import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { acquireConnectorLock, privateJson } from '../connector/store';
import { FileScopedRunStore, type ScopedRunRecord } from '../grok/scoped-store';
import { hermesJournalMatches, hermesProfileIdentity, inspectHermesTerminalTurn } from './scoped-host';
import { nativeGatewayReselection, reselectHermesGateway } from './reselect';
import { hermesHost, readHermesSelection, saveHermesScopedMode, selectScopedHermes, type HermesRuntimeConfiguration } from './scoped-runtime';

const origin = 'https://envoi.example';
const previousOrigin = 'http://127.0.0.1:18973', nextOrigin = 'http://127.0.0.1:18974';
const roots: string[] = [];
const signal = () => new AbortController().signal;
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'envoi-hermes-reselect-')); roots.push(root);
  const home = path.join(root, 'profile'), directory = path.join(root, 'enrollment'), cwd = path.join(home, 'workspace');
  await mkdir(cwd, { recursive: true }); await mkdir(directory);
  const configPath = path.join(home, 'config.yaml');
  await writeFile(configPath, 'model:\n  default: existing-model\n  provider: existing-provider\n');
  await writeFile(path.join(home, '.env'), 'ANTHROPIC_API_KEY=PRIVATE_MODEL_FIXTURE\n');
  const config: HermesRuntimeConfiguration = { home, profile: 'existing', configPath, apiUrl: previousOrigin, apiKey: '',
    scopedTools: true, daemonOrigin: previousOrigin, scopedCwd: cwd };
  const agent = { id: 'agent_existing', address: 'existing@envoi.mail' };
  const installation = { id: 'installation_existing', agentId: agent.id, connectionRoute: 'local_helper', deliveryMode: 'envoi_link', legacy: false };
  const completionId = 'completion_existing';
  const session = { agentId: agent.id, address: agent.address, inboxId: 'inbox_existing', agentApiToken: 'PRIVATE_ACCESS_FIXTURE',
    agentRefreshToken: 'PRIVATE_REFRESH_FIXTURE', lifecycle: { state: 'STOPPED' },
    _onboarding: { completionId, origin, runtime: { type: 'hermes', version: 'unknown' }, agent, installation } };
  const connection = { version: 1, apiUrl: origin, runtime: 'hermes', address: agent.address, configuration: config,
    activationSetup: { completionId, agentId: agent.id, inboxId: session.inboxId, installationId: installation.id } };
  const helper = { version: 1, origin, runtime: { type: 'hermes', version: 'unknown' }, phase: 'completed', completionId };
  await privateJson(path.join(directory, 'session.json'), session);
  await privateJson(path.join(directory, 'connection.json'), connection);
  await privateJson(path.join(directory, 'helper-state.json'), helper);
  await saveHermesScopedMode(directory, config);
  const run: ScopedRunRecord = { version: 1, workId: 'msg_existing', model: `hermes-daemon:${previousOrigin}:${home}:${cwd}`,
    input: [{ kind: 'hermes-scoped-v1', requestId: 'request_original', inputId: 'input_original', text: 'Original fixture task',
      sessionId: 'native_session_original', admissionId: 'native_admission_original' }], pending: [], providerCalls: 1, completed: true };
  const runs = new FileScopedRunStore(directory); await runs.save(run);
  const confirmGateway = vi.fn(async () => true);
  const discoverGateway = vi.fn(async () => ({ home, cwd, origin: nextOrigin }));
  const options = { env: {}, secureDirectory: async (value: string) => value, confirmGateway, discoverGateway };
  const selectionFile = path.join(directory, 'hermes-scoped.json');
  const selection = () => readFile(selectionFile, 'utf8');
  const preservedFiles = [path.join(directory, 'session.json'), path.join(directory, 'connection.json'), path.join(directory, 'helper-state.json'),
    path.join(directory, 'scoped-runs', run.workId + '.json'), configPath, path.join(home, '.env')];
  const preserved = () => Promise.all(preservedFiles.map(file => readFile(file, 'utf8')));
  return { root, home, cwd, directory, config, connection, session, helper, run, runs, options, selection, selectionFile, preserved, confirmGateway, discoverGateway };
}

