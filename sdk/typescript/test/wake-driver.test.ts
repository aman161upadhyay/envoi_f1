import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvoiConnector, type CaseSessionWorkHandler, type ConnectorOptions, type ConnectorSession, type WorkLease } from '../src/connector';
import { contractRegistry, loadContractFixture } from '../../../integrations/contract-fixtures/setup';

const contract = contractRegistry.contracts.find(entry => entry.id === 'case-session')!;

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(complete => { resolve = complete; });
  return { promise, resolve };
}

function harness() {
  let saved: ConnectorSession = {
    agentId: 'agent_example', inboxId: 'inbox_example', address: 'example@envoi.mail',
    agentApiToken: 'PRIVATE_ACCESS', agentRefreshToken: 'PRIVATE_REFRESH', cursor: null,
    agentTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    agentRefreshTokenExpiresAt: new Date(Date.now() + 86400_000).toISOString()
  };
  const work: WorkLease = {
    workId: 'msg_example', leaseToken: 'PRIVATE_LEASE', leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    message: { id: 'msg_example', caseId: 'case_example', recipientAgentId: 'agent_example', senderAgentId: 'agent_counterparty', text: 'untrusted', from: { agentId: 'agent_counterparty', address: 'counterparty@envoi.mail' } }
  };
  const entered = deferred<AbortSignal>();
  const released = deferred<void>();
  const controls = {
    state: 'active', available: true, renewCode: '', idle: false, hint: 2500,
    renewal: undefined as undefined | ((signal?: AbortSignal | null) => Promise<Response>),
    status: undefined as undefined | (() => Promise<Response>),
    completeParsed: false,
    afterCompleteRead: undefined as undefined | (() => void)
  };
  const paths: string[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    const operation = path.split('/').at(-1);
    if (operation === 'status') return controls.status ? controls.status() : Response.json({ state: controls.state, inboxId: saved.inboxId, agent: { id: saved.agentId }, caseSessions: { available: controls.available, version: 1 } });
    if (operation === 'claim') return Response.json(controls.idle ? { state: 'idle', work: null, nextAvailableInMs: controls.hint } : { state: 'claimed', work });
    if (operation === 'renew') {
      if (controls.renewal) return controls.renewal(options?.signal);
      if (controls.renewCode) return Response.json({ code: controls.renewCode }, { status: 409 });
      return Response.json({ workId: work.workId, leaseToken: work.leaseToken, leaseExpiresAt: new Date(Date.now() + 120_000).toISOString() });
    }
    if (operation === 'session') {
      const source = loadContractFixture(contract, 'session-created.json') as Record<string, any>;
      const payload = source.response.body;
      Object.assign(payload.session, { createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 900_000).toISOString() });
      payload.lease.leaseExpiresAt = work.leaseExpiresAt;
      return Response.json(payload, { status: 201 });
    }
    if (operation === 'end') return Response.json({ session: { id: JSON.parse(String(options?.body)).sessionId, status: 'ended' } });
    if (operation === 'acknowledge' || operation === 'complete') {
      const state = operation === 'complete' ? 'processed' : 'acknowledged';
      const response = Response.json({ workId: work.workId, status: state, receipt: { messageId: work.message.id, state } });
      if (operation === 'complete') {
        const read = response.text.bind(response);
        response.text = async () => { const text = await read(); controls.completeParsed = true; return text; };
      }
      return response;
    }
    throw new Error(`Unexpected offline test request: ${operation}`);
  });
  const handler: CaseSessionWorkHandler = {
    admit: vi.fn(async () => {}),
    process: vi.fn(async (_channel, context) => { entered.resolve(context.signal); await released.promise; })
  };
  const store = {
    load: async () => {
      if (controls.completeParsed && controls.afterCompleteRead) {
        const interrupt = controls.afterCompleteRead; controls.afterCompleteRead = undefined; interrupt();
      }
      return saved;
    },
    save: async (next: ConnectorSession) => { saved = structuredClone(next); }
  };
  const options: ConnectorOptions = { fetch: fetcher as typeof fetch, caseSessionHandler: handler };
  const connector = new EnvoiConnector('https://envoi.example', store, options);
  return { connector, options, store, fetcher, paths, controls, entered, released, work };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-18T16:00:00Z')); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('scoped connector wake driver', () => {
  it('rejects absent and legacy handlers before storage or network access', () => {
    const load = vi.fn();
    for (const options of [{}, { handler: { admit: async () => {}, process: async () => {} } }]) {
      const connector = new EnvoiConnector('https://envoi.example', { load, save: vi.fn() }, options);
      expect(() => connector.scopedWakeWorkDriver()).toThrow(expect.objectContaining({ code: 'SCOPED_HANDLER_REQUIRED' }));
    }
    expect(load).not.toHaveBeenCalled();
  });

  it('exposes only frozen host operations, never credentials or a legacy fallback', async () => {
    const test = harness();
    const driver = test.connector.scopedWakeWorkDriver();
    expect(Object.isFrozen(driver)).toBe(true);
    expect(Object.keys(driver).sort()).toEqual(['nextAvailableInMs', 'processWorkBatch', 'processWorkOnce', 'revalidateLiveLeases']);
    expect(JSON.stringify(driver)).not.toMatch(/PRIVATE|token|lease/i);
    test.options.caseSessionHandler = undefined;
    expect(() => driver.processWorkOnce()).toThrow(expect.objectContaining({ code: 'SCOPED_HANDLER_REQUIRED' }));
    expect(() => driver.processWorkBatch([{workId:'msg_explicit',caseId:'case_explicit'}])).toThrow(expect.objectContaining({ code: 'SCOPED_HANDLER_REQUIRED' }));
    await expect(driver.revalidateLiveLeases()).rejects.toMatchObject({ code: 'SCOPED_HANDLER_REQUIRED' });
    expect(test.fetcher).not.toHaveBeenCalled();
  });

  it('returns only the canonical idle retry hint with an elapsed-time adjustment', async () => {
    const test = harness(); test.controls.idle = true;
    const driver = test.connector.scopedWakeWorkDriver();
    expect(driver.nextAvailableInMs()).toBeUndefined();
    await expect(driver.processWorkOnce()).resolves.toBe(false);
    expect(driver.nextAvailableInMs()).toBe(2500);
    await vi.advanceTimersByTimeAsync(1500);
    expect(driver.nextAvailableInMs()).toBe(1000);
    await vi.advanceTimersByTimeAsync(1500);
    expect(driver.nextAvailableInMs()).toBe(0);
  });

  it('renews a live lease immediately without waiting for the model or periodic timer', async () => {
    const test = harness(); const driver = test.connector.scopedWakeWorkDriver();
    const processing = driver.processWorkOnce();
    const signal = await test.entered.promise;
    await driver.revalidateLiveLeases();
    expect(test.paths.filter(path => path.endsWith('/renew'))).toHaveLength(1);
    expect(signal.aborted).toBe(false);
    expect(test.paths.some(path => path.endsWith('/complete'))).toBe(false);
    test.released.resolve();
    await expect(processing).resolves.toBe(true);
    await driver.revalidateLiveLeases();
    expect(test.paths.filter(path => path.endsWith('/renew'))).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('serializes a fresh post-hint renewal behind the periodic renewal', async () => {
    const test = harness(); const driver = test.connector.scopedWakeWorkDriver();
    const processing = driver.processWorkOnce(); await test.entered.promise;
    const renewing = deferred<void>(); const response = deferred<Response>();
    test.controls.renewal = () => { renewing.resolve(); return response.promise; };
    await vi.advanceTimersByTimeAsync(20_000); await renewing.promise;
    const first = driver.revalidateLiveLeases(); const second = driver.revalidateLiveLeases();
    await vi.advanceTimersByTimeAsync(1);
    expect(test.paths.filter(path => path.endsWith('/renew'))).toHaveLength(1);
    test.controls.renewal = undefined;
    response.resolve(Response.json({ workId: test.work.workId, leaseToken: test.work.leaseToken, leaseExpiresAt: new Date(Date.now() + 120_000).toISOString() }));
    await Promise.all([first, second]);
    expect(test.paths.filter(path => path.endsWith('/renew'))).toHaveLength(2);
    test.released.resolve(); await expect(processing).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['WORK_LEASE_STALE', 'CASE_CONTROLLED', 'CREDENTIAL_REVOKED'])('cancels a live turn after renewal rejects %s with no late settlement', async code => {
    const test = harness(); const driver = test.connector.scopedWakeWorkDriver();
    const processing = driver.processWorkOnce();
    const outcome = processing.catch(error => error);
    const signal = await test.entered.promise;
    test.controls.renewCode = code;
    if (code === 'CREDENTIAL_REVOKED') await expect(driver.revalidateLiveLeases()).rejects.toMatchObject({ code });
    else await driver.revalidateLiveLeases();
    expect(signal.aborted).toBe(true);
    test.released.resolve();
    if (code === 'CREDENTIAL_REVOKED') expect(await outcome).toMatchObject({ code });
    else expect(await outcome).toBe(true);
    expect(test.paths.some(path => /\/(complete|fail)$/.test(path))).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('requires fresh authority after a held pre-hint renewal succeeds', async () => {
    const test = harness(); const driver = test.connector.scopedWakeWorkDriver();
    const processing = driver.processWorkOnce(); await test.entered.promise;
    const response = deferred<Response>(); const renewing = deferred<void>();
    test.controls.renewal = () => { renewing.resolve(); return response.promise; };
    await vi.advanceTimersByTimeAsync(20_000); await renewing.promise;
    const control = driver.revalidateLiveLeases();
    test.controls.renewal = undefined; test.controls.renewCode = 'WORK_LEASE_STALE';
    response.resolve(Response.json({ workId: test.work.workId, leaseToken: test.work.leaseToken, leaseExpiresAt: new Date(Date.now() + 120_000).toISOString() }));
    await control;
    expect(test.paths.filter(path => path.endsWith('/renew'))).toHaveLength(2);
    test.released.resolve(); await expect(processing).resolves.toBe(true);
    expect(test.paths.some(path => /\/(complete|fail)$/.test(path))).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts immediate lease validation while the status request is stalled', async () => {
    const test = harness(); const driver = test.connector.scopedWakeWorkDriver();
    const processing = driver.processWorkOnce(); await test.entered.promise;
    const status = deferred<Response>(); const renewed = deferred<void>();
    test.controls.status = () => status.promise;
    test.controls.renewal = async () => {
      renewed.resolve();
      return Response.json({ workId: test.work.workId, leaseToken: test.work.leaseToken, leaseExpiresAt: new Date(Date.now() + 120_000).toISOString() });
    };
    const control = driver.revalidateLiveLeases();
    await renewed.promise;
    expect(test.paths.filter(path => path.endsWith('/renew'))).toHaveLength(1);
    status.resolve(Response.json({ state: 'active', agent: { id: 'agent_example' }, inboxId: 'inbox_example', caseSessions: { available: true, version: 1 } }));
    await control;
    test.released.resolve(); await expect(processing).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not turn successful settlement into failure when control renewal is aborted by normal teardown', async () => {
    const test = harness(); const driver = test.connector.scopedWakeWorkDriver();
    const processing = driver.processWorkOnce(); await test.entered.promise;
    const renewing = deferred<void>();
    test.controls.renewal = signal => new Promise((_resolve, reject) => {
      renewing.resolve();
      signal?.addEventListener('abort', () => reject(new Error('Fixture request aborted')), { once: true });
    });
    const control = driver.revalidateLiveLeases(); await renewing.promise;
    test.released.resolve();
    await expect(processing).resolves.toBe(true);
    await expect(control).resolves.toBeUndefined();
    expect(test.paths.filter(path => path.endsWith('/complete'))).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not let an older active status undo a newer pause reported by renewal', async () => {
    const test = harness(); const driver = test.connector.scopedWakeWorkDriver();
    const processing = driver.processWorkOnce(); await test.entered.promise;
    const status = deferred<Response>(); const started = deferred<void>();
    test.controls.status = () => { started.resolve(); return status.promise; };
    test.controls.renewCode = 'AGENT_PAUSED';
    const control = driver.revalidateLiveLeases(); await started.promise;
    await control;
    expect((await test.connector.lifecycle()).paused).toBe(true);
    status.resolve(Response.json({ state: 'active', agent: { id: 'agent_example' }, inboxId: 'inbox_example', caseSessions: { available: true, version: 1 } }));
    await vi.advanceTimersByTimeAsync(0);
    expect((await test.connector.lifecycle()).paused).toBe(true);
    test.released.resolve(); await processing;
    expect(test.paths.some(path => /\/(complete|fail)$/.test(path))).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not report successful processing if cancellation arrives during completion wrapper cleanup', async () => {
    const test = harness(); const driver = test.connector.scopedWakeWorkDriver();
    const stop = new AbortController();
    const processing = driver.processWorkOnce(stop.signal); const outcome = processing.catch(error => error);
    await test.entered.promise;
    test.controls.afterCompleteRead = () => stop.abort();
    test.released.resolve();
    expect(await outcome).toMatchObject({ code: 'REQUEST_CANCELLED' });
    expect(test.paths.filter(path => path.endsWith('/complete'))).toHaveLength(1);
    expect(test.paths.some(path => path.endsWith('/fail'))).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['pause', 'feature disabled'])('invalidates live work on canonical %s before renewing', async change => {
    const test = harness(); const driver = test.connector.scopedWakeWorkDriver();
    const processing = driver.processWorkOnce(); const outcome = processing.catch(error => error);
    const signal = await test.entered.promise;
    if (change === 'pause') test.controls.state = 'paused'; else test.controls.available = false;
    await driver.revalidateLiveLeases();
    expect(signal.aborted).toBe(true);
    test.released.resolve(); await outcome;
    expect(test.paths.some(path => /\/(complete|fail)$/.test(path))).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
