import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { EnvoiError } from '../../sdk/typescript/src/index';
import { EnvoiConnector, type ConnectorSession } from '../../sdk/typescript/src/connector';
import { EnvoiWakeHostTransport, HttpWakeHost, type WakeHostTransport, type WakeSubscription } from './http-wake-host';
import { emptyWakeState } from './http-wake-store';
import type { WakeNotification, WakeState, WakeStore } from './http-wake-receiver';

const identity = { agentId: 'agent_example', installationId: 'installation_example', inboxId: 'inbox_example' };
const receiverUrl = 'https://hooks.example.org/envoi/wake';
const now = Date.parse('2026-10-17T12:00:00.000Z');
const noticeId = 'wake_evt_abcdefghijklmnop';
function authenticated(fetcher: typeof fetch) {
  let saved: ConnectorSession = { agentId: identity.agentId, inboxId: identity.inboxId, address: 'example@envoi.mail', agentApiToken: 'host-token', agentRefreshToken: 'refresh-token', agentTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), agentRefreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(), cursor: null };
  return new EnvoiConnector('https://envoi.example', { load: async () => structuredClone(saved), save: async value => { saved = structuredClone(value); } }, { fetch: fetcher });
}
function memoryStore(): WakeStore {
  let saved = emptyWakeState();
  return { read: async () => structuredClone(saved), update: async mutate => { const copy = structuredClone(saved); mutate(copy); saved = copy; } };
}
function subscription(patch: Partial<WakeSubscription> = {}): WakeSubscription {
  return { id: 'wake_sub_example', ...identity, url: receiverUrl, status: 'active', endedReason: null, expiresAt: '2026-11-16T12:00:00.000Z', replacesSubscriptionId: null, ...patch };
}
async function pending(store: WakeStore, type: string, patch: Partial<WakeNotification> = {}) {
  await store.update(state => {
    state.subscriptions.wake_sub_example = { url: receiverUrl, status: 'active', installationId: identity.installationId };
    state.accepted[noticeId] = { receivedAt: now, expiresAt: now + 3_900_000, pending: true, acknowledged: true, notification: { version: 1, id: noticeId, subscriptionId: 'wake_sub_example', type, ...patch } };
  });
}
function setup() {
  const store = memoryStore();
  const transport = { identity, status: vi.fn(async () => ({ paused: false, wake: { available: true, version: 1 as const, subscription: null } })),
    list: vi.fn(async () => [subscription()]), create: vi.fn(async () => subscription({ status: 'pending', expiresAt: null })),
    activate: vi.fn(async () => subscription()) };
  const driver = { processWorkOnce: vi.fn(async () => false), revalidateLiveLeases: vi.fn(async () => {}) };
  return { store, transport, driver, host: new HttpWakeHost(transport, store, driver, receiverUrl, () => now) };
}
afterEach(() => { vi.useRealTimers(); });

