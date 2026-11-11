import { nearReaders } from '/adapters/near/read.mjs';
import { checkProof } from '/packages/check/index.mjs';

const results = document.querySelector('#results');
const verdict = document.querySelector('#verdict');
const input = document.querySelector('#file');
const drop = document.querySelector('#drop');
const labels = {
  envoi_signature: ['Recorded by envoi', "This record wasn't signed by envoi, or it was edited."],
  content: ['Nothing changed since it was recorded', 'This record was changed after it was recorded.'],
  owner_signature: ['Rule signed by the owner', "The rule wasn't signed by the owner named."],
  registry: ["Owner's key is listed on NEAR", "This key isn't listed for this owner on NEAR, or was added later."],
  display: ['What was signed matches the rule', "What was signed doesn't match the rule."],
  chain_policy: ['Same rule is set in the spending contract', 'The spending contract has a different rule.'],
  chain_event: ['The transaction matches this record', "The NEAR transaction doesn't match this record."],
  batch_path: ['Record matches its batch', "This record isn't in the batch it claims."],
  sealed: ["Sealed in envoi's record on NEAR", "This record isn't in the sealed batch it claims."],
  locked_record: ['The record contract has no keys and matches its published build', 'The record contract could be changed by someone.'],
  private_check: ['Checked inside secure hardware on NEAR AI Cloud', "The private check's signature or attestation didn't verify."]
};
const configuration = fetch('/demo-samples.json').then(response => response.ok ? response.json() : {}).catch(() => ({}));
let latest = 0;

async function show(read) {
  const id = ++latest;
  results.replaceChildren();
  verdict.textContent = 'Checking proof';
  try {
    const proof = await read();
    const config = await configuration;
    const online = proof?.seal?.network === 'near-testnet' && config.testnet && config.testnetTrust;
    const trust = online ? { ...config.testnetTrust, ...nearReaders({
      ...config.testnet, ...config.testnetTrust, rpcUrl: '/testnet-rpc'
    }) } : { evidenceKeys: config.evidenceKeys };
    const result = await checkProof(proof, trust);
    if (id !== latest) return;
    for (const { id: check, status, message, reason } of result.checks) {
      const row = document.createElement('li');
      row.dataset.status = status;
      const [pass, fail] = labels[check] ?? [check, check];
      const fallback = status === 'PASS' ? pass : status === 'FAIL' ? fail :
        pass + (reason === 'unavailable' ? " - Couldn't reach the public record. Try again later." : ' - Not checked');
      const marker = { PASS: 'Pass', FAIL: 'Failed', SKIP: 'Skipped' }[status];
      row.textContent = (marker ? marker + ': ' : '') + (message ?? fallback);
      results.append(row);
      if (check === 'display' && status === 'PASS') {
        for (const line of proof.permission.document.display) {
          const item = document.createElement('li');
          item.textContent = line;
          results.append(item);
        }
      }
    }
    verdict.textContent = result.message ?? {
      failed: "This record can't be trusted.",
      bad_file: "This isn't an envoi proof file.",
      partial: "Signatures check out. Some checks still need verification.",
      verified: 'This record is genuine and unchanged.'
    }[result.verdict];
  } catch (error) {
    if (id !== latest) return;
    if (error instanceof SyntaxError) verdict.textContent = "This isn't an envoi proof file.";
    else if (error instanceof RangeError) verdict.textContent = error.message;
    else verdict.textContent = "Couldn't check this proof. Try opening the file again.";
  }
}
function choose(file) {
  if (file) show(async () => {
    if (file.size > 2 * 1024 * 1024) throw new RangeError('Proof is too large. Choose a file under 2 MB.');
    return JSON.parse(await file.text());
  });
}

input.addEventListener('change', () => choose(input.files[0]));
drop.addEventListener('dragover', event => event.preventDefault());
drop.addEventListener('drop', event => {
  event.preventDefault();
  choose(event.dataTransfer.files[0]);
});
const config = await configuration;
if (config.genuine && config.edited) {
  document.querySelector('#samples').hidden = false;
  for (const sample of ['genuine', 'edited']) {
    document.querySelector('#' + sample).addEventListener('click', () => show(async () => config[sample]));
  }
}

const query = new URLSearchParams(location.search);
const sample = query.get('sample');
const record = query.get('record');
if (sample === 'genuine' || sample === 'edited') show(async () => config[sample]);
else if (record) show(async () => config.testnetProofs?.find(proof => proof.record.id === record));
