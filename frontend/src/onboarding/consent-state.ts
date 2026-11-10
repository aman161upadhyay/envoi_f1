import { claimProblem, type ClaimProblem } from './claim-state';
import * as validate from './remote-auth.validator.mjs';
import { hasRemotePermissions, remoteGrantAllowed, remoteTargetMatches, remoteTargetValid } from './remote-auth-grants';
import type { ConsentApproval, ConsentApproved, ConsentDecided, ConsentView, RemoteAuthApi } from './remote-auth-types';

function validView(raw: unknown): raw is ConsentView {
  if (!validate.consentView(raw)) return false;
  const view = raw as ConsentView;
  return hasRemotePermissions(view.requestedPermissions) && hasRemotePermissions(view.grantablePermissions)
    && (!view.decision || view.decision.status === 'denied' || (remoteGrantAllowed(view.decision.effectivePermissions) && remoteTargetValid(view.decision)));
}

export function authorizationHandle(search: string) {
  const params = new URLSearchParams(search);
  const handles = params.getAll('request');
  const value = handles[0];
  return handles.length === 1 && value && value.length <= 2048 && !/[\s\u0000-\u001f\u007f]/.test(value) ? value : null;
}
const startErrors = {
  invalid_client: 'Envoi could not verify the assistant’s OAuth client configuration. Contact Envoi support before retrying. Your agent permissions have not changed.',
  invalid_redirect_uri: 'Envoi could not verify where this assistant should return after approval. Contact Envoi support before retrying.',
  invalid_request: 'The assistant sent an invalid connection request. Start again from your assistant; contact Envoi support if it repeats.'
} as const;
export type AuthorizationStartError = keyof typeof startErrors;
export function authorizationStartError(search: string): AuthorizationStartError | null {
  const params = new URLSearchParams(search), errors = params.getAll('error');
  if (params.has('request') || errors.length !== 1 || !Object.hasOwn(startErrors, errors[0])) return null;
  return errors[0] as AuthorizationStartError;
}
export const authorizationStartMessage = (error: AuthorizationStartError) => startErrors[error];
export function authorizationSignInPath(path: string, search: string) {
  const handle = authorizationHandle(search);
  const error = authorizationStartError(search);
  const target = handle ? '/authorize-agent?request=' + encodeURIComponent(handle)
    : error ? '/authorize-agent?error=' + error : '/authorize-agent';
  const url = new URL(path, 'https://www.envoi-agents.com');
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '/api/auth/workos/sign-in?returnTo=' + encodeURIComponent(target);
  url.searchParams.set('returnTo', target);
  return path.startsWith('/') && !path.startsWith('//') ? url.pathname + url.search : url.href;
}
export const consentOutcomeText = {
  pending_exchange: "Approved. Go back to your assistant to finish connecting. If it doesn't connect, start again from your assistant.",
  completed: 'Connected. You can close this page.',
  expired: 'This approval expired before your assistant finished. Start again from your assistant.',
  withdrawn: 'This approval no longer holds. Start again from your assistant.',
  denied: 'Connection declined. You can close this page.'
} as const;
export interface ConsentState {
  view: ConsentView | null; outcome: ConsentDecided | { status: 'denied' } | null;
  phase: 'loading' | 'review' | 'decided' | 'redirecting'; busy: boolean; blocked: boolean;
  problem: ClaimProblem | null; retryAt: number; uncertain: boolean; attempts: number;
}
const initial = (): ConsentState => ({ view: null, outcome: null, phase: 'loading', busy: false, blocked: false, problem: null, retryAt: 0, uncertain: false, attempts: 0 });
type Decision = { kind: 'approve'; body: ConsentApproval } | { kind: 'deny' };