describe('private wake host', () => {
  it('drains canonical work after a wake, ignoring its unknown fields and reasons', async () => {
    const setupState = setup();
    await pending(setupState.store, 'wake.work_available', { reason: 'future_reason' });
    setupState.driver.processWorkOnce.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await setupState.host.dispatchPending();
    expect(setupState.driver.processWorkOnce).toHaveBeenCalledTimes(2);
    expect(setupState.transport.create).not.toHaveBeenCalled();
    expect((await setupState.store.read()).accepted[noticeId].pending).toBe(false);
  });
  it('control callbacks only revalidate live leases, never claim', async () => {
    const setupState = setup(); await pending(setupState.store, 'wake.control_changed');
    await setupState.host.dispatchPending();
    expect(setupState.driver.revalidateLiveLeases).toHaveBeenCalledOnce();
    expect(setupState.driver.processWorkOnce).not.toHaveBeenCalled();
  });
  it('does not dispatch a durably accepted hint until its HTTP response was flushed', async () => {
    const setupState = setup(); await pending(setupState.store, 'wake.work_available');
    await setupState.store.update(state => { state.accepted[noticeId].acknowledged = false; });
    await setupState.host.dispatchPending(); expect(setupState.driver.processWorkOnce).not.toHaveBeenCalled();
    await setupState.host.acknowledge(noticeId); await setupState.host.dispatchPending();
    expect(setupState.driver.processWorkOnce).toHaveBeenCalledOnce();
  });
  it('a challenge activates the same subscription without model or claim calls', async () => {
    const setupState = setup(); const challenge = `envoi_wake_challenge_${'a'.repeat(43)}`;
    await pending(setupState.store, 'wake.challenge', { challenge, expiresAt: '2026-10-17T12:10:00.000Z' });
    await setupState.host.dispatchPending();
    expect(setupState.transport.activate).toHaveBeenCalledWith('wake_sub_example', challenge, undefined);
    expect(setupState.driver.processWorkOnce).not.toHaveBeenCalled();
  });
  it('keeps uncertain dispatch pending for restart instead of inventing success', async () => {
    const setupState = setup(); await pending(setupState.store, 'wake.work_available');
    setupState.driver.processWorkOnce.mockRejectedValueOnce(new Error('offline'));
    await expect(setupState.host.dispatchPending()).rejects.toThrow('offline');
    expect((await setupState.store.read()).accepted[noticeId].pending).toBe(true);
    const restarted = new HttpWakeHost(setupState.transport, setupState.store, setupState.driver, receiverUrl, () => now);
    await restarted.dispatchPending(); expect((await setupState.store.read()).accepted[noticeId].pending).toBe(false);
  });
  it('does not process another installation or an ended subscription', async () => {
    const setupState = setup(); await pending(setupState.store, 'wake.work_available');
    await setupState.store.update(state => { state.subscriptions.wake_sub_example.installationId = 'installation_other'; });
    await setupState.host.dispatchPending(); expect(setupState.driver.processWorkOnce).not.toHaveBeenCalled();
  });
  it('keeps paused work held while maintaining connectivity', async () => {
    const setupState = setup(); await pending(setupState.store, 'wake.work_available');
    setupState.transport.status.mockResolvedValue({ paused: true, wake: { available: false, version: 1, subscription: null } });
    await setupState.host.poll(); expect(setupState.driver.processWorkOnce).not.toHaveBeenCalled();
    expect(setupState.transport.create).not.toHaveBeenCalled();
  });
  it('remembers owner revoke even after a later null status and restart', async () => {
    const setupState = setup();
    setupState.transport.status.mockResolvedValueOnce({ paused: false, wake: { available: true, version: 1, subscription: { id: 'wake_sub_example', status: 'ended', endedReason: 'revoked_by_owner', expiresAt: null } } } as never);
    await setupState.host.maintain();
    await new HttpWakeHost(setupState.transport, setupState.store, setupState.driver, receiverUrl).maintain();
    expect(setupState.transport.create).not.toHaveBeenCalled(); expect(setupState.transport.list).not.toHaveBeenCalled();
  });
  it('does not auto recreate receiver-gone or host-ended subscriptions', async () => {
    for (const reason of ['receiver_gone', 'ended_by_host', 'credential_ended']) {
      const setupState = setup(); setupState.transport.list.mockResolvedValue([]);
      await setupState.store.update(state => { state.endedReasons[identity.installationId] = reason; });
      await setupState.host.maintain(); expect(setupState.transport.create).not.toHaveBeenCalled();
    }
  });
  it('replaces within seven days and durably records the returned canonical URL', async () => {
    const setupState = setup(); setupState.transport.list.mockResolvedValue([subscription({ expiresAt: '2026-10-18T12:00:00.000Z' })]);
    await Promise.all([setupState.host.maintain(), setupState.host.maintain()]);
    expect(setupState.transport.create).toHaveBeenCalledOnce();
    expect((await setupState.store.read()).subscriptions.wake_sub_example.status).toBe('pending');
  });
  it('retains both active and pending subscription IDs during replacement', async () => {
    const setupState = setup(); setupState.transport.list.mockResolvedValue([subscription(), subscription({ id: 'wake_sub_next', status: 'pending', expiresAt: null, replacesSubscriptionId: 'wake_sub_example' })]);
    await setupState.host.maintain();
    expect(Object.keys((await setupState.store.read()).subscriptions)).toEqual(['wake_sub_example', 'wake_sub_next']);
    expect(setupState.transport.create).not.toHaveBeenCalled();
  });
  it('runs startup and safety claims with missing or disabled wake and no subscription creates', async () => {
    const setupState = setup(); setupState.transport.status.mockResolvedValue({ paused: false, wake: null } as never);
    await setupState.host.poll(); expect(setupState.driver.processWorkOnce).toHaveBeenCalledOnce(); expect(setupState.transport.create).not.toHaveBeenCalled();
  });
  it('does not overlap claims when polling and durable dispatch race', async () => {
    const setupState = setup(); await pending(setupState.store, 'wake.work_available');
    let release!: () => void;
    setupState.driver.processWorkOnce.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(false); }));
    const dispatch = setupState.host.dispatchPending();
    await vi.waitFor(() => expect(setupState.driver.processWorkOnce).toHaveBeenCalledOnce());
    const poll = setupState.host.poll(); await Promise.resolve(); release(); await Promise.all([dispatch, poll]);
    expect(setupState.driver.processWorkOnce.mock.calls.length).toBeLessThanOrEqual(2);
  });
  it('rejects a scheduling interval beyond the contract bound and cancels cleanly', async () => {
    const setupState = setup(); const stop = new AbortController();
    await expect(setupState.host.run(stop.signal, 900001)).rejects.toThrow();
    stop.abort(); await setupState.host.run(stop.signal); expect(setupState.transport.status).not.toHaveBeenCalled();
  });
  it('stops on credential revocation without enrollment or retries', async () => {
    const setupState = setup(); setupState.transport.status.mockRejectedValue(new EnvoiError('refused', 401, 'CREDENTIAL_REVOKED'));
    await expect(setupState.host.run(new AbortController().signal)).rejects.toMatchObject({ code: 'CREDENTIAL_REVOKED' });
    expect(setupState.transport.create).not.toHaveBeenCalled(); expect(setupState.driver.processWorkOnce).not.toHaveBeenCalled();
  });
  it('keeps the hosted worker alive through a temporary upstream status failure', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const setupState = setup(); const stop = new AbortController();
    const host = new HttpWakeHost(setupState.transport, setupState.store, setupState.driver, receiverUrl, Date.now);
    setupState.transport.status.mockRejectedValueOnce(new EnvoiError('Temporary upstream response', 503, 'NETWORK_ERROR'));
    const running = host.run(stop.signal, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(setupState.transport.status).toHaveBeenCalledTimes(1);
    expect(setupState.driver.processWorkOnce).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(setupState.transport.status).toHaveBeenCalledTimes(2);
    expect(setupState.driver.processWorkOnce).toHaveBeenCalledTimes(2);
    stop.abort(); await running;
  });
  it('keeps checking the canonical queue while subscription status is unavailable', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const setupState = setup(); const stop = new AbortController();
    const host = new HttpWakeHost(setupState.transport, setupState.store, setupState.driver, receiverUrl, Date.now);
    setupState.transport.status.mockRejectedValue(new EnvoiError('Temporary upstream response', 503, 'NETWORK_ERROR'));
    const running = host.run(stop.signal, 1000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(setupState.transport.status).toHaveBeenCalledTimes(4);
    expect(setupState.driver.processWorkOnce).toHaveBeenCalledTimes(4);
    stop.abort(); await running;
  });
  it('keeps claiming while wake maintenance honors Retry-After', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const setupState = setup(); const stop = new AbortController();
    const host = new HttpWakeHost(setupState.transport, setupState.store, setupState.driver, receiverUrl, Date.now);
    setupState.transport.status.mockRejectedValueOnce(new EnvoiError('Wake status throttled', 429, 'RATE_LIMITED', { retryAfterSeconds: 60 }));
    const running = host.run(stop.signal, 1000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(setupState.transport.status).toHaveBeenCalledOnce();
    expect(setupState.driver.processWorkOnce).toHaveBeenCalledTimes(4);
    stop.abort(); await running;
  });
  it('checks canonical work when a wake hint fails status revalidation', async () => {
    vi.useFakeTimers();
    const setupState = setup(); const stop = new AbortController();
    await pending(setupState.store, 'wake.work_available');
    setupState.transport.status.mockRejectedValue(new EnvoiError('Temporary upstream response', 503, 'NETWORK_ERROR'));
    const running = setupState.host.run(stop.signal, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(setupState.driver.processWorkOnce).toHaveBeenCalledOnce();
    expect((await setupState.store.read()).accepted[noticeId].pending).toBe(true);
    stop.abort(); await running;
  });
  it('continues safety claims while a wake hint status call is stalled', async () => {
    vi.useFakeTimers();
    const setupState = setup(); const stop = new AbortController();
    await pending(setupState.store, 'wake.work_available');
    let release!: () => void;
    setupState.transport.status.mockResolvedValueOnce({ paused: false, wake: { available: true, version: 1, subscription: null } })
      .mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ paused: false, wake: { available: true, version: 1, subscription: null } }); }));
    const running = setupState.host.run(stop.signal, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(setupState.driver.processWorkOnce).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(setupState.driver.processWorkOnce).toHaveBeenCalledTimes(2);
    release(); stop.abort(); await running;
  });
  it('never starts a safety claim before a pending control is revalidated', async () => {
    const setupState = setup(); await pending(setupState.store, 'wake.control_changed');
    setupState.transport.status.mockRejectedValue(new EnvoiError('Temporary upstream response', 503, 'NETWORK_ERROR'));
    setupState.driver.revalidateLiveLeases.mockRejectedValue(new EnvoiError('Credential revoked', 401, 'CREDENTIAL_REVOKED'));
    await expect(setupState.host.run(new AbortController().signal)).rejects.toMatchObject({ code: 'CREDENTIAL_REVOKED' });
    expect(setupState.driver.processWorkOnce).not.toHaveBeenCalled();
  });
  it('honors an earlier canonical work-due hint instead of waiting for the safety interval', async () => {
    vi.useFakeTimers();
    const setupState = setup(); const stop = new AbortController();
    const host = new HttpWakeHost(setupState.transport, setupState.store, { ...setupState.driver, nextAvailableInMs: () => 2000 }, receiverUrl, () => now);
    const running = host.run(stop.signal, 60_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(setupState.driver.processWorkOnce).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2000);
    expect(setupState.driver.processWorkOnce).toHaveBeenCalledTimes(2);
    stop.abort(); await running;
  });
});

