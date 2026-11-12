// Public, key-free verification of a NEAR deployment of envoi guard. Anyone can run it: it only
// reads chain state. It answers "is this deployment what the README says it is?":
// accounts, code hashes, key scopes, the record contract's whole batch chain, the lock, storage
// headroom, seal receipts, and that refused payments left the owner's vault unchanged.
import { createRpc, DEFAULT_ARCHIVAL_RPC, isNearUnavailable, NearUnavailable } from '../../adapters/near/rpc.mjs';
import { ZERO_ROOT } from '../core/tree.mjs';

export const PR302_OWNER = 'envoi-pr302-20261106.testnet';
export const PR302_RECORD_CODE_HASH = 'FDvRgQSwfbocdwNRgdu53WhkXB39rYutZvohTd83ZK7s';
const PUBLISHER_METHODS = ['register_evidence_key', 'seal'];
const NO_CODE = '11111111111111111111111111111111';
export const MIN_FREE_STORAGE_YOCTO = 2n * 10n ** 23n; // 0.2 NEAR, about 100 seals

/** Account IDs for a deployment made by `npm run testnet:prepare -- <owner>`. */
export function deploymentAccounts({ owner = PR302_OWNER, record, spend, agent, publisher } = {}) {
  return { owner, record: record ?? 'record.' + owner, spend: spend ?? 'spend.' + owner,
    agent: agent ?? 'milo.' + owner, publisher: publisher ?? 'publisher.' + owner };
}

const near = value => (Number(BigInt(value) / 10n ** 18n) / 1e6).toFixed(6) + ' NEAR';
const b64 = value => btoa(JSON.stringify(value));
const decodeBytes = bytes => JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes)));

