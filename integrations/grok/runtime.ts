import { EnvoiConnector, type ConnectorOptions } from '../../sdk/typescript/src/connector';
import { bridgeHandler } from '../agent-bridges/bridge';
import { loadAssetManifest, manifestAssetExchange } from '../agent-bridges/asset-manifest';
import { FileBridgeStore } from '../agent-bridges/file-store';
import { xaiTurn } from '../agent-bridges/providers';
import { scopedTurnHandler } from '../agent-bridges/scoped-turn';
import { xaiScopedTurn } from './scoped-turn';
import { FileScopedRunStore } from './scoped-store';
import { validateEnvoiMcpDestination } from './mcp-origin';

export interface GrokBridgeConfiguration {
  apiUrl: string;
  stateDir: string;
  apiKey: string;
  model: string;
  mcpUrl?: string;
  assetManifestPath?: string;
}

/** Manual setup and the unified installer use the same durable claim/reply pipeline. */
export async function createGrokBridge(config: GrokBridgeConfiguration,
  options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; pollIntervalMs?: number } = {}) {
  const env = options.env ?? process.env;
  const store = new FileBridgeStore(config.stateDir);
  await store.init();
  if (!await store.load()) throw new Error('No connector credentials were saved. Run setup first');
  if (env.ENVOI_SCOPED_TOOLS !== undefined && env.ENVOI_SCOPED_TOOLS !== 'true' && env.ENVOI_SCOPED_TOOLS !== 'false') {
    throw new TypeError('ENVOI_SCOPED_TOOLS must be true or false');
  }
  if (env.ENVOI_SCOPED_TOOLS === 'true') {
    const runs = new FileScopedRunStore(config.stateDir);
    const connector = new EnvoiConnector(config.apiUrl, store, {
      ...(options.fetch ? { fetch: options.fetch } : {}),
      caseSessionHandler: scopedTurnHandler({
        admit: message => store.admit(message),
        run: xaiScopedTurn({ apiKey: config.apiKey, model: config.model, store: runs, fetch: options.fetch }),
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
  let connector: EnvoiConnector;
  const approvedAssets = await loadAssetManifest(config.assetManifestPath ?? env.ENVOI_ASSET_MANIFEST_PATH);
  const mcpUrl = config.mcpUrl ?? env.ENVOI_MCP_URL;
  if (mcpUrl) validateEnvoiMcpDestination(config.apiUrl, mcpUrl);
  const turn = xaiTurn({
    apiKey: config.apiKey, model: config.model,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    history: async (caseId, group) => group ? (await connector.getGroupCase(caseId)).messages : connector.listCaseMessages(caseId, 20),
    assetHandles: [...approvedAssets.values()].map(({ handle, filename }) => ({ handle, filename })),
    ...(mcpUrl ? { mcp: {
      serverUrl: mcpUrl,
      // Only the five-minute, case-scoped read token goes to the provider.
      accessToken: async caseId => (await connector.mintMcpReadToken(caseId)).mcpAccessToken
    } } : {})
  });
  const connectorOptions: ConnectorOptions = {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.pollIntervalMs ? { pollIntervalMs: options.pollIntervalMs } : {}),
    handler: bridgeHandler(store, turn, approvedAssets.size
      ? (message, reply, key, signal) => manifestAssetExchange(approvedAssets, connector)(message, reply, key, signal) : undefined)
  };
  connector = new EnvoiConnector(config.apiUrl, store, connectorOptions);
  return { connector, store, close: async () => {} };
}
