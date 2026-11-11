import path from 'node:path';
import { buildTree } from '../frontend/guard-demo/packages/core/tree.mjs';
import { valueDigest } from './policy-engine.js';
import { traceQueue, traceQueuePath, traceSealPath } from './case-trace.js';

const activePath = path.join('case-trace', 'active.json');
const scopePath = path.join('case-trace', 'network.json');
const lock = ['case-trace:seal'];

export function createCaseTraceSealer({ store, transport, scope }) {
  async function prepare() {
    return store.withTransaction(lock, async () => {
      const configured = await store.getJson(scopePath);
      if (configured && valueDigest(configured) !== valueDigest(scope)) {
        throw new Error('The trace queue is bound to a different record contract.');
      }
      const active = await store.getJson(activePath);
      if (active) return active;
      const entries = await store.queryJson(traceQueue, { limit: 50, order: 'asc' });
      if (!entries.length) return null;
      const tip = await transport.tip();
      const tree = await buildTree(entries.map(entry => entry.digest));
      const batch = { id: tip.batchId + 1, root: tree.root, previous_root: tip.root, count: entries.length };
      const submission = await transport.prepare(batch);
      const reserved = { entries, batch, submission };
      await store.putJsonBatch([{ path: scopePath, value: scope }, { path: activePath, value: reserved }]);
      return reserved;
    });
  }

  async function complete(active, state) {
    return store.withTransaction(lock, async () => {
      const current = await store.getJson(activePath);
      if (current?.batch.id !== active.batch.id || current.batch.root !== active.batch.root) return null;
      if (state.status !== 'final') {
        await store.putJson(activePath, { ...current, blocked: true });
        return { status: 'blocked', batchId: active.batch.id };
      }
      const seal = { ...scope, status: 'final', batchId: active.batch.id, root: active.batch.root,
        previousRoot: active.batch.previous_root, count: active.batch.count, txRef: state.txRef };
      const tree = await buildTree(active.entries.map(entry => entry.digest));
      await store.putJsonBatch(active.entries.map((entry, leafIndex) => ({
        path: traceSealPath(entry.id), value: { ...seal, leafIndex, siblings: tree.path(leafIndex) }
      })));
      for (const entry of active.entries) await store.deleteJson(traceQueuePath(entry.id));
      await store.deleteJson(activePath);
      return seal;
    });
  }

  return async function sealNext() {
    const active = await prepare();
    if (!active || active.blocked) return active?.blocked ? { status: 'blocked', batchId: active.batch.id } : null;
    let state = await transport.inspect(active.submission, active.batch);
    if (state.status === 'missing') {
      try {
        await transport.broadcast(active.submission, active.batch);
      } catch (error) {
        if (!error.permanentSealFailure) throw error;
        state = await transport.inspect(active.submission, active.batch);
        return complete(active, state);
      }
      state = await transport.inspect(active.submission, active.batch);
    }
    if (state.status === 'final' || state.status === 'failed' || state.status === 'conflict') return complete(active, state);
    return { status: 'pending', batchId: active.batch.id };
  };
}
