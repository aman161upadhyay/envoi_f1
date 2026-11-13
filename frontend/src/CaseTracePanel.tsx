import { useEffect, useState } from 'react';
import { request } from './api';

interface CaseTraceStep {
  record: { id: string; type: string; at: string; sensitive: boolean; details: { reasonCode?: string | null; outcome?: string; policyEvaluationId?: string } };
  seal: { status: 'final'; network: string; txRef: string } | null;
}

const label = (value: string) => value.replaceAll(/[._]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');

function downloadStep(step: CaseTraceStep) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(step, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `case-evidence-${step.record.id}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function CaseTracePanel({ inboxId, caseId, focusId }: { inboxId: string; caseId: string; focusId?: string }) {
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
  useEffect(() => {
    if (!focusId || !steps) return;
    document.querySelector(`[data-trace-focus="${CSS.escape(focusId)}"]`)?.scrollIntoView({ block: 'center' });
  }, [focusId, steps]);
  if (failed) return <p role="alert">Case evidence could not be loaded.</p>;
  if (!steps) return <p role="status">Loading signed evidence…</p>;
  if (!steps.length) return <p>No signed evidence has been recorded for this case.</p>;
  return <ul className="signed-policy-display">{steps.map(step => <li key={step.record.id} data-trace-focus={step.record.details.policyEvaluationId || step.record.id} className={focusId && (step.record.details.policyEvaluationId === focusId || step.record.id === focusId) ? 'trace-focused' : undefined}>
    <strong>{label(step.record.type)}</strong>
    <p>{step.record.details.outcome ? label(step.record.details.outcome) + ' · ' : ''}
      {step.record.details.reasonCode ? label(step.record.details.reasonCode) + ' · ' : ''}
      {step.seal?.network.startsWith('near-') ? 'Sealed on NEAR' : step.seal ? 'Sealed locally'
        : step.record.sensitive ? 'Awaiting seal' : 'Signed by Envoi'}</p>
    <time dateTime={step.record.at}>{new Date(step.record.at).toLocaleString()}</time>
    <button type="button" className="button secondary" onClick={() => downloadStep(step)}>Download signed record</button>
  </li>)}</ul>;
}
