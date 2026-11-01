import { lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import contract from '../../test/contract-fixtures/agent-registration/schemas.json';
import { runCli, connectionFailure, type HelperDependencies } from './envoi-link.mjs';
import { adapterFor } from '../connector/adapters';
import { adoptActivatedConnection, operationalConnectionStatus, readConnection, startConnection, type AdapterResolver, type OperationalStatusContext, type SetupOptions } from '../connector/core';
import { FileBridgeStore } from '../agent-bridges/file-store';
import type { AdapterOptions } from '../connector/adapter';
import { quickConnectOrigin } from '../../sdk/typescript/src/quick-connect';
import { runHostTaskCommand, type TaskPrompt } from './task-cli';
import { validTaskId } from '../connector/host-task';

export type LocalRuntime = 'hermes' | 'openclaw';
export function helperDirectory(origin: string, runtime: LocalRuntime, options: AdapterOptions = {}) {
  const env = options.env ?? process.env; const home = options.homeDir ?? homedir();
  const base = (options.platform ?? process.platform) === 'win32' ? env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    : (options.platform ?? process.platform) === 'darwin' ? path.join(home, 'Library', 'Application Support')
      : env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(home, '.local', 'state');
  return path.join(base, 'envoi', 'onboarding', runtime, createHash('sha256').update(origin).digest('hex').slice(0, 24));
}
export async function selectLocalRuntime(explicit: string | undefined, resolveAdapter: AdapterResolver, options: AdapterOptions = {}, check = true): Promise<LocalRuntime> {
  if (explicit && !['hermes', 'openclaw'].includes(explicit)) throw new Error('Choose Hermes or OpenClaw.');
  const found: LocalRuntime[] = [];
  for (const runtime of (explicit ? [explicit] : ['hermes', 'openclaw']) as LocalRuntime[]) {
    if (!check && explicit) return runtime;
    try { const adapter = resolveAdapter(runtime); const configuration = await adapter.discover(options); if (check) await adapter.preflight(configuration, options); found.push(runtime); }
    catch { /* Provider/configuration errors stay private; no response dump. */ }
  }
  if (found.length !== 1) throw new Error(found.length ? 'Choose one runtime with --runtime hermes or --runtime openclaw.' : 'Prepare a supported runtime on this host before connecting.');
  return found[0];
}
interface LinkOptions extends SetupOptions {
  resolveAdapter?: AdapterResolver; helperCli?: typeof runCli;
  adopt?: typeof adoptActivatedConnection; start?: typeof startConnection;
  write?: (projection: Record<string, any>) => void;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  helperDependencies?: HelperDependencies;
  taskPrompt?: TaskPrompt;
}
/** Actual foreground CLI. Tests inject all runtime/network effects. No service or settings installation. */
export async function runLocalLink(args: string[], signal: AbortSignal, options: LinkOptions = {}) {
  const [command, rawOrigin] = args;
  if (!['connect', 'resume', 'status', 'doctor', 'task'].includes(command) || !rawOrigin) throw new Error('Use envoi-link connect|task <Envoi origin>.');
  const origin = quickConnectOrigin(rawOrigin);
  const runtimeIndex = args.indexOf('--runtime');
  const explicit = runtimeIndex < 0 ? undefined : args[runtimeIndex + 1];
  let retryId: string | undefined;
  let requestedPermissions: string[] | undefined;
  // Reject unknown/token-bearing args before runtime discovery or credential work.
  for (let index = 2; index < args.length; index++) {
    if (args[index] === '--runtime' && ['hermes', 'openclaw'].includes(args[index + 1])) {
      if (command === 'task' && index !== runtimeIndex) throw new Error('Choose one runtime.');
      index++; continue;
    }
    if (command === 'task' && args[index] === '--retry' && !retryId && validTaskId(args[index + 1])) { retryId = args[++index]; continue; }
    if (command === 'connect' && args[index] === '--permissions' && requestedPermissions === undefined) {
      const value = args[++index];
      const permissions = typeof value === 'string' && value.length <= 128 ? value.split(',') : [];
      if (!permissions.length || permissions.length > 4 || new Set(permissions).size !== permissions.length
        || !permissions.includes('receive_agent_messages')
        || permissions.some(permission => !Object.hasOwn(contract['x-permission-labels'], permission))) {
        throw new Error('Choose a supported permission list that includes receiving messages.');
      }
      requestedPermissions = permissions; continue;
    }
    if (command !== 'task' && ['--show-code', '--new'].includes(args[index])) continue;
    throw new Error('Use the documented local helper options.');
  }
  const resolver = options.resolveAdapter ?? adapterFor;
  let selected = explicit;
  if (!selected && ['status', 'doctor', 'resume', 'task'].includes(command)) {
    const saved: LocalRuntime[] = [];
    for (const candidate of ['hermes', 'openclaw'] as const) {
      const candidateDirectory = options.stateDir ?? helperDirectory(origin, candidate, options);
      const stat = await lstat(path.join(candidateDirectory, 'helper-state.json')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (stat && stat.isFile() && !stat.isSymbolicLink()) saved.push(candidate);
    }
    if (saved.length === 1) selected = saved[0];
    else if (saved.length > 1) throw new Error('Choose the saved runtime explicitly.');
  }
  const runtime = await selectLocalRuntime(selected, resolver, options, command === 'connect');
  const directory = options.stateDir ?? helperDirectory(origin, runtime, options);
  if (command === 'task') return runHostTaskCommand(directory, { apiUrl: origin, runtime }, signal,
    { retryId, prompt: options.taskPrompt, write: options.write });
  const dependencies: HelperDependencies = {
    ...options.helperDependencies, contract, directory, runtime: { type: runtime, version: 'unknown' }, ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(requestedPermissions ? { requestedPermissions } : {}),
    operationalStatus: options.helperDependencies?.operationalStatus ?? ((context: OperationalStatusContext) => operationalConnectionStatus(context, { fetch: options.fetch })),
    adopt: async (activation, context) => {
      await (options.adopt ?? adoptActivatedConnection)(origin, runtime, activation, resolver, {
        ...options, signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal,
        stateDir: directory, completionId: context.completionId,
        executableFile: options.executableFile ?? fileURLToPath(new URL(/* @vite-ignore */ './envoi-connector.mjs', import.meta.url))
      });
    }
  };
  const call = options.helperCli ?? runCli;
  const effectiveArgs = [command, origin, '--runtime', runtime, ...args.slice(2).filter((value, index, rest) =>
    !['--runtime', '--permissions'].includes(value) && !['--runtime', '--permissions'].includes(rest[index - 1]))];
  let result = await call(effectiveArgs, dependencies);
  options.write?.(result);
  while (['connect', 'resume'].includes(command) && result.state === 'pending_approval' && !signal.aborted) {
    await (options.wait ?? ((ms, stop) => delay(ms, undefined, { signal: stop })))(contract['x-limits'].pollAfterSeconds * 1000, signal);
    signal.throwIfAborted();
    const next = await call(['resume', origin, '--runtime', runtime], dependencies);
    if (next.state !== result.state) options.write?.(next);
    result = next;
  }
  if (['connect', 'resume'].includes(command) && ['connected', 'paused'].includes(result.state) && !signal.aborted) {
    const configuration = await readConnection(directory);
    const session = await new FileBridgeStore(directory).load() as any;
    if (configuration.apiUrl !== origin || configuration.runtime !== runtime || configuration.address !== session?.address
      || !configuration.activationSetup || configuration.activationSetup.completionId !== session?._onboarding?.completionId
      || configuration.activationSetup.installationId !== session?._onboarding?.installation?.id) throw new Error('Saved runtime configuration does not match this installation.');
    let failure: Record<string, any> | null = null;
    try {
      await (options.start ?? startConnection)(directory, signal, resolver, { ...options, control: true });
      if (!signal.aborted) {
        // The foreground connector can stop normally after durably recording a revoke.
        // Reload after it releases its lock; the pre-start session is now stale.
        const lifecycle = (await new FileBridgeStore(directory).load())?.lifecycle;
        if (lifecycle && ['REVOKED', 'NEEDS_RECONNECT'].includes(lifecycle.state)) failure = connectionFailure(contract, lifecycle);
      }
    } catch (error) {
      if (signal.aborted) return result;
      failure = connectionFailure(contract, error);
      if (!failure) throw error;
    }
    if (failure) { result = failure; options.write?.(result); }
  }
  return result;
}
