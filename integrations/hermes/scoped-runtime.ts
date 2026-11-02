import path from 'node:path';
import { lstat, readFile } from 'node:fs/promises';
import { EnvoiConnector } from '../../sdk/typescript/src/connector';
import { FileBridgeStore } from '../agent-bridges/file-store';
import { scopedTurnHandler } from '../agent-bridges/scoped-turn';
import { FileScopedRunStore } from '../grok/scoped-store';
import { ConnectorSetupError, type AdapterOptions } from '../connector/adapter';
import { privateJson } from '../connector/store';
import { optionalText, type HermesConfiguration } from './config';
import { hermesScopedTurn, validateHermesHost, type HermesScopedHost } from './scoped-host';
import { observeRuntime, type ScopedRuntimeObserver } from '../agent-bridges/runtime-events';

export type HermesRuntimeConfiguration = HermesConfiguration & { scopedTools?: true; daemonOrigin?: string; scopedCwd?: string };

const refuse = () => new ConnectorSetupError('SCOPED_CONFIG_INVALID', 'Scoped Hermes requires its saved daemon selection and a profile without a separate privileged Envoi integration');
const legacyOptions = ['HERMES_MCP_RELAY_TOKEN', 'HERMES_MCP_RELAY_PORT', 'HERMES_MCP_WRITE_ENABLED', 'ENVOI_ASSET_MANIFEST_PATH'];

export function hermesHost(config: HermesRuntimeConfiguration): HermesScopedHost {
  if (config.scopedTools !== true || typeof config.daemonOrigin !== 'string' || typeof config.scopedCwd !== 'string') throw refuse();
  const host = { home: config.home, origin: config.daemonOrigin, cwd: config.scopedCwd };
  validateHermesHost(host);
  return host;
}

export type HermesSelection = { version: 1 | 2; configuration: HermesRuntimeConfiguration; previousConfiguration?: HermesRuntimeConfiguration };
const configurationKeys = 'apiKey,apiUrl,configPath,daemonOrigin,home,profile,scopedCwd,scopedTools';
export function sameHermesConfiguration(left: unknown, right: unknown): boolean {
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) || Array.isArray(right)) return false;
  return Object.keys(left).sort().join(',') === configurationKeys && Object.keys(right).sort().join(',') === configurationKeys
    && Object.keys(left).every(key => (left as Record<string, unknown>)[key] === (right as Record<string, unknown>)[key]);
}
export function sameHermesProfile(left: HermesRuntimeConfiguration, right: HermesRuntimeConfiguration): boolean {
  return sameHermesConfiguration({ ...left, apiUrl: right.apiUrl, daemonOrigin: right.daemonOrigin }, right);
}
export async function readHermesSelection(stateDir?: string): Promise<HermesSelection | undefined> {
  if (!stateDir) return;
  const filename = path.join(stateDir, 'hermes-scoped.json');
  const stat = await lstat(filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat) return;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw refuse();
  try {
    const value = JSON.parse(await readFile(filename, 'utf8'));
    if (!value || ![1, 2].includes(value.version) || Object.keys(value).sort().join(',') !==
      (value.version === 1 ? 'configuration,version' : 'configuration,previousConfiguration,version')) throw refuse();
    for (const config of value.version === 1 ? [value.configuration] : [value.configuration, value.previousConfiguration]) {
      if (!config || Object.keys(config).sort().join(',') !== configurationKeys || config.apiKey !== '' || config.apiUrl !== config.daemonOrigin) throw refuse();
      hermesHost(config);
    }
    if (value.version === 2 && !sameHermesProfile(value.configuration, value.previousConfiguration)) throw refuse();
    return value;
  } catch { throw refuse(); }
}

export async function assertScopedHermes(config: HermesRuntimeConfiguration, env: NodeJS.ProcessEnv) {
  hermesHost(config);
  if (!path.isAbsolute(config.configPath) || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(config.profile)
    || config.assetManifestPath !== undefined || legacyOptions.some(name => env[name] !== undefined)
    || env.ENVOI_SCOPED_TOOLS !== undefined && env.ENVOI_SCOPED_TOOLS !== 'true') throw refuse();
  const yaml = await optionalText(config.configPath), localEnv = await optionalText(path.join(config.home, '.env'));
  if (yaml === null || /envoi|sinaloa/i.test(yaml) || /(?:ENVOI|SINALOA)_(?:MCP|API|ENROLLMENT|AGENT|ACCESS|REFRESH)/i.test(localEnv ?? '')) throw refuse();
}

