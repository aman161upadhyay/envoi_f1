import { responsePayload, rotateAgentToken, EnvoiClient, EnvoiError, type AgentTokens, type AssetUploadInput, type CaseMessageInput, type ClientOptions, type NativeMessageInput } from './index';
import { lifecyclePolicy, retryDelay, guidanceText, type ConnectorLifecycle, type ConnectorState } from './lifecycle';
export type { ConnectorLifecycle, ConnectorState } from './lifecycle';
import { CONNECTOR_RUNTIMES, type ConnectorRuntime } from './quick-connect';
import { eventFrames } from './sse';
import { CaseSessionChannel, caseSessionResponse, retryableCaseSessionError } from './case-session';
import { CaseToolError } from './case-tools';

/** Persist the whole record atomically, including each replacement refresh token. */
export interface ConnectorSession extends AgentTokens {
  agentId: string;
  inboxId: string;
  address: string;
  cursor: string | null;
  /** Observation cursors belong to an inbox, never to the installation globally. */
  cursors?: Record<string, string | null>;
  lifecycle?: ConnectorLifecycle;
  pendingRotation?: {
    rotationId: string;
    refreshTokenFingerprint: string;
    startedAt: string;
  };
}

export interface ConnectorStore {
  load(): Promise<ConnectorSession | null>;
  save(session: ConnectorSession): Promise<void>;
}

export interface McpReadToken {
  mcpAccessToken: string;
  tokenType: 'Bearer';
  scope: 'case_read';
  caseId: string | null;
  expiresAt: string;
}

export interface InboxEvent {
  id: string;
  type: string;
  cursor: string;
  [key: string]: unknown;
}

export interface NativeWorkMessage extends Record<string, unknown> {
  kind?: 'nativeAgentMessage';
  id: string;
  senderAgentId: string;
  recipientAgentId: string;
  from: { agentId: string; address: string };
  caseId?: string | null;
  text: string;
}

export interface HumanInstructionWorkMessage extends Record<string, unknown> {
  id: string;
  kind: 'humanInstruction';
  senderType: 'human';
  senderHumanId: string;
  senderAgentId?: never;
  senderInboxId?: never;
  recipientAgentId: string;
  recipientInboxId: string;
  from: { humanId: string; agentId?: never; address?: never };
  caseId: string;
  type: 'instruction';
  text: string;
}

export interface HumanDecisionWorkMessage extends Record<string, unknown> {
  id: string;
  kind: 'humanDecision';
  type: 'humanDecision';
  inboxId: string;
  caseId: string;
  senderType: 'human' | 'system';
  senderHumanId?: string;
  from?: { humanId: string };
  senderAgentId?: never;
  senderInboxId?: never;
  recipientInboxId: string;
  recipientAgentId: string;
  counterpartyAgentId: string;
  counterpartyInboxId: string;
  counterpartyAddress: string;
  requestId: string;
  policyEvaluationId: string;
  action: 'proposal.accept' | 'case.complete';
  outcome: 'approved' | 'declined' | 'expired';
  text: string;
  status: 'delivered';
  createdAt: string;
  deliveredAt: string;
  updatedAt: string;
}

export type WorkMessage = NativeWorkMessage | HumanInstructionWorkMessage | HumanDecisionWorkMessage;

export interface HumanInstructionReply extends Record<string, unknown> {
  id: string;
  kind: 'humanInstructionReply';
  inboxId: string;
  caseId: string;
  senderType: 'agent';
  senderAgentId: string;
  senderInboxId: string;
  recipientInboxId: string;
  recipientHumanId: string;
  from: { agentId: string; address: string };
  inReplyTo: string;
  type: 'message';
  text: string;
  status: 'delivered';
}

export function isHumanInstructionMessage(message: WorkMessage): message is HumanInstructionWorkMessage {
  return message.kind === 'humanInstruction';
}

export function isHumanDecisionMessage(message: WorkMessage): message is HumanDecisionWorkMessage {
  return message.kind === 'humanDecision';
}

export function assertHumanDecisionMessage(message: HumanDecisionWorkMessage) {
  const invalid = () => new EnvoiError('Envoi returned an invalid human decision');
  const id = (value: unknown, prefix: string) => typeof value === 'string' && new RegExp(`^${prefix}[A-Za-z0-9_-]+$`).test(value);
  const required = ['id', 'kind', 'type', 'inboxId', 'caseId', 'senderType', 'recipientInboxId', 'recipientAgentId', 'counterpartyAgentId',
    'counterpartyInboxId', 'counterpartyAddress', 'requestId', 'policyEvaluationId', 'action', 'outcome', 'text', 'status', 'createdAt', 'deliveredAt', 'updatedAt'];
  if (required.some(key => !Object.hasOwn(message, key)) || Object.keys(message).some(key => ![...required, 'senderHumanId', 'from'].includes(key))
    || message.kind !== 'humanDecision' || message.type !== 'humanDecision' || !id(message.id, 'msg_') || !id(message.caseId, 'case_')
    || !id(message.inboxId, 'inbox_') || message.inboxId !== message.recipientInboxId || !id(message.recipientAgentId, 'agent_')
    || !id(message.counterpartyAgentId, 'agent_') || !id(message.counterpartyInboxId, 'inbox_')
    || message.counterpartyAgentId === message.recipientAgentId || message.counterpartyInboxId === message.recipientInboxId
    || typeof message.counterpartyAddress !== 'string' || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(message.counterpartyAddress)
    || typeof message.requestId !== 'string' || !message.requestId || !id(message.policyEvaluationId, 'policy_eval_')
    || !['proposal.accept', 'case.complete'].includes(message.action) || !['approved', 'declined', 'expired'].includes(message.outcome)
    || typeof message.text !== 'string' || !message.text || [...message.text].length > 500 || message.status !== 'delivered'
    || ['createdAt', 'deliveredAt', 'updatedAt'].some(key => typeof message[key] !== 'string' || !Number.isFinite(Date.parse(message[key] as string)))) throw invalid();
  if (message.outcome === 'expired') {
    if (message.senderType !== 'system' || 'senderHumanId' in message || 'from' in message) throw invalid();
  } else if (message.senderType !== 'human' || !id(message.senderHumanId, 'human_') || !message.from
    || typeof message.from !== 'object' || Array.isArray(message.from) || Object.keys(message.from).length !== 1
    || message.from.humanId !== message.senderHumanId) throw invalid();
}

function assertHumanInstructionMessage(message: HumanInstructionWorkMessage) {
  const safeId = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
  if (message.senderType !== 'human' || message.type !== 'instruction' || !safeId(message.senderHumanId)
    || !safeId(message.recipientInboxId) || !safeId(message.caseId) || typeof message.text !== 'string' || !message.text.trim()
    || !message.from || typeof message.from !== 'object' || Array.isArray(message.from) || message.from.humanId !== message.senderHumanId
    || Object.keys(message.from).some(key => key !== 'humanId') || 'senderAgentId' in message || 'senderInboxId' in message || 'senderEmail' in message) {
    throw new EnvoiError('Envoi returned an invalid human instruction');
  }
}

export interface WorkLease {
  workId: string;
  message: WorkMessage;
  leaseToken: string;
  leaseExpiresAt: string;
}

interface WorkSettlement {
  workId: string;
  status: 'acknowledged' | 'processed';
  receipt: { messageId: string; state: 'acknowledged' | 'processed'; [key: string]: unknown };
}

export interface WorkContext {
  /** Aborts on shutdown or if the connector can no longer renew its lease. */
  signal: AbortSignal;
  /** Use a stable idempotency key for each logical reply; retries may run the handler again. */
  reply(text: string, idempotencyKey: string, extra?: Omit<NativeMessageInput, 'senderAgentId' | 'recipientEmail' | 'text' | 'caseId'>): Promise<unknown>;
}

export interface WorkHandler {
  /** Must durably admit by message.id before resolving; may be called again after a crash. */
  admit(message: WorkMessage): Promise<void>;
  /** Must be idempotent by message.id and honor context.signal for long work. */
  process(message: WorkMessage, context: WorkContext): Promise<void>;
}

export interface CaseSessionWorkHandler {
  admit(message: WorkMessage): Promise<void>;
  process(channel: CaseSessionChannel, context: { signal: AbortSignal; workId?: string }): Promise<void>;
}

export interface ScopedWakeWorkDriver {
  processWorkOnce(signal?: AbortSignal): Promise<boolean>;
  /** Trusted opt-in only: at most two exact, distinct case/work pairs. Claims
   * validate serially before either handler is admitted; leases renew while
   * waiting for that admission barrier. Outcomes remain per work. */
  processWorkBatch(expectations: readonly ScopedWorkExpectation[], signal?: AbortSignal): Promise<readonly ScopedWorkOutcome[]>;
  revalidateLiveLeases(signal?: AbortSignal): Promise<void>;
  nextAvailableInMs(): number | undefined;
}
export type ScopedWorkExpectation = Readonly<{workId: string; caseId: string}>;
export type ScopedWorkOutcome = ScopedWorkExpectation & ({status: 'fulfilled'; worked: boolean} | {status: 'rejected'; error: unknown});

/** Trusted operator fixture only. Never part of model context or a scoped-tool fallback. */
export interface SyntheticPolicyFixtureInput {
  fixtureId: string;
  windowId: string;
  approvalSha256: string;
  approvalDecisionRaw: string;
  expected: Readonly<{inboxId:string;agentId:string;installationId:string;caseId:string;workId:string;proposalId:string;optionId:string}>;
  expiresAt: string;
}
export interface SyntheticPolicyFixtureResult {
  id:string;actor:string;requestedAction:'proposal.accept';decision:'needsHuman'|'deny'|'allow';expiresAt:string;
}

/** Trusted operator denial probe; the lease must already belong to this SDK. */
export interface StaleControlSettlementProbe {
  workId:string;leaseToken:string;leaseExpiresAt:string;expected:'paused'|'revoked'|'expired';
}

export interface ConnectorOptions extends ClientOptions {
  pageSize?: number;
  /** @deprecated Wake safety intervals are fixed by a4-wake; this value is ignored. */
  pollIntervalMs?: number;
  refreshSkewMs?: number;
  /** Observation only. Processing uses the separate fenced work-claim API. */
  onEvent?: (event: InboxEvent) => Promise<void> | void;
  /** Enables fenced work processing when the server work routes are available. */
  handler?: WorkHandler;
  caseSessionHandler?: CaseSessionWorkHandler;
  onState?: (lifecycle: ConnectorLifecycle) => void;
}

export class ConnectorPersistenceError extends Error {
  constructor(public readonly requestId?: string, public readonly status?: number) {
    super('Connector credential persistence failed; stop this installation and recover its saved rotation state');
    this.name = 'ConnectorPersistenceError';
  }
}

/** Safe enrollment diagnostics; never includes a response body or credentials. */
export class ConnectorEnrollmentError extends EnvoiError {
  constructor(code: string, public readonly requestId: string, status?: number) {
    super(`Envoi enrollment failed (${code}${status ? `; HTTP ${status}` : ''})`, status, code);
    this.name = 'ConnectorEnrollmentError';
  }
}

function enrollmentRejectionCode(payload: Record<string, unknown> | null) {
  if (payload?.code === 'ACTIVE_AGENT_LIMIT' || payload?.error === 'ACTIVE_AGENT_LIMIT') return 'ENROLLMENT_AGENT_LIMIT';
  if (payload?.error === 'AUTH_UNAVAILABLE') return 'ENROLLMENT_AUTH_UNAVAILABLE';
  switch (payload?.error === 'REQUEST_FAILED' ? payload.message : payload?.error) {
    case 'Enrollment token is invalid, expired, or already used': return 'ENROLLMENT_TOKEN_REJECTED';
    case 'Setup runtime does not match this enrollment': return 'ENROLLMENT_RUNTIME_MISMATCH';
    case 'Enrollment owner is invalid':
    case 'Reconnect owner is invalid': return 'ENROLLMENT_OWNER_INVALID';
    case 'That agent address is already taken': return 'ENROLLMENT_ADDRESS_TAKEN';
    default: return 'ENROLLMENT_HTTP_ERROR';
  }
}

export class ConnectorContractError extends Error {
  constructor() {
    super('Envoi fenced work API is unavailable; agent processing cannot start');
    this.name = 'ConnectorContractError';
  }
}

