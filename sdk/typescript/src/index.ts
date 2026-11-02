export const ENVOI_PROTOCOL_VERSION = '1.0' as const;

export type EnvoiIntent = 'request' | 'offer' | 'counteroffer' | 'accept' | 'reject' | 'clarify' | 'commit' | 'cancel' | 'status' | 'receipt' | 'message';
export type DeliveryState = 'pendingContactApproval' | 'queued' | 'retrying' | 'accepted' | 'delivered' | 'acknowledged' | 'processed' | 'declined' | 'deadLettered' | 'held' | 'cancelled';

export interface AgentRef { agentId: string; address: string }
export interface ContentPart { type: 'text' | 'json' | 'artifactRef'; text?: string; data?: unknown; artifactRef?: string }
export interface Authority { scope: string; humanApproval: 'notRequired' | 'pending' | 'approved' | 'denied'; policyEvaluationId?: string | null }
export interface AgentMessage {
  schemaVersion: typeof ENVOI_PROTOCOL_VERSION;
  messageId: string;
  conversationId: string;
  taskId?: string | null;
  correlationId: string | null;
  causationId: string | null;
  from: AgentRef;
  to: AgentRef[];
  intent: EnvoiIntent;
  content: ContentPart[];
  proposal?: Record<string, unknown> | null;
  authority: Authority;
  artifactRefs: string[];
  requiresAck: boolean;
  traceparent?: string | null;
  signature?: string | null;
  createdAt: string;
}

export interface AgentTokens {
  agentApiToken: string;
  agentRefreshToken: string;
  agentTokenExpiresAt: string;
  agentRefreshTokenExpiresAt: string;
}

export interface NativeMessageInput {
  senderAgentId: string;
  recipientEmail: string;
  text: string;
  intent?: EnvoiIntent;
  caseId?: string;
  content?: ContentPart[];
  payload?: Record<string, unknown> | null;
  artifactRefs?: string[];
  requiresAck?: boolean;
}

export interface CaseMessageInput extends Omit<NativeMessageInput, 'caseId'> {
  caseId: string;
}

export interface AssetRecord {
  id: string;
  caseId: string | null;
  filename: string;
  mimeType: string;
  size: number;
  checksumSha256: string;
  createdByAgentId: string;
  state: 'quarantine' | 'clean' | 'infected' | 'error';
  createdAt: string;
  scannedAt: string | null;
  /** Present when this asset is visible through a cross-owner case grant. */
  grant?: AssetGrant;
}

export interface AssetGrant {
  id: string;
  assetId: string;
  caseId: string;
  ownerInboxId: string;
  recipientInboxId: string;
  createdByAgentId: string;
  recipientAgentId: string;
  grantedBy: string;
  grantedAt: string;
  revokedAt: string | null;
  updatedAt: string;
}

export type RelationshipGrant = 'shareAssets' | 'autoAcceptSelectedTasks' | 'richerProfileVisibility' | 'allowInvitations';
export type DiscoveryTrust = 'relationship' | 'approved_contact' | 'same_organization' | 'signed_invitation' | 'exact_address';
export interface AgentDiscovery {
  agentId: string;
  address: string;
  trust: DiscoveryTrust;
  grants: RelationshipGrant[];
  a2aCardUrl?: string;
  inboxId?: string;
}
export interface A2ATask {
  id: string;
  contextId: string;
  status: { state: string; timestamp: string };
  artifacts: Array<{ artifactId: string; name: string; parts: Array<{ url: string }> }>;
}
export interface A2AAgentCard {
  name: string;
  supportedInterfaces: Array<{ url: string; protocolBinding: 'HTTP+JSON'; protocolVersion: '1.0' }>;
  capabilities: { streaming: false; pushNotifications: false; extendedAgentCard: false };
  securitySchemes: Record<string, unknown>;
  defaultInputModes: string[];
  defaultOutputModes: string[];
}

export interface SignedAssetRequest { url: string; method: 'PUT' | 'GET'; headers?: Record<string, string> }
export interface AssetUploadInput { filename: string; mimeType: string; size: number; checksumSha256: string; caseId?: string }

