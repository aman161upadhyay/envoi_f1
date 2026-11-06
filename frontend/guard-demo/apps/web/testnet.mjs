import { base58Encode, callWithScopedKey } from '/adapters/near/sign.mjs';
import { createRpc } from '/adapters/near/rpc.mjs';
import { fromHex, hashJson, publicHex } from '/packages/core/crypto.mjs';

const rpc = createRpc('/testnet-rpc');

async function view(contract, method, args) {
  const payload = new TextEncoder().encode(JSON.stringify(args));
  const result = await rpc('query', { request_type: 'call_function', finality: 'final', account_id: contract,
    method_name: method, args_base64: btoa(String.fromCharCode(...payload)) });
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(result.result)));
}

export async function getTestnetPolicy(config) {
  const policy = await view(config.spendContract, 'get_policy', { agent: config.agent });
  if (!policy || policy.owner !== config.owner) throw new Error('Register this testnet agent with the configured owner first.');
  return policy;
}

export async function describeDevice(keys) {
  const hex = await publicHex(keys.publicKey);
  return { hex, accessKey: 'ed25519:' + base58Encode(fromHex(hex, 32)) };
}

export async function applyTestnetPolicy(config, keys, document) {
  const hash = await hashJson(document);
  const { hex } = await describeDevice(keys);
  const registered = await view(config.recordContract, 'owner_keys', { owner: config.owner });
  const key = registered.find(entry => entry.public_key === hex && entry.key_type === 'demo_device');
  if (!key || key.registered_at_ms > document.issuedAtMs || key.revoked_at_ms !== null) {
    throw new Error('Register this demo device on testnet before signing.');
  }
  const spend = document.rules.spend_money;
  if (spend.payees.length > 32) throw new Error('Use at most 32 payees.');
  const intended = spend.payees.map(payee => [payee.account, payee.maxPerPayment]).sort();
  const matches = policy => policy.policy_hash === hash && policy.version === document.version &&
    policy.daily_cap === spend.dailyCap &&
    JSON.stringify(policy.payees.map(payee => [payee.account, payee.max_per_payment]).sort()) === JSON.stringify(intended);
  const current = await getTestnetPolicy(config);
  if (matches(current)) return;
  if (current.version !== document.version - 1 || current.policy_hash !== document.previousHash) {
    throw new Error('The testnet policy changed. Reopen the confirmation sheet and review it again.');
  }
  try {
    await callWithScopedKey({ rpc, keys, sender: config.owner, receiver: config.spendContract,
      method: 'set_policy', args: { agent: config.agent, expected_version: current.version,
        daily_cap: spend.dailyCap, policy_hash: hash,
        payees: spend.payees.map(payee => ({ account: payee.account, max_per_payment: payee.maxPerPayment })) } });
  } catch (error) {
    if (!matches(await getTestnetPolicy(config))) throw error;
  }
  if (!matches(await getTestnetPolicy(config))) throw new Error('Testnet did not confirm the signed policy.');
}
