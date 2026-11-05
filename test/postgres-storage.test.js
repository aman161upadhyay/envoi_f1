import test from 'node:test';
import { createConsumerIdentity } from '../src/consumer-identity.js';
import { inspectQueueConsumers } from '../scripts/queue-consumers.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PostgresStore } from '../src/postgres-storage.js';
import { DocumentObjectMetadataStore, ObjectStorageService, PersistentQuotaLedger } from '../src/object-storage.js';
import { PostgresMalwareScanJobStore } from '../src/object-scan-lifecycle.js';
import { assertDeliveryWritesCommitWithSettlement } from './delivery-commit-harness.js';

test('batch document read uses one PostgreSQL statement for visible preference paths', async () => {
  const calls = [];
  const store = {
    query: async (statement, parameters) => {
      calls.push({ statement, parameters });
      return { rows: [{ path: 'prefs/one.json', value: { read: true } }] };
    }
  };
  const result = await PostgresStore.prototype.getJsonBatch.call(store, ['prefs/one.json', 'prefs/two.json']);
  assert.equal(calls.length, 1);
  assert.match(calls[0].statement, /WHERE path = ANY\(\$1::text\[\]\)/);
  assert.deepEqual(calls[0].parameters, [['prefs/one.json', 'prefs/two.json']]);
  assert.deepEqual(result.get('prefs/one.json'), { read: true });
  assert.equal(result.has('prefs/two.json'), false);
});

