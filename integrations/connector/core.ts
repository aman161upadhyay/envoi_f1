import { copyFile, lstat, readFile, rm, rename, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { lifecyclePolicy } from '../../sdk/typescript/src/lifecycle';
import { EnvoiError, responsePayload } from '../../sdk/typescript/src/index';
import { enrollConnector, EnvoiConnector, type ConnectorSession } from '../../sdk/typescript/src/connector';
import { CONNECTOR_RUNTIMES, quickConnectOrigin, validateQuickConnectHandoff, type ConnectorRuntime } from '../../sdk/typescript/src/quick-connect';
import { FileBridgeStore } from '../agent-bridges/file-store';
import { ConnectorSetupError, type AdapterOptions, type ConnectorAdapter, type RuntimeBridge } from './adapter';
import { privateDirectory, privateJson, acquireConnectorLock } from './store';
import { checkServiceManager, inspectConnectorService } from './service';
import { startControl, queryControl, controlIdentityMatches } from './control';
import { enrollmentSetupError, readEnrollmentDiagnostic } from './enrollment-error';
import { migrateConnectionDirectory } from './migrate';
import { waitForRuntimeTools } from './runtime-readiness';
import { parseHostedWakeConfig, runHostedWake } from './hosted-wake-runner';
import { resolveHostedWakeConfig } from './hosted-wake-config';
import { createHostTaskSender, HostTaskError } from './host-task';
import { readRuntimeDiagnostic, writeRuntimeDiagnostic, type RuntimeDiagnostic, type RuntimePhase } from './runtime-diagnostics';
import { inspectHermesHost, type HermesHostObservation } from '../hermes/scoped-host';

export interface InstalledConnection {
  version: 1;
  runtime: ConnectorRuntime;
  apiUrl: string;
  address: string;
  agentName: string;
  configuration: unknown;
  lastReconnectId?: string;
  activationSetup?: { completionId: string; installationId: string; agentId?: string; inboxId?: string };
}
export interface SetupOptions extends AdapterOptions {
  stateDir?: string;
  executableFile?: string;
  secureDirectory?: typeof privateDirectory;
  installService?: boolean;
  onProgress?: (phase: string) => void;
  /** Hermes Gateway reconciliation and parked-server recovery, bounded across all attempts. */
  toolRecoveryTimeoutMs?: number;
  toolRecoveryRetryMs?: number;
}
export type AdapterResolver = (runtime: ConnectorRuntime) => ConnectorAdapter<any>;

export function connectionDirectory(apiUrl: string, address: string, runtime: ConnectorRuntime, options: AdapterOptions = {}) {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const platform = options.platform ?? process.platform;
  const id = createHash('sha256').update(`${quickConnectOrigin(apiUrl)}\n${address.toLowerCase()}`).digest('hex').slice(0, 24);
  const base = platform === 'win32' ? (env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'))
    : platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
      : env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(home, '.local', 'state');
  return path.join(base, 'envoi', runtime, id);
}
export function startCommand(stateDir: string, platform = process.platform) {
  const args = [process.execPath, path.join(stateDir, 'connector.mjs'), 'start', '--state-dir', stateDir];
  return platform === 'win32' ? `& ${args.map(value => `'${value.replaceAll("'", "''")}'`).join(' ')}`
    : args.map(value => `'${value.replaceAll("'", "'\"'\"'")}'`).join(' ');
}
export const noRedirectFetch = (fetcher: typeof fetch = fetch): typeof fetch => (input, init) => fetcher(input, { ...init, redirect: 'error' });

async function saveExecutable(directory: string, source?: string) {
  if (!source || path.resolve(source) === path.join(directory, 'connector.mjs')) return;
  const temporary = path.join(directory, `.connector-${randomUUID()}.tmp`);
  try {
    await copyFile(source, temporary);
    if (process.platform !== 'win32') await chmod(temporary, 0o600);
    await rename(temporary, path.join(directory, 'connector.mjs'));
  } finally { await rm(temporary, { force: true }); }
}

async function savedSession(directory: string): Promise<ConnectorSession | null> {
  const filename = path.join(directory, 'session.json');
  const stat = await lstat(filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128_000) throw new ConnectorSetupError('STATE_INVALID', 'Saved credentials must be a regular private file');
  let value: ConnectorSession | null;
  try { value = await new FileBridgeStore(directory).load(); }
  catch { throw new ConnectorSetupError('STATE_INVALID', 'Saved credentials are invalid; preserve the connection directory for recovery'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ['agentId', 'inboxId', 'address', 'agentApiToken', 'agentRefreshToken'].some(key => typeof value![key as keyof ConnectorSession] !== 'string' || !value![key as keyof ConnectorSession])
    || !Number.isFinite(Date.parse(value.agentTokenExpiresAt)) || !Number.isFinite(Date.parse(value.agentRefreshTokenExpiresAt))) {
    throw new ConnectorSetupError('STATE_INVALID', 'Saved credentials are invalid; preserve the connection directory for recovery');
  }
  return value;
}

export async function readConnection(directory: string): Promise<InstalledConnection> {
  const filename = path.join(directory, 'connection.json');
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128_000) throw new ConnectorSetupError('STATE_INVALID', 'Choose a regular private saved connection');
  let saved: InstalledConnection & { openclaw?: unknown };
  try { saved = JSON.parse(await readFile(filename, 'utf8')); }
  catch { throw new ConnectorSetupError('STATE_INVALID', 'The saved connection is invalid; preserve it and inspect the private state directory'); }
  // OpenClaw v1 installations upgrade without another enrollment.
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new ConnectorSetupError('STATE_INVALID', 'The saved connection is invalid');
  if (saved.runtime === 'openclaw' && !saved.configuration && saved.openclaw) saved.configuration = saved.openclaw;
  if (saved.version !== 1 || !CONNECTOR_RUNTIMES.includes(saved.runtime) || !saved.configuration || typeof saved.configuration !== 'object' || Array.isArray(saved.configuration)
      || typeof saved.address !== 'string' || typeof saved.agentName !== 'string') throw new ConnectorSetupError('STATE_INVALID', 'The saved connection is invalid');
  saved.apiUrl = quickConnectOrigin(saved.apiUrl);
  return saved;
}

/** Refresh only the installed launcher for a stopped, already enrolled profile. */
export async function refreshInstalledExecutable(directory: string, source: string) {
  const unlock = await acquireConnectorLock(directory);
  try {
    const saved = await readConnection(directory);
    const session = await savedSession(directory);
    if (!session || session.address !== saved.address
      || (saved.activationSetup?.agentId && session.agentId !== saved.activationSetup.agentId)
      || (saved.activationSetup?.inboxId && session.inboxId !== saved.activationSetup.inboxId))
      throw new ConnectorSetupError('STATE_MISMATCH', 'The saved connector identity does not match this installation; preserve the profile and inspect it before updating');
    const sourceStat = await lstat(source);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink())
      throw new ConnectorSetupError('STATE_INVALID', 'Choose a regular candidate connector bundle');
    const installed = path.join(directory, 'connector.mjs');
    const oldStat = await lstat(installed).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (oldStat && (!oldStat.isFile() || oldStat.isSymbolicLink()))
      throw new ConnectorSetupError('STATE_INVALID', 'The installed connector is not a regular file; preserve the profile and inspect it before updating');
    const candidateHash = createHash('sha256').update(await readFile(source)).digest('hex');
    const currentHash = oldStat ? createHash('sha256').update(await readFile(installed)).digest('hex') : null;
    if (currentHash === candidateHash) return { candidateHash, previousHash: currentHash, changed: false };
    if (oldStat) {
      const backup = path.join(directory, 'connector.previous.mjs');
      const temporaryBackup = path.join(directory, `.connector-backup-${randomUUID()}.tmp`);
      try {
        await copyFile(installed, temporaryBackup);
        if (process.platform !== 'win32') await chmod(temporaryBackup, 0o600);
        await rename(temporaryBackup, backup);
      } finally { await rm(temporaryBackup, { force: true }); }
    }
    await saveExecutable(directory, source);
    return { candidateHash, previousHash: currentHash, changed: true };
  } finally { await unlock(); }
}
export async function checkEnvoi(apiUrl: string, fetcher: typeof fetch) {
  let response: Response;
  try { response = await fetcher(`${quickConnectOrigin(apiUrl)}/health`, { signal: AbortSignal.timeout(10_000) }); }
  catch { throw new ConnectorSetupError('ENVOI_UNREACHABLE', 'Envoi is unreachable from this host. A remote agent cannot reach another computer’s localhost URL; use the correct public HTTPS deployment'); }
  try {
    if (!response.ok || (await response.json() as { service?: string }).service !== 'envoi') throw new Error();
  } catch { throw new ConnectorSetupError('ENVOI_UNREACHABLE', 'The selected URL did not return Envoi health. Check the deployment origin before enrolling'); }
}
async function report(saved: InstalledConnection, connector: EnvoiConnector, phase: 'ready' | 'error', _fetcher: typeof fetch, errorCode?: string) {
  await connector.reportConnectionStatus({ version: 1, runtime: saved.runtime, phase,
    runtimeTest: phase === 'ready' ? 'passed' : 'failed', ...(errorCode ? { errorCode } : {}) });
}

export async function prepareConnection(runtime: ConnectorRuntime, apiUrl: string, resolveAdapter: AdapterResolver, options: AdapterOptions = {}) {
  const fetcher = noRedirectFetch(options.fetch);
  await checkEnvoi(apiUrl, fetcher);
  const adapter = resolveAdapter(runtime);
  const config = await adapter.discover({ ...options, fetch: fetcher });
  await adapter.preflight(config, { ...options, apiUrl, fetch: fetcher });
  return { runtime, checks: 'passed', ...adapter.describe(config), note: 'Preparation did not enroll an agent or prove unattended receiving' };
}

export async function setupConnection(input: unknown, resolveAdapter: AdapterResolver, options: SetupOptions = {}) {
  const handoff = validateQuickConnectHandoff(input, { allowExpired: true });
  const directory = await (options.secureDirectory ?? privateDirectory)(await migrateConnectionDirectory(options.stateDir ?? connectionDirectory(handoff.apiUrl, handoff.address, handoff.runtime, options), options.secureDirectory));
  const unlock = await acquireConnectorLock(directory);
  const fetcher = noRedirectFetch(options.fetch);
  let bridge: RuntimeBridge | undefined;
  let saved: InstalledConnection | undefined;
  let enrolledConnector: EnvoiConnector | undefined;
  try {
    const store = new FileBridgeStore(directory); await store.init();
    let session = await savedSession(directory);
    const prior = await readConnection(directory).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (prior && (prior.apiUrl !== handoff.apiUrl || prior.address !== handoff.address || prior.runtime !== handoff.runtime)
      || session && session.address !== handoff.address) throw new ConnectorSetupError('STATE_MISMATCH', 'This directory belongs to another connection. Use a separate agent-specific directory');
    if (session && !prior) throw new ConnectorSetupError('STATE_INVALID', 'Saved credentials have no connection configuration; preserve this directory and inspect it');
    // Record only a nonreversible digest to distinguish a retry from a new reconnect request.
    const reconnectId = handoff.operation === 'reconnect' ? createHash('sha256').update(handoff.enrollmentToken).digest('hex') : undefined;
    const sessionRedemptionId = (session as (ConnectorSession & { setupRedemptionId?: string }) | null)?.setupRedemptionId;
    const needsEnrollment = !session || !!reconnectId && sessionRedemptionId !== reconnectId && prior?.lastReconnectId !== reconnectId;
    if (needsEnrollment) validateQuickConnectHandoff(input);
    if (options.installService) await checkServiceManager();
    options.onProgress?.('Checking Envoi reachability');
    await checkEnvoi(handoff.apiUrl, fetcher);
    const adapter = resolveAdapter(handoff.runtime);
    const context = { ...options, apiUrl: handoff.apiUrl, stateDir: directory, fetch: fetcher };
    options.onProgress?.(`Preparing ${handoff.runtime}`);
    const config = await adapter.discover(context, prior?.configuration);
    await adapter.preflight(config, context);
    saved = { version: 1, runtime: handoff.runtime, apiUrl: handoff.apiUrl, address: handoff.address,
      agentName: handoff.agentName, configuration: config, ...(prior?.lastReconnectId ? { lastReconnectId: prior.lastReconnectId } : {}) };
    await privateJson(path.join(directory, 'connection.json'), saved);
    await saveExecutable(directory, options.executableFile);
    if (needsEnrollment) {
      options.onProgress?.(handoff.operation === 'reconnect' ? 'Reconnecting the existing agent' : 'Enrolling the agent');
      // Save the retry marker in the SAME atomic write as the new credentials. A crash
      // before connection.json is updated must not redeem a consumed token again.
      const enrollmentStore = { load: () => store.load(), save: (value: ConnectorSession) => store.save({ ...value, ...(reconnectId ? { setupRedemptionId: reconnectId } : {}) }) };
      try { session = await enrollConnector(handoff.apiUrl, handoff.enrollmentToken, enrollmentStore, { name: handoff.agentName, runtime: handoff.runtime, fetch: fetcher }); }
      catch (error) { throw await enrollmentSetupError(error, directory); }
      if (reconnectId) { saved.lastReconnectId = reconnectId; await privateJson(path.join(directory, 'connection.json'), saved); }
    }
    if (!session || session.address !== handoff.address) throw new ConnectorSetupError('STATE_MISMATCH', 'The enrolled address differs from this handoff. Inspect Agent connections before starting');
    await rm(path.join(directory, 'enrollment-error.json'), { force: true });
    enrolledConnector = new EnvoiConnector(saved.apiUrl, store, { fetch: fetcher });
    await adapter.configure?.(config, context);
    // Adapters may allocate a local relay port during configure. Save it before service start.
    await privateJson(path.join(directory, 'connection.json'), saved);
    options.onProgress?.('Verifying runtime tools and Envoi access');
    bridge = await adapter.createBridge(config, context);
    await bridge.connector.start();
    await bridge.connector.checkStatus();
    const paused = (await bridge.connector.lifecycle()).paused;
    if (!paused) { await bridge.verify?.(); await report(saved, bridge.connector, 'ready', fetcher); }
    const checks = paused ? 'deferred_while_paused' as const : 'passed' as const;
    await privateJson(path.join(directory, 'setup-check.json'), { runtime: saved.runtime, checkedAt: new Date().toISOString(), checks });
    return { stateDir: directory, runtime: saved.runtime, address: session.address, agentId: session.agentId, checks };
  } catch (error) {
    if (saved && (bridge || enrolledConnector)) await report(saved, bridge?.connector ?? enrolledConnector!, 'error', fetcher,
      error instanceof ConnectorSetupError ? error.code : 'CONNECTION_TEST_FAILED').catch(() => {});
    throw error;
  } finally { try { await bridge?.close(); } finally { await unlock(); } }
}

/** Private activation handoff. Never accepts a bootstrap token or calls legacy enrollment. */
export interface ActivatedConnection {
  installation: { id: string; agentId: string; connectionRoute: string; deliveryMode: string;
    runtime: { type: string; version: string | null }; status: string; legacy: boolean };
  agent: { id: string; name: string; address: string; status: string };
  inboxId: string;
  effectivePermissions: string[];
  agentApiToken: string;
  agentRefreshToken: string;
  agentTokenExpiresAt: string;
  agentRefreshTokenExpiresAt: string;
  tokenType: 'Bearer';
}

export interface ActivatedSetupOptions extends SetupOptions { completionId: string }

export async function adoptActivatedConnection(apiUrl: string, runtime: ConnectorRuntime, activation: ActivatedConnection,
  resolveAdapter: AdapterResolver, options: ActivatedSetupOptions) {
  const origin = quickConnectOrigin(apiUrl);
  const validText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
  if (!['hermes', 'openclaw'].includes(runtime) || !activation || !validText(options.completionId)
    || !activation.installation || activation.installation.runtime?.type !== runtime
    || activation.installation.connectionRoute !== 'local_helper' || activation.installation.deliveryMode !== 'envoi_link'
    || activation.installation.status !== 'active' || activation.installation.legacy !== false
    || !validText(activation.installation.id) || !activation.agent || activation.installation.agentId !== activation.agent.id
    || !['active', 'paused'].includes(activation.agent.status)
    || !['id', 'name', 'address'].every(key => validText(activation.agent[key as keyof ActivatedConnection['agent']]))
    || !validText(activation.inboxId) || !validText(activation.agentApiToken) || !validText(activation.agentRefreshToken)
    || !Number.isFinite(Date.parse(activation.agentTokenExpiresAt)) || !Number.isFinite(Date.parse(activation.agentRefreshTokenExpiresAt))
    || activation.tokenType !== 'Bearer' || !Array.isArray(activation.effectivePermissions)
    || activation.effectivePermissions.some(permission => !validText(permission))) {
    throw new ConnectorSetupError('ACTIVATION_INVALID', 'The private activation handoff is invalid; preserve saved state for recovery');
  }
  const directory = await (options.secureDirectory ?? privateDirectory)(options.stateDir ?? connectionDirectory(origin, activation.agent.address, runtime, options));
  const unlock = await acquireConnectorLock(directory);
  let bridge: RuntimeBridge | undefined;
  try {
    const store = new FileBridgeStore(directory); await store.init();
    const session = await savedSession(directory) as (ConnectorSession & {
      _onboarding?: { completionId: string; origin: string; runtime: { type: string }; installation: { id: string };
        previousCompletionId?: string; previousInstallationId?: string; previousAgentId?: string; previousInboxId?: string; previousAddress?: string }
    }) | null;
    const prior = await readConnection(directory).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    const previous = session?._onboarding;
    const replacingPrior = !!prior?.activationSetup && !!previous
      && previous.previousCompletionId === prior.activationSetup.completionId
      && previous.previousInstallationId === prior.activationSetup.installationId
      && previous.previousCompletionId !== options.completionId && previous.previousInstallationId !== activation.installation.id
      && previous.previousAgentId === activation.agent.id && previous.previousInboxId === activation.inboxId
      && previous.previousAddress === activation.agent.address && previous.previousAddress === prior.address
      && (!prior.activationSetup.agentId || prior.activationSetup.agentId === activation.agent.id)
      && (!prior.activationSetup.inboxId || prior.activationSetup.inboxId === activation.inboxId);
    if (prior && (prior.apiUrl !== origin || prior.runtime !== runtime || prior.address !== activation.agent.address
        || !replacingPrior && (prior.activationSetup?.installationId !== activation.installation.id || prior.activationSetup?.completionId !== options.completionId))
      || session && (session.agentId !== activation.agent.id || session.inboxId !== activation.inboxId || session.address !== activation.agent.address
        || session._onboarding?.completionId !== options.completionId || session._onboarding?.installation?.id !== activation.installation.id
        || session._onboarding?.origin !== origin || session._onboarding?.runtime?.type !== runtime)) {
      throw new ConnectorSetupError('STATE_MISMATCH', 'This directory belongs to another installation; preserve it and use its original private handoff');
    }
    if (prior && !session) throw new ConnectorSetupError('STATE_INVALID', 'Saved configuration has lost its credentials; preserve this directory for recovery');
    if (!session) {
      // The completion identity and operational credentials become durable together.
      // Retries preserve later rotations, pendingRotation, cursors and terminal state.
      await privateJson(path.join(directory, 'session.json'), {
        agentId: activation.agent.id, inboxId: activation.inboxId, address: activation.agent.address, cursor: null,
        agentApiToken: activation.agentApiToken, agentRefreshToken: activation.agentRefreshToken,
        agentTokenExpiresAt: activation.agentTokenExpiresAt, agentRefreshTokenExpiresAt: activation.agentRefreshTokenExpiresAt,
        tokenType: activation.tokenType,
        ...(activation.agent.status === 'paused' ? { lifecycle: { state: 'PAUSED', paused: true, failures: 0, changedAt: new Date().toISOString() } } : {}),
        _onboarding: { completionId: options.completionId, origin, runtime: activation.installation.runtime, agent: activation.agent, installation: activation.installation,
          effectivePermissions: activation.effectivePermissions }
      });
    }
    const fetcher = noRedirectFetch(options.fetch);
    const startup = new EnvoiConnector(origin, store, { fetch: fetcher });
    // A saved revocation/reconnect requirement stops before any service or runtime call.
    await startup.start();
    await startup.checkStatus();
    if (options.installService) await checkServiceManager();
    const adapter = resolveAdapter(runtime);
    const context = { ...options, apiUrl: origin, stateDir: directory, fetch: fetcher };
    options.onProgress?.(`Preparing ${runtime}`);
    const configuration = await adapter.discover(context, prior?.configuration);
    await adapter.preflight(configuration, context);
    const saved: InstalledConnection = { version: 1, runtime, apiUrl: origin, address: activation.agent.address,
      agentName: activation.agent.name, configuration,
      activationSetup: { completionId: options.completionId, installationId: activation.installation.id,
        agentId: activation.agent.id, inboxId: activation.inboxId } };
    // A crash during adapter configuration resumes using this same installation.
    await privateJson(path.join(directory, 'connection.json'), saved);
    await saveExecutable(directory, options.executableFile);
    await adapter.configure?.(configuration, context);
    await privateJson(path.join(directory, 'connection.json'), saved);
    bridge = await adapter.createBridge(configuration, context);
    await bridge.connector.start();
    await bridge.connector.checkStatus();
    let paused = (await bridge.connector.lifecycle()).paused;
    if (!paused) {
      if (runtime === 'hermes') await waitForRuntimeTools(bridge, options.signal ?? new AbortController().signal, {
        timeoutMs: options.toolRecoveryTimeoutMs, retryMs: options.toolRecoveryRetryMs,
        onWaiting() { options.onProgress?.('Waiting for Hermes Gateway MCP reconciliation; keep this connector running.'); }
      });
      else await bridge.verify?.();
      // The owner may pause while recovery waits. Never report ready in that case.
      paused = (await bridge.connector.lifecycle()).paused;
      if (!paused) await report(saved, bridge.connector, 'ready', fetcher);
    }
    const checks = paused ? 'deferred_while_paused' as const : 'passed' as const;
    await privateJson(path.join(directory, 'setup-check.json'), { runtime, checkedAt: new Date().toISOString(), checks });
    return { stateDir: directory, runtime, address: activation.agent.address, agentId: activation.agent.id, checks };
  } finally { try { await bridge?.close(); } finally { await unlock(); } }
}

export interface OperationalStatusContext {
  origin: string;
  runtime: { type: string; version?: string | null };
  stateDirectory: string;
  completionId: string;
}
export interface OperationalAgentStatus extends Record<string, unknown> {
  state: 'active' | 'paused';
  agent: { id: string; address?: string; status?: string };
  inboxId: string;
  installation: { id: string; connectionRoute: string; deliveryMode: string; legacy: boolean };
}

/** Private authenticated status: never starts a runtime or competes with its refresh. */
export async function operationalConnectionStatus(context: OperationalStatusContext,
  options: { fetch?: typeof fetch; queryControl?: typeof queryControl } = {}): Promise<OperationalAgentStatus> {
  const origin = quickConnectOrigin(context.origin);
  const directory = path.resolve(context.stateDirectory);
  const store = new FileBridgeStore(directory);
  type MarkedSession = ConnectorSession & { _onboarding?: { completionId: string; origin: string; runtime: { type: string };
    agent: { id: string; address: string }; installation: { id: string; agentId: string; connectionRoute: string; deliveryMode: string; legacy: boolean } } };
  const sessionForStatus = async () => {
    const session = await savedSession(directory) as MarkedSession | null;
    const marker = session?._onboarding;
    if (!session || !marker || marker.completionId !== context.completionId || marker.origin !== origin
      || marker.runtime?.type !== context.runtime.type || !['hermes', 'openclaw'].includes(context.runtime.type)
      || marker.agent?.id !== session.agentId || marker.agent?.address !== session.address
      || marker.installation?.agentId !== session.agentId || typeof marker.installation?.id !== 'string' || !marker.installation.id) {
      throw new ConnectorSetupError('STATE_MISMATCH', 'Saved credentials do not match this private installation');
    }
    return session;
  };
  const validateStatus = (value: unknown, session: MarkedSession): OperationalAgentStatus => {
    const status = value as OperationalAgentStatus | null;
    const installation = session._onboarding!.installation;
    if (!status || !['active', 'paused'].includes(status.state) || status.agent?.id !== session.agentId
      || status.inboxId !== session.inboxId || status.agent.address !== session.address
      || status.installation?.id !== installation.id || status.installation.connectionRoute !== installation.connectionRoute
      || status.installation.deliveryMode !== installation.deliveryMode || status.installation.legacy !== installation.legacy) {
      throw new ConnectorSetupError('STATE_MISMATCH', 'Envoi status does not match this private installation');
    }
    return status;
  };
  await sessionForStatus();
  const fetcher = noRedirectFetch(options.fetch);
  const guard = new EnvoiConnector(origin, store, { fetch: fetcher, timeoutMs: 10_000 });
  // Terminal state is checked even before querying the local control listener.
  await guard.assertActive();
  let live: Record<string, unknown> | null = null;
  try { live = await (options.queryControl ?? queryControl)(directory, 'status'); }
  catch (error) { if (error instanceof ConnectorSetupError && error.code === 'CONTROL_INVALID') throw error; }
  if (live) {
    const request = async (session: MarkedSession) => {
      await guard.assertActive();
      let response: Response;
      try { response = await fetcher(`${origin}/api/agent/status`, { credentials: 'omit', redirect: 'error',
        headers: { authorization: `Bearer ${session.agentApiToken}` }, signal: AbortSignal.timeout(10_000) }); }
      catch { throw new EnvoiError('Envoi status could not be reached', undefined, 'NETWORK_ERROR'); }
      return validateStatus(await responsePayload<unknown>(response, 'Envoi status failed'), session);
    };
    const session = await sessionForStatus();
    try { return await request(session); }
    catch (error) {
      if (!(error instanceof EnvoiError) || error.code !== 'ACCESS_TOKEN_EXPIRED') throw error;
      const replacement = await sessionForStatus();
      if (replacement.agentApiToken === session.agentApiToken) throw error;
      // Only the foreground owner can rotate. Read its successor once, without writes.
      return await request(replacement);
    }
  }
  const unlock = await acquireConnectorLock(directory);
  try {
    await sessionForStatus();
    let actualStatus: unknown;
    const connector = new EnvoiConnector(origin, store, { timeoutMs: 10_000, fetch: async (input, init) => {
      const response = await fetcher(input, init);
      if (String(input) === `${origin}/api/agent/status` && response.ok) actualStatus = await response.clone().json();
      return response;
    } });
    await connector.start();
    await connector.checkStatus();
    return validateStatus(actualStatus, await sessionForStatus());
  } finally { await unlock(); }
}

export async function startConnection(stateDir: string, signal: AbortSignal, resolveAdapter: AdapterResolver,
  options: AdapterOptions & { secureDirectory?: typeof privateDirectory; pollIntervalMs?: number; onReady?: () => void; onWaiting?: (code: string) => void; retryDelayMs?: number; toolRecoveryTimeoutMs?: number; toolRecoveryRetryMs?: number; control?: boolean } = {}) {
  parseHostedWakeConfig(options.env ?? process.env);
  const directory = await (options.secureDirectory ?? privateDirectory)(await migrateConnectionDirectory(stateDir, options.secureDirectory));
  const unlock = await acquireConnectorLock(directory);
  const fetcher = noRedirectFetch(options.fetch);
  const stop = new AbortController();
  const cancel = () => stop.abort(); signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) stop.abort();
  let bridge: RuntimeBridge | undefined;
  let control: Awaited<ReturnType<typeof startControl>> | undefined;
  let saved: InstalledConnection | undefined;
  let diagnostics: Record<string, unknown> = { status: 'starting', phase: 'starting', runtimeChecks: 'pending' };
  const startedAt = new Date().toISOString();
  let failed = false;
  const record = async (phase: RuntimePhase, runtimeChecks: RuntimeDiagnostic['runtimeChecks'] = 'pending',
    errorCode?: string, retryAt?: string) => {
    const previousCode = typeof diagnostics.errorCode === 'string' ? diagnostics.errorCode : undefined;
    const candidate = errorCode ?? (phase === 'service_check' || phase === 'runtime_check' || phase === 'tool_verification' ? previousCode : undefined);
    const safeCode = candidate && /^[A-Z][A-Z0-9_]{0,119}$/.test(candidate) ? candidate : undefined;
    const snapshot: RuntimeDiagnostic = { version: 1, phase, startedAt, updatedAt: new Date().toISOString(), runtimeChecks,
      ...(safeCode ? { errorCode: safeCode } : {}), ...(retryAt ? { retryAt } : {}) };
    diagnostics = { ...diagnostics, phase, runtimeChecks, errorCode: safeCode, retryAt };
    // Observation must never prevent the owner process from starting or recovering.
    await writeRuntimeDiagnostic(directory, snapshot).catch(() => {});
  };
  try {
    await record('starting');
    const wake = await resolveHostedWakeConfig(directory, options.env ?? process.env);
    saved = await readConnection(directory);
    if (!await savedSession(directory)) throw new ConnectorSetupError('STATE_INVALID', 'Saved credentials are missing; reconnect through Envoi before starting');
    const startup = new EnvoiConnector(saved.apiUrl, new FileBridgeStore(directory), { fetch: fetcher });
    await startup.start();
    const adapter = resolveAdapter(saved.runtime);
    const context = { ...options, signal: stop.signal, apiUrl: saved.apiUrl, stateDir: directory, fetch: fetcher };
    if (options.control !== false) control = await startControl(directory, { runtime: saved.runtime, address: saved.address, apiUrl: saved.apiUrl }, cancel,
      () => ({ ...diagnostics, ...(bridge ? { wake: bridge.connector.wakeDiagnostics() } : {}) }),
      createHostTaskSender(directory, saved, () => {
        if (!bridge || diagnostics.runtimeChecks !== 'passed' || stop.signal.aborted) throw new HostTaskError('CONNECTOR_NOT_READY');
        return bridge.connector;
      }));
    const initialState = await startup.lifecycle();
    if (initialState.retryAt) await delay(Math.max(0, Date.parse(initialState.retryAt) - Date.now()), undefined, { signal: stop.signal }).catch(error => { if (!stop.signal.aborted) throw error; });
    while (!stop.signal.aborted) {
      try {
        await record('service_check');
        await checkEnvoi(saved.apiUrl, fetcher);
        await record('runtime_check');
        const config = await adapter.discover(context, saved.configuration);
        await (adapter.startupCheck ?? adapter.preflight)(config, context);
        await adapter.configure?.(config, context);
        saved.configuration = config;
        await privateJson(path.join(directory, 'connection.json'), saved);
        bridge = await adapter.createBridge(config, context);
        if (wake) bridge.connector.scopedWakeWorkDriver();
        bridge.connector.onState(lifecycle => { diagnostics = { ...diagnostics, status: lifecycle.state === 'DEGRADED' ? 'waiting' : lifecycle.state.toLowerCase(), lifecycle, guidance: lifecycle.guidance }; });
        await bridge.connector.start();
        await bridge.connector.checkStatus();
        if (!(await bridge.connector.lifecycle()).paused) {
          await record('tool_verification');
          if (saved.runtime === 'hermes') await waitForRuntimeTools(bridge, stop.signal, {
            timeoutMs: options.toolRecoveryTimeoutMs, retryMs: options.toolRecoveryRetryMs,
            onWaiting(code) {
              diagnostics = { status: 'waiting', runtimeChecks: 'pending', errorCode: code,
                guidance: 'Waiting for the selected Gateway to rediscover Envoi tools. Saved enrollment is unchanged.' };
              options.onWaiting?.(code);
            }
          });
          else await bridge.verify?.();
          if (!(await bridge.connector.lifecycle()).paused) await report(saved, bridge.connector, 'ready', fetcher);
        }
        const lifecycle = await bridge.connector.lifecycle();
        diagnostics = { status: lifecycle.state.toLowerCase(), lifecycle, guidance: lifecycle.guidance, runtimeChecks: lifecycle.paused ? 'deferred_while_paused' : 'passed', checkedAt: new Date().toISOString(), ...adapter.describe(config) };
        await record('ready', lifecycle.paused ? 'deferred_while_paused' : 'passed');
        break;
      } catch (error) {
        await bridge?.close(); bridge = undefined;
        if (stop.signal.aborted) return;
        const transient = error instanceof ConnectorSetupError && ['ENVOI_UNREACHABLE', 'GATEWAY_UNREACHABLE', 'PROVIDER_UNREACHABLE'].includes(error.code)
          || error instanceof EnvoiError && lifecyclePolicy(error).lifecycle === 'DEGRADED'
          || error instanceof TypeError && /fetch|network/i.test(error.message);
        if (!transient) throw error;
        const code = error instanceof ConnectorSetupError ? error.code : 'CONNECTION_TEMPORARILY_UNAVAILABLE';
        if (!(error instanceof EnvoiError)) await startup.observeError(new EnvoiError('Runtime connection unavailable', undefined, 'NETWORK_ERROR'));
        const lifecycle = await startup.lifecycle();
        diagnostics = { status: 'waiting', lifecycle, guidance: lifecycle.guidance, runtimeChecks: 'pending', errorCode: code };
        await record('retry_wait', 'pending', code, lifecycle.retryAt);
        options.onWaiting?.(code);
        await delay(Math.max(error instanceof EnvoiError ? (error.retryAfterSeconds ?? 0) * 1000 : 0, options.retryDelayMs ?? Math.max(0, Date.parse(lifecycle.retryAt ?? '') - Date.now())), undefined, { signal: stop.signal }).catch(error => { if (!stop.signal.aborted) throw error; });
      }
    }
    if (stop.signal.aborted || !bridge) return;
    if (wake) {
      const session = await new FileBridgeStore(directory).load();
      if (!session) throw new ConnectorSetupError('STATE_INVALID', 'Hosted wake needs saved connector identity');
      await runHostedWake({ connector: bridge.connector, session, stateDir: directory, config: wake, signal: stop.signal,
        onListening: options.onReady });
    } else { options.onReady?.(); await bridge.connector.run(stop.signal); }
  } catch (error) {
    if (!stop.signal.aborted) {
      failed = true;
      await record('failed', 'pending', error instanceof ConnectorSetupError || error instanceof EnvoiError ? error.code : 'CONNECTOR_START_FAILED');
    }
    if (saved && bridge && !stop.signal.aborted) await report(saved, bridge.connector, 'error', fetcher, 'CONNECTOR_START_FAILED').catch(() => {});
    if (!stop.signal.aborted) throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    try { await control?.close(); await bridge?.close(); } finally {
      if (!failed) await record('stopped');
      await unlock();
    }
  }
}

