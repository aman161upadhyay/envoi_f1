import { isHumanInstructionMessage, EnvoiConnector, type ConnectorOptions } from '../../sdk/typescript/src/connector';
import { bridgeHandler } from '../agent-bridges/bridge';
import { loadAssetManifest, manifestAssetExchange } from '../agent-bridges/asset-manifest';
import { FileBridgeStore } from '../agent-bridges/file-store';
import { startOpenClawMcpRelay } from './mcp-relay';
import { mcpReplyMessageId, openClawTurn, withRecordedMcpReply } from './turn';
import { openClawRuntimeEnvironment, saveOpenClawScopedMode } from './scoped-admission';
import { scopedTurnHandler } from '../agent-bridges/scoped-turn';
import { FileScopedRunStore } from '../grok/scoped-store';
import { openClawScopedTurn } from './scoped-turn';
import { guardScopedPreparation,type ScopedPreparationGuard } from '../hermes/native-binding';

export interface BridgeConfiguration {
  apiUrl: string;
  stateDir: string;
  gatewayUrl: string;
  gatewayToken: string;
  agentId: string;
  scopedTools?: true;
}

/** Legacy setup and Quick Connect share the durable work and reply implementation. */
export async function createOpenClawBridge(config: BridgeConfiguration, options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; pollIntervalMs?: number;beforeScopedTurn?:ScopedPreparationGuard } = {}) {
  const env = await openClawRuntimeEnvironment(config.stateDir, options.env ?? process.env, config);
  if (env.ENVOI_SCOPED_TOOLS === 'true') {
    const store = new FileBridgeStore(config.stateDir);
    await store.init();
    if (!await store.load()) throw new Error('No connector credentials were saved. Run setup first');
    await saveOpenClawScopedMode(config.stateDir, env);
    const runs = new FileScopedRunStore(config.stateDir);
    const connector = new EnvoiConnector(config.apiUrl, store, {
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.pollIntervalMs ? { pollIntervalMs: options.pollIntervalMs } : {}),
      caseSessionHandler: scopedTurnHandler({
        admit: message => store.admit(message),
        run: async(turn,host)=>{await guardScopedPreparation(options.beforeScopedTurn,host.workId,turn.signal);
          return openClawScopedTurn({ gatewayUrl: config.gatewayUrl, gatewayToken: config.gatewayToken, agentId: config.agentId, store: runs, fetch: options.fetch })(turn,host);},
        async beforeEndTurn(host) {
          if (!host.workId) throw new Error('Scoped runtime needs trusted work identity');
          const record = await runs.load(host.workId);
          if (!record) throw new Error('Scoped turn journal is missing');
          await runs.save({ ...record, completed: true, pending: [] });
        }
      })
    });
    return { connector, store, close: async () => {} };
  }
  const relayToken = env.OPENCLAW_MCP_RELAY_TOKEN;
  if (env.OPENCLAW_MCP_RELAY_PORT && !relayToken) throw new Error('OPENCLAW_MCP_RELAY_TOKEN is required when the relay port is configured');
  if (env.OPENCLAW_MCP_WRITE_ENABLED && env.OPENCLAW_MCP_WRITE_ENABLED !== 'true') throw new Error('OPENCLAW_MCP_WRITE_ENABLED must be true when set');
  if (env.OPENCLAW_MCP_WRITE_ENABLED && !relayToken) throw new Error('OPENCLAW_MCP_RELAY_TOKEN is required for MCP writes');
  const store = new FileBridgeStore(config.stateDir);
  await store.init();
  if (!await store.load()) throw new Error('No connector credentials were saved. Run setup first');
  let connector: EnvoiConnector;
  const approvedAssets = await loadAssetManifest(env.ENVOI_ASSET_MANIFEST_PATH);
  const writeEnabled = env.OPENCLAW_MCP_WRITE_ENABLED === 'true';
  const gatewayTurn = openClawTurn({
    gatewayUrl: config.gatewayUrl, gatewayToken: config.gatewayToken, agentId: config.agentId,
    allowEnvoiMcpWrites: writeEnabled,
    assetHandles: [...approvedAssets.values()].map(({ handle, filename }) => ({ handle, filename })),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    history: caseId => connector.listCaseMessages(caseId, 20)
  });
  const turn = writeEnabled ? withRecordedMcpReply(gatewayTurn, messageId => store.mcpReplySent(messageId)) : gatewayTurn;
  let humanWorkActive = false;
  const handler = bridgeHandler(store, turn, approvedAssets.size
    ? (message, reply, key, signal) => manifestAssetExchange(approvedAssets, connector)(message, reply, key, signal) : undefined);
  const connectorOptions: ConnectorOptions = {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.pollIntervalMs ? { pollIntervalMs: options.pollIntervalMs } : {}),
    handler: {
      admit: message => handler.admit(message),
      async process(message, context) {
        humanWorkActive = isHumanInstructionMessage(message);
        try { await handler.process(message, context); }
        finally { humanWorkActive = false; }
      }
    }
  };
  connector = new EnvoiConnector(config.apiUrl, store, connectorOptions);
  const relay = relayToken ? await startOpenClawMcpRelay({
    connector, bearerToken: relayToken,
    port: env.OPENCLAW_MCP_RELAY_PORT ? Number(env.OPENCLAW_MCP_RELAY_PORT) : 8788,
    allowCollaborationWrites: writeEnabled,
    authorizeWrite: async (name, args) => {
      if (humanWorkActive) return false;
      const messageId = mcpReplyMessageId(name, args);
      return !messageId || !await store.isHumanInstruction(messageId);
    },
    ...(writeEnabled ? { onSuccessfulWrite: async (name: string, args: Record<string, unknown>) => {
      const messageId = mcpReplyMessageId(name, args);
      if (messageId) await store.markMcpReplySent(messageId);
    } } : {})
  }) : null;
  return { connector, store, close: async () => { await relay?.close(); } };
}