test('PostgreSQL store preserves atomic and paginated document semantics', { skip: !process.env.DATABASE_URL }, async t => {
  const store = new PostgresStore(process.env.DATABASE_URL);
  t.after(() => store.close());
  await store.init();
  const migrations = await store.pool.query('SELECT name, checksum FROM sinaloa_schema_migrations ORDER BY name');
  assert.deepEqual(migrations.rows.map(row => row.name), ['001_documents.sql', '002_object_storage.sql', '003_delivery.sql', '004_history_indexes.sql']);
  assert.ok(migrations.rows.every(row => /^[a-f0-9]{64}$/.test(row.checksum)));
  const prefix = `test/${crypto.randomUUID()}`;
  const eventInboxId = `inbox_${crypto.randomUUID()}`;
  assert.equal(await store.nextEventSequence(eventInboxId), 1);
  assert.equal(await store.nextEventSequence(eventInboxId), 2);
  await store.putJson(`${prefix}/messages/one.json`, { id: 'one', caseId: 'case-a', createdAt: '2026-01-01T00:00:00.000Z' });
  await store.putJson(`${prefix}/messages/two.json`, { id: 'two', caseId: 'case-a', createdAt: '2026-01-02T00:00:00.000Z' });
  assert.equal((await store.getJson(`${prefix}/messages/one.json`)).id, 'one');
  const batch = await store.getJsonBatch([
    `${prefix}/messages/one.json`, `${prefix}/messages/missing.json`, `${prefix}/messages/two.json`
  ]);
  assert.equal(batch.get(`${prefix}/messages/one.json`).id, 'one');
  assert.equal(batch.get(`${prefix}/messages/two.json`).id, 'two');
  assert.equal(batch.has(`${prefix}/messages/missing.json`), false);
  assert.equal((await store.getJsonBatch([])).size, 0);
  assert.equal(await store.putJsonIfAbsent(`${prefix}/identity.json`, { state: 'reserved' }), true);
  assert.equal(await store.putJsonIfAbsent(`${prefix}/identity.json`, { state: 'overwritten' }), false);
  await store.putJson(`${prefix}/token.json`, { usedAt: null, value: 'secret' });
  assert.equal((await store.claimJson(`${prefix}/token.json`, 'usedAt', '2026-01-03T00:00:00.000Z')).usedAt, '2026-01-03T00:00:00.000Z');
  assert.equal(await store.claimJson(`${prefix}/token.json`, 'usedAt', 'later'), null);
  const outboxId = `delivery_${crypto.randomUUID()}`;
  const outboxCreatedAt = new Date().toISOString();
  const queued = await store.enqueueOutbox([
    { path: `${prefix}/messages/queued.json`, value: { id: 'queued', status: 'queued' } }
  ], { id: outboxId, kind: 'test', messageId: 'queued', senderInboxId: 'sender', recipientInboxId: 'recipient', status: 'queued', attempts: 0, maxAttempts: 2, availableAt: outboxCreatedAt, createdAt: outboxCreatedAt, updatedAt: outboxCreatedAt });
  assert.equal(queued.enqueueCreated, true);
  assert.equal((await store.getJson(`${prefix}/messages/queued.json`)).status, 'queued');
  const claimed = await store.claimOutbox('postgres-test-worker');
  assert.equal(claimed.id, outboxId);
  assert.equal(claimed.status, 'processing');
  await store.completeOutbox(outboxId, [{ path: `${prefix}/messages/queued.json`, value: { id: 'queued', status: 'delivered' } }], { receiptId: 'receipt_1' }, claimed);
  assert.equal((await store.getOutbox(outboxId)).status, 'delivered');
  assert.equal((await store.getJson(`${prefix}/messages/queued.json`)).status, 'delivered');
  const first = await store.queryJson(`${prefix}/messages`, { limit: 1, filters: { caseId: 'case-a' } });
  assert.deepEqual(first.map(item => item.id), ['two']);
  const second = await store.queryJson(`${prefix}/messages`, { limit: 1, before: first[0].createdAt, filters: { caseId: 'case-a' } });
  assert.deepEqual(second.map(item => item.id), ['one']);
  assert.equal(await store.countJson(`${prefix}/messages`, { filters: { caseId: 'case-a' } }), 2);
  await store.putJson(`${prefix}/messages/three.json`, { id: 'three', caseId: 'case-a', createdAt: '2026-01-02T00:00:00.000Z' });
  const compoundFirst = await store.queryJson(`${prefix}/messages`, { limit: 1, filters: { caseId: 'case-a' } });
  const compoundSecond = await store.queryJson(`${prefix}/messages`, { limit: 1, before: { value: compoundFirst[0].createdAt, id: compoundFirst[0].id }, filters: { caseId: 'case-a' } });
  assert.deepEqual(compoundFirst.map(item => item.id), ['two']);
  assert.deepEqual(compoundSecond.map(item => item.id), ['three']);
  assert.equal(await store.deleteJson(`${prefix}/messages/one.json`), true);
  assert.equal(await store.getJson(`${prefix}/messages/one.json`), null);
  await store.putJson(`${prefix}/remove_target/deep/one.json`, { id: 'remove-me' });
  await store.putJson(`${prefix}/remove_target_other/one.json`, { id: 'keep-me' });
  await assert.rejects(() => store.withTransaction([], async () => {
    assert.equal(await store.deleteJsonTree(`${prefix}/remove_target`), 1);
    throw new Error('Rollback removal');
  }), /Rollback removal/);
  assert.equal((await store.getJson(`${prefix}/remove_target/deep/one.json`)).id, 'remove-me');
  assert.equal(await store.deleteJsonTree(`${prefix}/remove_target`), 1);
  assert.equal(await store.getJson(`${prefix}/remove_target/deep/one.json`), null);
  assert.equal((await store.getJson(`${prefix}/remove_target_other/one.json`)).id, 'keep-me');
  const quotaWorkspace = `workspace_${crypto.randomUUID()}`;
  const quotaAttempts = await Promise.allSettled(Array.from({ length: 4 }, () => store.reserveObjectQuota(quotaWorkspace, 6, 10)));
  assert.equal(quotaAttempts.filter(attempt => attempt.status === 'fulfilled').length, 1);
  assert.equal(quotaAttempts.filter(attempt => attempt.status === 'rejected' && attempt.reason.code === 'QUOTA_EXCEEDED').length, 3);
  const firstReservation = quotaAttempts.find(attempt => attempt.status === 'fulfilled').value;
  await store.releaseObjectQuota(firstReservation.id);
  assert.deepEqual(await store.objectQuotaUsage(quotaWorkspace, 10), { workspaceId: quotaWorkspace, used: 0, reserved: 0, quota: 10 });
  const committedReservation = await store.reserveObjectQuota(quotaWorkspace, 6, 10);
  await store.commitObjectQuota(committedReservation.id);
  assert.deepEqual(await store.objectQuotaUsage(quotaWorkspace, 10), { workspaceId: quotaWorkspace, used: 6, reserved: 0, quota: 10 });
  await store.deleteCommittedObjectQuota(committedReservation.id);
  await store.deleteCommittedObjectQuota(committedReservation.id);
  assert.deepEqual(await store.objectQuotaUsage(quotaWorkspace, 10), { workspaceId: quotaWorkspace, used: 0, reserved: 0, quota: 10 });
  const expiredReservation = await store.reserveObjectQuota(quotaWorkspace, 4, 10, 1_000);
  const reclaimed = await store.reclaimExpiredObjectQuota(new Date(new Date(expiredReservation.expiresAt).getTime() + 1));
  assert.deepEqual(reclaimed, { releasedReservations: 1, releasedBytes: 4 });
  await assert.rejects(() => store.commitObjectQuota(expiredReservation.id), error => error.code === 'QUOTA_RESERVATION_EXPIRED');
  const unreapedReservation = await store.reserveObjectQuota(quotaWorkspace, 4, 10, 1_000);
  await store.pool.query('UPDATE sinaloa_object_quota_reservations SET expires_at = NOW() - INTERVAL \'1 second\' WHERE id = $1', [unreapedReservation.id]);
  await assert.rejects(() => store.commitObjectQuota(unreapedReservation.id), error => error.code === 'QUOTA_RESERVATION_EXPIRED');
  assert.deepEqual(await store.objectQuotaUsage(quotaWorkspace, 10), { workspaceId: quotaWorkspace, used: 0, reserved: 0, quota: 10 });
});

