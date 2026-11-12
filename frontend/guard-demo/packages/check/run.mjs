// Checks every proof in a rehearsal output (scripts/live.mjs or scripts/verify-evidence-setup.mjs),
// then edits one field of each and confirms the checker rejects the edited copy.
import { checkProof } from './index.mjs';

/** The proofs inside a run file: `{ proofs: [...] }`, `{ proof }`, an array, or one proof. */
export function proofsInRun(run) {
  if (Array.isArray(run)) return run;
  if (Array.isArray(run?.proofs)) return run.proofs;
  if (run?.proof) return [run.proof];
  if (run?.format === 'envoi.proof/v1') return [run];
  return [];
}

/** The edit applied to each copy: one visible word in the record's summary. */
export function editProof(proof) {
  const edited = structuredClone(proof);
  edited.record.summary = String(edited.record.summary) + ' (edited)';
  return edited;
}

export async function checkRun(run, trust) {
  const proofs = proofsInRun(run);
  const results = [];
  for (const [index, proof] of proofs.entries()) {
    const genuine = await checkProof(proof, trust);
    const edited = await checkProof(editProof(proof), trust);
    results.push({
      index, type: proof?.record?.type ?? null, seq: proof?.record?.seq ?? null, summary: proof?.record?.summary ?? null,
      genuine: { verdict: genuine.verdict, reason: genuine.reason ?? null, message: genuine.message,
        notPassed: genuine.checks.filter(row => row.status !== 'PASS').map(({ id, status, reason }) => ({ id, status, reason: reason ?? null })) },
      edited: { verdict: edited.verdict, message: edited.message }
    });
  }
  const editedAllFailed = results.every(row => row.edited.verdict === 'failed');
  const genuineFailed = results.some(row => row.genuine.verdict === 'failed');
  const genuinePartial = results.some(row => row.genuine.verdict === 'partial');
  const verdict = !results.length || genuineFailed || !editedAllFailed ? 'failed' : genuinePartial ? 'partial' : 'verified';
  return { verdict, proofs: results.length, results };
}
