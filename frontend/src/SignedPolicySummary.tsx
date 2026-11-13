import { useEffect, useState } from 'react';
import { request } from './api';
import { describeAction, formatNear, sourceLabel } from './decision-rules';
import type { OwnerSigningMethod, SignedPolicyDraft } from './signed-case-policy';
import type { Asset, ParticipantIdentity } from './types';

// The read-only scope reports the mapped agent's current spending policy and verified key restrictions.
export interface SpendScope {
  source: string;
  payees: Array<{ label: string; account: string; maxPerPayment: string }>;
  dailyCap?: string;
  unit?: string;
  paused?: boolean;
  agentKey?: { account: string; receiver: string; methods: string[]; allowance?: string };
}

const DECISION_CHIP = { allow: ['Allowed', 'allowed'], needsHuman: ['Ask first', 'needs'], deny: ['Off', 'denied'] } as const;

export function SignedPolicySummary({ inboxId, caseId, draft, assets, directory, method }: {
  inboxId: string; caseId: string; draft: SignedPolicyDraft; assets: Asset[]; directory?: Record<string, ParticipantIdentity> | ParticipantIdentity[]; method: OwnerSigningMethod;
}) {
  const [scope, setScope] = useState<SpendScope | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    setScope(undefined);
    void request<SpendScope>(`/api/inboxes/${encodeURIComponent(inboxId)}/cases/${encodeURIComponent(caseId)}/spend-scope`, {}, false)
      .then(result => { if (!cancelled) setScope(result && Array.isArray(result.payees) ? result : null); })
      .catch(() => { if (!cancelled) setScope(null); });
    return () => { cancelled = true; };
  }, [inboxId, caseId]);

  const entries = Array.isArray(directory) ? directory : Object.entries(directory || {}).map(([key, value]) => ({ ...value, id: value.id || key }));
  const ownerName = entries.find(item => item.id === draft.ownerId)?.displayName || 'the owner';
  const document = draft.active;
  const unit = (value?: string) => (value ? formatNear(value) ?? value : null);
  return <section className="signed-summary" aria-label="What is signed">
    <h3>What {ownerName} signs</h3>
    {document ? <ul className="policy-grants">
      {document.grants.map(grant => {
        const [label, tone] = DECISION_CHIP[grant.decision];
        return <li key={grant.id}><span className={`decision-chip outcome-${tone}`}>{label}</span><span>{describeAction(grant.action, grant.target, assets, directory, scope)}</span></li>;
      })}
      <li className="policy-else"><span className="decision-chip outcome-denied">Off</span><span>Everything else is off.</span></li>
    </ul> : <p className="dialog-copy">No signed policy is active yet. Everything is off.</p>}

    {scope ? <>
      <h3>Spending limits <span className="source-chip">{sourceLabel(scope.source)}</span></h3>
      {scope.paused && <p className="dialog-copy">Payments are paused.</p>}
      <ul className="policy-facts">
        {scope.payees.map(payee => <li key={payee.account}><strong>{payee.label}</strong> <code>{payee.account}</code><span>Up to {unit(payee.maxPerPayment)} per payment</span></li>)}
        {scope.dailyCap && <li><strong>Daily cap</strong><span>{unit(scope.dailyCap)} per day</span></li>}
      </ul>
      {scope.agentKey && <>
        <h3>Agent spending key <span className="source-chip">{sourceLabel(scope.source)}</span></h3>
        <ul className="policy-facts">
          <li>Can only call {scope.agentKey.methods.map(name => <code key={name}>{name}</code>)} on <code>{scope.agentKey.receiver}</code></li>
          {scope.agentKey.allowance && <li>Fee allowance <strong>{unit(scope.agentKey.allowance)}</strong></li>}
          <li>Account <code>{scope.agentKey.account}</code></li>
        </ul>
      </>}
    </> : scope === null ? <p className="dialog-copy">The NEAR spending scope could not be verified for this case.</p> : null}

    <h3>Signature</h3>
    <ul className="policy-facts">
      <li>Signer <code>{draft.signing.ownerAccount}</code></li>
      <li>Method {method === 'passkey' ? 'Passkey' : 'Demo device'}</li>
      <li>Version {document?.version ?? draft.version}{document ? <>, expires {new Date(document.expiresAtMs).toLocaleString()}</> : null}</li>
      <li>Record <code>{draft.signing.recordContract}</code> on {draft.signing.network === 'offline-replay' ? 'Offline replay' : draft.signing.network}</li>
    </ul>
  </section>;
}