describe('fixed-origin authenticated transport', () => {
  it('consumes the canonical status and binds installation, agent and inbox', async () => {
    const fixture = JSON.parse(await readFile(new URL('../../test/contract-fixtures/http-wake/agent-status-http-wake.json', import.meta.url), 'utf8'));
    const fetcher = vi.fn(async () => Response.json(fixture.response.body));
    const client = new EnvoiWakeHostTransport('https://envoi.example', identity, authenticated(fetcher as typeof fetch));
    expect((await client.status()).wake?.subscription?.id).toBe('wake_sub_example');
    expect(fetcher.mock.calls[0][0]).toBe('https://envoi.example/api/agent/status');
    expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1]).toMatchObject({ redirect: 'error', credentials: 'omit', headers: { authorization: 'Bearer host-token' } });
  });
  it('rejects wrong-owner status and never uses a notification-provided destination', async () => {
    const fetcher = vi.fn(async () => Response.json({ state: 'active', inboxId: 'inbox_other', agent: { id: identity.agentId } }));
    const client = new EnvoiWakeHostTransport('https://envoi.example', identity, authenticated(fetcher as typeof fetch));
    await expect(client.status()).rejects.toThrow('identity changed');
    expect(() => new EnvoiWakeHostTransport('https://user:secret@envoi.example', identity, authenticated(fetcher as typeof fetch))).toThrow();
  });
  it('rejects array-coerced state and subscription status fields', async () => {
    for (const field of ['state', 'status']) {
      const fixture = JSON.parse(await readFile(new URL('../../test/contract-fixtures/http-wake/agent-status-http-wake.json', import.meta.url), 'utf8'));
      if (field === 'state') fixture.response.body.state = ['active'];
      else fixture.response.body.httpWake.subscription.status = ['active'];
      const connector = authenticated(vi.fn(async () => Response.json(fixture.response.body)) as typeof fetch);
      await expect(new EnvoiWakeHostTransport('https://envoi.example', identity, connector).status()).rejects.toThrow();
    }
  });
});
