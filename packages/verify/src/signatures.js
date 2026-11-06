// Ed25519 and ES256 (P-256) through WebCrypto. WebAuthn returns ES256 signatures in DER;
// WebCrypto wants raw r||s, so we convert both ways here.
import { base64UrlToBytes, bytesToBase64Url, concatBytes } from './bytes.js';
import { publicJwk } from './hash.js';

const subtle = () => globalThis.crypto.subtle;

export const importEd25519Public = jwk => subtle().importKey('jwk', publicJwk(jwk), { name: 'Ed25519' }, false, ['verify']);
export const importP256Public = jwk => subtle().importKey('jwk', publicJwk(jwk), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);

export const verifyEd25519 = async (jwk, message, signatureB64url) => {
  try {
    const key = await importEd25519Public(jwk);
    return await subtle().verify({ name: 'Ed25519' }, key, base64UrlToBytes(signatureB64url), message);
  } catch {
    return false;
  }
};

const readDerInt = (bytes, offset) => {
  if (bytes[offset] !== 0x02) throw new Error('DER: expected integer');
  const len = bytes[offset + 1];
  let value = bytes.slice(offset + 2, offset + 2 + len);
  while (value.length > 32 && value[0] === 0) value = value.slice(1);
  if (value.length > 32) throw new Error('DER: integer too long');
  const padded = new Uint8Array(32);
  padded.set(value, 32 - value.length);
  return { value: padded, next: offset + 2 + len };
};

export const derToRaw = der => {
  if (der[0] !== 0x30) throw new Error('DER: expected sequence');
  const r = readDerInt(der, 2);
  const s = readDerInt(der, r.next);
  return concatBytes(r.value, s.value);
};

const derInt = bytes => {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  let v = bytes.slice(start);
  if (v[0] & 0x80) v = concatBytes(Uint8Array.of(0), v);
  return concatBytes(Uint8Array.of(0x02, v.length), v);
};

export const rawToDer = raw => {
  const body = concatBytes(derInt(raw.slice(0, 32)), derInt(raw.slice(32, 64)));
  return concatBytes(Uint8Array.of(0x30, body.length), body);
};

export const verifyEs256Der = async (jwk, data, derSignatureB64url) => {
  try {
    const key = await importP256Public(jwk);
    const raw = derToRaw(base64UrlToBytes(derSignatureB64url));
    return await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, key, raw, data);
  } catch {
    return false;
  }
};

// Signing helpers for envoi's evidence key (server and tests). The private key is a JWK with `d`.
export const generateEd25519 = async () => {
  const pair = await subtle().generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  return { privateJwk: await subtle().exportKey('jwk', pair.privateKey), publicJwk: publicJwk(await subtle().exportKey('jwk', pair.publicKey)) };
};

export const signEd25519 = async (privateJwk, message) => {
  const key = await subtle().importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: privateJwk.x, d: privateJwk.d }, { name: 'Ed25519' }, false, ['sign']);
  return bytesToBase64Url(new Uint8Array(await subtle().sign({ name: 'Ed25519' }, key, message)));
};
