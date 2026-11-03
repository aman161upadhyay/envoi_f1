import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvoiConnector, PermanentWorkError, ConnectorContractError, assertHumanDecisionMessage, type CaseSessionWorkHandler, type ConnectorSession, type WorkLease } from '../src/connector';
import { EnvoiError } from '../src/index';
import { CaseSessionChannel } from '../src/case-session';
import { contractRegistry, loadContractFixture } from '../../../integrations/contract-fixtures/setup';

const contract = contractRegistry.contracts.find(entry => entry.id === 'case-session')!;
const published = () => loadContractFixture(contract, 'session-created.json') as Record<string, any>;
const call = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'envoi_case_snapshot', arguments: {} } });

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(yes => { resolve = yes; });
  return { promise, resolve };
}

function harness(process: CaseSessionWorkHandler['process'] = async () => {}, suppliedWork?: WorkLease) {
  let saved: ConnectorSession = {
    agentId: 'agent_example', inboxId: 'inbox_example', address: 'example@envoi.mail',
    agentApiToken: 'HOST_ACCESS_SENTINEL', agentRefreshToken: 'HOST_REFRESH_SENTINEL',
    agentTokenExpiresAt: '2026-10-17T13:00:00.000Z', agentRefreshTokenExpiresAt: '2026-11-17T12:00:00.000Z', cursor: null
  };
  const work: WorkLease = suppliedWork ?? { workId: 'msg_example', leaseToken: 'lease_PRIVATE_SENTINEL', leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(), message: {
    id: 'msg_example', caseId: 'case_example', senderAgentId: 'agent_counterparty', recipientAgentId: 'agent_example', text: 'UNTRUSTED_MESSAGE_SENTINEL',
    from: { agentId: 'agent_counterparty', address: 'counterparty@envoi.mail' }
  } };
  const controls = { available: true, statusState:'active', statusRevoked:false, mintFailures: 0, endFailures: 0, renewalFailure: false, mcpDenials: [] as string[],
    fail: undefined as undefined | (() => Promise<Response>), complete: undefined as undefined | (() => Promise<Response>) };
  const order: string[] = [];
  let minted = 0;
  const fetcher = vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const operation = path.split('/').at(-1)!; order.push(operation);
    if (operation === 'status') return controls.statusRevoked?Response.json({code:'CREDENTIAL_REVOKED'},{status:401}):Response.json({ state: controls.statusState, inboxId: saved.inboxId, agent: { id: saved.agentId }, caseSessions: { available: controls.available, version: 1 } });
    if (operation === 'claim') return Response.json({ state: 'claimed', work });
    if (operation === 'renew') {
      if (controls.renewalFailure) return Response.json({ code: 'INTERNAL_SERVER_ERROR', message: 'Temporary fault' }, { status: 500 });
      work.leaseExpiresAt = new Date(Date.now() + 120_000).toISOString();
      return Response.json({ workId: work.workId, leaseToken: work.leaseToken, leaseExpiresAt: work.leaseExpiresAt });
    }
    if (operation === 'session') {
      minted++;
      if (controls.mintFailures-- > 0) throw new Error('Committed mint response lost');
      const payload = work.message.kind === 'humanDecision'
        ? (loadContractFixture(contract, 'session-created-human-decision.json') as Record<string, any>).response.body
        : published().response.body;
      Object.assign(payload.session, { workId: work.workId, id: `case_session_run${minted}`, token: `envoi_case_session_PLACEHOLDER_run${minted}`, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 900_000).toISOString() });
      Object.assign(payload.lease, { workId: work.workId, leaseExpiresAt: work.leaseExpiresAt });
      return Response.json(payload, { status: 201 });
    }
    if (operation === 'end') {
      if (controls.endFailures-- > 0) throw new Error('Committed end response lost');
      return Response.json({ session: { id: JSON.parse(String(options?.body)).sessionId, status: 'ended' } });
    }
    if (operation === 'mcp') {
      const code = controls.mcpDenials.shift();
      if (code) return Response.json({ code, reason: code === 'CASE_SESSION_ENDED' ? 'superseded' : undefined }, { status: 401 });
      return Response.json({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{}' }], isError: false } });
    }
    if (operation === 'acknowledge' || operation === 'complete') {
      if (operation === 'complete' && controls.complete) return controls.complete();
      const state = operation === 'complete' ? 'processed' : 'acknowledged';
      return Response.json({ workId: work.workId, status: state, receipt: { messageId: work.message.id, state } });
    }
    if (operation === 'fail') return controls.fail ? controls.fail() : Response.json({ workId: work.workId, status: 'failed' });
    throw new Error(`Unexpected offline test route: ${operation}`);
  });
  const handler: CaseSessionWorkHandler = {
    admit: vi.fn(async () => { order.push('admit'); }),
    process: vi.fn(async (channel, context) => { order.push('process'); await process(channel, context); })
  };
  const store = { load: async () => saved, save: vi.fn(async (next: ConnectorSession) => { saved = structuredClone(next); }) };
  const connector = new EnvoiConnector('https://envoi.example', store, { fetch: fetcher as typeof fetch, caseSessionHandler: handler });
  const requests = () => fetcher.mock.calls.map(([url, options]) => ({ path: new URL(String(url)).pathname, options }));
  return { connector, work, controls, order, handler, store, fetcher, requests };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-17T12:00:06.000Z')); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('scoped trusted-host work loop', () => {
  it('records a permanent scoped failure, then processes later work with the same connector', async () => {
    let failed = false;
    const test = harness(async () => {
      if (!failed) { failed = true; throw new PermanentWorkError('HERMES_TURN_NOT_COMPLETED'); }
    });
    await expect(test.connector.processWorkOnce()).resolves.toBe(true);
    const failure = test.requests().find(request => request.path.endsWith('/fail'))!;
    expect(JSON.parse(String(failure.options?.body))).toEqual({ leaseToken: test.work.leaseToken, retryable: false, reasonCode: 'HERMES_TURN_NOT_COMPLETED' });
    expect(test.order.indexOf('end')).toBeLessThan(test.order.indexOf('fail'));
    expect(test.order).not.toContain('complete');
    test.work.workId = 'msg_later'; test.work.message.id = 'msg_later';
    await expect(test.connector.processWorkOnce()).resolves.toBe(true);
    expect(test.requests().filter(request => request.path.endsWith('/complete')).map(request => request.path))
      .toEqual(['/api/agent/work/msg_later/complete']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['wrong-work', 'retryable', 'malformed', 'null'])('refuses an invalid %s permanent failure settlement', async variant => {
    const test = harness(async () => { throw new PermanentWorkError('HERMES_TURN_NOT_COMPLETED'); });
    test.controls.fail = async () => Response.json(variant === 'wrong-work' ? { workId: 'msg_other', status: 'failed' }
      : variant === 'retryable' ? { workId: test.work.workId, status: 'retryable' } : variant === 'null' ? null : { failed: true });
    const result = test.connector.processWorkOnce();
    if (variant === 'null') await expect(result).rejects.toMatchObject({ code: 'CASE_SESSION_TRANSPORT_ERROR' });
    else await expect(result).rejects.toBeInstanceOf(ConnectorContractError);
    expect(test.order.filter(operation => operation === 'fail')).toHaveLength(1);
    expect(test.order).not.toContain('complete');
  });

  it('preserves an unacknowledged permanent settlement for a fenced retry', async () => {
    const test = harness(async () => { throw new PermanentWorkError('HERMES_TURN_NOT_COMPLETED'); });
    test.controls.fail = async () => { throw new Error('Lost failure receipt'); };
    await expect(test.connector.processWorkOnce()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(test.order.filter(operation => operation === 'fail')).toHaveLength(1);
    expect(test.order).not.toContain('complete');
  });

  it.each(['cancelled', 'expired'])('does not accept permanent settlement after the host was %s', async variant => {
    const stop = new AbortController();
    const test = harness(async () => { throw new PermanentWorkError('HERMES_TURN_NOT_COMPLETED'); });
    test.controls.fail = async () => {
      if (variant === 'cancelled') stop.abort();
      else vi.setSystemTime(new Date(Date.parse(test.work.leaseExpiresAt) + 1));
      return Response.json({ workId: test.work.workId, status: 'failed' });
    };
    await expect(test.connector.processWorkOnce(stop.signal)).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    expect(test.order).not.toContain('complete');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not interpret an ordinary runtime error code as a permanent disposition', async () => {
    const test = harness(async () => { throw new EnvoiError('Unknown execution', undefined, 'HERMES_TURN_NOT_COMPLETED'); });
    await expect(test.connector.processWorkOnce()).rejects.toMatchObject({ code: 'HERMES_TURN_NOT_COMPLETED' });
    const failure = test.requests().find(request => request.path.endsWith('/fail'))!;
    expect(JSON.parse(String(failure.options?.body)).retryable).toBe(true);
    expect(test.order).not.toContain('complete');
  });

  it.each(['approved', 'declined', 'expired'])('processes %s human-decision work through its case-bound tool channel', async outcome => {
    const source = loadContractFixture(contract, 'claimed-human-decision.json') as Record<string, any>;
    const work = source.response.body.work as WorkLease;
    work.message.outcome = outcome;
    if (outcome === 'expired') { work.message.senderType = 'system'; delete work.message.senderHumanId; delete work.message.from; }
    const test = harness(async channel => {
      expect(channel.modelContext().counterpartyKind).toBe('agent');
      expect(channel.modelContext().counterpartyAddress).toBe('counterparty@envoi.mail');
      expect(JSON.stringify(channel)).not.toMatch(/human_example|request_example|policy_eval_example|lease_PLACEHOLDER|msg_human_decision_example/);
      await channel.forward(call);
    }, work);
    await expect(test.connector.processWorkOnce()).resolves.toBe(true);
    expect(test.handler.admit).toHaveBeenCalledWith(work.message);
    expect(test.handler.process).toHaveBeenCalledTimes(1);
    expect(test.order.filter(operation => operation === 'complete')).toHaveLength(1);
    expect(test.order).not.toContain('fail');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { senderType: 'system' }, { from: { humanId: 'human_other' } }, { senderAgentId: 'agent_other' },
    { counterpartyAddress: 'invalid' }, { recipientInboxId: 'inbox_other' }, { caseId: '' },
    { policyEvaluationId: '' }, { requestId: '' }, { action: 'asset.share' }, { outcome: 'unknown' },
    { counterpartyAgentId: 'agent_example' }, { counterpartyInboxId: 'inbox_example' }, { text: '' }, { status: 'processed' }
  ])('rejects an invalid decision envelope before admission: %j', update => {
    const source = loadContractFixture(contract, 'claimed-human-decision.json') as Record<string, any>;
    const message = { ...source.response.body.work.message, ...update };
    expect(() => assertHumanDecisionMessage(message)).toThrow('invalid human decision');
  });

  it('admits and acknowledges once, keeps the model scoped, then ends before host settlement', async () => {
    const test = harness(async (channel, context) => {
      expect(Object.keys(context)).toEqual(['signal', 'workId']);
      expect(context.workId).toBe('msg_example');
      expect(context.signal).toBe(channel.signal);
      expect(JSON.stringify(channel)).not.toMatch(/HOST_|lease_PRIVATE|msg_example|case_example|UNTRUSTED_MESSAGE/);
      await channel.forward(call);
    });
    await expect(test.connector.processWorkOnce()).resolves.toBe(true);
    expect(test.order).toEqual(['status', 'claim', 'admit', 'acknowledge', 'status', 'session', 'process', 'mcp', 'end', 'complete']);
    expect(test.handler.process).toHaveBeenCalledTimes(1);
    for (const request of test.requests().filter(request => !request.path.endsWith('/mcp') && request.options?.body)) {
      expect(String(request.options?.body)).not.toContain('UNTRUSTED_MESSAGE');
      expect(new Headers(request.options?.headers).get('authorization')).toBe('Bearer HOST_ACCESS_SENTINEL');
    }
    expect(test.requests().filter(request => request.path.endsWith('/complete')).map(request => JSON.parse(String(request.options?.body))))
      .toEqual([{ leaseToken: test.work.leaseToken }]);
    expect(JSON.stringify(test.store.save.mock.calls)).not.toContain('envoi_case_session_');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refuses unavailable sessions before claiming work or admitting a model turn', async () => {
    const test = harness(); test.controls.available = false;
    await expect(test.connector.processWorkOnce()).rejects.toMatchObject({ code: 'FEATURE_DISABLED' });
    expect(test.order).toEqual(['status']); expect(test.handler.admit).not.toHaveBeenCalled();
  });

  it('does not expose privileged model credentials or forwarding in scoped mode', async () => {
    const test = harness();
    await expect(test.connector.currentAccessToken()).rejects.toMatchObject({ code: 'LEGACY_MODEL_ACCESS_DISABLED' });
    expect(() => test.connector.mintMcpReadToken()).toThrow('Scoped runtimes');
    expect(() => test.connector.forwardMcpRequest(call)).toThrow('Scoped runtimes');
    expect(test.fetcher).not.toHaveBeenCalled();
  });

  it('cannot install both scoped and legacy work handlers', () => {
    const test = harness();
    expect(() => new EnvoiConnector('https://envoi.example', test.store, { caseSessionHandler: test.handler, handler: { admit: async () => {}, process: async () => {} } })).toThrow('cannot fall back');
  });

  it.each(['CASE_SESSION_EXPIRED', 'CASE_SESSION_ENDED', 'AUTHENTICATION_REQUIRED'])('remints only once after %s, without readmitting or acknowledging twice', async code => {
    const test = harness(async channel => { await channel.forward(call); }); test.controls.mcpDenials = [code];
    await expect(test.connector.processWorkOnce()).resolves.toBe(true);
    expect(test.handler.admit).toHaveBeenCalledTimes(1); expect(test.handler.process).toHaveBeenCalledTimes(2);
    expect(test.order.filter(operation => operation === 'acknowledge')).toHaveLength(1);
    expect(test.order.filter(operation => operation === 'session')).toHaveLength(2);
    expect(test.order.filter(operation => operation === 'complete')).toHaveLength(1);
    expect(test.requests().every(request => !request.path.includes('agent-token') && !request.path.includes('/messages'))).toBe(true);
  });

  it('does not loop indefinitely or settle after the bounded remint also expires', async () => {
    const test = harness(async channel => { await channel.forward(call); }); test.controls.mcpDenials = ['CASE_SESSION_EXPIRED', 'CASE_SESSION_EXPIRED'];
    await expect(test.connector.processWorkOnce()).rejects.toMatchObject({ code: 'CASE_SESSION_EXPIRED' });
    expect(test.handler.process).toHaveBeenCalledTimes(2);
    expect(test.order).not.toContain('complete'); expect(test.order).not.toContain('fail');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('recovers a lost mint response with the identical body and no new enrollment or claim', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const test = harness(); test.controls.mintFailures = 1;
    const pending = test.connector.processWorkOnce();
    await vi.advanceTimersByTimeAsync(600);
    await expect(pending).resolves.toBe(true);
    const mints = test.requests().filter(request => request.path.endsWith('/session'));
    expect(mints).toHaveLength(2);
    expect(mints[0].options?.body).toBe(mints[1].options?.body);
    expect(new Headers(mints[0].options?.headers).has('idempotency-key')).toBe(false);
    expect(test.handler.process).toHaveBeenCalledTimes(1);
    expect(test.order.filter(operation => operation === 'claim')).toHaveLength(1);
  });

  it('allows only one mint in flight per work', async () => {
    const test = harness(); const first = test.connector.mintCaseSession(test.work);
    await expect(test.connector.mintCaseSession(test.work)).rejects.toThrow('already in flight');
    const channel = await first; await channel.end();
    expect(test.order.filter(operation => operation === 'session')).toHaveLength(1);
  });

  it('recovers a lost session-end response without rerunning the model or failing the work', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const test = harness(); test.controls.endFailures = 1;
    const pending = test.connector.processWorkOnce(); await vi.advanceTimersByTimeAsync(600);
    await expect(pending).resolves.toBe(true);
    const ends = test.requests().filter(request => request.path.endsWith('/end'));
    expect(ends).toHaveLength(2); expect(ends[0].options?.body).toBe(ends[1].options?.body);
    expect(test.handler.process).toHaveBeenCalledTimes(1);
    expect(test.order.filter(operation => operation === 'complete')).toHaveLength(1);
    expect(test.order).not.toContain('fail');
  });

  it('renews within 20 seconds and immediately cancels on the first renewal error', async () => {
    const started = deferred<void>(); const never = deferred<void>(); let turnSignal!: AbortSignal;
    const test = harness(async (_channel, context) => { turnSignal = context.signal; started.resolve(); await never.promise; });
    test.controls.renewalFailure = true;
    const pending = test.connector.processWorkOnce(); const rejected = expect(pending).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    await started.promise; await vi.advanceTimersByTimeAsync(20_000); await rejected;
    expect(turnSignal.aborted).toBe(true);
    expect(test.order.filter(operation => operation === 'renew')).toHaveLength(1);
    expect(test.order).not.toContain('complete'); expect(test.order).not.toContain('fail');
    never.resolve(); await Promise.resolve();
    expect(test.order).not.toContain('complete'); expect(vi.getTimerCount()).toBe(0);
  });

  it('renews a long turn on the host without reminting or duplicating acknowledgement', async () => {
    const started = deferred<void>(); const finished = deferred<void>();
    const test = harness(async () => { started.resolve(); await finished.promise; });
    const pending = test.connector.processWorkOnce(); await started.promise;
    await vi.advanceTimersByTimeAsync(40_001);
    expect(test.order.filter(operation => operation === 'renew')).toHaveLength(2);
    expect(test.order.filter(operation => operation === 'session')).toHaveLength(1);
    finished.resolve(); await expect(pending).resolves.toBe(true);
    expect(test.order.filter(operation => operation === 'acknowledge')).toHaveLength(1);
    expect(test.order.filter(operation => operation === 'complete')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['agent.pause', 'case.pause', 'credential.revoke'])('cancels a noncooperating provider and discards its late result on %s', async control => {
    const started = deferred<void>(); const late = deferred<void>(); let oldChannel!: CaseSessionChannel;
    const test = harness(async channel => { oldChannel = channel; started.resolve(); await late.promise; });
    const pending = test.connector.processWorkOnce(); const rejected = expect(pending).rejects.toBeDefined();
    await started.promise;
    if (control === 'agent.pause') await test.connector.observeEvent({ agentId: 'agent_example', type: 'agent.paused' });
    else if (control === 'credential.revoke') await test.connector.observeEvent({ type: 'credential.ended', code: 'CREDENTIAL_REVOKED', reason: 'revoked' });
    else await test.connector.observeEvent({ type: 'case_session.ended', agentId: 'agent_example', workId: 'msg_example', caseId: 'case_example', sessionId: 'case_session_run1', reason: 'case_controlled' });
    await rejected; late.resolve(); await Promise.resolve();
    expect(oldChannel.signal.aborted).toBe(true);
    await expect(oldChannel.forward(call)).rejects.toBeDefined();
    expect(test.order).not.toContain('complete'); expect(test.order).not.toContain('fail');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not report a late completion response as success after pause', async () => {
    const completing = deferred<void>(); const reply = deferred<Response>();
    const test = harness(); test.controls.complete = () => { completing.resolve(); return reply.promise; };
    const pending = test.connector.processWorkOnce(); const rejected = expect(pending).rejects.toBeDefined();
    await completing.promise;
    await test.connector.observeEvent({ type: 'agent.paused', agentId: 'agent_example' });
    reply.resolve(Response.json({ workId: 'msg_example', status: 'processed', receipt: { messageId: 'msg_example', state: 'processed' } }));
    await rejected;
    expect(test.order.filter(operation => operation === 'complete')).toHaveLength(1);
    expect(test.order).not.toContain('fail');
  });

  it('ends the private channel before reporting an ordinary handler failure to the host queue', async () => {
    const test = harness(async () => { throw new Error('Provider failed'); });
    await expect(test.connector.processWorkOnce()).rejects.toThrow('Provider failed');
    expect(test.order.indexOf('end')).toBeLessThan(test.order.indexOf('fail'));
    expect(test.order).not.toContain('complete'); expect(test.handler.process).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('trusted retired-lease server denial probes',()=>{
  const args=(test:ReturnType<typeof harness>,expected:'paused'|'revoked'|'expired'='expired')=>({workId:test.work.workId,
    leaseToken:test.work.leaseToken,leaseExpiresAt:test.work.leaseExpiresAt,expected});
  const retire=async(test:ReturnType<typeof harness>)=>{await expect(test.connector.processWorkOnce()).rejects.toThrow('Controlled stop');};
  const expire=(test:ReturnType<typeof harness>)=>vi.setSystemTime(Date.parse(test.work.leaseExpiresAt)+1501);
  it('requires a real retired SDK claim and exact latest lease metadata before any HTTP',async()=>{
    const test=harness(async()=>{throw Error('Controlled stop');});
    await expect(test.connector.probeStaleControlSettlementOnce(args(test),{signal:new AbortController().signal})).rejects.toMatchObject({code:'ACTUAL_RETIRED_CONTROL_LEASE_REQUIRED'});
    expect(test.fetcher).not.toHaveBeenCalled();await retire(test);expire(test);
    const count=test.fetcher.mock.calls.length;
    await expect(test.connector.probeStaleControlSettlementOnce({...args(test),leaseExpiresAt:new Date(Date.now()-1).toISOString()},{signal:new AbortController().signal})).rejects.toMatchObject({code:'ACTUAL_RETIRED_CONTROL_LEASE_REQUIRED'});
    expect(test.fetcher.mock.calls).toHaveLength(count);
  });
  it('returns the actual server stale-lease response once, without a token output or retries',async()=>{
    const test=harness(async()=>{throw Error('Controlled stop');});await retire(test);expire(test);
    test.controls.complete=async()=>Response.json({code:'WORK_LEASE_STALE'},{status:409});
    const result=await test.connector.probeStaleControlSettlementOnce(args(test),{signal:new AbortController().signal});
    expect(result.settlement).toEqual({status:409,raw:JSON.stringify({code:'WORK_LEASE_STALE'})});
    expect(JSON.stringify(result)).not.toContain(test.work.leaseToken);
    await expect(test.connector.probeStaleControlSettlementOnce(args(test),{signal:new AbortController().signal})).rejects.toMatchObject({code:'CONTROL_PROBE_ALREADY_ATTEMPTED'});
    expect(test.order.filter(x=>x==='complete')).toHaveLength(1);
  });
  it('refuses an unexpired retired claim, even if a caller labels it expired',async()=>{
    const test=harness(async()=>{throw Error('Controlled stop');});await retire(test);const count=test.fetcher.mock.calls.length;
    await expect(test.connector.probeStaleControlSettlementOnce(args(test),{signal:new AbortController().signal})).rejects.toMatchObject({code:'ACTUAL_RETIRED_CONTROL_LEASE_REQUIRED'});expect(test.fetcher.mock.calls).toHaveLength(count);
  });
  it('observes actual paused state and allows a separate expiry probe only after the frozen lease tail',async()=>{
    const test=harness(async()=>{throw Error('Controlled stop');});await retire(test);test.controls.statusState='paused';
    test.controls.complete=async()=>Response.json({code:'AGENT_PAUSED'},{status:409});
    expect((await test.connector.probeStaleControlSettlementOnce(args(test,'paused'),{signal:new AbortController().signal})).settlement.status).toBe(409);
    test.controls.statusState='active';expire(test);test.controls.complete=async()=>Response.json({code:'WORK_LEASE_STALE'},{status:409});
    expect((await test.connector.probeStaleControlSettlementOnce(args(test),{signal:new AbortController().signal})).settlement.status).toBe(409);
    expect(test.order.filter(x=>x==='complete')).toHaveLength(2);
  });
  it('does not use local paused metadata as server precondition evidence',async()=>{
    const test=harness(async()=>{throw Error('Controlled stop');});await retire(test);
    await test.connector.observeEvent({agentId:'agent_example',type:'agent.paused'});
    await expect(test.connector.probeStaleControlSettlementOnce(args(test,'paused'),{signal:new AbortController().signal})).rejects.toMatchObject({code:'ACTUAL_CONTROL_PRECONDITION_REQUIRED'});expect(test.order).not.toContain('complete');
  });
  it('can obtain an actual revoked denial with the saved credential without refreshing or reconnecting',async()=>{
    const test=harness(async()=>{throw Error('Controlled stop');});await retire(test);
    await test.connector.observeError(new EnvoiError('revoked',401,'CREDENTIAL_REVOKED'));
    test.controls.statusRevoked=true;test.controls.complete=async()=>Response.json({code:'CREDENTIAL_REVOKED'},{status:401});
    const result=await test.connector.probeStaleControlSettlementOnce(args(test,'revoked'),{signal:new AbortController().signal});
    expect(result.status.status).toBe(401);expect(result.settlement.status).toBe(401);expect(test.order).not.toContain('agent-token');
    expect((await test.connector.lifecycle()).state).toBe('REVOKED');
  });
  it('quarantines a lost completion response and never submits it again',async()=>{
    const test=harness(async()=>{throw Error('Controlled stop');});await retire(test);expire(test);
    test.controls.complete=async()=>{throw Error('PRIVATE_NETWORK');};
    await expect(test.connector.probeStaleControlSettlementOnce(args(test),{signal:new AbortController().signal})).rejects.toMatchObject({code:'CONTROL_PROBE_RESULT_UNKNOWN'});
    await expect(test.connector.probeStaleControlSettlementOnce(args(test),{signal:new AbortController().signal})).rejects.toMatchObject({code:'CONTROL_PROBE_ALREADY_ATTEMPTED'});expect(test.order.filter(x=>x==='complete')).toHaveLength(1);
  });
  it('stops if the stale probe unexpectedly processes; a successful denial is never fabricated',async()=>{
    const test=harness(async()=>{throw Error('Controlled stop');});await retire(test);expire(test);
    await expect(test.connector.probeStaleControlSettlementOnce(args(test),{signal:new AbortController().signal})).rejects.toMatchObject({code:'STALE_CONTROL_UNEXPECTEDLY_PROCESSED'});
    expect((await test.connector.lifecycle()).state).toBe('STOPPED');
  });
  it('never permits probing a work that the SDK already processed',async()=>{
    const test=harness();await test.connector.processWorkOnce();expire(test);const before=test.fetcher.mock.calls.length;
    await expect(test.connector.probeStaleControlSettlementOnce(args(test),{signal:new AbortController().signal})).rejects.toMatchObject({code:'ACTUAL_RETIRED_CONTROL_LEASE_REQUIRED'});expect(test.fetcher.mock.calls).toHaveLength(before);
  });
});
