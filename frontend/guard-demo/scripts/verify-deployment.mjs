// npm run verify:deployment -- [--owner <owner.testnet>] [--code-hash <hash>] [--spend-code-hash <hash>]
//                                [--seal <tx>]... [--refusal <tx>]... [--require-locked] [--mainnet] [--json]
//
// Read-only and key-free: anyone can check the public deployment. Without flags it checks the
// disposable PR302 testnet deployment against its published record code hash.
// Exit codes: 0 every check passed, 1 something is wrong, 2 not finished (e.g. not locked yet,
// low storage balance, NEAR unreachable), 3 usage error.
import { nearReaders } from '../adapters/near/read.mjs';
import { createRpc, DEFAULT_RPC } from '../adapters/near/rpc.mjs';
import { deploymentAccounts, PR302_OWNER, PR302_RECORD_CODE_HASH, verifyDeployment } from '../packages/check/deployment.mjs';

const USAGE = 'Usage: npm run verify:deployment -- [--owner <account>] [--code-hash <hash>] [--spend-code-hash <hash>] ' +
  '[--seal <tx>]... [--refusal <tx>]... [--require-locked] [--mainnet] [--json]';
const VALUE_FLAGS = new Set(['--owner', '--record', '--spend', '--agent', '--publisher', '--code-hash', '--spend-code-hash', '--seal', '--refusal']);
const BOOL_FLAGS = new Set(['--require-locked', '--mainnet', '--json']);

function parse(argv) {
  const options = { seals: [], refusals: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (BOOL_FLAGS.has(flag)) { options[flag.slice(2)] = true; continue; }
    if (!VALUE_FLAGS.has(flag) || i + 1 >= argv.length) throw new Error(USAGE);
    const value = argv[++i];
    if (flag === '--seal') options.seals.push(value);
    else if (flag === '--refusal') options.refusals.push(value);
    else options[flag.slice(2)] = value;
  }
  return options;
}

try {
  const options = parse(process.argv.slice(2));
  const network = options.mainnet ? 'near-mainnet' : 'near-testnet';
  const owner = options.owner ?? (network === 'near-testnet' ? PR302_OWNER : undefined);
  if (!owner) throw new Error('Pass --owner for a mainnet deployment.');
  const accounts = deploymentAccounts({ owner, record: options.record, spend: options.spend, agent: options.agent, publisher: options.publisher });
  const expectedRecordHash = options['code-hash'] ?? (owner === PR302_OWNER ? PR302_RECORD_CODE_HASH : undefined);
  const rpc = createRpc(process.env.NEAR_RPC_URL || DEFAULT_RPC[network]);
  const readers = nearReaders({ network, rpcUrl: process.env.NEAR_RPC_URL || DEFAULT_RPC[network],
    recordContract: accounts.record, spendContract: accounts.spend, publisher: accounts.publisher });
  const result = await verifyDeployment({ network, accounts, rpc, readers, expectedRecordHash,
    expectedSpendHash: options['spend-code-hash'], requireLocked: Boolean(options['require-locked']),
    seals: options.seals, refusals: options.refusals });
  if (options.json) console.log(JSON.stringify({ network, accounts, ...result }, null, 2));
  else {
    for (const row of result.rows) console.log(`${row.status.padEnd(4)} ${row.id}${row.detail ? ': ' + row.detail : ''}`);
    console.log({ verified: 'Deployment verified.', partial: 'Deployment checks out so far; some steps are not finished.', failed: 'Deployment does not match.' }[result.verdict]);
  }
  process.exitCode = { verified: 0, failed: 1, partial: 2 }[result.verdict];
} catch (error) {
  console.error(error.message);
  process.exitCode = error.message === USAGE ? 3 : 1;
}
