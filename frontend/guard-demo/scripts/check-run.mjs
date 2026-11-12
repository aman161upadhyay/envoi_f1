// npm run check:run -- <run.json> [--owner <owner.testnet>] [--code-hash <hash>] [--keys <trusted-evidence-keys.json>]
//                      [--attestation] [--offline] [--json]
//
// Checks every proof in a rehearsal output against NEAR testnet, then an edited copy of each.
// envoi's key comes from the record contract's evidence list unless --keys pins a key map.
// --attestation also re-runs the NEAR AI receipt verifier (needs the Python environment from the
// README); without it, private-check rows show as not checked. --offline checks signatures and
// batch paths only, with the run file's own key map.
// Exit codes: 0 every genuine proof verified and every edited copy rejected; 1 a genuine proof
// failed, an edited copy passed, or the file holds no proofs; 2 genuine proofs only partly
// checked (not locked yet, NEAR unreachable, attestation not re-run); 3 usage or unreadable file.
import { readFile } from 'node:fs/promises';
import { nearReaders } from '../adapters/near/read.mjs';
import { DEFAULT_RPC } from '../adapters/near/rpc.mjs';
import { deploymentAccounts, PR302_OWNER, PR302_RECORD_CODE_HASH } from '../packages/check/deployment.mjs';
import { checkRun } from '../packages/check/run.mjs';

const USAGE = 'Usage: npm run check:run -- run.json [--owner <account>] [--code-hash <hash>] [--keys <file>] [--attestation] [--offline] [--json]';

function parse(argv) {
  const options = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (['--attestation', '--offline', '--json'].includes(arg)) options[arg.slice(2)] = true;
    else if (['--owner', '--code-hash', '--keys'].includes(arg) && i + 1 < argv.length) options[arg.slice(2)] = argv[++i];
    else if (arg.startsWith('--')) throw new Error(USAGE);
    else rest.push(arg);
  }
  if (rest.length !== 1) throw new Error(USAGE);
  return { ...options, file: rest[0] };
}

async function main() {
  const options = parse(process.argv.slice(2));
  let run;
  try { run = JSON.parse(await readFile(options.file, 'utf8')); } catch { return { exit: 3, text: "Couldn't read a run file at " + options.file }; }
  const pinned = options.keys ? JSON.parse(await readFile(options.keys, 'utf8')) : options.offline ? run.evidenceKeys : undefined;
  let trust = pinned ? { evidenceKeys: pinned } : {};
  if (!options.offline) {
    const owner = options.owner ?? PR302_OWNER;
    const accounts = deploymentAccounts({ owner });
    const rpcUrl = process.env.NEAR_RPC_URL || DEFAULT_RPC['near-testnet'];
    trust = { ...trust, ...nearReaders({ network: 'near-testnet', rpcUrl, recordContract: accounts.record,
      spendContract: accounts.spend, publisher: accounts.publisher,
      recordCodeHash: options['code-hash'] ?? (owner === PR302_OWNER ? PR302_RECORD_CODE_HASH : undefined) }) };
    if (options.attestation) {
      const { checkIds, verifyReceipt } = await import('../adapters/nearai/screen.mjs');
      trust.verifyScreen = async evidence => { const result = await verifyReceipt(evidence); return checkIds.every(id => result[id] === true); };
    }
  }
  const result = await checkRun(run, trust);
  const exit = { verified: 0, failed: 1, partial: 2 }[result.verdict];
  if (options.json) return { exit, text: JSON.stringify(result, null, 2) };
  const lines = result.results.map(row => {
    const missing = row.genuine.notPassed.map(c => `${c.id} ${c.status}${c.reason ? ' (' + c.reason + ')' : ''}`).join(', ');
    return `#${row.seq ?? row.index} ${row.type}: genuine ${row.genuine.verdict}${missing ? ' [' + missing + ']' : ''}; edited copy ${row.edited.verdict}`;
  });
  const summary = { verified: 'Every genuine proof verified and every edited copy was rejected.',
    partial: 'Every edited copy was rejected; some genuine checks could not finish (see the brackets).',
    failed: result.proofs ? 'A genuine proof failed or an edited copy passed.' : 'No proofs found in this file.' }[result.verdict];
  return { exit, text: [...lines, '-'.repeat(60), summary].join('\n') };
}

try {
  const { exit, text } = await main();
  console.log(text);
  process.exitCode = exit;
} catch (error) {
  console.error(error.message);
  process.exitCode = error.message === USAGE ? 3 : 1;
}
