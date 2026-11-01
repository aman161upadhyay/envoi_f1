import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorSession } from '../../sdk/typescript/src/connector';
import { FileBridgeStore } from '../agent-bridges/file-store';
import { FileScopedRunStore } from '../grok/scoped-store';
import { contractRegistry, loadContractFixture } from '../contract-fixtures/setup';
import { createHermesBridge } from './runtime';
import { hermesAdapter } from './adapter';
import { prepareHermesRun } from './run';
import { selectScopedHermes } from './scoped-runtime';
import { currentHermesHost, hermesProfileIdentity } from './scoped-host';

interface Fixture { request?: { path?: string; body?: Record<string, any> }; response?: { status: number; body: Record<string, any> }; steps?: Fixture[] }
const cleanups: Array<() => Promise<unknown>> = [];
const origin = 'https://envoi.example';
const access = 'PRIVATE_HOST_ACCESS_FIXTURE', refresh = 'PRIVATE_HOST_REFRESH_FIXTURE';
const daemon = 'http://127.0.0.1:18973';

function fixture(name: string): Fixture {
  const [contractId, filename] = name.split('/');
  const contract = contractRegistry.contracts.find(entry => entry.id === contractId)!;
  const source = JSON.stringify(loadContractFixture(contract, filename + '.json'));
  const offset = Date.now() - Date.parse('2026-10-17T12:00:06.000Z');
  return JSON.parse(source, (_key, value: unknown) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    ? new Date(Date.parse(value) + offset).toISOString() : value);
}

