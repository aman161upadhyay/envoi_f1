// Producer-side helpers: the server lane uses these to build records, batches and proofs so
// the bytes it writes are exactly the bytes the checker reads. One implementation, two sides.
import { hexToBytes, randomHex } from './bytes.js';
import { canonicalHash, detailsHash, RECORD_SCHEMA, recordHash } from './hash.js';
import { inclusionProof, merkleRoot } from './merkle.js';
import { signEd25519 } from './signatures.js';

export const buildRecord = async ({ details = null, detailsSalt = randomHex(), salt = randomHex(), privateCheck = null, ...fields }) => {
  const record = {
    schema: RECORD_SCHEMA,
    caseId: null, ruleVersionHash: null, chainRef: null, previousHash: null, occurrences: 1,
    ...fields,
    detailsHash: await detailsHash(detailsSalt, details),
    privateCheckHash: privateCheck ? await canonicalHash(privateCheck) : null,
    salt,
  };
  return { record, details, detailsSalt, privateCheck, recordHash: await recordHash(record) };
};

export const signRecordHash = async (recordHashHex, { keyId, privateJwk, publicJwk }) => ({
  keyId, alg: 'Ed25519', signature: await signEd25519(privateJwk, hexToBytes(recordHashHex)), publicKey: publicJwk,
});

export const buildBatch = async ({ batchId, recordHashes, previousRoot = null }) => {
  const root = await merkleRoot(recordHashes);
  const pathFor = leafIndex => inclusionProof(recordHashes, leafIndex);
  return { batchId, root, previousRoot, count: recordHashes.length, pathFor };
};

export const signPermissionVersion = async ({ document, device, rpId, rpOrigin, ownerRef, ownerName, method = 'passkey' }) => {
  const documentHash = await canonicalHash(document);
  const assertion = await device.sign({ documentHash, rpId, rpOrigin });
  return { document, documentHash, method, ownerRef, ownerName, rpId, rpOrigin, ownerPublicKey: device.publicJwk, assertion };
};

export const assembleProof = async ({ built, envoiSignature, permissionVersion = null, batch, leafIndex, seals = [], registry = null, includeDetails = true }) => {
  const proof = {
    format: 'envoi.proof/v1',
    record: built.record,
    recordHash: built.recordHash,
    envoiSignature,
    batch: {
      batchId: batch.batchId, root: batch.root, previousRoot: batch.previousRoot, count: batch.count,
      leafIndex, siblings: await batch.pathFor(leafIndex),
    },
    seals,
  };
  if (includeDetails && built.details != null) { proof.details = built.details; proof.detailsSalt = built.detailsSalt; }
  if (permissionVersion) proof.permissionVersion = permissionVersion;
  if (built.privateCheck) proof.privateCheck = built.privateCheck;
  if (registry) proof.registry = registry;
  return proof;
};