export interface ClientOptions {
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface ErrorDetails { reason?: string; retryAfterSeconds?: number; requestId?: string }
export class EnvoiError extends Error {
  readonly reason?: string;
  readonly retryAfterSeconds?: number;
  readonly requestId?: string;
  constructor(message: string, public readonly status?: number, public readonly code?: string, details: ErrorDetails = {}) {
    super(message);
    this.name = 'EnvoiError';
    this.reason = details.reason; this.retryAfterSeconds = details.retryAfterSeconds; this.requestId = details.requestId;
  }
}

const timeoutMs = (value = 30_000) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) throw new RangeError('timeoutMs must be an integer from 1 to 300000');
  return value;
};

const safePayload = (text: string): Record<string, unknown> | unknown[] | null => {
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value as Record<string, unknown> | unknown[] : null;
  } catch {
    return null;
  }
};

export async function responsePayload<T>(response: Response, fallback: string): Promise<T> {
  const text = await response.text();
  const payload = safePayload(text);
  if (!response.ok) {
    const errorBody = payload && !Array.isArray(payload) ? payload : null;
    const a2aError = errorBody?.error && typeof errorBody.error === 'object' && !Array.isArray(errorBody.error) ? errorBody.error as Record<string, unknown> : null;
    const remoteMessage = typeof errorBody?.message === 'string' && errorBody.message.length > 0 && errorBody.message.length <= 500 ? errorBody.message : typeof a2aError?.message === 'string' && a2aError.message.length <= 500 ? a2aError.message : typeof errorBody?.error === 'string' ? errorBody.error : null;
    const message = remoteMessage && remoteMessage.length <= 500 ? remoteMessage : `${fallback} with HTTP ${response.status}`;
    const header = response.headers.get('retry-after');
    const headerSeconds = header ? (/^\d+$/.test(header) ? Number(header) : Math.max(0, (Date.parse(header) - Date.now()) / 1000)) : 0;
    const bodySeconds = typeof errorBody?.retryAfterSeconds === 'number' ? errorBody.retryAfterSeconds : 0;
    const retryAfterSeconds = Math.max(Number.isFinite(headerSeconds) ? headerSeconds : 0, Number.isFinite(bodySeconds) ? bodySeconds : 0);
    throw new EnvoiError(message, response.status, typeof errorBody?.code === 'string' ? errorBody.code : typeof a2aError?.code === 'string' ? a2aError.code : undefined, {
      ...(retryAfterSeconds > 0 ? { retryAfterSeconds } : {}),
      ...(typeof errorBody?.reason === 'string' && ['revoked', 'replaced', 'refresh_replay'].includes(errorBody.reason) ? { reason: errorBody.reason } : {}),
      ...(typeof errorBody?.requestId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(errorBody.requestId) ? { requestId: errorBody.requestId } : {})
    });
  }
  if (!text) throw new EnvoiError('Envoi returned an empty response', response.status);
  if (payload === null) throw new EnvoiError('Envoi returned an invalid JSON response', response.status);
  return payload as T;
}

async function fetchWithTimeout(fetcher: typeof fetch, url: string, init: RequestInit, duration: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs(duration));
  const onAbort = () => controller.abort();
  init.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetcher(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted && !init.signal?.aborted) throw new EnvoiError('Envoi request timed out', undefined, 'TIMEOUT');
    throw new EnvoiError('Envoi could not be reached', undefined, 'NETWORK_ERROR');
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', onAbort);
  }
}

export interface ContactInvitation {
  id: string;
  fromAddress: string;
  toAddress: string;
  state: 'pending' | 'accepted' | 'declined' | 'superseded';
  conversationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type SendMessageResult = AgentMessage & { status: DeliveryState; transport: 'native'; recipientEmail: string };

/** Generate once and persist before the first send; retries must reuse this ID. */
export function newCaseId(): string { return `case_${globalThis.crypto.randomUUID().replaceAll('-', '')}`; }

export class EnvoiClient {
  private readonly requestTimeoutMs: number;
  private readonly fetcher: typeof fetch;

  constructor(private readonly baseUrl: string, private accessToken: string, options: ClientOptions = {}) {
    this.requestTimeoutMs = timeoutMs(options.timeoutMs);
    this.fetcher = options.fetch || fetch;
  }