export async function connectionStatus(stateDir: string) {
  const directory = path.resolve(stateDir);
  const saved = await readConnection(directory);
  const session = await savedSession(directory);
  let live: Record<string, unknown> | null = null;
  let controlChannel: 'responding' | 'absent' | 'unreachable' | 'invalid' | 'identity_mismatch' = 'absent';
  try {
    const response = await queryControl(directory, 'status');
    if (!controlIdentityMatches(response, saved) || typeof response.status !== 'string') controlChannel = 'identity_mismatch';
    else { live = response; controlChannel = 'responding'; }
  } catch (error) {
    controlChannel = error instanceof ConnectorSetupError && error.code === 'CONTROL_INVALID' ? 'invalid'
      : (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'absent' : 'unreachable';
  }
  const checks = await readFile(path.join(directory, 'setup-check.json'), 'utf8').then(text => JSON.parse(text) as { checkedAt?: string }).catch(() => null);
  const enrollmentError = await readEnrollmentDiagnostic(directory);
  const lastRuntime = await readRuntimeDiagnostic(directory);
  const configuration = saved.configuration as Record<string, unknown>;
  const scopedHermes = saved.runtime === 'hermes' && configuration.scopedTools === true;
  const gatewayHost = scopedHermes && typeof configuration.home === 'string' && typeof configuration.daemonOrigin === 'string'
    && typeof configuration.scopedCwd === 'string'
    ? { home: configuration.home, origin: configuration.daemonOrigin, cwd: configuration.scopedCwd } : null;
  const [startupService, selectedGateway] = await Promise.all([
    inspectConnectorService(directory, saved.runtime).catch(() => ({ registration: 'unverified' as const })),
    gatewayHost ? inspectHermesHost(gatewayHost).catch((): HermesHostObservation => ({ connection: 'unverified', supervisor: 'unknown', originMatches: null }))
      : Promise.resolve(scopedHermes ? { connection: 'unverified', supervisor: 'unknown', originMatches: null } as HermesHostObservation : undefined)
  ]);
  const status = live?.status ?? (controlChannel === 'invalid' || controlChannel === 'identity_mismatch'
    || 'managerState' in startupService && startupService.managerState === 'running' ? 'unverified' : 'stopped');
  const diagnosticCode = live ? live.errorCode : lastRuntime?.errorCode;
  const errorCode = typeof diagnosticCode === 'string' ? diagnosticCode : undefined;
  const phase = live ? live.phase : lastRuntime?.phase;
  const nextAction = !session ? 'Preserve the connection directory and ask the owner to recover its missing credentials.'
    : session.lifecycle?.state === 'REVOKED' ? 'Ask the owner to review the revoked installation; preserve its saved state.'
    : session.lifecycle?.state === 'NEEDS_RECONNECT' ? 'Ask the owner to reconnect this existing agent through Envoi.'
    : controlChannel === 'invalid' || controlChannel === 'identity_mismatch' ? 'Inspect the private connector control record and preserve this installation; its live identity is unverified.'
    : status === 'unverified' ? 'The host manager reports a running connector without a responding control channel; inspect that process and retry status.'
    : session.lifecycle?.paused ? status === 'stopped'
      ? 'Start the existing connector so it can observe the owner resuming this agent.'
      : 'Wait for the owner to resume this existing agent.'
    : errorCode === 'SCOPED_CONFIG_INVALID' ? 'Preserve the connection and ask the owner to review the selected scoped Gateway.'
    : ['HERMES_EXECUTION_UNCERTAIN', 'HERMES_CREATION_UNCERTAIN', 'SCOPED_MODEL_CHANGED'].includes(errorCode ?? '')
      ? 'Preserve the turn journal and use the supported settlement recovery procedure.'
    : 'enabled' in startupService && startupService.enabled === false ? 'Ask the owner to enable the existing startup service.'
    : 'managerState' in startupService && startupService.managerState === 'failed' ? 'Inspect the startup service failure; preserve enrollment and credentials.'
    : errorCode === 'GATEWAY_UNREACHABLE' ? 'Restore the selected Gateway; the connector will retry its saved connection.'
    : phase === 'failed' ? 'Inspect the saved runtime error code and repair the selected runtime before restarting.'
    : 'recoveryPolicy' in startupService && startupService.recoveryPolicy === 'outdated' ? 'Ask the owner to reinstall the existing connector startup service with this build; preserve its saved profile and enrollment.'
    : status === 'stopped' && startupService.registration === 'not_installed' ? 'Start the existing connector or ask the owner to install its startup service.'
    : status === 'stopped' ? 'Restart the existing connector using its saved state directory.'
    : status === 'waiting' ? 'Wait for the saved retry, then verify a real agent exchange.'
    : undefined;
  return { runtime: saved.runtime, address: saved.address, apiUrl: saved.apiUrl, agentId: session?.agentId,
    credentialState: session ? 'saved' : 'missing', lifecycle: session?.lifecycle, guidance: session?.lifecycle?.guidance, ...(enrollmentError ? { enrollmentError } : {}),
    stateDir: directory, status, controlChannel, startupService, ...(selectedGateway ? { selectedGateway } : {}),
    ...(nextAction ? { nextAction } : {}), checkedAt: live?.checkedAt ?? checks?.checkedAt,
    runtimeDiagnostic: live ? { phase: live.phase, runtimeChecks: live.runtimeChecks,
      ...(live.errorCode ? { errorCode: live.errorCode } : {}), ...(live.retryAt ? { retryAt: live.retryAt } : {}),
      ...(live.wake ? { wake: live.wake } : {}) } : lastRuntime,
    credentialExpiresAt: session?.agentTokenExpiresAt, refreshExpiresAt: session?.agentRefreshTokenExpiresAt,
    note: 'A running connector is not proof of successful message delivery. Verify a real agent exchange' };
}
export async function doctorConnection(stateDir: string, resolveAdapter: AdapterResolver, options: AdapterOptions = {}) {
  const directory = path.resolve(stateDir);
  const snapshot = await connectionStatus(directory);
  if (snapshot.status === 'unverified') return { ...snapshot, runtimeChecks: 'unverified',
    note: 'The local connector identity or process is unverified; inspect the saved control channel before running offline preflight' };
  const live = snapshot.controlChannel === 'responding' ? await queryControl(directory, 'doctor').catch(() => null) : null;
  // Ask the owner process for its latest checks. A second process must not rotate
  // shared credentials or claim queued work while the durable bridge owns them.
  if (controlIdentityMatches(live, snapshot))
    return { ...snapshot, ...live, note: 'Checks are from the running connector; verify a real message exchange' };
  if (snapshot.controlChannel === 'responding') return { ...snapshot, status: 'unverified', runtimeChecks: 'unverified',
    nextAction: 'The connector control response changed during doctor; inspect the existing process and retry status.',
    note: 'The local connector identity or process is unverified; offline preflight was not run' };
  const unlock = await acquireConnectorLock(directory);
  try {
    const saved = await readConnection(directory);
    const adapter = resolveAdapter(saved.runtime);
    const fetcher = noRedirectFetch(options.fetch);
    await checkEnvoi(saved.apiUrl, fetcher);
    const context = { ...options, apiUrl: saved.apiUrl, stateDir: directory, fetch: fetcher };
    const config = await adapter.discover(context, saved.configuration);
    await (adapter.startupCheck ?? adapter.preflight)(config, context);
    const store = new FileBridgeStore(directory);
    await new EnvoiConnector(saved.apiUrl, store, { fetch: fetcher }).checkStatus();
    return { ...await connectionStatus(directory), runtimeChecks: 'preflight_only',
      note: 'No connector is running. Preflight cannot prove MCP tool discovery, inbox wake, or agent processing', ...adapter.describe(config) };
  } finally { await unlock(); }
}
export async function removeInstalledExecutable(stateDir: string) {
  const directory = path.resolve(stateDir);
  let unlock: (() => Promise<void>) | undefined;
  const deadline = Date.now() + 15_000;
  while (!unlock) {
    try { unlock = await acquireConnectorLock(directory); }
    catch (error) { if (!(error instanceof Error) || !error.message.includes('already running') || Date.now() >= deadline) throw error; await delay(100); }
  }
  try { await rm(path.join(directory, 'connector.mjs'), { force: true }); }
  finally { await unlock(); }
}
