import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorSession } from '../../sdk/typescript/src/connector';
import { FileBridgeStore } from '../agent-bridges/file-store';
import { FileScopedRunStore } from '../grok/scoped-store';
import { createOpenClawBridge } from './runtime';
import { contractRegistry, loadContractFixture } from '../contract-fixtures/setup';

interface Fixture {
  request?: { path?: string; body?: Record<string, any> };
  response?: { status: number; body: Record<string, any> };
  steps?: Fixture[];
}

const origin = 'https://envoi.example';
const gateway = 'https://gateway.example';
const accessToken = 'PRIVATE_HOST_ACCESS_FIXTURE';
const refreshToken = 'PRIVATE_HOST_REFRESH_FIXTURE';
const gatewayToken = 'PRIVATE_GATEWAY_FIXTURE';
const directories: string[] = [];
const closers: Array<() => Promise<void>> = [];

async function fixture(name: string): Promise<Fixture> {
  const [contractId, filename] = name.split('/');
  const contract = contractRegistry.contracts.find(candidate => candidate.id === contractId);
  if (!contract) throw new Error('Missing canonical contract: ' + contractId);
  const source = JSON.stringify(loadContractFixture(contract, filename + '.json'));
  const offset = Date.now() - Date.parse('2026-10-17T12:00:06.000Z');
  return JSON.parse(source, (_key, value: unknown) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    ? new Date(Date.parse(value) + offset).toISOString() : value) as Fixture;
}

function response(value: NonNullable<Fixture['response']>): Response {
  return Response.json(structuredClone(value.body), { status: value.status });
}

function textOutput(text = 'Done') {
  return { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] };
}

function callOutput(name: string, args: Record<string, unknown>, callId = 'call_fixture') {
  return { type: 'function_call', name, arguments: JSON.stringify(args), call_id: callId };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(done => { resolve = done; });
  return { promise, resolve };
}

