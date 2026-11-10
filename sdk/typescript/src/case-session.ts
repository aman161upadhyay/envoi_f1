import { EnvoiError, responsePayload } from './index';
import { retryDelay } from './lifecycle';

const caseTools = new Set([
  'envoi_case_snapshot', 'envoi_case_reply', 'envoi_case_propose', 'envoi_case_decide',
  'envoi_authority_check', 'envoi_request_human', 'envoi_case_list_assets',
  'envoi_case_share_asset', 'envoi_case_complete'
]);
const scopeFields = new Set([
  'caseId', 'workId', 'inboxId', 'agentId', 'senderAgentId', 'senderInboxId',
  'recipientAddress', 'recipientAgentId', 'recipientInboxId', 'recipientEmail',
  'counterpartyAddress', 'sessionId'
]);
const endedReasons = new Set([
  'credential_ended', 'agent_paused', 'case_controlled', 'work_ineligible',
  'work_settled', 'ended_by_host', 'superseded', 'lease_lost'
]);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const safeId = (value: unknown, prefix: string): value is string => typeof value === 'string' && new RegExp(`^${prefix}[A-Za-z0-9_-]+$`).test(value);
const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

export function retryableCaseSessionError(error: unknown): error is EnvoiError {
  return error instanceof EnvoiError && (['NETWORK_ERROR', 'TIMEOUT', 'INTERNAL_SERVER_ERROR', 'AUTH_UNAVAILABLE', 'RATE_LIMITED'].includes(error.code ?? '')
    || error.status !== undefined && error.status >= 500 && error.status !== 501);
}

function waitForSession(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

function requestInSession(run: () => Promise<Response>, signal: AbortSignal): Promise<Response> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return run(); }).then(response => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) { void response.body?.cancel().catch(() => {}); reject(signal.reason); }
      else resolve(response);
    }, error => { signal.removeEventListener('abort', abort); reject(signal.aborted ? signal.reason : error); });
  });
}

export async function caseSessionResponse<T>(response: Response): Promise<T> {
  const copy = response.ok ? null : response.clone();
  try { return await responsePayload<T>(response, 'Envoi case session request failed'); }
  catch (error) {
    if (!(error instanceof EnvoiError)) throw new EnvoiError('Envoi case session response was invalid', undefined, 'CASE_SESSION_RESPONSE_INVALID');
    const payload = await copy?.json().catch(() => null) as Record<string, unknown> | null;
    const code = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'CASE_SESSION_TRANSPORT_ERROR';
    const reasons = code === 'CASE_SESSION_ENDED' ? endedReasons
      : code === 'WORK_LEASE_STALE' ? new Set(['other_installation', 'superseded', 'settled', 'released', 'expired'])
      : code === 'WORK_NOT_ELIGIBLE' ? new Set(['counterparty_unavailable', 'relationship_blocked', 'instruction_authority_lost', 'permission_removed'])
      : new Set(['revoked', 'replaced', 'refresh_replay']);
    const reason = typeof payload?.reason === 'string' && reasons.has(payload.reason) ? payload.reason : undefined;
    throw new EnvoiError('Envoi case session request failed', error.status, code, { reason, retryAfterSeconds: error.retryAfterSeconds, requestId: error.requestId });
  }
}

export interface CaseSessionBinding {
  agentId: string;
  installationId?: string;
  workId: string;
  caseId: string;
  workKind: 'agent_message' | 'human_instruction' | 'human_decision';
  counterpartyAddress?: string;
  agentAddress: string;
  groupMemberAgentIds?: readonly string[];
}

export interface CaseSessionModelContext {
  counterpartyKind: 'agent' | 'human';
  counterpartyAddress?: string;
  allowedTools: readonly string[];
  sessionExpiresInSeconds: number;
  agentAddress: string;
  groupMemberAgentIds?: readonly string[];
}

interface SessionRecord {
  id: string;
  token: string;
  transport: { kind: 'mcp_streamable_http'; url: string };
  agentId: string;
  installationId: string;
  workId: string;
  caseId: string;
  fence: number;
  workKind: 'agent_message' | 'human_instruction' | 'human_decision';
  counterparty: { kind: 'agent'; address: string } | { kind: 'human' };
  allowedTools: string[];
  createdAt: string;
  expiresAt: string;
}

export interface CaseSessionChannelOptions {
  origin: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  assertActive?: () => Promise<void>;
  onInvalidated?: (error: EnvoiError) => void;
  end?: (sessionId: string) => Promise<void>;
}

