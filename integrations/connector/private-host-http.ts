/** Host-only transport. Never expose this object, headers or raw failures as model tools. */
export type HostLifecycle = 'RUNNING' | 'PAUSED' | 'REVOKED' | 'NEEDS_RECONNECT';
export class HostRequestError extends Error {
  constructor(public readonly code: string, public readonly status?: number, public readonly retryAfterSeconds?: number) {
    super(`Envoi host request failed (${code})`);
    this.name = 'HostRequestError';
  }
}

export function closed(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => ![...required, ...optional].includes(key))) throw new HostRequestError('INVALID_RESPONSE');
}
export function valid(condition: unknown): asserts condition {
  if (!condition) throw new HostRequestError('INVALID_RESPONSE');
}
export const utf8Bytes = (value: string) => new TextEncoder().encode(value).length;
export const dateTime = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
// JSON Schema maxLength counts Unicode code points; UTF-8 transport caps are separate.
export function text(value: unknown, max = 2048): value is string {
  if (typeof value !== 'string') return false;
  let length = 0;
  for (const _point of value) if (++length > max) return false;
  return true;
}
export const matches = (value: unknown, pattern: RegExp): value is string => typeof value === 'string' && pattern.test(value);
const httpCodes = new Set([
  'AGENT_PAUSED', 'CREDENTIAL_REVOKED', 'CREDENTIAL_EXPIRED', 'ACCESS_TOKEN_EXPIRED', 'AUTHENTICATION_REQUIRED', 'RATE_LIMITED',
  'FEATURE_DISABLED', 'GATEWAY_SESSION_REVOKED', 'GATEWAY_SESSION_EXPIRED', 'GATEWAY_SESSION_REQUIRED',
  'GATEWAY_SCOPE_CHANGED', 'GATEWAY_SCOPE_REQUIRED', 'GATEWAY_GENERATION_STALE', 'GATEWAY_RECOVERY_REQUIRED',
  'GATEWAY_CSRF_INVALID', 'GATEWAY_SCOPE_DENIED', 'GATEWAY_REQUEST_INVALID',
  'GATEWAY_CHECK_ACTIVE', 'GATEWAY_ACTION_UNSUPPORTED', 'LEASE_LOST', 'GATEWAY_RUN_EXPIRED', 'GATEWAY_RUN_MISMATCH',
  'IDEMPOTENCY_CONFLICT', 'GATEWAY_TEMPORARILY_UNAVAILABLE'
]);
const maximumRetrySeconds = 86400;
function retryDelay(response: Response, payload: unknown): number | undefined {
  const bounded = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0 ? Math.min(maximumRetrySeconds, Number(value)) : 0;
  const header = response.headers.get('retry-after');
  const headerSeconds = header && /^\d{1,15}$/.test(header) ? bounded(Number(header))
    : header && Number.isFinite(Date.parse(header)) ? bounded(Math.max(1, Math.ceil((Date.parse(header) - Date.now()) / 1000))) : 0;
  const bodySeconds = payload && typeof payload === 'object' && 'retryAfterSeconds' in payload ? bounded(payload.retryAfterSeconds) : 0;
  return Math.max(headerSeconds, bodySeconds) || undefined;
}

export function httpsOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new TypeError('A configured HTTPS origin is required'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.port) throw new TypeError('A configured HTTPS origin is required');
  return url.origin;
}

/** Enforces bytes while streaming; never buffers an unbounded response or includes its body in errors. */
export async function boundedJson(response: Response, maxBytes = 65536): Promise<unknown> {
  const size = response.headers.get('content-length');
  if (size && (!/^\d+$/.test(size) || Number(size) > maxBytes)) {
    await response.body?.cancel();
    throw new HostRequestError('RESPONSE_TOO_LARGE');
  }
  if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel();
    throw new HostRequestError('INVALID_RESPONSE');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new HostRequestError('INVALID_RESPONSE');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > maxBytes) { await reader.cancel(); throw new HostRequestError('RESPONSE_TOO_LARGE'); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new HostRequestError('INVALID_RESPONSE'); }
}

export class PrivateHostTransport {
  #state: HostLifecycle = 'RUNNING';
  #fetch: typeof fetch;
  #headers: () => Promise<Record<string, string>>;
  #origin: string;
  #credentials: RequestCredentials;
  #timeoutMs: number;
  constructor(options: { origin: string; headers: () => Promise<Record<string, string>>; fetch?: typeof fetch; credentials?: RequestCredentials; timeoutMs?: number }) {
    this.#origin = httpsOrigin(options.origin);
    this.#fetch = options.fetch ?? fetch;
    this.#headers = options.headers;
    this.#credentials = options.credentials ?? 'omit';
    this.#timeoutMs = options.timeoutMs ?? 15000;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 60000) throw new TypeError('Invalid timeout');
  }
  get lifecycle() { return this.#state; }
  /** Called only after an external owner-resume observation, never by a model or retry timer. */
  ownerResumed() { if (this.#state === 'PAUSED') this.#state = 'RUNNING'; }
  async post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<unknown> {
    if (this.#state !== 'RUNNING') throw new HostRequestError(this.#state === 'PAUSED' ? 'AGENT_PAUSED' : this.#state === 'REVOKED' ? 'CREDENTIAL_REVOKED' : 'OWNER_RECONNECT_REQUIRED');
    if (!/^\/(mcp|api\/agent-gateway\/work\/(claim|act|renew))$/.test(path)) throw new TypeError('Unsupported host path');
    const serialized = JSON.stringify(body);
    if (utf8Bytes(serialized) > 8192) throw new TypeError('Request exceeds 8192 UTF-8 bytes');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const privateHeaders = await this.#headers();
      const response = await this.#fetch(`${this.#origin}${path}`, {
        method: 'POST', redirect: 'error', credentials: this.#credentials, cache: 'no-store', signal: controller.signal,
        headers: { ...privateHeaders, ...headers, 'content-type': 'application/json', accept: 'application/json' }, body: serialized
      });
      const payload = await boundedJson(response);
      if (!response.ok) {
        const code = payload && typeof payload === 'object' && 'code' in payload && typeof payload.code === 'string' && httpCodes.has(payload.code) ? payload.code : 'HTTP_ERROR';
        if (code === 'AGENT_PAUSED') this.#state = 'PAUSED';
        if (code === 'CREDENTIAL_REVOKED' || code === 'GATEWAY_SESSION_REVOKED') this.#state = 'REVOKED';
        if (['CREDENTIAL_EXPIRED', 'AUTHENTICATION_REQUIRED', 'GATEWAY_SESSION_EXPIRED', 'GATEWAY_SCOPE_CHANGED',
          'GATEWAY_SCOPE_REQUIRED', 'GATEWAY_SCOPE_DENIED', 'GATEWAY_SESSION_REQUIRED', 'GATEWAY_GENERATION_STALE',
          'GATEWAY_RECOVERY_REQUIRED'].includes(code)) this.#state = 'NEEDS_RECONNECT';
        throw new HostRequestError(code, response.status, retryDelay(response, payload));
      }
      return payload;
    } catch (error) {
      if (error instanceof HostRequestError) throw error;
      throw new HostRequestError(controller.signal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR');
    } finally { clearTimeout(timer); }
  }
}