async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), 'envoi-hermes-scoped-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, 'profile'); await mkdir(home);
  const configPath = path.join(home, 'config.yaml');
  await writeFile(configPath, 'model:\n  default: existing-model\n  provider: existing-provider\n');
  const env = { ENVOI_SCOPED_TOOLS: 'true', HERMES_HOME: home, HERMES_DAEMON_URL: daemon };
  const config = await selectScopedHermes({ env });
  const status = fixture('case-session/agent-status-case-sessions').response!;
  const flow = fixture('http-wake/wake-then-claim-and-mint');
  const claim = flow.steps!.find(step => step.request?.path === '/api/agent/work/claim')!.response!;
  const minted = fixture('case-session/session-created').response!;
  const ended = fixture('case-session/session-end').response!;
  const snapshot = fixture('case-tools/snapshot-agent-work').response!;
  const reply = fixture('case-tools/reply-agent-work');
  const work = claim.body.work;
  work.leaseExpiresAt = new Date(Date.now() + 120000).toISOString();
  minted.body.lease.leaseExpiresAt = work.leaseExpiresAt;
  minted.body.session.createdAt = new Date().toISOString();
  minted.body.session.expiresAt = new Date(Date.parse(minted.body.session.createdAt) + 900000).toISOString();
  const credentials: ConnectorSession = { agentId: 'agent_example', inboxId: 'inbox_example', address: 'example@envoi.mail', cursor: null,
    agentApiToken: access, agentRefreshToken: refresh, agentTokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    agentRefreshTokenExpiresAt: new Date(Date.now() + 86400000).toISOString() };
  const store = new FileBridgeStore(directory); await store.init(); await store.save(credentials);
  const toolRequests: Record<string, any>[] = [], rpcRequests: Record<string, any>[] = [], modelText: string[] = [];
  const bootstrap: Record<string, any>[] = [], sockets: FakeSocket[] = [];
  const extra = new Map<string, Fixture>(), effects = new Set<string>();
  let claimable = true, currentStatus = 'terminal', outcome = 'completed', admissionId = 'admission_fixture';
  let serverSpec: Record<string, any> | undefined, onPrompt: () => Promise<void> = async () => {};
  let mcpConnectionId = '1'.repeat(32);
  const inputs = new Set<string>();
  let lostSubmit = false, loseReceipt = false, sourceCapabilities = ['acp-editor-policy-v1', 'acp-session-mcp-v1'];
  let controlCapabilities = ['session-authority-v1', 'durable-admission-v1', 'event-replay-v1'];
  const netTarget = process.platform === 'win32' ? `\\\\.\\pipe\\hermes-gateway-${createHash('sha256').update(path.resolve(home).toLowerCase()).digest('hex').slice(0, 16)}` : path.join(home, 'gateway.sock');
  const server = createServer(socket => {
    socket.setEncoding('utf8'); let text = '';
    socket.on('data', chunk => {
      text += chunk; if (!text.includes('\n')) return;
      const request = JSON.parse(text); bootstrap.push(request);
      const result = request.verb === 'identify' ? { runtime_protocol: 1, state: 'ready', api_origin: daemon, instance_id: 'instance_fixture', capabilities: controlCapabilities,
        served_profiles: [{ home, profile_id: home }] } : { runtime_protocol: 1, instance_id: 'instance_fixture', profile_id: home, ticket: 'PRIVATE_FIXTURE_TICKET_1234567890' };
      socket.end(JSON.stringify({ protocol: 1, id: 1, ok: true, result }) + '\n');
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(netTarget, resolve); });
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  async function mcp(method: string, params?: Record<string, unknown>) {
    const environment = Object.fromEntries(serverSpec!.env.map((entry: { name: string; value: string }) => [entry.name, entry.value]));
    const response = await fetch(environment.ENVOI_SCOPED_MCP_URL, { method: 'POST', headers: {
      authorization: 'Bearer ' + environment.ENVOI_SCOPED_MCP_TOKEN, 'content-type': 'application/json',
      'x-envoi-mcp-connection': mcpConnectionId
    }, body: JSON.stringify({ jsonrpc: '2.0', ...(method === 'notifications/initialized' ? {} : { id: 'fixture_call' }), method, ...(params ? { params } : {}) }) });
    return response.status === 204 ? null : response.json();
  }
  const receipt = () => ({ admission_id: admissionId, ref: { profile_id: home, session_id: 'hermes_session_fixture' },
    status: currentStatus, outcome: currentStatus === 'terminal' ? outcome : null, execution_generation: 1, authority_epoch: 1, sequence: 1 });
  class FakeSocket extends EventTarget {
    readyState = 0; bufferedAmount = 0; protocol = 'hermes-gateway-v1';
    constructor(url: string, protocols: string[]) {
      super(); expect(url).toBe(daemon.replace('http:', 'ws:') + '/api/ws');
      expect(protocols).toEqual(['hermes-gateway-v1', 'hermes-gateway-ticket.PRIVATE_FIXTURE_TICKET_1234567890']);
      sockets.push(this); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); });
    }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')); }
    send(text: string) {
      const request = JSON.parse(text); rpcRequests.push(request);
      void this.answer(request).then(result => {
        if (this.readyState === 1 && result !== undefined) this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) }));
      }).catch(error => {
        if (this.readyState === 1) this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ jsonrpc: '2.0', id: request.id,
          error: { code: 4001, message: error.message === 'stale_generation' ? 'stale_generation' : 'fixture_failure' } }) }));
      });
    }
    async answer(request: Record<string, any>) {
      const params = request.params;
      if (request.method === 'runtime.describe') return { profile_id: home, instance_id: 'instance_fixture', capabilities: sourceCapabilities, session_create: { sources: ['acp'] } };
      if (request.method === 'session.create') {
        expect(params).toMatchObject({ source: 'acp', cwd: home, toolsets: ['no_mcp'], accept_hooks: false });
        serverSpec = params.editor.mcp_servers[0];
        await mcp('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'inert-daemon', version: '1' } });
        await mcp('notifications/initialized');
        const listed = await mcp('tools/list');
        expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(minted.body.session.allowedTools);
        return { session_id: 'hermes_session_fixture', subscription_id: 'subscription_fixture' };
      }
      if (request.method === 'session.resume') return { session_id: 'hermes_session_fixture', subscription_id: 'subscription_fixture',
        pending: currentStatus === 'terminal' ? [] : [{ ...receipt(), input_id: rpcRequests.find(entry => entry.method === 'prompt.submit')?.params.input_id }] };
      if (request.method === 'prompt.submit') {
        if (!inputs.has(params.input_id)) {
          inputs.add(params.input_id); modelText.push(params.text);
          // Like the real Gateway, execution rediscovers the editor server with a new stdio process.
          mcpConnectionId = '2'.repeat(32);
          const initialized = await mcp('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'inert-daemon', version: '1' } });
          expect(initialized.error).toBeUndefined();
          await mcp('notifications/initialized'); await mcp('tools/list');
          await onPrompt();
        }
        if (lostSubmit) { lostSubmit = false; this.close(); return; }
        return receipt();
      }
      if (request.method === 'prompt.receipt') {
        expect(params.admission_id).toBe(admissionId);
        if (loseReceipt) { loseReceipt = false; this.close(); return; }
        return receipt();
      }
      if (request.method === 'prompt.cancel') {
        if (currentStatus === 'started') throw new Error('stale_generation');
        return receipt();
      }
      if (request.method === 'session.interrupt') {
        expect(params.execution_generation).toBe(1); currentStatus = 'terminal'; outcome = 'interrupted'; return {};
      }
      if (request.method === 'session.detach') return { detached: true };
      throw new Error('Unexpected Hermes RPC ' + request.method);
    }
  }
  vi.stubGlobal('WebSocket', FakeSocket);
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input)), body = init?.body ? JSON.parse(String(init.body)) : {};
    const authorization = new Headers(init?.headers).get('authorization');
    expect(url.origin).toBe(origin);
    if (url.pathname === '/mcp') {
      expect(authorization).toBe('Bearer ' + minted.body.session.token); toolRequests.push(body);
      const name = body.params.name;
      const value = name === 'envoi_case_snapshot' ? { response: snapshot } : extra.get(name) ?? reply;
      if (name !== 'envoi_case_snapshot') expect(body.params.arguments).toEqual(value.request!.body!.params.arguments);
      if (name === 'envoi_case_reply' && value.response!.status < 400) effects.add(body.params.arguments.idempotencyKey);
      return Response.json({ ...structuredClone(value.response!.body), id: body.id }, { status: value.response!.status });
    }
    expect(authorization).toBe('Bearer ' + access);
    if (url.pathname === '/api/agent/status') return Response.json(status.body);
    if (url.pathname === '/api/agent/work/claim') {
      if (!claimable) return Response.json({ work: null, state: 'idle' }); claimable = false; return Response.json(claim.body);
    }
    const prefix = '/api/agent/work/' + work.workId;
    if (url.pathname === prefix + '/session') return Response.json(minted.body, { status: minted.status });
    if (url.pathname === prefix + '/session/end') return Response.json(ended.body);
    if (url.pathname === prefix + '/renew') return Response.json({ workId: work.workId, leaseToken: work.leaseToken, leaseExpiresAt: work.leaseExpiresAt });
    const operation = url.pathname.slice(prefix.length + 1); expect(['acknowledge', 'complete', 'fail']).toContain(operation);
    const state = operation === 'acknowledge' ? 'acknowledged' : operation === 'complete' ? 'processed' : 'failed';
    return Response.json({ workId: work.workId, status: state, receipt: { messageId: work.workId, state } });
  });
  const open = async (requestedEnv: NodeJS.ProcessEnv = {}, timeoutMs = 1000) => {
    const bridge = await createHermesBridge({ apiUrl: origin, stateDir: directory, hermesUrl: '', hermesKey: '', runtime: config! },
      { env: requestedEnv, fetch: fetcher, pollMs: 1, timeoutMs });
    cleanups.push(bridge.close); return bridge;
  };
  return { directory, home, config: config!, env, store, fetcher, minted, work, toolRequests, rpcRequests, modelText, bootstrap, sockets,
    effects, open, mcp, replyArgs: reply.request!.body!.params.arguments,
    snapshot: snapshot.body,
    onPrompt: (action: typeof onPrompt) => { onPrompt = action; },
    addTool: (value: Fixture) => { extra.set(value.request!.body!.params.name, value); },
    setStatus: (status: string, result = 'completed') => { currentStatus = status; outcome = result; },
    loseSubmit: () => { lostSubmit = true; }, loseReceipt: () => { loseReceipt = true; },
    capabilities: (capabilities: string[]) => { sourceCapabilities = capabilities; },
    controlCapabilities: (capabilities: string[]) => { controlCapabilities = capabilities; },
    reclaim: () => { claimable = true; minted.body.session.fence++; },
    journal: () => new FileScopedRunStore(directory).load(work.workId)
  };
}

afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('production Hermes scoped composition with inert authenticated daemon transport', () => {
  it('discovers the selected private gateway and verifies its ticketed descriptor without creating a session or prompt', async () => {
    const scenario = await setup();
    expect(await currentHermesHost(scenario.home, scenario.home, new AbortController().signal)).toEqual({ home: scenario.home, cwd: scenario.home, origin: daemon });
    expect(scenario.bootstrap.map(entry => entry.verb)).toEqual(['identify', 'identify', 'session-ticket']);
    expect(scenario.rpcRequests.map(entry => entry.method)).toEqual(['runtime.describe']);
    expect(scenario.modelText).toEqual([]); expect(scenario.fetcher).not.toHaveBeenCalled();
    expect(scenario.sockets.every(socket => socket.readyState === 3)).toBe(true);
  });
  it.each(['control', 'descriptor'])('refuses a gateway missing canonical %s capabilities before model work', async source => {
    const scenario = await setup();
    if (source === 'control') scenario.controlCapabilities([]); else scenario.capabilities([]);
    await expect(currentHermesHost(scenario.home, scenario.home, new AbortController().signal)).rejects.toThrow();
    expect(scenario.rpcRequests.every(entry => entry.method === 'runtime.describe')).toBe(true);
    expect(scenario.modelText).toEqual([]); expect(scenario.fetcher).not.toHaveBeenCalled();
    expect(scenario.sockets.every(socket => socket.readyState === 3)).toBe(true);
  });
  it('executes typed tools, separates credentials and deduplicates a completed work after restart', async () => {
    const scenario = await setup();
    scenario.onPrompt(async () => { expect((await scenario.mcp('tools/call', { name: 'envoi_case_reply', arguments: scenario.replyArgs })).result.isError).toBe(false); });
    const bridge = await scenario.open();
    expect(scenario.fetcher).not.toHaveBeenCalled();
    await expect(bridge.connector.scopedWakeWorkDriver().processWorkOnce()).resolves.toBe(true);
    expect(scenario.effects.size).toBe(1);
    expect(scenario.toolRequests.map(entry => entry.params.name)).toEqual(['envoi_case_snapshot', 'envoi_case_reply']);
    expect(await scenario.journal()).toMatchObject({ completed: true, providerCalls: 1 });
    const model = scenario.modelText.join('');
    for (const secret of [access, refresh, scenario.work.leaseToken, scenario.minted.body.session.token, scenario.work.workId, scenario.work.message.caseId, 'PRIVATE_FIXTURE_TICKET']) expect(model).not.toContain(secret);
    const journal = await readFile(path.join(scenario.directory, 'scoped-runs', scenario.work.workId + '.json'), 'utf8');
    for (const secret of [access, refresh, scenario.work.leaseToken, scenario.minted.body.session.token, 'PRIVATE_FIXTURE_TICKET']) expect(journal).not.toContain(secret);
    scenario.reclaim(); await bridge.close();
    const recovered = await scenario.open(); await recovered.connector.scopedWakeWorkDriver().processWorkOnce();
    expect(scenario.modelText).toHaveLength(1); expect(scenario.effects.size).toBe(1);
    expect(scenario.bootstrap.filter(entry => entry.verb === 'session-ticket')[0].params.purpose).toBe('interactive');
    expect(scenario.sockets.every(socket => socket.readyState === 3)).toBe(true);
  });
  it('retains a completed legacy journal across a gateway address change without resubmission or a second effect', async () => {
    const scenario = await setup();
    scenario.onPrompt(async () => { await scenario.mcp('tools/call', { name: 'envoi_case_reply', arguments: scenario.replyArgs }); });
    const bridge = await scenario.open(); await bridge.connector.scopedWakeWorkDriver().processWorkOnce(); await bridge.close();
    const runs = new FileScopedRunStore(scenario.directory), completed = (await scenario.journal())!;
    expect(completed.model).toBe(hermesProfileIdentity({ home: scenario.home, cwd: scenario.home, origin: daemon }));
    const legacy = { ...completed, model: `hermes-daemon:http://127.0.0.1:18975:${scenario.home}:${scenario.home}` };
    await runs.save(legacy); const before = await readFile(path.join(scenario.directory, 'scoped-runs', scenario.work.workId + '.json'), 'utf8');
    scenario.reclaim(); const recovered = await scenario.open(); await recovered.connector.scopedWakeWorkDriver().processWorkOnce();
    expect(scenario.modelText).toHaveLength(1); expect(scenario.effects.size).toBe(1);
    expect(await readFile(path.join(scenario.directory, 'scoped-runs', scenario.work.workId + '.json'), 'utf8')).toBe(before);
  });
  it('recovers a lost submit acknowledgement using its durable input identity without a replacement turn', async () => {
    const scenario = await setup(); scenario.loseSubmit();
    const bridge = await scenario.open(); await expect(bridge.connector.scopedWakeWorkDriver().processWorkOnce()).rejects.toThrow();
    expect(await scenario.journal()).toMatchObject({ completed: false });
    scenario.reclaim(); const recovered = await scenario.open(); await recovered.connector.scopedWakeWorkDriver().processWorkOnce();
    const submissions = scenario.rpcRequests.filter(entry => entry.method === 'prompt.submit');
    expect(submissions).toHaveLength(2); expect(submissions[1].params).toEqual(submissions[0].params);
    expect(scenario.modelText).toHaveLength(1);
    expect(scenario.rpcRequests.filter(entry => entry.method === 'session.create')).toHaveLength(1);
    expect(await scenario.journal()).toMatchObject({ completed: true });
  });
  it('recovers a lost terminal receipt by reading the original admission only', async () => {
    const scenario = await setup(); scenario.loseReceipt();
    const bridge = await scenario.open(); await expect(bridge.connector.scopedWakeWorkDriver().processWorkOnce()).rejects.toThrow();
    scenario.reclaim(); const recovered = await scenario.open(); await recovered.connector.scopedWakeWorkDriver().processWorkOnce();
    expect(scenario.modelText).toHaveLength(1); expect(await scenario.journal()).toMatchObject({ completed: true });
  });
  it('never resamples an unknown execution', async () => {
    const scenario = await setup(); scenario.setStatus('unknown');
    const bridge = await scenario.open(); await expect(bridge.connector.scopedWakeWorkDriver().processWorkOnce()).rejects.toThrow();
    scenario.reclaim(); const recovered = await scenario.open(); await expect(recovered.connector.scopedWakeWorkDriver().processWorkOnce()).rejects.toThrow();
    expect(scenario.modelText).toHaveLength(1); expect(await scenario.journal()).toMatchObject({ completed: false });
  });
  it.each(['failed', 'interrupted', 'cancelled', 'rejected'])('settles a saved terminal %s turn as failed without replacing it or stopping later work', async outcome => {
    const scenario = await setup(); scenario.setStatus('unknown');
    const original = await scenario.open();
    await expect(original.connector.scopedWakeWorkDriver().processWorkOnce()).rejects.toThrow();
    await original.close();
    const filename = path.join(scenario.directory, 'scoped-runs', scenario.work.workId + '.json');
    const journal = await readFile(filename, 'utf8');
    scenario.setStatus('terminal', outcome); scenario.reclaim();
    const recovered = await scenario.open();
    await expect(recovered.connector.scopedWakeWorkDriver().processWorkOnce()).resolves.toBe(true);
    const failed = scenario.fetcher.mock.calls.filter(([url]) => String(url).endsWith('/fail')).at(-1)!;
    expect(JSON.parse(String(failed[1]?.body))).toEqual({ leaseToken: scenario.work.leaseToken, retryable: false, reasonCode: 'HERMES_TURN_NOT_COMPLETED' });
    expect(await readFile(filename, 'utf8')).toBe(journal);
    expect(scenario.rpcRequests.filter(entry => entry.method === 'session.create')).toHaveLength(1);
    expect(scenario.rpcRequests.filter(entry => entry.method === 'prompt.submit')).toHaveLength(1);
    expect(scenario.effects.size).toBe(0);
    expect(scenario.fetcher.mock.calls.some(([url]) => String(url).endsWith('/complete'))).toBe(false);
    await expect(recovered.connector.scopedWakeWorkDriver().processWorkOnce()).resolves.toBe(false);
  });
  it('refuses an unrecognized terminal outcome without permanently failing or completing the work', async () => {
    const scenario = await setup(); scenario.setStatus('terminal', 'unrecognized');
    const bridge = await scenario.open();
    await expect(bridge.connector.scopedWakeWorkDriver().processWorkOnce()).rejects.toMatchObject({ code: 'HERMES_EXECUTION_UNCERTAIN' });
    const failed = scenario.fetcher.mock.calls.find(([url]) => String(url).endsWith('/fail'))!;
    expect(JSON.parse(String(failed[1]?.body)).retryable).toBe(true);
    expect(await scenario.journal()).toMatchObject({ completed: false });
    expect(scenario.effects.size).toBe(0);
  });
  it('records human wait before stopping the vendor turn and refuses late scoped callbacks', async () => {
    const scenario = await setup();
    const authority = fixture('case-tools/authority-check-needs-human'); scenario.addTool(authority);
    const request = fixture('case-tools/request-human'); scenario.addTool(request);
    scenario.setStatus('started');
    scenario.onPrompt(async () => {
      await scenario.mcp('tools/call', { name: 'envoi_authority_check', arguments: authority.request!.body!.params.arguments });
      await scenario.mcp('tools/call', { name: 'envoi_request_human', arguments: request.request!.body!.params.arguments });
    });
    const bridge = await scenario.open(); await bridge.connector.scopedWakeWorkDriver().processWorkOnce();
    expect(await scenario.journal()).toMatchObject({ completed: true });
    await bridge.close();
    expect(scenario.rpcRequests.find(entry => entry.method === 'prompt.cancel')?.params).toEqual({ session_id: 'hermes_session_fixture', admission_id: 'admission_fixture' });
    expect(scenario.rpcRequests.find(entry => entry.method === 'session.interrupt')?.params).toEqual({ session_id: 'hermes_session_fixture', execution_generation: 1 });
    expect(scenario.sockets.every(socket => socket.readyState === 3)).toBe(true);
    await expect(scenario.mcp('tools/call', { name: 'envoi_case_reply', arguments: scenario.replyArgs })).rejects.toThrow();
    scenario.reclaim(); const recovered = await scenario.open(); await recovered.connector.scopedWakeWorkDriver().processWorkOnce();
    expect(scenario.modelText).toHaveLength(1); expect(scenario.effects.size).toBe(0);
  });
  it('cancels the exact executing admission on close and denies callbacks after close', async () => {
    const scenario = await setup(); scenario.setStatus('started');
    let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
    scenario.onPrompt(async () => { began(); });
    const bridge = await scenario.open(); const operation = expect(bridge.connector.scopedWakeWorkDriver().processWorkOnce()).rejects.toThrow();
    await started; await bridge.close(); await operation;
    expect(scenario.rpcRequests.some(entry => entry.method === 'prompt.cancel')).toBe(true);
    expect(scenario.rpcRequests.find(entry => entry.method === 'session.interrupt')?.params).toEqual({ session_id: 'hermes_session_fixture', execution_generation: 1 });
    await expect(scenario.mcp('tools/call', { name: 'envoi_case_reply', arguments: scenario.replyArgs })).rejects.toThrow();
    expect(scenario.effects.size).toBe(0);
  });
  it('refuses a changed session/case binding before contacting the daemon', async () => {
    const scenario = await setup(); scenario.minted.body.session.caseId = 'case_unrelated';
    const bridge = await scenario.open(); await expect(bridge.connector.scopedWakeWorkDriver().processWorkOnce()).rejects.toMatchObject({ code: 'CASE_SESSION_RESPONSE_INVALID' });
    expect(scenario.modelText).toHaveLength(0); expect(scenario.bootstrap).toHaveLength(0);
  });
  it.each(['agent_paused', 'credential_ended', 'lease_lost'])('denies %s at the tool boundary without privileged fallback', async reason => {
    const scenario = await setup();
    const ended = fixture('case-tools/reply-session-ended-in-write');
    ended.response!.body.reason = reason;
    scenario.addTool(ended);
    scenario.onPrompt(async () => { await scenario.mcp('tools/call', { name: 'envoi_case_reply', arguments: ended.request!.body!.params.arguments }); });
    const bridge = await scenario.open();
    await expect(bridge.connector.scopedWakeWorkDriver().processWorkOnce()).resolves.toBe(true);
    await bridge.close();
    expect(await scenario.journal()).toMatchObject({ completed: false });
    expect(scenario.effects.size).toBe(0);
    expect(() => bridge.connector.forwardMcpRequest('{"jsonrpc":"2.0","id":1,"method":"tools/list"}')).toThrow('Scoped runtimes cannot use privileged legacy MCP');
  });
  it('bounds a stalled turn and interrupts only its captured execution generation', async () => {
    const scenario = await setup(); scenario.setStatus('started');
    const bridge = await scenario.open({}, 300);
    const started = Date.now();
    await expect(bridge.connector.scopedWakeWorkDriver().processWorkOnce()).rejects.toBeDefined();
    await bridge.close();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(scenario.rpcRequests.filter(entry => entry.method === 'session.interrupt')).toHaveLength(1);
    expect(scenario.sockets.every(socket => socket.readyState === 3)).toBe(true);
  });
  it('accepts the official control/descriptor capability split without submitting a model turn', async () => {
    const scenario = await setup();
    await expect(hermesAdapter.preflight(scenario.config, { env: {} })).resolves.toBeUndefined();
    expect(scenario.bootstrap.map(entry => entry.verb)).toEqual(['identify', 'session-ticket']);
    expect(scenario.rpcRequests.map(entry => entry.method)).toEqual(['runtime.describe']);
    expect(scenario.modelText).toHaveLength(0);
    expect(scenario.sockets.every(socket => socket.readyState === 3)).toBe(true);
  });
  it('requires session authority on the authenticated control identity before requesting a ticket', async () => {
    const scenario = await setup(); scenario.controlCapabilities([]);
    scenario.capabilities(['session-authority-v1', 'acp-editor-policy-v1', 'acp-session-mcp-v1']);
    await expect(hermesAdapter.preflight(scenario.config, { env: {} })).rejects.toThrow();
    expect(scenario.bootstrap.map(entry => entry.verb)).toEqual(['identify']);
    expect(scenario.rpcRequests).toHaveLength(0); expect(scenario.modelText).toHaveLength(0);
  });
  it.each(['acp-editor-policy-v1', 'acp-session-mcp-v1'])('refuses missing %s on the scoped descriptor even if control advertises it', async missing => {
    const scenario = await setup();
    scenario.controlCapabilities(['session-authority-v1', 'acp-editor-policy-v1', 'acp-session-mcp-v1']);
    scenario.capabilities(['acp-editor-policy-v1', 'acp-session-mcp-v1'].filter(value => value !== missing));
    await expect(hermesAdapter.preflight(scenario.config, { env: {} })).rejects.toThrow();
    expect(scenario.modelText).toHaveLength(0); expect(scenario.rpcRequests.map(entry => entry.method)).toEqual(['runtime.describe']);
  });
  it('refuses unsupported runtime capabilities in read-only setup preflight', async () => {
    const scenario = await setup(); scenario.capabilities([]);
    await expect(hermesAdapter.preflight(scenario.config, { env: {} })).rejects.toThrow();
    expect(scenario.modelText).toHaveLength(0); expect(scenario.rpcRequests.map(entry => entry.method)).toEqual(['runtime.describe']);
  });
  it.each(['share-asset-not-clean', 'list-asset-ungranted', 'decide-accept-authority-denied'])('preserves canonical %s tool refusal without bypassing it', async name => {
    const scenario = await setup(); const denied = fixture('case-tools/' + name); scenario.addTool(denied);
    let result: Record<string, any> | undefined;
    scenario.onPrompt(async () => { result = await scenario.mcp('tools/call', denied.request!.body!.params); });
    const bridge = await scenario.open(); await bridge.connector.scopedWakeWorkDriver().processWorkOnce();
    expect(result?.result.isError).toBe(true);
    expect(scenario.effects.size).toBe(0);
    expect(scenario.toolRequests.map(entry => entry.params.name)).toEqual(['envoi_case_snapshot', denied.request!.body!.params.name]);
  });
  it.each(['expired', 'fence'])('rejects an invalid %s CaseSession before any provider work', async variant => {
    const scenario = await setup();
    if (variant === 'fence') scenario.minted.body.session.fence = 0;
    else {
      scenario.minted.body.session.createdAt = new Date(Date.now() - 901000).toISOString();
      scenario.minted.body.session.expiresAt = new Date(Date.now() - 1000).toISOString();
    }
    const bridge = await scenario.open();
    await expect(bridge.connector.scopedWakeWorkDriver().processWorkOnce()).rejects.toMatchObject({ code: 'CASE_SESSION_RESPONSE_INVALID' });
    expect(scenario.bootstrap).toHaveLength(0); expect(scenario.effects.size).toBe(0);
  });
  it('persists scoped manual selection, rejects downgrade and legacy options before state mutation', async () => {
    const scenario = await setup(); await scenario.open();
    const before = await readFile(path.join(scenario.directory, 'hermes-scoped.json'), 'utf8');
    const prepared = await prepareHermesRun({ ENVOI_API_URL: origin, ENVOI_STATE_DIR: scenario.directory });
    expect(prepared.scoped?.daemonOrigin).toBe(daemon);
    for (const env of [{ ENVOI_SCOPED_TOOLS: 'false' }, { HERMES_MCP_WRITE_ENABLED: 'true' }, { ENVOI_ASSET_MANIFEST_PATH: '/assets.json' }, { HERMES_DAEMON_URL: 'http://127.0.0.1:9999' }]) {
      await expect(prepareHermesRun({ ENVOI_API_URL: origin, ENVOI_STATE_DIR: scenario.directory, ...env })).rejects.toThrow();
    }
    expect(await readFile(path.join(scenario.directory, 'hermes-scoped.json'), 'utf8')).toBe(before);
    expect(await readFile(scenario.config.configPath, 'utf8')).toContain('existing-provider');
    expect(scenario.bootstrap).toHaveLength(0);
  });
});
