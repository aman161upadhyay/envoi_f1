import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvoiConnector, PermanentWorkError, type ConnectorSession } from '../../sdk/typescript/src/connector';
import { EnvoiError } from '../../sdk/typescript/src/index';
import type { CaseSessionChannel } from '../../sdk/typescript/src/case-session';
import { contractRegistry, loadContractFixture } from '../contract-fixtures/setup';
import { scopedTurnHandler, type ScopedModelTurn } from './scoped-turn';

const fixture = (contractId: string, name: string) => loadContractFixture(
  contractRegistry.contracts.find(entry => entry.id === contractId)!, `${name}.json`
) as Record<string, any>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

function harness(run: (turn: ScopedModelTurn) => Promise<void>) {
  let saved: ConnectorSession = {
    agentId: 'agent_example', inboxId: 'inbox_example', address: 'example@envoi.mail', cursor: null,
    agentApiToken: 'PRIVATE_HOST_ACCESS', agentRefreshToken: 'PRIVATE_HOST_REFRESH',
    agentTokenExpiresAt: '2026-10-17T13:00:00.000Z', agentRefreshTokenExpiresAt: '2026-11-17T12:00:00.000Z'
  };
  const session = fixture('case-session', 'session-created').response.body;
  const work = { workId: session.session.workId, leaseToken: 'PRIVATE_LEASE', leaseExpiresAt: session.lease.leaseExpiresAt,
    message: { id: session.session.workId, caseId: session.session.caseId, senderAgentId: 'agent_counterparty',
      recipientAgentId: saved.agentId, from: { agentId: 'agent_counterparty', address: session.session.counterparty.address } } };
  const toolStarted = deferred<void>(), toolResponse = deferred<Response>();
  const requests: Array<{ path: string; body: any }> = [];
  let channel!: CaseSessionChannel, claimed = false;
  const scoped = scopedTurnHandler({ admit: async () => {}, run });
  const connector = new EnvoiConnector('https://envoi.example', {
    load: async () => saved, save: async value => { saved = structuredClone(value); }
  }, {
    caseSessionHandler: { ...scoped, process(current, context) { channel = current; return scoped.process(current, context); } },
    fetch: async (input, options) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://envoi.example');
      const body = options?.body ? JSON.parse(String(options.body)) : {};
      requests.push({ path: url.pathname, body });
      const operation = url.pathname.split('/').at(-1);
      if (operation === 'status') return Response.json({ state: 'active', inboxId: saved.inboxId,
        agent: { id: saved.agentId }, caseSessions: { available: true, version: 1 } });
      if (operation === 'claim') { if (claimed) return Response.json({ work: null, state: 'idle' }); claimed = true; return Response.json({ work }); }
      if (operation === 'session') return Response.json(session, { status: 201 });
      if (operation === 'mcp') {
        if (body.params.name === 'envoi_case_snapshot') {
          const response = fixture('case-tools', 'snapshot-agent-work').response.body;
          response.id = body.id; return Response.json(response);
        }
        toolStarted.resolve(); return toolResponse.promise;
      }
      if (operation === 'end') return Response.json({ session: { id: session.session.id, status: 'ended' } });
      if (operation === 'acknowledge' || operation === 'fail' || operation === 'complete') return Response.json({
        workId: work.workId, status: operation === 'acknowledge' ? 'acknowledged' : operation === 'complete' ? 'processed' : body.retryable ? 'retryable' : 'failed',
        receipt: { messageId: work.workId, state: operation === 'acknowledge' ? 'acknowledged' : 'processed' }
      });
      if (operation === 'renew') return Response.json({ workId: work.workId, leaseToken: work.leaseToken, leaseExpiresAt: work.leaseExpiresAt });
      throw new Error(`Unexpected offline route: ${url.pathname}`);
    }
  });
  return { connector, requests, toolStarted, channel: () => channel,
    finishTool() {
      const body = fixture('case-tools', 'reply-agent-work').response.body;
      const request = requests.find(x => x.path === '/mcp' && x.body.params.name === 'envoi_case_reply')!;
      body.id = request.body.id; toolResponse.resolve(Response.json(body));
    },
    invalidate(reason: string) { expect(channel.observeEvent({ type: 'case_session.ended', agentId: saved.agentId,
      workId: work.workId, caseId: work.message.caseId, sessionId: session.session.id, reason })).toBe(true); }
  };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-17T12:00:06Z')); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('real connector and scoped-handler failure finalization', () => {
  it.each(['typed deadline', 'ordinary runtime error'] as const)('preserves a %s with a pending tool through connector error selection', async kind => {
    const original = kind === 'typed deadline' ? new EnvoiError('Hermes deadline expired', undefined, 'TIMEOUT') : new Error('PRIVATE_RUNTIME_DIAGNOSTIC');
    const late: Array<Promise<unknown>> = [];
    let turn!: ScopedModelTurn;
    const test = harness(async current => {
      turn = current;
      const args = fixture('case-tools', 'reply-agent-work').request.body.params.arguments;
      late.push(current.callTool('envoi_case_reply', args).catch(error => error));
      late.push(current.callTool('envoi_case_reply', { ...args, idempotencyKey: 'queued-distinct-action' }).catch(error => error));
      await test.toolStarted.promise;
      throw original;
    });
    const error = await test.connector.processWorkOnce().catch(error => error);
    if (kind === 'typed deadline') expect(error).toBe(original);
    else {
      expect(error).toMatchObject({ code: 'HANDLER_FAILED', cause: original });
      expect(JSON.stringify(error)).not.toContain('PRIVATE_RUNTIME_DIAGNOSTIC');
    }
    expect(test.channel().signal.reason).toBe(error);
    expect(test.requests.some(x => x.path.endsWith('/complete'))).toBe(false);
    expect(test.requests.find(x => x.path.endsWith('/fail'))?.body).toMatchObject({ retryable: true, reasonCode: 'HANDLER_FAILED' });
    test.finishTool();
    expect((await Promise.all(late)).every(x => x instanceof Error)).toBe(true);
    await expect(turn.callTool('envoi_case_reply', fixture('case-tools', 'reply-agent-work').request.body.params.arguments)).rejects.toBeDefined();
    expect(test.requests.filter(x => x.path === '/mcp' && x.body.params.name === 'envoi_case_reply')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['credential_ended', 'agent_paused', 'lease_lost'])('keeps %s authoritative over a later runtime exception', async reason => {
    const late: Array<Promise<unknown>> = [];
    const test = harness(async turn => {
      const args = fixture('case-tools', 'reply-agent-work').request.body.params.arguments;
      late.push(turn.callTool('envoi_case_reply', args).catch(error => error));
      late.push(turn.callTool('envoi_case_reply', { ...args, idempotencyKey: 'never-dispatch' }).catch(error => error));
      await test.toolStarted.promise;
      test.invalidate(reason);
      throw new EnvoiError('Later runtime failure', undefined, 'TIMEOUT');
    });
    const processing = test.connector.processWorkOnce();
    await expect(processing).rejects.toMatchObject({ code: 'CASE_SESSION_ENDED', reason });
    expect(test.requests.some(x => x.path.endsWith('/complete'))).toBe(false);
    test.finishTool(); await Promise.all(late);
    expect(test.requests.filter(x => x.path === '/mcp' && x.body.params.name === 'envoi_case_reply')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a verified terminal failure permanent even when a tool remains outstanding', async () => {
    let late!: Promise<unknown>;
    const test = harness(async turn => {
      late = turn.callTool('envoi_case_reply', fixture('case-tools', 'reply-agent-work').request.body.params.arguments).catch(error => error);
      await test.toolStarted.promise;
      throw new PermanentWorkError('HERMES_TURN_NOT_COMPLETED');
    });
    await expect(test.connector.processWorkOnce()).resolves.toBe(true);
    expect(test.requests.find(x => x.path.endsWith('/fail'))?.body).toMatchObject({
      retryable: false, reasonCode: 'HERMES_TURN_NOT_COMPLETED'
    });
    expect(test.requests.some(x => x.path.endsWith('/complete'))).toBe(false);
    test.finishTool(); expect(await late).toBeInstanceOf(Error);
    expect(vi.getTimerCount()).toBe(0);
  });
});
