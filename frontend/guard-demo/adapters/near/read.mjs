import { createRpc, DEFAULT_ARCHIVAL_RPC, DEFAULT_RPC, NearUnavailable } from './rpc.mjs';
import { parseAmount } from '../../packages/core/policy.mjs';

const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const decode = value => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value), char => char.charCodeAt(0))));
const missingBlock = error => ['UNKNOWN_BLOCK', 'GARBAGE_COLLECTED_BLOCK'].includes(error?.rpcError);

export function nearReaders({ rpcUrl, recordContract, spendContract, publisher, recordCodeHash, network = 'near-testnet', fetcher = fetch }) {
  if (!['near-testnet', 'near-mainnet'].includes(network)) throw new TypeError('Unsupported NEAR network');
  // Outages throw NearUnavailable, which the checker reports as "not checked" instead of a failure.
  // Transaction lookups use archival nodes on the default endpoints, so old seals still verify.
  const usesDefaults = !rpcUrl || rpcUrl === DEFAULT_RPC[network];
  const rpc = createRpc(rpcUrl || DEFAULT_RPC[network], fetcher,
    { timeoutMs: 15000, archivalUrls: usesDefaults ? DEFAULT_ARCHIVAL_RPC[network] : [] });
  const query = (request_type, account_id, fields = {}) =>
    rpc('query', { request_type, account_id, finality: 'final', ...fields });

  async function view(account, method_name, args, blockId) {
    const bytes = new TextEncoder().encode(JSON.stringify(args));
    const args_base64 = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
    const result = await rpc('query', { request_type: 'call_function', account_id: account, method_name, args_base64,
      ...(blockId === undefined ? { finality: 'final' } : { block_id: blockId }) });
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(result.result)));
  }

  async function transaction(txRef, sender, contract, method) {
    if (!TX_HASH.test(txRef) || !sender) return null;
    // NONE answers at once: a known transaction reports its status, an unknown one returns
    // UNKNOWN_TRANSACTION. Waiting for FINAL would instead time out on a made-up hash, and a
    // forged proof would read "not checked" instead of failing. Only FINAL outcomes count below.
    const result = await rpc('tx', { tx_hash: txRef, sender_account_id: sender, wait_until: 'NONE' });
    const { transaction: tx, status } = result;
    const call = tx?.actions?.[0]?.FunctionCall;
    if (result.final_execution_status !== 'FINAL' || tx?.hash !== txRef || tx.signer_id !== sender ||
        tx.receiver_id !== contract || tx.actions.length !== 1 || call?.method_name !== method ||
        !Object.hasOwn(status ?? {}, 'SuccessValue')) return null;
    return { result, args: decode(call.args) };
  }

  async function readSeal(txRef, batch) {
    const tx = await transaction(txRef, publisher, recordContract, 'seal');
    return tx && tx.args.batch_id === batch.batchId && tx.args.root === batch.root &&
      tx.args.previous_root === batch.previousRoot && tx.args.count === batch.count ? tx.result : null;
  }

  async function block(blockId) {
    const { header } = await rpc('block', { block_id: blockId });
    const time = Number(BigInt(header.timestamp_nanosec) / 1_000_000n);
    if (!Number.isSafeInteger(time) || !Number.isSafeInteger(header.height) || !TX_HASH.test(header.hash)) {
      throw new NearUnavailable('Incomplete NEAR block header');
    }
    return { hash: header.hash, previousHash: header.prev_hash, height: header.height, time };
  }

  async function blockAtOrBefore(height, knownLowerHeight) {
    // Heights can be skipped. Check nearby heights before treating the archive as incomplete.
    const floor = Math.max(knownLowerHeight + 1, height - 15);
    for (let candidate = height; candidate >= floor; candidate--) {
      try { return await block(candidate); }
      catch (error) { if (!missingBlock(error)) throw error; }
    }
    if (floor === knownLowerHeight + 1) return null;
    throw new NearUnavailable('Historical NEAR block headers are unavailable');
  }

  async function blockAtTime(sealed, timestamp) {
    if (timestamp > sealed.time) return null;
    if (timestamp === sealed.time) return sealed.hash;
    let upper = sealed;
    let lower;
    // Bracket from the seal so recent records need only a few lookups.
    for (let offset = 1; !lower; offset *= 2) {
      const height = Math.max(0, sealed.height - offset);
      const candidate = await blockAtOrBefore(height, -1);
      if (!candidate) throw new NearUnavailable('No historical NEAR block for the record time');
      if (candidate.time <= timestamp) lower = candidate;
      else {
        if (height === 0) return null;
        upper = candidate;
      }
    }
    let lowerHeight = lower.height;
    while (upper.previousHash !== lower.hash && upper.height - lowerHeight > 1) {
      const midpoint = lowerHeight + Math.floor((upper.height - lowerHeight) / 2);
      const candidate = await blockAtOrBefore(midpoint, lower.height);
      if (candidate && candidate.time > timestamp) upper = candidate;
      else {
        if (candidate) lower = candidate;
        lowerHeight = midpoint;
      }
    }
    if (upper.previousHash !== lower.hash) throw new NearUnavailable('Historical NEAR block history is incomplete');
    return lower.hash;
  }

  const publicRecord = {
    network,
    async status(txRef) { return await transaction(txRef, publisher, recordContract, 'seal') ? 'final' : 'failed'; },
    async readRoot(batchId) {
      const batch = await view(recordContract, 'root_of', { batch_id: batchId });
      return batch && { root: batch.root, previousRoot: batch.previous_root, count: batch.count, sealedAtMs: batch.sealed_at_ms };
    },
    async verifySeal(txRef, batch) {
      return Boolean(await readSeal(txRef, batch));
    },
    async describeContract() {
      const [account, keys] = await Promise.all([query('view_account', recordContract), query('view_access_key_list', recordContract)]);
      return { address: recordContract, codeHash: account.code_hash, locked: keys.keys.length === 0 };
    }
  };
  const ownerRegistry = {
    network,
    async lookup(owner, publicKey) {
      const list = await view(recordContract, 'owner_keys', { owner });
      const key = list.find(entry => entry.public_key === publicKey);
      return key ? { type: key.key_type, label: key.label, registeredAtMs: key.registered_at_ms,
        ...(key.revoked_at_ms === null ? {} : { revokedAtMs: key.revoked_at_ms }) } : null;
    }
  };
  const evidenceRegistry = {
    network,
    async lookup(keyId) {
      const key = await view(recordContract, 'evidence_key', { key_id: keyId });
      return key && { publicKey: key.public_key, registeredAtMs: key.registered_at_ms,
        ...(key.revoked_at_ms === null ? {} : { revokedAtMs: key.revoked_at_ms }) };
    }
  };
  const spendGuard = {
    network, unit: 'yoctoNEAR',
    async vaultOf(owner) {
      const balance = await view(spendContract, 'vault_of', { owner });
      parseAmount(balance);
      return balance;
    },
    async getPolicy(agent) {
      const policy = await view(spendContract, 'get_policy', { agent });
      return policy && { policyHash: policy.policy_hash, version: policy.version, paused: policy.paused, dailyCap: policy.daily_cap,
        payees: policy.payees.map(entry => ({ account: entry.account, maxPerPayment: entry.max_per_payment })) };
    },
    async getPolicyAt(agent, timestamp, { seal, batch }) {
      if (seal.network !== network || seal.contract !== recordContract) return null;
      const tx = await readSeal(seal.txRef, batch);
      if (!tx) return null;
      const receiptId = tx.transaction_outcome?.outcome?.status?.SuccessReceiptId;
      const outcome = tx.receipts_outcome?.find(receipt => receipt.id === receiptId && receipt.outcome.executor_id === recordContract);
      if (!TX_HASH.test(outcome?.block_hash ?? '') || !Object.hasOwn(outcome.outcome.status ?? {}, 'SuccessValue')) {
        throw new NearUnavailable('NEAR archive did not return the seal receipt');
      }
      try {
        const historicalBlock = await blockAtTime(await block(outcome.block_hash), timestamp);
        if (!historicalBlock) return null;
        const policy = await view(spendContract, 'get_policy', { agent }, historicalBlock);
        return policy && { policyHash: policy.policy_hash };
      } catch (error) {
        if (missingBlock(error)) throw new NearUnavailable('Historical NEAR policy is unavailable', { cause: error });
        throw error;
      }
    },
    async readOutcome(txRef, agent) {
      const tx = await transaction(txRef, agent, spendContract, 'pay');
      if (!tx) return null;
      const outcome = decode(tx.result.status.SuccessValue);
      if (!['refused', 'paid'].includes(outcome.status) || outcome.agent !== agent || outcome.to !== tx.args.to ||
          outcome.amount !== tx.args.amount || outcome.case_ref !== tx.args.case_ref) return null;
      return { status: outcome.status, txRef, agent, to: outcome.to, amount: outcome.amount, caseRef: outcome.case_ref,
        policyHash: outcome.policy_hash, ...(outcome.reason ? { reason: outcome.reason } : {}) };
    }
  };
  const agentAccounts = {
    network,
    async describe(agent) {
      const result = await query('view_access_key_list', agent);
      return { account: agent, keys: result.keys.map(entry => {
        const permission = entry.access_key.permission;
        if (permission === 'FullAccess') return { publicKey: entry.public_key, kind: 'full' };
        const { receiver_id, method_names, allowance } = permission.FunctionCall;
        return { publicKey: entry.public_key, kind: 'function_call', receiver: receiver_id, methods: method_names, allowance };
      }) };
    }
  };
  return { publicRecord, ownerRegistry, evidenceRegistry, spendGuard, agentAccounts, recordContract, spendContract, recordCodeHash };
}