it('commits only the verified, owner-confirmed address and preserves enrollment, grants, journals and model files', async () => {
  const f = await fixture(), before = await f.preserved(), priorSelection = await f.selection();
  const next = await reselectHermesGateway(f.directory, origin, signal(), f.options);
  expect(next).toEqual({ ...f.config, apiUrl: nextOrigin, daemonOrigin: nextOrigin });
  expect(f.confirmGateway).toHaveBeenCalledExactlyOnceWith({ agentAddress: f.session.address, profile: f.home, workspace: f.cwd,
    previousOrigin, nextOrigin }, expect.any(AbortSignal));
  expect(f.discoverGateway).toHaveBeenCalledTimes(2);
  expect(await f.preserved()).toEqual(before);
  const backups = (await readdir(f.directory)).filter(name => name.startsWith('hermes-scoped-before-'));
  expect(backups).toHaveLength(1);
  expect(JSON.parse(await readFile(path.join(f.directory, backups[0]), 'utf8'))).toEqual(JSON.parse(priorSelection));
  expect(await selectScopedHermes({ stateDir: f.directory, env: {} }, f.config)).toEqual(next);
  await saveHermesScopedMode(f.directory, next!);
  expect((await readHermesSelection(f.directory))?.version).toBe(2);
  expect(await f.preserved()).toEqual(before);
  expect(await readdir(f.directory)).not.toContain('connector.lock');
});

it.each(['decline', 'noninteractive', 'cancel'])('makes no selection write on owner %s', async mode => {
  const f = await fixture(), before = await f.preserved(), selection = await f.selection(), controller = new AbortController();
  const options = { ...f.options, confirmGateway: mode === 'noninteractive' ? nativeGatewayReselection : vi.fn(async () => {
    if (mode === 'cancel') controller.abort(); return mode === 'cancel';
  }) };
  expect(await reselectHermesGateway(f.directory, origin, controller.signal, options)).toBeNull();
  expect(await f.selection()).toBe(selection); expect(await f.preserved()).toEqual(before);
  expect((await readdir(f.directory)).filter(name => name.startsWith('hermes-scoped-before-'))).toEqual([]);
});

it('does not prompt or rewrite an already current selection', async () => {
  const f = await fixture(), selection = await f.selection();
  f.discoverGateway.mockResolvedValue({ home: f.home, cwd: f.cwd, origin: previousOrigin });
  expect(await reselectHermesGateway(f.directory, origin, signal(), f.options)).toEqual(f.config);
  expect(f.confirmGateway).not.toHaveBeenCalled(); expect(await f.selection()).toBe(selection);
});

it.each(['completed', 'failed', 'interrupted', 'cancelled', 'rejected'])('preserves an unfinished journal with verified native %s proof during owner-confirmed reselection', async outcome => {
  const f = await fixture();
  await f.runs.save({ ...f.run, model: hermesProfileIdentity(hermesHost(f.config)), completed: false });
  const before = await f.preserved();
  const inspectTerminalTurn = vi.fn<typeof inspectHermesTerminalTurn>(async () => outcome);
  await expect(reselectHermesGateway(f.directory, origin, signal(), { ...f.options, inspectTerminalTurn })).resolves.toMatchObject({ daemonOrigin: nextOrigin });
  expect(inspectTerminalTurn).toHaveBeenCalledTimes(2);
  expect(inspectTerminalTurn.mock.calls[0]).toMatchObject([{ home: f.home, cwd: f.cwd, origin: nextOrigin }, { completed: false, workId: f.run.workId }, expect.any(AbortSignal)]);
  expect(f.confirmGateway).toHaveBeenCalledWith(expect.objectContaining({ retainedTerminalTurns: 1 }), expect.any(AbortSignal));
  expect(await f.preserved()).toEqual(before);
  expect(await f.runs.load(f.run.workId)).toMatchObject({ completed: false });
});

