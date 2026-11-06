import { base58Decode, base58Encode } from './sign.mjs';

export async function loadScopedKey(secret, publicKey) {
  // NEAR CLI credentials contain a 32-byte seed followed by its 32-byte public key.
  const raw = secret?.startsWith('ed25519:') ? base58Decode(secret.slice(8)) : [];
  if (raw.length !== 64 || publicKey !== secretPublic(raw)) throw new Error('A valid scoped testnet credential is required.');
  const prefix = Uint8Array.of(0x30, 0x2e, 2, 1, 0, 0x30, 5, 6, 3, 0x2b, 0x65, 0x70, 4, 0x22, 4, 0x20);
  const privateKey = await crypto.subtle.importKey('pkcs8', Uint8Array.from([...prefix, ...raw.slice(0, 32)]), 'Ed25519', false, ['sign']);
  const key = await crypto.subtle.importKey('raw', raw.slice(32), 'Ed25519', true, ['verify']);
  const challenge = Uint8Array.of(1);
  if (!await crypto.subtle.verify('Ed25519', key, await crypto.subtle.sign('Ed25519', privateKey, challenge), challenge)) {
    throw new Error('Scoped credential public key does not match its private key.');
  }
  return { privateKey, publicKey: key };
}

function secretPublic(raw) {
  return 'ed25519:' + base58Encode(raw.slice(32));
}
