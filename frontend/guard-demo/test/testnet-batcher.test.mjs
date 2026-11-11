import test from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceStore } from '../apps/server/evidence-store.mjs';
import { EvidenceBatcher } from '../apps/server/evidence-batcher.mjs';
import { testnetSealer } from '../apps/server/testnet-sealer.mjs';
import { base58Encode } from '../adapters/near/sign.mjs';
import { NearRpcError } from '../adapters/near/rpc.mjs';

test('testnet batcher persists exact signed bytes before broadcast and confirms the public seal', async () => {
  const keys = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  const store = new EvidenceStore(':memory:', { network: 'near-testnet', recordContract: 'record.testnet', publisher: 'publisher.testnet' });
  let root;
  let sent = 0;
  let txRef;
  const publicRecord = {
    readRoot: async () => root ?? null,
    verifySeal: async (ref, batch) => ref === txRef && batch.root === root?.root
  };
  const rpc = async (method, params) => {
    if (method === 'query' && params.method_name === 'last') {
      return { result: [...Buffer.from(JSON.stringify([0, '0'.repeat(64)]))] };
    }
    if (method === 'query') return { nonce: 1, block_hash: '1'.repeat(32),
      permission: { FunctionCall: { receiver_id: 'record.testnet', method_names: ['seal', 'register_evidence_key'] } } };
    if (method === 'tx') throw new NearRpcError('UNKNOWN_TRANSACTION');
    assert.equal(method, 'send_tx');
    const saved = JSON.parse(store.activeBatch().submission);
    assert.equal(saved.signedTransaction, params.signed_tx_base64);
    const signed = Buffer.from(saved.signedTransaction, 'base64');
    const tx = signed.subarray(0, -65);
    const digest = await crypto.subtle.digest('SHA-256', tx);
    assert.equal(await crypto.subtle.verify('Ed25519', keys.publicKey, signed.subarray(-64), digest), true);
    txRef = base58Encode(new Uint8Array(digest));
    assert.equal(txRef, saved.txRef);
    root = { root: store.activeBatch().root, previousRoot: '0'.repeat(64), count: 1 };
    sent++;
    return {};
  };
  try {
    await store.append('event-1', {
      agent: 'milo.testnet', counterparty: 'ledger.testnet', caseRef: 'test', type: 'share_blocked',
      summary: 'Blocked share', details: {}, permissionHash: '0'.repeat(64), createdAtMs: 1
    }, keys);
    const batcher = new EvidenceBatcher({
      store, transport: testnetSealer({ rpc, keys, publisher: 'publisher.testnet', recordContract: 'record.testnet', publicRecord })
    });
    assert.equal((await batcher.tick()).status, 'final');
    assert.equal(sent, 1);
    assert.equal(await batcher.tick(), null);
  } finally { store.close(); }
});
