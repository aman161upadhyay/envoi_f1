import { writeFile } from 'node:fs/promises';
import { createRpc } from '../adapters/near/rpc.mjs';
import { nearReaders } from '../adapters/near/read.mjs';
import { callWithScopedKey } from '../adapters/near/sign.mjs';
import { loadScopedKey } from '../adapters/near/key-file.mjs';
import { hashJson } from '../packages/core/crypto.mjs';
import { validAccount } from '../packages/core/policy.mjs';

const env = process.env;
const owner = env.NEAR_OWNER_ACCOUNT;
const agent = env.NEAR_AGENT_ACCOUNT;
const publisher = env.NEAR_PUBLISHER_ACCOUNT;
const recordContract = env.NEAR_RECORD_CONTRACT;
const spendContract = env.NEAR_SPEND_CONTRACT;
const attacker = env.NEAR_DEMO_ATTACKER;
const accounts = [owner, agent, publisher, recordContract, spendContract, attacker];
if (!accounts.every(account => validAccount(account) && account.endsWith('.testnet')) ||
    new Set(accounts).size !== accounts.length) throw new Error('Set distinct testnet account IDs.');
const rpcUrl = env.NEAR_RPC_URL || 'https://rpc.testnet.near.org';
const rpc = createRpc(rpcUrl);
if ((await rpc('status', [])).chain_id !== 'testnet') throw new Error('Testnet RPC required.');
const { spendGuard, publicRecord } = nearReaders({ rpcUrl, recordContract, spendContract, publisher });
const [agentKey, publisherKey, policy] = await Promise.all([
  loadScopedKey(env.NEAR_AGENT_PRIVATE_KEY, env.NEAR_AGENT_PUBLIC_KEY),
  loadScopedKey(env.NEAR_PUBLISHER_PRIVATE_KEY, env.NEAR_PUBLISHER_PUBLIC_KEY),
  spendGuard.getPolicy(agent)
]);
if (!policy || policy.paused || policy.version < 1 || policy.payees.some(payee => payee.account === attacker)) {
  throw new Error('Require a signed, active testnet policy that excludes the attacker.');
}
const caseRef = 'smoke-' + crypto.randomUUID();
const amount = '20000000000000000000000000';
const vault = async () => {
  const result = await rpc('query', { request_type: 'call_function', account_id: spendContract, method_name: 'vault_of',
    args_base64: Buffer.from(JSON.stringify({ owner })).toString('base64'), finality: 'final' });
  return JSON.parse(Buffer.from(result.result));
};
const before = await vault();
const txRef = await callWithScopedKey({ rpc, keys: agentKey, sender: agent, receiver: spendContract, method: 'pay',
  args: { to: attacker, amount, case_ref: caseRef, expected_policy_hash: policy.policyHash } });
const outcome = await spendGuard.readOutcome(txRef, agent);
if (outcome?.status !== 'refused' || outcome.reason !== 'not_payee' || outcome.policyHash !== policy.policyHash ||
    outcome.caseRef !== caseRef || await vault() !== before) throw new Error('Refusal was not verified: ' + txRef);
console.log('Verified refusal and unchanged vault:', txRef);

const result = await rpc('query', { request_type: 'call_function', account_id: recordContract, finality: 'final',
  method_name: 'last', args_base64: 'e30=' });
const [last, previousRoot] = JSON.parse(Buffer.from(result.result));
const summary = { format: 'envoi.testnet-smoke/v1', outcome, vaultUnchanged: true };
const batch = { batchId: last + 1, root: await hashJson(summary), previousRoot, count: 1 };
const sealRef = await callWithScopedKey({ rpc, keys: publisherKey, sender: publisher, receiver: recordContract, method: 'seal',
  args: { batch_id: batch.batchId, root: batch.root, previous_root: previousRoot, count: batch.count } });
if (!await publicRecord.verifySeal(sealRef, batch)) throw new Error('Smoke seal was not verified: ' + sealRef);
await writeFile(caseRef + '.json', JSON.stringify({ ...summary, batch, sealRef }, null, 2), { flag: 'wx' });
console.log('Verified final seal:', sealRef);
