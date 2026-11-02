import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertOpenClawScopedAdmission } from './scoped-admission';

/** Trusted local diagnostic. Never construct this class from an upstream response body. */
export class OpenClawSetupError extends Error {
  constructor(message: string, public readonly code: 'GATEWAY_TEST_FAILED' | 'GATEWAY_UNREACHABLE' | 'GATEWAY_AUTH_FAILED' = 'GATEWAY_TEST_FAILED') {
    super(message); this.name = 'OpenClawSetupError';
  }
}

export interface OpenClawConfiguration {
  gatewayUrl: string;
  gatewayToken: string;
  agentId: string;
  configPath: string;
  /** Undefined when using explicit connection settings without a local config. */
  chatCompletionsEnabled: boolean | undefined;
  responsesEnabled?: boolean;
  scopedTools?: true;
}

export interface DiscoverOpenClawOptions {
  env?: Record<string, string | undefined>;
  homeDir?: string;
  configPath?: string;
  profile?: string;
  gatewayUrl?: string;
  gatewayToken?: string;
  agentId?: string;
  readFile?: (path: string) => Promise<string>;
  /** Resume a saved explicit connection when its original optional config is absent. */
  allowMissingConfig?: boolean;
  /** Missing-file recovery and same-origin env secret recovery; fresh resolved settings win. */
  fallbackConfiguration?: OpenClawConfiguration;
}

const safeId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const envId = /^[A-Za-z_][A-Za-z0-9_]*$/;
const authHelp = 'Envoi needs a Gateway credential: set gateway.auth.mode to "token" with gateway.auth.token (or OPENCLAW_GATEWAY_TOKEN), or to "password" with gateway.auth.password, restart the Gateway, and retry. This check did not redeem an enrollment token.';
const endpointHelp = 'Enable gateway.http.endpoints.chatCompletions.enabled in the active OpenClaw configuration, restart the Gateway, and retry the connector. This check did not redeem an enrollment token.';
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** A data-only JSON5 subset: comments, quoted/unquoted keys, single quotes and trailing commas. */
function parseConfig(source: string): Record<string, unknown> {
  if (source.length > 2_000_000) throw new Error('configuration size');
  let i = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  const fail = (): never => { throw new Error('configuration syntax'); };
  const skip = () => {
    while (i < source.length) {
      if (/\s/.test(source[i])) { i++; continue; }
      if (source.slice(i, i + 2) === '//') { i += 2; while (i < source.length && !/[\r\n]/.test(source[i])) i++; continue; }
      if (source.slice(i, i + 2) === '/*') { const end = source.indexOf('*/', i + 2); if (end < 0) fail(); i = end + 2; continue; }
      break;
    }
  };
  const string = (): string => {
    const quote = source[i++];
    let result = '';
    while (i < source.length) {
      const char = source[i++];
      if (char === quote) return result;
      if (char === '\n' || char === '\r') fail();
      if (char !== '\\') { result += char; continue; }
      const escaped = source[i++];
      const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0', '"': '"', "'": "'", '\\': '\\', '/': '/' };
      if (escaped === 'u' || escaped === 'x') {
        const length = escaped === 'u' ? 4 : 2;
        const hex = source.slice(i, i + length);
        if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(hex)) fail();
        result += String.fromCharCode(parseInt(hex, 16)); i += length;
      } else if (escaped === '\n') { /* JSON5 line continuation */ }
      else if (escaped === '\r') { if (source[i] === '\n') i++; }
      else if (escaped in escapes) result += escapes[escaped];
      else fail();
    }
    return fail();
  };
  const value = (depth = 0): unknown => {
    if (depth > 64) fail();
    skip();
    const char = source[i];
    if (char === '"' || char === "'") return string();
    if (char === '{' || char === '[') {
      const object = char === '{';
      const result: Record<string, unknown> | unknown[] = object ? Object.create(null) : [];
      const end = object ? '}' : ']';
      i++; skip();
      while (source[i] !== end) {
        if (object) {
          let key: string;
          if (source[i] === '"' || source[i] === "'") key = string();
          else { const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(i)); if (!match) return fail(); key = match[0]; i += key.length; }
          skip(); if (source[i++] !== ':') fail();
          if (Object.hasOwn(result, key)) fail();
          (result as Record<string, unknown>)[key] = value(depth + 1);
        } else (result as unknown[]).push(value(depth + 1));
        skip(); if (source[i] === end) break;
        if (source[i++] !== ',') fail();
        skip();
      }
      i++; return result;
    }
    const literal = /^(?:true|false|null)(?![A-Za-z0-9_$])/.exec(source.slice(i));
    if (literal) { i += literal[0].length; return JSON.parse(literal[0]); }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(i));
    if (number) { i += number[0].length; const parsed = Number(number[0]); if (!Number.isFinite(parsed)) fail(); return parsed; }
    return fail();
  };
  const parsed = value(); skip();
  if (i !== source.length || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail();
  return parsed as Record<string, unknown>;
}

