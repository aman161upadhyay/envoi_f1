import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { privateJson } from '../../connector/store';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FileBridgeStore } from '../../agent-bridges/file-store';
vi.mock('../../connector/core', async importOriginal => ({ ...await importOriginal<typeof import('../../connector/core')>(),
  readConnection: vi.fn(async () => ({ apiUrl: 'https://www.envoi-agents.com', runtime: 'hermes', address: 'example@envoi.mail', activationSetup: { completionId: 'completion_fixture', installationId: 'installation_example' } }))
}));
import { readConnection } from '../../connector/core';
import { contractRegistry, loadContractFixture } from '../../contract-fixtures/setup';
import { runLocalLink, selectLocalRuntime } from '../cli';
const origin = 'https://www.envoi-agents.com';
const resolver = () => ({ discover: vi.fn(async () => ({})), preflight: vi.fn(async () => undefined) }) as any;
const directories: string[] = [];
beforeEach(() => vi.mocked(readConnection).mockResolvedValue({ apiUrl: origin, runtime: 'hermes', address: 'example@envoi.mail', activationSetup: { completionId: 'completion_fixture', installationId: 'installation_example' } } as any));
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
function session() {
  return { address: 'example@envoi.mail', _onboarding: { completionId: 'completion_fixture', installation: { id: 'installation_example' } } } as any;
}
it('keeps polling a private pending setup, then starts the foreground connector after confirmed authenticated completion', async () => {
  vi.spyOn(FileBridgeStore.prototype, 'load').mockResolvedValue(session());
  const helper = vi.fn().mockResolvedValueOnce({ schemaVersion: '1', state: 'pending_approval', claimUrl: origin + '/claim', verificationCode: 'F7KQ-PM4D' })
    .mockResolvedValueOnce({ schemaVersion: '1', state: 'connected' });
  const start = vi.fn(async () => undefined), write = vi.fn(), wait = vi.fn(async () => undefined);
  const result = await runLocalLink(['connect', origin, '--runtime', 'hermes'], new AbortController().signal, { resolveAdapter: resolver, helperCli: helper, start, write, wait });
  expect(result.state).toBe('connected'); expect(wait).toHaveBeenCalledTimes(1);
  expect(helper.mock.calls[1][0]).toEqual(['resume', origin, '--runtime', 'hermes']);
  expect(write).toHaveBeenCalledTimes(2); expect(start).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(write.mock.calls)).not.toMatch(/agentApiToken|private.*directory|completion_fixture/);
});
it('restarts an already completed saved connection even when adoption was not invoked again', async () => {
  vi.spyOn(FileBridgeStore.prototype, 'load').mockResolvedValue(session());
  const start = vi.fn(async () => undefined), adopt = vi.fn();
  await runLocalLink(['resume', origin, '--runtime', 'hermes'], new AbortController().signal, { resolveAdapter: resolver, helperCli: vi.fn().mockResolvedValue({ state: 'paused' }), start, adopt });
  expect(adopt).not.toHaveBeenCalled(); expect(start).toHaveBeenCalledTimes(1);
});
it('does not start on status/doctor or when no explicit local confirmation was supplied', async () => {
  const start = vi.fn(async () => undefined);
  for (const command of ['status', 'doctor', 'resume']) {
    await runLocalLink([command, origin, '--runtime', 'hermes'], new AbortController().signal, { resolveAdapter: resolver, helperCli: vi.fn().mockResolvedValue({ state: command === 'resume' ? 'confirm_approval' : 'connected' }), start });
  }
  expect(start).not.toHaveBeenCalled();
});
it('refuses token-bearing/unknown arguments before discovering or contacting any runtime', async () => {
  const discover = vi.fn();
  await expect(runLocalLink(['connect', origin, '--token', 'private-never-output'], new AbortController().signal, { resolveAdapter: discover })).rejects.toThrow();
  expect(discover).not.toHaveBeenCalled();
});

