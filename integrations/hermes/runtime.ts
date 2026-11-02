import { EnvoiConnector, type WorkMessage } from '../../sdk/typescript/src/connector';
import { bridgeHandler, mcpReplyMessageId, withRecordedMcpReply } from '../agent-bridges/bridge';
import { loadAssetManifest, manifestAssetExchange } from '../agent-bridges/asset-manifest';
import { FileBridgeStore } from '../agent-bridges/file-store';
import { startMcpRelay } from '../agent-bridges/mcp-relay';
import { HermesRunStore } from './run-store';
import { hermesTurn } from './turn';
import { authorizedHermesWrite } from './lease-write';
import { createScopedHermesBridge, selectScopedHermes, type HermesRuntimeConfiguration } from './scoped-runtime';
import type { ScopedRuntimeObserver } from '../agent-bridges/runtime-events';

export interface HermesBridgeConfiguration {
  apiUrl: string;
  stateDir: string;
  hermesUrl: string;
  hermesKey: string;
  relayToken?: string;
  relayPort?: number;
  writeEnabled?: boolean;
  runtime?: HermesRuntimeConfiguration;
}

/** Shared by the existing manual bridge and the unified installer. Recovery stays intact. */
export async function createHermesBridge(config: HermesBridgeConfiguration,
  options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; pollIntervalMs?: number; onSuccessfulToolCall?: (name: string) => void;
    timeoutMs?: number; pollMs?: number; onRuntimeEvent?: ScopedRuntimeObserver;
    beforeNativeSubmit?: import('./native-binding').NativeSubmissionGuard;
    beforeScopedTurn?: import('./native-binding').ScopedPreparationGuard;
    nativeRequestGate?: import('./request-gate-attestation').NativeRequestGateExpectation } = {}) {
  const env = options.env ?? process.env;
  const scoped = await selectScopedHermes({ env, stateDir: config.stateDir }, config.runtime);
  if (scoped) {
    if (config.relayToken !== undefined || config.relayPort !== undefined || config.writeEnabled !== undefined) throw new Error('Scoped Hermes refuses legacy relay and write options');
    return createScopedHermesBridge({ apiUrl: config.apiUrl, stateDir: config.stateDir, runtime: scoped }, options);
  }
  const store = new FileBridgeStore(config.stateDir);
  await store.init();
  const session = await store.load();
  if (!session) throw new Error('Envoi enrollment did not create a connector session');
  const approvedAssets = await loadAssetManifest(env.ENVOI_ASSET_MANIFEST_PATH);
  let active: { message: WorkMessage; signal: AbortSignal } | null = null;
  let connector: EnvoiConnector;
  const provider = hermesTurn({
    apiUrl: config.hermesUrl, apiKey: config.hermesKey, agentId: session.agentId,
    runs: new HermesRunStore(config.stateDir), replies: store,
    fetch: options.fetch, allowEnvoiMcpWrites: config.writeEnabled,
    mcpReplySent: config.writeEnabled ? id => store.mcpReplySent(id) : undefined,
    assetHandles: [...approvedAssets.values()].map(({ handle, filename }) => ({ handle, filename })),
    history: caseId => connector.listCaseMessages(caseId, 20),
    onActive(message, signal) { active = signal ? { message, signal } : null; }
  });
  const turn = config.writeEnabled ? withRecordedMcpReply(provider, id => store.mcpReplySent(id)) : provider;
  connector = new EnvoiConnector(config.apiUrl, store, {
    fetch: options.fetch, pollIntervalMs: options.pollIntervalMs,
    handler: bridgeHandler(store, turn, approvedAssets.size
      ? (message, reply, key, signal) => manifestAssetExchange(approvedAssets, connector)(message, reply, key, signal) : undefined)
  });
  const relay = config.relayToken ? await startMcpRelay({
    connector, bearerToken: config.relayToken, port: config.relayPort ?? 8789,
    allowCollaborationWrites: config.writeEnabled,
    collaborationToolNames: ['envoi_start_case', 'envoi_send_message', 'envoi_send_proposal', 'envoi_send_decision'],
    authorizeWrite: (name, args) => authorizedHermesWrite(active, name, args),
    onSuccessfulToolCall: options.onSuccessfulToolCall,
    onSuccessfulWrite: async (name, args) => { const id = mcpReplyMessageId(name, args); if (id) await store.markMcpReplySent(id); }
  }) : null;
  return { connector, store, relayUrl: relay?.url, close: async () => { await relay?.close(); } };
}
