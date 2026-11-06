// Input checks shared by every adapter.
export const HEX32 = /^[0-9a-f]{64}$/;

export const assertSealInput = ({ batchId, root, previousRoot, count }) => {
  if (!Number.isSafeInteger(batchId) || batchId < 1) throw new TypeError('batchId must be a positive integer');
  if (!HEX32.test(root)) throw new TypeError('root must be 32-byte lowercase hex');
  if (previousRoot !== null && !HEX32.test(previousRoot)) throw new TypeError('previousRoot must be hex or null');
  if (!Number.isSafeInteger(count) || count < 1 || count > 0xffffffff) throw new TypeError('count must be a positive u32');
};

export const assertKeyInput = ({ kind, keyRef, keyId, fingerprint, alg }) => {
  if (!['envoi', 'owner', 'owner_demo'].includes(kind)) throw new TypeError('kind must be envoi, owner or owner_demo');
  if (typeof keyRef !== 'string' || keyRef.length === 0 || keyRef.length > 128) throw new TypeError('keyRef required');
  if (typeof keyId !== 'string' || keyId.length === 0 || keyId.length > 128) throw new TypeError('keyId required');
  if (!HEX32.test(fingerprint)) throw new TypeError('fingerprint must be 32-byte lowercase hex');
  if (!['Ed25519', 'ES256'].includes(alg)) throw new TypeError('alg must be Ed25519 or ES256');
};
