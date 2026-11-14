import { createRpc } from '../frontend/guard-demo/adapters/near/rpc.mjs';
import { nearReaders } from '../frontend/guard-demo/adapters/near/read.mjs';
import { loadScopedKey } from '../frontend/guard-demo/adapters/near/key-file.mjs';
import { callWithScopedKey } from '../frontend/guard-demo/adapters/near/sign.mjs';
import { parseAmount } from '../frontend/guard-demo/packages/core/policy.mjs';
import { paymentApprover } from '../frontend/guard-demo/packages/core/payment-approval.mjs';

const accountPattern = /^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*\.testnet$/;
const digestPattern = /^[0-9a-f]{64}$/;
export const nearTransactionRef = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const cancelMethod = 'cancel_payments';
const cancellationGas = 100_000_000_000_000n;
const cancellationBatchSize = 32;
// Current NEAR protocol minimum prepaid gas purchase price, in yoctoNEAR per gas.
const minGasPurchasePrice = 1_000_000_000n;

function cancellationBudget(gasPrice, runtime) {
  const { action_receipt_creation_config: receipt, action_creation_config: actions } = runtime.transaction_costs;
  const gasFor = fee => BigInt(fee.send_not_sir) + BigInt(fee.execution);
  // The contract accepts up to 32 references of 128 bytes. Include JSON escaping,
  // the other arguments and the method name in the transaction's byte fee.
  const maxCallBytes = BigInt(cancellationBatchSize * (128 * 6 + 3) + 512);
  const gas = cancellationGas + gasFor(receipt) + gasFor(actions.function_call_cost)
    + maxCallBytes * gasFor(actions.function_call_cost_per_byte);
  const price = BigInt(gasPrice);
  if (price <= 0n || gas < cancellationGas) throw new Error('Invalid NEAR gas configuration.');
  return gas * (price > minGasPurchasePrice ? price : minGasPurchasePrice);
}

function failure(code, message, statusCode = 409) {
  return Object.assign(new Error(message), { code, statusCode });
}

