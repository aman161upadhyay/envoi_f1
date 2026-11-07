// Writes to the record contract with the publisher's limited key: list envoi's evidence key,
// then seal batches. Both calls go through callWithScopedKey, which refuses a full-access key.
import { callWithScopedKey } from './sign.mjs';

// The exact method list on the publisher's function-call key (order doesn't matter).
export const PUBLISHER_METHODS = Object.freeze(['register_evidence_key', 'seal']);

const KEY_ID = /^[a-z0-9-]{1,32}$/;

/** A fresh, never-reused evidence key ID such as `ev-mh3k2x1a-9f2c` (the contract refuses reuse). */
export function newEvidenceKeyId(now = Date.now()) {
  const random = Array.from(crypto.getRandomValues(new Uint8Array(2)), byte => byte.toString(16).padStart(2, '0')).join('');
  return `ev-${now.toString(36)}-${random}`;
}

/**
 * Lists envoi's evidence key on the record contract and reads it back. Returns the listing's
 * block time; records signed with this key must be created at or after `registeredAtMs`.
 */
export async function registerEvidenceKey({ rpc, keys, publisher, recordContract, keyId, publicKey, evidenceRegistry }) {
  if (!KEY_ID.test(keyId) || !/^[0-9a-f]{64}$/.test(publicKey)) throw new TypeError('Invalid evidence key');
  const txRef = await callWithScopedKey({ rpc, keys, sender: publisher, receiver: recordContract,
    method: 'register_evidence_key', methods: PUBLISHER_METHODS, args: { key_id: keyId, public_key: publicKey } });
  const listed = await evidenceRegistry.lookup(keyId);
  if (!listed || listed.publicKey !== publicKey || listed.revokedAtMs !== undefined) {
    throw new Error('The record contract did not list evidence key ' + keyId + ' (' + txRef + ')');
  }
  return { txRef, registeredAtMs: listed.registeredAtMs };
}

/** Seals the next batch after reading the contract's tip. Returns the batch and seal transaction. */
export async function sealNextBatch({ rpc, keys, publisher, recordContract, root, count }) {
  const tip = await rpc('query', { request_type: 'call_function', finality: 'final', account_id: recordContract,
    method_name: 'last', args_base64: btoa('{}') });
  const [last, previousRoot] = JSON.parse(new TextDecoder().decode(Uint8Array.from(tip.result)));
  const batch = { batchId: last + 1, root, previousRoot, count };
  const sealRef = await callWithScopedKey({ rpc, keys, sender: publisher, receiver: recordContract, method: 'seal',
    methods: PUBLISHER_METHODS, args: { batch_id: batch.batchId, root, previous_root: previousRoot, count } });
  return { batch, sealRef };
}
