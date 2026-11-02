import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPortableRestHost } from './portable-rest';
import { privateDirectory } from '../connector/store';
import { nativeConfirmation } from './helper/confirmation.mjs';
import type { WorkHandler } from '../../sdk/typescript/src/connector';

interface HostConfig {
  schemaVersion: 'portable-rest-host-v1';
  origin: string;
  stateDirectory: string;
  handlerModule: string;
  runtime: { type: string; version: string };
  requestedName: string;
}
const safeFailure = { schemaVersion: '1', state: 'needs_help', reachability: 'not_verified_closed_app',
  nextAction: 'The trusted REST host could not continue. Preserve its private state and check the host configuration or service supervisor.' };
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

async function readHostConfig(filename: string): Promise<HostConfig> {
  if (!path.isAbsolute(filename)) throw new Error('HOST_CONFIG_INVALID');
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw new Error('HOST_CONFIG_INVALID');
  const config = JSON.parse(await readFile(filename, 'utf8')) as HostConfig;
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || Object.keys(config).some(key => !['schemaVersion', 'origin', 'stateDirectory', 'handlerModule', 'runtime', 'requestedName'].includes(key))
    || config.schemaVersion !== 'portable-rest-host-v1' || typeof config.origin !== 'string'
    || !path.isAbsolute(config.stateDirectory) || !path.isAbsolute(config.handlerModule)
    || !/^envoi-rest-host(?:-[a-z0-9_-]{1,40})?$/.test(path.basename(config.stateDirectory))
    || !samePath(path.dirname(filename), config.stateDirectory)
    || !config.runtime || Object.keys(config.runtime).some(key => !['type', 'version'].includes(key))
    || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(config.runtime.type)
    || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/.test(config.runtime.version)
    || typeof config.requestedName !== 'string' || !config.requestedName.trim() || config.requestedName.length > 80) throw new Error('HOST_CONFIG_INVALID');
  const handlerStat = await lstat(config.handlerModule);
  if (!handlerStat.isFile() || handlerStat.isSymbolicLink() || handlerStat.size > 1_000_000) throw new Error('HOST_HANDLER_INVALID');
  const canonicalHandler = await realpath(config.handlerModule);
  if (process.platform === 'win32' ? canonicalHandler.toLowerCase() !== config.handlerModule.toLowerCase()
    : canonicalHandler !== config.handlerModule) throw new Error('HOST_HANDLER_INVALID');
  return config;
}

export async function runPortableRestCli(args: string[], emit: (result: Record<string, unknown>) => void = result => process.stdout.write(`${JSON.stringify(result)}\n`)) {
  try {
    if (args.length !== 2 || !['connect', 'resume', 'status', 'run'].includes(args[0])) throw new Error('COMMAND_INVALID');
    const command = args[0] as 'connect' | 'resume' | 'status' | 'run';
    const filename = args[1];
    const config = await readHostConfig(filename);
    await privateDirectory(config.stateDirectory);
    if (JSON.stringify(await readHostConfig(filename)) !== JSON.stringify(config)) throw new Error('HOST_CONFIG_CHANGED');
    let handler: WorkHandler;
    if (command !== 'status') {
      const module = await import(/* @vite-ignore */ pathToFileURL(config.handlerModule).href) as { createWorkHandler?: (context: { origin: string; stateDirectory: string }) => Promise<WorkHandler> | WorkHandler };
      if (typeof module.createWorkHandler !== 'function') throw new Error('HOST_HANDLER_INVALID');
      handler = await module.createWorkHandler({ origin: config.origin, stateDirectory: config.stateDirectory });
    } else {
      // Status never executes provider work or initializes its model.
      handler = { admit: async () => { throw new Error('HOST_HANDLER_NOT_RUNNING'); },
        process: async () => { throw new Error('HOST_HANDLER_NOT_RUNNING'); } };
    }
    const host = await createPortableRestHost({ origin: config.origin, directory: config.stateDirectory,
      runtime: config.runtime, helper: { name: 'envoi-rest-host', version: '1.0.0' },
      deliveryCapabilities: { persistentProcess: true, outboundHttps: true, sse: true, webhook: false, scheduledPolling: false, a2a: false },
      requestedName: config.requestedName,
      confirm: details => nativeConfirmation(details), handler });
    if (command === 'run') {
      const stop = new AbortController();
      const onStop = () => stop.abort();
      process.once('SIGINT', onStop); process.once('SIGTERM', onStop);
      try { await host.run(stop.signal); }
      finally { process.off('SIGINT', onStop); process.off('SIGTERM', onStop); }
      return true;
    }
    const result = await host[command]();
    emit(result);
    return true;
  } catch { emit(safeFailure); return false; }
}
