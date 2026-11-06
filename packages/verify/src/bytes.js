// Byte helpers that work the same in Node 22 and in browsers. No dependencies.

const HEX = /^[0-9a-f]*$/;

export const utf8 = text => new TextEncoder().encode(text);

export const hexToBytes = hex => {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !HEX.test(hex)) throw new TypeError('expected lowercase hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

export const bytesToHex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

export const concatBytes = (...parts) => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};

export const bytesToBase64Url = bytes => {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const base64UrlToBytes = text => {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) throw new TypeError('expected base64url');
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
};

export const equalBytes = (a, b) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
};

export const randomHex = (length = 32) => bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(length)));
