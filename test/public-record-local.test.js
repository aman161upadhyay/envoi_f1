// Shared PublicRecord behaviour, run against the local adapter in CI. The same expectations are
// encoded in contracts/near/envoi-record unit tests (strict order, root chaining, append-only keys).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalPublicRecord } from '../src/public-record/local.js';
import { createPublicRecords, readersFor } from '../src/public-record/index.js';

const R1 = '1'.repeat(64);
const R2 = '2'.repeat(64);
const FP = 'f'.repeat(64);

test('seals must be in order and chained to the previous root', async () => {
  const chain = createLocalPublicRecord();
  await assert.rejects(chain.publish({ batchId: 2, root: R1, previousRoot: null, count: 1 }), /out of order/);
  const receipt = await chain.publish({ batchId: 1, root: R1, previousRoot: null, count: 3 });
  assert.equal(receipt.network, 'local');
  await assert.rejects(chain.publish({ batchId: 2, root: R2, previousRoot: null, count: 1 }), /bad link/);
  await chain.publish({ batchId: 2, root: R2, previousRoot: R1, count: 1 });
  const read = await chain.readRoot(2);
  assert.equal(read.root, R2);
  assert.equal(read.previousRoot, R1);
  assert.deepEqual(await chain.reader().last(), [2, R2]);
  assert.equal((await chain.status(receipt.txRef)).status, 'final');
});

test('inputs are validated', async () => {
  const chain = createLocalPublicRecord();
  await assert.rejects(chain.publish({ batchId: 1, root: 'ZZ', previousRoot: null, count: 1 }), /root/);
  await assert.rejects(chain.publish({ batchId: 0, root: R1, previousRoot: null, count: 1 }), /batchId/);
  await assert.rejects(chain.registerKey({ kind: 'admin', keyRef: 'x', keyId: 'k', fingerprint: FP, alg: 'Ed25519' }), /kind/);
});

test('keys are append only and listed with a block time', async () => {
  const chain = createLocalPublicRecord();
  await chain.registerKey({ kind: 'owner', keyRef: 'ref', keyId: 'k1', fingerprint: FP, alg: 'ES256' });
  await assert.rejects(chain.registerKey({ kind: 'owner', keyRef: 'ref', keyId: 'k2', fingerprint: FP, alg: 'ES256' }), /already listed/);
  const keys = await chain.reader().keysOf('local.envoi', 'ref');
  assert.equal(keys.length, 1);
  assert.match(keys[0].block_ts, /^\d+$/);
});

test('an outage fails the publish and the next attempt succeeds in order', async () => {
  const chain = createLocalPublicRecord();
  chain.simulateOutage(1);
  await assert.rejects(chain.publish({ batchId: 1, root: R1, previousRoot: null, count: 1 }), /outage/);
  assert.equal((await chain.health()).ok, true);
  await chain.publish({ batchId: 1, root: R1, previousRoot: null, count: 1 });
});

test('file persistence lets another process read the record', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'envoi-pr-')), 'record.json');
  const writer = createLocalPublicRecord({ path: file });
  await writer.publish({ batchId: 1, root: R1, previousRoot: null, count: 1 });
  const reader = createLocalPublicRecord({ path: file }).reader();
  assert.equal((await reader.rootOf('local.envoi', 1)).root, R1);
});

test('configuration builds the local adapter by default and rejects unknown networks', async () => {
  const records = await createPublicRecords({});
  assert.deepEqual(records.map(r => r.network), ['local']);
  assert.deepEqual(Object.keys(readersFor(records)), ['local']);
  await assert.rejects(createPublicRecords({ PUBLIC_RECORD_NETWORKS: 'monad-testnet' }), /unknown public record network/);
  await assert.rejects(createPublicRecords({ PUBLIC_RECORD_NETWORKS: 'near-testnet' }), /record contract account is not configured/);
});