async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), 'envoi-openclaw-scoped-'));
  directories.push(directory);
  const status = (await fixture('case-session/agent-status-case-sessions')).response!;
  const flow = await fixture('http-wake/wake-then-claim-and-mint');
  const claim = flow.steps!.find(step => step.request?.path === '/api/agent/work/claim')!.response!;
  const minted = (await fixture('case-session/session-created')).response!;
  const ended = (await fixture('case-session/session-end')).response!;
  const snapshot = (await fixture('case-tools/snapshot-agent-work')).response!;
  const replyFixture = await fixture('case-tools/reply-agent-work');
  const work = claim.body.work;
  work.leaseExpiresAt = new Date(Date.now() + 120000).toISOString();
  minted.body.lease.leaseExpiresAt = work.leaseExpiresAt;
  minted.body.session.createdAt = new Date().toISOString();
  minted.body.session.expiresAt = new Date(Date.parse(minted.body.session.createdAt) + 900000).toISOString();
  const sessionToken = minted.body.session.token as string;
  const store = new FileBridgeStore(directory);
  await store.init();
  const session: ConnectorSession = {
    agentId: 'agent_example', inboxId: 'inbox_example', address: 'example@envoi.mail', cursor: null,
    agentApiToken: accessToken, agentRefreshToken: refreshToken,
    agentTokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    agentRefreshTokenExpiresAt: new Date(Date.now() + 86400000).toISOString()
  };
  await store.save(session);
  const requests: Array<{ url: string; body: Record<string, any>; authorization: string | null }> = [];
  const modelRequests: Record<string, any>[] = [];
  const toolRequests: Record<string, any>[] = [];
  const extraTools = new Map<string, Fixture>();
  const effects = new Set<string>();
  let claimable = true;
  let gatewayResponse: (body: Record<string, any>, signal: AbortSignal) => Promise<Response> = async () =>
    Response.json({ status: 'completed', output: [textOutput()] });
  let mintResponse = minted;
  let snapshotResponse = snapshot;
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, any> : {};
    const authorization = new Headers(init?.headers).get('authorization');
    requests.push({ url: url.href, body, authorization });
    if (url.origin === gateway) {
      expect(url.pathname).toBe('/v1/responses');
      expect(authorization).toBe('Bearer ' + gatewayToken);
      expect(init?.redirect).toBe('error');
      modelRequests.push(body);
      return gatewayResponse(body, init!.signal!);
    }
    expect(url.origin).toBe(origin);
    if (url.pathname === '/mcp') {
      expect(authorization).toBe('Bearer ' + sessionToken);
      expect(body.method).toBe('tools/call');
      toolRequests.push(body);
      const tool = body.params.name;
      if (tool === 'envoi_case_snapshot') return Response.json({ ...structuredClone(snapshotResponse.body), id: body.id }, { status: snapshotResponse.status });
      const extra = extraTools.get(tool);
      if (extra) {
        expect(body.params.arguments).toEqual(extra.request!.body!.params.arguments);
        return Response.json({ ...structuredClone(extra.response!.body), id: body.id }, { status: extra.response!.status });
      }
      expect(tool).toBe('envoi_case_reply');
      expect(body.params.arguments).toEqual(replyFixture.request!.body!.params.arguments);
      const replayed = effects.has(body.params.arguments.idempotencyKey);
      effects.add(body.params.arguments.idempotencyKey);
      const payload = structuredClone(replyFixture.response!.body);
      payload.id = body.id;
      const envelope = JSON.parse(payload.result.content[0].text);
      envelope.result.replayed = replayed;
      payload.result.content[0].text = JSON.stringify(envelope);
      return Response.json(payload);
    }
    expect(authorization).toBe('Bearer ' + accessToken);
    if (url.pathname === '/api/agent/status') return response(status);
    if (url.pathname === '/api/agent/work/claim') {
      if (!claimable) return Response.json({ work: null, state: 'idle' });
      claimable = false;
      return response(claim);
    }
    const prefix = '/api/agent/work/' + work.workId;
    expect(url.pathname.startsWith(prefix + '/')).toBe(true);
    if (url.pathname === prefix + '/session') return response(mintResponse);
    if (url.pathname === prefix + '/session/end') return response(ended);
    if (url.pathname === prefix + '/renew') return Response.json({ workId: work.workId, leaseToken: work.leaseToken, leaseExpiresAt: work.leaseExpiresAt });
    const operation = url.pathname.slice(prefix.length + 1);
    expect(['acknowledge', 'complete', 'fail']).toContain(operation);
    expect(body.leaseToken).toBe(work.leaseToken);
    const state = operation === 'acknowledge' ? 'acknowledged' : operation === 'complete' ? 'processed' : 'failed';
    return Response.json({ workId: work.workId, status: state, receipt: { messageId: work.workId, state } });
  });
  const config = { apiUrl: origin, stateDir: directory, gatewayUrl: gateway, gatewayToken, agentId: 'main' };
  const open = async (beforeScopedTurn?:import('../hermes/native-binding').ScopedPreparationGuard) => {
    const bridge = await createOpenClawBridge(config, { env: { ENVOI_SCOPED_TOOLS: 'true' }, fetch: fetcher,beforeScopedTurn });
    closers.push(bridge.close);
    return bridge;
  };
  return {
    directory, config, store, status, work, minted, sessionToken, requests, modelRequests, toolRequests, effects, fetcher, open,
    replyArgs: replyFixture.request!.body!.params.arguments as Record<string, unknown>,
    model: (handler: typeof gatewayResponse) => { gatewayResponse = handler; },
    denyMint: (value: typeof minted) => { mintResponse = value; },
    denySnapshot: (value: typeof snapshot) => { snapshotResponse = value; },
    addTool: (value: Fixture) => { extraTools.set(value.request!.body!.params.name, value); },
    reclaim: () => { claimable = true; minted.body.session.fence++; },
    journal: () => new FileScopedRunStore(directory).load(work.workId)
  };
}

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('production OpenClaw scoped bridge composition', () => {
  it('holds canonical control work before any real gateway request or native journal',async()=>{
    const s=await setup();let reached=false;
    const bridge=await s.open(async workId=>{expect(workId).toBe(s.work.workId);expect(s.toolRequests.map(r=>r.params.name)).toEqual(['envoi_case_snapshot']);
      expect(await s.journal()).toBeNull();reached=true;throw Error('INERT_OC_PRE_NATIVE_CONTROL');});
    await expect(bridge.connector.scopedWakeWorkDriver().processWorkOnce()).rejects.toThrow('INERT_OC_PRE_NATIVE_CONTROL');
    expect(reached).toBe(true);expect(s.modelRequests).toHaveLength(0);expect(await s.journal()).toBeNull();
  });
  it('executes one canonical typed reply and reopens completed work without another model call or effect', async () => {
    const scenario = await setup();
    scenario.model(async () => Response.json({ status: 'completed', output: [scenario.modelRequests.length === 1
      ? callOutput('envoi_case_reply', scenario.replyArgs) : textOutput()] }));
    const bridge = await scenario.open();
    expect(scenario.fetcher).not.toHaveBeenCalled();
    await expect(bridge.connector.scopedWakeWorkDriver().processWorkOnce()).resolves.toBe(true);
    expect(scenario.toolRequests.map(request => request.params.name)).toEqual(['envoi_case_snapshot', 'envoi_case_reply']);
    expect(scenario.effects.size).toBe(1);
    expect(scenario.modelRequests).toHaveLength(2);
    expect(scenario.modelRequests[1].input).toContainEqual(expect.objectContaining({ type: 'function_call_output', call_id: 'call_fixture' }));
    expect(await scenario.journal()).toMatchObject({ completed: true, pending: [], providerCalls: 2 });
    const privateValues = [accessToken, refreshToken, scenario.sessionToken, scenario.work.leaseToken,
      scenario.work.workId, scenario.work.message.caseId, 'installation_example', 'case_session_example', 'agent_example', 'inbox_example'];
    const modelWire = JSON.stringify(scenario.modelRequests);
    for (const value of privateValues) expect(modelWire).not.toContain(value);
    for (const request of scenario.modelRequests) {
      expect(request).toMatchObject({ model: 'openclaw/main', store: false, stream: false });
      expect(request.tools.map((tool: { name: string }) => tool.name)).toEqual(scenario.minted.body.session.allowedTools);
    }
    const saved = await readFile(path.join(scenario.directory, 'scoped-runs', scenario.work.workId + '.json'), 'utf8');
    for (const value of [accessToken, refreshToken, gatewayToken, scenario.sessionToken, scenario.work.leaseToken]) expect(saved).not.toContain(value);
    expect(await new FileBridgeStore(scenario.directory).load()).toMatchObject({ agentId: 'agent_example', agentRefreshToken: refreshToken });
    scenario.reclaim();
    const recovered = await scenario.open();
    await expect(recovered.connector.scopedWakeWorkDriver().processWorkOnce()).resolves.toBe(true);
    expect(scenario.modelRequests).toHaveLength(2);
    expect(scenario.effects.size).toBe(1);
    expect(scenario.toolRequests.filter(request => request.params.name === 'envoi_case_reply')).toHaveLength(1);
    expect(scenario.requests.filter(request => request.url.endsWith('/complete'))).toHaveLength(2);
  });

  it('does not turn plain model text into a privileged REST send', async () => {
    const scenario = await setup();
    scenario.model(async () => Response.json({ status: 'completed', output: [textOutput('Send this directly to the counterparty')] }));
    await (await scenario.open()).connector.scopedWakeWorkDriver().processWorkOnce();
    expect(scenario.effects.size).toBe(0);
    expect(scenario.toolRequests.map(request => request.params.name)).toEqual(['envoi_case_snapshot']);
    expect(scenario.requests.filter(request => new URL(request.url).pathname.includes('/send'))).toEqual([]);
    expect(await scenario.journal()).toMatchObject({ completed: true, providerCalls: 1 });
  });

  it('refuses a missing server feature before claim or Gateway access', async () => {
    const scenario = await setup();
    scenario.status.body.caseSessions = { available: false, version: 1 };
    await expect((await scenario.open()).connector.scopedWakeWorkDriver().processWorkOnce()).resolves.toBe(false);
    expect(scenario.modelRequests).toEqual([]);
    expect(scenario.requests.map(request => new URL(request.url).pathname)).toEqual(['/api/agent/status']);
  });

  it('preserves canonical mint denial without model execution or legacy fallback', async () => {
    const scenario = await setup();
    scenario.denyMint((await fixture('case-session/mint-case-controlled')).response!);
    await expect((await scenario.open()).connector.scopedWakeWorkDriver().processWorkOnce()).resolves.toBe(true);
    expect(scenario.modelRequests).toEqual([]);
    expect(scenario.toolRequests).toEqual([]);
    expect(scenario.effects.size).toBe(0);
    expect(scenario.requests.some(request => request.url.endsWith('/complete'))).toBe(false);
  });

  it('does not call the Gateway when the initial scoped snapshot is denied', async () => {
    const scenario = await setup();
    scenario.denySnapshot((await fixture('case-session/session-ended-case-paused')).response!);
    await expect((await scenario.open()).connector.scopedWakeWorkDriver().processWorkOnce()).resolves.toBe(true);
    expect(scenario.modelRequests).toEqual([]);
    expect(scenario.effects.size).toBe(0);
    expect(scenario.requests.some(request => request.url.endsWith('/complete'))).toBe(false);
  });

  it('rejects a legacy Envoi tool returned by Gateway without executing or settling success', async () => {
    const scenario = await setup();
    scenario.model(async () => Response.json({ status: 'completed', output: [callOutput('envoi_send_message', { text: 'Do not send' })] }));
    await expect((await scenario.open()).connector.scopedWakeWorkDriver().processWorkOnce()).rejects.toMatchObject({ code: 'SCOPED_PROVIDER_RESPONSE_INVALID' });
    expect(scenario.effects.size).toBe(0);
    expect(scenario.toolRequests.map(request => request.params.name)).toEqual(['envoi_case_snapshot']);
    expect(scenario.requests.some(request => request.url.endsWith('/complete'))).toBe(false);
  });

  it('durably ends for human input without another model invocation or later reply', async () => {
    const scenario = await setup();
    const authority = await fixture('case-tools/authority-check-needs-human');
    const human = await fixture('case-tools/request-human');
    scenario.denySnapshot((await fixture('case-tools/snapshot-awaiting-decision')).response!);
    scenario.addTool(authority);
    scenario.addTool(human);
    scenario.model(async () => {
      const target = scenario.modelRequests.length === 1 ? authority : human;
      return Response.json({ status: 'completed', output: [callOutput(target.request!.body!.params.name,
        target.request!.body!.params.arguments, 'call_' + scenario.modelRequests.length)] });
    });
    await expect((await scenario.open()).connector.scopedWakeWorkDriver().processWorkOnce()).resolves.toBe(true);
    expect(scenario.modelRequests).toHaveLength(2);
    expect(scenario.toolRequests.map(request => request.params.name)).toEqual(['envoi_case_snapshot', 'envoi_authority_check', 'envoi_request_human']);
    expect(scenario.effects.size).toBe(0);
    expect(await scenario.journal()).toMatchObject({ completed: true, pending: [], providerCalls: 2 });
    scenario.reclaim();
    await expect((await scenario.open()).connector.scopedWakeWorkDriver().processWorkOnce()).resolves.toBe(true);
    expect(scenario.modelRequests).toHaveLength(2);
    expect(scenario.toolRequests.filter(request => request.params.name === 'envoi_request_human')).toHaveLength(1);
  });

  it('cancels the original Gateway request and ignores its late typed reply', async () => {
    const scenario = await setup();
    const entered = deferred<AbortSignal>();
    const finish = deferred<Response>();
    scenario.model(async (_body, signal) => { entered.resolve(signal); return finish.promise; });
    const controller = new AbortController();
    const bridge = await scenario.open();
    const pending = bridge.connector.scopedWakeWorkDriver().processWorkOnce(controller.signal);
    const rejected = expect(pending).rejects.toBeDefined();
    const signal = await entered.promise;
    controller.abort();
    await rejected;
    expect(signal.aborted).toBe(true);
    finish.resolve(Response.json({ status: 'completed', output: [callOutput('envoi_case_reply', scenario.replyArgs)] }));
    await Promise.resolve();
    await new Promise(resolve => setImmediate(resolve));
    expect(scenario.effects.size).toBe(0);
    expect(scenario.requests.some(request => request.url.endsWith('/complete'))).toBe(false);
    expect((await scenario.journal())?.pending).toEqual([]);
  });

  it.each(['OPENCLAW_MCP_RELAY_TOKEN', 'OPENCLAW_MCP_RELAY_PORT', 'OPENCLAW_MCP_WRITE_ENABLED', 'ENVOI_MCP_URL', 'ENVOI_ASSET_MANIFEST_PATH'])(
    'rejects %s before initializing private state or making a request', async setting => {
      const directory = await mkdtemp(path.join(tmpdir(), 'envoi-openclaw-refused-'));
      directories.push(directory);
      const fetcher = vi.fn<typeof fetch>(async () => { throw new Error('Network forbidden'); });
      await expect(createOpenClawBridge({ apiUrl: origin, stateDir: directory, gatewayUrl: gateway, gatewayToken, agentId: 'main' },
        { env: { ENVOI_SCOPED_TOOLS: 'true', [setting]: '' }, fetch: fetcher })).rejects.toMatchObject({ code: 'SCOPED_LEGACY_CONFIGURATION_UNAVAILABLE' });
      expect(fetcher).not.toHaveBeenCalled();
      expect(await readdir(directory)).toEqual([]);
    }
  );
});

