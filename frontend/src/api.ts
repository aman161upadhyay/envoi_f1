import type { Agent, AgentConnectionInvitation, AgentConnectionInvitationDecision, ApprovedEmailContact, Asset, AuthConfig, CalendarConnector, CalendarProvider, EmailTransportStatus, Human, HumanActionKey, HumanView, Inbox, InboxPreference, Organization } from './types';
import { trackSessionRequest } from './session-lifecycle';
import { captureSuccessfulProductAction } from './analytics';
import type { EnrollmentResult, EnrollmentStatus } from './quick-connect';
import { validateQuickConnectHandoff, type ConnectorRuntime } from '../../sdk/typescript/src/quick-connect';

export const SESSION_EXPIRED_EVENT = 'envoi:session-expired';
export const CSRF_RELOAD_REQUIRED_EVENT = 'envoi:csrf-reload-required';
export const ACCOUNT_CHANGED_EVENT = 'envoi:account-changed';
let expectedHumanId: string | null = null;

// The account this tab is displaying. Tabs share one session cookie, so a write
// carries it and the server refuses it if the cookie now belongs to someone else.
export function setExpectedHuman(id: string | null) { expectedHumanId = id; }

export function expectedHumanHeaders(method = 'GET', pathname = '', humanId = expectedHumanId): Record<string, string> {
  if (!humanId || ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) || pathname.startsWith('/api/auth/')) return {};
  return { 'x-envoi-expected-human': humanId };
}

let configuredCsrfCookieName = 'envoi_csrf';

export function setCsrfCookieName(name?: string) {
  configuredCsrfCookieName = name && /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) ? name : 'envoi_csrf';
}

export class ApiError extends Error {
  readonly reason?: string;
  readonly requestId?: string;
  readonly retryAfterSeconds?: number;
  constructor(
    message: string,
    public status: number,
    public code?: string,
    public details?: Record<string, unknown>,
    public metadata: { reason?: string; requestId?: string; retryAfterSeconds?: number } = {}
  ) {
    super(message);
    this.name = 'ApiError';
    this.reason = metadata.reason; this.requestId = metadata.requestId; this.retryAfterSeconds = metadata.retryAfterSeconds;
  }
}

export function shouldNotifySessionExpired(pathname: string) {
  return ![
    '/api/auth/config',
    '/api/auth/phone/start',
    '/api/auth/phone/verify',
    '/api/auth/totp/setup',
    '/api/auth/totp/verify',
    '/api/auth/workos/sign-in',
    '/api/auth/workos/sign-up',
    '/api/auth/workos/callback',
    '/api/waitlist'
  ].some(path => pathname.startsWith(path));
}

export function csrfToken(cookieHeader = typeof document === 'undefined' ? '' : document.cookie) {
  const encodedName = encodeURIComponent(configuredCsrfCookieName);
  for (const item of cookieHeader.split(';').map(value => value.trim()).reverse()) {
    if (!item.startsWith(`${encodedName}=`)) continue;
    try { return decodeURIComponent(item.slice(encodedName.length + 1)) || null; }
    catch { continue; }
  }
  return null;
}

export function csrfHeaders(method = 'GET', cookieHeader?: string): Record<string, string> {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) return {};
  const token = csrfToken(cookieHeader);
  return token ? { 'x-envoi-csrf': token } : {};
}

export interface MonadPermissionEvidence {
  enabled: boolean;
  chainId: number;
  permission: { status: 'off' | 'not_recorded' | 'pending' | 'unavailable' | 'recorded'; digest?: string; txHash?: string; explorerUrl?: string };
  violations: Array<{ requestId: string; method: string; pathname: string; reasonCode: string; createdAt: string; status: 'queued' | 'pending' | 'recorded'; txHash?: string; explorerUrl?: string }>;
}
export interface MonadSettings { available: boolean; entitled: boolean; enabled: boolean }

export type PhaseDGrant = 'shareAssets' | 'autoAcceptSelectedTasks' | 'richerProfileVisibility' | 'allowInvitations';
export interface PhaseDDiscovery { agentId: string; address: string; trust: string; grants: PhaseDGrant[]; a2aCardUrl?: string }
export interface PhaseDRelationship { id: string; inboxId: string; actorAgentId: string; targetAgentId: string; status: 'active' | 'revoked'; grants: PhaseDGrant[] }
export interface PhaseDInvitation { id: string; invitation: string; expiresAt: string }

