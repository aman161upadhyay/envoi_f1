import { ConnectorSetupError, type AdapterOptions, type ConnectorAdapter } from '../connector/adapter';
import { createGrokBridge } from './runtime';
import path from 'node:path';
import { validateEnvoiMcpDestination } from './mcp-origin';

export interface GrokConfiguration {
  apiKey: string;
  model: string;
  mcpUrl?: string;
  assetManifestPath?: string;
}

const endpoint = 'https://api.x.ai/v1/responses';
const modelsEndpoint = 'https://api.x.ai/v1/models';
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

function validate(config: GrokConfiguration): void {
  if (!config || typeof config !== 'object' || Array.isArray(config)
      || Object.keys(config).some(key => !['apiKey', 'model', 'mcpUrl', 'assetManifestPath'].includes(key))) {
    throw new ConnectorSetupError('STATE_INVALID', 'The saved Grok configuration is invalid; preserve the private connection directory.');
  }
  if (!config.apiKey) throw new ConnectorSetupError('MODEL_CREDENTIAL_MISSING',
    'Grok needs an xAI model-provider credential. Set XAI_API_KEY privately on this host and retry. An Envoi enrollment token cannot replace it.');
  if (typeof config.apiKey !== 'string' || config.apiKey.length > 16_384 || /[\x00-\x20\x7f]/.test(config.apiKey)) {
    throw new ConnectorSetupError('MODEL_CREDENTIAL_INVALID', 'The local xAI credential is invalid. Set XAI_API_KEY privately on this host and retry.');
  }
  if (typeof config.model !== 'string' || !config.model.trim() || config.model !== config.model.trim()
    || config.model.length > 256 || /[\x00-\x1f\x7f]/.test(config.model)) {
    throw new ConnectorSetupError('MODEL_CONFIGURATION_INVALID', 'Set XAI_MODEL to a valid model name supported by your xAI account.');
  }
  if (config.mcpUrl !== undefined) {
    let target: URL;
    try { target = new URL(config.mcpUrl); } catch { throw new ConnectorSetupError('RUNTIME_CONFIGURATION_INVALID', 'ENVOI_MCP_URL must be an HTTPS /mcp endpoint or loopback HTTP /mcp endpoint.'); }
    if (typeof config.mcpUrl !== 'string' || /[\r\n\x00]/.test(config.mcpUrl) || target.pathname !== '/mcp'
        || target.username || target.password || target.search || target.hash
        || !(target.protocol === 'https:' || target.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(target.hostname))) {
      throw new ConnectorSetupError('RUNTIME_CONFIGURATION_INVALID', 'ENVOI_MCP_URL must be an HTTPS /mcp endpoint or loopback HTTP /mcp endpoint without embedded credentials.');
    }
  }
  if (config.assetManifestPath !== undefined && (typeof config.assetManifestPath !== 'string'
      || !path.isAbsolute(config.assetManifestPath) || /[\x00-\x1f\x7f]/.test(config.assetManifestPath))) {
    throw new ConnectorSetupError('RUNTIME_CONFIGURATION_INVALID', 'The saved approved asset manifest path must be an absolute local path.');
  }
}

export async function discoverGrok(options: AdapterOptions = {}, previous?: GrokConfiguration): Promise<GrokConfiguration> {
  const env = options.env ?? process.env;
  if (previous !== undefined) validate(previous);
  const mcpUrl = env.ENVOI_MCP_URL ?? previous?.mcpUrl;
  const manifest = env.ENVOI_ASSET_MANIFEST_PATH ?? previous?.assetManifestPath;
  const config = {
    apiKey: env.XAI_API_KEY ?? previous?.apiKey ?? '',
    model: env.XAI_MODEL ?? previous?.model ?? 'grok-4.7',
    ...(mcpUrl ? { mcpUrl } : {}),
    ...(manifest ? { assetManifestPath: path.resolve(manifest) } : {})
  };
  validate(config);
  return config;
}

