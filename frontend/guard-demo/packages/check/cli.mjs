// npm run check -- <proof.json> <trusted-evidence-keys.json> [--json]                 (offline)
// npm run check -- <proof.json> [trusted-evidence-keys.json] --testnet|--mainnet [--json]
//
// Exit codes, so scripts and CI can tell the outcomes apart:
//   0  verified: every check passed
//   1  failed: the record can't be trusted
//   2  partial: signatures check out, but some checks were skipped or NEAR couldn't be reached
//   3  usage error or not an envoi proof file
import { readFile } from 'node:fs/promises';
import { checkProof } from './index.mjs';
import { VERDICT_MESSAGES } from './messages.mjs';
import { nearReaders } from '../../adapters/near/read.mjs';
import { DEFAULT_RPC } from '../../adapters/near/rpc.mjs';
import { checkIds, verifyReceipt } from '../../adapters/nearai/screen.mjs';
import { validAccount } from '../core/policy.mjs';
import { deploymentAccounts, PR302_RECORD_CODE_HASH } from './deployment.mjs';

const USAGE = 'Usage: npm run check -- proof.json trusted-evidence-keys.json [--json]\n' +
  '   or: npm run check -- proof.json [trusted-evidence-keys.json] --testnet|--mainnet [--json]';
const EXIT = { verified: 0, failed: 1, partial: 2 };
const NETWORKS = { '--testnet': 'near-testnet', '--mainnet': 'near-mainnet' };

class UsageError extends Error {}

const onNetwork = (network, account) => validAccount(account) &&
  (network === 'near-testnet' ? account.endsWith('.testnet') : !account.endsWith('.testnet'));

async function main(argv) {
  const flags = argv.filter(arg => arg.startsWith('--'));
  const [path, keyPath, ...extra] = argv.filter(arg => !arg.startsWith('--'));
  const unknown = flags.filter(flag => !NETWORKS[flag] && flag !== '--json');
  const networkFlags = flags.filter(flag => NETWORKS[flag]);
  const json = flags.includes('--json');
  const network = NETWORKS[networkFlags[0]];
  // Offline, envoi's key can only come from a key map. On NEAR, the record contract lists it,
  // so the key map becomes an optional override.
  if (!path || (!keyPath && !network) || extra.length || unknown.length || networkFlags.length > 1) throw new UsageError(USAGE);

  let proof;
  try {
    proof = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return { exit: 3, output: json ? { verdict: 'failed', reason: 'bad_file', message: VERDICT_MESSAGES.bad_file, checks: [] } : VERDICT_MESSAGES.bad_file };
  }
  let evidenceKeys;
  if (keyPath) {
    try {
      evidenceKeys = JSON.parse(await readFile(keyPath, 'utf8'));
    } catch {
      throw new UsageError('Could not read the trusted evidence key map: ' + keyPath);
    }
  }

  let trust = evidenceKeys ? { evidenceKeys } : {};
  if (network) {
    try { process.loadEnvFile(); } catch { /* .env is optional when the variables are already set */ }
    let env = process.env;
    // A fresh clone has no .env: on testnet, fall back to the published PR302 deployment, so a
    // judge can run `npm run check -- proof.json --testnet` as is.
    if (network === 'near-testnet' && !env.NEAR_RECORD_CONTRACT && !env.NEAR_SPEND_CONTRACT && !env.NEAR_PUBLISHER_ACCOUNT && !env.NEAR_RECORD_CODE_HASH) {
      const pr302 = deploymentAccounts();
      env = { ...env, NEAR_RECORD_CONTRACT: pr302.record, NEAR_SPEND_CONTRACT: pr302.spend,
        NEAR_PUBLISHER_ACCOUNT: pr302.publisher, NEAR_RECORD_CODE_HASH: PR302_RECORD_CODE_HASH };
      if (!json) console.error(`Using the published testnet deployment ${pr302.record}.`);
    }
    const accounts = [env.NEAR_RECORD_CONTRACT, env.NEAR_SPEND_CONTRACT, env.NEAR_PUBLISHER_ACCOUNT];
    if (!accounts.every(account => onNetwork(network, account)) || !env.NEAR_RECORD_CODE_HASH) {
      throw new UsageError(`Configure the trusted ${network} record contract, spending contract, publisher and published record code hash.`);
    }
    trust = { ...trust, ...nearReaders({
      network, rpcUrl: env.NEAR_RPC_URL || DEFAULT_RPC[network], recordContract: env.NEAR_RECORD_CONTRACT,
      spendContract: env.NEAR_SPEND_CONTRACT, publisher: env.NEAR_PUBLISHER_ACCOUNT, recordCodeHash: env.NEAR_RECORD_CODE_HASH
    }), verifyScreen: async evidence => {
      const result = await verifyReceipt(evidence);
      return checkIds.every(id => result[id] === true);
    } };
  }

  const result = await checkProof(proof, trust);
  const exit = result.reason === 'bad_file' ? 3 : EXIT[result.verdict] ?? 1;
  if (json) return { exit, output: result };
  const icon = { PASS: '✓', FAIL: '✗', SKIP: '·' };
  const lines = result.checks.map(row => `${icon[row.status] ?? '?'} ${row.message}`);
  return { exit, output: [...lines, '-'.repeat(60), result.message].join('\n') };
}

try {
  const { exit, output } = await main(process.argv.slice(2));
  console.log(typeof output === 'string' ? output : JSON.stringify(output, null, 2));
  process.exitCode = exit;
} catch (error) {
  console.error(error.message);
  process.exitCode = error instanceof UsageError ? 3 : 1;
}
