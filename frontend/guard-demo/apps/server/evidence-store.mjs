import { DatabaseSync } from 'node:sqlite';
import { hashJson, canonical } from '../../packages/core/crypto.mjs';
import { makeEvidence } from '../../packages/core/evidence.mjs';
import { buildTree, ZERO_ROOT } from '../../packages/core/tree.mjs';

export class EvidenceStore {
  constructor(path, scope) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS evidence_scope (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evidence_permissions (hash TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evidence_records (
        seq INTEGER PRIMARY KEY, event_id TEXT UNIQUE NOT NULL, intent_hash TEXT NOT NULL,
        hash TEXT UNIQUE NOT NULL, payload TEXT NOT NULL, batch_id INTEGER
      );
      CREATE TABLE IF NOT EXISTS evidence_batches (
        id INTEGER PRIMARY KEY, root TEXT NOT NULL, previous_root TEXT NOT NULL,
        count INTEGER NOT NULL, status TEXT NOT NULL, submission TEXT,
        tx_ref TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0, error TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_evidence_batch ON evidence_batches ((1)) WHERE status != 'final';
    `);
    const binding = canonical(scope);
    this.db.prepare('INSERT OR IGNORE INTO evidence_scope VALUES (1, ?)').run(binding);
    if (this.db.prepare('SELECT value FROM evidence_scope WHERE id=1').get().value !== binding) {
      this.db.close();
      throw new Error('This evidence database belongs to a different network or contract.');
    }
  }
  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async savePermission(permission) {
    const hash = await hashJson(permission.document);
    const payload = canonical(permission);
    this.db.prepare('INSERT OR IGNORE INTO evidence_permissions VALUES (?,?)').run(hash, payload);
    if (this.db.prepare('SELECT payload FROM evidence_permissions WHERE hash=?').get(hash).payload !== payload) {
      throw new Error('This permission hash already has a different signature envelope.');
    }
    return hash;
  }
  record(eventId) {
    return this.db.prepare('SELECT * FROM evidence_records WHERE event_id=?').get(eventId);
  }
  records(batchId) {
    const rows = batchId === undefined
      ? this.db.prepare('SELECT payload FROM evidence_records ORDER BY seq').all()
      : this.db.prepare('SELECT payload FROM evidence_records WHERE batch_id=? ORDER BY seq').all(batchId);
    return rows.map(row => JSON.parse(row.payload));
  }
  async append(eventId, fields, keys, keyId = 'ev-1') {
    if (typeof eventId !== 'string' || !eventId.length) throw new Error('A durable event ID is required.');
    const intentHash = await hashJson({ fields, keyId });
    for (let attempt = 0; attempt < 8; attempt++) {
      const existing = this.record(eventId);
      if (existing) {
        if (existing.intent_hash !== intentHash) throw new Error('This event ID was reused for different evidence.');
        return JSON.parse(existing.payload);
      }
      const tip = this.db.prepare('SELECT seq, hash FROM evidence_records ORDER BY seq DESC LIMIT 1').get();
      const seq = (tip?.seq ?? 0) + 1;
      const entry = await makeEvidence({ ...fields, seq, previousHash: tip?.hash ?? ZERO_ROOT }, keys);
      entry.envoi.keyId = keyId;
      const hash = entry.recordHash;
      const stored = this.transaction(() => {
        if (this.record(eventId)) return false;
        const latest = this.db.prepare('SELECT seq FROM evidence_records ORDER BY seq DESC LIMIT 1').get();
        if ((latest?.seq ?? 0) !== seq - 1) return false;
        this.db.prepare('INSERT INTO evidence_records(seq,event_id,intent_hash,hash,payload) VALUES (?,?,?,?,?)')
          .run(seq, eventId, intentHash, hash, JSON.stringify(entry));
        return true;
      });
      if (stored) return entry;
    }
    throw new Error('Concurrent evidence writes prevented this append. Retry with the same event ID.');
  }
  activeBatch() {
    return this.db.prepare("SELECT * FROM evidence_batches WHERE status != 'final'").get();
  }
  pendingRecords() {
    return this.db.prepare('SELECT payload FROM evidence_records WHERE batch_id IS NULL ORDER BY seq')
      .all().map(row => JSON.parse(row.payload));
  }
  reserveBatch(entries, tree, tip) {
    return this.transaction(() => {
      const active = this.activeBatch();
      if (active) return active;
      const previous = this.db.prepare("SELECT * FROM evidence_batches WHERE status='final' ORDER BY id DESC LIMIT 1").get();
      if (previous && (previous.id !== tip.batchId || previous.root !== tip.root)) {
        throw new Error('The public record moved outside this evidence database. Reconcile it before sealing.');
      }
      const id = tip.batchId + 1;
      this.db.prepare("INSERT INTO evidence_batches(id,root,previous_root,count,status) VALUES (?,?,?,?,'prepared')")
        .run(id, tree.root, tip.root, entries.length);
      for (const entry of entries) {
        const result = this.db.prepare('UPDATE evidence_records SET batch_id=? WHERE seq=? AND hash=? AND batch_id IS NULL')
          .run(id, entry.record.seq, entry.recordHash);
        if (result.changes !== 1) throw new Error('An evidence record was already assigned to another batch.');
      }
      return this.activeBatch();
    });
  }
  saveSubmission(id, submission) {
    this.db.prepare("UPDATE evidence_batches SET submission=?,status='submitted' WHERE id=? AND submission IS NULL")
      .run(JSON.stringify(submission), id);
    return JSON.parse(this.db.prepare('SELECT submission FROM evidence_batches WHERE id=?').get(id).submission);
  }
  block(id, detail) {
    this.db.prepare("UPDATE evidence_batches SET status='blocked',error=? WHERE id=?").run(detail, id);
  }
  markFinal(id, txRef) {
    if (typeof txRef !== 'string' || !txRef) throw new Error('A finalized transaction reference is required.');
    this.db.prepare("UPDATE evidence_batches SET status='final',tx_ref=?,error=NULL,next_attempt=0 WHERE id=?").run(txRef, id);
  }
  retry(id, now, error) {
    const row = this.db.prepare('SELECT attempts FROM evidence_batches WHERE id=?').get(id);
    const delay = Math.min(300000, 1000 * 2 ** Math.min(row.attempts, 8));
    this.db.prepare("UPDATE evidence_batches SET status='retrying',attempts=attempts+1,next_attempt=?,error=? WHERE id=?")
      .run(now + delay, String(error).slice(0, 500), id);
  }
  snapshot() {
    return this.db.prepare(`SELECT r.event_id,r.payload,b.status FROM evidence_records r
      LEFT JOIN evidence_batches b ON b.id=r.batch_id ORDER BY r.seq`).all().map(row => ({
        ...JSON.parse(row.payload), eventId: row.event_id, sealState: row.status ?? 'waiting'
      }));
  }
  async proofFor(eventId, permission, seal) {
    const row = this.record(eventId);
    if (!row?.batch_id) throw new Error('This record has not been sealed.');
    const batch = this.db.prepare('SELECT * FROM evidence_batches WHERE id=?').get(row.batch_id);
    if (batch.status !== 'final') throw new Error('This record has not been sealed.');
    const entries = this.records(batch.id);
    const tree = await buildTree(entries.map(entry => entry.recordHash));
    if (tree.root !== batch.root) throw new Error('Stored batch content failed its integrity check.');
    const entry = JSON.parse(row.payload);
    if (!permission) {
      const saved = this.db.prepare('SELECT payload FROM evidence_permissions WHERE hash=?').get(entry.record.permissionHash);
      if (!saved) throw new Error('The signed permission for this record is unavailable.');
      permission = JSON.parse(saved.payload);
    }
    if (await hashJson(permission.document) !== entry.record.permissionHash) {
      throw new Error('The permission document does not match this record.');
    }
    const leafIndex = entries.findIndex(value => value.record.seq === row.seq);
    return {
      format: 'envoi.proof/v1', ...entry, permission,
      batch: { batchId: batch.id, root: batch.root, previousRoot: batch.previous_root,
        count: batch.count, leafIndex, siblings: tree.path(leafIndex) },
      seal: { network: seal.network, contract: seal.contract, txRef: batch.tx_ref },
      ...(entry.record.chainRef ? { chainEvent: { ...entry.record.chainRef, contract: seal.spendContract } } : {})
    };
  }
  close() { this.db.close(); }
}