function origin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new OpenClawSetupError('OpenClaw Gateway URL must be an HTTPS origin or loopback HTTP origin.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new OpenClawSetupError('OpenClaw Gateway requires HTTPS or loopback HTTP. Set OPENCLAW_GATEWAY_URL to its private origin.');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || /[\r\n\t\\]/.test(value)) throw new OpenClawSetupError('OpenClaw Gateway URL must be an origin without credentials, query, fragment, or path.');
  return url.origin;
}

type SecretKind = 'token' | 'password';
const secretEnv = (kind: SecretKind) => kind === 'token' ? 'OPENCLAW_GATEWAY_TOKEN' : 'OPENCLAW_GATEWAY_PASSWORD';

function tokenValue(value: unknown, env: Record<string, string | undefined>, kind: SecretKind = 'token'): string {
  const name = secretEnv(kind);
  if (typeof value === 'string') {
    const expanded = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, variable: string) => {
      if (!env[variable]) throw new OpenClawSetupError(`OpenClaw Gateway ${kind} references an unavailable environment variable. Run setup with the Gateway environment or set ${name} locally.`);
      return env[variable]!;
    });
    if (expanded.includes('${')) throw new OpenClawSetupError(`OpenClaw Gateway ${kind} could not be resolved. Set ${name} locally.`);
    return expanded;
  }
  const ref = record(value);
  if (ref.source === 'env' && typeof ref.id === 'string' && envId.test(ref.id)) {
    const resolved = env[ref.id];
    if (resolved) return resolved;
    throw new OpenClawSetupError(`OpenClaw Gateway env secret is unavailable. Run setup with the Gateway environment or set ${name} locally.`);
  }
  if (value !== undefined) throw new OpenClawSetupError(`OpenClaw Gateway uses an unsupported secret reference. Resolve it through your local secret manager and set ${name} locally; do not paste it into chat.`);
  throw new OpenClawSetupError(`OpenClaw Gateway ${kind} was not found. Run setup on the Gateway host with its environment or set ${name} locally.`);
}

function validate(config: Pick<OpenClawConfiguration, 'gatewayUrl' | 'gatewayToken' | 'agentId'>): string {
  const url = origin(config.gatewayUrl);
  if (!config.gatewayToken || config.gatewayToken.trim() !== config.gatewayToken || /[\x00-\x20\x7f]/.test(config.gatewayToken) || config.gatewayToken.length > 16_384) throw new OpenClawSetupError('OpenClaw Gateway token is missing or invalid. Set OPENCLAW_GATEWAY_TOKEN locally.');
  if (!safeId.test(config.agentId)) throw new OpenClawSetupError('OpenClaw agent ID is invalid. Set OPENCLAW_AGENT_ID to a configured agent ID.');
  return url;
}