test('PostgreSQL transaction locks preserve both mutations and rollback all writes', { skip: !process.env.DATABASE_URL }, async t => {
  const store = new PostgresStore(process.env.DATABASE_URL);
  t.after(() => store.close());
  await store.init();
  const relative = `test/${crypto.randomUUID()}/transaction.json`;
  await store.putJson(relative, { count: 0 });
  await Promise.all(Array.from({ length: 8 }, () => store.withTransaction([relative], async () => {
    const current = await store.getJson(relative);
    await store.withTransaction([relative], () => store.putJson(relative, { count: current.count + 1 }));
  })));
  assert.equal((await store.getJson(relative)).count, 8);
  await assert.rejects(() => store.withTransaction([relative], async () => {
    await store.putJson(relative, { count: 99 });
    await store.putJsonBatch([{ path: `test/${crypto.randomUUID()}/extra.json`, value: { extra: true } }]);
    throw new Error('abort');
  }), /abort/);
  assert.equal((await store.getJson(relative)).count, 8);
});

test('PostgreSQL delivery lease rejects stale document writes', { skip: !process.env.DATABASE_URL }, async t => {
  const store = new PostgresStore(process.env.DATABASE_URL);
  t.after(() => store.close());
  await store.init();
  const id = `delivery_${crypto.randomUUID()}`;
  const prefix = `test/${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();
  await store.enqueueOutbox([], { id, kind: 'test', status: 'queued', attempts: 0, maxAttempts: 2, availableAt: createdAt, createdAt, updatedAt: createdAt });
  const original = await store.claimOutbox('worker_one');
  await store.pool.query("UPDATE sinaloa_outbox SET locked_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [id]);
  const replacement = await store.claimOutbox('worker_two', 1_000);
  assert.notEqual(original.leaseToken, replacement.leaseToken);
  await assert.rejects(() => store.completeOutbox(id, [{ path: `${prefix}/stale.json`, value: { stale: true } }], {}, original), error => error.code === 'LEASE_LOST');
  assert.equal(await store.getJson(`${prefix}/stale.json`), null);
  await store.completeOutbox(id, [{ path: `${prefix}/current.json`, value: { current: true } }], {}, replacement);
  assert.deepEqual(await store.getJson(`${prefix}/current.json`), { current: true });
});

// http-wake v1 §6.5: the recipient wake written while delivering commits with the settlement or not at all.
test('PostgreSQL delivery writes commit only with the settlement', { skip: !process.env.DATABASE_URL }, async t => {
  const store = new PostgresStore(process.env.DATABASE_URL);
  t.after(() => store.close());
  await store.init();
  await assertDeliveryWritesCommitWithSettlement(store, {
    expireLease: record => store.pool.query("UPDATE sinaloa_outbox SET locked_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [record.id])
  });
});

async function createHeldOutboxFixture(t) {
  const store = new PostgresStore(process.env.DATABASE_URL);
  const run = crypto.randomUUID();
  const created = [];
  t.after(async () => {
    try { await store.pool.query('DELETE FROM sinaloa_outbox WHERE id = ANY($1::text[])', [created]); }
    finally { await store.close(); }
  });
  await store.init();
  const past = '2026-01-01T00:00:00.000Z';
  const name = value => `${value}_${run}`;
  const enqueue = async (id, { sender = 'sender', key = 'case_one', availableAt = past } = {}) => {
    created.push(name(id));
    return store.enqueueOutbox([], { id: name(id), kind: 'test', messageId: name(id), senderInboxId: name(sender), recipientInboxId: name('recipient'), orderingKey: name(key), status: 'queued', attempts: 0, maxAttempts: 5, availableAt, createdAt: availableAt, updatedAt: availableAt });
  };
  return { store, past, name, enqueue, prefix: `test/${run}` };
}

const heldFieldsOf = value => [value.heldReason, value.heldAt, value.heldFromStatus];

test('PostgreSQL outbox hold keeps attempts and requires the current lease', { skip: !process.env.DATABASE_URL }, async t => {
  const { store, past, name, enqueue, prefix } = await createHeldOutboxFixture(t);
  await enqueue('first');
  const claimed = await store.claimOutbox('worker_one');
  assert.equal(claimed.id, name('first'));
  await assert.rejects(() => store.holdOutbox(name('first'), [{ path: `${prefix}/stale.json`, value: { stale: true } }], { reason: 'sender_paused', lease: { ...claimed, leaseToken: 'wrong' } }), error => error.code === 'LEASE_LOST' && error.statusCode === 409);
  assert.equal(await store.getJson(`${prefix}/stale.json`), null);
  const held = await store.holdOutbox(name('first'), [{ path: `${prefix}/held.json`, value: { status: 'held' } }], { reason: 'sender_paused', lease: claimed });
  assert.equal(held.status, 'held');
  assert.equal(held.attempts, 0);
  assert.equal(held.availableAt, past);
  assert.equal(held.heldReason, 'sender_paused');
  assert.equal(held.heldFromStatus, 'queued');
  assert.ok(!Number.isNaN(Date.parse(held.heldAt)));
  assert.equal(held.lockedAt, null);
  assert.equal(held.lockedBy, null);
  assert.equal(held.leaseToken, null);
  assert.deepEqual(await store.getJson(`${prefix}/held.json`), { status: 'held' });

  await enqueue('second', { key: 'case_two' });
  const firstAttempt = await store.claimOutbox('worker_one');
  assert.equal(firstAttempt.id, name('second'));
  await store.failOutbox(name('second'), [], { error: 'timeout', nextAttemptAt: past, lease: firstAttempt });
  const secondAttempt = await store.claimOutbox('worker_one');
  assert.equal(secondAttempt.id, name('second'));
  const heldRetry = await store.holdOutbox(name('second'), [], { reason: 'sender_paused', lease: secondAttempt });
  assert.equal(heldRetry.attempts, 1);
  assert.equal(heldRetry.heldFromStatus, 'retrying');
  assert.equal(heldRetry.lastError, 'timeout');
  assert.equal(await store.claimOutbox('worker_one', 0), null);
});

test('PostgreSQL held outbox records block their case until released in sequence order', { skip: !process.env.DATABASE_URL }, async t => {
  const { store, past, name, enqueue } = await createHeldOutboxFixture(t);
  await enqueue('processing', { key: 'case_processing' });
  const processing = await store.claimOutbox('worker_one');
  assert.equal(processing.id, name('processing'));
  await enqueue('first');
  const attempt = await store.claimOutbox('worker_one');
  assert.equal(attempt.id, name('first'));
  await store.failOutbox(name('first'), [], { error: 'timeout', nextAttemptAt: past, lease: attempt });
  await enqueue('second');
  await enqueue('reply', { sender: 'active' });
  await enqueue('other', { sender: 'active', key: 'case_two' });

  const heldAt = '2026-02-01T00:00:00.000Z';
  const held = await store.holdQueuedOutbox({ senderInboxId: name('sender'), reason: 'sender_paused', heldAt });
  assert.deepEqual(held.map(value => [value.id, value.heldFromStatus, value.attempts]), [[name('first'), 'retrying', 1], [name('second'), 'queued', 0]]);
  assert.ok(held.every(value => value.status === 'held' && value.heldReason === 'sender_paused' && value.heldAt === heldAt));
  assert.equal((await store.getOutbox(name('processing'))).status, 'processing');
  assert.equal((await store.getOutbox(name('reply'))).status, 'queued');
  assert.deepEqual((await store.queryOutbox({ senderInboxId: name('sender'), status: 'held' })).map(value => value.id).sort(), [name('first'), name('second')].sort());
  assert.deepEqual((await store.queryOutbox({ orderingKey: name('case_one') })).map(value => value.id).sort(), [name('first'), name('second'), name('reply')].sort());
  assert.deepEqual((await store.queryOutbox({ orderingKey: name('case_one'), senderInboxId: name('active') })).map(value => value.id), [name('reply')]);

  const other = await store.claimOutbox('worker_one');
  assert.equal(other.id, name('other'));
  await store.completeOutbox(name('other'), [], {}, other);
  await store.completeOutbox(name('processing'), [], {}, processing);
  assert.equal(await store.claimOutbox('worker_one'), null);

  const released = await store.releaseHeldOutbox({ senderInboxId: name('sender') });
  assert.deepEqual(released.map(value => [value.id, value.status, value.attempts]), [[name('first'), 'retrying', 1], [name('second'), 'queued', 0]]);
  assert.ok(released.every(value => value.availableAt === past && heldFieldsOf(value).every(field => field === undefined)));
  assert.deepEqual(await store.releaseHeldOutbox({ senderInboxId: name('sender') }), []);
  const delivered = [];
  for (let claimed = await store.claimOutbox('worker_one'); claimed; claimed = await store.claimOutbox('worker_one')) {
    delivered.push(claimed.id);
    await store.completeOutbox(claimed.id, [], {}, claimed);
  }
  assert.deepEqual(delivered, [name('first'), name('second'), name('reply')]);
});

test('PostgreSQL cancelling a held outbox record releases its case barrier', { skip: !process.env.DATABASE_URL }, async t => {
  const { store, name, enqueue, prefix } = await createHeldOutboxFixture(t);
  await enqueue('paused');
  await enqueue('reply', { sender: 'active' });
  await store.holdQueuedOutbox({ senderInboxId: name('sender'), reason: 'sender_paused' });
  assert.equal(await store.cancelHeldOutbox(name('reply'), [{ path: `${prefix}/reply.json`, value: { status: 'cancelled' } }]), null);
  assert.equal(await store.getJson(`${prefix}/reply.json`), null);
  assert.equal((await store.getOutbox(name('reply'))).status, 'queued');
  assert.equal(await store.claimOutbox('worker_one'), null);

  const cancelled = await store.cancelHeldOutbox(name('paused'), [{ path: `${prefix}/paused.json`, value: { status: 'cancelled' } }]);
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(!Number.isNaN(Date.parse(cancelled.cancelledAt)));
  assert.ok(heldFieldsOf(cancelled).every(field => field === undefined));
  assert.deepEqual(await store.getJson(`${prefix}/paused.json`), { status: 'cancelled' });
  assert.equal(await store.cancelHeldOutbox(name('paused')), null);
  const claimed = await store.claimOutbox('worker_one');
  assert.equal(claimed.id, name('reply'));
  await store.completeOutbox(name('reply'), [], {}, claimed);
});

test('PostgreSQL scan lease fences stale verdicts and settles metadata with its job', { skip: !process.env.DATABASE_URL }, async t => {
  const store = new PostgresStore(process.env.DATABASE_URL);
  t.after(() => store.close());
  await store.init();
  const metadata = new DocumentObjectMetadataStore(store);
  const jobs = new PostgresMalwareScanJobStore(store);
  const objectId = `obj_${crypto.randomUUID()}`;
  const inboxId = `inbox_${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();
  await metadata.create({ id: objectId, workspaceId: inboxId, state: 'quarantine', key: `test/${objectId}`, reservationId: `quota_${objectId}`, createdAt });
  const jobId = `scan_${objectId}`;
  await jobs.enqueue({ id: jobId, objectId, status: 'queued', attempts: 0, availableAt: createdAt, createdAt, updatedAt: createdAt });
  const original = await jobs.claim(jobId, 'same-worker', 1_000);
  await store.query("UPDATE sinaloa_documents SET value = value || jsonb_build_object('leaseExpiresAt', (NOW() - INTERVAL '1 second')::text) WHERE path = $1", [`object-storage/scan-jobs/${jobId}.json`]);
  const replacement = await jobs.claim(jobId, 'same-worker', 1_000);
  assert.notEqual(original.leaseToken, replacement.leaseToken);
  const verdict = { state: 'clean', scannedAt: createdAt, result: { status: 'clean' } };
  const outcome = { status: 'clean', completedAt: createdAt };
  await assert.rejects(() => jobs.settleProcessing(original, 'same-worker', outcome, metadata, verdict), error => error.code === 'SCAN_LEASE_LOST');
  assert.equal((await metadata.get(objectId)).state, 'quarantine');
  const rejectedMetadata = { store, updateScan: async () => { throw new Error('metadata write failed'); } };
  await assert.rejects(() => jobs.settleProcessing(replacement, 'same-worker', outcome, rejectedMetadata, verdict), /metadata write failed/);
  assert.equal((await jobs.get(jobId)).status, 'processing');
  await jobs.settleProcessing(replacement, 'same-worker', outcome, metadata, verdict);
  assert.equal((await metadata.get(objectId)).state, 'clean');
  assert.equal((await store.getJson(`inboxes/${inboxId}/assets/${objectId}.json`)).state, 'clean');
  assert.equal((await jobs.get(jobId)).status, 'clean');
});

test('PostgreSQL quota settlement cannot deadlock a workspace reaper', { skip: !process.env.DATABASE_URL }, async t => {
  const reaper = new PostgresStore(process.env.DATABASE_URL);
  const settler = new PostgresStore(process.env.DATABASE_URL);
  t.after(async () => { await reaper.close(); await settler.close(); });
  await reaper.init();
  const workspaceId = `workspace_${crypto.randomUUID()}`;
  const reservation = await reaper.reserveObjectQuota(workspaceId, 4, 10);
  let settlement;
  try {
    await reaper.withTransaction([], async () => {
      // Pause reaping after its workspace lock but before its reservation lock.
      await reaper.query('SELECT workspace_id FROM sinaloa_object_quota_usage WHERE workspace_id = $1 FOR UPDATE', [workspaceId]);
      let reportPid;
      const pidReady = new Promise(resolve => { reportPid = resolve; });
      settlement = settler.withTransaction([], async () => {
        const result = await settler.query('SELECT pg_backend_pid() AS pid');
        reportPid(result.rows[0].pid);
        return settler.releaseObjectQuota(reservation.id);
      });
      // Attach a rejection handler while the competing transaction is blocked.
      settlement.catch(() => {});
      const pid = await pidReady;
      let waiting = false;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const locks = await reaper.query('SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted', [pid]);
        if (locks.rowCount) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(waiting, true, 'settlement should wait for the workspace lock');
      // With inverted lock order the settler already holds this row, so NOWAIT
      // raises 55P03; real reaping without NOWAIT would deadlock instead.
      await reaper.query('SELECT id FROM sinaloa_object_quota_reservations WHERE id = $1 FOR UPDATE NOWAIT', [reservation.id]);
      await reaper.reclaimExpiredObjectQuota(new Date(Date.now() + 3_600_000));
    });
  } finally { if (settlement) await settlement; }
  assert.deepEqual(await reaper.objectQuotaUsage(workspaceId, 10), { workspaceId, used: 0, reserved: 0, quota: 10 });
});

test('PostgreSQL retained upload quota survives generic reaping and is released only after sealed cleanup', { skip: !process.env.DATABASE_URL }, async t => {
  const store = new PostgresStore(process.env.DATABASE_URL);
  t.after(() => store.close());
  await store.init();
  const workspaceId = `workspace_${crypto.randomUUID()}`;
  const ledger = new PersistentQuotaLedger(store, { defaultQuotaBytes: 10, reservationTtlMs: 1000 });
  const held = await ledger.reserve(workspaceId, 8);
  assert.equal(held.expiresAt, null);
  await ledger.reclaimExpired(new Date(Date.now() + 86_400_000));
  assert.equal((await ledger.usage(workspaceId)).reserved, 8);
  await assert.rejects(() => ledger.reserve(workspaceId, 3), { code: 'QUOTA_EXCEEDED' });
  await ledger.release(held.id);
  let now = new Date();
  let failSeal = true;
  const calls = [];
  const adapter = {
    createPresignedUpload: async () => ({ url: 'https://objects.example.test/upload', method: 'PUT', headers: {} }),
    createPresignedDownload: async () => ({ url: 'https://objects.example.test/download' }),
    headObject: async () => null, getObject: async () => null,
    deleteObject: async () => { calls.push('delete'); },
    sealDeletedObject: async () => { calls.push('seal'); if (failSeal) throw new Error('Race conflict'); return true; }
  };
  const metadataStore = new DocumentObjectMetadataStore(store);
  const service = new ObjectStorageService({ adapter, metadataStore, quotaLedger: ledger, scanner: { scan: async () => ({ status: 'clean' }) }, uploadUrlTtlSeconds: 1, uploadCleanupGraceMs: 0, uploadCleanupRetryMs: 1, clock: () => now });
  const started = await service.beginUpload({ workspaceId, filename: 'test.txt', mimeType: 'text/plain', size: 8, checksumSha256: crypto.createHash('sha256').update('12345678').digest('base64') });
  now = new Date(now.getTime() + 1001);
  const due = await metadataStore.listUploadCleanupCandidates(now, 1);
  assert.equal(due.length, 1);
  assert.equal(due[0].id, started.object.id);
  assert.deepEqual(await service.reapExpiredUploads({ now }), { processed: 1, deleted: 0, deferred: 1 });
  assert.equal((await ledger.usage(workspaceId)).reserved, 8);
  assert.equal((await metadataStore.get(started.object.id)).state, 'upload-cleanup-pending');
  failSeal = false; now = new Date(now.getTime() + 2);
  assert.deepEqual(await service.reapExpiredUploads({ now }), { processed: 1, deleted: 1, deferred: 0 });
  assert.equal((await ledger.usage(workspaceId)).reserved, 0);
  assert.equal((await metadataStore.get(started.object.id)).state, 'deleted');
  assert.deepEqual(calls, ['delete', 'seal', 'delete', 'seal']);
  await assert.rejects(() => service.completeUpload(started.object.id), { code: 'UPLOAD_REJECTED' });
});


test('PostgreSQL reports the stamped consumer identity on its actual session', { skip: !process.env.DATABASE_URL }, async t => {
  const identity = createConsumerIdentity({ connectionString: process.env.DATABASE_URL, releaseSha: 'a'.repeat(40) });
  const store = new PostgresStore(process.env.DATABASE_URL, { applicationName: identity.applicationName });
  t.after(() => store.close());
  await store.init();
  const result = await store.pool.query("SELECT application_name FROM pg_stat_activity WHERE pid = pg_backend_pid()");
  assert.equal(result.rows[0].application_name, identity.applicationName);
  const client = await store.pool.connect();
  try {
    const inventory = await inspectQueueConsumers(client);
    assert.ok(Array.isArray(inventory.connections));
    assert.ok(Array.isArray(inventory.leases));
    assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'off');
  } finally { client.release(); }
});