export async function selectScopedHermes(options: AdapterOptions & { stateDir?: string }, previous?: HermesRuntimeConfiguration) {
  const env = options.env ?? process.env;
  if (env.ENVOI_SCOPED_TOOLS !== undefined && !['true', 'false'].includes(env.ENVOI_SCOPED_TOOLS)) throw refuse();
  const selection = await readHermesSelection(options.stateDir);
  const marker = selection?.configuration;
  // One atomic owner-approved marker is authoritative. The regular connector
  // refreshes its cached connection only after this exact before/after match.
  const prior = previous?.scopedTools === true ? previous : marker;
  const persisted = selection?.version === 2 && prior && sameHermesConfiguration(prior, selection.previousConfiguration!) ? marker : prior;
  if (persisted && env.ENVOI_SCOPED_TOOLS === 'false') throw refuse();
  if (!persisted && env.ENVOI_SCOPED_TOOLS !== 'true') return null;
  if (previous && previous.scopedTools !== true && previous.assetManifestPath !== undefined) throw refuse();
  const home = options.configPath ? path.dirname(path.resolve(options.configPath)) : persisted?.home ?? env.HERMES_HOME;
  if (!home || !path.isAbsolute(home)) throw refuse();
  const config: HermesRuntimeConfiguration = {
    home, profile: options.profile ?? persisted?.profile ?? 'default', configPath: options.configPath ? path.resolve(options.configPath) : persisted?.configPath ?? path.join(home, 'config.yaml'),
    apiUrl: env.HERMES_DAEMON_URL ?? persisted?.daemonOrigin ?? '', apiKey: '', scopedTools: true,
    daemonOrigin: env.HERMES_DAEMON_URL ?? persisted?.daemonOrigin ?? '', scopedCwd: env.HERMES_SCOPED_CWD ?? persisted?.scopedCwd ?? home
  };
  if (marker && !sameHermesConfiguration(marker, config) || persisted && (persisted.home !== config.home || persisted.daemonOrigin !== config.daemonOrigin || persisted.scopedCwd !== config.scopedCwd
    || persisted.configPath !== config.configPath || persisted.profile !== config.profile)) throw refuse();
  await assertScopedHermes(config, env);
  return config;
}

export async function saveHermesScopedMode(stateDir: string, config: HermesRuntimeConfiguration) {
  const existing = (await readHermesSelection(stateDir))?.configuration;
  if (existing && !sameHermesConfiguration(existing, config)) throw refuse();
  if (!existing) await privateJson(path.join(stateDir, 'hermes-scoped.json'), { version: 1, configuration: config });
}

export async function createScopedHermesBridge(config: { apiUrl: string; stateDir: string; runtime: HermesRuntimeConfiguration }, options: {
  env?: NodeJS.ProcessEnv; fetch?: typeof fetch; pollIntervalMs?: number;
  timeoutMs?: number; pollMs?: number; onRuntimeEvent?: ScopedRuntimeObserver;
} = {}) {
  await assertScopedHermes(config.runtime, options.env ?? process.env);
  const selected = await selectScopedHermes({ env: options.env ?? process.env, stateDir: config.stateDir }, config.runtime);
  if (!selected) throw refuse();
  const store = new FileBridgeStore(config.stateDir);
  await store.init();
  if (!await store.load()) throw new Error('No connector credentials were saved. Run setup first');
  await saveHermesScopedMode(config.stateDir, selected);
  const runs = new FileScopedRunStore(config.stateDir);
  const stopping = new AbortController();
  const active = new Set<Promise<void>>();
  const run = hermesScopedTurn(hermesHost(selected), runs, options);
  const connector = new EnvoiConnector(config.apiUrl, store, { fetch: options.fetch, pollIntervalMs: options.pollIntervalMs,
    caseSessionHandler: scopedTurnHandler({
      admit: message => store.admit(message),
      async run(turn, host) {
        const operation = run({ ...turn, signal: AbortSignal.any([turn.signal, stopping.signal]) }, host);
        active.add(operation);
        try { await operation; } finally { active.delete(operation); }
      },
      async beforeEndTurn(host) {
        if (!host.workId) throw new Error('Scoped Hermes requires trusted work identity');
        const record = await runs.load(host.workId);
        if (!record) throw new Error('Scoped Hermes journal is missing');
        await runs.save({ ...record, completed: true, pending: [] });
      }
    })
  });
  return { connector, store, relayUrl: undefined, close: async () => {
    if (active.size) observeRuntime(options.onRuntimeEvent, { runtime: 'hermes', kind: 'bridge_stop_requested', monotonicMs: performance.now() });
    stopping.abort(); await Promise.allSettled([...active]);
  } };
}
