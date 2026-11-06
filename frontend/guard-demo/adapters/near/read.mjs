const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const decode = value => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value), char => char.charCodeAt(0))));

export function nearReaders({ rpcUrl, recordContract, spendContract, publisher, recordCodeHash, network = 'near-testnet', fetcher = fetch }) {
  if (!['near-testnet', 'near-mainnet'].includes(network)) throw new TypeError('Unsupported NEAR network');
  async function rpc(method, params) {
    const response = await fetcher(rpcUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'envoi', method, params }),
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`NEAR RPC returned ${response.status}`);
    const { result, error } = await response.json();
    if (error || !result) throw new Error(error?.cause?.name ?? 'Missing NEAR RPC result');
    return result;
  }
  const query = (request_type, account_id, fields = {}) =>
    rpc('query', { request_type, account_id, finality: 'final', ...fields });

  async function view(account, method_name, args) {
    const bytes = new TextEncoder().encode(JSON.stringify(args));
    const args_base64 = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
    const result = await query('call_function', account, { method_name, args_base64 });
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(result.result)));
  }

  async function transaction(txRef, sender, contract, method) {
    if (!TX_HASH.test(txRef) || !sender) return null;
    const result = await rpc('tx', { tx_hash: txRef, sender_account_id: sender, wait_until: 'FINAL' });
    const { transaction: tx, status } = result;
    const call = tx?.actions?.[0]?.FunctionCall;
    if (result.final_execution_status !== 'FINAL' || tx?.hash !== txRef || tx.signer_id !== sender ||
        tx.receiver_id !== contract || tx.actions.length !== 1 || call?.method_name !== method ||
        !Object.hasOwn(status ?? {}, 'SuccessValue')) return null;
    return { result, args: decode(call.args) };
  }

  const publicRecord = {
    network,
    async status(txRef) { return await transaction(txRef, publisher, recordContract, 'seal') ? 'final' : 'failed'; },
    async readRoot(batchId) {
      const batch = await view(recordContract, 'root_of', { batch_id: batchId });
      return batch && { root: batch.root, previousRoot: batch.previous_root, count: batch.count, sealedAtMs: batch.sealed_at_ms };
    },
    async verifySeal(txRef, batch) {
      const tx = await transaction(txRef, publisher, recordContract, 'seal');
      return Boolean(tx && tx.args.batch_id === batch.batchId && tx.args.root === batch.root &&
        tx.args.previous_root === batch.previousRoot && tx.args.count === batch.count);
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
  const spendGuard = {
    network, unit: 'yoctoNEAR',
    async getPolicy(agent) {
      const policy = await view(spendContract, 'get_policy', { agent });
      return policy && { policyHash: policy.policy_hash, version: policy.version, paused: policy.paused, dailyCap: policy.daily_cap,
        payees: policy.payees.map(entry => ({ account: entry.account, maxPerPayment: entry.max_per_payment })) };
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
  return { publicRecord, ownerRegistry, spendGuard, agentAccounts, recordContract, spendContract, recordCodeHash };
}