/** Never stores the handle, code or redirect in browser storage, rendered state or telemetry. */
export class ConsentController {
  private state = initial();
  private listeners = new Set<() => void>();
  private active: AbortController | null = null;
  private generation = 0;
  private decision: Decision | null = null;
  constructor(private handle: string | null, private client: RemoteAuthApi, private navigate: (url: string) => void, readonly now: () => number = Date.now) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<ConsentState>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  dispose = () => { this.generation++; this.active?.abort(); this.active = null; this.decision = null; this.state = initial(); this.listeners.clear(); };
  private allowed() { return !this.state.busy && !this.state.blocked && this.state.retryAt <= this.now() && this.state.phase !== 'redirecting'; }
  private begin() {
    this.active?.abort(); const active = this.active = new AbortController(); const generation = ++this.generation;
    this.update({ busy: true, problem: null });
    return { signal: active.signal, current: () => generation === this.generation && !active.signal.aborted };
  }
  private failure(caught: unknown) {
    const problem = claimProblem(caught, this.now(), this.state.attempts);
    if (problem.code === 'AUTHORIZATION_REQUEST_INVALID') problem.message = 'This request is no longer available. Start again from your assistant.';
    if (problem.code === 'INVALID_OAUTH_RESPONSE') problem.message = 'The connection response could not be verified. Start again from your assistant.';
    const terminal = problem.blocksSession || ['FEATURE_DISABLED', 'AUTHORIZATION_REQUEST_INVALID', 'INVALID_OAUTH_RESPONSE'].includes(problem.code);
    this.update({ busy: false, problem, retryAt: problem.retryAt, blocked: terminal,
      ...(terminal ? { view: null, outcome: null, uncertain: false } : {}) });
    if (terminal) this.decision = null;
    return problem;
  }
  private invalid(): never { throw { code: 'INVALID_OAUTH_RESPONSE' }; }
  async load() {
    if (!this.allowed()) return false;
    if (!this.handle) { this.failure({ code: 'AUTHORIZATION_REQUEST_INVALID' }); return false; }
    const op = this.begin();
    try {
      const raw = await this.client.view(this.handle, op.signal); if (!op.current()) return false;
      if (!validView(raw)) this.invalid();
      const view = raw as ConsentView;
      if (view.decision) this.decision = null;
      this.update({ view, outcome: view.decision ?? null, phase: view.decision ? 'decided' : 'review', busy: false,
        retryAt: 0, uncertain: Boolean(this.decision) });
      return true;
    } catch (caught) { if (op.current()) this.failure(caught); return false; }
  }
  async approve(body: ConsentApproval) {
    if (!this.allowed() || this.decision || this.state.outcome || !this.state.view || Date.parse(this.state.view.expiresAt) <= this.now()) return false;
    if (!validate.consentApproveRequest(body) || !remoteGrantAllowed(body.grantedPermissions)
      || body.grantedPermissions.some(permission => !this.state.view!.requestedPermissions.includes(permission) || !this.state.view!.grantablePermissions.includes(permission))) return false;
    this.decision = { kind: 'approve', body: structuredClone(body) };
    return this.sendDecision();
  }
  async deny() {
    if (!this.allowed() || this.decision || this.state.outcome || !this.state.view || Date.parse(this.state.view.expiresAt) <= this.now()) return false;
    this.decision = { kind: 'deny' }; return this.sendDecision();
  }
  retryDecision() {
    if (!this.allowed() || !this.state.uncertain || !this.decision || !this.state.problem?.retryable || this.state.attempts >= 3) return Promise.resolve(false);
    return this.sendDecision();
  }
  private async sendDecision() {
    const decision = this.decision; if (!decision || !this.handle) return false;
    const op = this.begin();
    try {
      const raw = decision.kind === 'approve' ? await this.client.approve(this.handle, structuredClone(decision.body), op.signal) : await this.client.deny(this.handle, op.signal);
      if (!op.current()) return false;
      if (decision.kind === 'approve' && validate.consentDecided(raw)) {
        if (!remoteTargetMatches(decision.body.target, raw as ConsentDecided)
          || !remoteGrantAllowed((raw as ConsentDecided).effectivePermissions, decision.body.grantedPermissions)) this.invalid();
        this.decision = null; this.update({ outcome: raw as ConsentDecided, phase: 'decided', busy: false, uncertain: false, retryAt: 0 }); return true;
      }
      if (decision.kind === 'approve' ? !validate.consentApproved(raw) : !validate.consentDenied(raw)) this.invalid();
      const response = raw as ConsentApproved;
      if (decision.kind === 'approve' && (!remoteTargetMatches(decision.body.target, response)
        || !remoteGrantAllowed(response.effectivePermissions, decision.body.grantedPermissions))) this.invalid();
      const redirect = new URL(response.redirectTo);
      const client = this.state.view!.client;
      if (redirect.host !== client.redirectHost || redirect.username || redirect.password || redirect.hash
        || (client.loopbackRedirect ? redirect.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(redirect.hostname) : redirect.protocol !== 'https:')) this.invalid();
      const outcome = decision.kind === 'approve'
        ? (({ redirectTo: _redirect, ...safe }) => ({ ...safe, status: 'pending_exchange' as const }))(response)
        : { status: 'denied' as const };
      if (outcome.status === 'pending_exchange' && Date.parse(outcome.codeExpiresAt) <= this.now()) {
        this.decision = null; this.update({ outcome: { ...outcome, status: 'expired' }, phase: 'decided', busy: false, uncertain: false }); return true;
      }
      this.decision = null; this.update({ outcome, phase: 'redirecting', busy: false, uncertain: false, retryAt: 0 });
      // No code-bearing URL is retained, even if navigation fails.
      if (op.current()) { try { this.navigate(response.redirectTo); } catch { this.update({ phase: 'decided' }); } }
      return true;
    } catch (caught) {
      if (!op.current()) return false;
      const problem = this.failure(caught);
      if (this.state.blocked) return false;
      // Ambiguous writes are locked to this exact decision until an outcome is read.
      const editable = ['CLAIM_INVALID', 'CLAIM_FORBIDDEN', 'CLAIM_STALE', 'AGENT_NOT_RECONNECTABLE', 'ADDRESS_TAKEN', 'ACTIVE_AGENT_LIMIT', 'PENDING_ACTIVATION_LIMIT'].includes(problem.code);
      if (editable) this.decision = null;
      this.update({ uncertain: !editable, attempts: this.state.attempts + 1 });
      return false;
    }
  }
  async withdraw() {
    const outcome = this.state.outcome;
    if (!this.allowed() || outcome?.status !== 'pending_exchange' || !this.handle) return false;
    const op = this.begin();
    try {
      await this.client.withdraw(outcome.registrationId, op.signal);
      if (!op.current()) return false;
      // Read the authoritative outcome: an exchange could have won the race.
      const raw = await this.client.view(this.handle, op.signal); if (!op.current()) return false;
      if (!validView(raw) || !raw.decision) this.invalid();
      const view = raw as ConsentView;
      this.update({ view, outcome: view.decision!, phase: 'decided', busy: false, problem: null, retryAt: 0 }); return true;
    } catch (caught) { if (op.current()) this.failure(caught); return false; }
  }
}