  setAccessToken(accessToken: string) { this.accessToken = accessToken; }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetchWithTimeout(this.fetcher, `${this.baseUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.accessToken}`, ...init.headers }
    }, this.requestTimeoutMs);
    return responsePayload<T>(response, 'Envoi request failed');
  }

  sendMessage(inboxId: string, idempotencyKey: string, input: NativeMessageInput) {
    return this.request<SendMessageResult>(`/api/inboxes/${encodeURIComponent(inboxId)}/messages`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(input)
    });
  }

  /** Starts a distinct native case with the first message. Persist caseId and key before retrying. */
  startCase(inboxId: string, idempotencyKey: string, input: CaseMessageInput) {
    if (!input.caseId) throw new TypeError('A persisted caseId is required to start a case');
    return this.sendMessage(inboxId, idempotencyKey, { ...input, intent: input.intent || 'request' });
  }

  /** Sends a typed event on the canonical native message path visible to both owners. */
  sendCaseEvent(inboxId: string, idempotencyKey: string, input: CaseMessageInput) {
    if (!input.caseId) throw new TypeError('A caseId is required for a case event');
    return this.sendMessage(inboxId, idempotencyKey, input);
  }

  listCases(inboxId: string, limit = 50, before?: string) {
    const query = new URLSearchParams({ limit: String(limit), ...(before ? { before } : {}) });
    return this.request<Array<Record<string, unknown>>>(`/api/inboxes/${encodeURIComponent(inboxId)}/cases?${query}`);
  }

  getCase(inboxId: string, caseId: string) {
    return this.request<Record<string, unknown>>(`/api/inboxes/${encodeURIComponent(inboxId)}/cases/${encodeURIComponent(caseId)}`);
  }

  listCaseMessages(inboxId: string, caseId: string, limit = 50, before?: string) {
    const query = new URLSearchParams({ caseId, limit: String(limit), ...(before ? { before } : {}) });
    return this.request<Array<Record<string, unknown>>>(`/api/inboxes/${encodeURIComponent(inboxId)}/messages?${query}`);
  }

  /** Reuse the same key and input after an uncertain upload reservation response. */
  beginAssetUpload(inboxId: string, idempotencyKey: string, input: AssetUploadInput) {
    return this.request<{ object: AssetRecord; upload: SignedAssetRequest }>(`/api/inboxes/${encodeURIComponent(inboxId)}/asset-uploads`, {
      method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(input)
    });
  }

  completeAssetUpload(inboxId: string, assetId: string) {
    return this.request<AssetRecord>(`/api/inboxes/${encodeURIComponent(inboxId)}/assets/${encodeURIComponent(assetId)}/complete`, { method: 'POST', body: '{}' });
  }

  /** Grant one clean case asset to the other bound case participant. Reuse the key on retry. */
  grantCaseAsset(inboxId: string, assetId: string, caseId: string, recipientAgentId: string, idempotencyKey: string) {
    if (!idempotencyKey) throw new TypeError('An asset grant idempotency key is required');
    return this.request<AssetGrant>(`/api/inboxes/${encodeURIComponent(inboxId)}/assets/${encodeURIComponent(assetId)}/grants`, {
      method: 'POST', headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ caseId, recipientAgentId })
    });
  }

  listAssets(inboxId: string) {
    return this.request<AssetRecord[]>(`/api/inboxes/${encodeURIComponent(inboxId)}/assets`);
  }

  /** The server issues a download URL only when the asset passed its malware scan. */
  async getCleanAssetDownload(inboxId: string, assetId: string) {
    const result = await this.request<{ object: AssetRecord; download: SignedAssetRequest }>(`/api/inboxes/${encodeURIComponent(inboxId)}/assets/${encodeURIComponent(assetId)}/download`);
    const target = new URL(result.download.url);
    if (target.origin === new URL(this.baseUrl).origin && target.pathname === `/api/inboxes/${encodeURIComponent(inboxId)}/assets/${encodeURIComponent(assetId)}/content`) {
      return { ...result, download: { ...result.download, headers: { ...result.download.headers, authorization: `Bearer ${this.accessToken}` } } };
    }
    return result;
  }

  /** Legacy route. Native processing must use the connector's fenced work claim. */
  /** @deprecated Native messages return 410; use EnvoiConnector with a work handler. */
  acknowledge(inboxId: string, messageId: string, state: 'acknowledged' | 'processed', idempotencyKey: string) {
    return this.request(`/api/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(messageId)}/acknowledgements`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ state })
    });
  }

  delta(inboxId: string, cursor?: string, limit = 100) {
    const query = new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) });
    return this.request<{ events: Array<Record<string, unknown>>; nextCursor: string | null; hasMore: boolean }>(`/api/inboxes/${encodeURIComponent(inboxId)}/events/delta?${query}`);
  }

  /** Exact-address discovery conveys visibility, never permission to send or share. */
  discoverAgent(address: string) {
    return this.request<AgentDiscovery>(`/api/agent/discovery?address=${encodeURIComponent(address)}`);
  }

  discoverOrganization(limit = 25, after?: string) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new RangeError('Discovery limit must be 1–50');
    const query = new URLSearchParams({ scope: 'organization', limit: String(limit), ...(after ? { after } : {}) });
    return this.request<{ agents: AgentDiscovery[]; nextCursor: string | null }>(`/api/agent/discovery?${query}`);
  }

  redeemDiscoveryInvitation(invitation: string) {
    if (!invitation) throw new TypeError('An invitation is required');
    return this.request<AgentDiscovery>('/api/agent/discovery/invitation', { method: 'POST', body: JSON.stringify({ invitation }) });
  }

  /** The authenticated card is address-specific; there is no public directory. */
  getA2ACard(address: string) {
    return this.request<A2AAgentCard>(`/api/agent/a2a/agents/${encodeURIComponent(address)}/card`);
  }

  /** Persist messageId before first send and reuse it after an uncertain response. */
  sendA2AText(address: string, messageId: string, text: string) {
    if (!messageId || !text.trim()) throw new TypeError('A persisted messageId and nonempty text are required');
    return this.request<{ task: A2ATask }>(`/api/agent/a2a/agents/${encodeURIComponent(address)}/message:send`, {
      method: 'POST', headers: { 'content-type': 'application/a2a+json' },
      body: JSON.stringify({ message: { messageId, role: 'ROLE_USER', parts: [{ text }] }, configuration: { returnImmediately: true } })
    });
  }

  getA2ATask(address: string, caseId: string) {
    return this.request<A2ATask>(`/api/agent/a2a/agents/${encodeURIComponent(address)}/tasks/${encodeURIComponent(caseId)}`);
  }
}