it.each(['unknown', 'unavailable', 'changed-outcome', 'changed-journal', 'decline'])('makes no selection commit for terminal recovery %s', async variant => {
  const f = await fixture();
  const run = { ...f.run, model: hermesProfileIdentity(hermesHost(f.config)), completed: false };
  await f.runs.save(run);
  const selection = await f.selection();
  const inspectTerminalTurn = vi.fn<typeof inspectHermesTerminalTurn>(async () => 'interrupted');
  if (variant === 'unknown') inspectTerminalTurn.mockResolvedValue('unknown');
  if (variant === 'unavailable') inspectTerminalTurn.mockRejectedValue(new Error('Unavailable native proof'));
  if (variant === 'changed-outcome') inspectTerminalTurn.mockResolvedValueOnce('interrupted').mockResolvedValue('completed');
  if (variant === 'changed-journal') f.confirmGateway.mockImplementation(async () => { await f.runs.save({ ...run, providerCalls: 2 }); return true; });
  if (variant === 'decline') f.confirmGateway.mockResolvedValue(false);
  const operation = reselectHermesGateway(f.directory, origin, signal(), { ...f.options, inspectTerminalTurn });
  if (variant === 'decline') await expect(operation).resolves.toBeNull();
  else await expect(operation).rejects.toThrow();
  expect(await f.selection()).toBe(selection);
  expect((await readdir(f.directory)).some(name => name.startsWith('hermes-scoped-before-'))).toBe(false);
});

it.each(['connector', 'helper'])('refuses an active %s owner before gateway discovery', async owner => {
  const f = await fixture(), selection = await f.selection();
  const unlock = owner === 'connector' ? await acquireConnectorLock(f.directory) : async () => {};
  if (owner === 'helper') await privateJson(path.join(f.directory, 'helper.lock'), { pid: 4, nonce: 'other_owner' });
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  try { await expect(reselectHermesGateway(f.directory, origin, signal(), f.options)).rejects.toThrow(/already running|helper setup/); }
  finally { kill.mockRestore(); await unlock(); }
  expect(f.discoverGateway).not.toHaveBeenCalled(); expect(f.confirmGateway).not.toHaveBeenCalled(); expect(await f.selection()).toBe(selection);
});

it.each(['pending', 'admission', 'foreign-profile', 'foreign-workspace', 'corrupt'])('preserves a %s journal and refuses port migration', async variant => {
  const f = await fixture(), selection = await f.selection();
  if (variant === 'pending') await f.runs.save({ ...f.run, completed: false });
  if (variant === 'admission') await f.runs.save({ ...f.run, admission: { version: 1, requestId: 'req_1', bindingDigest: 'a'.repeat(64),
    requestDigest: 'b'.repeat(64), fence: 1, history: ['req_1'], state: 'started' } });
  if (variant === 'foreign-profile') await f.runs.save({ ...f.run, model: hermesProfileIdentity({ origin: previousOrigin, home: f.root, cwd: f.cwd }) });
  if (variant === 'foreign-workspace') await f.runs.save({ ...f.run, model: hermesProfileIdentity({ origin: previousOrigin, home: f.home, cwd: f.root }) });
  if (variant === 'corrupt') await writeFile(path.join(f.directory, 'scoped-runs', f.run.workId + '.json'), '{broken');
  const preserved = await f.preserved();
  await expect(reselectHermesGateway(f.directory, origin, signal(), f.options)).rejects.toThrow();
  expect(f.confirmGateway).not.toHaveBeenCalled(); expect(await f.selection()).toBe(selection); expect(await f.preserved()).toEqual(preserved);
});