it.each(['hermes', 'openclaw'])('passes explicitly selected permissions to the existing %s registration engine', async runtime => {
  const permissions = ['send_agent_messages', 'receive_agent_messages', 'execute_cases', 'create_assets'];
  const helper = vi.fn().mockResolvedValue({ state: 'confirm_approval' });
  const start = vi.fn();
  await runLocalLink(['connect', origin, '--runtime', runtime, '--permissions', permissions.join(','), '--show-code'],
    new AbortController().signal, { resolveAdapter: resolver, helperCli: helper, start });
  expect(helper.mock.calls[0][0]).toEqual(['connect', origin, '--runtime', runtime, '--show-code']);
  expect(helper.mock.calls[0][1].requestedPermissions).toEqual(permissions);
  expect(start).not.toHaveBeenCalled();
});

it('leaves the existing default permission request with the helper when no selection is supplied', async () => {
  const helper = vi.fn().mockResolvedValue({ state: 'confirm_approval' });
  await runLocalLink(['connect', origin, '--runtime', 'hermes'], new AbortController().signal,
    { resolveAdapter: resolver, helperCli: helper });
  expect(helper.mock.calls[0][1].requestedPermissions).toBeUndefined();
});

it.each([
  ['connect', ''], ['connect', 'send_agent_messages'], ['connect', 'receive_agent_messages,'],
  ['connect', 'receive_agent_messages,receive_agent_messages'], ['connect', 'receive_agent_messages,__proto__'],
  ['connect', 'receive_agent_messages,envoi_agent_access_DO_NOT_PRINT'],
  ['resume', 'receive_agent_messages'], ['status', 'receive_agent_messages'], ['task', 'receive_agent_messages']
])('refuses invalid or misplaced permission selection before discovery (%s)', async (command, value) => {
  const discover = vi.fn();
  await expect(runLocalLink([command, origin, '--permissions', value], new AbortController().signal,
    { resolveAdapter: discover })).rejects.toThrow(/supported permission list|documented local helper options/);
  expect(discover).not.toHaveBeenCalled();
});

it('refuses a repeated permission option before discovery', async () => {
  const discover = vi.fn();
  await expect(runLocalLink(['connect', origin, '--permissions', 'receive_agent_messages', '--permissions', 'receive_agent_messages'],
    new AbortController().signal, { resolveAdapter: discover })).rejects.toThrow('documented local helper options');
  expect(discover).not.toHaveBeenCalled();
});
it('does not start stale runtime configuration after a mismatched installation completion', async () => {
  vi.spyOn(FileBridgeStore.prototype, 'load').mockResolvedValue({ ...session(), _onboarding: { completionId: 'other', installation: { id: 'installation_example' } } });
  const start = vi.fn();
  await expect(runLocalLink(['resume', origin, '--runtime', 'hermes'], new AbortController().signal, { resolveAdapter: resolver, helperCli: vi.fn().mockResolvedValue({ state: 'connected' }), start })).rejects.toThrow('does not match');
  expect(start).not.toHaveBeenCalled();
});
it('requires explicit choice if both trusted runtimes are ready', async () => {
  await expect(selectLocalRuntime(undefined, resolver)).rejects.toThrow('Choose one runtime');
});
it('keeps the helper bundle and metadata exclusively in its private local package', () => {
  const config = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
  expect(config).toContain("outDir: 'integrations/onboarding/dist'");
  expect(config).not.toContain("outDir: 'web/");
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  expect(pkg.private).toBe(true); expect(pkg.bin['envoi-link']).toBe('./dist/envoi-link.mjs');
});