/** Sends bytes only to the server-provided signed target, without agent credentials. */
export async function putSignedAsset(upload: SignedAssetRequest, body: Uint8Array | Blob, options: ClientOptions = {}): Promise<void> {
  if (upload.method !== 'PUT') throw new TypeError('Signed upload must use PUT');
  const target = new URL(upload.url);
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))) {
    throw new TypeError('Signed upload URL must use HTTPS');
  }
  const response = await fetchWithTimeout(options.fetch || fetch, target.toString(), {
    method: 'PUT', headers: upload.headers || {}, body: body as BodyInit, redirect: 'error'
  }, timeoutMs(options.timeoutMs));
  if (!response.ok) throw new EnvoiError(`Signed upload failed with HTTP ${response.status}`, response.status);
}

export async function rotateAgentToken(baseUrl: string, agentRefreshToken: string, rotationId: string, options: ClientOptions = {}): Promise<AgentTokens> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(rotationId)) throw new TypeError('Valid rotationId required');
  const response = await fetchWithTimeout(options.fetch || fetch, `${baseUrl.replace(/\/$/, '')}/api/agent-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grantType: 'refresh_token', agentRefreshToken, rotationId })
  }, timeoutMs(options.timeoutMs));
  const result = await responsePayload<AgentTokens>(response, 'Envoi token rotation failed');
  return {
    agentApiToken: result.agentApiToken, agentRefreshToken: result.agentRefreshToken,
    agentTokenExpiresAt: result.agentTokenExpiresAt, agentRefreshTokenExpiresAt: result.agentRefreshTokenExpiresAt
  };
}
