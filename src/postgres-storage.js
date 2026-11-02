import pg from 'pg';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { runMigrations } from './migrations.js';
import { createPostgresOptions } from './postgres-options.js';
import { normalizeDocumentPath } from './path-safety.js';
import { DEPLOYMENT_IDENTITY_PATH } from './deployment-identity.js';

const { Pool } = pg;
const likePrefix = relative => `${normalizeDocumentPath(relative).replace(/[\\%_]/g, value => `\\${value}`)}/%`;
const addHistoryScope = (relativeDir, values, conditions) => {
  const segments = normalizeDocumentPath(relativeDir).split('/');
  if (segments.length !== 3 || segments[0] !== 'inboxes') return;
  values.push(segments[1], segments[2]);
  conditions.push("path LIKE 'inboxes/%'");
  // Match the partial cursor index predicate explicitly, including prepared plans.
  if (segments[2] === 'events') conditions.push("path LIKE 'inboxes/%/events/%'");
  conditions.push(`split_part(path, '/', 2) = $${values.length - 1}`);
  conditions.push(`split_part(path, '/', 3) = $${values.length}`);
};

export class PostgresStore {
  constructor(connectionString, options = {}) { this.pool = new Pool(createPostgresOptions(connectionString, process.env, options)); this.transactionContext = new AsyncLocalStorage(); }
  query(statement, values) {
    const current = this.transactionContext.getStore();
    if (current && !current.active) throw new Error('Transaction is no longer active');
    return (current?.client ?? this.pool).query(statement, values);
  }
  async withTransaction(keys, operation, { lockWaitMs = null } = {}) {
    if (!Array.isArray(keys) || keys.some(key => typeof key !== 'string' || !key || key.length > 512) || typeof operation !== 'function') throw new TypeError('Transaction keys and callback are required');
    const orderedKeys = [...new Set(keys)].sort();
    const current = this.transactionContext.getStore();
    if (current) {
      if (!current.active) throw new Error('Transaction is no longer active');
      if (orderedKeys.some(key => !current.keys.has(key))) throw new Error('Nested transaction cannot acquire additional keys');
      return operation();
    }
    let timer;
    let abandoned = false;
    const deadline = lockWaitMs == null ? null : Date.now() + lockWaitMs;
    const checkAcquisitionDeadline = () => {
      if (deadline != null && Date.now() >= deadline) throw Object.assign(new Error('Transaction lock wait expired'), { code: 'LOCK_TIMEOUT' });
    };
    const connection = this.pool.connect();
    connection.then(client => { if (abandoned) client.release(); }, () => {});
    let client;
    try {
      client = await (lockWaitMs == null ? connection : Promise.race([connection, new Promise((_, reject) => {
        timer = setTimeout(() => { abandoned = true; reject(Object.assign(new Error('Transaction lock wait expired'), { code: 'LOCK_TIMEOUT' })); }, lockWaitMs);
      })]));
    } finally { clearTimeout(timer); }
    const context = { client, keys: new Set(orderedKeys), active: true };
    let active = false;
    try {
      checkAcquisitionDeadline();
      await client.query('BEGIN');
      active = true;
      for (const key of orderedKeys) {
        if (deadline != null) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw Object.assign(new Error('Transaction lock wait expired'), { code: 'LOCK_TIMEOUT' });
          await client.query("SELECT set_config('lock_timeout', $1, true)", [`${remaining}ms`]);
        }
        checkAcquisitionDeadline();
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
      }
      // A successful database reply can arrive after the shared acquisition budget.
      checkAcquisitionDeadline();
      const result = await this.transactionContext.run(context, operation);
      await client.query('COMMIT');
      active = false;
      context.active = false;
      return result;
    } catch (error) {
      if (active) await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      context.active = false;
      client.release();
    }
  }
  async transactional(operation) {
    const current = this.transactionContext.getStore();
    if (current) {
      if (!current.active) throw new Error('Transaction is no longer active');
      return operation(current.client);
    }
    return this.withTransaction([], () => operation(this.transactionContext.getStore().client));
  }
  async init() {
    await runMigrations(this.pool);
  }
  async ensureInbox() {}
  async nextEventSequence(inboxId) {
    const result = await this.query(`INSERT INTO sinaloa_event_sequences(inbox_id, value) VALUES($1, 1)
      ON CONFLICT(inbox_id) DO UPDATE SET value = sinaloa_event_sequences.value + 1 RETURNING value`, [inboxId]);
    return Number(result.rows[0].value);
  }
  async putJson(relative, value) { await this.query('INSERT INTO sinaloa_documents(path, value) VALUES($1, $2) ON CONFLICT(path) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()', [normalizeDocumentPath(relative), value]); }
  async writeDocuments(client, documents) {
    for (const document of documents) {
      await client.query('INSERT INTO sinaloa_documents(path, value) VALUES($1, $2) ON CONFLICT(path) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()', [normalizeDocumentPath(document.path), document.value]);
    }
  }
  async putJsonBatch(documents) { return this.transactional(client => this.writeDocuments(client, documents)); }
  rowToOutbox(row) {
    if (!row) return null;
    return {
      ...row.value,
      status: row.status,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      availableAt: new Date(row.available_at).toISOString(),
      lockedAt: row.locked_at ? new Date(row.locked_at).toISOString() : null,
      lockedBy: row.locked_by,
      lastError: row.last_error,
      deliveredAt: row.delivered_at ? new Date(row.delivered_at).toISOString() : null,
      deadLetteredAt: row.dead_lettered_at ? new Date(row.dead_lettered_at).toISOString() : null,
      sequence: Number(row.delivery_sequence),
      updatedAt: new Date(row.updated_at).toISOString(),
      createdAt: new Date(row.created_at).toISOString()
    };
  }
  async enqueueOutbox(documents, record) {
    return this.transactional(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [record.id]);
      const existing = await client.query('SELECT * FROM sinaloa_outbox WHERE id = $1', [record.id]);
      if (existing.rowCount) return { ...this.rowToOutbox(existing.rows[0]), enqueueCreated: false };
      await this.writeDocuments(client, documents);
      const result = await client.query(`INSERT INTO sinaloa_outbox(id, value, status, attempts, max_attempts, available_at, created_at, updated_at)
        VALUES($1, $2, $3, $4, $5, $6, $7, $7) RETURNING *`, [record.id, record, record.status, record.attempts || 0, record.maxAttempts || 5, record.availableAt, record.createdAt]);
      return { ...this.rowToOutbox(result.rows[0]), enqueueCreated: true };
    });
  }
  async getOutbox(id) { const result = await this.query('SELECT * FROM sinaloa_outbox WHERE id = $1', [id]); return this.rowToOutbox(result.rows[0]); }
  async queryOutbox({ inboxId = null, status = null, orderingKey = null, senderInboxId = null, limit = 100 } = {}) {
    const values = [];
    const conditions = [];
    if (inboxId) { values.push(inboxId); conditions.push(`(value->>'senderInboxId' = $${values.length} OR value->>'recipientInboxId' = $${values.length})`); }
    if (status) { values.push(status); conditions.push(`status = $${values.length}`); }
    if (orderingKey) { values.push(orderingKey); conditions.push(`value->>'orderingKey' = $${values.length}`); }
    if (senderInboxId) { values.push(senderInboxId); conditions.push(`value->>'senderInboxId' = $${values.length}`); }
    values.push(Math.max(1, Math.min(Number(limit) || 100, 200)));
    const result = await this.query(`SELECT * FROM sinaloa_outbox ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT $${values.length}`, values);
    return result.rows.map(row => this.rowToOutbox(row));
  }
  // With deploymentEnvironment, nothing is claimed unless the database is stamped for that
  // deployment, checked in the same statement (src/deployment-identity.js).
  async claimOutbox(workerId, leaseMs = 30_000, { deploymentEnvironment = null } = {}) {
    const leaseToken = crypto.randomUUID();
    const values = [workerId, leaseMs, leaseToken];
    let identityCondition = '';
    if (deploymentEnvironment) {
      values.push(DEPLOYMENT_IDENTITY_PATH, deploymentEnvironment);
      identityCondition = `AND EXISTS (SELECT 1 FROM sinaloa_documents AS identity WHERE identity.path = $4 AND identity.value->>'environment' = $5)`;
    }
    const result = await this.query(`WITH candidate AS (
      SELECT pending.id FROM sinaloa_outbox AS pending
      WHERE ((pending.status IN ('queued', 'retrying') AND pending.available_at <= NOW())
        OR (pending.status = 'processing' AND pending.locked_at <= NOW() - ($2::bigint * INTERVAL '1 millisecond')))
      AND NOT EXISTS (
        SELECT 1 FROM sinaloa_outbox AS earlier
        WHERE earlier.id <> pending.id
          AND earlier.value->>'orderingKey' = pending.value->>'orderingKey'
          AND earlier.status NOT IN ('delivered', 'deadLettered', 'cancelled')
          AND earlier.delivery_sequence < pending.delivery_sequence
      )
      ${identityCondition}
      ORDER BY pending.available_at, pending.delivery_sequence
      FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE sinaloa_outbox AS outbox
    SET status = 'processing', locked_at = NOW(), locked_by = $1, updated_at = NOW(), value = value || jsonb_build_object('leaseToken', $3::text)
    FROM candidate WHERE outbox.id = candidate.id RETURNING outbox.*`, values);
    return this.rowToOutbox(result.rows[0]);
  }
  async assertOutboxLease(client, id, lease) {
    const result = await client.query('SELECT * FROM sinaloa_outbox WHERE id = $1 FOR UPDATE', [id]);
    const record = this.rowToOutbox(result.rows[0]);
    if (!record || record.status !== 'processing' || !lease?.leaseToken || record.leaseToken !== lease.leaseToken || record.lockedBy !== lease.lockedBy) {
      throw Object.assign(new Error('Delivery lease was lost'), { code: 'LEASE_LOST', statusCode: 409 });
    }
  }
  async completeOutbox(id, documents, resultValue = {}, lease = null) {
    return this.transactional(async client => {
      await this.assertOutboxLease(client, id, lease);
      await this.writeDocuments(client, documents);
      const result = await client.query(`UPDATE sinaloa_outbox SET status = 'delivered', delivered_at = NOW(), updated_at = NOW(), locked_at = NULL, locked_by = NULL, last_error = NULL, value = value || $2::jsonb WHERE id = $1 RETURNING *`, [id, JSON.stringify({ result: resultValue, leaseToken: null })]);
      return this.rowToOutbox(result.rows[0]);
    });
  }
  async failOutbox(id, documents, { error, nextAttemptAt, forceDeadLetter = false, lease = null }) {
    return this.transactional(async client => {
      await this.assertOutboxLease(client, id, lease);
      await this.writeDocuments(client, documents);
      const result = await client.query(`UPDATE sinaloa_outbox SET
        attempts = attempts + 1,
        status = CASE WHEN $4 OR attempts + 1 >= max_attempts THEN 'deadLettered' ELSE 'retrying' END,
        available_at = CASE WHEN $4 OR attempts + 1 >= max_attempts THEN available_at ELSE $3 END,
        dead_lettered_at = CASE WHEN $4 OR attempts + 1 >= max_attempts THEN NOW() ELSE NULL END,
        updated_at = NOW(), locked_at = NULL, locked_by = NULL, last_error = $2, value = value || jsonb_build_object('leaseToken', NULL::text)
        WHERE id = $1 RETURNING *`, [id, error, nextAttemptAt, forceDeadLetter]);
      return this.rowToOutbox(result.rows[0]);
    });
  }
  async retryOutbox(id, documents = []) {
    return this.transactional(async client => {
      const current = await client.query("SELECT id FROM sinaloa_outbox WHERE id = $1 AND status = 'deadLettered' FOR UPDATE", [id]);
      if (!current.rowCount) return null;
      await this.writeDocuments(client, documents);
      const result = await client.query(`UPDATE sinaloa_outbox SET status = 'queued', attempts = 0, available_at = NOW(), updated_at = NOW(), locked_at = NULL, locked_by = NULL, last_error = NULL, dead_lettered_at = NULL, value = value || jsonb_build_object('leaseToken', NULL::text) WHERE id = $1 RETURNING *`, [id]);
      return this.rowToOutbox(result.rows[0]);
    });
  }
  bySequence(records) { return records.sort((a, b) => a.sequence - b.sequence); }
  async holdOutbox(id, documents, { reason, lease = null }) {
    return this.transactional(async client => {
      await this.assertOutboxLease(client, id, lease);
      await this.writeDocuments(client, documents);
      const result = await client.query(`UPDATE sinaloa_outbox SET
        status = 'held', updated_at = NOW(), locked_at = NULL, locked_by = NULL,
        value = value || jsonb_build_object('leaseToken', NULL::text, 'heldReason', $2::text, 'heldAt', $3::text,
          'heldFromStatus', CASE WHEN attempts > 0 THEN 'retrying' ELSE 'queued' END)
        WHERE id = $1 RETURNING *`, [id, reason, new Date().toISOString()]);
      return this.rowToOutbox(result.rows[0]);
    });
  }
  async holdQueuedOutbox({ senderInboxId, reason, heldAt = null }) {
    if (!senderInboxId) throw new TypeError('senderInboxId is required');
    return this.transactional(async client => {
      const locked = await client.query(`SELECT id FROM sinaloa_outbox
        WHERE value->>'senderInboxId' = $1 AND status IN ('queued', 'retrying') ORDER BY delivery_sequence FOR UPDATE`, [senderInboxId]);
      if (!locked.rowCount) return [];
      const result = await client.query(`UPDATE sinaloa_outbox SET
        status = 'held', updated_at = NOW(),
        value = value || jsonb_build_object('heldReason', $2::text, 'heldAt', $3::text, 'heldFromStatus', status)
        WHERE id = ANY($1::text[]) AND status IN ('queued', 'retrying') RETURNING *`, [locked.rows.map(row => row.id), reason, heldAt ?? new Date().toISOString()]);
      return this.bySequence(result.rows.map(row => this.rowToOutbox(row)));
    });
  }
  async releaseHeldOutbox({ senderInboxId }) {
    if (!senderInboxId) throw new TypeError('senderInboxId is required');
    return this.transactional(async client => {
      const locked = await client.query(`SELECT id FROM sinaloa_outbox
        WHERE value->>'senderInboxId' = $1 AND status = 'held' ORDER BY delivery_sequence FOR UPDATE`, [senderInboxId]);
      if (!locked.rowCount) return [];
      const result = await client.query(`UPDATE sinaloa_outbox SET
        status = COALESCE(NULLIF(value->>'heldFromStatus', ''), 'queued'), updated_at = NOW(),
        value = value - 'heldReason' - 'heldAt' - 'heldFromStatus'
        WHERE id = ANY($1::text[]) AND status = 'held' RETURNING *`, [locked.rows.map(row => row.id)]);
      return this.bySequence(result.rows.map(row => this.rowToOutbox(row)));
    });
  }
  async cancelHeldOutbox(id, documents = []) {
    return this.transactional(async client => {
      const current = await client.query("SELECT id FROM sinaloa_outbox WHERE id = $1 AND status = 'held' FOR UPDATE", [id]);
      if (!current.rowCount) return null;
      await this.writeDocuments(client, documents);
      const result = await client.query(`UPDATE sinaloa_outbox SET status = 'cancelled', updated_at = NOW(),
        value = (value - 'heldReason' - 'heldAt' - 'heldFromStatus') || jsonb_build_object('cancelledAt', $2::text)
        WHERE id = $1 RETURNING *`, [id, new Date().toISOString()]);
      return this.rowToOutbox(result.rows[0]);
    });
  }
  async reserveObjectQuota(workspaceId, bytes, quotaBytes, reservationTtlMs = 1_200_000, { retainUntilCleanup = false } = {}) {
    return this.transactional(async client => {
      await client.query(`INSERT INTO sinaloa_object_quota_usage(workspace_id, quota_bytes) VALUES($1, $2)
        ON CONFLICT(workspace_id) DO UPDATE SET quota_bytes = EXCLUDED.quota_bytes, updated_at = NOW()`, [workspaceId, quotaBytes]);
      const usage = await client.query('SELECT * FROM sinaloa_object_quota_usage WHERE workspace_id = $1 FOR UPDATE', [workspaceId]);
      const row = usage.rows[0];
      const expired = await client.query(`UPDATE sinaloa_object_quota_reservations SET status = 'released', updated_at = NOW()
        WHERE workspace_id = $1 AND status = 'reserved' AND expires_at IS NOT NULL AND expires_at <= NOW() RETURNING bytes`, [workspaceId]);
      const expiredBytes = expired.rows.reduce((total, value) => total + Number(value.bytes), 0);
      if (expiredBytes) await client.query('UPDATE sinaloa_object_quota_usage SET reserved_bytes = GREATEST(0, reserved_bytes - $2), updated_at = NOW() WHERE workspace_id = $1', [workspaceId, expiredBytes]);
      const activeReserved = Number(row.reserved_bytes) - expiredBytes;
      if (Number(row.used_bytes) + activeReserved + bytes > quotaBytes) throw Object.assign(new Error('Workspace object quota exceeded'), { code: 'QUOTA_EXCEEDED', statusCode: 413 });
      const createdAt = new Date();
      const reservation = { id: `quota_${crypto.randomUUID()}`, workspaceId, bytes, state: 'reserved', createdAt: createdAt.toISOString(), expiresAt: retainUntilCleanup ? null : new Date(createdAt.getTime() + reservationTtlMs).toISOString() };
      await client.query('UPDATE sinaloa_object_quota_usage SET reserved_bytes = reserved_bytes + $2, updated_at = NOW() WHERE workspace_id = $1', [workspaceId, bytes]);
      await client.query('INSERT INTO sinaloa_object_quota_reservations(id, workspace_id, bytes, status, created_at, expires_at, updated_at) VALUES($1, $2, $3, $4, $5, $6, $5)', [reservation.id, workspaceId, bytes, reservation.state, reservation.createdAt, reservation.expiresAt]);
      return reservation;
    });
  }
  async lockObjectQuotaReservation(client, reservationId) {
    const lookup = await client.query('SELECT workspace_id FROM sinaloa_object_quota_reservations WHERE id = $1', [reservationId]);
    if (!lookup.rowCount) throw Object.assign(new Error('Unknown object quota reservation'), { code: 'UNKNOWN_RESERVATION', statusCode: 400 });
    // Reserve/reaping acquire the workspace usage row first. Follow that same
    // order before locking the reservation, and re-read its state under lock.
    await client.query('SELECT workspace_id FROM sinaloa_object_quota_usage WHERE workspace_id = $1 FOR UPDATE', [lookup.rows[0].workspace_id]);
    const result = await client.query('SELECT * FROM sinaloa_object_quota_reservations WHERE id = $1 FOR UPDATE', [reservationId]);
    if (!result.rowCount) throw Object.assign(new Error('Unknown object quota reservation'), { code: 'UNKNOWN_RESERVATION', statusCode: 400 });
    return result.rows[0];
  }
  async settleObjectQuota(reservationId, commit) {
    const settlement = await this.transactional(async client => {
      const reservation = await this.lockObjectQuotaReservation(client, reservationId);
      const expired = reservation.status === 'reserved' && reservation.expires_at && new Date(reservation.expires_at) <= new Date();
      if (reservation.status === 'reserved') {
        await client.query(`UPDATE sinaloa_object_quota_usage SET reserved_bytes = GREATEST(0, reserved_bytes - $2), used_bytes = used_bytes + $3, updated_at = NOW() WHERE workspace_id = $1`, [reservation.workspace_id, Number(reservation.bytes), commit && !expired ? Number(reservation.bytes) : 0]);
        await client.query('UPDATE sinaloa_object_quota_reservations SET status = $2, updated_at = NOW() WHERE id = $1', [reservationId, expired ? 'released' : commit ? 'committed' : 'released']);
        reservation.status = expired ? 'released' : commit ? 'committed' : 'released';
      }
      return { expired: Boolean(expired), reservation: { id: reservation.id, workspaceId: reservation.workspace_id, bytes: Number(reservation.bytes), state: reservation.status, createdAt: new Date(reservation.created_at).toISOString() } };
    });
    if (commit && settlement.reservation.state === 'released') throw Object.assign(new Error('Object quota reservation has expired'), { code: 'QUOTA_RESERVATION_EXPIRED', statusCode: 409 });
    return settlement.reservation;
  }
  commitObjectQuota(reservationId) { return this.settleObjectQuota(reservationId, true); }
  releaseObjectQuota(reservationId) { return this.settleObjectQuota(reservationId, false); }
  async deleteCommittedObjectQuota(reservationId) {
    return this.transactional(async client => {
      const reservation = await this.lockObjectQuotaReservation(client, reservationId);
      if (reservation.status === 'committed') {
        await client.query('UPDATE sinaloa_object_quota_usage SET used_bytes = GREATEST(0, used_bytes - $2), updated_at = NOW() WHERE workspace_id = $1', [reservation.workspace_id, Number(reservation.bytes)]);
        await client.query("UPDATE sinaloa_object_quota_reservations SET status = 'released', updated_at = NOW() WHERE id = $1", [reservationId]);
        reservation.status = 'released';
      } else if (reservation.status !== 'released') {
        throw Object.assign(new Error('Object quota is not committed'), { code: 'QUOTA_NOT_COMMITTED', statusCode: 409 });
      }
      return { id: reservation.id, workspaceId: reservation.workspace_id, bytes: Number(reservation.bytes), state: reservation.status, createdAt: new Date(reservation.created_at).toISOString() };
    });
  }
  async reclaimExpiredObjectQuota(now = new Date()) {
    return this.transactional(async client => {
      const workspaces = await client.query(`SELECT DISTINCT workspace_id FROM sinaloa_object_quota_reservations
        WHERE status = 'reserved' AND expires_at IS NOT NULL AND expires_at <= $1 ORDER BY workspace_id`, [now]);
      let releasedReservations = 0;
      let releasedBytes = 0;
      for (const { workspace_id: workspaceId } of workspaces.rows) {
        await client.query('SELECT workspace_id FROM sinaloa_object_quota_usage WHERE workspace_id = $1 FOR UPDATE', [workspaceId]);
        const expired = await client.query(`UPDATE sinaloa_object_quota_reservations SET status = 'released', updated_at = NOW()
          WHERE workspace_id = $1 AND status = 'reserved' AND expires_at IS NOT NULL AND expires_at <= $2 RETURNING bytes`, [workspaceId, now]);
        const bytes = expired.rows.reduce((total, value) => total + Number(value.bytes), 0);
        if (bytes) await client.query('UPDATE sinaloa_object_quota_usage SET reserved_bytes = GREATEST(0, reserved_bytes - $2), updated_at = NOW() WHERE workspace_id = $1', [workspaceId, bytes]);
        releasedReservations += expired.rowCount;
        releasedBytes += bytes;
      }
      return { releasedReservations, releasedBytes };
    });
  }
  async objectQuotaUsage(workspaceId, quotaBytes) {
    const result = await this.query('SELECT * FROM sinaloa_object_quota_usage WHERE workspace_id = $1', [workspaceId]);
    const row = result.rows[0];
    return row ? { workspaceId, used: Number(row.used_bytes), reserved: Number(row.reserved_bytes), quota: Number(row.quota_bytes) } : { workspaceId, used: 0, reserved: 0, quota: quotaBytes };
  }
  async putJsonIfAbsent(relative, value) { const result = await this.query('INSERT INTO sinaloa_documents(path, value) VALUES($1, $2) ON CONFLICT(path) DO NOTHING RETURNING path', [normalizeDocumentPath(relative), value]); return result.rowCount === 1; }
  // Atomic read-modify-write in its own transaction, never a caller's: `update` returns the next
  // value, or null to leave the document alone. Resolves to the stored value afterwards, or null
  // when `guard.valid` rejects the guard document, which is read FOR SHARE so a concurrent change
  // to it is serialized with this write. Never await it inside a transaction: it would hold a
  // second pool connection.
  async updateJson(relative, update, { guard = null } = {}) {
    const key = normalizeDocumentPath(relative);
    return this.transactionContext.exit(() => this.transactional(async client => {
      if (guard) {
        const guarded = (await client.query('SELECT value FROM sinaloa_documents WHERE path = $1 FOR SHARE', [normalizeDocumentPath(guard.path)])).rows[0]?.value ?? null;
        if (!guard.valid(guarded)) return null;
      }
      // A concurrent first insert makes ON CONFLICT wait, then the second pass locks the new row.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const current = (await client.query('SELECT value FROM sinaloa_documents WHERE path = $1 FOR UPDATE', [key])).rows[0]?.value ?? null;
        const next = update(current);
        if (!next) return current;
        if (current) {
          await client.query('UPDATE sinaloa_documents SET value = $2, updated_at = NOW() WHERE path = $1', [key, next]);
          return next;
        }
        const inserted = await client.query('INSERT INTO sinaloa_documents(path, value) VALUES($1, $2) ON CONFLICT(path) DO NOTHING RETURNING path', [key, next]);
        if (inserted.rowCount === 1) return next;
      }
      throw new Error('Document update conflicted');
    }));
  }
  async claimJson(relative, field, value) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(field)) throw new Error('Invalid claim field');
    const result = await this.query(`UPDATE sinaloa_documents SET value = jsonb_set(value, $2, to_jsonb($3::text)), updated_at = NOW() WHERE path = $1 AND (value->>$4) IS NULL RETURNING value`, [normalizeDocumentPath(relative), `{${field}}`, value, field]);
    return result.rows[0]?.value ?? null;
  }
  async getJson(relative, fallback = null) { const result = await this.query('SELECT value FROM sinaloa_documents WHERE path = $1', [normalizeDocumentPath(relative)]); return result.rows[0]?.value ?? fallback; }
  async deleteJson(relative) { const result = await this.query('DELETE FROM sinaloa_documents WHERE path = $1', [normalizeDocumentPath(relative)]); return result.rowCount === 1; }
  async deleteJsonTree(relativeDir) { const result = await this.query("DELETE FROM sinaloa_documents WHERE path LIKE $1 ESCAPE E'\\\\'", [likePrefix(relativeDir)]); return result.rowCount; }
  // The path of the first document under relativeDir, at any depth, in path order; null when there is none.
  async firstJsonPath(relativeDir) { const result = await this.query("SELECT path FROM sinaloa_documents WHERE path LIKE $1 ESCAPE E'\\\\' ORDER BY path LIMIT 1", [likePrefix(relativeDir)]); return result.rows[0]?.path ?? null; }
  async listJson(relativeDir) { const result = await this.query("SELECT value FROM sinaloa_documents WHERE path LIKE $1 ESCAPE E'\\\\' ORDER BY path", [likePrefix(relativeDir)]); return result.rows.filter((row) => row.value && typeof row.value === 'object' && !Array.isArray(row.value)).map((row) => row.value); }
  async countJson(relativeDir, { filters = {} } = {}) {
    const values = [likePrefix(relativeDir)];
    const conditions = ["path LIKE $1 ESCAPE E'\\\\'"];
    addHistoryScope(relativeDir, values, conditions);
    for (const [key, value] of Object.entries(filters)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)) throw new Error('Invalid filter field');
      values.push(key, String(value));
      conditions.push(`value->>$${values.length - 1} = $${values.length}`);
    }
    const result = await this.query(`SELECT COUNT(*)::bigint AS count FROM sinaloa_documents WHERE ${conditions.join(' AND ')}`, values);
    return Number(result.rows[0].count);
  }
  async queryJson(relativeDir, { limit = 100, before = null, after = null, filters = {}, sortField = 'createdAt', order = 'desc' } = {}) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(sortField)) throw new Error('Invalid sort field');
    if (!['asc', 'desc'].includes(order) || (before && after)) throw new TypeError('Invalid query cursor or order');
    const values = [likePrefix(relativeDir)];
    const conditions = ["path LIKE $1 ESCAPE E'\\\\'"];
    addHistoryScope(relativeDir, values, conditions);
    const sortExpression = `COALESCE(value->>'${sortField}', '')`;
    for (const [key, value] of Object.entries(filters)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)) throw new Error('Invalid filter field');
      values.push(key, String(value));
      conditions.push(`value->>$${values.length - 1} = $${values.length}`);
    }
    const cursor = before || after;
    const comparator = after ? '>' : '<';
    if (cursor && typeof cursor === 'object') {
      if (typeof cursor.value !== 'string' || typeof cursor.id !== 'string') throw new TypeError('Invalid compound cursor');
      values.push(cursor.value, cursor.id);
      conditions.push(`(${sortExpression}, COALESCE(value->>'id', '')) ${comparator} ($${values.length - 1}::text, $${values.length}::text)`);
    } else if (cursor) {
      values.push(String(cursor));
      conditions.push(`${sortExpression} ${comparator} $${values.length}`);
    }
    values.push(Math.max(1, Math.min(Number(limit) || 100, 200)));
    const direction = order.toUpperCase();
    const result = await this.query(`SELECT value FROM sinaloa_documents WHERE ${conditions.join(' AND ')} ORDER BY ${sortExpression} ${direction}, COALESCE(value->>'id', '') ${direction} LIMIT $${values.length}`, values);
    return result.rows.map(row => row.value);
  }
  id(prefix) { return `${prefix}_${crypto.randomUUID()}`; }
  now() { return new Date().toISOString(); }
  async close() { await this.pool.end(); }
}
