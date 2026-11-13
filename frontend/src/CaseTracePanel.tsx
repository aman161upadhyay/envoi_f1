import { useEffect, useMemo, useState } from 'react';
import { request } from './api';
import { describeAction, ruleFor, sourceLabel } from './decision-rules';
import { editedCopy, verifyTraceStep, type ProofVerdict } from './trace-proof';
import type { Asset, ParticipantIdentity } from './types';

interface CaseTraceStep {
  record: { id: string; index?: number; previous?: string | null; type: string; at: string; sensitive: boolean; details: Record<string, any> };
  digest?: string;
  publicKey?: string;
  signature?: string;
  seal: { status: 'final'; network: string; txRef: string | null } | null;
}

const label = (value: string) => value.replaceAll(/[._]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');

const TYPE_WORDS: Record<string, string> = {
  'case.signed_policy_updated': 'Signed policy updated',
  'policy.evaluated': 'Policy checked',
  'payment.confirmed': 'Payment',
  'message.private_screened': 'Private screening',
  'case.human_decision_requested': 'Decision requested'
};

const ATTESTATION_CHECKS: Array<[string, string]> = [
  ['signed_text', 'Answer matches what was signed'],
  ['signature', 'Signature valid'],
  ['signer_attested', 'Signer attested'],
  ['report_data', 'Report data matches'],
  ['tdx_quote', 'TDX quote valid'],
  ['gpu', 'GPU attested']
];

const OUTCOME_WORDS: Record<string, string> = { confirmed: 'Paid', refused: 'Refused by contract', flagged: 'Flagged' };

function downloadStep(step: CaseTraceStep) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(step, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `case-evidence-${step.record.id}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function traceSource(step: CaseTraceStep): string {
  const network = step.seal?.network ?? (typeof step.record.details.network === 'string' ? step.record.details.network : null);
  return sourceLabel(network, 'Signed by Envoi');
}

/** The only place "Sealed on NEAR" is written. It needs a final seal on a near-* network. */
export function sealStatus(step: CaseTraceStep): { text: string; href?: string } | null {
  const seal = step.seal;
  if (seal?.status === 'final' && seal.network.startsWith('near-')) {
    return { text: 'Sealed on NEAR', href: seal.txRef ? `https://testnet.nearblocks.io/txns/${encodeURIComponent(seal.txRef)}` : undefined };
  }
  if (seal?.status === 'final') return { text: 'Sealed locally' };
  return step.record.sensitive ? { text: 'Awaiting seal' } : null;
}

function Attestation({ step }: { step: CaseTraceStep }) {
  const attestation = step.record.details.attestation as { source?: string; checks?: Array<{ id: string; passed: boolean }> } | undefined;
  const checks = attestation?.checks;
  if (Array.isArray(checks) && checks.length === 6) {
    return <ul className="trace-attestation" aria-label="Attestation checks">{ATTESTATION_CHECKS.map(([id, text]) => {
      const passed = checks.find(check => check.id === id)?.passed === true;
      return <li key={id} className={passed ? 'passed' : 'failed'}>{passed ? 'Passed' : 'Failed'}: {text}</li>;
    })}</ul>;
  }
  return <p className="trace-note">{attestation?.source === 'offline-replay' ? 'Private screening: local screening (Offline replay)' : 'Screened on NEAR AI Cloud. Attestation receipt not available yet.'}</p>;
}

function ProofCheck({ step, previous }: { step: CaseTraceStep; previous?: CaseTraceStep }) {
  const [result, setResult] = useState<{ original: ProofVerdict; edited?: ProofVerdict } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!step.digest || !step.publicKey || !step.signature) return null;
  const proof = { record: step.record, digest: step.digest, publicKey: step.publicKey, signature: step.signature };
  const previousProof = previous?.digest && previous.publicKey && previous.signature ? { record: previous.record, digest: previous.digest, publicKey: previous.publicKey, signature: previous.signature } : null;
  async function run(withEdit: boolean) {
    setBusy(true);
    try {
      const original = await verifyTraceStep(proof, previousProof);
      setResult({ original, edited: withEdit ? await verifyTraceStep(editedCopy(proof), previousProof) : undefined });
    } finally { setBusy(false); }
  }
  return <div className="trace-proof">
    <div className="trace-proof-actions">
      <button type="button" className="button secondary" disabled={busy} onClick={() => void run(false)}>Check this proof</button>
      <button type="button" className="button secondary" disabled={busy} onClick={() => void run(true)}>Try an edited copy</button>
      <button type="button" className="button quiet" onClick={() => downloadStep(step)}>Download signed record</button>
    </div>
    {result && <div className="trace-verdicts" role="status">
      <p className={`trace-verdict ${result.original.status === 'genuine' ? 'passed' : 'failed'}`}><strong>Original:</strong> {result.original.status === 'genuine' ? 'genuine' : result.original.message}</p>
      {result.edited && <p className={`trace-verdict ${result.edited.status === 'genuine' ? 'passed' : 'failed'}`}><strong>Edited:</strong> {result.edited.status === 'changed' ? 'changed after it was recorded' : result.edited.message}</p>}
      {result.original.status === 'genuine' && <p className="trace-note">{result.original.message}</p>}
      {result.edited && result.edited.status !== 'genuine' && <p className="trace-note">{result.edited.message}</p>}
    </div>}
  </div>;
}

