import assert from 'node:assert/strict';
import test from 'node:test';
import { base58Encode } from '../adapters/near/sign.mjs';
import { registerEvidenceKey, PUBLISHER_METHODS } from '../scripts/evidence-key.mjs';

test('evidence registration uses the restricted publisher key and confirms before returning', async () => {
  const keys = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  let registered = null;
  let calls = 0;
  const rpc = async (method, params) => {
    if (method === 'query') return { nonce: 1, block_hash: '1'.repeat(32),
      permission: { FunctionCall: { receiver_id: 'record.testnet', method_names: [...PUBLISHER_METHODS] } } };
    assert.equal(method, 'send_tx');
    calls++;
    const signed = Buffer.from(params.signed_tx_base64, 'base64');
    const hash = base58Encode(new Uint8Array(await crypto.subtle.digest('SHA-256', signed.subarray(0, -65))));
    registered = { publicKey: 'ab'.repeat(32), registeredAtMs: 123 };
    return { final_execution_status: 'FINAL', transaction: { hash }, status: { SuccessValue: '' } };
  };
  const options = { rpc, keys, publisher: 'publisher.testnet', recordContract: 'record.testnet',
    registry: { lookup: async () => registered }, keyId: 'ev-test', publicKey: 'ab'.repeat(32) };
  const result = await registerEvidenceKey(options);
  assert.equal(result.registeredAtMs, 123);
  assert.equal(result.keyId, 'ev-test');
  assert.equal(calls, 1);
  assert.equal((await registerEvidenceKey(options)).txRef, null);
  assert.equal(calls, 1);
  await assert.rejects(registerEvidenceKey({ ...options, publicKey: 'cd'.repeat(32) }), /already assigned/);
  registered.revokedAtMs = 124;
  await assert.rejects(registerEvidenceKey(options), /already assigned/);
});

test('unconfirmed evidence registration stops the runner setup', async () => {
  await assert.rejects(registerEvidenceKey({
    registry: { lookup: async () => null },
    rpc: async () => { throw new Error('unavailable'); },
    keys: await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']),
    publisher: 'publisher.testnet', recordContract: 'record.testnet', keyId: 'ev-test', publicKey: 'ab'.repeat(32)
  }), /unavailable/);
});
