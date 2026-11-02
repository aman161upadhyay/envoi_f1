import { useState, type FormEvent } from 'react';
import { api, type PhaseDDiscovery, type PhaseDGrant, type PhaseDInvitation } from './api';

const grantOptions: Array<{ id: PhaseDGrant; label: string }> = [
  { id: 'shareAssets', label: 'Share files' },
  { id: 'autoAcceptSelectedTasks', label: 'Auto-accept selected tasks' },
  { id: 'richerProfileVisibility', label: 'Show richer profile' },
  { id: 'allowInvitations', label: 'Allow invitations' }
];

function message(error: unknown) { return error instanceof Error ? error.message : 'Request failed'; }

export function PhaseDTrustControls({ inboxId, actorAgentId }: { inboxId: string; actorAgentId: string }) {
  const [address, setAddress] = useState('');
  const [found, setFound] = useState<PhaseDDiscovery | null>(null);
  const [grants, setGrants] = useState<PhaseDGrant[]>([]);
  const [invitation, setInvitation] = useState<PhaseDInvitation | null>(null);
  const [revokeInvitationId, setRevokeInvitationId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function run(action: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (caught) { setError(message(caught)); }
    finally { setBusy(false); }
  }
  function lookup(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const result = await api.discoverAgentForOwner(inboxId, address.trim(), actorAgentId);
      setFound(result); setGrants(result.grants || []);
    });
  }
  function setGrant(grant: PhaseDGrant, checked: boolean) {
    setGrants(current => checked ? [...new Set([...current, grant])] : current.filter(item => item !== grant));
  }
  return <section className="agent-trust-controls" aria-label="Agent trust and discovery">
    <h3>Agent trust and discovery</h3>
    <p>Look up an exact agent address before granting access or issuing an invitation.</p>
    <form onSubmit={lookup}>
      <label htmlFor={`trust-address-${actorAgentId}`}>Agent address</label>
      <input id={`trust-address-${actorAgentId}`} type="email" value={address} onChange={event => { setAddress(event.target.value); setFound(null); setInvitation(null); setError(''); }} disabled={busy} required />
      <button type="submit" disabled={busy}>Find agent</button>
    </form>
    {found && <div>
      <p><strong>{found.address}</strong> · {found.trust.replaceAll('_', ' ')}</p>
      <fieldset disabled={busy}>
        <legend>Access from this agent to the selected agent</legend>
        {grantOptions.map(option => <label key={option.id}><input type="checkbox" checked={grants.includes(option.id)} onChange={event => setGrant(option.id, event.target.checked)} />{option.label}</label>)}
      </fieldset>
      <div className="dialog-actions">
        <button type="button" disabled={busy || grants.length === 0} onClick={() => void run(async () => {
          const result = await api.grantRelationship(inboxId, actorAgentId, found.address, grants);
          setFound({ ...found, trust: 'relationship', grants: result.grants });
          setNotice('Relationship granted.');
        })}>Save grants</button>
        {found.trust === 'relationship' && <button type="button" disabled={busy} onClick={() => void run(async () => {
          await api.revokeRelationship(inboxId, actorAgentId, found.agentId);
          const current = await api.discoverAgentForOwner(inboxId, found.address, actorAgentId);
          setFound(current); setGrants(current.grants || []);
          setNotice('Relationship revoked.');
        })}>Revoke relationship</button>}
        <button type="button" disabled={busy} onClick={() => void run(async () => {
          const result = await api.issueDiscoveryInvitation(inboxId, actorAgentId, found.address);
          setInvitation(result); setRevokeInvitationId(result.id);
          setNotice('Invitation issued. Copy the token now; it is shown once.');
        })}>Issue invitation</button>
      </div>
    </div>}
    {invitation && <div className="credential-once">
      <p>Invitation token (shown once; expires {new Date(invitation.expiresAt).toLocaleString()})</p>
      <input aria-label="Discovery invitation token" readOnly value={invitation.invitation} onFocus={event => event.currentTarget.select()} />
      <button type="button" onClick={() => void navigator.clipboard.writeText(invitation.invitation).then(() => setNotice('Invitation copied.'), caught => setError(message(caught)))}>Copy invitation</button>
    </div>}
    <form onSubmit={event => { event.preventDefault(); void run(async () => {
      await api.revokeDiscoveryInvitation(inboxId, revokeInvitationId.trim());
      setInvitation(null); setRevokeInvitationId(''); setNotice('Invitation revoked.');
    }); }}>
      <label htmlFor={`trust-invitation-${actorAgentId}`}>Invitation ID to revoke</label>
      <input id={`trust-invitation-${actorAgentId}`} value={revokeInvitationId} onChange={event => setRevokeInvitationId(event.target.value)} disabled={busy} required />
      <button type="submit" disabled={busy || !revokeInvitationId.trim()}>Revoke invitation</button>
    </form>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
