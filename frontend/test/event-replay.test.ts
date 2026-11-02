import { expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { createEventCursorStore, PROGRESS_ONLY_EVENTS, subscribeReplayRecovery, WORKSPACE_EVENT_TYPES } from '../src/event-replay';

it('refreshes bounded replay notices while preserving native reconnect state', () => {
  const stream = new EventTarget();
  const close = vi.fn();
  Object.assign(stream, { close });
  const refresh = vi.fn(); const notify = vi.fn();
  const cleanup = subscribeReplayRecovery(stream, refresh, notify);
  stream.dispatchEvent(new Event('replay_required'));
  stream.dispatchEvent(new Event('replay_required'));
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(notify).toHaveBeenCalledWith('Catching up on workspace activity…');
  expect(close).not.toHaveBeenCalled();
  cleanup();
  stream.dispatchEvent(new Event('replay_required'));
  expect(refresh).toHaveBeenCalledTimes(2);
});

function message(type: string, cursor: string, payload: unknown = {}) {
  return new MessageEvent(type, { lastEventId: cursor, data: JSON.stringify(payload) });
}

it('resumes manual reconnects with encoded, workspace-scoped progress', () => {
  const store = createEventCursorStore();
  const scope = store.scope('human', 'workspace one', () => true);
  const cursor = '2026-10-04T12:00:00.000Z|evt&1';
  expect(scope.record(message('case.created', cursor))).toBe(true);
  expect(new URL(scope.url(), 'https://example.com').searchParams.get('cursor')).toBe(cursor);
  expect(scope.url()).toContain('workspace%20one');
  expect(store.scope('human', 'workspace one', () => true).url()).toBe(scope.url());
  expect(store.scope('human', 'other', () => true).url()).not.toContain('?');
  expect(store.scope('other human', 'workspace one', () => true).url()).not.toContain('?');
});

it('clears all account progress on logout and rejects old callbacks after sign-in', () => {
  const store = createEventCursorStore(); const old = store.scope('human', 'workspace', () => true);
  old.record(message('case.created', '0001')); store.clear();
  expect(old.record(message('case.created', '0002'))).toBe(false);
  expect(store.scope('human', 'workspace', () => true).url()).not.toContain('?');
});

it('ignores obsolete workspace callbacks, regressing progress, and invalid cursors', () => {
  let current = true;
  const store = createEventCursorStore(); const scope = store.scope('human', 'workspace', () => current);
  scope.record(message('case.created', '0002'));
  expect(scope.record(message('case.created', '0001'))).toBe(false);
  expect(scope.record(message('case.created', 'bad\nvalue'))).toBe(false);
  expect(scope.record(message('case.created', 'x'.repeat(513)))).toBe(false);
  current = false;
  expect(scope.record(message('case.created', '0003'))).toBe(false);
  expect(store.scope('human', 'workspace', () => true).url()).toContain('cursor=0002');
});

it('accepts ready progress beyond unhandled event types without advancing beyond the delivered checkpoint', () => {
  const store = createEventCursorStore(); const scope = store.scope('human', 'workspace', () => true);
  scope.record(message('case.created', '0001'));
  // Native EventSource carries the previous actual id into ready, even when its
  // named data event had no application listener. The server adds no ready id.
  expect(scope.record(message('ready', '0003', { inboxId: 'workspace', cursor: '9999' }), true)).toBe(true);
  expect(scope.url()).toContain('cursor=0003');
  expect(scope.record(message('ready', '0002', { inboxId: 'workspace', cursor: '0002' }), true)).toBe(false);
  expect(scope.record(message('ready', '0004', { inboxId: 'other', cursor: '0004' }), true)).toBe(false);
});

it('can use the server ready payload when no inherited id is available, and keeps progress received before ready', () => {
  const store = createEventCursorStore(); const scope = store.scope('human', 'workspace', () => true);
  expect(scope.record(message('ready', '', { inboxId: 'workspace', cursor: '0002' }), true)).toBe(true);
  scope.record(message('case.created', '0003'));
  expect(store.scope('human', 'workspace', () => true).url()).toContain('cursor=0003');
  expect(scope.record(new MessageEvent('ready', { data: 'not json', lastEventId: '0004' }), true)).toBe(false);
});

it('covers the literal data events emitted by the server and keeps control events separate', () => {
  // Feature audit callbacks publish through the same committed workspace stream as
  // server.js. Read the modules present in this checkout, including composed native
  // and provider implementations, rather than overlooking their literal events.
  const modules = new Set(['server.js', 'provider-browser-poll.js', 'provider-gateway-native.js', 'provider-event-wake.js', 'http-wake.js']);
  const directory = new URL('../../src/', import.meta.url);
  const source = readdirSync(directory).filter(name => modules.has(name)).map(name => readFileSync(new URL(name, directory), 'utf8')).join('\n');
  const emitted = [...source.matchAll(/(?:audit|writeAudit)\(\s*(?:[^,\n]+,\s*)?['"]([a-z][a-z_.]+)['"]/g)].map(match => match[1]);
  expect(emitted.length).toBeGreaterThan(25);
  // Global HTTP-wake startup epochs use a null inbox and do not enter a workspace stream.
  for (const type of emitted.filter(type => type !== 'http_wake.epoch_moved')) expect(WORKSPACE_EVENT_TYPES, type).toContain(type);
  for (const type of ['agent.reenroll_token_created', 'agent.reconnect_token_created']) expect(WORKSPACE_EVENT_TYPES).toContain(type);
  expect(WORKSPACE_EVENT_TYPES).not.toContain('session.revoked');
  expect(WORKSPACE_EVENT_TYPES).not.toContain('ready');
  expect(PROGRESS_ONLY_EVENTS.has('agent.mcp_read_token_issued')).toBe(true);
  expect(WORKSPACE_EVENT_TYPES).toContain('agent.refresh_recovered');
  expect(PROGRESS_ONLY_EVENTS.has('agent.refresh_recovered')).toBe(true);
  expect(PROGRESS_ONLY_EVENTS.has('case.action_recorded')).toBe(false);
  // Pause/resume use a template literal in server.js, outside the literal-event scan.
  for (const type of ['agent.paused', 'agent.resumed', 'agent.refresh_replay_detected', 'message.cancelled']) {
    expect(WORKSPACE_EVENT_TYPES).toContain(type);
    expect(PROGRESS_ONLY_EVENTS.has(type)).toBe(false);
  }
  expect(WORKSPACE_EVENT_TYPES).toContain('work.available');
  expect(PROGRESS_ONLY_EVENTS.has('work.available')).toBe(true);
});

it('subscribes to the approved Phase D owner audit events', () => {
  const schema = JSON.parse(readFileSync(new URL('../../test/contract-fixtures/phase-d/schemas.json', import.meta.url), 'utf8')) as { 'x-owner-events': string[] };
  for (const type of schema['x-owner-events']) {
    expect(WORKSPACE_EVENT_TYPES).toContain(type);
    expect(PROGRESS_ONLY_EVENTS.has(type)).toBe(false);
  }
});

it('refreshes visible native work, owner scope and provider target state rather than treating them as progress-only', () => {
  const store = createEventCursorStore();
  const scope = store.scope('owner', 'workspace', () => true);
  const types = ['agent.gateway_scope_changed', 'agent.gateway_work_released', 'agent.gateway_work_replied', 'agent.wake_target_secret_set', 'agent.wake_target_attention'];
  types.forEach((type, index) => {
    expect(WORKSPACE_EVENT_TYPES).toContain(type);
    expect(PROGRESS_ONLY_EVENTS.has(type)).toBe(false);
    expect(scope.record(message(type, String(index + 1).padStart(20, '0')))).toBe(true);
  });
  expect(scope.url()).toContain('cursor=00000000000000000005');
  expect(WORKSPACE_EVENT_TYPES).not.toContain('http_wake.epoch_moved');
});