/** Read local connection settings only. Provider secrets never leave the host. */
export async function discoverOpenClaw(options: DiscoverOpenClawOptions = {}): Promise<OpenClawConfiguration> {
  const env = assertOpenClawScopedAdmission(options.env ?? process.env, options.fallbackConfiguration);
  const home = options.homeDir ?? env.OPENCLAW_HOME ?? homedir();
  const profile = options.profile ?? env.OPENCLAW_PROFILE;
  if (profile && !safeId.test(profile)) throw new OpenClawSetupError('OpenClaw profile is invalid. Specify its OPENCLAW_CONFIG_PATH directly.');
  const expand = (path: string) => resolve(path === '~' ? home : path.startsWith('~/') || path.startsWith('~\\') ? join(home, path.slice(2)) : path);
  const explicitPath = options.configPath ?? env.OPENCLAW_CONFIG_PATH;
  const configPath = expand(explicitPath ?? join(expand(env.OPENCLAW_STATE_DIR ?? join(home, profile ? `.openclaw-${profile}` : '.openclaw')), 'openclaw.json'));
  let config: Record<string, unknown> | undefined;
  let fallback: OpenClawConfiguration | undefined;
  try {
    const source = await (options.readFile ?? (path => readFile(path, 'utf8')))(configPath);
    try { config = parseConfig(source); }
    catch { throw new OpenClawSetupError('OpenClaw configuration could not be parsed safely. Use JSON or JSON5 comments, quoted strings, simple keys and trailing commas; otherwise supply explicit Gateway settings.'); }
  } catch (error) {
    if (record(error).code !== 'ENOENT') {
      if (error instanceof OpenClawSetupError) throw error;
      throw new OpenClawSetupError('OpenClaw configuration could not be read. Check OPENCLAW_CONFIG_PATH and local file permissions.');
    }
    if (options.allowMissingConfig && options.fallbackConfiguration) {
      const fallbackOrigin = validate(options.fallbackConfiguration);
      const selectedUrl = options.gatewayUrl ?? env.OPENCLAW_GATEWAY_URL;
      if (selectedUrl && origin(selectedUrl) !== fallbackOrigin && !(options.gatewayToken ?? env.OPENCLAW_GATEWAY_TOKEN)) {
        throw new OpenClawSetupError('Changing the saved Gateway origin requires its own explicit local Gateway credential. Set OPENCLAW_GATEWAY_TOKEN for the selected Gateway.');
      }
      fallback = options.fallbackConfiguration;
    }
    const completeOverrides = (options.gatewayUrl ?? env.OPENCLAW_GATEWAY_URL ?? fallback?.gatewayUrl) &&
      (options.gatewayToken ?? env.OPENCLAW_GATEWAY_TOKEN ?? fallback?.gatewayToken) && (options.agentId ?? env.OPENCLAW_AGENT_ID ?? fallback?.agentId);
    if (options.allowMissingConfig && !completeOverrides) {
      throw new OpenClawSetupError('Resuming without an OpenClaw config requires explicit Gateway URL, Gateway token and agent ID. Supply all three connection settings locally.');
    }
    if (explicitPath && !(options.allowMissingConfig && completeOverrides)) {
      throw new OpenClawSetupError('OpenClaw configuration was not found at OPENCLAW_CONFIG_PATH. Check the active Gateway profile and retry.');
    }
  }
  const gateway = record(config?.gateway);
  const auth = record(gateway.auth);
  // Select the credential for the active mode, including when stale token
  // settings coexist with a password in the Gateway's environment.
  const hasPassword = auth.password !== undefined || !!env.OPENCLAW_GATEWAY_PASSWORD;
  const mode = auth.mode ?? (hasPassword ? 'password' : 'token');
  const secretKind: SecretKind = mode === 'token' ? 'token' : 'password';
  const overrideUrl = options.gatewayUrl ?? env.OPENCLAW_GATEWAY_URL ?? fallback?.gatewayUrl;
  const overrideToken = options.gatewayToken ?? env[secretEnv(secretKind)] ?? fallback?.gatewayToken;
  if (config?.$include !== undefined && (!overrideUrl || !overrideToken || !(options.agentId ?? env.OPENCLAW_AGENT_ID))) throw new OpenClawSetupError('OpenClaw config includes other files. Supply explicit OPENCLAW_GATEWAY_URL, OPENCLAW_GATEWAY_TOKEN and OPENCLAW_AGENT_ID from the active Gateway, or select its resolved configuration.');
  if (gateway.mode === 'remote' && (!overrideUrl || !overrideToken)) throw new OpenClawSetupError('OpenClaw uses a remote Gateway. Set OPENCLAW_GATEWAY_URL to the private HTTPS origin and OPENCLAW_GATEWAY_TOKEN to that Gateway credential locally.');
  // Gateway HTTP endpoints accept the token or password as a Bearer value; trusted-proxy
  // admits same-host clients only through its password fallback.
  if (mode === 'none') throw new OpenClawSetupError(`OpenClaw Gateway authentication is disabled (gateway.auth.mode is "none"). ${authHelp}`);
  if (!overrideToken) {
    if (mode === 'trusted-proxy' && !hasPassword) throw new OpenClawSetupError(`OpenClaw Gateway uses trusted-proxy authentication without a local password, so this host cannot connect directly. Set gateway.auth.password (or OPENCLAW_GATEWAY_PASSWORD) for same-host clients, restart the Gateway, and retry. This check did not redeem an enrollment token.`);
    if (!['token', 'password', 'trusted-proxy'].includes(String(mode))) throw new OpenClawSetupError(`OpenClaw Gateway authentication mode is not supported. ${authHelp}`);
  }
  const port = env.OPENCLAW_GATEWAY_PORT === undefined ? gateway.port ?? (profile === 'dev' ? 19001 : 18789) : Number(env.OPENCLAW_GATEWAY_PORT);
  if (!overrideUrl && !gateway.url && (!Number.isSafeInteger(port) || Number(port) < 1 || Number(port) > 65535)) throw new OpenClawSetupError('OpenClaw Gateway port is invalid. Set OPENCLAW_GATEWAY_URL to the active Gateway origin.');
  const gatewayUrl = origin(overrideUrl ?? (typeof gateway.url === 'string' ? gateway.url : `http://127.0.0.1:${port}`));
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(gatewayUrl).hostname) && (!overrideUrl || !overrideToken)) {
    throw new OpenClawSetupError('A remote Gateway requires its own explicit OPENCLAW_GATEWAY_URL and OPENCLAW_GATEWAY_TOKEN. Local discovered credentials cannot be forwarded to a remote host.');
  }
  const agents = record(config?.agents);
  const entries = record(agents.entries);
  const legacy = Array.isArray(agents.list) ? agents.list : [];
  const ids = Object.keys(entries).length ? Object.keys(entries) : legacy.map(item => record(item).id);
  if (ids.some(id => typeof id !== 'string' || !safeId.test(id))) throw new OpenClawSetupError('OpenClaw config contains an invalid agent ID. Repair the agent roster before setup.');
  const knownIds = [...new Set(ids as string[])];
  let agentId = options.agentId ?? env.OPENCLAW_AGENT_ID ?? fallback?.agentId;
  if (!agentId && knownIds.length > 1) throw new OpenClawSetupError(`Choose the agent to connect by setting OPENCLAW_AGENT_ID. Available agents: ${knownIds.join(', ')}.`);
  agentId ??= knownIds[0] ?? 'main';
  if (knownIds.length && !knownIds.includes(agentId)) throw new OpenClawSetupError(`The selected OpenClaw agent is not configured. Set OPENCLAW_AGENT_ID to one of: ${knownIds.join(', ')}.`);
  const localEndpoint = record(record(record(gateway.http).endpoints).chatCompletions).enabled === true;
  const localResponses = record(record(record(gateway.http).endpoints).responses).enabled === true;
  let gatewayToken: string;
  // gatewayToken holds whichever shared secret the Gateway accepts as a Bearer value.
  const configured = auth[secretKind] ?? (secretKind === 'password' ? env.OPENCLAW_GATEWAY_PASSWORD : undefined);
  try { gatewayToken = tokenValue(overrideToken ?? configured, env, overrideToken ? 'token' : secretKind); }
  catch (error) {
    const ref = record(configured);
    const supportedEnvReference = typeof configured === 'string'
      ? configured.includes('${') && !configured.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, '').includes('${')
      : ref.source === 'env' && typeof ref.id === 'string' && envId.test(ref.id);
    // User services may not inherit the shell that originally resolved a secret.
    // Recover its saved value only for the identical, previously paired local origin.
    const prior = options.allowMissingConfig ? options.fallbackConfiguration : undefined;
    if (overrideToken || !supportedEnvReference || !prior || origin(prior.gatewayUrl) !== gatewayUrl) throw error;
    gatewayToken = prior.gatewayToken;
  }
  const result = { gatewayUrl, gatewayToken, agentId, configPath, chatCompletionsEnabled: config && !overrideUrl ? localEndpoint : undefined,
    ...(config && !overrideUrl && env.ENVOI_SCOPED_TOOLS === 'true' ? { responsesEnabled: localResponses } : {}),
    ...(env.ENVOI_SCOPED_TOOLS === 'true' ? { scopedTools: true as const } : {}) };
  validate(result);
  return result;
}