/** A harmless, bounded model call is required before an enrollment token is consumed. */
export async function preflightGrok(config: GrokConfiguration, options: AdapterOptions = {}): Promise<void> {
  validate(config);
  if (config.mcpUrl && options.apiUrl) {
    try { validateEnvoiMcpDestination(options.apiUrl, config.mcpUrl); }
    catch { throw new ConnectorSetupError('RUNTIME_CONFIGURATION_INVALID',
      'ENVOI_MCP_URL must use the selected Envoi origin /mcp. Correct it before enrollment.'); }
  }
  if (options.signal?.aborted) throw new ConnectorSetupError('MODEL_TEST_FAILED', 'Grok connection test was canceled before enrollment.');
  const controller = new AbortController();
  const signal = controller.signal;
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, 60_000);
  const timeoutError = () => new ConnectorSetupError('MODEL_TEST_FAILED',
    'Grok connection test was canceled or timed out before enrollment. Check model-provider availability and retry.');
  let rejectCanceled: () => void = () => {};
  const canceled = new Promise<never>((_, reject) => {
    rejectCanceled = () => reject(timeoutError());
    signal.addEventListener('abort', rejectCanceled, { once: true });
  });
  try { await Promise.race([canceled, (async () => {
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(endpoint, {
        method: 'POST', redirect: 'error', signal,
        headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: config.model, store: false, max_output_tokens: 32,
          input: 'Envoi connection test. Reply with a brief confirmation only. Do not use tools or perform external actions.' })
      });
    } catch {
      throw new ConnectorSetupError('PROVIDER_UNREACHABLE', 'The xAI model provider could not be reached. Check host networking and retry before enrollment.');
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => {});
      throw new ConnectorSetupError('PROVIDER_AUTH_FAILED', 'xAI authentication failed. Check the local XAI_API_KEY and account access before enrollment.');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new ConnectorSetupError(response.status === 429 || response.status >= 500 ? 'PROVIDER_UNREACHABLE' : 'MODEL_TEST_FAILED', `The xAI model test failed with HTTP ${response.status}. Check XAI_MODEL, account quota and provider health before enrollment.`);
    }
    // Bound the provider body as well as the output request; never include it in diagnostics.
    const reader = response.body?.getReader();
    if (!reader) throw new ConnectorSetupError('MODEL_TEST_FAILED', 'The xAI model test returned an empty response before enrollment.');
    const chunks: Uint8Array[] = [];
    let length = 0;
    const cancelReader = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', cancelReader, { once: true });
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.byteLength;
        if (length > 1_000_000) {
          await reader.cancel().catch(() => {});
          throw new Error('response too large');
        }
        chunks.push(next.value);
      }
      const data = record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const hasText = Array.isArray(data.output) && data.output.some(item => {
        const message = record(item);
        return message.type === 'message' && Array.isArray(message.content)
          && message.content.some(part => record(part).type === 'output_text'
            && typeof record(part).text === 'string' && (record(part).text as string).trim());
      });
      if (data.status !== 'completed' || !hasText) throw new Error('incomplete response');
    } catch {
      throw new ConnectorSetupError('MODEL_TEST_FAILED', 'The xAI model test did not return a completed text reply. Check the selected model and retry before enrollment.');
    } finally { signal.removeEventListener('abort', cancelReader); reader.releaseLock(); }
  })()]); }
  finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
    signal.removeEventListener('abort', rejectCanceled);
  }
}

/** Existing enrollment uses an authenticated catalog probe instead of another inference request on restart. */
export async function checkGrokProvider(config: GrokConfiguration, options: AdapterOptions = {}): Promise<void> {
  validate(config);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(modelsEndpoint, { method: 'GET', redirect: 'error',
      headers: { authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(10_000)]) });
  } catch { throw new ConnectorSetupError('PROVIDER_UNREACHABLE', 'The xAI provider is unavailable; retrying the saved connection.'); }
  await response.body?.cancel().catch(() => {});
  if (response.status === 401 || response.status === 403) throw new ConnectorSetupError('PROVIDER_AUTH_FAILED', 'xAI rejected the saved model credential. Check it privately on this host.');
  if (response.status === 429 || response.status >= 500) throw new ConnectorSetupError('PROVIDER_UNREACHABLE', 'The xAI provider is temporarily unavailable; retrying.');
  if (!response.ok) throw new ConnectorSetupError('MODEL_TEST_FAILED', 'The xAI model catalog check failed. Check the saved provider configuration.');
}

export const grokAdapter: ConnectorAdapter<GrokConfiguration> = {
  runtime: 'grok',
  discover: discoverGrok,
  preflight: preflightGrok,
  startupCheck: checkGrokProvider,
  createBridge: async (config, context) => {
    const current = await discoverGrok(context, config);
    return createGrokBridge({ ...current, apiUrl: context.apiUrl, stateDir: context.stateDir }, context);
  },
  describe: config => ({ provider: 'xAI', model: config.model })
};