export async function request<T>(pathname: string, options: RequestInit = {}, notifySessionExpired = true): Promise<T> {
  const requestHumanId = expectedHumanId;
  const session = trackSessionRequest();
  try {
    const send = () => fetch(pathname, {
      ...options,
      signal: options.signal ? AbortSignal.any([options.signal, session.signal]) : session.signal,
      credentials: 'same-origin',
      headers: {
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...csrfHeaders(options.method),
        ...expectedHumanHeaders(options.method, pathname, requestHumanId),
        ...(options.headers || {})
      }
    });
    const sentCsrfToken = csrfToken();
    let response = await send();
    let payload = await response.json().catch(() => ({})) as { error?: string; message?: string; code?: string; details?: Record<string, unknown>; reason?: string; requestId?: string; retryAfterSeconds?: number };
    session.check();
    options.signal?.throwIfAborted();
    if (response.status === 403 && payload.error === 'CSRF validation failed'
      && !['GET', 'HEAD', 'OPTIONS'].includes((options.method || 'GET').toUpperCase())
      && (options.body === undefined || typeof options.body === 'string')) {
      const recovery = await fetch('/api/auth/me', { credentials: 'same-origin', signal: options.signal ? AbortSignal.any([options.signal, session.signal]) : session.signal });
      const identity = await recovery.json().catch(() => ({})) as { id?: string; error?: string };
      session.check();
      options.signal?.throwIfAborted();
      if (recovery.ok && identity.id && requestHumanId && identity.id !== requestHumanId) {
        if (typeof window !== 'undefined') window.dispatchEvent(new Event(ACCOUNT_CHANGED_EVENT));
        throw new ApiError('The signed-in account changed. Reload before continuing.', 409, 'ACCOUNT_CHANGED');
      }
      const recoveredToken = csrfToken();
      if ((recovery.ok && identity.id && recoveredToken && recoveredToken !== sentCsrfToken) || (recovery.status === 401 && pathname === '/api/auth/logout')) {
        response = await send();
        payload = await response.json().catch(() => ({}));
      } else if (recovery.status === 401) {
        response = recovery;
        payload = identity;
      }
    }
    session.check();
    options.signal?.throwIfAborted();
    if (!response.ok) {
      if (response.status === 403 && payload.error === 'CSRF validation failed' && typeof window !== 'undefined') {
        window.dispatchEvent(new Event(CSRF_RELOAD_REQUIRED_EVENT));
      }
      if (notifySessionExpired && response.status === 401 && shouldNotifySessionExpired(pathname) && typeof window !== 'undefined') {
        window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
      }
      if (response.status === 409 && payload.code === 'ACCOUNT_CHANGED' && typeof window !== 'undefined') window.dispatchEvent(new Event(ACCOUNT_CHANGED_EVENT));
      const headerValue = response.headers.get('retry-after');
      const headerDelay = headerValue === null ? undefined : Number(headerValue);
      const bodyDelay = payload.retryAfterSeconds;
      const delays = [headerDelay, bodyDelay].filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
      throw new ApiError(payload.message || payload.error || 'The request could not be completed.', response.status, payload.code || payload.error, payload.details, {
        ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}),
        ...(typeof payload.requestId === 'string' ? { requestId: payload.requestId } : {}),
        ...(delays.length ? { retryAfterSeconds: Math.max(...delays) } : {})
      });
    }
    captureSuccessfulProductAction(pathname, options.method);
    return payload as T;
  } finally { session.release(); }
}

export function safeDownloadUrl(value: string, baseUrl = typeof window === 'undefined' ? 'https://localhost/' : window.location.href) {
  try {
    const base = new URL(baseUrl);
    const target = new URL(value, base);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) return null;
    if (base.protocol === 'https:' && target.protocol !== 'https:') return null;
    return target.href;
  } catch {
    return null;
  }
}

