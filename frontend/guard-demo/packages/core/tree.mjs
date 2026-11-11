import { digest, fromHex } from './crypto.mjs';

export const ZERO_ROOT = '0'.repeat(64);
const leaf = hash => digest(Uint8Array.of(0), fromHex(hash, 32));
const node = (left, right) => digest(Uint8Array.of(1), fromHex(left, 32), fromHex(right, 32));

export async function buildTree(hashes) {
  if (!hashes.length) throw new TypeError('Empty batch');
  const levels = [await Promise.all(hashes.map(leaf))];
  while (levels.at(-1).length > 1) {
    const level = levels.at(-1);
    const parents = [];
    for (let i = 0; i < level.length; i += 2) {
      parents.push(i + 1 < level.length ? await node(level[i], level[i + 1]) : level[i]);
    }
    levels.push(parents);
  }
  return {
    root: levels.at(-1)[0],
    path(index) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= hashes.length) throw new RangeError('Invalid leaf');
      const siblings = [];
      for (const level of levels.slice(0, -1)) {
        const isRight = index % 2 === 1;
        const sibling = level[index + (isRight ? -1 : 1)];
        if (sibling) siblings.push({ hash: sibling, side: isRight ? 'left' : 'right' });
        index = Math.floor(index / 2);
      }
      return siblings;
    }
  };
}

export async function verifyPath(recordHash, batch) {
  let { leafIndex: index, count } = batch;
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index < 0 || index >= count) return false;
  let hash = await leaf(recordHash);
  let cursor = 0;
  while (count > 1) {
    if (index % 2 === 1 || index + 1 < count) {
      const sibling = batch.siblings[cursor++];
      const side = index % 2 === 1 ? 'left' : 'right';
      if (sibling?.side !== side) return false;
      hash = side === 'left' ? await node(sibling.hash, hash) : await node(hash, sibling.hash);
    }
    index = Math.floor(index / 2);
    count = Math.ceil(count / 2);
  }
  return cursor === batch.siblings.length && hash === batch.root;
}
