// Browser helpers for the Settings screen: create an owner passkey, and sign a permission hash
// with it. Both need a page on https or on http://localhost (WebAuthn refuses IP addresses such
// as 127.0.0.1). The output plugs straight into the proof format the checker reads.
import { fromHex } from './crypto.mjs';
import { fromBase64Url, passkeyPublicHex, toBase64Url } from './webauthn.mjs';

const ES256 = -7;

/**
 * Creates a passkey for the owner. Returns what the owner then lists on the record contract
 * with `register_owner_key({ key_type: 'passkey', public_key, label })`, plus the credential
 * ID the page keeps to sign with this passkey later.
 */
export async function createPasskey({ rpId = location.hostname, rpName = 'envoi', ownerAccount, displayName = ownerAccount }) {
  const credential = await navigator.credentials.create({ publicKey: {
    rp: { id: rpId, name: rpName },
    user: { id: new TextEncoder().encode(ownerAccount), name: ownerAccount, displayName },
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    pubKeyCredParams: [{ type: 'public-key', alg: ES256 }],
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    attestation: 'none'
  } });
  const spki = credential.response.getPublicKey?.();
  if (!spki || credential.response.getPublicKeyAlgorithm?.() !== ES256) throw new Error('This device did not create a P-256 passkey.');
  return { credentialId: toBase64Url(credential.rawId), publicKey: await passkeyPublicHex(spki), rpId };
}

/**
 * Asks the owner's device to sign a permission hash (Face ID, Touch ID, Windows Hello or a
 * security key). Returns the `permission.signature` object for the proof.
 */
export async function signWithPasskey({ credentialId, hash, rpId = location.hostname }) {
  const assertion = await navigator.credentials.get({ publicKey: {
    challenge: fromHex(hash, 32),
    rpId,
    allowCredentials: [{ type: 'public-key', id: fromBase64Url(credentialId) }],
    userVerification: 'required',
    timeout: 60000
  } });
  return {
    authenticatorData: toBase64Url(assertion.response.authenticatorData),
    clientDataJSON: toBase64Url(assertion.response.clientDataJSON),
    signature: toBase64Url(assertion.response.signature)
  };
}
