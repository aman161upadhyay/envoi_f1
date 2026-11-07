// The runner's record-contract writes: listing envoi's evidence key and sealing, both with the
// publisher's limited key. The RPC is a fixture that checks exactly what gets signed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { base58Encode } from '../adapters/near/sign.mjs';
import { newEvidenceKeyId, PUBLISHER_METHODS, registerEvidenceKey, sealNextBatch } from '../adapters/near/record.mjs';
import { nearReaders } from '../adapters/near/read.mjs';
import { hashJson, publicHex } from '../packages/core/crypto.mjs';
import { makeEvidence } from '../packages/core/evidence.mjs';
import { ZERO_ROOT } from '../packages/core/tree.mjs';

const recordContract = 'record.owner.testnet';
const publisher = 'publisher.owner.testnet';
const bytes = value => Array.from(new TextEncoder().encode(JSON.stringify(value)));

function fixtureRpc({ methods = PUBLISHER_METHODS, tip = [3, 'ab'.repeat(32)] } = {}) {
  const sent = [];
  const rpc = async (method, params) => {
    if (method === 'query' && params.request_type === 'view_access_key') {
      return { nonce: 1, block_hash: base58Encode(new Uint8Array(32)),
        permission: { FunctionCall: { receiver_id: recordContract, method_names: [...methods] } } };
    }
    if (method === 'query' && params.request_type === 'call_function') {
      assert.equal(params.method_name, 'last');
      return { result: bytes(tip) };
    }
    if (method === 'send_tx') {
      const signed = Buffer.from(params.signed_tx_base64, 'base64');
      const transaction = signed.subarray(0, -65);
      const hash = base58Encode(new Uint8Array(await crypto.subtle.digest('SHA-256', transaction)));
      sent.push(transaction.toString('latin1'));
      return { final_execution_status: 'FINAL', transaction: { hash }, status: { SuccessValue: '' } };
    }
    throw new Error('unexpected ' + method);
  };
  return { rpc, sent };
}

test('evidence key IDs fit the contract rules and are not reused', () => {
  const ids = new Set(Array.from({ length: 50 }, () => newEvidenceKeyId(1_700_000_000_000)));
  assert.ok(ids.size > 45);
  for (const id of ids) assert.match(id, /^[a-z0-9-]{1,32}$/);
});

test('the runner lists its evidence key with the publisher key and reads it back', async () => {
  const keys = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  const evidencePublic = 'cd'.repeat(32);
  const { rpc, sent } = fixtureRpc();
  const evidenceRegistry = { lookup: async id => (id === 'ev-run-1' ? { publicKey: evidencePublic, registeredAtMs: 1234 } : null) };
  const result = await registerEvidenceKey({ rpc, keys, publisher, recordContract, keyId: 'ev-run-1', publicKey: evidencePublic, evidenceRegistry });
  assert.equal(result.registeredAtMs, 1234);
  assert.match(result.txRef, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  assert.match(sent[0], /register_evidence_key/);
  assert.match(sent[0], /"key_id":"ev-run-1"/);

  const wrongKey = { lookup: async () => ({ publicKey: 'ef'.repeat(32), registeredAtMs: 1 }) };
  await assert.rejects(registerEvidenceKey({ rpc, keys, publisher, recordContract, keyId: 'ev-run-2', publicKey: evidencePublic, evidenceRegistry: wrongKey }), /did not list/);
  await assert.rejects(registerEvidenceKey({ rpc, keys, publisher, recordContract, keyId: 'EV 1', publicKey: evidencePublic, evidenceRegistry }), /Invalid evidence key/);
});

test('a publisher key without register_evidence_key is refused before signing', async () => {
  const keys = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  const { rpc, sent } = fixtureRpc({ methods: ['seal'] });
  const evidenceRegistry = { lookup: async () => null };
  await assert.rejects(registerEvidenceKey({ rpc, keys, publisher, recordContract, keyId: 'ev-1', publicKey: 'cd'.repeat(32), evidenceRegistry }), /limited testnet access key/);
  await assert.rejects(sealNextBatch({ rpc, keys, publisher, recordContract, root: 'ef'.repeat(32), count: 1 }), /limited testnet access key/);
  assert.equal(sent.length, 0);
});

test('sealing reads the tip and seals the next batch linked to it', async () => {
  const keys = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  const { rpc, sent } = fixtureRpc({ tip: [3, 'ab'.repeat(32)] });
  const { batch, sealRef } = await sealNextBatch({ rpc, keys, publisher, recordContract, root: 'ef'.repeat(32), count: 5 });
  assert.deepEqual(batch, { batchId: 4, root: 'ef'.repeat(32), previousRoot: 'ab'.repeat(32), count: 5 });
  assert.ok(sealRef);
  assert.match(sent[0], /seal/);
  assert.match(sent[0], new RegExp(`"previous_root":"${'ab'.repeat(32)}"`));
});

test('records carry the run\'s evidence key ID', async () => {
  const pair = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  const entry = await makeEvidence({ seq: 1, type: 'permission_changed', agent: 'milo.owner.testnet', counterparty: 'x.testnet', caseRef: 'c',
    summary: 's', previousHash: ZERO_ROOT, permissionHash: await hashJson('p'), createdAtMs: 1, details: {} }, { ...pair, keyId: 'ev-run-1' });
  assert.equal(entry.envoi.keyId, 'ev-run-1');
  assert.equal(entry.envoi.publicKey, await publicHex(pair.publicKey));
  const legacy = await makeEvidence({ seq: 1, type: 't', agent: 'a.testnet', counterparty: 'b.testnet', caseRef: 'c', summary: 's',
    previousHash: ZERO_ROOT, permissionHash: await hashJson('p'), createdAtMs: 1, details: {} }, pair);
  assert.equal(legacy.envoi.keyId, 'ev-1');
});

test('a record contract without evidence keys is reported, not read as "no key"', async () => {
  const fetcher = async () => new Response(JSON.stringify({ result: { error: 'wasm execution failed with error: MethodResolveError(MethodNotFound)', logs: [] } }));
  const { evidenceRegistry } = nearReaders({ rpcUrl: 'https://rpc.example', recordContract, spendContract: 'spend.owner.testnet', publisher, fetcher });
  await assert.rejects(evidenceRegistry.lookup('preflight-probe'), /evidence_key failed/);
});
