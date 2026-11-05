import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { Inbox } from '../types';
import { ClaimProblemNotice, useClaimClock } from './ClaimPage';
import { ConsentTargetForm } from './ConsentTargetForm';
import { ConsentController, consentOutcomeText } from './consent-state';
import { remoteAuthApi } from './remote-auth-api';
import { permissionLabel, routeLabel, type ClaimAgent, type OnboardingApi } from './types';
import type { RemoteAuthApi } from './remote-auth-types';

export interface AuthorizeAgentPageProps {
  humanId: string; handle: string | null; workspaces: Inbox[]; agents: ClaimAgent[];
  client?: RemoteAuthApi; controller?: ConsentController; replacementClient?: OnboardingApi;
}
const navigate = (url: string) => window.location.replace(url);
export function AuthorizeAgentPage(props: AuthorizeAgentPageProps) {
  return <AuthorizeAgentSession key={props.humanId + ':' + props.handle} {...props} />;
}
function AuthorizeAgentSession({ humanId, handle, workspaces, agents, client = remoteAuthApi, controller: supplied, replacementClient }: AuthorizeAgentPageProps) {
  const controller = useMemo(() => supplied ?? new ConsentController(handle, client, navigate), [humanId, handle, client, supplied]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => { void controller.load(); return () => controller.dispose(); }, [controller]);
  const now = useClaimClock(controller.now);
  const view = state.view; const outcome = state.outcome;
  const expired = Boolean(view && Date.parse(view.expiresAt) <= now);
  const locked = state.busy || state.blocked || state.retryAt > now || state.phase === 'redirecting';
  return <section className="onboarding-page claim-page" aria-labelledby="oauth-title">
    <header className="onboarding-heading"><div><p className="eyebrow">Envoi · owner approval</p><h1 id="oauth-title">Connect your assistant</h1></div></header>
    <ClaimProblemNotice problem={state.problem} now={now} />
    {!view && !state.problem && <p role="status">Loading connection request…</p>}
    {view && !state.blocked && <section className="onboarding-request">
      <h2>What this assistant requests</h2><p><strong>{view.client.name}</strong> (claims to be) · {view.client.clientIdHost ?? view.client.provider}</p>
      <p>The name is a claim made by the client. It does not verify who runs it.</p>
      {view.connectionRoute === 'remote_mcp_oauth' && <p>This is Envoi’s OAuth approval step. Your assistant continues running in its own app.</p>}
      <dl><div><dt>Connection route</dt><dd>{routeLabel(view.connectionRoute)}</dd></div><div><dt>Authorization returns to</dt><dd>{view.client.redirectHost}</dd></div>
        <div><dt>Requested permissions</dt><dd>{view.requestedPermissions.map(permissionLabel).join(', ')}</dd></div></dl>
      {view.connectionRoute === 'remote_mcp_oauth' && !view.requestedPermissions.includes('send_agent_messages') && <p className="onboarding-notice" role="status"><strong>Receive-only connection.</strong> This request cannot send agent messages or replies. For two-way messaging, return to the plugin connection and request envoi.agent envoi.send, then approve a new request. You can continue with receiving only if that is what you intend.</p>}
      {view.requestedPermissions.includes('send_agent_messages') && !view.grantablePermissions.includes('send_agent_messages') && <p className="onboarding-notice" role="status">Workspace policy does not allow sending in this request. Ask your workspace administrator to review that policy before using two-way messaging.</p>}
      {view.client.loopbackRedirect && <p className="onboarding-notice" role="note">Any program on that computer could receive this authorization. Approve only a connection you just started.</p>}
    </section>}
    {outcome && <section className="onboarding-result" role="status"><p>{consentOutcomeText[outcome.status]}</p>
      {outcome.status !== 'denied' && <><p>{outcome.agent.name} · {outcome.agent.address}</p><p>Workspace: {outcome.workspaceName}</p><p>Effective permissions: {outcome.effectivePermissions.map(permissionLabel).join(', ')}.</p></>}
      {outcome.status === 'pending_exchange' && <>
        <p>Approval lapses at <time dateTime={outcome.codeExpiresAt}>{new Date(outcome.codeExpiresAt).toLocaleString()}</time>.</p>
        {Date.parse(outcome.codeExpiresAt) <= now && <p>The deadline passed. Refresh the outcome before starting again.</p>}
        <p>If a new approval reports that the address is held, withdraw this pending approval first.</p>
        <button className="button secondary" type="button" disabled={locked} onClick={() => void controller.withdraw()}>Withdraw approval</button>
      </>}
    </section>}
    {view && !outcome && state.uncertain && <div className="onboarding-notice" role="status"><p>The decision's outcome is uncertain. Retry the same decision or refresh its outcome. Start again from your assistant if it did not connect.</p>
      <button className="button secondary" type="button" disabled={locked || !state.problem?.retryable || state.attempts >= 3} onClick={() => void controller.retryDecision()}>Retry same decision</button>
    </div>}
    {view && !outcome && !state.uncertain && <>
      <p>Request expires at <time dateTime={view.expiresAt}>{new Date(view.expiresAt).toLocaleString()}</time>.</p>
      {expired ? <p role="status">This request expired. Start again from your assistant.</p>
        : <ConsentTargetForm key={state.attempts} workspaces={workspaces} agents={agents} requested={view.requestedPermissions} grantable={view.grantablePermissions}
          disabled={locked} onApprove={body => controller.approve(body)} onDeny={() => void controller.deny()} client={replacementClient} />}
    </>}
    <button className="button secondary" type="button" disabled={locked} onClick={() => void controller.load()}>Refresh outcome</button>
    <a className="button quiet" href="/app">Back to workspace</a>
  </section>;
}
