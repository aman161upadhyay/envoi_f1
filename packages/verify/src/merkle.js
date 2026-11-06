// RFC 6962 Merkle tree hash with domain-separated leaves and nodes.
// Leaves are record hashes (hex). See docs/proof-format.md section 3.
import { bytesToHex, concatBytes, hexToBytes } from './bytes.js';
import { sha256 } from './hash.js';

const LEAF = Uint8Array.of(0x00);
const NODE = Uint8Array.of(0x01);

export const leafHash = async recordHashHex => sha256(concatBytes(LEAF, hexToBytes(recordHashHex)));
export const nodeHash = async (left, right) => sha256(concatBytes(NODE, left, right));

const splitPoint = n => {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
};

const mth = async leaves => {
  if (leaves.length === 1) return leaves[0];
  const k = splitPoint(leaves.length);
  return nodeHash(await mth(leaves.slice(0, k)), await mth(leaves.slice(k)));
};

export const merkleRoot = async recordHashes => {
  if (!Array.isArray(recordHashes) || recordHashes.length === 0) throw new RangeError('a batch needs at least one record');
  const leaves = await Promise.all(recordHashes.map(leafHash));
  return bytesToHex(await mth(leaves));
};

// Sides of each sibling, bottom-up, for leaf m in a tree of n leaves.
export const expectedSides = (m, n) => {
  if (!Number.isInteger(m) || !Number.isInteger(n) || m < 0 || m >= n) throw new RangeError('leaf index out of range');
  const sides = [];
  const walk = (index, size) => {
    if (size <= 1) return;
    const k = splitPoint(size);
    if (index < k) { walk(index, k); sides.push('right'); }
    else { walk(index - k, size - k); sides.push('left'); }
  };
  walk(m, n);
  return sides;
};

export const inclusionProof = async (recordHashes, m) => {
  const leaves = await Promise.all(recordHashes.map(leafHash));
  const path = [];
  const walk = async (index, slice) => {
    if (slice.length <= 1) return;
    const k = splitPoint(slice.length);
    if (index < k) {
      await walk(index, slice.slice(0, k));
      path.push({ hash: bytesToHex(await mth(slice.slice(k))), side: 'right' });
    } else {
      await walk(index - k, slice.slice(k));
      path.push({ hash: bytesToHex(await mth(slice.slice(0, k))), side: 'left' });
    }
  };
  if (!Number.isInteger(m) || m < 0 || m >= leaves.length) throw new RangeError('leaf index out of range');
  await walk(m, leaves);
  return path;
};

export const verifyInclusion = async ({ recordHash, leafIndex, count, siblings, root }) => {
  let sides;
  try { sides = expectedSides(leafIndex, count); } catch { return { ok: false, reason: 'leaf index out of range' }; }
  if (!Array.isArray(siblings) || siblings.length !== sides.length) return { ok: false, reason: 'wrong path length' };
  let acc = await leafHash(recordHash);
  for (let i = 0; i < siblings.length; i += 1) {
    const { hash, side } = siblings[i];
    if (side !== sides[i]) return { ok: false, reason: 'path sides do not match leaf index' };
    const sibling = hexToBytes(hash);
    acc = side === 'left' ? await nodeHash(sibling, acc) : await nodeHash(acc, sibling);
  }
  return bytesToHex(acc) === root ? { ok: true } : { ok: false, reason: 'path does not lead to the batch root' };
};