export const api = {
  discoverAgentForOwner: (inboxId: string, address: string, actorAgentId: string) => request<PhaseDDiscovery>(`/api/inboxes/${encodeURIComponent(inboxId)}/discovery?address=${encodeURIComponent(address)}&actorAgentId=${encodeURIComponent(actorAgentId)}`),
  grantRelationship: (inboxId: string, actorAgentId: string, targetAddress: string, grants: PhaseDGrant[]) => request<PhaseDRelationship>(`/api/inboxes/${encodeURIComponent(inboxId)}/relationships`, { method: 'POST', body: JSON.stringify({ actorAgentId, targetAddress, grants }) }),
  revokeRelationship: (inboxId: string, actorAgentId: string, targetAgentId: string) => request<PhaseDRelationship>(`/api/inboxes/${encodeURIComponent(inboxId)}/relationships/${encodeURIComponent(actorAgentId)}/${encodeURIComponent(targetAgentId)}/revoke`, { method: 'POST', body: '{}' }),
  issueDiscoveryInvitation: (inboxId: string, actorAgentId: string, recipientAddress: string) => request<PhaseDInvitation>(`/api/inboxes/${encodeURIComponent(inboxId)}/discovery-invitations`, { method: 'POST', body: JSON.stringify({ actorAgentId, recipientAddress }) }),
  revokeDiscoveryInvitation: (inboxId: string, invitationId: string) => request<{ id: string; status: 'revoked'; revokedAt: string }>(`/api/inboxes/${encodeURIComponent(inboxId)}/discovery-invitations/${encodeURIComponent(invitationId)}/revoke`, { method: 'POST', body: '{}' }),
  authConfig: async () => {
    const config = await request<AuthConfig>('/api/auth/config');
    setCsrfCookieName(config.csrfCookieName);
    return config;
  },
  me: (signal?: AbortSignal, notifySessionExpired = true) => request<Human>('/api/auth/me', { signal }, notifySessionExpired),
  phoneStart: (phoneNumber: string, displayName: string) => request<{ challengeId: string; expiresAt: string; developmentCode?: string }>('/api/auth/phone/start', { method: 'POST', body: JSON.stringify({ phoneNumber, displayName }) }),
  phoneVerify: (challengeId: string, code: string) => request<{ human: Human; secondFactorRequired: boolean; mfaSetupRequired: boolean; expiresAt?: string }>('/api/auth/phone/verify', { method: 'POST', body: JSON.stringify({ challengeId, code }) }),
  totpSetup: () => request<{ secret: string; otpauthUri: string; developmentCode?: string }>('/api/auth/totp/setup', { method: 'POST', body: '{}' }),
  totpVerify: (code: string) => request<{ human: Human; assurance: string }>('/api/auth/totp/verify', { method: 'POST', body: JSON.stringify({ code }) }),
  logout: () => request<{ revoked: boolean; logoutUrl?: string | null }>('/api/auth/logout', { method: 'POST', body: '{}' }),
  organizations: (signal?: AbortSignal) => request<Organization[]>('/api/organizations', { signal }),
  workspaces: (organizationId: string, signal?: AbortSignal) => request<Inbox[]>(`/api/organizations/${organizationId}/workspaces`, { signal }),
  createInboxFolder: (inboxId: string, name: string) => request<{ folder: { id: string; name: string } }>(`/api/inboxes/${encodeURIComponent(inboxId)}/inbox-folders`, { method: 'POST', body: JSON.stringify({ name }) }),
  deleteInboxFolder: (inboxId: string, folderId: string) => request<{ deleted: boolean }>(`/api/inboxes/${encodeURIComponent(inboxId)}/inbox-folders/${encodeURIComponent(folderId)}`, { method: 'DELETE' }),
  updateInboxPreference: (inboxId: string, caseId: string, patch: { archive?: boolean; folderId?: string | null; read?: boolean; readThrough?: string }) => request<{ inboxPreference: InboxPreference }>(`/api/inboxes/${encodeURIComponent(inboxId)}/cases/${encodeURIComponent(caseId)}/inbox-preferences`, { method: 'POST', body: JSON.stringify(patch) }),
  sendInstruction: (inboxId: string, caseId: string, text: string, idempotencyKey: string) => request<unknown>(`/api/inboxes/${encodeURIComponent(inboxId)}/cases/${encodeURIComponent(caseId)}/instructions`, { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ text }) }),
  createWorkspace: (name: string, organizationId?: string) => request<Inbox>('/api/inboxes', { method: 'POST', body: JSON.stringify({ name, organizationId }) }),
  humanView: (inboxId: string, history?: Record<string, string>, signal?: AbortSignal) => request<HumanView>(`/api/inboxes/${encodeURIComponent(inboxId)}/human-view${history ? `?history=${encodeURIComponent(JSON.stringify(history))}` : ''}`, { signal }),
  monadPermissionEvidence: (inboxId: string, agentId: string, signal?: AbortSignal) => request<MonadPermissionEvidence>(`/api/inboxes/${encodeURIComponent(inboxId)}/agents/${encodeURIComponent(agentId)}/monad-evidence`, { signal }),
  monadSettings: (inboxId: string, signal?: AbortSignal) => request<MonadSettings>(`/api/inboxes/${encodeURIComponent(inboxId)}/monad-settings`, { signal }),
  updateMonadSettings: (inboxId: string, enabled: boolean) => request<MonadSettings>(`/api/inboxes/${encodeURIComponent(inboxId)}/monad-settings`, { method: 'POST', body: JSON.stringify({ enabled }) }),
  // Only the validation caller handles denial, to distinguish MFA from logout.
  sessionView: (inboxId: string, signal: AbortSignal) => request<HumanView>(`/api/inboxes/${encodeURIComponent(inboxId)}/human-view`, { signal }, false),
  invitations: (inboxId: string) => request<AgentConnectionInvitation[]>(`/api/inboxes/${encodeURIComponent(inboxId)}/invitations`),
  acceptInvitation: (inboxId: string, invitationId: string) => request<AgentConnectionInvitationDecision>(`/api/inboxes/${encodeURIComponent(inboxId)}/invitations/${encodeURIComponent(invitationId)}/accept`, { method: 'POST' }),
  declineInvitation: (inboxId: string, invitationId: string) => request<AgentConnectionInvitation>(`/api/inboxes/${encodeURIComponent(inboxId)}/invitations/${encodeURIComponent(invitationId)}/decline`, { method: 'POST' }),
  action: (inboxId: string, caseId: string, actionKey: HumanActionKey, externalRefs: Record<string, unknown> = {}) => request<{ case: unknown; action: unknown; replay?: boolean }>(`/api/inboxes/${encodeURIComponent(inboxId)}/cases/${encodeURIComponent(caseId)}/actions`, {
    method: 'POST',
    headers: { 'Idempotency-Key': `${actionKey}-${caseId}-${crypto.randomUUID()}` },
    body: JSON.stringify({ actionKey, externalRefs })
  }),
  agentAddressAvailability: (inboxId: string, localPart: string) => request<{ localPart: string; address: string; available: boolean }>(`/api/inboxes/${encodeURIComponent(inboxId)}/agent-address-availability?localPart=${encodeURIComponent(localPart)}`),
  enrollmentToken: (inboxId: string, name: string, localPart: string, permissions: string[], runtime: ConnectorRuntime = 'openclaw') => request<EnrollmentResult>(`/api/inboxes/${encodeURIComponent(inboxId)}/agent-enrollment-tokens`, {
    method: 'POST',
    body: JSON.stringify({ runtime, permissions, agentProfile: { name, localPart } })
  }).then(result => result.quickConnect ? { ...result, quickConnect: validateQuickConnectHandoff(result.quickConnect) } : result),
  enrollmentStatus: (inboxId: string, enrollmentId: string, signal?: AbortSignal) => request<EnrollmentStatus>(`/api/inboxes/${encodeURIComponent(inboxId)}/agent-enrollment-tokens/${encodeURIComponent(enrollmentId)}/status`, { signal }),
  approveAgent: (inboxId: string, agentId: string, permissions: string[]) => request<{ agent: unknown; agentApiToken?: string }>(`/api/inboxes/${encodeURIComponent(inboxId)}/agent-onboarding/${encodeURIComponent(agentId)}/approve`, { method: 'POST', body: JSON.stringify({ permissions }) })
  ,updateAgentPermissions: (inboxId: string, agentId: string, permissions: string[], expectedPermissions: string[]) => request<{ agent: Agent }>(`/api/inboxes/${encodeURIComponent(inboxId)}/agents/${encodeURIComponent(agentId)}/permissions`, { method: 'POST', body: JSON.stringify({ permissions, expectedPermissions }) })
  ,removeAgent: (inboxId: string, agentId: string, deleteHistory: boolean, confirmation: string) => request<{ removed: boolean; deletedHistory: boolean }>(`/api/inboxes/${encodeURIComponent(inboxId)}/agents/${encodeURIComponent(agentId)}/remove`, { method: 'POST', body: JSON.stringify({ deleteHistory, confirmation }) })
  ,revokeAgentCredentials: (inboxId: string, agentId: string) => request<{ revoked: boolean; agentId: string; credentialFamilyCount: number; revokedAt: string }>(`/api/inboxes/${encodeURIComponent(inboxId)}/agents/${encodeURIComponent(agentId)}/credentials/revoke`, { method: 'POST', body: '{}' })
  ,reconnectAgentToken: (inboxId: string, agentId: string, runtime?: ConnectorRuntime, permissions?: string[]) => request<EnrollmentResult & { agentId: string; address: string }>(`/api/inboxes/${encodeURIComponent(inboxId)}/agents/${encodeURIComponent(agentId)}/credentials/reconnect-token`, { method: 'POST', body: JSON.stringify({ ...(runtime ? { runtime } : {}), ...(permissions ? { permissions } : {}) }) }).then(result => result.quickConnect ? { ...result, quickConnect: validateQuickConnectHandoff(result.quickConnect) } : result)
  ,setAgentPaused: (inboxId: string, agentId: string, paused: boolean) => request<Agent>(`/api/inboxes/${encodeURIComponent(inboxId)}/agents/${encodeURIComponent(agentId)}/${paused ? 'pause' : 'resume'}`, { method: 'POST', body: '{}' })
  ,setNativeContactBlocked: (inboxId: string, agentId: string, blocked: boolean) => request<{ agentId: string; blocked: boolean; updatedAt: string }>(`/api/inboxes/${encodeURIComponent(inboxId)}/contacts/${encodeURIComponent(agentId)}/${blocked ? 'block' : 'unblock'}`, { method: 'POST', body: '{}' })
  ,downloadAsset: (inboxId: string, assetId: string) => request<{ object: Asset; download: { url: string; method: 'GET'; headers?: Record<string, string> } }>(`/api/inboxes/${encodeURIComponent(inboxId)}/assets/${encodeURIComponent(assetId)}/download`)
  ,emailTransport: (inboxId: string) => request<EmailTransportStatus>(`/api/inboxes/${inboxId}/email-transport`)
  ,approveExternalContact: (inboxId: string, input: { email: string; displayName: string; direction: ApprovedEmailContact['direction'] }) => request<ApprovedEmailContact>(`/api/inboxes/${encodeURIComponent(inboxId)}/external-contacts`, { method: 'POST', body: JSON.stringify(input) })
  ,setExternalContactBlocked: (inboxId: string, contactId: string, blocked: boolean) => request<ApprovedEmailContact>(`/api/inboxes/${encodeURIComponent(inboxId)}/external-contacts/${encodeURIComponent(contactId)}/${blocked ? 'block' : 'unblock'}`, { method: 'POST', body: '{}' })
  ,calendarConnectors: (inboxId: string) => request<{ providers: Record<CalendarProvider['id'], CalendarProvider>; connectors: CalendarConnector[] }>(`/api/inboxes/${inboxId}/calendar-connectors`)
  ,connectCalendar: (inboxId: string, provider: CalendarProvider['id']) => request<{ provider: CalendarProvider['id']; authorizationUrl: string; expiresAt: string }>(`/api/inboxes/${inboxId}/calendar-connectors/${provider}/connect`, { method: 'POST', body: '{}' })
  ,disconnectCalendar: (inboxId: string, provider: CalendarProvider['id']) => request<CalendarConnector>(`/api/inboxes/${inboxId}/calendar-connectors/${provider}/disconnect`, { method: 'POST', body: '{}' })
};