describe('durable OpenClaw scoped runtime mode', () => {
  it('persists scoped mode and reopens with an empty environment without exposing installation access', async () => {
    const scenario = await setup();
    const initial = await scenario.open();
    const marker = path.join(scenario.directory, 'openclaw-mode.json');
    expect(JSON.parse(await readFile(marker, 'utf8'))).toEqual({ version: 1, scopedTools: true });
    await initial.close();
    const recovered = await createOpenClawBridge(scenario.config, { env: {}, fetch: scenario.fetcher });
    closers.push(recovered.close);
    await expect(recovered.connector.currentAccessToken()).rejects.toMatchObject({ code: 'LEGACY_MODEL_ACCESS_DISABLED' });
    expect(scenario.fetcher).not.toHaveBeenCalled();
    await expect(recovered.connector.scopedWakeWorkDriver().processWorkOnce()).resolves.toBe(true);
    expect(scenario.modelRequests).toHaveLength(1);
    expect(scenario.effects.size).toBe(0);
    expect(JSON.parse(await readFile(marker, 'utf8'))).toEqual({ version: 1, scopedTools: true });
  });

  it('refuses an explicit downgrade before store initialization or model access', async () => {
    const scenario = await setup();
    await scenario.open();
    const before = (await readdir(scenario.directory)).sort();
    const saved = await readFile(path.join(scenario.directory, 'session.json'), 'utf8');
    const initialize = vi.spyOn(FileBridgeStore.prototype, 'init');
    await expect(createOpenClawBridge(scenario.config, { env: { ENVOI_SCOPED_TOOLS: 'false' }, fetch: scenario.fetcher }))
      .rejects.toMatchObject({ code: 'SCOPED_MODE_DOWNGRADE_UNAVAILABLE' });
    expect(initialize).not.toHaveBeenCalled();
    expect(scenario.fetcher).not.toHaveBeenCalled();
    expect((await readdir(scenario.directory)).sort()).toEqual(before);
    expect(await readFile(path.join(scenario.directory, 'session.json'), 'utf8')).toBe(saved);
  });

  it.each(['OPENCLAW_MCP_RELAY_TOKEN', 'OPENCLAW_MCP_RELAY_PORT', 'OPENCLAW_MCP_WRITE_ENABLED', 'ENVOI_MCP_URL', 'ENVOI_ASSET_MANIFEST_PATH'])(
    'refuses saved scoped mode plus %s without a legacy relay or initialization', async setting => {
      const scenario = await setup();
      await scenario.open();
      const before = (await readdir(scenario.directory)).sort();
      const initialize = vi.spyOn(FileBridgeStore.prototype, 'init');
      await expect(createOpenClawBridge(scenario.config, { env: { [setting]: '' }, fetch: scenario.fetcher }))
        .rejects.toMatchObject({ code: 'SCOPED_LEGACY_CONFIGURATION_UNAVAILABLE' });
      expect(initialize).not.toHaveBeenCalled();
      expect(scenario.fetcher).not.toHaveBeenCalled();
      expect((await readdir(scenario.directory)).sort()).toEqual(before);
    }
  );

  it.each(['{', 'null', '{"version":1,"scopedTools":false}', '{"version":1,"scopedTools":true,"extra":true}', ' '.repeat(1025)])(
    'refuses corrupt saved marker %# instead of falling back to legacy mode', async content => {
      const scenario = await setup();
      await scenario.open();
      const marker = path.join(scenario.directory, 'openclaw-mode.json');
      await writeFile(marker, content);
      const initialize = vi.spyOn(FileBridgeStore.prototype, 'init');
      await expect(createOpenClawBridge(scenario.config, { env: {}, fetch: scenario.fetcher })).rejects.toThrow(/saved OpenClaw mode/);
      expect(initialize).not.toHaveBeenCalled();
      expect(scenario.fetcher).not.toHaveBeenCalled();
      expect(await readFile(marker, 'utf8')).toBe(content);
    }
  );

  it('refuses a symlink marker instead of following it or selecting legacy mode', async () => {
    const scenario = await setup();
    await scenario.open();
    const marker = path.join(scenario.directory, 'openclaw-mode.json');
    const targetDirectory = path.join(scenario.directory, 'marker-target');
    await mkdir(targetDirectory);
    const target = path.join(targetDirectory, 'mode.json');
    const content = '{"version":1,"scopedTools":true}';
    await writeFile(target, content);
    await rm(marker);
    try { await symlink(target, marker, 'file'); }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await symlink(targetDirectory, marker, 'junction');
    }
    const initialize = vi.spyOn(FileBridgeStore.prototype, 'init');
    await expect(createOpenClawBridge(scenario.config, { env: {}, fetch: scenario.fetcher })).rejects.toThrow(/saved OpenClaw mode/);
    expect(initialize).not.toHaveBeenCalled();
    expect(scenario.fetcher).not.toHaveBeenCalled();
    expect(await readFile(target, 'utf8')).toBe(content);
  });
});
