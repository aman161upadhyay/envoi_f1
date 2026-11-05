import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { Inbox } from '../types';
import { onboardingApi } from './api';
import { ClaimProblemNotice, useClaimClock } from './ClaimPage';
import { ClaimController, newestActiveInstallation } from './claim-state';
import { canReconnectAgent, permissionLabel, routeLabel, type ClaimAgent, type OnboardingApi, type RegistrationPermission } from './types';
import type { ConsentApproval } from './remote-auth-types';

export interface ConsentTargetFormProps {
  workspaces: Inbox[]; agents: ClaimAgent[]; requested: RegistrationPermission[]; grantable: RegistrationPermission[];
  disabled: boolean; onApprove: (body: ConsentApproval) => Promise<unknown>; onDeny?: () => void; client?: OnboardingApi; controller?: ClaimController;
}
/** The server remains authoritative for management, eligibility, slots and staleness. */
export function ConsentTargetForm({ workspaces, agents, requested, grantable, disabled, onApprove, onDeny, client = onboardingApi, controller: supplied }: ConsentTargetFormProps) {
  const replacement = useMemo(() => supplied ?? new ClaimController(client), [client, supplied]);
  const review = useSyncExternalStore(replacement.subscribe, replacement.getSnapshot, replacement.getSnapshot);
  useEffect(() => () => replacement.dispose(), [replacement]);
  const now = useClaimClock(replacement.now);
  const [kind, setKind] = useState<'new_agent' | 'existing_agent'>('new_agent');
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? '');
  const [name, setName] = useState(''); const [localPart, setLocalPart] = useState('');
  const [agentId, setAgentId] = useState('');
  const [permissions, setPermissions] = useState<RegistrationPermission[]>(requested.filter(value => grantable.includes(value)));
  const eligible = agents.filter(canReconnectAgent);
  const agent = eligible.find(value => value.id === agentId);
  const current = review.installations ? newestActiveInstallation(review.installations) : null;
  const ready = Boolean(agent && review.replacementScope?.agentId === agent.id && review.installations && review.replacementConfirmed);
  const locked = disabled || review.busy || review.blocked || review.retryAt > now;
  function chooseAgent(id: string) {
    setAgentId(id); const selected = eligible.find(item => item.id === id);
    setPermissions(requested.filter(value => grantable.includes(value) && (value === 'receive_agent_messages' || selected?.permissions.includes(value))));
    if (selected) void replacement.reviewReplacement(selected.inboxId, selected.id);
  }
  return <form className="onboarding-approval-form" onSubmit={event => {
    event.preventDefault(); if (locked || (kind === 'existing_agent' && !ready)) return;
    if (kind === 'new_agent' && (!workspaceId || !name.trim() || !localPart.trim())) return;
    void onApprove({ target: kind === 'new_agent'
      ? { kind, workspaceInboxId: workspaceId, name: name.trim(), localPart: localPart.trim() }
      : { kind, agentId, replacesInstallationId: current?.id ?? null }, grantedPermissions: [...permissions], policyProfile: 'default' });
  }}>
    <ClaimProblemNotice problem={review.problem} now={now} />
    <fieldset disabled={locked}><legend>Choose the agent identity</legend>
      <label><input type="radio" name="oauth-target" checked={kind === 'new_agent'} onChange={() => { setKind('new_agent'); setPermissions(requested.filter(value => grantable.includes(value))); }} />Create a new agent</label>
      <label><input type="radio" name="oauth-target" checked={kind === 'existing_agent'} disabled={!eligible.length} onChange={() => { setKind('existing_agent'); chooseAgent(agentId); }} />Reconnect an existing agent</label>
      {kind === 'new_agent' ? <div className="onboarding-fields">
        <label className="field"><span>Workspace</span><select value={workspaceId} onChange={event => setWorkspaceId(event.target.value)} required><option value="">Choose a workspace</option>{workspaces.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
        <label className="field"><span>Agent name</span><input value={name} onChange={event => setName(event.target.value)} maxLength={80} required /></label>
        <label className="field"><span>Address name</span><input value={localPart} onChange={event => setLocalPart(event.target.value)} autoCapitalize="none" autoComplete="off" spellCheck={false} minLength={3} maxLength={32} pattern="[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*" required /></label>
      </div> : <>
        <label className="field"><span>Existing agent</span><select value={agentId} onChange={event => chooseAgent(event.target.value)} required><option value="">Choose an agent</option>{eligible.map(item => <option key={item.id} value={item.id}>{item.name} · {item.address}</option>)}</select></label>
        {agent && <div className="onboarding-replacement">
          <p>The agent keeps its address, cases and history{agent.paused || agent.status === 'paused' ? ', and stays paused until you resume it' : ''}. Activation replaces every active installation; current connections keep working until then.</p>
          {review.installations && review.replacementScope?.agentId === agent.id ? <>
            <p>{current ? 'Newest active installation: ' + current.runtime.type + ' · ' + routeLabel(current.connectionRoute) : 'There is no active installation to replace.'}</p>
            <label><input type="checkbox" checked={review.replacementConfirmed} onChange={event => replacement.confirmReplacement(event.target.checked)} />I reviewed the current connection and confirm this replacement.</label>
          </> : <button className="button secondary" type="button" onClick={() => void replacement.reviewReplacement(agent.inboxId, agent.id)}>Review current installations</button>}
        </div>}
      </>}
    </fieldset>
    <fieldset disabled={locked}><legend>Permissions</legend><p>Only requested permissions allowed by workspace policy can be granted. Receiving messages is required.</p>
      {kind === 'existing_agent' && <p>Existing permissions are selected initially. To add a requested permission, select it explicitly before approving.</p>}
      <div className="onboarding-permissions">{requested.map(value => <label key={value}>
        <input type="checkbox" checked={permissions.includes(value)} disabled={value === 'receive_agent_messages' || !grantable.includes(value)} onChange={event => setPermissions(previous => event.target.checked ? [...new Set([...previous, value])] : previous.filter(item => item !== value))} />
        {permissionLabel(value)}{value === 'receive_agent_messages' ? ' (required)' : !grantable.includes(value) ? ' (not grantable)' : ''}
      </label>)}</div>
      {!permissions.includes('send_agent_messages') && <p className="onboarding-notice" role="status">This approval allows receiving only; the assistant cannot send messages or replies.{requested.includes('send_agent_messages') && grantable.includes('send_agent_messages') ? ' Select send agent messages above if you want two-way messaging.' : ' Sending must first be requested by the plugin and allowed by workspace policy.'}</p>}
    </fieldset>
    <div className="onboarding-actions">{onDeny && <button className="button secondary" type="button" disabled={locked} onClick={onDeny}>Decline connection</button>}
      <button className="button primary" disabled={locked || (kind === 'existing_agent' ? !ready : !workspaceId || !name.trim() || !localPart.trim())}>Approve access</button>
    </div>
  </form>;
}