export async function verifyDeployment({ network = 'near-testnet', accounts, rpc, archivalRpc, readers,
  expectedRecordHash, expectedSpendHash, requireLocked = false, seals = [], refusals = [] }) {
  archivalRpc ??= createRpc(DEFAULT_ARCHIVAL_RPC[network]);
  const rows = [];
  const step = async (id, fn) => {
    try {
      const out = await fn();
      rows.push(typeof out === 'object' && out?.status ? { id, ...out } : { id, status: 'PASS', detail: out ?? '' });
    } catch (error) {
      rows.push({ id, status: isNearUnavailable(error) ? 'WAIT' : 'FAIL', detail: isNearUnavailable(error) ? "Couldn't reach NEAR" : error.message });
    }
  };
  const must = (condition, message) => { if (!condition) throw new Error(message); };
  const view = async (account, method, args, block) => {
    const client = block === undefined ? rpc : archivalRpc;
    const result = await client('query', { request_type: 'call_function', account_id: account, method_name: method,
      args_base64: b64(args), ...(block === undefined ? { finality: 'final' } : { block_id: block }) });
    must(Array.isArray(result.result), `${method} failed on ${account}: ${result.error ?? 'no result'}`);
    return decodeBytes(result.result);
  };
  const account = id => rpc('query', { request_type: 'view_account', finality: 'final', account_id: id });
  const keyList = async id => (await rpc('query', { request_type: 'view_access_key_list', finality: 'final', account_id: id })).keys;

  await step('network', async () => {
    const { chain_id: chain } = await rpc('status', []);
    must(chain === network.replace('near-', ''), `RPC is on ${chain}, expected ${network}`);
    return chain;
  });
  const info = {};
  // A step that depends on an account we could not read is "not checked", not a failure.
  const accountOf = role => { if (!info[role]) throw new NearUnavailable(); return info[role]; };
  for (const [role, id] of Object.entries(accounts)) {
    await step(`account ${role}`, async () => { info[role] = await account(id); return id; });
  }
  await step('record code', async () => {
    const hash = accountOf('record').code_hash;
    must(hash && hash !== NO_CODE, 'No contract deployed on the record account');
    must(!expectedRecordHash || hash === expectedRecordHash, `Code hash ${hash} is not the published ${expectedRecordHash}`);
    return hash + (expectedRecordHash ? ' (matches the published hash)' : '');
  });
  await step('spend code', async () => {
    const hash = accountOf('spend').code_hash;
    must(hash && hash !== NO_CODE, 'No contract deployed on the spending account');
    must(!expectedSpendHash || hash === expectedSpendHash, `Code hash ${hash} is not the published ${expectedSpendHash}`);
    return hash;
  });
  await step('agent key', async () => {
    const keys = await keyList(accounts.agent);
    const fc = keys[0]?.access_key?.permission?.FunctionCall;
    must(keys.length === 1 && fc && fc.receiver_id === accounts.spend && fc.method_names.length === 1 && fc.method_names[0] === 'pay',
      `The agent must hold exactly one key, limited to pay on ${accounts.spend}`);
    return `only pay on ${accounts.spend}`;
  });
  await step('publisher key', async () => {
    const keys = await keyList(accounts.publisher);
    const scoped = keys.map(k => k.access_key.permission.FunctionCall).filter(Boolean)
      .find(fc => fc.receiver_id === accounts.record && fc.method_names.length === PUBLISHER_METHODS.length &&
        PUBLISHER_METHODS.every(method => fc.method_names.includes(method)));
    must(scoped, `No limited publisher key for exactly ${PUBLISHER_METHODS.join(' and ')} on ${accounts.record}`);
    return `${PUBLISHER_METHODS.join(' and ')} on ${accounts.record}`;
  });
  await step('record publisher', async () => {
    const publisher = await view(accounts.record, 'publisher', {});
    must(publisher === accounts.publisher, `The record contract's publisher is ${publisher}`);
    return publisher;
  });
  await step('evidence keys', async () => {
    must(await view(accounts.record, 'evidence_key', { key_id: 'verify-deployment-probe' }) === null, 'Unexpected probe key');
    return 'evidence_key supported';
  });
  const roots = new Map();
  await step('batch chain', async () => {
    const [last, lastRoot] = await view(accounts.record, 'last', {});
    let previous = ZERO_ROOT;
    for (let id = 1; id <= last; id += 1) {
      const batch = await view(accounts.record, 'root_of', { batch_id: id });
      must(batch, `Batch ${id} is missing`);
      must(batch.previous_root === previous, `Batch ${id} doesn't link to batch ${id - 1}`);
      must(batch.count > 0, `Batch ${id} is empty`);
      roots.set(id, batch);
      previous = batch.root;
    }
    must(previous === lastRoot, 'The last root does not match the chain');
    return `${last} batches, each linked to the one before`;
  });
  await step('record lock', async () => {
    const keys = await keyList(accounts.record);
    if (!keys.length) return 'no access keys: nobody can change this contract';
    const full = keys.filter(k => k.access_key.permission === 'FullAccess').length;
    const detail = `${keys.length} access key(s), ${full} full access: not locked yet`;
    if (requireLocked) throw new Error(detail);
    return { status: 'WAIT', detail };
  });
  await step('record storage', async () => {
    const { runtime_config: config } = await rpc('EXPERIMENTAL_protocol_config', { finality: 'final' });
    const record = accountOf('record');
    const free = BigInt(record.amount) - BigInt(record.storage_usage) * BigInt(config.storage_amount_per_byte);
    const detail = `${near(free)} free for storage (${record.storage_usage} bytes used)`;
    return free >= MIN_FREE_STORAGE_YOCTO ? detail : { status: 'WAIT', detail: detail + '; top up before locking' };
  });

  for (const txRef of seals) {
    await step(`seal ${txRef.slice(0, 8)}…`, async () => {
      const tx = await rpc('tx', { tx_hash: txRef, sender_account_id: accounts.publisher, wait_until: 'NONE' });
      const call = tx.transaction.actions?.[0]?.FunctionCall;
      must(tx.final_execution_status === 'FINAL' && Object.hasOwn(tx.status, 'SuccessValue'), 'Not a final, successful transaction');
      must(tx.transaction.receiver_id === accounts.record && call?.method_name === 'seal', 'Not a seal on the record contract');
      const args = JSON.parse(atob(call.args));
      const stored = roots.get(args.batch_id) ?? await view(accounts.record, 'root_of', { batch_id: args.batch_id });
      must(stored && stored.root === args.root && stored.previous_root === args.previous_root && stored.count === args.count,
        `Batch ${args.batch_id} on chain doesn't match this seal`);
      return `batch ${args.batch_id}, ${args.count} record(s), matches root_of`;
    });
  }

  for (const txRef of refusals) {
    await step(`refusal ${txRef.slice(0, 8)}…`, async () => {
      const outcome = await readers.spendGuard.readOutcome(txRef, accounts.agent);
      must(outcome, 'Not a final pay transaction from the agent');
      must(outcome.status === 'refused', `The spending contract ${outcome.status} this payment`);
      const tx = await rpc('tx', { tx_hash: txRef, sender_account_id: accounts.agent, wait_until: 'NONE' });
      const block = await archivalRpc('block', { block_id: tx.transaction_outcome.block_hash });
      const height = block.header.height;
      const owner = accounts.owner;
      // Read the vault from archival state just before the payment and a few blocks after it.
      const before = await view(accounts.spend, 'vault_of', { owner }, height - 1);
      const after = await view(accounts.spend, 'vault_of', { owner }, height + 5);
      must(String(before) === String(after), `The vault changed from ${near(before)} to ${near(after)}`);
      return `${outcome.reason}: ${near(outcome.amount)} to ${outcome.to}, vault ${near(before)} before and after`;
    });
  }
  const failed = rows.some(row => row.status === 'FAIL');
  const waiting = rows.some(row => row.status === 'WAIT');
  return { rows, verdict: failed ? 'failed' : waiting ? 'partial' : 'verified' };
}

