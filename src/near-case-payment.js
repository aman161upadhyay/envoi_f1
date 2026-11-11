import { createRpc } from '../frontend/guard-demo/adapters/near/rpc.mjs';
import { nearReaders } from '../frontend/guard-demo/adapters/near/read.mjs';

const accountPattern = /^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*\.testnet$/;
const digestPattern = /^[0-9a-f]{64}$/;
export const nearTransactionRef = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function failure(code, message, statusCode = 409) {
  return Object.assign(new Error(message), { code, statusCode });
}

export function createNearCasePayment({ rpcUrl, contract, agentAccounts, fetcher = fetch }) {
  if (!rpcUrl && !contract && !agentAccounts) return null;
  if (!rpcUrl || !accountPattern.test(contract) || !agentAccounts || Object.values(agentAccounts).some(id => !accountPattern.test(id))) {
    throw new Error('Configure a testnet spend contract, RPC and Envoi agent account mapping for case payments.');
  }
  const rpc = createRpc(rpcUrl, fetcher, { timeoutMs: 4000 });
  const { spendGuard } = nearReaders({ rpcUrl, spendContract: contract, fetcher });
  const assertNetwork = async () => {
    if ((await rpc('status', [])).chain_id !== 'testnet') throw failure('NEAR_PAYMENT_NETWORK_INVALID', 'The payment RPC is outside NEAR testnet.', 503);
  };
  return {
    async prepare({ agentId, ownerAccount, payload, paymentId, expiresAt }) {
      const agentAccount = Object.hasOwn(agentAccounts, agentId) ? agentAccounts[agentId] : null;
      const { payee, amount } = payload;
      if (!agentAccount || !accountPattern.test(ownerAccount) || !accountPattern.test(payee) || amount?.network !== 'near-testnet'
        || amount.unit !== 'yoctoNEAR' || !/^[1-9][0-9]{0,38}$/.test(amount.units)) {
        throw failure('NEAR_PAYMENT_SCOPE_INVALID', 'The signed payment must use configured NEAR testnet accounts and an exact amount.');
      }
      await assertNetwork();
      const result = await rpc('query', { request_type: 'call_function', finality: 'final', account_id: contract,
        method_name: 'get_policy', args_base64: Buffer.from(JSON.stringify({ agent: agentAccount })).toString('base64') });
      const policy = JSON.parse(Buffer.from(result.result));
      const ceiling = policy?.payees?.find(entry => entry.account === payee)?.max_per_payment;
      if (policy?.owner !== ownerAccount || policy.paused || !digestPattern.test(policy.policy_hash) || ceiling == null
        || BigInt(amount.units) > BigInt(ceiling) || BigInt(amount.units) > BigInt(policy.daily_cap)) {
        throw failure('NEAR_PAYMENT_POLICY_DENIED', 'The spending contract policy does not authorize this payment.', 403);
      }
      return { network: 'near-testnet', agentAccount, contract, method: 'pay', expiresAt,
        args: { to: payee, amount: amount.units, case_ref: paymentId, expected_policy_hash: policy.policy_hash } };
    },
    async confirm(instruction, txRef) {
      if (!nearTransactionRef.test(txRef)) throw failure('NEAR_TX_INVALID', 'A NEAR transaction reference is required.', 400);
      if (instruction.contract !== contract) throw failure('NEAR_PAYMENT_CONTRACT_CHANGED', 'The payment contract configuration changed.');
      await assertNetwork();
      const outcome = await spendGuard.readOutcome(txRef, instruction.agentAccount);
      if (!outcome || outcome.caseRef !== instruction.args.case_ref || outcome.policyHash !== instruction.args.expected_policy_hash
        || outcome.to !== instruction.args.to || outcome.amount !== instruction.args.amount) {
        throw failure('NEAR_PAYMENT_MISMATCH', 'The finalized transaction does not match the authorized case payment.');
      }
      return outcome;
    }
  };
}
