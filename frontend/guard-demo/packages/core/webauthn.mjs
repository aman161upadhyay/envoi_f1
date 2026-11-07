// Passkey (WebAuthn, ES256) support shared by the checker, the browser and tests.
//
// A passkey signs a permission like this: the challenge is the permission hash, and the
// authenticator signs authenticatorData || SHA-256(clientDataJSON) with its P-256 key.
// The proof carries `permission.keyType = 'passkey'`, the owner key as an uncompressed SEC1
// point in hex (`04 || x || y`, what the record contract stores), and
// `permission.signature = { authenticatorData, clientDataJSON, signature }` in base64url,
// with `signature` DER-encoded as authenticators return it.
import { fromHex, hex } from './crypto.mjs';

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;

export const toBase64Url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function fromBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) throw new TypeError('Invalid base64url');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
}

export const isPasskeyPublicKey = value => typeof value === 'string' && /^04[0-9a-f]{128}$/.test(value);

const sha256 = async bytes => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};
const sameBytes = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);

// DER ECDSA signature -> raw r || s (64 bytes), which WebCrypto verifies.
export function derToRaw(der) {
  if (der[0] !== 0x30 || der[1] !== der.length - 2) throw new TypeError('Invalid DER signature');
  const parts = [];
  let offset = 2;
  for (let i = 0; i < 2; i += 1) {
    if (der[offset] !== 0x02) throw new TypeError('Invalid DER signature');
    const length = der[offset + 1];
    let value = der.slice(offset + 2, offset + 2 + length);
    if (value.length !== length || length === 0) throw new TypeError('Invalid DER signature');
    while (value.length > 32 && value[0] === 0) value = value.slice(1);
    if (value.length > 32) throw new TypeError('Invalid DER signature');
    parts.push(concat(new Uint8Array(32 - value.length), value));
    offset += 2 + length;
  }
  if (offset !== der.length) throw new TypeError('Invalid DER signature');
  return concat(...parts);
}

export function rawToDer(raw) {
  const integer = bytes => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
    let value = bytes.slice(start);
    if (value[0] & 0x80) value = concat(Uint8Array.of(0), value);
    return concat(Uint8Array.of(0x02, value.length), value);
  };
  const body = concat(integer(raw.slice(0, 32)), integer(raw.slice(32, 64)));
  return concat(Uint8Array.of(0x30, body.length), body);
}

const originMatches = (origin, rpId) => {
  try {
    const { hostname } = new URL(origin);
    return hostname === rpId || hostname.endsWith('.' + rpId);
  } catch {
    return false;
  }
};

/**
 * Checks a passkey signature over a permission hash. Returns true only when the challenge is
 * this hash, the assertion came from a page on `rpId` (and from an allowed origin, when the
 * checker was given a list), the user was present and verified, and the P-256 signature holds.
 */
export async function verifyPasskeySignature({ publicKey, hash, signature, rpId, allowedOrigins }) {
  if (!isPasskeyPublicKey(publicKey) || typeof rpId !== 'string' || !rpId) return false;
  const authenticatorData = fromBase64Url(signature?.authenticatorData);
  const clientDataBytes = fromBase64Url(signature?.clientDataJSON);
  const der = fromBase64Url(signature?.signature);
  if (authenticatorData.length < 37) return false;
  const clientData = JSON.parse(new TextDecoder().decode(clientDataBytes));
  if (clientData.type !== 'webauthn.get') return false;
  if (clientData.challenge !== toBase64Url(fromHex(hash, 32))) return false;
  if (!originMatches(clientData.origin, rpId)) return false;
  if (Array.isArray(allowedOrigins) && !allowedOrigins.includes(clientData.origin)) return false;
  if (!sameBytes(authenticatorData.slice(0, 32), await sha256(new TextEncoder().encode(rpId)))) return false;
  const flags = authenticatorData[32];
  if (!(flags & FLAG_USER_PRESENT) || !(flags & FLAG_USER_VERIFIED)) return false;
  const key = await crypto.subtle.importKey('raw', fromHex(publicKey, 65), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const signed = concat(authenticatorData, await sha256(clientDataBytes));
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(der), signed);
}

/** Uncompressed hex point for a P-256 CryptoKey (or SPKI bytes from getPublicKey()). */
export async function passkeyPublicHex(keyOrSpki) {
  const key = keyOrSpki instanceof CryptoKey ? keyOrSpki :
    await crypto.subtle.importKey('spki', keyOrSpki, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
  return hex(await crypto.subtle.exportKey('raw', key));
}
