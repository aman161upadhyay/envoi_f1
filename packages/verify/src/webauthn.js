// Checks a WebAuthn assertion whose challenge is a permission document hash.
// docs/proof-format.md section 4.
import { base64UrlToBytes, bytesToBase64Url, concatBytes, equalBytes, hexToBytes, utf8 } from './bytes.js';
import { sha256 } from './hash.js';
import { verifyEs256Der } from './signatures.js';

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;

export const verifyPermissionAssertion = async ({ documentHash, rpId, rpOrigin, ownerPublicKey, assertion }) => {
  let authData;
  let clientDataBytes;
  let clientData;
  try {
    authData = base64UrlToBytes(assertion.authenticatorData);
    clientDataBytes = base64UrlToBytes(assertion.clientDataJSON);
    clientData = JSON.parse(new TextDecoder().decode(clientDataBytes));
  } catch {
    return { ok: false, reason: 'unreadable assertion' };
  }
  if (authData.length < 37) return { ok: false, reason: 'authenticator data too short' };
  if (clientData.type !== 'webauthn.get') return { ok: false, reason: 'not an authentication assertion' };
  if (clientData.challenge !== bytesToBase64Url(hexToBytes(documentHash))) return { ok: false, reason: 'signed something other than this permission' };
  if (clientData.origin !== rpOrigin) return { ok: false, reason: 'signed on a different site' };
  if (!equalBytes(authData.slice(0, 32), await sha256(utf8(rpId)))) return { ok: false, reason: 'signed for a different site' };
  const flags = authData[32];
  if (!(flags & FLAG_UP)) return { ok: false, reason: 'no user presence' };
  const signed = concatBytes(authData, await sha256(clientDataBytes));
  const ok = await verifyEs256Der(ownerPublicKey, signed, assertion.signature);
  if (!ok) return { ok: false, reason: 'signature does not match the device key' };
  const view = new DataView(authData.buffer, authData.byteOffset, authData.byteLength);
  return { ok: true, userVerified: Boolean(flags & FLAG_UV), signCount: view.getUint32(33) };
};
