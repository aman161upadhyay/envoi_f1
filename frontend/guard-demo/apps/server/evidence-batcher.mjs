import { buildTree } from '../../packages/core/tree.mjs';

const urgent = new Set(['pay_refused', 'share_blocked', 'screen_flagged']);

export class EvidenceBatcher {
  constructor({ store, transport, clock = Date.now, intervalMs = 600000 }) {
    this.store = store;
    this.transport = transport;
    this.clock = clock;
    this.intervalMs = intervalMs;
    this.running = null;
  }
  tick({ force = false } = {}) {
    if (this.running) return this.running;
    this.running = this.flush(force).finally(() => { this.running = null; });
    return this.running;
  }
  async flush(force) {
    let batch = this.store.activeBatch();
    if (!batch) {
      const entries = this.store.pendingRecords();
      if (!entries.length) return null;
      const due = this.clock() - entries[0].record.createdAtMs >= this.intervalMs;
      if (!force && !due && !entries.some(entry => urgent.has(entry.record.type))) return null;
      const tree = await buildTree(entries.map(entry => entry.recordHash));
      const tip = await this.transport.tip();
      batch = this.store.reserveBatch(entries, tree, tip);
    }
    if (batch.status === 'blocked' || batch.next_attempt > this.clock()) return batch;
    let submission = batch.submission ? JSON.parse(batch.submission) : null;
    try {
      if (!submission) submission = this.store.saveSubmission(batch.id, await this.transport.prepare(batch));
      // Recover a completed broadcast first. Reuse the same signed transaction on retries.
      let state = await this.transport.inspect(submission, batch);
      if (state.status === 'missing') {
        await this.transport.broadcast(submission, batch);
        state = await this.transport.inspect(submission, batch);
      }
      if (state.status === 'conflict' || state.status === 'failed') {
        this.store.block(batch.id, state.detail);
        return this.store.activeBatch();
      }
      if (state.status === 'final') this.store.markFinal(batch.id, state.txRef);
      else throw new Error(state.detail || 'Seal is awaiting a final public confirmation.');
    } catch (error) {
      if (error.permanentSealFailure && submission) {
        try {
          const recovered = await this.transport.inspect(submission, batch);
          if (recovered.status === 'final') this.store.markFinal(batch.id, recovered.txRef);
          else this.store.block(batch.id, 'The signed seal transaction expired. Reconcile the public record before preparing a replacement.');
        } catch { this.store.retry(batch.id, this.clock(), 'Could not reconcile an expired seal transaction.'); }
      } else this.store.retry(batch.id, this.clock(), error.message);
    }
    return this.store.db.prepare('SELECT * FROM evidence_batches WHERE id=?').get(batch.id);
  }
}
