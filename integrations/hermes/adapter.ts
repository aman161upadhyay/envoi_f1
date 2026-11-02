import path from 'node:path';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { ConnectorSetupError, type AdapterContext, type ConnectorAdapter } from '../connector/adapter';
import { EnvoiError } from '../../sdk/typescript/src/index';
import { privateJson } from '../openclaw/quick-connect-store';
import { discoverHermes, hermesServerName, mergeMcpConfiguration, optionalText, replaceConfiguration, setEnvValue } from './config';
import { boundedHermesRun, checkHermesCapabilities, preflightHermes } from './api';
import { createHermesBridge } from './runtime';
import { assertScopedHermes, hermesHost, selectScopedHermes, type HermesRuntimeConfiguration } from './scoped-runtime';
import { connectHermesHost } from './scoped-host';

interface RelayState { version: 1; port: number; token: string; serverName: string }

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (!address || typeof address === 'string') throw new ConnectorSetupError('RELAY_UNAVAILABLE', 'Could not allocate a private Hermes MCP relay port.');
  return address.port;
}

async function relayState(context: AdapterContext): Promise<RelayState> {
  const filename = path.join(context.stateDir, 'hermes-relay.json');
  const text = await optionalText(filename);
  if (text !== null) {
    let stored: RelayState;
    try { stored = JSON.parse(text) as RelayState; }
    catch { throw new ConnectorSetupError('STATE_INVALID', 'Hermes relay state is unreadable. Restore its private saved configuration.'); }
    if (!stored || typeof stored !== 'object' || Array.isArray(stored) || stored.version !== 1 || !Number.isSafeInteger(stored.port) || stored.port < 1 || stored.port > 65535
      || !/^[a-f0-9]{64}$/.test(stored.token) || !/^envoi_[a-f0-9]{16}$/.test(stored.serverName)) {
      throw new ConnectorSetupError('STATE_INVALID', 'Hermes relay state is invalid. Restore its private saved configuration.');
    }
    return stored;
  }
  const serverName = hermesServerName(context.stateDir);
  const state: RelayState = { version: 1, port: await availablePort(), token: randomBytes(32).toString('hex'), serverName };
  await privateJson(filename, state);
  return state;
}

export async function configureHermes(config: HermesRuntimeConfiguration, context: AdapterContext) {
  const scoped = await selectScopedHermes(context, config);
  if (scoped) { await assertScopedHermes(scoped, context.env ?? process.env); return; }
  const relay = await relayState(context);
  const variable = `ENVOI_MCP_${relay.serverName.slice('envoi_'.length).toUpperCase()}`;
  const original = await optionalText(config.configPath);
  const block = [
    `  ${relay.serverName}:`, `    url: "http://127.0.0.1:${relay.port}/mcp"`, '    headers:',
    `      Authorization: "Bearer \${${variable}}"`, '    tools:',
    '      include: [envoi_agent_info, envoi_start_case, envoi_send_message, envoi_send_proposal, envoi_send_decision, envoi_list_cases, envoi_read_case, envoi_list_messages, envoi_list_assets, envoi_asset_download]',
    '      resources: false', '      prompts: false'
  ];
  const updated = mergeMcpConfiguration(original ?? '', relay.serverName, block);
  const envPath = path.join(config.home, '.env');
  const originalEnv = await optionalText(envPath);
  await replaceConfiguration(envPath, originalEnv, setEnvValue(originalEnv ?? '', variable, relay.token));
  await replaceConfiguration(config.configPath, original, updated);
}

export const hermesAdapter: ConnectorAdapter<HermesRuntimeConfiguration> = {
  runtime: 'hermes',
  async discover(options, previous) {
    return await selectScopedHermes(options, previous) ?? discoverHermes(options, previous);
  },
  async preflight(config, options) {
    const scoped = await selectScopedHermes(options, config);
    if (!scoped) return preflightHermes(config, options);
    await assertScopedHermes(scoped, options.env ?? process.env);
    let wire;
    try { wire = await connectHermesHost(hermesHost(scoped), AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(15000)])); }
    catch (error) {
      // Startup has not claimed work. Retry only an absent selected daemon;
      // identity/scope mismatches and failures during a turn remain terminal.
      if (error instanceof EnvoiError && error.code === 'HERMES_DAEMON_UNREACHABLE')
        throw new ConnectorSetupError('GATEWAY_UNREACHABLE', 'The selected Hermes Gateway is unavailable; retrying its saved origin.');
      if (error instanceof EnvoiError && error.code === 'HERMES_ORIGIN_CHANGED')
        throw new ConnectorSetupError('SCOPED_CONFIG_INVALID', 'The selected Hermes Gateway origin changed. Preserve the saved connection and use the supported owner-confirmed reselection procedure.');
      throw error;
    }
    wire.close();
  },
  async startupCheck(config, options) {
    const scoped = await selectScopedHermes(options, config);
    if (!scoped) return checkHermesCapabilities(config, options);
    return hermesAdapter.preflight(config, options);
  },
  async configure(config, context) {
    const scoped = await selectScopedHermes(context, config);
    if (scoped) { await assertScopedHermes(scoped, context.env ?? process.env); return; }
    // Persist the port/key now, but do not advertise an unreachable MCP endpoint.
    // The Gateway can otherwise discover it before createBridge starts listening.
    await relayState(context);
  },
  async createBridge(config, context) {
    const scoped = await selectScopedHermes(context, config);
    if (scoped) return createHermesBridge({ apiUrl: context.apiUrl, stateDir: context.stateDir,
      hermesUrl: '', hermesKey: '', runtime: scoped }, context);
    const relay = await relayState(context);
    let observedInfo = 0;
    let bridge: Awaited<ReturnType<typeof createHermesBridge>>;
    try {
      bridge = await createHermesBridge({
        apiUrl: context.apiUrl, stateDir: context.stateDir, hermesUrl: config.apiUrl, hermesKey: config.apiKey,
        relayToken: relay.token, relayPort: relay.port, writeEnabled: true
      }, { env: { ...(context.env ?? process.env), ENVOI_ASSET_MANIFEST_PATH: config.assetManifestPath }, fetch: context.fetch, pollIntervalMs: context.pollIntervalMs,
        onSuccessfulToolCall(name) { if (name === 'envoi_agent_info') observedInfo++; }
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new ConnectorSetupError('RELAY_UNAVAILABLE', 'This Hermes connection relay port is occupied. Stop its prior connector or the conflicting process, then retry with the same state directory.');
      throw error;
    }
    try {
      // createHermesBridge has awaited listen(). Keep this same relay alive while
      // the Gateway reconciles config, including its parked-server self-probe.
      await configureHermes(config, context);
    } catch (error) {
      await bridge.close();
      throw error;
    }
    return { connector: bridge.connector, close: bridge.close, async verify(signal) {
      const before = observedInfo;
      await boundedHermesRun(config,
        `Envoi setup verification. Call the envoi_agent_info MCP tool from server ${relay.serverName} exactly once, then finish. Use its discovered tool name. Do not send messages, invoke terminal commands, or change files.`,
        { ...context, ...(signal ? { signal } : {}) });
      if (observedInfo <= before) throw new ConnectorSetupError('TOOLS_NOT_READY', 'Hermes has not invoked the Envoi identity tool through its live relay yet. Waiting for the selected Gateway to reconcile or reconnect its MCP server. Keep this connector running; saved enrollment is unchanged.');
    } };
  },
  describe(config) { return { runtime: 'hermes', profile: config.profile, gatewayUrl: config.apiUrl, configPath: config.configPath }; }
};