function stepSummary(step: CaseTraceStep, assets: Asset[], directory?: Record<string, ParticipantIdentity> | ParticipantIdentity[], ownerName?: string) {
  const { details, type } = step.record;
  const target = { payee: details.payee, amount: details.amount, assetId: details.assetId, recipientAgentId: details.recipientAgentId, parts: details.parts };
  if (type === 'payment.confirmed') {
    const outcome = String(details.outcome || '');
    return { sentence: `${describeAction('payment.near', target, assets, directory)}.`, outcome: OUTCOME_WORDS[outcome] || (outcome ? label(outcome) : null), rule: details.reasonCode ? ruleFor(String(details.reasonCode), 'deny', null, { ownerName, assets, directory }).rule : null };
  }
  if (details.requestedAction) {
    const decision = String(details.decision || 'deny');
    const result = ruleFor(String(details.reasonCode || ''), decision, { action: String(details.requestedAction), target }, { ownerName, assets, directory });
    return { sentence: `${describeAction(String(details.requestedAction), target, assets, directory)}.`, outcome: result.outcome, rule: result.rule };
  }
  return { sentence: null, outcome: details.outcome ? OUTCOME_WORDS[String(details.outcome)] || label(String(details.outcome)).replace(/^./, c => c.toUpperCase()) : null, rule: null };
}

export function CaseTracePanel({ inboxId, caseId, focusId, assets = [], directory, ownerName }: { inboxId: string; caseId: string; focusId?: string; assets?: Asset[]; directory?: Record<string, ParticipantIdentity> | ParticipantIdentity[]; ownerName?: string }) {
  const [steps, setSteps] = useState<CaseTraceStep[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void request<{ steps: CaseTraceStep[] }>(
      `/api/inboxes/${encodeURIComponent(inboxId)}/cases/${encodeURIComponent(caseId)}/signed-trace`,
      { signal: controller.signal }
    ).then(result => setSteps(result.steps)).catch(() => {
      if (!controller.signal.aborted) setFailed(true);
    });
    return () => controller.abort();
  }, [inboxId, caseId]);
  // The server lists newest first. People read a timeline oldest first.
  const ordered = useMemo(() => steps ? [...steps].sort((a, b) => (a.record.index ?? 0) - (b.record.index ?? 0) || a.record.at.localeCompare(b.record.at)) : null, [steps]);
  useEffect(() => {
    if (!focusId || !ordered) return;
    document.querySelector(`[data-trace-focus="${CSS.escape(focusId)}"]`)?.scrollIntoView({ block: 'center' });
  }, [focusId, ordered]);
  if (failed) return <p role="alert">Case evidence could not be loaded.</p>;
  if (!ordered) return <p role="status">Loading signed evidence…</p>;
  if (!ordered.length) return <p>No signed evidence has been recorded for this case.</p>;
  return <ol className="trace-timeline">{ordered.map((step, position) => {
    const focused = Boolean(focusId && (step.record.details.policyEvaluationId === focusId || step.record.id === focusId));
    const summary = stepSummary(step, assets, directory, ownerName);
    const seal = sealStatus(step);
    return <li key={step.record.id} data-trace-focus={step.record.details.policyEvaluationId || step.record.id} className={`trace-step${focused ? ' trace-focused' : ''}`}>
      <div className="trace-head">
        <strong>{TYPE_WORDS[step.record.type] || label(step.record.type)}</strong>
        <span className="source-chip">{traceSource(step)}</span>
        {seal && <span className="trace-seal">{seal.href ? <a href={seal.href} target="_blank" rel="noreferrer noopener">{seal.text}</a> : seal.text}</span>}
        <time dateTime={step.record.at}>{new Date(step.record.at).toLocaleString()}</time>
      </div>
      {(summary.sentence || summary.outcome) && <p className="trace-line">{summary.outcome && <span className="trace-outcome">{summary.outcome}</span>} {summary.sentence}</p>}
      {summary.rule && <p className="trace-rule">Rule: {summary.rule}</p>}
      {step.record.type === 'message.private_screened' && <Attestation step={step} />}
      <ProofCheck step={step} previous={ordered[position - 1]} />
    </li>;
  })}</ol>;
}
