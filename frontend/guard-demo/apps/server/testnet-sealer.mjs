import { encodeFunctionCall, base58Decode, base58Encode } from '../../adapters/near/sign.mjs';
import { fromHex, publicHex } from '../../packages/core/crypto.mjs';
import { PUBLISHER_METHODS } from '../../scripts/evidence-key.mjs';

export function testnetSealer({ rpc, keys, publisher, recordContract, publicRecord }) {
  return {
    async tip() {
      const response = await rpc('query', { request_type: 'call_function', finality: 'final',
        account_id: recordContract, method_name: 'last', args_base64: 'e30=' });
      const [batchId, root] = JSON.parse(Buffer.from(response.result));
      return { batchId, root };
    },
    async prepare(batch) {
      const rawKey = fromHex(await publicHex(keys.publicKey), 32);
      const access = await rpc('query', { request_type: 'view_access_key', finality: 'final',
        account_id: publisher, public_key: 'ed25519:' + base58Encode(rawKey) });
      const scope = access.permission?.FunctionCall;
      if (!scope || scope.receiver_id !== recordContract || scope.method_names.length !== PUBLISHER_METHODS.length ||
          !PUBLISHER_METHODS.every(method => scope.method_names.includes(method))) throw new Error('The publisher key has unexpected permissions.');
      if (!Number.isSafeInteger(access.nonce)) throw new Error('Unsupported publisher nonce.');
      const tx = encodeFunctionCall({ sender: publisher, receiver: recordContract, publicKey: rawKey,
        blockHash: base58Decode(access.block_hash), nonce: BigInt(access.nonce) + 1n, method: 'seal',
        args: { batch_id: batch.id, root: batch.root, previous_root: batch.previous_root, count: batch.count },
        gas: '100000000000000' });
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', tx));
      const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', keys.privateKey, hash));
      return {
        txRef: base58Encode(hash),
        signedTransaction: Buffer.concat([tx, Buffer.from([0]), signature]).toString('base64')
      };
    },
    async broadcast(submission) {
      try {
        await rpc('send_tx', { signed_tx_base64: submission.signedTransaction, wait_until: 'FINAL' });
      } catch (error) {
        if (error.rpcError === 'INVALID_TRANSACTION' && /\bExpired\b/.test(JSON.stringify(error.data))) {
          error.permanentSealFailure = true;
        }
        throw error;
      }
    },
    async inspect(submission, batch) {
      const root = await publicRecord.readRoot(batch.id);
      if (root) {
        if (root.root !== batch.root || root.previousRoot !== batch.previous_root || root.count !== batch.count) {
          return { status: 'conflict', detail: 'This batch ID was sealed with different contents. Operator reconciliation is required.' };
        }
        const valid = await publicRecord.verifySeal(submission.txRef, {
          batchId: batch.id, root: batch.root, previousRoot: batch.previous_root, count: batch.count
        });
        return valid ? { status: 'final', txRef: submission.txRef } :
          { status: 'failed', detail: 'The public root matched but this seal transaction did not verify.' };
      }
      try {
        const tx = await rpc('tx', { tx_hash: submission.txRef, sender_account_id: publisher, wait_until: 'NONE' });
        if (tx.final_execution_status === 'FINAL' && tx.status?.Failure) {
          return { status: 'failed', detail: 'The stored seal transaction failed. Operator reconciliation is required.' };
        }
        return { status: 'pending' };
      } catch (error) {
        if (error.rpcError === 'UNKNOWN_TRANSACTION') return { status: 'missing' };
        throw error;
      }
    }
  };
}