/** Restart readiness does not start an agent turn or spend a model call. */
export async function checkOpenClawGateway(config: OpenClawConfiguration,
  options: { fetch?: typeof fetch; signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {}): Promise<void> {
  assertOpenClawScopedAdmission(options.env ?? process.env, config);
  const url = validate(config);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${url}/readyz`, { method: 'GET', redirect: 'error',
      headers: { authorization: `Bearer ${config.gatewayToken}` },
      signal: AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(10_000)]) });
  } catch {
    throw new OpenClawSetupError('The selected OpenClaw Gateway is unavailable; retrying the saved origin.', 'GATEWAY_UNREACHABLE');
  }
  // A broken, unrelated chat channel can make /readyz return 503 while the
  // agent runtime remains admissible. Authenticated probes expose coreReady.
  const body = response.status === 503 ? await response.json().catch(() => null) : null;
  await response.body?.cancel().catch(() => {});
  if (response.status === 401 || response.status === 403) throw new OpenClawSetupError('The selected OpenClaw Gateway rejected its saved credential.', 'GATEWAY_AUTH_FAILED');
  if (response.status === 503 && body && typeof body === 'object' && 'coreReady' in body && body.coreReady === true) return;
  if (response.status === 429 || response.status >= 500) throw new OpenClawSetupError('The selected OpenClaw Gateway is not ready; retrying.', 'GATEWAY_UNREACHABLE');
  if (!response.ok) throw new OpenClawSetupError('The selected OpenClaw Gateway does not expose the expected readiness check.', 'GATEWAY_TEST_FAILED');
}

/** Require a complete harmless agent turn before consuming the enrollment token. */
export async function preflightOpenClaw(config: OpenClawConfiguration, options: { fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<void> {
  const env = assertOpenClawScopedAdmission(options.env ?? process.env, config);
  const scoped = env.ENVOI_SCOPED_TOOLS === 'true';
  const selectedEndpointHelp = scoped
    ? 'Enable gateway.http.endpoints.responses.enabled in the selected OpenClaw profile and retry. This check did not redeem an enrollment token.'
    : endpointHelp;
  const url = validate(config);
  if (scoped ? config.responsesEnabled === false : config.chatCompletionsEnabled === false) throw new OpenClawSetupError(selectedEndpointHelp);
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new OpenClawSetupError('OpenClaw preflight timeout must be from 1 to 300000 milliseconds.');
  if (options.signal?.aborted) throw new OpenClawSetupError('OpenClaw connection test was canceled. This check did not redeem an enrollment token.');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, timeoutMs);
  const canceled = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new OpenClawSetupError(
    'OpenClaw connection test was canceled or timed out. This check did not redeem an enrollment token.',
    options.signal?.aborted ? 'GATEWAY_TEST_FAILED' : 'GATEWAY_UNREACHABLE')), { once: true }));
  try {
    await Promise.race([canceled, (async () => {
      let response: Response;
      try {
        response = await (options.fetch ?? fetch)(`${url}/v1/${scoped ? 'responses' : 'chat/completions'}`, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { authorization: `Bearer ${config.gatewayToken}`, 'content-type': 'application/json' },
          body: JSON.stringify(scoped ? { model: `openclaw/${config.agentId}`, stream: false, store: false, tools: [], max_output_tokens: 128,
            input: [{ type: 'message', role: 'user', content: 'Envoi connection test. Do not use tools, read files, or perform external actions. Reply with a short confirmation.' }] }
            : { model: `openclaw/${config.agentId}`, user: `envoi:connection-test:${crypto.randomUUID()}`, stream: false,
              messages: [{ role: 'user', content: 'Envoi connection test. Do not use tools, read files, or perform external actions. Reply with a short confirmation that you can receive and answer this message.' }] })
        });
      } catch { throw new OpenClawSetupError('OpenClaw Gateway could not be reached. Check it is running and run the connector in the same network environment. This check did not redeem an enrollment token.', 'GATEWAY_UNREACHABLE'); }
      if (response.status === 404 || response.status === 405) throw new OpenClawSetupError(selectedEndpointHelp);
      if (response.status === 401 || response.status === 403) throw new OpenClawSetupError('OpenClaw Gateway authentication failed. Check the local Gateway credential and selected profile. This check did not redeem an enrollment token.', 'GATEWAY_AUTH_FAILED');
      if (!response.ok) throw new OpenClawSetupError(`OpenClaw connection test failed with HTTP ${response.status}. Check Gateway health and the selected agent model. This check did not redeem an enrollment token.`, response.status === 429 || response.status >= 500 ? 'GATEWAY_UNREACHABLE' : 'GATEWAY_TEST_FAILED');
      let body: unknown;
      try { body = await response.json(); } catch { throw new OpenClawSetupError('OpenClaw connection test returned invalid JSON. Check the Gateway endpoint. This check did not redeem an enrollment token.'); }
      if (scoped) {
        const result = record(body);
        if (result.status !== 'completed' || !Array.isArray(result.output) || !result.output.length
          || result.output.some(item => !['message', 'reasoning'].includes(String(record(item).type)))
          || !result.output.some(item => Array.isArray(record(item).content) && (record(item).content as unknown[])
            .some(part => record(part).type === 'output_text' && typeof record(part).text === 'string' && (record(part).text as string).trim()))) {
          throw new OpenClawSetupError('OpenClaw Responses test did not return a completed text reply. This check did not redeem an enrollment token.');
        }
        return;
      }
      const choices = record(body).choices;
      const first = Array.isArray(choices) ? record(choices[0]) : {};
      const content = record(first.message).content;
      if (first.finish_reason !== 'stop' || typeof content !== 'string' || !content.trim()) throw new OpenClawSetupError('OpenClaw connection test did not return a completed text reply. Check the selected agent model and try again. This check did not redeem an enrollment token.');
    })()]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
  }
}