function parseSession(payload: unknown, binding: CaseSessionBinding, origin: string): SessionRecord {
  const invalid = () => new EnvoiError('Envoi returned an invalid case session', undefined, 'CASE_SESSION_RESPONSE_INVALID');
  if (!object(payload) || !exact(payload, ['session', 'lease']) || !object(payload.session) || !object(payload.lease)) throw invalid();
  const session = payload.session;
  if (!exact(session, ['id', 'token', 'tokenType', 'status', 'transport', 'agentId', 'installationId', 'workId', 'workKind', 'caseId', 'fence', 'counterparty', 'allowedTools', 'createdAt', 'expiresAt'])
    || !safeId(session.id, 'case_session_') || typeof session.token !== 'string' || !/^envoi_case_session_[A-Za-z0-9_-]{16,256}$/.test(session.token)
    || session.tokenType !== 'Bearer' || session.status !== 'active'
    || !object(session.transport) || !exact(session.transport, ['kind', 'url']) || session.transport.kind !== 'mcp_streamable_http' || session.transport.url !== `${origin}/mcp`
    || !safeId(session.agentId, 'agent_') || session.agentId !== binding.agentId
    || !safeId(session.installationId, 'installation_') || binding.installationId !== undefined && session.installationId !== binding.installationId
    || !safeId(session.workId, 'msg_') || session.workId !== binding.workId
    || !safeId(session.caseId, 'case_') || session.caseId !== binding.caseId || session.workKind !== binding.workKind
    || !Number.isSafeInteger(session.fence) || (session.fence as number) < 1
    || !timestamp(session.createdAt) || !timestamp(session.expiresAt) || Date.parse(session.expiresAt) - Date.parse(session.createdAt) !== 900_000
    || Date.parse(session.createdAt) > Date.now() + 5000 || Date.parse(session.expiresAt) <= Date.now()
    || !Array.isArray(session.allowedTools) || !session.allowedTools.includes('envoi_case_snapshot')
    || new Set(session.allowedTools).size !== session.allowedTools.length || session.allowedTools.some(tool => typeof tool !== 'string' || !caseTools.has(tool))
    || !object(session.counterparty) || !exact(payload.lease, ['workId', 'leaseExpiresAt'])
    || payload.lease.workId !== binding.workId || !timestamp(payload.lease.leaseExpiresAt) || Date.parse(payload.lease.leaseExpiresAt) <= Date.now()) throw invalid();
  if (binding.workKind === 'agent_message' || binding.workKind === 'human_decision') {
    if (!exact(session.counterparty, ['kind', 'address']) || session.counterparty.kind !== 'agent'
      || typeof session.counterparty.address !== 'string' || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(session.counterparty.address)
      || session.counterparty.address !== binding.counterpartyAddress) throw invalid();
  } else if (!exact(session.counterparty, ['kind']) || session.counterparty.kind !== 'human'
    || session.allowedTools.some(tool => !['envoi_case_snapshot', 'envoi_case_reply', 'envoi_case_list_assets'].includes(tool))) throw invalid();
  return structuredClone(session) as unknown as SessionRecord;
}

export class CaseSessionChannel {
  #session: SessionRecord;
  #binding: CaseSessionBinding;
  #options: CaseSessionChannelOptions;
  #controller = new AbortController();
  #expiryTimer: ReturnType<typeof setTimeout>;
  #parentAbort: () => void;
  #failure?: EnvoiError;