it('runs the actual private helper engine through canonical registration, confirmation, activation and foreground adoption', async () => {
  const registered = contractRegistry.contracts.find(item => item.id === 'agent-registration')!;
  const fromFixture = (name: string) => loadContractFixture(registered, name + '.json') as any;
  const responses = ['routes-available', 'registration-created', 'registration-approved', 'activation-created'].map(fromFixture);
  const status = fromFixture('agent-status-installation').response.body;
  const records = new Map<string, any>();
  const memory = { directory: 'private-runtime-test', lock: (fn: () => any) => fn(), read: async (name: string) => structuredClone(records.get(name) ?? null),
    write: async (name: string, value: any) => { records.set(name, structuredClone(value)); } };
  vi.spyOn(FileBridgeStore.prototype, 'load').mockImplementation(async () => records.get('session.json'));
  vi.mocked(readConnection).mockResolvedValue({ version: 1, apiUrl: origin, runtime: 'hermes', address: status.agent.address, configuration: {},
    agentName: 'Example agent', activationSetup: { completionId: 'activation_7f3c9a1e', installationId: status.installation.id } });
  let now = Date.parse('2026-10-12T12:00:00.000Z');
  const paths: string[] = [], start = vi.fn(async () => undefined), adopt = vi.fn<typeof import('../../connector/core').adoptActivatedConnection>(async () => ({} as any)), write = vi.fn();
  const stop = new AbortController();
  const result = await runLocalLink(['connect', origin, '--runtime', 'hermes'], stop.signal, {
    resolveAdapter: resolver, start, adopt, write, wait: async ms => { now += ms; },
    helperDependencies: { store: memory, now: () => now, randomId: () => 'activation_7f3c9a1e',
      confirm: async (details: any) => { expect(details.approverEmailHint).toBe('o***@example.com'); return true; },
      operationalStatus: async () => status,
      request: async (method: string, requestPath: string, options: any = {}) => {
        const next = responses.shift(); paths.push(requestPath); expect(next).toBeDefined();
        expect(method).toBe(next.request.method); expect(requestPath).toBe(next.request.path);
        if (method === 'POST' && requestPath.endsWith('/activate')) expect(options.body).toEqual(next.request.body);
        return structuredClone(next.response.body);
      }
    }
  });
  expect(result.state).toBe('connected'); expect(adopt).toHaveBeenCalledTimes(1); expect(start).toHaveBeenCalledTimes(1);
  expect(adopt.mock.calls[0][4].signal).toBe(stop.signal);
  expect(paths).not.toContain('/api/agent-enroll'); expect(responses).toHaveLength(0);
  expect(records.get('helper-state.json').bootstrapToken).toBeUndefined();
  expect(JSON.stringify(write.mock.calls)).not.toMatch(/envoi_(reg|agent_access|agent_refresh)_|activation_7f3c9a1e|installation_example|inbox_example/);
});

it.each(['throw', 'normal exit'])('projects foreground installation revoke on %s without raw diagnostics', async mode => {
  const lifecycle = { state: 'REVOKED', code: 'CREDENTIAL_REVOKED', reason: 'revoked', guidance: 'owner_reenroll' };
  vi.spyOn(FileBridgeStore.prototype, 'load').mockResolvedValueOnce(session()).mockResolvedValue({ ...session(), lifecycle } as any);
  const start = vi.fn(async () => { if (mode === 'throw') throw Object.assign(new Error('PRIVATE envoi_agent_access_DO_NOT_PRINT'), { code: lifecycle.code, reason: lifecycle.reason, status: 401 }); });
  const write = vi.fn();
  const result = await runLocalLink(['resume', origin, '--runtime', 'hermes'], new AbortController().signal,
    { resolveAdapter: resolver, helperCli: vi.fn().mockResolvedValue({ schemaVersion: '1', state: 'connected' }), start, write });
  expect(result).toMatchObject({ state: 'revoked', guidance: 'owner_reconnect' });
  expect(write.mock.calls.at(-1)?.[0]).toEqual(result); expect(start).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(write.mock.calls)).not.toMatch(/PRIVATE|DO_NOT_PRINT|envoi_agent_|completion_fixture|installation_example|owner_reenroll/);
});