export function createNearCasePayment({ rpcUrl, contract, agentAccounts, approvalSigningKey, cancellationRelay, fetcher = fetch }) {
  if (!rpcUrl && !contract && !agentAccounts && !approvalSigningKey) return null;
  if (!rpcUrl || !accountPattern.test(contract) || !agentAccounts || !approvalSigningKey ||
      Object.values(agentAccounts).some(id => !accountPattern.test(id))) {
    throw new Error('Configure a testnet spend contract, RPC, agent accounts and an approval signing key for case payments.');
  }
  const approver = paymentApprover(approvalSigningKey);
  if (cancellationRelay && !accountPattern.test(cancellationRelay.account)) {
    throw new Error('Configure a NEAR testnet account for the payment cancellation relay.');
  }
  const rpc = createRpc(rpcUrl, fetcher, { timeoutMs: 4000 });
  const cancellationRpc = createRpc(rpcUrl, fetcher, { timeoutMs: 15000 });
  let cancellationQueue = Promise.resolve();
  const { spendGuard, agentAccounts: accountReader } = nearReaders({ rpcUrl, spendContract: contract, fetcher });
  const mappedAccount = agentId => Object.hasOwn(agentAccounts, agentId) ? agentAccounts[agentId] : null;
  const readSpend = async (method_name, agent) => {
    const result = await rpc('query', { request_type: 'call_function', finality: 'final', account_id: contract,
      method_name, args_base64: Buffer.from(JSON.stringify({ agent })).toString('base64') });
    return JSON.parse(Buffer.from(result.result));
  };
  const assertNetwork = async () => {
    if ((await rpc('status', [])).chain_id !== 'testnet') throw failure('NEAR_PAYMENT_NETWORK_INVALID', 'The payment RPC is outside NEAR testnet.', 503);
  };
  async function checkCancellationRelay() {
    const { account, publicKey, privateKey } = cancellationRelay;
    const [key, relay, price, config] = await Promise.all([
      rpc('query', { request_type: 'view_access_key', finality: 'final', account_id: account, public_key: publicKey }),
      rpc('query', { request_type: 'view_account', finality: 'final', account_id: account }),
      rpc('gas_price', [null]),
      rpc('EXPERIMENTAL_protocol_config', { finality: 'final' })
    ]);
    const permission = key.permission?.FunctionCall;
    if (permission?.receiver_id !== contract || permission.method_names?.length !== 1 || permission.method_names[0] !== cancelMethod) {
      throw new Error('A cancellation-only NEAR access key is required.');
    }
    const cost = cancellationBudget(price.gas_price, config.runtime_config);
    const available = BigInt(relay.amount) - BigInt(relay.storage_usage) * BigInt(config.runtime_config.storage_amount_per_byte);
    if (available < cost || (permission.allowance !== null && BigInt(permission.allowance) < cost)) {
      throw new Error('The NEAR cancellation relay cannot fund a cancellation.');
    }
    await loadScopedKey(privateKey, publicKey);
  }
  return {
    async readScope({ agentId, ownerAccount }) {
      const account = mappedAccount(agentId);
      if (!account || !accountPattern.test(ownerAccount)) return null;
      await assertNetwork();
      const policy = await readSpend('get_policy', account);
      if (policy?.owner !== ownerAccount || !digestPattern.test(policy.policy_hash)) return null;
      parseAmount(policy.daily_cap);
      const payees = policy.payees.map(entry => {
        if (!accountPattern.test(entry.account)) throw new Error('Invalid spending policy payee.');
        parseAmount(entry.max_per_payment);
        return { label: entry.account, account: entry.account, maxPerPayment: entry.max_per_payment };
      });
      const { keys } = await accountReader.describe(account);
      const key = keys[0];
      const agentKey = keys.length === 1 && key.kind === 'function_call' && key.receiver === contract
        && key.methods.length === 1 && key.methods[0] === 'pay'
        ? { account, receiver: contract, methods: ['pay'], allowance: key.allowance ?? undefined }
        : undefined;
      return { source: 'near-testnet', payees, dailyCap: policy.daily_cap, unit: 'yoctoNEAR', paused: policy.paused === true, agentKey };
    },
    async prepare({ agentId, ownerAccount, payload, paymentId, expiresAt }) {
      if (!cancellationRelay) {
        throw failure('NEAR_PAYMENT_CANCELLATION_UNAVAILABLE', 'Configure the payment cancellation relay before issuing approvals.', 503);
      }
      const agentAccount = mappedAccount(agentId);
      const { payee, amount } = payload;
      if (!agentAccount || !accountPattern.test(ownerAccount) || !accountPattern.test(payee) || amount?.network !== 'near-testnet'
        || amount.unit !== 'yoctoNEAR' || !/^[1-9][0-9]{0,38}$/.test(amount.units)) {
        throw failure('NEAR_PAYMENT_SCOPE_INVALID', 'The signed payment must use configured NEAR testnet accounts and an exact amount.');
      }
      await assertNetwork();
      const policy = await readSpend('get_policy', agentAccount);
      const ceiling = policy?.payees?.find(entry => entry.account === payee)?.max_per_payment;
      if (policy?.owner !== ownerAccount || policy.paused || !digestPattern.test(policy.policy_hash) || ceiling == null
        || BigInt(amount.units) > BigInt(ceiling) || BigInt(amount.units) > BigInt(policy.daily_cap)) {
        throw failure('NEAR_PAYMENT_POLICY_DENIED', 'The spending contract policy does not authorize this payment.', 403);
      }
      if (await readSpend('get_payment_approval_key', agentAccount) !== approver.publicKey) {
        throw failure('NEAR_PAYMENT_APPROVER_UNCONFIGURED', 'The owner must register the payment approval key for this agent.', 503);
      }
      try {
        const [supported] = await Promise.all([readSpend('payment_cancellation_supported', agentAccount), checkCancellationRelay()]);
        if (supported !== true) throw new Error('The spending contract does not support cancellation.');
      } catch {
        throw failure('NEAR_PAYMENT_CANCELLATION_UNAVAILABLE', 'The deployed contract and relay must support cancellation before issuing a payment.', 503);
      }
      const expiresAtMs = Math.min(Date.parse(expiresAt), Date.now() + 120_000);
      if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= Date.now()) {
        throw failure('NEAR_PAYMENT_APPROVAL_EXPIRED', 'Evaluate the payment again to get a current approval.');
      }
      const approval = approver.approve({ contract, owner: ownerAccount, agent: agentAccount, to: payee, amount: amount.units,
        caseRef: paymentId, policyHash: policy.policy_hash, policyVersion: policy.version, expiresAtMs });
      return { network: 'near-testnet', agentAccount, contract, method: 'pay', expiresAt: new Date(expiresAtMs).toISOString(),
        args: { to: payee, amount: amount.units, case_ref: paymentId, expected_policy_hash: policy.policy_hash, approval } };
    },
    async confirm(instruction, txRef) {
      if (!nearTransactionRef.test(txRef)) throw failure('NEAR_TX_INVALID', 'A NEAR transaction reference is required.', 400);
      if (instruction.contract !== contract) throw failure('NEAR_PAYMENT_CONTRACT_CHANGED', 'The payment contract configuration changed.');
      await assertNetwork();
      const outcome = await spendGuard.readOutcome(txRef, instruction.agentAccount, instruction.args.approval);
      if (!outcome || outcome.caseRef !== instruction.args.case_ref || outcome.policyHash !== instruction.args.expected_policy_hash
        || outcome.to !== instruction.args.to || outcome.amount !== instruction.args.amount) {
        throw failure('NEAR_PAYMENT_MISMATCH', 'The finalized transaction does not match the authorized case payment.');
      }
      return outcome;
    },
    async cancel(agentId, payments) {
      const agent = mappedAccount(agentId);
      if (!agent) {
        throw failure('NEAR_PAYMENT_CANCELLATION_UNAVAILABLE', 'Cannot cancel the outstanding payment approvals. Retry after restoring the cancellation relay.', 503);
      }
      const run = cancellationQueue.then(async () => {
        await assertNetwork();
        const { header } = await rpc('block', { finality: 'final' });
        const blockTime = Number(BigInt(header.timestamp_nanosec) / 1_000_000n);
        if (!Number.isSafeInteger(blockTime)) throw new Error('Invalid NEAR block timestamp.');
        const expired = new Set(payments.filter(payment => (payment.instruction.args.approval?.expires_at_ms
          ?? Date.parse(payment.instruction.expiresAt)) <= blockTime).map(payment => payment.id));
        const outstanding = payments.filter(payment => !expired.has(payment.id));
        const references = outstanding.map(payment => payment.instruction.args.case_ref);
        if (!references.length) return expired;
        if (!cancellationRelay || outstanding.some(payment =>
          payment.instruction.contract !== contract || payment.instruction.agentAccount !== agent)) {
          throw new Error('The original payment cancellation configuration is required.');
        }
        const policy = await readSpend('get_policy', agent);
        const keys = await loadScopedKey(cancellationRelay.privateKey, cancellationRelay.publicKey);
        for (let start = 0; start < references.length; start += cancellationBatchSize) {
          const case_refs = references.slice(start, start + cancellationBatchSize);
          const signature = approver.cancel({ contract, owner: policy.owner, agent, references: case_refs });
          await callWithScopedKey({ rpc: cancellationRpc, keys, sender: cancellationRelay.account, receiver: contract,
            method: cancelMethod, gas: String(cancellationGas), args: { agent, case_refs, signature } });
        }
        return expired;
      });
      // Serialize nonce use for this key in this process. Another server racing on the same
      // key can fail safely and retry the idempotent cancellation before committing its controls.
      cancellationQueue = run.catch(() => {});
      try { return await run; }
      catch {
        throw failure('NEAR_PAYMENT_CANCELLATION_UNAVAILABLE', 'NEAR did not confirm cancellation of the outstanding payment approvals. Retry the control change.', 503);
      }
    }
  };
}