  constructor(payload: unknown, binding: CaseSessionBinding, options: CaseSessionChannelOptions) {
    const base = new URL(options.origin);
    if (base.origin !== options.origin || base.username || base.password
      || base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) throw new TypeError('Invalid case session origin');
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 300_000)) throw new RangeError('Invalid case session timeout');
    if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(binding.agentAddress)) throw new TypeError('Invalid agent address');
    this.#session = parseSession(payload, binding, options.origin);
    this.#binding = { ...binding, ...(binding.groupMemberAgentIds ? { groupMemberAgentIds: Object.freeze([...binding.groupMemberAgentIds]) } : {}) };
    this.#options = { ...options };
    this.#expiryTimer = setTimeout(() => this.invalidate(new EnvoiError('Case session expired', 401, 'CASE_SESSION_EXPIRED')), Date.parse(this.#session.expiresAt) - Date.now());
    this.#parentAbort = () => this.invalidate(new EnvoiError('Case session was interrupted', undefined, 'REQUEST_CANCELLED'));
    options.signal?.addEventListener('abort', this.#parentAbort, { once: true });
    if (options.signal?.aborted) this.#parentAbort();
  }

  get signal(): AbortSignal { return this.#controller.signal; }

  #check() {
    if (this.#failure) throw this.#failure;
    if (Date.parse(this.#session.expiresAt) <= Date.now()) this.invalidate(new EnvoiError('Case session expired', 401, 'CASE_SESSION_EXPIRED'));
    if (this.#failure) throw this.#failure;
  }

  modelContext(): Readonly<CaseSessionModelContext> {
    this.#check();
    return Object.freeze({
      counterpartyKind: this.#session.counterparty.kind,
      ...(this.#binding.groupMemberAgentIds ? { groupMemberAgentIds: this.#binding.groupMemberAgentIds } : {}),
      ...(this.#session.counterparty.kind === 'agent' ? { counterpartyAddress: this.#session.counterparty.address } : {}),
      allowedTools: Object.freeze([...this.#session.allowedTools]),
      sessionExpiresInSeconds: Math.max(0, Math.floor((Date.parse(this.#session.expiresAt) - Date.now()) / 1000)),
      agentAddress: this.#binding.agentAddress
    });
  }

  toJSON() { return this.#controller.signal.aborted ? { state: 'ended' } : this.modelContext(); }

  async end(): Promise<void> {
    const sessionId = this.#session.id;
    this.invalidate();
    await this.#options.end?.(sessionId);
  }

  invalidate(error = new EnvoiError('Case session ended', 401, 'CASE_SESSION_ENDED', { reason: 'ended_by_host' })) {
    if (this.#failure) return;
    this.#failure = error;
    this.#session.token = '';
    clearTimeout(this.#expiryTimer);
    this.#options.signal?.removeEventListener('abort', this.#parentAbort);
    this.#controller.abort(error);
    try { this.#options.onInvalidated?.(error); } catch {}
  }

  observeEvent(event: Record<string, unknown>): boolean {
    if (event.type !== 'case_session.ended' || event.agentId !== this.#session.agentId || event.workId !== this.#session.workId
      || event.caseId !== this.#session.caseId || event.sessionId !== this.#session.id || typeof event.reason !== 'string' || !endedReasons.has(event.reason)) return false;
    this.invalidate(new EnvoiError('Case session ended', 401, 'CASE_SESSION_ENDED', { reason: event.reason }));
    return true;
  }

  async forward(body: string, protocolVersion = '2025-11-25'): Promise<Response> {
    let failures = 0;
    while (true) {
      try { return await this.#forwardOnce(body, protocolVersion); }
      catch (error) {
        this.#check();
        if (!retryableCaseSessionError(error) || ++failures > 3) throw error;
        await waitForSession(retryDelay(failures, Math.random(), error.retryAfterSeconds), this.signal);
      }
    }
  }

  async #forwardOnce(body: string, protocolVersion: string): Promise<Response> {
    this.#check();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(protocolVersion) || typeof body !== 'string' || new TextEncoder().encode(body).byteLength > 1_000_000) throw new TypeError('Invalid case session MCP request');
    let request: unknown;
    try { request = JSON.parse(body); } catch { throw new TypeError('Invalid case session MCP request'); }
    if (!object(request) || request.jsonrpc !== '2.0' || !['initialize', 'notifications/initialized', 'ping', 'tools/list', 'tools/call'].includes(String(request.method))) throw new TypeError('Invalid case session MCP method');
    if (request.method === 'tools/call') {
      if (!object(request.params) || typeof request.params.name !== 'string' || !this.#session.allowedTools.includes(request.params.name)) throw new EnvoiError('Tool is not in this case session', undefined, 'TOOL_NOT_IN_SESSION');
      if (!object(request.params.arguments) || Object.keys(request.params.arguments).some(key => scopeFields.has(key))) throw new EnvoiError('Tool arguments cannot override session scope', undefined, 'TOOL_ARGUMENTS_INVALID');
    }
    await this.#options.assertActive?.();
    this.#check();
    const timeout = AbortSignal.timeout(this.#options.timeoutMs ?? 30_000);
    const requestSignal = AbortSignal.any([timeout, this.signal]);
    let response: Response;
    try {
      response = await requestInSession(() => (this.#options.fetch ?? fetch)(`${this.#options.origin}/mcp`, {
        method: 'POST', credentials: 'omit', redirect: 'error', body,
        signal: requestSignal,
        headers: { authorization: `Bearer ${this.#session.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': protocolVersion }
      }), requestSignal);
    } catch {
      this.#check();
      throw new EnvoiError('Case session transport failed', undefined, timeout.aborted ? 'TIMEOUT' : 'NETWORK_ERROR');
    }
    this.#check();
    if (response.status !== 202 && response.status !== 204) {
      const reader = response.body?.getReader();
      if (!reader) throw new EnvoiError('Case session returned an empty response', undefined, 'CASE_SESSION_RESPONSE_INVALID');
      const chunks: Uint8Array[] = [];
      let size = 0;
      const cancel = () => { void reader.cancel().catch(() => {}); };
      this.signal.addEventListener('abort', cancel, { once: true });
      timeout.addEventListener('abort', cancel, { once: true });
      try {
        while (true) {
          const chunk = await reader.read();
          this.#check();
          if (timeout.aborted) throw new EnvoiError('Case session response timed out', undefined, 'TIMEOUT');
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 4_000_000) throw new EnvoiError('Case session response is too large', undefined, 'CASE_SESSION_RESPONSE_INVALID');
          chunks.push(chunk.value);
        }
      } catch (error) {
        await reader.cancel().catch(() => {});
        this.#check();
        if (error instanceof EnvoiError) throw error;
        throw new EnvoiError('Case session response could not be read', undefined, 'NETWORK_ERROR');
      } finally {
        this.signal.removeEventListener('abort', cancel);
        timeout.removeEventListener('abort', cancel);
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      response = new Response(bytes, { status: response.status, headers: response.headers });
    }
    this.#check();
    if (!response.ok) {
      try { await caseSessionResponse(response); }
      catch (error) {
        this.#check();
        if (response.status === 401 && error instanceof EnvoiError) this.invalidate(error);
        throw error;
      }
    }
    await this.#options.assertActive?.();
    this.#check();
    return response;
  }
}
