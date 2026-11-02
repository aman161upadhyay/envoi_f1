import type { EnvoiConnector } from '../../sdk/typescript/src/connector';
import type { ConnectorRuntime } from '../../sdk/typescript/src/quick-connect';

export class ConnectorSetupError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'ConnectorSetupError'; }
}

export interface AdapterOptions {
  apiUrl?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: string;
  configPath?: string;
  profile?: string;
  agentId?: string;
  gatewayUrl?: string;
  prepareRuntime?: boolean;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}
export interface AdapterContext extends AdapterOptions {
  apiUrl: string;
  stateDir: string;
  pollIntervalMs?: number;
}
export interface RuntimeBridge {
  connector: EnvoiConnector;
  close(): Promise<void>;
  /** Actual tool invocation, not discovery; runs before setup is reported ready. */
  verify?(signal?: AbortSignal): Promise<void>;
}
export interface ConnectorAdapter<C = unknown> {
  runtime: ConnectorRuntime;
  discover(options: AdapterOptions, previous?: C): Promise<C>;
  preflight(config: C, options: AdapterOptions): Promise<void>;
  /** Restart-only, read-only readiness probe. Setup still uses the full model preflight. */
  startupCheck?(config: C, options: AdapterOptions): Promise<void>;
  /** Configure local tools after enrollment, before the runtime bridge starts. */
  configure?(config: C, context: AdapterContext): Promise<void>;
  createBridge(config: C, context: AdapterContext): Promise<RuntimeBridge>;
  /** Safe output only. Never include keys, configuration contents or provider bodies. */
  describe(config: C): Record<string, string>;
}
