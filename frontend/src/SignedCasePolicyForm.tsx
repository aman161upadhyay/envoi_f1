import { useEffect, useState, type FormEvent } from 'react';
import { api } from './api';
import { preferredOwnerSigningMethod, readOwnerPasskey, setupOwnerDevice, setupOwnerPasskey, signOwnerDocument, supportsOwnerPasskey,
  type OwnerSigningMethod, type SignedCaseGrant, type SignedPolicyDocument, type SignedPolicyDraft } from './signed-case-policy';
import type { Asset, WorkCase } from './types';

type DraftGrant = Omit<SignedCaseGrant, 'target'> & { targetText: string };

const dayMs = 24 * 60 * 60 * 1000;
const emptyGrant = (): DraftGrant => ({ id: crypto.randomUUID(), action: '', decision: 'deny', targetText: '{}' });

function parseTarget(text: string): Record<string, unknown> {
  try {
    const result: unknown = JSON.parse(text);
    if (result && typeof result === 'object' && !Array.isArray(result)) return result as Record<string, unknown>;
  } catch { /* Show one actionable message for both invalid forms. */ }
  throw new Error('Enter the exact action target as a JSON object.');
}

export function SignedCasePolicyForm({ inboxId, caseId, assets, groupMembers, onClose, onSaved, onBusy }: {
  inboxId: string; caseId: string; assets: Asset[]; groupMembers?: WorkCase['members']; onClose: () => void; onSaved: () => void; onBusy: (busy: boolean) => void;
}) {
  const [draft, setDraft] = useState<SignedPolicyDraft | null>(null);
  const [grants, setGrants] = useState<DraftGrant[]>([]);
  const [days, setDays] = useState('7');
  const [method, setMethod] = useState<OwnerSigningMethod>('demo_device');
  const [demoPublicKey, setDemoPublicKey] = useState('');
  const [passkeyPublicKey, setPasskeyPublicKey] = useState('');
  const [review, setReview] = useState<SignedPolicyDocument | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const caseFiles = assets.filter(asset => asset.caseId === caseId && asset.checksumSha256 && (asset.state === 'clean' || asset.scan?.status === 'clean'));

  useEffect(() => {
    let cancelled = false;
    void api.signedCasePolicy(inboxId, caseId).then(next => {
      if (cancelled) return;
      setDraft(next);
      setMethod(preferredOwnerSigningMethod(next.ownerId, next.signing));
      setDemoPublicKey('');
      setPasskeyPublicKey(readOwnerPasskey(next.ownerId, next.signing)?.publicKey ?? '');
      setGrants(next.active?.grants.map(({ target, ...grant }) => ({ ...grant, targetText: JSON.stringify(target, null, 2) })) ?? []);
    }).catch(caught => {
      if (!cancelled) setError(caught instanceof Error ? caught.message : 'Could not load case permissions.');
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [inboxId, caseId]);

  async function run(operation: () => Promise<void>) {
    setBusy(true);
    onBusy(true);
    setError('');
    try { await operation(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not save case permissions.'); }
    finally { setBusy(false); onBusy(false); }
  }

  function updateGrant(id: string, changes: Partial<DraftGrant>) {
    setGrants(current => current.map(grant => grant.id === id ? { ...grant, ...changes } : grant));
  }

  function preview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || busy) return;
    void run(async () => {
      const { workspaceId, ownerId, agentId, version, previousHash } = draft;
      const issuedAtMs = Date.now();
      const result = await api.previewSignedCasePolicy(inboxId, caseId, {
        schema: 'envoi.case-policy/v1', workspaceId, caseId, ownerId, agentId, version, previousHash,
        issuedAtMs, expiresAtMs: issuedAtMs + Number(days) * dayMs,
        grants: grants.map(({ action, targetText, ...grant }) => ({ ...grant, action: action.trim(), target: parseTarget(targetText) }))
      });
      setReview(result.document);
    });
  }

  async function save() {
    if (!draft || !review || busy) return;
    await run(async () => {
      await api.saveSignedCasePolicy(inboxId, caseId, await signOwnerDocument(review, method, draft.signing));
      onSaved();
    });
  }

  const passkeyAvailable = supportsOwnerPasskey(draft?.signing);
  const publicKey = method === 'passkey' ? passkeyPublicKey : demoPublicKey;
  return <div className="signed-policy-form">
    {loading && <p role="status">Loading case permissions…</p>}
    {error && <p role="alert" className="form-error">{error}</p>}
    {draft && <>
      <div className="signed-policy-device">
        {passkeyAvailable && <label>Signing method
          <select value={method} disabled={busy} onChange={event => { setMethod(event.target.value === 'passkey' ? 'passkey' : 'demo_device'); setError(''); }}>
            <option value="demo_device">Demo device</option>
            <option value="passkey">Passkey</option>
          </select>
        </label>}
        {method === 'passkey' ? !passkeyPublicKey &&
          <button type="button" className="button secondary" disabled={busy} onClick={() => void run(async () =>
            setPasskeyPublicKey(await setupOwnerPasskey(draft.ownerId, draft.signing))
          )}>Create a passkey</button> :
          <button type="button" className="button secondary" disabled={busy} onClick={() => void run(async () =>
            setDemoPublicKey(await setupOwnerDevice(draft.ownerId))
          )}>Show demo device key</button>}
        {publicKey && <label>{method === 'passkey' ? 'Passkey public key' : 'Public device key'}
          <input readOnly value={publicKey} onFocus={event => event.currentTarget.select()} />
          <small>Register this key as <code>{method}</code> from {draft.signing.ownerAccount} on {draft.signing.network} in {draft.signing.recordContract} before requesting a new review.</small>
        </label>}
      </div>
      {review ? <>
        <h3>Review what you’ll sign</h3>
        <ul className="signed-policy-display">{review.display.map((line, index) => <li key={index}>{line}</li>)}</ul>
        <div className="dialog-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={() => { setReview(null); setError(''); }}>Edit</button>
          <button type="button" className="button primary" disabled={busy || (method === 'passkey' && !passkeyPublicKey)} onClick={() => void save()}>{busy ? 'Saving…' : 'Sign and save'}</button>
        </div>
      </> : <form onSubmit={preview}>
        {grants.map((grant, index) => <fieldset key={grant.id} disabled={busy}>
          <legend>Grant {index + 1}</legend>
          <label>Action
            <input required maxLength={100} value={grant.action} onChange={event => updateGrant(grant.id, { action: event.target.value })} />
          </label>
          <label>Permission
            <select value={grant.decision} onChange={event => updateGrant(grant.id, { decision: event.target.value as DraftGrant['decision'] })}>
              <option value="deny">Off</option><option value="needsHuman">Ask first</option><option value="allow">Allowed</option>
            </select>
          </label>
          <label>Exact target (JSON)
            <textarea required rows={3} spellCheck={false} value={grant.targetText} onChange={event => updateGrant(grant.id, { targetText: event.target.value })} />
          </label>
          <button type="button" className="button quiet" disabled={busy} onClick={() => setGrants(current => current.filter(item => item.id !== grant.id))}>Remove grant</button>
        </fieldset>)}
        <p className="dialog-copy">Actions without a matching grant are off when the policy is active.</p>
        {groupMembers && <div className="dialog-actions">
          <button type="button" className="button secondary"
            disabled={busy || grants.length >= 100 || grants.some(grant => grant.action === 'case.snapshot')}
            onClick={() => setGrants(current => [...current, { ...emptyGrant(), action: 'case.snapshot', decision: 'allow' }])}>
            Allow group timeline and assignments
          </button>
          <button type="button" className="button secondary" disabled={busy || grants.length >= 100}
            onClick={() => setGrants(current => [...current, {
              ...emptyGrant(), action: 'group.message.send', decision: 'allow',
              targetText: JSON.stringify({ text: '', inReplyTo: null, assigneeAgentIds: [],
                recipientAgentIds: groupMembers.map(member => member.agentId).filter(id => id !== draft.agentId).sort() }, null, 2)
            }])}>
            Add exact group message grant
          </button>
        </div>}
        {caseFiles.length > 0 && <label>Add a file read grant
          <select value="" disabled={busy || grants.length >= 100} onChange={event => {
            const asset = caseFiles.find(item => item.id === event.target.value);
            if (!asset) return;
            const grant = { ...emptyGrant(), action: 'asset.read', targetText: JSON.stringify({ assetId: asset.id, assetVersion: asset.checksumSha256 }, null, 2) };
            setGrants(current => [...current, grant]);
          }}>
            <option value="">Choose a file version</option>
            {caseFiles.map(asset => <option key={asset.id} value={asset.id}>{asset.filename || asset.name || asset.id}</option>)}
          </select>
        </label>}
        <button type="button" className="button secondary" disabled={busy || grants.length >= 100} onClick={() => setGrants(current => [...current, emptyGrant()])}>Add grant</button>
        <label>Expires in
          <select disabled={busy} value={days} onChange={event => setDays(event.target.value)}>
            <option value="1">1 day</option><option value="7">7 days</option><option value="30">30 days</option>
          </select>
        </label>
        <div className="dialog-actions"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" className="button primary" disabled={busy}>{busy ? 'Preparing…' : 'Review policy'}</button></div>
      </form>}
    </>}
  </div>;
}