it.each(['origin', 'runtime', 'agent', 'installation', 'completion', 'revoked', 'needs-reconnect', 'configuration'])('refuses a changed %s binding before discovery', async variant => {
  const f = await fixture(), selection = await f.selection();
  if (variant === 'origin') f.connection.apiUrl = 'https://other.example';
  if (variant === 'runtime') f.connection.runtime = 'openclaw';
  if (variant === 'agent') f.session.agentId = 'agent_other';
  if (variant === 'installation') f.connection.activationSetup.installationId = 'installation_other';
  if (variant === 'completion') f.helper.completionId = '';
  if (variant === 'revoked') f.session.lifecycle.state = 'REVOKED';
  if (variant === 'needs-reconnect') f.session.lifecycle.state = 'NEEDS_RECONNECT';
  if (variant === 'configuration') f.connection.configuration = { ...f.config, profile: 'other' };
  await privateJson(path.join(f.directory, 'connection.json'), f.connection); await privateJson(path.join(f.directory, 'session.json'), f.session);
  await privateJson(path.join(f.directory, 'helper-state.json'), f.helper);
  const preserved = await f.preserved();
  await expect(reselectHermesGateway(f.directory, origin, signal(), f.options)).rejects.toMatchObject({ code: 'GATEWAY_RESELECTION_REFUSED' });
  expect(f.discoverGateway).not.toHaveBeenCalled(); expect(f.confirmGateway).not.toHaveBeenCalled(); expect(await f.selection()).toBe(selection);
  expect(await f.preserved()).toEqual(preserved);
});

it.each(['home', 'workspace', 'config', 'profile', 'unrelated-port', 'legacy-relay', 'downgrade'])('refuses an explicit conflicting %s selection', async variant => {
  const f = await fixture(), selection = await f.selection();
  const options = { ...f.options, env: {} as NodeJS.ProcessEnv, configPath: undefined as string | undefined, profile: undefined as string | undefined };
  if (variant === 'home') options.env.HERMES_HOME = f.root;
  if (variant === 'workspace') options.env.HERMES_SCOPED_CWD = f.root;
  if (variant === 'config') options.configPath = path.join(f.root, 'config.yaml');
  if (variant === 'profile') options.profile = 'other';
  if (variant === 'unrelated-port') options.env.HERMES_DAEMON_URL = 'http://127.0.0.1:19001';
  if (variant === 'legacy-relay') options.env.HERMES_MCP_WRITE_ENABLED = 'true';
  if (variant === 'downgrade') options.env.ENVOI_SCOPED_TOOLS = 'false';
  await expect(reselectHermesGateway(f.directory, origin, signal(), options)).rejects.toThrow();
  expect(f.confirmGateway).not.toHaveBeenCalled(); expect(await f.selection()).toBe(selection);
});

it.each(['foreign-home', 'foreign-workspace', 'nonloopback', 'changed-while-reviewing', 'binding-changed-while-reviewing'])('refuses %s gateway selection without a commit', async variant => {
  const f = await fixture(), selection = await f.selection();
  if (variant === 'foreign-home') f.discoverGateway.mockResolvedValue({ origin: nextOrigin, home: f.root, cwd: f.cwd });
  if (variant === 'foreign-workspace') f.discoverGateway.mockResolvedValue({ origin: nextOrigin, home: f.home, cwd: f.root });
  if (variant === 'nonloopback') f.discoverGateway.mockResolvedValue({ origin: 'https://other.example:443', home: f.home, cwd: f.cwd });
  if (variant === 'changed-while-reviewing') f.discoverGateway.mockResolvedValueOnce({ origin: nextOrigin, home: f.home, cwd: f.cwd })
    .mockResolvedValue({ origin: 'http://127.0.0.1:19001', home: f.home, cwd: f.cwd });
  if (variant === 'binding-changed-while-reviewing') f.confirmGateway.mockImplementation(async () => {
    await privateJson(path.join(f.directory, 'session.json'), { ...f.session, address: 'other@envoi.mail' }); return true;
  });
  await expect(reselectHermesGateway(f.directory, origin, signal(), f.options)).rejects.toThrow();
  expect(await f.selection()).toBe(selection);
});