it.each(['NETWORK_ERROR', 'TIMEOUT'])('projects a coded %s from foreground startup as a resumable transport outage', async code => {
  vi.spyOn(FileBridgeStore.prototype, 'load').mockResolvedValue(session());
  const start = vi.fn(async () => { throw Object.assign(new Error('PRIVATE TLS cause'), { code }); });
  const write = vi.fn();
  const result = await runLocalLink(['resume', origin, '--runtime', 'hermes'], new AbortController().signal,
    { resolveAdapter: resolver, helperCli: vi.fn().mockResolvedValue({ state: 'connected' }), start, write });
  expect(result).toMatchObject({ state: 'degraded', guidance: 'service_unavailable' });
  expect(write.mock.calls.at(-1)?.[0]).toEqual(result);
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE|TLS/);
});

it('keeps an unknown foreground setup failure fail-closed', async () => {
  vi.spyOn(FileBridgeStore.prototype, 'load').mockResolvedValue(session());
  await expect(runLocalLink(['resume', origin, '--runtime', 'hermes'], new AbortController().signal,
    { resolveAdapter: resolver, helperCli: vi.fn().mockResolvedValue({ state: 'connected' }),
      start: async () => { throw new Error('unknown configuration failure'); } })).rejects.toThrow('unknown configuration failure');
});

it.each(['status', 'resume'])('%s maps a real authenticated-status TLS rejection to degraded and reuses the saved enrollment', async command => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-12T12:05:00Z'));
  const registration = contractRegistry.contracts.find(item => item.id === 'agent-registration')!;
  const fromFixture = (name: string) => (loadContractFixture(registration, name + '.json') as any).response.body;
  const activation = fromFixture('activation-created'), status = fromFixture('agent-status-installation');
  const directory = await mkdtemp(path.join(tmpdir(), 'envoi-helper-tls-')); directories.push(directory);
  const store = new FileBridgeStore(directory); await store.init();
  const saved = { ...activation, agentId: activation.agent.id, address: activation.agent.address, cursor: null,
    _onboarding: { completionId: 'completion_fixture', origin, runtime: { type: 'hermes', version: 'unknown' },
      agent: activation.agent, installation: activation.installation } };
  await privateJson(path.join(directory, 'session.json'), saved);
  const journal = { version: 1, origin, runtime: { type: 'hermes', version: 'unknown' }, phase: 'completed', completionId: 'completion_fixture' };
  await privateJson(path.join(directory, 'helper-state.json'), journal);
  const tls = Object.assign(new TypeError('fetch failed: PRIVATE diagnostic'), {
    cause: Object.assign(new Error('PRIVATE certificate path envoi_agent_access_DO_NOT_PRINT'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' })
  });
  let offline = true;
  const fetcher = vi.fn(async () => { if (offline) throw tls; return Response.json(status); });
  const start = vi.fn(async () => undefined), write = vi.fn();
  const options = { stateDir: directory, resolveAdapter: resolver, fetch: fetcher as typeof fetch, start, write };
  const result = await runLocalLink([command, origin, '--runtime', 'hermes'], new AbortController().signal, options);
  expect(result).toMatchObject({ state: 'degraded', guidance: 'service_unavailable' });
  expect(JSON.stringify(write.mock.calls)).not.toMatch(/PRIVATE|certificate|DO_NOT_PRINT|envoi_agent_|completion_fixture|installation_example/);
  expect(start).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(path.join(directory, 'helper-state.json'), 'utf8'))).toEqual(journal);
  expect(await store.load()).toMatchObject({ agentApiToken: saved.agentApiToken, agentRefreshToken: saved.agentRefreshToken, lifecycle: { state: 'DEGRADED' } });
  offline = false;
  const recovered = await runLocalLink([command, origin, '--runtime', 'hermes'], new AbortController().signal, options);
  expect(recovered.state).toBe('connected');
  expect(start).toHaveBeenCalledTimes(command === 'resume' ? 1 : 0);
  expect(fetcher.mock.calls.every(call => String((call as unknown[])[0]) === origin + '/api/agent/status')).toBe(true);
  expect((await store.load())?.agentApiToken).toBe(saved.agentApiToken);
});
