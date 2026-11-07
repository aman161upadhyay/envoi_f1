import { createPasskey, signWithPasskey } from '/packages/core/passkey.mjs';
import { verifyPasskeySignature } from '/packages/core/webauthn.mjs';

const storageKey = owner => 'envoi-owner-passkey:' + location.origin + ':' + owner;
export function passkeySupported() {
  return isSecureContext && Boolean(window.PublicKeyCredential && navigator.credentials) &&
    (location.hostname === 'localhost' || location.protocol === 'https:');
}
export function ownerPasskey(owner) {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(owner)));
    return value?.rpId === location.hostname && typeof value.credentialId === 'string' &&
      /^04[0-9a-f]{128}$/.test(value.publicKey) ? value : null;
  } catch { return null; }
}
export async function enrollPasskey(owner) {
  if (!passkeySupported()) throw new Error('Open this demo on http://localhost:4173 to use a passkey.');
  const passkey = await createPasskey({ ownerAccount: owner });
  localStorage.setItem(storageKey(owner), JSON.stringify(passkey));
  return passkey;
}
export async function signPermissionWithPasskey(owner, hash) {
  const passkey = ownerPasskey(owner);
  if (!passkey) throw new Error('Create a passkey for this owner first.');
  const signature = await signWithPasskey({ ...passkey, hash });
  if (!await verifyPasskeySignature({ publicKey: passkey.publicKey, hash, signature,
    rpId: passkey.rpId, allowedOrigins: [location.origin] })) throw new Error('The passkey signature did not verify.');
  return { keyType: 'passkey', publicKey: passkey.publicKey, rpId: passkey.rpId, signature };
}
export async function verifySavedPermission(entry, hash) {
  return verifyPasskeySignature({ publicKey: entry.publicKey, signature: entry.signature, hash,
    rpId: entry.rpId, allowedOrigins: [location.origin] });
}