it.each(['before_selection_commit', 'after_selection_commit'])('recovers a crash at %s through a single atomic marker', async stage => {
  const f = await fixture(), before = await f.preserved();
  await expect(reselectHermesGateway(f.directory, origin, signal(), { ...f.options, selectionFault: async checkpoint => {
    if (checkpoint === stage) throw new Error('injected local write interruption');
  } })).rejects.toThrow('injected local write interruption');
  const expected = stage === 'before_selection_commit' ? f.config : { ...f.config, apiUrl: nextOrigin, daemonOrigin: nextOrigin };
  expect(await selectScopedHermes({ stateDir: f.directory, env: {} }, f.config)).toEqual(expected);
  expect(await f.preserved()).toEqual(before);
  expect(await readdir(f.directory)).not.toContain('connector.lock');
  expect(await reselectHermesGateway(f.directory, origin, signal(), f.options)).toEqual({ ...f.config, apiUrl: nextOrigin, daemonOrigin: nextOrigin });
  expect(await f.preserved()).toEqual(before);
});

it.each(['home', 'workspace', 'profile', 'configPath', 'apiKey', 'extra-field'])('refuses a v2 marker that changes %s as well as the port', async variant => {
  const f = await fixture();
  const next = { ...f.config, apiUrl: nextOrigin, daemonOrigin: nextOrigin } as Record<string, unknown>;
  if (variant === 'home') next.home = f.root;
  if (variant === 'workspace') next.scopedCwd = f.root;
  if (variant === 'profile') next.profile = 'other';
  if (variant === 'configPath') next.configPath = path.join(f.root, 'config.yaml');
  if (variant === 'apiKey') next.apiKey = 'forbidden';
  if (variant === 'extra-field') next.assetManifestPath = '/unrelated';
  await privateJson(f.selectionFile, { version: 2, configuration: next, previousConfiguration: f.config });
  await expect(selectScopedHermes({ stateDir: f.directory, env: {} }, f.config)).rejects.toMatchObject({ code: 'SCOPED_CONFIG_INVALID' });
});

it('refuses an unrelated cached connection after a committed selection and retains explicit port-conflict checks', async () => {
  const f = await fixture();
  await reselectHermesGateway(f.directory, origin, signal(), f.options);
  await expect(selectScopedHermes({ stateDir: f.directory, env: {} }, { ...f.config, daemonOrigin: 'http://127.0.0.1:19002', apiUrl: 'http://127.0.0.1:19002' }))
    .rejects.toMatchObject({ code: 'SCOPED_CONFIG_INVALID' });
  await expect(selectScopedHermes({ stateDir: f.directory, env: { HERMES_DAEMON_URL: previousOrigin } }, f.config))
    .rejects.toMatchObject({ code: 'SCOPED_CONFIG_INVALID' });
});

it('keeps stable new journal identity across ports and completed legacy checkpoints without admitting unfinished legacy work', async () => {
  const f = await fixture(), oldHost = hermesHost(f.config), newHost = { ...oldHost, origin: nextOrigin };
  expect(hermesProfileIdentity(oldHost)).toBe(hermesProfileIdentity(newHost));
  expect(hermesJournalMatches(f.run, newHost)).toBe(true);
  expect(hermesJournalMatches({ ...f.run, completed: false }, newHost)).toBe(false);
  expect(hermesJournalMatches({ ...f.run, model: 'hermes-daemon:https://untrusted.example:' + f.home + ':' + f.cwd }, newHost)).toBe(false);
  expect(hermesJournalMatches({ ...f.run, model: hermesProfileIdentity({ ...newHost, cwd: f.root }) }, newHost)).toBe(false);
});
