import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRpc } from '../adapters/near/rpc.mjs';
import { base58Encode } from '../adapters/near/sign.mjs';
import { nearReaders } from '../adapters/near/read.mjs';
import { hashJson, verify } from '../packages/core/crypto.mjs';
import { displayPermission, validAccount } from '../packages/core/policy.mjs';

const env = process.env;
const rpcUrl = env.NEAR_RPC_URL || 'https://rpc.testnet.near.org';
const rpc = createRpc(rpcUrl);
const owner = env.NEAR_OWNER_ACCOUNT;
const agent = env.NEAR_AGENT_ACCOUNT;
const publisher = env.NEAR_PUBLISHER_ACCOUNT;
const recordContract = env.NEAR_RECORD_CONTRACT;
const spendContract = env.NEAR_SPEND_CONTRACT;
const payee = env.NEAR_DEMO_PAYEE;
const attacker = env.NEAR_DEMO_ATTACKER;
const readers = nearReaders({ rpcUrl, recordContract, spendContract, publisher });
let failed = false;
async function check(label, fn) {
  try {
    console.log('PASS', label, await fn() ?? '');
    return true;
  } catch (error) {
    failed = true;
    console.log('WAIT', label, error.message);
    return false;
  }
}
function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}
const wasm = new Map();
for (const name of ['record', 'spend']) {
  await check(name + ' Wasm', async () => {
    const file = await readFile(new URL('../contracts/near/target/wasm32-unknown-unknown/release/envoi_' + name + '.wasm', import.meta.url));
    const hash = base58Encode(createHash('sha256').update(file).digest());
    wasm.set(name, hash);
    return hash;
  });
}
const rpcReady = await check('Testnet RPC', async () => requireThat((await rpc('status', [])).chain_id === 'testnet', 'Expected NEAR testnet.'));
const configured = await check('Account configuration', () => {
  const accounts = [owner, agent, publisher, recordContract, spendContract, payee, attacker];
  requireThat(accounts.every(account => validAccount(account) && account.endsWith('.testnet')) &&
    new Set(accounts).size === accounts.length, 'Set seven distinct testnet account IDs in .env.');
});
if (rpcReady && configured) {
  const account = id => rpc('query', { request_type: 'view_account', account_id: id, finality: 'final' });
  for (const [name, id] of Object.entries({ owner, agent, publisher, recordContract, spendContract, payee, attacker })) {
    await check(name + ' account', async () => { await account(id); return id; });
  }
  for (const [name, id] of [['record', recordContract], ['spend', spendContract]]) {
    await check(name + ' deployed code', async () => {
      const { code_hash: hash } = await account(id);
      requireThat(wasm.get(name) === hash, 'Testnet code does not match the locally built Wasm.');
      if (name === 'record') requireThat(env.NEAR_RECORD_CODE_HASH === hash, 'Set NEAR_RECORD_CODE_HASH to the verified record hash.');
      return hash;
    });
  }
  for (const [id, publicKey, receiver, method] of [
    [agent, env.NEAR_AGENT_PUBLIC_KEY, spendContract, 'pay'], [publisher, env.NEAR_PUBLISHER_PUBLIC_KEY, recordContract, 'seal']
  ]) {
    await check(id + ' key', async () => {
      const { keys } = await readers.agentAccounts.describe(id);
      const scoped = keys.find(key => key.publicKey === publicKey);
      requireThat(scoped?.kind === 'function_call' && scoped.receiver === receiver && scoped.methods.length === 1 &&
        scoped.methods[0] === method && (scoped.allowance == null || BigInt(scoped.allowance) > 0n),
        'Add the scoped public key and ensure its allowance covers the rehearsal.');
      if (id === agent) requireThat(keys.length === 1, 'Milo must have only its pay key before rehearsal.');
    });
  }
  await check('Owner vault', async () => {
    const response = await rpc('query', { request_type: 'call_function', account_id: spendContract,
      method_name: 'vault_of', args_base64: Buffer.from(JSON.stringify({ owner })).toString('base64'), finality: 'final' });
    requireThat(BigInt(JSON.parse(Buffer.from(response.result))) >= 5n * 10n ** 23n, 'Fund the owner vault with at least 0.5 testnet NEAR.');
  });
  await check('Signed policy', async () => {
    const { document, publicKey, signature } = JSON.parse(await readFile(env.NEAR_SIGNED_POLICY_FILE || 'signed-policy.json', 'utf8'));
    const hash = await hashJson(document);
    const [registry, chain] = await Promise.all([readers.ownerRegistry.lookup(owner, publicKey), readers.spendGuard.getPolicy(agent)]);
    requireThat(document.owner === owner && document.agent === agent && JSON.stringify(displayPermission(document)) === JSON.stringify(document.display) &&
      await verify(publicKey, signature, hash) && registry?.type === 'demo_device' && registry.revokedAtMs === undefined &&
      registry.registeredAtMs <= document.issuedAtMs && chain?.policyHash === hash && chain.version === document.version &&
      !chain.paused && chain.payees.some(entry => entry.account === payee && BigInt(entry.maxPerPayment) >= 5n * 10n ** 23n) &&
      !chain.payees.some(entry => entry.account === attacker) && BigInt(chain.dailyCap) >= 5n * 10n ** 23n,
      'Register the device, sign suitable limits in the browser, and download the confirmed policy.');
  });
}
await check('NEAR AI configuration', () => requireThat(env.NEAR_AI_API_KEY && env.NEAR_AI_MODEL,
  'Configure the API key and a TEE model in .env. This check does not call inference.'));
await check('Runner credentials', () => requireThat(env.NEAR_AGENT_PRIVATE_KEY && env.NEAR_PUBLISHER_PRIVATE_KEY,
  'Prepare the two scoped runner keys locally.'));
if (failed) process.exitCode = 1;
