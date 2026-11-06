import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { canonicalString, expectedSides, inclusionProof, merkleRoot, verifyInclusion } from '../packages/verify/src/index.js';

const vectors = JSON.parse(fs.readFileSync(new URL('./evidence/vectors.json', import.meta.url), 'utf8'));

// Independent reference implementation of RFC 6962 MTH using node:crypto, to cross-check.
const h = (...parts) => crypto.createHash('sha256').update(Buffer.concat(parts)).digest();
const naiveRoot = hexes => {
  const mth = leaves => {
    if (leaves.length === 1) return h(Buffer.from([0]), leaves[0]);
    let k = 1; while (k * 2 < leaves.length) k *= 2;
    return h(Buffer.from([1]), mth(leaves.slice(0, k)), mth(leaves.slice(k)));
  };
  return mth(hexes.map(x => Buffer.from(x, 'hex'))).toString('hex');
};

test('vector roots match the reference implementation and the committed vectors', async () => {
  for (const v of vectors.merkle) {
    assert.equal(naiveRoot(v.leaves), v.root, `reference root for ${v.leaves.length} leaves`);
    assert.equal(await merkleRoot(v.leaves), v.root, `library root for ${v.leaves.length} leaves`);
  }
});

test('every leaf of every vector has a valid inclusion path with RFC 6962 sides', async () => {
  for (const v of vectors.merkle) {
    for (let i = 0; i < v.leaves.length; i += 1) {
      const siblings = await inclusionProof(v.leaves, i);
      assert.deepEqual(siblings.map(s => s.side), expectedSides(i, v.leaves.length));
      const result = await verifyInclusion({ recordHash: v.leaves[i], leafIndex: i, count: v.leaves.length, siblings, root: v.root });
      assert.equal(result.ok, true, `leaf ${i} of ${v.leaves.length}`);
    }
  }
});

test('tampered paths are rejected', async () => {
  const v = vectors.merkle.find(x => x.leaves.length === 7);
  const siblings = await inclusionProof(v.leaves, 4);
  const base = { recordHash: v.leaves[4], leafIndex: 4, count: 7, root: v.root };
  assert.equal((await verifyInclusion({ ...base, siblings: siblings.slice(1) })).ok, false, 'removed sibling');
  const flipped = siblings.map((s, i) => (i === 0 ? { ...s, side: s.side === 'left' ? 'right' : 'left' } : s));
  assert.equal((await verifyInclusion({ ...base, siblings: flipped })).ok, false, 'flipped side');
  assert.equal((await verifyInclusion({ ...base, leafIndex: 5, siblings })).ok, false, 'wrong index');
  assert.equal((await verifyInclusion({ ...base, recordHash: v.leaves[3], siblings })).ok, false, 'other leaf');
  assert.equal((await verifyInclusion({ ...base, leafIndex: 9, siblings })).ok, false, 'index out of range');
});

test('canonical JSON matches the committed vectors and rejects ambiguous values', () => {
  for (const c of vectors.canonical) assert.equal(canonicalString(c.input), c.output);
  assert.throws(() => canonicalString({ a: undefined }));
  assert.throws(() => canonicalString({ a: Number.NaN }));
  assert.throws(() => canonicalString({ a: new Date(0) }));
});
