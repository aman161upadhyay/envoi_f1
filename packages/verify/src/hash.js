import { bytesToHex, concatBytes, hexToBytes, utf8 } from './bytes.js';
import { canonicalBytes } from './canonical.js';

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('WebCrypto is not available in this runtime');
  return s;
};

export const sha256 = async bytes => new Uint8Array(await subtle().digest('SHA-256', bytes));

export const sha256Hex = async bytes => bytesToHex(await sha256(bytes));

export const canonicalHash = async value => sha256Hex(canonicalBytes(value));

export const RECORD_SCHEMA = 'envoi.evidence/v1';

// Exactly the fields covered by record_hash (docs/proof-format.md section 2).
export const RECORD_FIELDS = Object.freeze([
  'schema', 'id', 'workspaceId', 'seq', 'type', 'agentId', 'caseId',
  'summary', 'detailsHash', 'ruleVersionHash', 'privateCheckHash', 'chainRef',
  'occurrences', 'firstAt', 'lastAt', 'salt', 'previousHash',
]);

export const pickRecordFields = record => {
  const out = {};
  for (const field of RECORD_FIELDS) {
    if (!(field in record)) throw new TypeError(`record is missing ${field}`);
    out[field] = record[field];
  }
  return out;
};

export const recordHash = async record => canonicalHash(pickRecordFields(record));

export const detailsHash = async (detailsSaltHex, details) =>
  sha256Hex(concatBytes(hexToBytes(detailsSaltHex), canonicalBytes(details ?? null)));

// Key fingerprints cover only the public members of the JWK, so exports from different
// libraries (which add alg, ext, key_ops, ...) still fingerprint the same.
export const publicJwk = jwk => {
  if (jwk?.kty === 'OKP' && jwk.crv === 'Ed25519') return { kty: 'OKP', crv: 'Ed25519', x: jwk.x };
  if (jwk?.kty === 'EC' && jwk.crv === 'P-256') return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
  throw new TypeError('unsupported public key');
};

export const keyFingerprint = async jwk => canonicalHash(publicJwk(jwk));

export const textHash = async text => sha256Hex(utf8(text));
