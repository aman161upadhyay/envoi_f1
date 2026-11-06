// `near` public record: writes batch roots and key listings to the envoi-record contract.
// The publisher key should be a function-call key limited to `seal` and `register_key` on the
// record contract, so a leaked publisher key can't move funds or touch anything else.
import { Account, JsonRpcProvider, teraToGas, yoctoToNear } from 'near-api-js';
import { createNearReader, EXPLORER } from '../../packages/verify/src/near-reader.js';
import { assertKeyInput, assertSealInput } from './validate.js';

const failureOf = response => {
  const status = response?.status;
  if (status && typeof status === 'object' && 'Failure' in status) return JSON.stringify(status.Failure).slice(0, 300);
  for (const outcome of response?.receipts_outcome ?? []) {
    const s = outcome?.outcome?.status;
    if (s && typeof s === 'object' && 'Failure' in s) return JSON.stringify(s.Failure).slice(0, 300);
  }
  return null;
};

export const createNearPublicRecord = ({ network, contractId, rpcUrl, publisherId, publisherKey }) => {
  if (!contractId) throw new Error(`${network}: record contract account is not configured`);
  const provider = new JsonRpcProvider({ url: rpcUrl });
  const reader = createNearReader({ network, rpcUrl });
  const explorer = EXPLORER[network];
  let account = null;
  const publisher = () => {
    if (!publisherId || !publisherKey) throw new Error(`${network}: publisher account or key is not configured`);
    account ??= new Account(publisherId, provider, publisherKey);
    return account;
  };

  const call = async (methodName, args) => {
    const response = await publisher().callFunctionRaw({ contractId, methodName, args, gas: teraToGas('30'), waitUntil: 'EXECUTED_OPTIMISTIC' });
    const failure = failureOf(response);
    if (failure) throw new Error(`${methodName} failed on ${network}: ${failure}`);
    const txRef = response.transaction?.hash ?? response.transaction_outcome?.id;
    return { network, contractId, txRef, explorerUrl: explorer ? explorer.tx(txRef) : undefined };
  };

  return {
    network,
    contractId,
    publish(input) {
      assertSealInput(input);
      return call('seal', { batch_id: input.batchId, root: input.root, previous_root: input.previousRoot, count: input.count });
    },
    registerKey(input) {
      assertKeyInput(input);
      return call('register_key', { kind: input.kind, key_ref: input.keyRef, key_id: input.keyId, fingerprint: input.fingerprint, alg: input.alg, prev_sig_ref: input.prevSigRef ?? null });
    },
    async status(txRef) {
      try {
        const response = await provider.viewTransactionStatus({ txHash: txRef, accountId: publisherId, waitUntil: 'NONE' });
        const failure = failureOf(response);
        if (failure) return { status: 'failed', error: failure };
        return response.final_execution_status === 'FINAL' ? { status: 'final', finalAt: new Date() } : { status: 'submitted' };
      } catch (error) {
        return { status: 'submitted', error: String(error?.message ?? error) };
      }
    },
    async readRoot(batchId) {
      const r = await reader.rootOf(contractId, batchId);
      return r && { root: r.root, previousRoot: r.previous_root, count: r.count, sealedAt: new Date(Number(BigInt(r.block_ts) / 1_000_000n)) };
    },
    reader: () => reader,
    async health() {
      try {
        const state = await publisher().getState();
        return { ok: true, balance: yoctoToNear(state.balance?.available ?? state.amount ?? 0n, 4) };
      } catch (error) {
        return { ok: false, detail: String(error?.message ?? error) };
      }
    },
  };
};
