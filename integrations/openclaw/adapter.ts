import { ConnectorSetupError, type ConnectorAdapter } from '../connector/adapter';
import { checkOpenClawGateway, discoverOpenClaw, OpenClawSetupError, preflightOpenClaw, type OpenClawConfiguration } from './quick-connect-config';
import { createOpenClawBridge } from './runtime';
import path from 'node:path';
import { assertOpenClawScopedAdmission } from './scoped-admission';

export interface InstalledOpenClawConfiguration extends OpenClawConfiguration {
  relayToken?: string;
  relayPort?: string;
  mcpWriteEnabled?: boolean;
  assetManifestPath?: string;
}

function validate(config: InstalledOpenClawConfiguration) {
  if (!config || typeof config !== 'object' || Array.isArray(config)
      || Object.keys(config).some(key => !['gatewayUrl', 'gatewayToken', 'agentId', 'configPath', 'chatCompletionsEnabled', 'responsesEnabled', 'scopedTools',
        'relayToken', 'relayPort', 'mcpWriteEnabled', 'assetManifestPath'].includes(key))
      || typeof config.gatewayUrl !== 'string' || typeof config.gatewayToken !== 'string'
      || typeof config.agentId !== 'string' || typeof config.configPath !== 'string'
      || config.chatCompletionsEnabled !== undefined && typeof config.chatCompletionsEnabled !== 'boolean'
      || config.responsesEnabled !== undefined && typeof config.responsesEnabled !== 'boolean'
      || config.scopedTools !== undefined && config.scopedTools !== true) {
    throw new ConnectorSetupError('STATE_INVALID', 'The saved OpenClaw configuration is invalid; preserve the private connection directory.');
  }
  if (config.relayToken !== undefined && (typeof config.relayToken !== 'string' || !config.relayToken
      || config.relayToken.length > 16384 || /[\x00-\x20\x7f]/.test(config.relayToken))) {
    throw new ConnectorSetupError('RUNTIME_CONFIGURATION_INVALID', 'Set a valid OPENCLAW_MCP_RELAY_TOKEN privately on this host.');
  }
  if (config.relayPort !== undefined && (typeof config.relayPort !== 'string' || !/^\d+$/.test(config.relayPort)
      || Number(config.relayPort) < 1 || Number(config.relayPort) > 65535)) {
    throw new ConnectorSetupError('RUNTIME_CONFIGURATION_INVALID', 'OPENCLAW_MCP_RELAY_PORT must be from 1 to 65535.');
  }
  if (config.mcpWriteEnabled !== undefined && typeof config.mcpWriteEnabled !== 'boolean'
      || (config.relayPort || config.mcpWriteEnabled) && !config.relayToken) {
    throw new ConnectorSetupError('RUNTIME_CONFIGURATION_INVALID', 'OpenClaw MCP relay ports and writes require a private relay token.');
  }
  if (config.assetManifestPath !== undefined && (typeof config.assetManifestPath !== 'string'
      || !path.isAbsolute(config.assetManifestPath) || /[\x00-\x1f\x7f]/.test(config.assetManifestPath))) {
    throw new ConnectorSetupError('RUNTIME_CONFIGURATION_INVALID', 'The approved asset manifest path must be an absolute local path.');
  }
}

function runtimeSettings(config: OpenClawConfiguration, env: NodeJS.ProcessEnv, previous?: InstalledOpenClawConfiguration): InstalledOpenClawConfiguration {
  const relayToken = env.OPENCLAW_MCP_RELAY_TOKEN ?? previous?.relayToken;
  const relayPort = env.OPENCLAW_MCP_RELAY_PORT ?? previous?.relayPort;
  const write = env.OPENCLAW_MCP_WRITE_ENABLED;
  if (write !== undefined && !['', 'true', 'false'].includes(write)) throw new ConnectorSetupError('RUNTIME_CONFIGURATION_INVALID', 'OPENCLAW_MCP_WRITE_ENABLED must be true or false.');
  const mcpWriteEnabled = write === undefined ? previous?.mcpWriteEnabled : write === 'true';
  const manifest = env.ENVOI_ASSET_MANIFEST_PATH ?? previous?.assetManifestPath;
  const resolved = { ...config, ...(relayToken ? { relayToken } : {}), ...(relayPort ? { relayPort } : {}),
    ...(mcpWriteEnabled !== undefined ? { mcpWriteEnabled } : {}), ...(manifest ? { assetManifestPath: path.resolve(manifest) } : {}) };
  validate(resolved); return resolved;
}

export const openclawAdapter: ConnectorAdapter<InstalledOpenClawConfiguration> = {
  runtime: 'openclaw',
  discover: async (options, previous) => {
    try {
      const env = assertOpenClawScopedAdmission(options.env ?? process.env, previous);
      if (previous !== undefined) validate(previous);
      const config = await discoverOpenClaw({ ...options, env, configPath: options.configPath ?? previous?.configPath,
        allowMissingConfig: Boolean(previous), fallbackConfiguration: previous });
      return runtimeSettings(config, env, previous);
    } catch (error) {
      if (error instanceof OpenClawSetupError) throw new ConnectorSetupError('RUNTIME_CONFIGURATION_INVALID', error.message);
      throw error;
    }
  },
  preflight: async (config, options) => {
    try { assertOpenClawScopedAdmission(options.env ?? process.env, config); validate(config); await preflightOpenClaw(config, options); }
    catch (error) {
      if (error instanceof OpenClawSetupError) throw new ConnectorSetupError(error.code, error.message);
      throw error;
    }
  },
  startupCheck: async (config, options) => {
    try { assertOpenClawScopedAdmission(options.env ?? process.env, config); validate(config); await checkOpenClawGateway(config, options); }
    catch (error) {
      if (error instanceof OpenClawSetupError) throw new ConnectorSetupError(error.code, error.message);
      throw error;
    }
  },
  createBridge: (config, context) => {
    assertOpenClawScopedAdmission(context.env ?? process.env, config);
    validate(config);
    const { relayToken: _token, relayPort: _port, mcpWriteEnabled: _write, assetManifestPath: _manifest, ...base } = config;
    const current = runtimeSettings(base, context.env ?? process.env, config);
    const env = { ...(context.env ?? process.env), OPENCLAW_MCP_RELAY_TOKEN: current.relayToken,
      OPENCLAW_MCP_RELAY_PORT: current.relayPort, OPENCLAW_MCP_WRITE_ENABLED: current.mcpWriteEnabled ? 'true' : undefined,
      ENVOI_ASSET_MANIFEST_PATH: current.assetManifestPath };
    return createOpenClawBridge({ ...current, apiUrl: context.apiUrl, stateDir: context.stateDir }, { ...context, env });
  },
  describe: config => ({ gatewayUrl: config.gatewayUrl, agentId: config.agentId })
};
