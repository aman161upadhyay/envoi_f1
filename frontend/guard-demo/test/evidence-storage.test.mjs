import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EvidenceStore } from '../apps/server/evidence-store.mjs';
import { EvidenceBatcher } from '../apps/server/evidence-batcher.mjs';
import { localSealer } from '../apps/server/local-sealer.mjs';
import { createLocalAdapters } from '../adapters/local/store.mjs';
import { hashJson } from '../packages/core/crypto.mjs';
import { verifyPath } from '../packages/core/tree.mjs';

const scope = { network: 'local', recordContract: 'local-record', publisher: 'publisher' };
const fields = (createdAtMs, permissionHash, type = 'permission_changed') => ({
  type, agent: 'milo.testnet', counterparty: 'ledger.testnet', caseRef: 'invoice-1042',
  summary: 'Evidence storage regression test', details: { message: 'private' },
  chainRef: null, permissionHash, createdAtMs
});

test('ordinary case evidence stays signed and never enters the sealing queue', async () => {
  const store = new EvidenceStore(':memory:', scope);
  const keys = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  try {
    const ordinary = await store.append('ordinary', { ...fields(1, '0'.repeat(64), 'share_blocked'), sensitive: false }, keys);
    const batcher = new EvidenceBatcher({ store, transport: { tip() { assert.fail('Ordinary case reached the transport'); } } });
    assert.equal(await batcher.tick({ force: true }), null);
    assert.equal(store.snapshot()[0].sealState, 'local');
    const sensitive = await store.append('sensitive', { ...fields(2, '0'.repeat(64)), sensitive: true }, keys);
    assert.deepEqual(store.pendingRecords(), [sensitive]);
    assert.equal(sensitive.record.previousHash, ordinary.recordHash);
  } finally { store.close(); }
});

test('evidence is idempotent, durable, linked across restarts and scoped to one deployment', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'envoi-store-'));
  const path = join(dir, 'evidence.sqlite');
  const keys = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  let store = new EvidenceStore(path, scope);
  try {
    const first = await store.append('event-1', fields(1, '0'.repeat(64)), keys);
    assert.deepEqual(await store.append('event-1', fields(1, '0'.repeat(64)), keys), first);
    await assert.rejects(store.append('event-1', fields(2, '0'.repeat(64)), keys), /reused/);
    store.close();
    store = new EvidenceStore(path, scope);
    const second = await store.append('event-2', fields(2, '0'.repeat(64)), keys);
    assert.equal(second.record.seq, 2);
    assert.equal(second.record.previousHash, first.recordHash);
    assert.throws(() => new EvidenceStore(path, { ...scope, recordContract: 'other' }), /different network/);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a lost seal response is recovered after restart without rebroadcast or premature proof export', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'envoi-batcher-'));
  const path = join(dir, 'evidence.sqlite');
  const ledgerPath = join(dir, 'ledger.sqlite');
  const keys = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  let now = 1000;
  let store = new EvidenceStore(path, scope);
  let adapters = createLocalAdapters(ledgerPath, () => now);
  const permission = { document: { test: 'permission' }, signature: 'test' };
  const permissionHash = await hashJson(permission.document);
  let broadcasts = 0;
  try {
    await store.savePermission(permission);
    await store.append('event-1', fields(now, permissionHash, 'share_blocked'), keys);
    const local = localSealer(adapters.publicRecord);
    const flaky = { ...local, async broadcast(...args) {
      broadcasts++;
      await local.broadcast(...args);
      throw new Error('Response lost after commit');
    } };
    const batcher = new EvidenceBatcher({ store, transport: flaky, clock: () => now });
    const retry = await batcher.tick();
    assert.equal(retry.status, 'retrying');
    await assert.rejects(store.proofFor('event-1', permission, scope), /not been sealed/);
    const savedSubmission = retry.submission;
    store.close();
    adapters.db.close();
    now += 2000;
    store = new EvidenceStore(path, scope);
    adapters = createLocalAdapters(ledgerPath, () => now);
    const resumed = new EvidenceBatcher({ store, transport: localSealer(adapters.publicRecord), clock: () => now });
    const final = await resumed.tick();
    assert.equal(final.status, 'final');
    assert.equal(final.submission, savedSubmission);
    assert.equal(broadcasts, 1);
    const proof = await store.proofFor('event-1', undefined, { network: 'local', contract: 'local-record' });
    assert.deepEqual(proof.permission, permission);
    assert.equal(await verifyPath(proof.recordHash, proof.batch), true);
    assert.equal(await adapters.publicRecord.status(proof.seal.txRef), 'final');
    assert.equal(await resumed.tick(), null);
  } finally { store.close(); adapters.db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('interval batches wait until due and concurrent ticks share one ordered seal', async () => {
  const store = new EvidenceStore(':memory:', scope);
  const adapters = createLocalAdapters();
  let now = 100;
  try {
    const keys = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
    await store.append('event-1', fields(now, '0'.repeat(64)), keys);
    const batcher = new EvidenceBatcher({ store, transport: localSealer(adapters.publicRecord), clock: () => now, intervalMs: 120000 });
    assert.equal(await batcher.tick(), null);
    now += 120000;
    const [first, second] = await Promise.all([batcher.tick(), batcher.tick()]);
    assert.equal(first.id, 1);
    assert.deepEqual(first, second);
    await store.append('event-2', fields(now, '0'.repeat(64), 'pay_refused'), keys);
    const next = await batcher.tick();
    assert.equal(next.id, 2);
    assert.equal(next.previous_root, first.root);
    assert.equal(next.status, 'final');
  } finally { store.close(); adapters.db.close(); }
});

test('a public batch conflict blocks sealing and never marks evidence final', async () => {
  const store = new EvidenceStore(':memory:', scope);
  try {
    const keys = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
    await store.append('event-1', fields(1, '0'.repeat(64), 'pay_refused'), keys);
    let broadcasts = 0;
    const transport = {
      tip: async () => ({ batchId: 0, root: '0'.repeat(64) }),
      prepare: async () => ({ txRef: 'test', signedTransaction: 'durable' }),
      inspect: async () => ({ status: 'conflict', detail: 'A different batch already exists.' }),
      broadcast: async () => { broadcasts++; }
    };
    const batcher = new EvidenceBatcher({ store, transport });
    assert.equal((await batcher.tick()).status, 'blocked');
    assert.equal((await batcher.tick()).status, 'blocked');
    assert.equal(broadcasts, 0);
    await assert.rejects(store.proofFor('event-1', {}, scope), /not been sealed/);
  } finally { store.close(); }
});
