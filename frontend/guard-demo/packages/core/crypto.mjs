const encoder = new TextEncoder();

export function canonical(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') {
    if (/[\uD800-\uDFFF]/u.test(value)) throw new TypeError('Invalid Unicode');
    return JSON.stringify(value);
  }
  if (Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + Array.from(value, canonical).join(',') + ']';
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(key => canonical(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  throw new TypeError('Expected JSON with safe integers');
}

export function fromHex(value, size) {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(value) || (size !== undefined && value.length !== size * 2)) {
    throw new TypeError('Invalid hex');
  }
  return Uint8Array.from(value.match(/../g), pair => Number.parseInt(pair, 16));
}

export function hex(bytes) {
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function digest(...parts) {
  const data = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    data.set(part, offset);
    offset += part.length;
  }
  return hex(await crypto.subtle.digest('SHA-256', data));
}

export const hashJson = value => digest(encoder.encode(canonical(value)));
export const hashDetails = (salt, details) => digest(fromHex(salt, 32), encoder.encode(canonical(details)));
export const randomSalt = () => hex(crypto.getRandomValues(new Uint8Array(32)));

export async function verify(publicKey, signature, hash) {
  const key = await crypto.subtle.importKey('raw', fromHex(publicKey, 32), 'Ed25519', false, ['verify']);
  return crypto.subtle.verify('Ed25519', key, fromHex(signature, 64), fromHex(hash, 32));
}

export async function sign(key, hash) {
  return hex(await crypto.subtle.sign('Ed25519', key, fromHex(hash, 32)));
}

export const publicHex = async key => hex(await crypto.subtle.exportKey('raw', key));
