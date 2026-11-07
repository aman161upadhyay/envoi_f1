import { callWithScopedKey } from '../adapters/near/sign.mjs';

export const PUBLISHER_METHODS = ['seal', 'register_evidence_key'];

export async function registerEvidenceKey({ rpc, keys, publisher, recordContract, registry, keyId, publicKey }) {
  const active = key => key?.publicKey === publicKey && key.revokedAtMs === undefined;
  const existing = await registry.lookup(keyId);
  if (existing) {
    if (!active(existing)) throw new Error('The evidence key ID is already assigned or revoked.');
    return { ...existing, keyId, txRef: null };
  }
  let txRef;
  try {
    txRef = await callWithScopedKey({ rpc, keys, sender: publisher, receiver: recordContract,
      method: 'register_evidence_key', methods: PUBLISHER_METHODS,
      args: { key_id: keyId, public_key: publicKey } });
  } catch (error) {
    const registered = await registry.lookup(keyId);
    if (!active(registered)) throw error;
    return { ...registered, keyId, txRef: null };
  }
  const registered = await registry.lookup(keyId);
  if (!active(registered)) throw new Error('The evidence key registration was not confirmed.');
  return { ...registered, keyId, txRef };
}