/** Trusted scoped host: this exact work cannot be retried. Never means processed. */
export class PermanentWorkError extends EnvoiError {
  constructor(code: string) {
    if (!/^[A-Z][A-Z0-9_]{0,119}$/.test(code)) throw new TypeError('Invalid permanent work reason');
    super('The runtime turn failed permanently; retain its journal and canonical failure receipt', undefined, code);
    this.name = 'PermanentWorkError';
  }
}

export class ConnectorCredentialsError extends EnvoiError {
  constructor() {
    super('Connector credentials are missing or expired; ask the owner to reconnect this existing agent', undefined, 'CREDENTIAL_EXPIRED');
    this.name = 'ConnectorCredentialsError';
  }
}

function apiOrigin(value: string): string {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new TypeError('Connector API URL must use HTTPS (or local HTTP for development)');
  }
  if (url.username || url.password || url.search || url.hash) throw new TypeError('Connector API URL cannot contain credentials or a query');
  return url.toString().replace(/\/$/, '');
}

function validSession(value: ConnectorSession | null): ConnectorSession {
  if (!value || !value.agentId || !value.inboxId || !value.agentApiToken || !value.agentRefreshToken ||
    !Number.isFinite(Date.parse(value.agentTokenExpiresAt)) || !Number.isFinite(Date.parse(value.agentRefreshTokenExpiresAt))) {
    throw new ConnectorCredentialsError();
  }
  return value;
}

async function refreshFingerprint(token: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function eventFrom(value: Record<string, unknown>): InboxEvent {
  if (typeof value.id !== 'string' || typeof value.type !== 'string' || typeof value.cursor !== 'string' || !value.cursor) {
    throw new EnvoiError('Envoi returned an invalid event');
  }
  return value as InboxEvent;
}

/** Redeems a one-use code; optional runtime binding is checked before consumption. */
export async function enrollConnector(baseUrl: string, enrollmentToken: string, store: ConnectorStore, options: ClientOptions & { name?: string; runtime?: ConnectorRuntime } = {}): Promise<ConnectorSession> {
  const origin = apiOrigin(baseUrl);
  if (!enrollmentToken) throw new TypeError('Enrollment token is required');
  if (options.runtime !== undefined && !CONNECTOR_RUNTIMES.includes(options.runtime)) throw new TypeError('Unsupported connector runtime');
  const controller = new AbortController();
  const duration = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > 300_000) throw new RangeError('timeoutMs must be an integer from 1 to 300000');
  const requestId = crypto.randomUUID();
  const timer = setTimeout(() => controller.abort(), duration);
  try {
    let response: Response;
    try {
      response = await (options.fetch || fetch)(`${origin}/api/agent-enroll`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-request-id': requestId },
        body: JSON.stringify({ enrollmentToken, ...(options.name ? { name: options.name } : {}), ...(options.runtime ? { runtime: options.runtime } : {}) }), signal: controller.signal
      });
    } catch {
      throw new ConnectorEnrollmentError(controller.signal.aborted ? 'ENROLLMENT_TIMEOUT' : 'ENROLLMENT_TRANSPORT_FAILED', requestId);
    }
    let payload: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = await response.json();
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
    } catch {
      if (controller.signal.aborted) throw new ConnectorEnrollmentError('ENROLLMENT_TIMEOUT', requestId, response.status);
      /* Never expose provider response bodies. */
    }
    if (!response.ok) throw new ConnectorEnrollmentError(enrollmentRejectionCode(payload), requestId, response.status);
    const agent = payload?.agent as Record<string, unknown> | undefined;
    const inbox = payload?.inbox as Record<string, unknown> | undefined;
    let session: ConnectorSession;
    try {
      session = validSession({
        agentId: String(agent?.id || ''), inboxId: String(inbox?.id || ''), address: String(agent?.address || ''),
        agentApiToken: String(payload?.agentApiToken || ''), agentRefreshToken: String(payload?.agentRefreshToken || ''),
        agentTokenExpiresAt: String(payload?.agentTokenExpiresAt || ''),
        agentRefreshTokenExpiresAt: String(payload?.agentRefreshTokenExpiresAt || ''), cursor: null,
        lifecycle: { state: agent?.status === 'paused' ? 'PAUSED' : 'STARTING', paused: agent?.status === 'paused', changedAt: new Date().toISOString(), failures: 0 }
      });
    } catch { throw new ConnectorEnrollmentError('ENROLLMENT_RESPONSE_INVALID', requestId, response.status); }
    if (!session.address) throw new ConnectorEnrollmentError('ENROLLMENT_RESPONSE_INVALID', requestId, response.status);
    try { await store.save(session); } catch { throw new ConnectorPersistenceError(requestId, response.status); }
    return session;
  } finally { clearTimeout(timer); }
}

export class EnvoiConnector {
  private readonly origin: string;
  private readonly pageSize: number;
  private readonly refreshSkewMs: number;
  private writes: Promise<unknown> = Promise.resolve();
  private actionEpoch = 0;
  private persistenceFailed = false;
  private readonly observedErrors = new WeakSet<EnvoiError>();
  private wake = new AbortController();
  private readonly activeActions = new Set<AbortController>();
  private readonly activeRefresh = new Set<AbortController>();
  private readonly activeWork = new Set<AbortController>();
  private stateObserver?: (lifecycle: ConnectorLifecycle) => void;
  private refreshInFlight: Promise<ConnectorSession> | null = null;
  private workInFlight: Promise<boolean> | null = null;
  private explicitScopedBatch = false;
  private workFollowup = false;
  private nextClaimAt = Infinity;
  private wakeTrigger?: () => void;
  private readonly activeStreams = new Set<AbortController>();
  private readonly activeCaseSessions = new Set<CaseSessionChannel>();
  private readonly activeLeaseChecks = new Map<() => Promise<void>, AbortController>();
  private caseSessionsAvailable = false;
  private readonly mintingCaseWork = new Set<string>();
  private readonly syntheticFixtureUses = new Set<string>();
  private readonly controlProbeLeases = new Map<string,{workId:string;leaseExpiresAt:string;retired:boolean;processed:boolean;used:Set<string>}>();
  private wakeTransport: 'not_started' | 'connecting' | 'connected' | 'disconnected' = 'not_started';
  private lastWakeReadyAt?: string;
  private lastWakeEventAt?: string;
  private lastWorkClaimAt?: string;
  private lastWakeErrorCode?: string;

