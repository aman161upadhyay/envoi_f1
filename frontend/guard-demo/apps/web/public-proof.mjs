import { nearReaders } from '../../adapters/near/read.mjs';
import { deploymentAccounts, PR302_RECORD_CODE_HASH } from '../../packages/check/deployment.mjs';
import { checkProof } from '../../packages/check/index.mjs';

const { record, spend, publisher } = deploymentAccounts();
const trust = nearReaders({ recordContract: record, spendContract: spend, publisher, recordCodeHash: PR302_RECORD_CODE_HASH });
const verdict = document.querySelector('#verdict');
const checks = document.querySelector('#checks');
const samples = {
  original: '../../docs/acme-refused-payment.proof.json',
  edited: '../../docs/acme-refused-payment-edited.proof.json'
};
let current;

async function verifySample(sample) {
  current?.abort();
  const request = new AbortController();
  current = request;
  for (const name of Object.keys(samples)) {
    document.querySelector('#' + name).setAttribute('aria-pressed', String(sample === name));
  }
  checks.replaceChildren();
  verdict.textContent = 'Checking signatures and NEAR testnet…';
  try {
    const response = await fetch(new URL(samples[sample], import.meta.url), { signal: request.signal });
    if (!response.ok) throw new Error('Sample unavailable');
    const result = await checkProof(await response.json(), trust);
    if (request.signal.aborted) return;
    const labels = { PASS: 'Pass', FAIL: 'Failed', SKIP: 'Skipped' };
    for (const check of result.checks) {
      const row = document.createElement('li');
      row.dataset.status = check.reason === 'unlocked' ? 'WARN' : check.status;
      const label = check.reason === 'unlocked' ? 'Warning' : labels[check.status];
      row.textContent = label + ' · ' + check.message;
      checks.append(row);
    }
    verdict.textContent = result.message;
  } catch {
    if (!request.signal.aborted) verdict.textContent = 'Could not load the proof. Try again.';
  }
}

for (const sample of Object.keys(samples)) {
  document.querySelector('#' + sample).addEventListener('click', () => verifySample(sample));
}