  constructor(baseUrl: string, private readonly store: ConnectorStore, private readonly options: ConnectorOptions = {}) {
    if (options.handler && options.caseSessionHandler) throw new TypeError('Choose one work handler; a scoped turn cannot fall back to a legacy handler');
    this.origin = apiOrigin(baseUrl);
    this.pageSize = options.pageSize ?? 100;
    this.refreshSkewMs = options.refreshSkewMs ?? 60_000;
    if (!Number.isSafeInteger(this.pageSize) || this.pageSize < 1 || this.pageSize > 200) throw new RangeError('pageSize must be from 1 to 200');
    if (options.pollIntervalMs !== undefined && (!Number.isSafeInteger(options.pollIntervalMs) || options.pollIntervalMs < 1)) throw new RangeError('pollIntervalMs must be positive');
    if (!Number.isSafeInteger(this.refreshSkewMs) || this.refreshSkewMs < 0) throw new RangeError('refreshSkewMs must be nonnegative');
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 300_000)) throw new RangeError('timeoutMs must be an integer from 1 to 300000');
  }

  /** Diagnostics contain no tokens. Lifecycle updates share the atomic credential record. */
  async lifecycle(): Promise<ConnectorLifecycle> {
    await this.writes;
    const session = validSession(await this.store.load());
    return session.lifecycle ?? { state: 'STARTING', paused: false, changedAt: new Date().toISOString(), failures: 0 };
  }

  /** Check saved terminal state before allocating a runtime or contacting a service. */
  async assertActive() { await this.guard(); }

  async start(): Promise<void> {
    await this.guard();
    const state = await this.lifecycle();
    if (!(await this.store.load())?.lifecycle) await this.transition('STARTING');
    if (state.state === 'STOPPED') await this.transition(state.paused ? 'PAUSED' : 'STARTING');
  }

  onState(observer: (lifecycle: ConnectorLifecycle) => void) { this.stateObserver = observer; }

  /** Live transport observations only; no inbox contents, cursor, or credentials. */
  wakeDiagnostics() {
    return { transport: this.wakeTransport, lastReadyAt: this.lastWakeReadyAt,
      lastEventAt: this.lastWakeEventAt, lastWorkClaimAt: this.lastWorkClaimAt,
      lastErrorCode: this.lastWakeErrorCode };
  }

  private mutate(update: (current: ConnectorSession) => ConnectorSession): Promise<ConnectorSession> {
    const write = this.writes.then(async () => {
      if (this.persistenceFailed) throw new ConnectorPersistenceError();
      const current = validSession(await this.store.load());
      const next = update(current);
      if (next === current) return current;
      try { await this.store.save(next); } catch {
        this.persistenceFailed = true;
        this.actionEpoch++;
        for (const controller of [...this.activeActions, ...this.activeWork, ...this.activeRefresh]) controller.abort();
        throw new ConnectorPersistenceError();
      }
      return next;
    });
    this.writes = write.then(() => undefined, () => undefined);
    return write;
  }

  private async transition(state: ConnectorState, patch: Partial<ConnectorLifecycle> = {}, expectedEpoch?: number): Promise<void> {
    let applied = false;
    const next = await this.mutate(current => {
      if (expectedEpoch !== undefined && expectedEpoch !== this.actionEpoch) return current;
      const previous = current.lifecycle ?? { state: 'STARTING', paused: false, changedAt: new Date().toISOString(), failures: 0 };
      // A terminal installation can only be replaced by explicit owner enrollment.
      if (['REVOKED', 'NEEDS_RECONNECT'].includes(previous.state)) return current;
      if (['REVOKED', 'NEEDS_RECONNECT'].includes(state)) for (const controller of this.activeRefresh) controller.abort();
      applied = true;
      const lifecycle = { ...previous, ...patch, state, changedAt: new Date().toISOString() };
      if (previous.paused && !lifecycle.paused) this.actionEpoch++;
      if (lifecycle.paused || ['REVOKED', 'NEEDS_RECONNECT', 'STOPPED'].includes(state)) {
        this.actionEpoch++;
        for (const controller of [...this.activeActions, ...this.activeWork]) controller.abort();
        for (const channel of this.activeCaseSessions) channel.invalidate(new EnvoiError('Case session ended', 401, 'CASE_SESSION_ENDED', {
          reason: lifecycle.paused ? 'agent_paused' : state === 'STOPPED' ? 'ended_by_host' : 'credential_ended'
        }));
      }
      return { ...current, lifecycle };
    });
    if (applied && next.lifecycle) {
      if (['REVOKED', 'NEEDS_RECONNECT', 'STOPPED'].includes(next.lifecycle.state)) for (const stream of this.activeStreams) stream.abort();
      this.wake.abort();
      // Observation hooks cannot bypass persistence or change request outcomes.
      try { this.options.onState?.(next.lifecycle); this.stateObserver?.(next.lifecycle); } catch { /* diagnostic only */ }
    }
  }

  /** Apply a stable response code. Unknown auth statuses never imply revoke or refresh. */
  async observeError(error: unknown, expectedEpoch?: number): Promise<void> {
    if (!(error instanceof EnvoiError) || this.observedErrors.has(error)) return;
    this.observedErrors.add(error);
    const policy = lifecyclePolicy(error);
    if (policy.lifecycle === 'UNCHANGED' || policy.lifecycle === 'NOT_APPLICABLE') return;
    const previous = await this.lifecycle();
    const failures = policy.lifecycle === 'DEGRADED' ? previous.failures + 1 : 0;
    await this.transition(policy.lifecycle, { code: error.code, reason: error.reason, guidance: guidanceText(policy.guidance),
      paused: policy.lifecycle === 'PAUSED' || previous.paused, failures,
      retryAt: failures ? new Date(Date.now() + retryDelay(failures, Math.random(), error.retryAfterSeconds)).toISOString() : undefined }, expectedEpoch);
  }

  /** Accept delta/SSE lifecycle events; credential.ended has no observation cursor. */
  async observeEvent(event: Record<string, unknown>, type = String(event.type ?? '')): Promise<void> {
    if (type === 'case_session.ended') {
      let matched = false;
      for (const channel of this.activeCaseSessions) matched = channel.observeEvent({ ...event, type }) || matched;
      if (matched && event.reason === 'agent_paused') await this.observeError(new EnvoiError('Paused', undefined, 'AGENT_PAUSED'));
      return;
    }
    if (type === 'credential.ended') {
      if (typeof event.code === 'string') await this.observeError(new EnvoiError('Credential ended', undefined, event.code,
        { reason: typeof event.reason === 'string' ? event.reason : undefined }));
      return;
    }
    const session = validSession(await this.store.load());
    if (event.agentId !== session.agentId) return;
    if (type === 'agent.paused') await this.observeError(new EnvoiError('Paused', undefined, 'AGENT_PAUSED'));
    if (type === 'agent.resumed') {
      await this.transition('RUNNING', { paused: false, failures: 0, retryAt: undefined, code: undefined, reason: undefined, guidance: undefined });
      this.wake.abort();
      this.wakeTrigger?.();
    }
  }

  private async guard(action = false): Promise<void> {
    if (this.persistenceFailed) throw new ConnectorPersistenceError();
    const lifecycle = await this.lifecycle();
    if (['REVOKED', 'NEEDS_RECONNECT'].includes(lifecycle.state))
      throw new EnvoiError(lifecycle.guidance ?? 'Ask the owner to reconnect this installation', undefined, lifecycle.code ?? 'CREDENTIAL_EXPIRED');
    if (action && (lifecycle.paused || lifecycle.state === 'STOPPED'))
      throw new EnvoiError(lifecycle.guidance ?? 'Connector actions are stopped', undefined, lifecycle.paused ? 'AGENT_PAUSED' : 'CONNECTOR_STOPPED');
  }

  private async healthy(): Promise<void> {
    const current = await this.lifecycle();
    if (current.state === 'STARTING' || current.state === 'DEGRADED')
      await this.transition(current.paused ? 'PAUSED' : 'RUNNING', { failures: 0, retryAt: undefined, code: current.paused ? 'AGENT_PAUSED' : undefined,
        guidance: current.paused ? guidanceText('wait_for_resume') : undefined });
  }

  private async freshSession(force = false): Promise<ConnectorSession> {
    await this.guard();
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = (async () => {
      const current = validSession(await this.store.load());
      if (!force && !current.pendingRotation && Date.parse(current.agentTokenExpiresAt) > Date.now() + this.refreshSkewMs) return current;
      if (Date.parse(current.agentRefreshTokenExpiresAt) <= Date.now()) throw new ConnectorCredentialsError();
      const fingerprint = await refreshFingerprint(current.agentRefreshToken);
      if (current.pendingRotation && current.pendingRotation.refreshTokenFingerprint !== fingerprint) throw new ConnectorCredentialsError();
      const pendingRotation = current.pendingRotation || { rotationId: crypto.randomUUID(), refreshTokenFingerprint: fingerprint, startedAt: new Date().toISOString() };
      if (!current.pendingRotation) await this.mutate(latest => ({ ...latest, pendingRotation }));
      await this.guard();
      const controller = new AbortController();
      this.activeRefresh.add(controller);
      let rotated: AgentTokens;
      try {
        rotated = await rotateAgentToken(this.origin, current.agentRefreshToken, pendingRotation.rotationId, {
          ...this.options, fetch: (input, init) => (this.options.fetch || fetch)(input, { ...init,
            signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal }) });
      } finally { this.activeRefresh.delete(controller); }
      await this.guard();
      // Read the latest record under the write queue: late rotations cannot erase a pause or cursor.
      return this.mutate(latest => {
        if (['REVOKED', 'NEEDS_RECONNECT'].includes(latest.lifecycle?.state ?? ''))
          throw new EnvoiError(latest.lifecycle?.guidance ?? 'Credential ended', undefined, latest.lifecycle?.code);
        const { pendingRotation: _completed, ...saved } = latest;
        return validSession({ ...saved, ...rotated });
      });
    })();
    try { return await this.refreshInFlight; }
    catch (error) { await this.observeError(error); throw error; }
    finally { this.refreshInFlight = null; }
  }

  private async withFreshSession<T>(run: (session: ConnectorSession, signal?: AbortSignal) => Promise<T>, action = false, independentStream = false): Promise<T> {
    await this.guard(action);
    const session = await this.freshSession();
    await this.guard(action);
    const epoch = this.actionEpoch;
    const controller = new AbortController();
    if (action) this.activeActions.add(controller);
    const invoke = async (current: ConnectorSession) => {
      await this.guard(action);
      if (action && epoch !== this.actionEpoch) throw new EnvoiError('Connector action was interrupted', undefined, 'REQUEST_CANCELLED');
      const result = await run(current, controller.signal);
      await this.guard(action);
      if (action && epoch !== this.actionEpoch) throw new EnvoiError('Connector action was interrupted');
      await this.healthy();
      return result;
    };
    try {
      try { return await invoke(session); }
      catch (error) {
        if (!(error instanceof EnvoiError) || lifecyclePolicy(error).retry !== 'refresh_then_retry_once') throw error;
        await this.guard(action);
        const current = validSession(await this.store.load());
        return await invoke(current.agentApiToken === session.agentApiToken ? await this.freshSession(true) : current);
      }
    } catch (error) {
      if (action && controller.signal.aborted) {
        await this.guard(action);
        throw new EnvoiError('Connector action was interrupted', undefined, 'REQUEST_CANCELLED');
      }
      if (!(independentStream && error instanceof EnvoiError && lifecyclePolicy(error).lifecycle === 'DEGRADED')) await this.observeError(error);
      throw error;
    } finally { this.activeActions.delete(controller); }
  }

  private withFreshClient<T>(operation: (client: EnvoiClient, session: ConnectorSession) => Promise<T>, action = true): Promise<T> {
    return this.withFreshSession((session, signal) => operation(new EnvoiClient(this.origin, session.agentApiToken,
      { ...this.options, fetch: (input, init) => (this.options.fetch || fetch)(input, { ...init,
        signal: init?.signal && signal ? AbortSignal.any([init.signal, signal]) : signal }) }), session), action);
  }

  /** Trusted bridge code may pass only this short-lived access token to a remote MCP provider. */
  async currentAccessToken(minValidityMs = this.refreshSkewMs): Promise<string> {
    if (this.options.caseSessionHandler) throw new EnvoiError('Scoped runtimes cannot expose installation access credentials', undefined, 'LEGACY_MODEL_ACCESS_DISABLED');
    if (!Number.isSafeInteger(minValidityMs) || minValidityMs < 0 || minValidityMs > 300_000) {
      throw new RangeError('minValidityMs must be an integer from 0 to 300000');
    }
    let session = await this.freshSession();
    if (Date.parse(session.agentTokenExpiresAt) <= Date.now() + minValidityMs) session = await this.freshSession(true);
    if (Date.parse(session.agentTokenExpiresAt) <= Date.now() + minValidityMs) {
      throw new ConnectorCredentialsError();
    }
    return session.agentApiToken;
  }

  /** One non-idempotent, separately approved synthetic setup write. The host must
   * persist its intent/reservation BEFORE invoking this and reconcile every unknown
   * result without retry. This method shares the normal refresh/store owner, exports
   * no credential, and deliberately does not use withFreshSession's 401 replay.
   * The REST route is NOT lease/session-fenced; expected work pins are operator
   * linkage, not a claim that operational authority became case-session authority.
   * Actual human-policy provenance is verified by the trusted receipt reader. */
  async evaluateSyntheticPolicyFixtureOnce(input:Readonly<SyntheticPolicyFixtureInput>, signal?:AbortSignal):Promise<SyntheticPolicyFixtureResult> {
    const refuse=(code:string):never=>{throw new EnvoiError('Synthetic authority fixture requires reconciliation',undefined,code);};
    const exact=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
      &&Object.keys(v).sort().join()===keys.sort().join();
    const sha=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
    if(!this.options.caseSessionHandler||!exact(input,['fixtureId','windowId','approvalSha256','approvalDecisionRaw','expected','expiresAt'])
      ||!sha(input.fixtureId)||!sha(input.windowId)||!sha(input.approvalSha256)||typeof input.approvalDecisionRaw!=='string'
      ||new TextEncoder().encode(input.approvalDecisionRaw).length>32768
      ||!exact(input.expected,['inboxId','agentId','installationId','caseId','workId','proposalId','optionId']))refuse('SYNTHETIC_FIXTURE_APPROVAL_REQUIRED');
    const expected=Object.freeze({...input.expected});
    const request=Object.freeze({fixtureId:input.fixtureId,windowId:input.windowId,expiresAt:input.expiresAt,
      approvalSha256:input.approvalSha256,approvalDecisionRaw:input.approvalDecisionRaw,expected});
    for(const [key,prefix]of Object.entries({inboxId:'inbox_',agentId:'agent_',installationId:'installation_',caseId:'case_',workId:'msg_',proposalId:'proposal_',optionId:'option_'}))
      if(typeof expected[key as keyof typeof expected]!=='string'||!new RegExp('^'+prefix+'[A-Za-z0-9_-]+$').test(expected[key as keyof typeof expected]))refuse('SYNTHETIC_FIXTURE_APPROVAL_REQUIRED');
    let decision:Record<string,unknown>;
    try{decision=JSON.parse(request.approvalDecisionRaw);}catch{return refuse('SYNTHETIC_FIXTURE_APPROVAL_REQUIRED');}
    if(!exact(decision,['purpose','version','ownerApproved','policyApprovalSha256','fixtureId','windowId','expected','expiresAt','notAfterUtc'])
      ||decision.purpose!=='phase-c-synthetic-expiry-fixture-execution'||decision.version!==1||decision.ownerApproved!==true
      ||!sha(decision.policyApprovalSha256)||decision.fixtureId!==request.fixtureId||decision.windowId!==request.windowId
      ||!exact(decision.expected,Object.keys(expected))||Object.keys(expected).some(key=>(decision.expected as Record<string,unknown>)[key]!==expected[key as keyof typeof expected])
      ||decision.expiresAt!==request.expiresAt||typeof decision.notAfterUtc!=='string')refuse('SYNTHETIC_FIXTURE_APPROVAL_REQUIRED');
    const expiry=Date.parse(request.expiresAt),stop=Date.parse(decision.notAfterUtc as string);
    if(!Number.isFinite(expiry)||!Number.isFinite(stop)||new Date(expiry).toISOString()!==request.expiresAt
      ||new Date(stop).toISOString()!==decision.notAfterUtc||expiry<=Date.now()||stop<=expiry||stop>Date.now()+900000)refuse('SYNTHETIC_FIXTURE_DEADLINE');
    const raw=request.approvalDecisionRaw;
    const actualHash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw)))].map(b=>b.toString(16).padStart(2,'0')).join('');
    if(actualHash!==request.approvalSha256)refuse('SYNTHETIC_FIXTURE_APPROVAL_REQUIRED');
    if(this.syntheticFixtureUses.has(request.fixtureId))refuse('SYNTHETIC_FIXTURE_ALREADY_ATTEMPTED');
    this.syntheticFixtureUses.add(request.fixtureId);
    signal?.throwIfAborted();await this.guard(true);
    const action=new AbortController();this.activeActions.add(action);
    const bounded=AbortSignal.any([action.signal,...(signal?[signal]:[]),AbortSignal.timeout(this.options.timeoutMs??30000)]);
    const epoch=this.actionEpoch;
    const check=async()=>{bounded.throwIfAborted();await this.guard(true);if(epoch!==this.actionEpoch)refuse('REQUEST_CANCELLED');if(Date.now()>=expiry||Date.now()>=stop)refuse('SYNTHETIC_FIXTURE_DEADLINE');};
    const read=async(response:Response):Promise<Record<string,unknown>>=>{
      const reader=response.body?.getReader();if(!reader)return refuse('SYNTHETIC_FIXTURE_RESULT_UNKNOWN');
      const chunks:Uint8Array[]=[];let size=0;
      const cancel=()=>{void reader.cancel().catch(()=>{});};
      bounded.addEventListener('abort',cancel,{once:true});
      try{while(true){bounded.throwIfAborted();const part=await abortableTurn(()=>reader.read(),bounded);if(part.done)break;size+=part.value.length;if(size>65536){cancel();refuse('SYNTHETIC_FIXTURE_RESULT_UNKNOWN');}chunks.push(part.value);}}
      finally{bounded.removeEventListener('abort',cancel);reader.releaseLock();}
      const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
      return responsePayload<Record<string,unknown>>(new Response(bytes,{status:response.status,headers:response.headers}),'Synthetic fixture request failed');
    };
    try{
      const session=await abortableTurn(()=>this.freshSession(),bounded);await check();
      if(session.agentId!==expected.agentId||session.inboxId!==expected.inboxId)refuse('SYNTHETIC_FIXTURE_IDENTITY_MISMATCH');
      const fetcher=this.options.fetch??fetch;
      const boundedFetch=async(url:string,init:RequestInit)=>abortableTurn(async()=>{
        const response=await fetcher(url,init);
        if(bounded.aborted){void response.body?.cancel().catch(()=>{});bounded.throwIfAborted();}
        return response;
      },bounded);
      const status=await read(await boundedFetch(this.origin+'/api/agent/status',{headers:{authorization:'Bearer '+session.agentApiToken},credentials:'omit',redirect:'error',signal:bounded}));
      await check();
      if(status.state!=='active'||status.inboxId!==expected.inboxId||(status.agent as {id?:unknown})?.id!==expected.agentId
        ||(status.installation as {id?:unknown})?.id!==expected.installationId)refuse('SYNTHETIC_FIXTURE_IDENTITY_MISMATCH');
      const response=await boundedFetch(`${this.origin}/api/inboxes/${encodeURIComponent(expected.inboxId)}/cases/${encodeURIComponent(expected.caseId)}/policy-evaluations`,{
        method:'POST',credentials:'omit',redirect:'error',signal:bounded,headers:{'content-type':'application/json',authorization:'Bearer '+session.agentApiToken},
        body:JSON.stringify({requestedAction:'proposal.accept',actionPayload:{proposalId:expected.proposalId,optionId:expected.optionId},expiresAt:request.expiresAt,grantType:'oneTime'})});
      const result=await read(response);await check();
      if(response.status!==201||typeof result.id!=='string'||!/^policy_eval_[A-Za-z0-9_-]+$/.test(result.id)||result.actor!==expected.agentId
        ||result.requestedAction!=='proposal.accept'||!['needsHuman','deny','allow'].includes(String(result.decision))||result.expiresAt!==request.expiresAt)refuse('SYNTHETIC_FIXTURE_RESULT_UNKNOWN');
      return{id:result.id as string,actor:expected.agentId,requestedAction:'proposal.accept',decision:result.decision as SyntheticPolicyFixtureResult['decision'],expiresAt:request.expiresAt};
    }catch(error){
      if(error instanceof EnvoiError){await this.observeError(error);throw new EnvoiError('Synthetic authority fixture stopped; reconcile its existing intent',error.status,error.code??'SYNTHETIC_FIXTURE_RESULT_UNKNOWN');}
      await this.guard(true);
      throw new EnvoiError('Synthetic authority fixture stopped; reconcile its existing intent',undefined,bounded.aborted?'REQUEST_CANCELLED':'SYNTHETIC_FIXTURE_RESULT_UNKNOWN');
    }finally{this.activeActions.delete(action);}
  }

  get wakeOrigin(): string { return this.origin; }

  /** One actual server-denial probe against a captured retired claim. It cannot
   * settle a live lease, refresh a revoked credential, or replay an uncertain POST.
   * Returned raw envelopes stay in the trusted operator, never model context. */
  async probeStaleControlSettlementOnce(input:Readonly<StaleControlSettlementProbe>,options:{signal:AbortSignal}) {
    const refuse=(code:string):never=>{throw new EnvoiError('Retired control probe requires reconciliation',undefined,code);};
    const request=Object.freeze({...input});
    if(!this.options.caseSessionHandler||Object.keys(request).sort().join()!=='expected,leaseExpiresAt,leaseToken,workId'
      ||!/^msg_[A-Za-z0-9_-]+$/.test(request.workId)||!['paused','revoked','expired'].includes(request.expected))refuse('ACTUAL_RETIRED_CONTROL_LEASE_REQUIRED');
    const lease=this.controlProbeLeases.get(request.leaseToken);
    const eligible=()=>{if(!lease||lease.workId!==request.workId||lease.leaseExpiresAt!==request.leaseExpiresAt||!lease.retired||lease.processed
      ||request.expected==='expired'&&Date.now()<Date.parse(lease.leaseExpiresAt)+1500)refuse('ACTUAL_RETIRED_CONTROL_LEASE_REQUIRED');};
    eligible();if(lease!.used.has(request.expected))refuse('CONTROL_PROBE_ALREADY_ATTEMPTED');
    lease!.used.add(request.expected); // Burn before any await; unknown outcomes are not retried.
    const signal=AbortSignal.any([options.signal,AbortSignal.timeout(Math.min(this.options.timeoutMs??30000,30000))]);
    const fetcher=this.options.fetch??fetch;
    const exchange=async(url:string,init:RequestInit)=>abortableTurn(async()=>{
      signal.throwIfAborted();const response=await fetcher(url,{...init,credentials:'omit',redirect:'error',signal});
      if(signal.aborted){void response.body?.cancel().catch(()=>{});signal.throwIfAborted();}
      const reader=response.body?.getReader();if(!reader)return refuse('CONTROL_PROBE_RESULT_UNKNOWN');
      const chunks:Uint8Array[]=[];let length=0;
      const cancel=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
      try{while(true){const part=await abortableTurn(()=>reader.read(),signal);if(part.done)break;length+=part.value.length;
        if(length>65536){cancel();refuse('CONTROL_PROBE_RESULT_UNKNOWN');}chunks.push(part.value);}}
      finally{signal.removeEventListener('abort',cancel);reader.releaseLock();}
      const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
      const raw=new TextDecoder().decode(bytes);let value:Record<string,unknown>;
      try{value=JSON.parse(raw);}catch{return refuse('CONTROL_PROBE_RESULT_UNKNOWN');}
      if(!value||typeof value!=='object'||Array.isArray(value))refuse('CONTROL_PROBE_RESULT_UNKNOWN');
      return{status:response.status,raw,value};
    },signal);
    try{
      signal.throwIfAborted();
      const session=request.expected==='revoked'?validSession(await this.store.load()):await abortableTurn(()=>this.freshSession(),signal);
      signal.throwIfAborted();eligible();
      const status=await exchange(this.origin+'/api/agent/status',{headers:{authorization:'Bearer '+session.agentApiToken}});
      if(request.expected==='revoked'){
        if(![401,403].includes(status.status)||!['CREDENTIAL_REVOKED','REVOKED'].includes(String(status.value.code)))refuse('ACTUAL_CONTROL_PRECONDITION_REQUIRED');
      }else if(status.status!==200||status.value.inboxId!==session.inboxId||(status.value.agent as {id?:unknown})?.id!==session.agentId
        ||status.value.state!==(request.expected==='paused'?'paused':'active'))refuse('ACTUAL_CONTROL_PRECONDITION_REQUIRED');
      signal.throwIfAborted();eligible();
      const settlement=await exchange(this.origin+'/api/agent/work/'+encodeURIComponent(request.workId)+'/complete',{
        method:'POST',headers:{authorization:'Bearer '+session.agentApiToken,'content-type':'application/json','Idempotency-Key':'control-denial:'+crypto.randomUUID()},
        body:JSON.stringify({leaseToken:request.leaseToken})});
      if(settlement.status>=200&&settlement.status<300){await this.transition('STOPPED');return refuse('STALE_CONTROL_UNEXPECTEDLY_PROCESSED');}
      return{status:Object.freeze({status:status.status,raw:status.raw}),settlement:Object.freeze({status:settlement.status,raw:settlement.raw})};
    }catch(error){
      if(error instanceof EnvoiError)throw error;
      throw new EnvoiError('Retired control probe stopped; do not repeat its POST',undefined,signal.aborted?'REQUEST_CANCELLED':'CONTROL_PROBE_RESULT_UNKNOWN');
    }
  }

  async wakeRequest(route: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const read = body === undefined && ['/api/agent/status', '/api/agent/wake-subscriptions'].includes(route);
    const create = route === '/api/agent/wake-subscriptions' && body && Object.keys(body).length === 1 && typeof body.url === 'string';
    const activate = /^\/api\/agent\/wake-subscriptions\/wake_sub_[A-Za-z0-9_-]{3,64}\/activate$/.test(route)
      && body && Object.keys(body).length === 1 && typeof body.challenge === 'string';
    const end = /^\/api\/agent\/wake-subscriptions\/wake_sub_[A-Za-z0-9_-]{3,64}\/end$/.test(route) && body && Object.keys(body).length === 0;
    if (!read && !create && !activate && !end) throw new TypeError('Invalid trusted wake operation');
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    return this.withFreshSession(async (session, controller) => {
      signal?.throwIfAborted();
      const deadline = AbortSignal.timeout(10_000);
      let response: Response;
      try {
        response = await (this.options.fetch || fetch)(`${this.origin}${route}`, {
          method: body === undefined ? 'GET' : 'POST', credentials: 'omit', redirect: 'error',
          headers: { authorization: `Bearer ${session.agentApiToken}`, ...(body ? { 'content-type': 'application/json' } : {}) },
          ...(serialized !== undefined ? { body: serialized } : {}), signal: AbortSignal.any([deadline, controller!, ...(signal ? [signal] : [])])
        });
      } catch { throw new EnvoiError('Wake service is unavailable', undefined, signal?.aborted ? 'REQUEST_CANCELLED' : 'NETWORK_ERROR'); }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (reader) {
          const next = await reader.read();
          if (next.done) break;
          length += next.value.length;
          if (length > 16 * 1024 * 1024) throw new Error();
          chunks.push(next.value);
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        const bounded = new Response(bytes, { status: response.status, headers: response.headers });
        signal?.throwIfAborted();
        if (!response.ok) {
          const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Record<string, unknown>;
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error();
          const code = typeof payload.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(payload.code) ? payload.code : undefined;
          const reason = typeof payload.reason === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(payload.reason) ? payload.reason : undefined;
          const requestId = typeof payload.requestId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(payload.requestId) ? payload.requestId : undefined;
          const retryHeader = response.headers.get('retry-after');
          const retry = Math.max(retryHeader && /^\d{1,6}$/.test(retryHeader) ? Number(retryHeader) : 0, typeof payload.retryAfterSeconds === 'number' && Number.isSafeInteger(payload.retryAfterSeconds) && payload.retryAfterSeconds >= 0 ? payload.retryAfterSeconds : 0);
          throw new EnvoiError('Wake request was refused', response.status, code, { reason, requestId, ...(retry ? { retryAfterSeconds: Math.min(retry, 86_400) } : {}) });
        }
        return await responsePayload(bounded, 'Wake request was refused');
      } catch (error) {
        if (signal?.aborted) throw new EnvoiError('Wake request was cancelled', undefined, 'REQUEST_CANCELLED');
        if (deadline.aborted) throw new EnvoiError('Wake request timed out', undefined, 'TIMEOUT');
        if (error instanceof EnvoiError) throw error;
        // A proxy may return HTML or an empty body for a temporary 429/5xx.
        // Preserve a valid canonical error envelope; classify only malformed replies by status.
        if (response.status === 429 || response.status >= 500) {
          const header = response.headers.get('retry-after');
          const seconds = header && /^\d{1,6}$/.test(header) ? Math.min(Number(header), 86_400) : 0;
          throw new EnvoiError('Wake service is temporarily unavailable', response.status,
            response.status === 429 ? 'RATE_LIMITED' : 'NETWORK_ERROR',
            seconds ? { retryAfterSeconds: seconds } : undefined);
        }
        throw new EnvoiError('Invalid wake response');
      } finally { await reader?.cancel().catch(() => {}); }
    }, false);
  }

  /** Mint a short-lived MCP read credential for a single provider turn. Never send refresh credentials to a provider. */
  mintMcpReadToken(caseId: string | null = null): Promise<McpReadToken> {
    if (this.options.caseSessionHandler) throw new EnvoiError('Scoped runtimes cannot mint legacy model credentials', undefined, 'LEGACY_MODEL_ACCESS_DISABLED');
    if (caseId !== null && (typeof caseId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(caseId))) {
      throw new TypeError('A safe case ID is required for an MCP read token');
    }
    return this.withFreshSession(async (session, actionSignal) => {
      const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 30_000);
      let response: Response;
      try {
        response = await (this.options.fetch || fetch)(`${this.origin}/api/agent/mcp-read-token`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.any([timeout, actionSignal!]),
          headers: { authorization: `Bearer ${session.agentApiToken}`, 'content-type': 'application/json' },
          body: JSON.stringify(caseId === null ? {} : { caseId })
        });
      } catch { throw new EnvoiError(timeout.aborted ? 'Envoi MCP token request timed out' : 'Envoi MCP token service could not be reached', undefined, actionSignal?.aborted ? 'REQUEST_CANCELLED' : 'NETWORK_ERROR'); }
      if (!response.ok) await responsePayload(response, 'Envoi MCP read credential was denied');
      let payload: Record<string, unknown>;
      try { payload = await response.json() as Record<string, unknown>; }
      catch { throw new EnvoiError('Envoi returned an invalid MCP read credential'); }
      if (!payload || typeof payload.mcpAccessToken !== 'string' || !payload.mcpAccessToken ||
          payload.tokenType !== 'Bearer' || payload.scope !== 'case_read' || payload.caseId !== caseId ||
          typeof payload.expiresAt !== 'string' || Date.parse(payload.expiresAt) <= Date.now() + 120_000) {
        throw new EnvoiError('Envoi returned an invalid or short-lived MCP read credential');
      }
      return payload as unknown as McpReadToken;
    }, true);
  }

  /** Trusted host only: forwards MCP JSON-RPC without exposing the rotating refresh token. */
  forwardMcpRequest(body: string, { protocolVersion, signal }: { protocolVersion?: string; signal?: AbortSignal } = {}): Promise<Response> {
    if (this.options.caseSessionHandler) throw new EnvoiError('Scoped runtimes cannot use privileged legacy MCP', undefined, 'LEGACY_MODEL_ACCESS_DISABLED');
    if (protocolVersion && !/^\d{4}-\d{2}-\d{2}$/.test(protocolVersion)) throw new TypeError('Invalid MCP protocol version');
    return this.withFreshSession(async (session, actionSignal) => {
      const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 30_000);
      const requestSignal = AbortSignal.any([timeout, actionSignal!, ...(signal ? [signal] : [])]);
      let response: Response;
      try {
        response = await (this.options.fetch || fetch)(`${this.origin}/mcp`, {
          method: 'POST', redirect: 'error', signal: requestSignal, body,
          headers: {
            authorization: `Bearer ${session.agentApiToken}`,
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {})
          }
        });
      } catch {
        throw new EnvoiError(requestSignal.aborted ? 'Envoi MCP request timed out or canceled' : 'Envoi MCP could not be reached', undefined, actionSignal?.aborted ? 'REQUEST_CANCELLED' : 'NETWORK_ERROR');
      }
      if (!response.ok) await responsePayload(response.clone(), 'Envoi MCP request failed');
      return response;
    }, true);
  }

  /** Status reporting remains available while paused and observes the same credential codes. */
  reportConnectionStatus(body: Record<string, unknown>): Promise<void> {
    return this.withFreshSession(async session => {
      let response: Response;
      try { response = await (this.options.fetch || fetch)(`${this.origin}/api/agent/connection-status`, {
        method: 'POST', headers: { authorization: `Bearer ${session.agentApiToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000) }); }
      catch { throw new EnvoiError('Envoi status service could not be reached', undefined, 'NETWORK_ERROR'); }
      if (!response.ok) await responsePayload(response, 'Envoi could not record setup checks');
      else await response.body?.cancel();
    });
  }

  /** First message of a new case; persist the ID and idempotency key before calling. */
  startCase(idempotencyKey: string, input: Omit<CaseMessageInput, 'senderAgentId'>) {
    return this.withFreshClient((client, session) => client.startCase(session.inboxId, idempotencyKey, { ...input, senderAgentId: session.agentId }));
  }

  sendCaseEvent(idempotencyKey: string, input: Omit<CaseMessageInput, 'senderAgentId'>) {
    return this.withFreshClient((client, session) => client.sendCaseEvent(session.inboxId, idempotencyKey, { ...input, senderAgentId: session.agentId }));
  }

  listCases(limit = 50, before?: string) {
    return this.withFreshClient((client, session) => client.listCases(session.inboxId, limit, before), false);
  }

  getCase(caseId: string) {
    return this.withFreshClient((client, session) => client.getCase(session.inboxId, caseId), false);
  }

  listCaseMessages(caseId: string, limit = 50, before?: string) {
    return this.withFreshClient((client, session) => client.listCaseMessages(session.inboxId, caseId, limit, before), false);
  }

  beginAssetUpload(idempotencyKey: string, input: AssetUploadInput) {
    return this.withFreshClient((client, session) => client.beginAssetUpload(session.inboxId, idempotencyKey, input));
  }

  completeAssetUpload(assetId: string) {
    return this.withFreshClient((client, session) => client.completeAssetUpload(session.inboxId, assetId));
  }

  grantCaseAsset(assetId: string, caseId: string, recipientAgentId: string, idempotencyKey: string) {
    return this.withFreshClient((client, session) => client.grantCaseAsset(session.inboxId, assetId, caseId, recipientAgentId, idempotencyKey));
  }

  listAssets() {
    return this.withFreshClient((client, session) => client.listAssets(session.inboxId), false);
  }

  getCleanAssetDownload(assetId: string) {
    return this.withFreshClient((client, session) => client.getCleanAssetDownload(session.inboxId, assetId), false);
  }

  private async postWork<T>(path: string, body: Record<string, unknown>, idempotencyKey?: string, signal?: AbortSignal, scopedResponse = false): Promise<T> {
    return this.withFreshSession(async (session, actionSignal) => {
      signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 30_000);
      let response: Response;
      try {
        response = await (this.options.fetch || fetch)(`${this.origin}${path}`, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.agentApiToken}`,
            ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
          body: JSON.stringify(body), signal: AbortSignal.any([timeout, actionSignal!, ...(signal ? [signal] : [])])
        });
      } catch { throw new EnvoiError(timeout.aborted ? 'Envoi request timed out' : 'Envoi could not be reached', undefined, actionSignal?.aborted ? 'REQUEST_CANCELLED' : timeout.aborted ? 'TIMEOUT' : 'NETWORK_ERROR'); }
      signal?.throwIfAborted();
      const result = await (scopedResponse ? caseSessionResponse<T>(response) : responsePayload<T>(response, 'Envoi work request failed'));
      signal?.throwIfAborted();
      return result;
    }, true);
  }

  async mintCaseSession(work: WorkLease, options: { signal?: AbortSignal; installationId?: string; onInvalidated?: (error: EnvoiError) => void } = {}): Promise<CaseSessionChannel> {
    if (this.mintingCaseWork.has(work.workId)) throw new TypeError('A case session mint is already in flight for this work');
    this.mintingCaseWork.add(work.workId);
    try { return await this.createCaseSession(work, options); }
    finally { this.mintingCaseWork.delete(work.workId); }
  }

  private async createCaseSession(work: WorkLease, options: { signal?: AbortSignal; installationId?: string; onInvalidated?: (error: EnvoiError) => void }): Promise<CaseSessionChannel> {
    options.signal?.throwIfAborted();
    if (isHumanDecisionMessage(work.message)) assertHumanDecisionMessage(work.message);
    if (!/^msg_[A-Za-z0-9_-]+$/.test(work.workId) || typeof work.leaseToken !== 'string' || work.leaseToken.length < 1 || work.leaseToken.length > 256
      || !work.message.caseId || !Number.isFinite(Date.parse(work.leaseExpiresAt)) || Date.parse(work.leaseExpiresAt) <= Date.now()) throw new TypeError('A live case-bound work lease is required');
    await this.checkStatus();
    options.signal?.throwIfAborted();
    if (!this.caseSessionsAvailable) throw new EnvoiError('Case sessions are unavailable; update the server before processing', 404, 'FEATURE_DISABLED');
    const identity = validSession(await this.store.load());
    if (work.message.recipientAgentId !== identity.agentId) throw new EnvoiError('Work belongs to another agent', undefined, 'CASE_SESSION_RESPONSE_INVALID');
    if (isHumanDecisionMessage(work.message) && work.message.recipientInboxId !== identity.inboxId) throw new EnvoiError('Work belongs to another inbox', undefined, 'CASE_SESSION_RESPONSE_INVALID');
    const path = `/api/agent/work/${encodeURIComponent(work.workId)}/session`;
    const payload = await this.postWork<unknown>(path, { leaseToken: work.leaseToken }, undefined, options.signal, true);
    options.signal?.throwIfAborted();
    let channel: CaseSessionChannel;
    channel = new CaseSessionChannel(payload, {
      agentId: identity.agentId, installationId: options.installationId,
      workId: work.workId, caseId: work.message.caseId,
      workKind: isHumanInstructionMessage(work.message) ? 'human_instruction' : isHumanDecisionMessage(work.message) ? 'human_decision' : 'agent_message',
      counterpartyAddress: isHumanDecisionMessage(work.message) ? work.message.counterpartyAddress : work.message.from.address, agentAddress: identity.address
    }, {
      origin: this.origin, fetch: this.options.fetch, timeoutMs: this.options.timeoutMs,
      signal: options.signal, assertActive: () => this.guard(true),
      onInvalidated: error => { this.activeCaseSessions.delete(channel); options.onInvalidated?.(error); },
      end: async sessionId => {
        const ended = await this.postWork<{ session: { id: string; status: string } }>(`${path}/end`, { leaseToken: work.leaseToken, sessionId }, undefined, undefined, true);
        if (ended.session?.id !== sessionId || ended.session.status !== 'ended') throw new EnvoiError('Envoi returned an invalid case session end', undefined, 'CASE_SESSION_RESPONSE_INVALID');
      }
    });
    if (!channel.signal.aborted) this.activeCaseSessions.add(channel);
    return channel;
  }

  private async reply(message: WorkMessage, text: string, idempotencyKey: string, extra: Omit<NativeMessageInput, 'senderAgentId' | 'recipientEmail' | 'text' | 'caseId'> = {}, leaseToken?: string): Promise<unknown> {
    if (isHumanDecisionMessage(message)) throw new EnvoiError('Human decisions require the scoped tool channel', undefined, 'LEGACY_MODEL_ACCESS_DISABLED');
    if (isHumanInstructionMessage(message)) {
      assertHumanInstructionMessage(message);
      if (!idempotencyKey || idempotencyKey.length > 200 || /[\x00-\x1f\x7f]/.test(idempotencyKey)) throw new TypeError('A stable reply idempotency key is required');
      if (Object.keys(extra).length) throw new TypeError('Human instruction replies accept text only');
      if (!leaseToken) throw new TypeError('A current work lease token is required for a human instruction reply');
      const reply = await this.postWork<HumanInstructionReply>(`/api/agent/instructions/${encodeURIComponent(message.id)}/reply`, { text, leaseToken }, idempotencyKey);
      if (typeof reply.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(reply.id)
        || reply.kind !== 'humanInstructionReply' || reply.inReplyTo !== message.id || reply.caseId !== message.caseId
        || reply.inboxId !== message.recipientInboxId || reply.senderInboxId !== message.recipientInboxId || reply.recipientInboxId !== message.recipientInboxId
        || reply.senderType !== 'agent' || reply.senderAgentId !== message.recipientAgentId || reply.recipientHumanId !== message.senderHumanId
        || reply.from?.agentId !== message.recipientAgentId || typeof reply.from?.address !== 'string' || !reply.from.address
        || reply.type !== 'message' || reply.status !== 'delivered' || reply.text !== text.trim()) {
        throw new EnvoiError('Envoi returned an invalid human instruction reply');
      }
      return reply;
    }
    if (!idempotencyKey || !message.from?.address) throw new TypeError('A stable reply idempotency key and sender address are required');
    return this.withFreshClient((client, session) => client.sendMessage(
      session.inboxId, idempotencyKey,
      { ...extra, senderAgentId: session.agentId, recipientEmail: message.from.address, text, ...(message.caseId ? { caseId: message.caseId } : {}) }
    ));
  }

  scopedWakeWorkDriver(): ScopedWakeWorkDriver {
    const handler = this.options.caseSessionHandler;
    const assertScoped = () => {
      if (!handler || this.options.caseSessionHandler !== handler || this.options.handler)
        throw new EnvoiError('A scoped CaseSession handler is required for wake processing', undefined, 'SCOPED_HANDLER_REQUIRED');
    };
    assertScoped();
    const localCancellation = (error: unknown) => error instanceof EnvoiError
      && ['CASE_CONTROLLED', 'WORK_LEASE_STALE', 'WORK_NOT_ELIGIBLE', 'WORK_NOT_FOUND', 'CASE_SESSION_ENDED', 'CASE_SESSION_EXPIRED', 'REQUEST_CANCELLED'].includes(error.code ?? '');
    return Object.freeze({
      processWorkOnce: (signal?: AbortSignal) => {
        assertScoped();
        return this.processWorkOnce(signal).catch(error => {
          if (localCancellation(error) && !signal?.aborted) return true;
          if (error instanceof EnvoiError && ['AGENT_PAUSED', 'FEATURE_DISABLED'].includes(error.code ?? '') && !signal?.aborted) return false;
          throw error;
        });
      },
      processWorkBatch: (expectations: readonly ScopedWorkExpectation[], signal?: AbortSignal) => {
        assertScoped();
        return this.processScopedWorkBatch(expectations, signal);
      },
      revalidateLiveLeases: async (signal?: AbortSignal) => {
        assertScoped();
        signal?.throwIfAborted();
        const leases = [...this.activeLeaseChecks];
        const checks = leases.map(([renew]) => renew().catch(error => { if (!localCancellation(error)) throw error; }));
        try {
          await Promise.all([this.checkStatus().then(async () => {
            await this.guard(true);
            if (!this.caseSessionsAvailable) throw new EnvoiError('Case sessions are unavailable', 404, 'FEATURE_DISABLED');
          }), ...checks]);
          signal?.throwIfAborted();
        } catch (error) {
          for (const [, controller] of leases) controller.abort();
          if (error instanceof EnvoiError && ['AGENT_PAUSED', 'FEATURE_DISABLED'].includes(error.code ?? '') && !signal?.aborted) return;
          throw error;
        }
      },
      nextAvailableInMs: () => { assertScoped(); return Number.isFinite(this.nextClaimAt) ? Math.max(0, this.nextClaimAt - Date.now()) : undefined; }
    });
  }

  /** Handles canonical work. True means work was consumed, including a permanent failure; consult its receipt for success. */
  processWorkOnce(signal?: AbortSignal): Promise<boolean> {
    if (this.explicitScopedBatch) return Promise.reject(new EnvoiError('An explicit scoped batch owns work processing', undefined, 'SCOPED_BATCH_IN_FLIGHT'));
    if (this.workInFlight) { this.workFollowup = true; return this.workInFlight; }
    this.workInFlight = (async () => {
      let worked = false;
      do {
        this.workFollowup = false;
        worked = await this.processWorkAttempt(signal) || worked;
      } while (this.workFollowup && !signal?.aborted);
      return worked;
    })().finally(() => { this.workInFlight = null; this.workFollowup = false; });
    return this.workInFlight;
  }

  private async processScopedWorkBatch(expectations: readonly ScopedWorkExpectation[], signal?: AbortSignal): Promise<readonly ScopedWorkOutcome[]> {
    if (this.explicitScopedBatch || this.workInFlight) throw new EnvoiError('Work processing is already in flight', undefined, 'SCOPED_BATCH_IN_FLIGHT');
    if (!Array.isArray(expectations) || expectations.length < 1 || expectations.length > 2
      || expectations.some(e => !e || !/^msg_[A-Za-z0-9_-]+$/.test(e.workId) || !/^case_[A-Za-z0-9_-]+$/.test(e.caseId))
      || new Set(expectations.map(e => e.workId)).size !== expectations.length || new Set(expectations.map(e => e.caseId)).size !== expectations.length)
      throw new TypeError('At most two distinct exact scoped work/case expectations are required');
    const expected = expectations.map(e => Object.freeze({workId:e.workId,caseId:e.caseId}));
    this.explicitScopedBatch = true;
    const stop = new AbortController(), batchSignal = AbortSignal.any([stop.signal,...(signal ? [signal] : [])]);
    let admit!: () => void, refuseAdmission!: (reason: unknown) => void;
    const barrier = new Promise<void>((resolve,reject) => {admit=resolve;refuseAdmission=reject;});void barrier.catch(()=>{});
    const flights: Promise<boolean>[] = [];
    try {
      for (const item of expected) {
        batchSignal.throwIfAborted();
        const work = await this.claimWorkAttempt(batchSignal);
        if (!work || work.workId !== item.workId || work.message.caseId !== item.caseId)
          throw new EnvoiError('Claim does not match the explicit scoped batch', undefined, 'SCOPED_BATCH_CLAIM_MISMATCH');
        // Start the existing per-work lease lifecycle now, but neither admit nor
        // run a handler until every serial claim has been validated.
        const flight = this.processClaimedWork(work,batchSignal,()=>barrier);void flight.catch(()=>{});flights.push(flight);
      }
      batchSignal.throwIfAborted();admit();
      const outcomes = await Promise.allSettled(flights);
      return outcomes.map((outcome,index) => outcome.status === 'fulfilled'
        ? {...expected[index],status:'fulfilled' as const,worked:outcome.value}
        : {...expected[index],status:'rejected' as const,error:outcome.reason});
    } catch (error) {
      refuseAdmission(error);stop.abort(error);
      await Promise.allSettled(flights);
      throw error;
    } finally {this.explicitScopedBatch=false;}
  }

  private async processWorkAttempt(signal?: AbortSignal): Promise<boolean> {
    const work = await this.claimWorkAttempt(signal);
    return work ? this.processClaimedWork(work,signal) : false;
  }

  private async claimWorkAttempt(signal?: AbortSignal): Promise<WorkLease | null> {
    const scoped = this.options.caseSessionHandler;
    const handler = scoped ?? this.options.handler;
    if (!handler) throw new TypeError('A durable work handler is required');
    if (signal?.aborted) return null;
    await this.guard();
    if ((await this.lifecycle()).paused) return null;
    if (scoped) {
      await this.checkStatus();
      if (!this.caseSessionsAvailable) throw new EnvoiError('Case sessions are unavailable', 404, 'FEATURE_DISABLED');
      if ((await this.lifecycle()).paused) return null;
    }
    let claimed: { work: WorkLease | null; state?: string; nextAvailableInMs?: number };
    if (scoped) signal?.throwIfAborted();
    try { claimed = await this.postWork<{ work: WorkLease | null; state?: string }>('/api/agent/work/claim', { acceptHumanInstructions: true }, undefined, scoped ? signal : undefined); }
    catch (error) {
      if (error instanceof EnvoiError && [404, 405, 501].includes(error.status || 0)) throw new ConnectorContractError();
      throw error;
    }
    this.lastWorkClaimAt = new Date().toISOString();
    if (claimed.state === 'paused') { await this.observeError(new EnvoiError('Paused', undefined, 'AGENT_PAUSED')); return null; }
    this.nextClaimAt = Infinity;
    if (claimed.work === null) {
      if (claimed.state === 'idle' && Number.isSafeInteger(claimed.nextAvailableInMs) && claimed.nextAvailableInMs! >= 0)
        this.nextClaimAt = Date.now() + Math.max(1000, claimed.nextAvailableInMs!);
      return null;
    }
    const work = claimed.work;
    if (!work || typeof work.workId !== 'string' || typeof work.leaseToken !== 'string' || !Number.isFinite(Date.parse(work.leaseExpiresAt)) || typeof work.message?.id !== 'string' || !work.message.id || scoped && work.message.id !== work.workId) {
      throw new EnvoiError('Envoi returned an invalid work claim');
    }
    const session = validSession(await this.store.load());
    if (isHumanDecisionMessage(work.message)) {
      if (!scoped) throw new EnvoiError('Human decisions require a scoped runtime', undefined, 'FEATURE_DISABLED');
      assertHumanDecisionMessage(work.message);
      if (work.message.recipientInboxId !== session.inboxId || work.message.id !== work.workId) throw new EnvoiError('Envoi returned work for the wrong inbox');
    } else if (isHumanInstructionMessage(work.message)) {
      assertHumanInstructionMessage(work.message);
      if (work.message.recipientInboxId !== session.inboxId) throw new EnvoiError('Envoi returned work for the wrong inbox');
    } else if (work.message.senderType === 'human' || 'senderHumanId' in work.message || (work.message.from && 'humanId' in work.message.from) || !work.message.from?.address) {
      throw new EnvoiError('Envoi returned an invalid native work sender');
    }
    if (work.message.recipientAgentId !== session.agentId || work.message.status === 'processed') {
      throw new EnvoiError('Envoi returned work for the wrong recipient');
    }
    return work;
  }

  private async processClaimedWork(work: WorkLease, signal?: AbortSignal, admission?: () => Promise<void>): Promise<boolean> {
    const scoped = this.options.caseSessionHandler, handler = scoped ?? this.options.handler;
    if (!handler) throw new TypeError('A durable work handler is required');
    const probeLease=scoped?{workId:work.workId,leaseExpiresAt:work.leaseExpiresAt,retired:false,processed:false,used:new Set<string>()}:undefined;
    if(probeLease){
      // Bounded diagnostics must never impose a lifetime work cap on a connector.
      const previous=this.controlProbeLeases.get(work.leaseToken);
      if(previous&&!previous.retired)throw new ConnectorContractError();
      if(this.controlProbeLeases.size>=64){const oldest=[...this.controlProbeLeases].find(([,entry])=>entry.retired);if(oldest)this.controlProbeLeases.delete(oldest[0]);}
      if(this.controlProbeLeases.size>=64)throw new ConnectorContractError();
      this.controlProbeLeases.set(work.leaseToken,probeLease);
    }
    const workPath = `/api/agent/work/${encodeURIComponent(work.workId)}`;
    // The server scopes idempotency by agent, so a reclaimed lease needs new
    // request keys; reuse these keys only within this claim attempt.
    const attemptId = globalThis.crypto.randomUUID();
    const acknowledgeKey = `connector:${work.message.id}:${attemptId}:ack`;
    const completeKey = `connector:${work.message.id}:${attemptId}:complete`;
    const workAbort = new AbortController();
    this.activeWork.add(workAbort);
    const onAbort = () => workAbort.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) workAbort.abort();
    let leaseExpiresAt = work.leaseExpiresAt;
    let renewalError: unknown = null;
    let leaseDeadline: ReturnType<typeof setTimeout>;
    const scheduleDeadline = () => {
      clearTimeout(leaseDeadline);
      leaseDeadline = setTimeout(() => {
        renewalError = new EnvoiError('Work lease expired during processing', undefined, 'REQUEST_CANCELLED');
        workAbort.abort();
      }, Math.max(0, Date.parse(leaseExpiresAt) - Date.now()));
    };
    scheduleDeadline();
    let renewalFlight: Promise<void> | null = null;
    let retiring = false;
    const renewLease = (): Promise<void> => {
      if (renewalFlight) return renewalFlight;
      renewalFlight = (async () => {
        if (workAbort.signal.aborted) throw new EnvoiError('Work lease was interrupted', undefined, 'REQUEST_CANCELLED');
        const renewed = await this.postWork<{ workId: string; leaseToken: string; leaseExpiresAt: string }>(`${workPath}/renew`, { leaseToken: work.leaseToken }, undefined, workAbort.signal, !!scoped);
        if (workAbort.signal.aborted) throw new EnvoiError('Work lease was interrupted', undefined, 'REQUEST_CANCELLED');
        if (renewed.workId !== work.workId || renewed.leaseToken !== work.leaseToken || !Number.isFinite(Date.parse(renewed.leaseExpiresAt))) throw new EnvoiError('Envoi returned an invalid lease renewal');
        if (Date.parse(renewed.leaseExpiresAt) <= Date.now()) throw new EnvoiError('Envoi returned an expired lease renewal');
        leaseExpiresAt = renewed.leaseExpiresAt;
        if(probeLease)probeLease.leaseExpiresAt=renewed.leaseExpiresAt;
        scheduleDeadline();
      })().catch(error => {
        if (retiring) return;
        if (scoped) { renewalError = error; workAbort.abort(); }
        throw error;
      }).finally(() => { renewalFlight = null; });
      return renewalFlight;
    };
    const revalidateLease = async () => {
      if (renewalFlight) await renewalFlight;
      if (!retiring) await renewLease();
    };
    if (scoped) this.activeLeaseChecks.set(revalidateLease, workAbort);
    const renewal = (async () => {
      let failures = 0;
      while (!workAbort.signal.aborted) {
        const remaining = Date.parse(leaseExpiresAt) - Date.now();
        await delay(failures ? Math.min(1_000, Math.max(1, Math.floor(remaining / 3)))
          : Math.max(100, Math.min(scoped ? 20_000 : 30_000, Math.floor(remaining / 3))), workAbort.signal);
        if (workAbort.signal.aborted) break;
        try {
          await renewLease();
          failures = 0;
        } catch (error) {
          if (workAbort.signal.aborted) break;
          const transient = error instanceof EnvoiError && (['NETWORK_ERROR', 'TIMEOUT'].includes(error.code ?? '')
            || (!error.code && [502, 503, 504].includes(error.status ?? 0)) || error.code === 'INTERNAL_SERVER_ERROR');
          if (!scoped && transient && ++failures <= 2 && Date.parse(leaseExpiresAt) > Date.now()) continue;
          renewalError = error;
          workAbort.abort();
          break;
        }
      }
    })();
    const stopRenewal = async () => {
      retiring = true;
      this.activeLeaseChecks.delete(revalidateLease);
      clearTimeout(leaseDeadline); workAbort.abort(); await renewal;
      await renewalFlight?.catch(() => {});
    };
    let settled = false;
    let humanReplyError: unknown = null;
    try {
      if (workAbort.signal.aborted) throw new EnvoiError('Work claim was interrupted before admission');
      if (admission) await abortableTurn(admission,workAbort.signal);
      await this.guard(true);
      await handler.admit(work.message);
      if (workAbort.signal.aborted) throw new EnvoiError('Work lease was interrupted before acknowledgement');
      const acknowledged = await this.postWork<WorkSettlement>(`${workPath}/acknowledge`, { leaseToken: work.leaseToken }, acknowledgeKey, workAbort.signal, !!scoped);
      if (acknowledged.workId !== work.workId || acknowledged.status !== 'acknowledged' || acknowledged.receipt?.state !== 'acknowledged' || acknowledged.receipt.messageId !== work.message.id) {
        throw new EnvoiError('Envoi returned an invalid acknowledgement');
      }
      if (workAbort.signal.aborted) throw new EnvoiError('Work lease was interrupted before processing');
      if (scoped) await this.processCaseSessionWork(work, scoped, workAbort.signal, () => leaseExpiresAt);
      else await this.options.handler!.process(work.message, {
        signal: workAbort.signal,
        reply: async (text, key, extra) => {
          if (workAbort.signal.aborted || signal?.aborted || Date.parse(leaseExpiresAt) <= Date.now()) {
            throw new EnvoiError('Work lease is no longer valid for a reply');
          }
          try {
            const reply = await this.reply(work.message, text, key, extra, work.leaseToken);
            if (isHumanInstructionMessage(work.message)) humanReplyError = null;
            return reply;
          } catch (error) {
            if (isHumanInstructionMessage(work.message)) humanReplyError = error;
            throw error;
          }
        }
      });
      if (humanReplyError) throw humanReplyError;
      if (renewalError) throw renewalError;
      if (workAbort.signal.aborted || signal?.aborted || Date.parse(leaseExpiresAt) <= Date.now()) throw new EnvoiError('Work lease expired before completion');
      const completed = await this.postWork<WorkSettlement>(`${workPath}/complete`, { leaseToken: work.leaseToken }, completeKey, workAbort.signal, !!scoped);
      if (renewalError) throw renewalError;
      if (workAbort.signal.aborted || signal?.aborted || Date.parse(leaseExpiresAt) <= Date.now()) throw new EnvoiError('Work lease was interrupted during completion', undefined, 'REQUEST_CANCELLED');
      if (completed.workId !== work.workId || completed.status !== 'processed' || completed.receipt?.state !== 'processed' || completed.receipt.messageId !== work.message.id) {
        throw new EnvoiError('Envoi returned an invalid completion');
      }
      settled = true;
      if(probeLease)probeLease.processed=true;
      await stopRenewal();
      return true;
    } catch (error) {
      const interrupted = workAbort.signal.aborted;
      await stopRenewal();
      if (!interrupted && !renewalError && !settled && !signal?.aborted && !(await this.lifecycle()).paused
        && !['REVOKED', 'NEEDS_RECONNECT', 'STOPPED'].includes((await this.lifecycle()).state)
        && !(error instanceof EnvoiError && (error.code === 'CASE_CONTROLLED'
          || scoped && ['CASE_SESSION_ENDED', 'CASE_SESSION_EXPIRED', 'WORK_LEASE_STALE', 'WORK_NOT_ELIGIBLE', 'WORK_NOT_FOUND', 'FEATURE_DISABLED', 'AUTHENTICATION_REQUIRED'].includes(error.code ?? '')))
        && Date.parse(leaseExpiresAt) > Date.now()) {
        if (scoped && error instanceof PermanentWorkError) {
          const failed = await this.postWork<{ workId: string; status: string }>(`${workPath}/fail`, {
            leaseToken: work.leaseToken, retryable: false, reasonCode: error.code
          }, undefined, undefined, true);
          // stopRenewal intentionally aborted workAbort; only the owner signal and
          // captured lease deadline still fence this settlement acknowledgement.
          if (signal?.aborted || Date.parse(leaseExpiresAt) <= Date.now())
            throw new EnvoiError('Work lease was interrupted during failure settlement', undefined, 'REQUEST_CANCELLED');
          if (!failed || failed.workId !== work.workId || failed.status !== 'failed') throw new ConnectorContractError();
          settled = true;
          return true;
        }
        await this.postWork(`${workPath}/fail`, { leaseToken: work.leaseToken, retryable: true, reasonCode: 'HANDLER_FAILED' }, undefined, undefined, !!scoped).catch(() => {});
      }
      if (interrupted && !renewalError && error instanceof EnvoiError && !error.code)
        throw new EnvoiError(error.message, error.status, 'REQUEST_CANCELLED');
      if (!(error instanceof EnvoiError)) await this.observeError(new EnvoiError('Work handler failed', undefined, 'HANDLER_FAILED'));
      throw renewalError ?? error;
    } finally {
      this.activeWork.delete(workAbort);
      signal?.removeEventListener('abort', onAbort);
      await stopRenewal();
      if(probeLease)probeLease.retired=true;
    }
  }

  private async processCaseSessionWork(work: WorkLease, handler: CaseSessionWorkHandler, signal: AbortSignal, leaseExpiresAt: () => string): Promise<void> {
    let reminted = false;
    while (!signal.aborted) {
      let channel: CaseSessionChannel | undefined;
      let mintFailures = 0;
      while (!channel) {
        signal.throwIfAborted();
        try { channel = await this.mintCaseSession({ ...work, leaseExpiresAt: leaseExpiresAt() }, { signal }); }
        catch (error) {
          if (!retryableCaseSessionError(error) || ++mintFailures > 3) throw error;
          const wait = retryDelay(mintFailures, Math.random(), error.retryAfterSeconds);
          if (Date.now() + wait >= Date.parse(leaseExpiresAt())) throw error;
          await delay(wait, signal);
        }
      }
      try {
        await abortableTurn(() => handler.process(channel!, { signal: channel!.signal, workId: work.workId }), channel.signal);
        signal.throwIfAborted();
        let endFailures = 0;
        while (true) {
          signal.throwIfAborted();
          try { await channel.end(); break; }
          catch (error) {
            if (!retryableCaseSessionError(error) || ++endFailures > 3) throw error;
            const wait = retryDelay(endFailures, Math.random(), error.retryAfterSeconds);
            if (Date.now() + wait >= Date.parse(leaseExpiresAt())) throw error;
            await delay(wait, signal);
          }
        }
        signal.throwIfAborted();
        return;
      } catch (error) {
        const failure = channel.signal.aborted && !(channel.signal.reason instanceof EnvoiError && channel.signal.reason.reason === 'ended_by_host') ? channel.signal.reason : error;
        await channel.end().catch(() => {});
        if (failure instanceof EnvoiError && failure.code === 'CASE_SESSION_ENDED' && failure.reason === 'agent_paused') await this.observeError(new EnvoiError('Paused', undefined, 'AGENT_PAUSED'));
        const retry = failure instanceof EnvoiError && (failure.code === 'CASE_SESSION_EXPIRED'
          || failure.code === 'AUTHENTICATION_REQUIRED'
          || failure.code === 'CASE_SESSION_ENDED' && failure.reason === 'superseded');
        if (!reminted && retry && !signal.aborted && Date.parse(leaseExpiresAt()) > Date.now()) {
          reminted = true;
          continue;
        }
        throw failure;
      } finally { channel.invalidate(); }
    }
    signal.throwIfAborted();
  }

  /** Reads one durable delta page. The callback must complete before its cursor is committed. */
  async pollOnce(): Promise<{ count: number; hasMore: boolean }> {
    let session = validSession(await this.store.load());
    const page = await this.withFreshSession(async current => {
      session = current;
      return new EnvoiClient(this.origin, current.agentApiToken, this.options).delta(current.inboxId, this.cursorFor(current) || undefined, this.pageSize);
    });
    if (!Array.isArray(page.events) || typeof page.hasMore !== 'boolean') throw new EnvoiError('Envoi returned an invalid event page');
    if (page.hasMore && page.events.length === 0) throw new EnvoiError('Envoi returned an invalid event page');
    let count = 0;
    for (const raw of page.events) {
      const event = eventFrom(raw);
      if (this.cursorFor(session) && event.cursor <= this.cursorFor(session)!) continue;
      await this.observeEvent(event);
      await this.options.onEvent?.(event);
      // An event callback may send a reply and rotate credentials. Preserve its
      // new refresh token when committing the observation cursor.
      const current = validSession(await this.store.load());
      if (current.agentId !== session.agentId || current.inboxId !== session.inboxId) throw new EnvoiError('Connector session changed while reading events');
      session = await this.saveCursor(session, event.cursor);
      count += 1;
    }
    return { count, hasMore: page.hasMore };
  }

  private cursorFor(session: ConnectorSession): string | null {
    // The legacy scalar is migrated only when there is no inbox map yet.
    return session.cursors ? session.cursors[session.inboxId] ?? null : session.cursor;
  }

  private saveCursor(session: ConnectorSession, cursor: string | null): Promise<ConnectorSession> {
    return this.mutate(current => {
      if (current.inboxId !== session.inboxId || current.agentId !== session.agentId) throw new EnvoiError('Connector session changed while reading events');
      return { ...current, cursor, cursors: { ...current.cursors, [session.inboxId]: cursor } };
    });
  }

  /** Status is available while paused and is the recovery path for a missed resume. */
  async checkStatus(): Promise<void> {
    const epoch = this.actionEpoch;
    const result = await this.withFreshSession(async session => {
      let response: Response;
      try { response = await (this.options.fetch || fetch)(`${this.origin}/api/agent/status`, {
        headers: { authorization: `Bearer ${session.agentApiToken}` }, credentials: 'omit', redirect: 'error',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000)
      }); } catch { throw new EnvoiError('Envoi status could not be reached', undefined, 'NETWORK_ERROR'); }
      const status = await responsePayload<{ state: string; inboxId: string; agent: { id: string }; caseSessions?: { available: boolean; version: number } }>(response, 'Envoi status failed');
      if (!['active', 'paused'].includes(status.state) || status.inboxId !== session.inboxId || status.agent?.id !== session.agentId)
        throw new EnvoiError('Envoi returned an invalid agent status');
      return status;
    });
    if (epoch !== this.actionEpoch) return;
    this.caseSessionsAvailable = result.caseSessions?.available === true && result.caseSessions.version === 1;
    if (result.state === 'paused') await this.observeError(new EnvoiError('Paused', undefined, 'AGENT_PAUSED'), epoch);
    else if ((await this.lifecycle()).paused) {
      await this.transition('RUNNING', { paused: false, code: undefined, reason: undefined, guidance: undefined, failures: 0, retryAt: undefined }, epoch);
      this.wakeTrigger?.();
    }
  }

  /** SSE wakes the authoritative work queue; delta is used only after replay_required. */
  async run(signal: AbortSignal): Promise<void> {
    await this.start();
    const stop = new AbortController();
    const stopped = AbortSignal.any([signal, stop.signal]);
    const hasHandler = !!(this.options.handler || this.options.caseSessionHandler);
    let pending = hasHandler, flight: Promise<void> | null = null, fatal: unknown;
    let toolRetryAt = 0, toolFailures = 0;
    let connected = false, safetyAt = Date.now() + 12_000 + Math.random() * 6000;
    let statusAt = Date.now() + 30_000 + Math.random() * 30_000;
    const notify = () => this.wake.abort();
    const trigger = () => { if (hasHandler) pending = true; notify(); };
    const safetyDelay = (state?: ConnectorLifecycle) => connected && state?.state !== 'DEGRADED' ? 30_000 + Math.random() * 30_000 : 12_000 + Math.random() * 6000;
    const failure = async (error: unknown, independentStream = false) => {
      if (stopped.aborted) return;
      // A validated TOOL_BUSY exhausted its identical-call retries. The work
      // lease was deferred; keep the host loop alive with its existing durable
      // handler-failure backoff rather than requiring an owner restart.
      const busyTool = !!this.options.caseSessionHandler && error instanceof CaseToolError && error.code === 'TOOL_BUSY' && error.retryable;
      if (busyTool)
        error = new EnvoiError('Case tool is temporarily busy', undefined, 'HANDLER_FAILED');
      if (independentStream && error instanceof EnvoiError && lifecyclePolicy(error).lifecycle === 'DEGRADED') {
        safetyAt = Math.min(safetyAt, Date.now() + safetyDelay());
        notify();
        return;
      }
      await this.observeError(error);
      // A concurrent healthy status/stream response may clear lifecycle backoff;
      // it must not make the deferred tool turn hot-loop its next claim.
      if (busyTool) {
        toolRetryAt = Date.now() + retryDelay(++toolFailures);
        safetyAt = Math.min(safetyAt, toolRetryAt);
      }
      if (this.options.caseSessionHandler && error instanceof EnvoiError && error.code === 'CASE_SESSION_ENDED' && error.reason === 'credential_ended') {
        try { await this.checkStatus(); }
        catch (statusError) { error = statusError; await this.observeError(error); }
      }
      const state = await this.lifecycle();
      if (state.state === 'DEGRADED') safetyAt = Math.min(safetyAt, Date.now() + 12_000 + Math.random() * 6000);
      if (error instanceof ConnectorPersistenceError || error instanceof ConnectorContractError || ['REVOKED', 'NEEDS_RECONNECT'].includes(state.state)
        || !(error instanceof EnvoiError) && state.state !== 'DEGRADED'
        || error instanceof EnvoiError && !(lifecyclePolicy(error).lifecycle === 'DEGRADED' || ['REQUEST_CANCELLED', 'AGENT_PAUSED', 'CASE_CONTROLLED'].includes(error.code ?? '')
          || this.options.caseSessionHandler && ['CASE_SESSION_ENDED', 'CASE_SESSION_EXPIRED', 'WORK_LEASE_STALE', 'WORK_NOT_ELIGIBLE', 'WORK_NOT_FOUND'].includes(error.code ?? ''))) {
        fatal = error; stop.abort();
      }
      notify();
    };
    const onAbort = () => { this.actionEpoch++; for (const controller of [...this.activeActions, ...this.activeWork, ...this.activeRefresh, ...this.activeStreams]) controller.abort(); notify(); };
    signal.addEventListener('abort', onAbort, { once: true });
    stop.signal.addEventListener('abort', onAbort, { once: true });
    this.wakeTrigger = trigger;
    const initial = await this.lifecycle();
    if (initial.retryAt) await delay(Math.max(0, Date.parse(initial.retryAt) - Date.now()), stopped);
    const streams = (async () => {
      let failures = 0;
      while (!stopped.aborted) {
        this.wakeTransport = 'connecting';
        const stream = new AbortController();
        this.activeStreams.add(stream);
        const streamSignal = AbortSignal.any([stopped, stream.signal]);
        let openedAt = 0, uptime = 0, idle: ReturnType<typeof setTimeout> | undefined;
        let recovery = false, retryAfter = 0;
        let session = validSession(await this.store.load());
        const resume = this.cursorFor(session), baseline = !resume;
        const activity = () => { clearTimeout(idle); idle = setTimeout(() => stream.abort(), 60_000); };
        try {
          // A failed connection still counts as a reconnect for paused recovery.
          if ((await this.lifecycle()).paused) { await this.checkStatus(); statusAt = Date.now() + 30_000 + Math.random() * 30_000; }
          if (streamSignal.aborted) break;
          const response = await this.withFreshSession(async current => {
            if (current.inboxId !== session.inboxId || current.agentId !== session.agentId) throw new EnvoiError('Connector session changed while connecting');
            session = current;
            const headers: Record<string, string> = { authorization: `Bearer ${current.agentApiToken}`, accept: 'text/event-stream' };
            if (resume) headers['Last-Event-ID'] = resume;
            const headerTimeout = new AbortController();
            const timer = setTimeout(() => headerTimeout.abort(), this.options.timeoutMs ?? 30_000);
            try {
              let response: Response;
              try { response = await (this.options.fetch || fetch)(`${this.origin}/api/inboxes/${encodeURIComponent(current.inboxId)}/events${baseline ? '?from=latest' : ''}`, {
                headers, credentials: 'omit', redirect: 'error', signal: AbortSignal.any([streamSignal, headerTimeout.signal])
              }); } catch { throw new EnvoiError('Envoi event stream could not be reached', undefined, 'NETWORK_ERROR'); }
              if (!response.ok) await responsePayload(response, 'Envoi event stream failed');
              return response;
            } finally { clearTimeout(timer); }
          }, false, true);
          openedAt = Date.now(); activity();
          try {
            for await (const frame of eventFrames(response, streamSignal, activity)) {
              if (stopped.aborted) break;
              if (frame.id !== undefined) {
                if (!/^\d{20}$/.test(frame.id) || frame.data.cursor !== frame.id || frame.data.type !== frame.type)
                  throw new EnvoiError('Envoi returned an invalid stored event');
                const current = validSession(await this.store.load());
                if (current.inboxId !== session.inboxId || current.agentId !== session.agentId) throw new EnvoiError('Connector session changed while reading events');
                if (this.cursorFor(current) && frame.id <= this.cursorFor(current)!) continue;
                const event = eventFrom(frame.data);
                await this.observeEvent(event, frame.type);
                await this.options.onEvent?.(event);
                await this.saveCursor(session, frame.id);
                this.lastWakeEventAt = new Date().toISOString();
                if (frame.type === 'work.available' && event.agentId === session.agentId
                  || (frame.type === 'message.delivered' || frame.type === 'human.instruction_created') && event.recipientAgentId === session.agentId) trigger();
              } else if (frame.type === 'ready') {
                if (frame.data.inboxId !== session.inboxId || frame.data.cursor !== null && (typeof frame.data.cursor !== 'string' || !/^\d{20}$/.test(frame.data.cursor)))
                  throw new EnvoiError('Envoi returned an invalid ready frame');
                if (baseline && !this.cursorFor(validSession(await this.store.load()))) await this.saveCursor(session, frame.data.cursor as string | null);
                connected = true; safetyAt = Date.now() + safetyDelay();
                this.wakeTransport = 'connected'; this.lastWakeReadyAt = new Date().toISOString(); this.lastWakeErrorCode = undefined;
                if ((await this.lifecycle()).paused) { await this.checkStatus(); statusAt = Date.now() + 30_000 + Math.random() * 30_000; }
                trigger();
              } else if (frame.type === 'replay_required') { recovery = true; break; }
              else if (frame.type === 'replay_error') throw new EnvoiError('Envoi event replay failed', undefined, 'NETWORK_ERROR');
              else if (frame.type === 'credential.ended') { await this.observeEvent(frame.data, frame.type); await this.guard(); throw new EnvoiError('Credential ended', undefined, String(frame.data.code)); }
            }
          } catch (error) {
            if (error instanceof EnvoiError || error instanceof ConnectorPersistenceError) throw error;
            throw new EnvoiError('Envoi event stream was interrupted', undefined, 'NETWORK_ERROR');
          }
        } catch (error) {
          this.lastWakeErrorCode = error instanceof EnvoiError && error.code && /^[A-Z][A-Z0-9_]{0,119}$/.test(error.code)
            ? error.code : 'WAKE_STREAM_ERROR';
          if (error instanceof EnvoiError && error.code === 'EVENT_CURSOR_INVALID') { await this.saveCursor(session, null); trigger(); }
          else { retryAfter = error instanceof EnvoiError ? (error.retryAfterSeconds ?? 0) * 1000 : 0; await failure(error, true); }
        } finally {
          clearTimeout(idle); stream.abort(); this.activeStreams.delete(stream);
          uptime = openedAt ? Date.now() - openedAt : 0;
          connected = false; safetyAt = Math.min(safetyAt, Date.now() + safetyDelay()); notify();
          this.wakeTransport = 'disconnected';
        }
        if (stopped.aborted) break;
        if (recovery) {
          try {
            while (!stopped.aborted) { const page = await this.pollOnce(); if (!page.hasMore) break; }
            trigger();
          } catch (error) {
            if (error instanceof EnvoiError && error.code === 'EVENT_CURSOR_INVALID') { await this.saveCursor(session, null); trigger(); }
            else { await failure(error); recovery = false; }
          }
          if (recovery) continue;
        }
        if (uptime >= 60_000) failures = 0;
        const ceiling = Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5));
        await delay(Math.max(retryAfter, Math.random() * ceiling), stopped);
      }
    })().catch(async error => { await failure(error, true); }).finally(notify);
    try {
      while (!stopped.aborted) {
        this.wake = new AbortController();
        if (fatal) throw fatal;
        const state = await this.lifecycle();
        if (['REVOKED', 'NEEDS_RECONNECT'].includes(state.state)) { await streams; if (fatal) throw fatal; await this.guard(); }
        const now = Date.now();
        const retryAt = Math.max(state.retryAt ? Date.parse(state.retryAt) : 0, toolRetryAt);
        if (state.paused) {
          pending = false; this.nextClaimAt = Infinity;
          if (now >= statusAt) { statusAt = now + 30_000 + Math.random() * 30_000; try { await this.checkStatus(); } catch (error) { await failure(error); } }
        } else if (hasHandler) {
          if (now >= Math.min(safetyAt, this.nextClaimAt)) { pending = true; safetyAt = now + safetyDelay(state); this.nextClaimAt = Infinity; }
          if (pending && !flight && now >= retryAt) {
            pending = false;
            flight = this.processWorkOnce(stopped).then(worked => { if (worked) { pending = true; toolRetryAt = 0; toolFailures = 0; } }, async error => {
              await failure(error);
              if ((await this.lifecycle()).state === 'DEGRADED') pending = true;
            })
              .finally(() => { flight = null; notify(); });
          }
        }
        const deadline = state.paused ? statusAt : pending && !flight ? retryAt : hasHandler ? Math.max(retryAt, Math.min(safetyAt, this.nextClaimAt)) : Infinity;
        if (pending && !flight && !state.paused && Date.now() >= retryAt) continue;
        await delay(Math.min(60_000, Math.max(1, deadline - Date.now())), AbortSignal.any([stopped, this.wake.signal]));
      }
      if (fatal) throw fatal;
    } finally {
      stop.abort(); await streams; await flight;
      this.wakeTrigger = undefined;
      signal.removeEventListener('abort', onAbort);
      stop.signal.removeEventListener('abort', onAbort);
      onAbort();
      const current = await this.lifecycle();
      if (!['REVOKED', 'NEEDS_RECONNECT'].includes(current.state)) await this.transition('STOPPED');
    }
  }
}

function abortableTurn<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return run(); }).then(
      value => { signal.removeEventListener('abort', abort); if (signal.aborted) reject(signal.reason); else resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(signal.aborted ? signal.reason : error); }
    );
  });
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    function done() { signal.removeEventListener('abort', done); clearTimeout(timer); resolve(); }
    signal.addEventListener('abort', done, { once: true });
  });
}
