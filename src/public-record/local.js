// `local` public record: a fake chain for development and CI. It enforces the same rules as
// contracts/near/envoi-record (strict batch order, root chaining, append-only keys) so the
// shared adapter suite proves both behave alike. Optional JSON file persistence lets the CLI
// checker read what the server wrote.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { assertKeyInput, assertSealInput } from './validate.js';

const nowNs = () => (BigInt(Date.now()) * 1_000_000n).toString();

const emptyState = () => ({ lastBatchId: 0, lastRoot: null, roots: {}, keys: [], txs: {} });

const load = path => {
  if (!path || !fs.existsSync(path)) return emptyState();
  return { ...emptyState(), ...JSON.parse(fs.readFileSync(path, 'utf8')) };
};

export const createLocalPublicRecord = ({ path = null, contractId = 'local.envoi', finalityDelayMs = 0 } = {}) => {
  let state = load(path);
  let failuresRemaining = 0;
  const save = () => { if (path) fs.writeFileSync(path, JSON.stringify(state, null, 2)); };
  const refresh = () => { if (path) state = load(path); };
  const newTx = () => {
    const txRef = `local-${crypto.randomBytes(16).toString('hex')}`;
    state.txs[txRef] = { submittedAt: Date.now() };
    return txRef;
  };
  const maybeFail = () => {
    if (failuresRemaining > 0) { failuresRemaining -= 1; throw new Error('local public record: simulated outage'); }
  };

  const rootOf = (_contractId, batchId) => { refresh(); return state.roots[String(batchId)] ?? null; };
  const keysOf = (_contractId, keyRef) => { refresh(); return state.keys.filter(k => k.key_ref === keyRef); };
  const last = () => { refresh(); return [state.lastBatchId, state.lastRoot]; };

  return {
    network: 'local',
    contractId,
    async publish(input) {
      assertSealInput(input);
      maybeFail();
      refresh();
      if (input.batchId !== state.lastBatchId + 1) throw new Error('out of order');
      if ((input.previousRoot ?? null) !== state.lastRoot) throw new Error('bad link');
      state.roots[String(input.batchId)] = { root: input.root, previous_root: input.previousRoot ?? null, count: input.count, block_ts: nowNs() };
      state.lastBatchId = input.batchId;
      state.lastRoot = input.root;
      const txRef = newTx();
      save();
      return { network: 'local', contractId, txRef };
    },
    async registerKey(input) {
      assertKeyInput(input);
      maybeFail();
      refresh();
      if (state.keys.some(k => k.key_ref === input.keyRef && k.fingerprint === input.fingerprint)) throw new Error('key already listed');
      state.keys.push({ kind: input.kind, key_ref: input.keyRef, key_id: input.keyId, fingerprint: input.fingerprint, alg: input.alg, prev_sig_ref: input.prevSigRef ?? null, block_ts: nowNs() });
      const txRef = newTx();
      save();
      return { network: 'local', contractId, txRef };
    },
    async status(txRef) {
      refresh();
      const tx = state.txs[txRef];
      if (!tx) return { status: 'failed', error: 'unknown transaction' };
      if (Date.now() - tx.submittedAt < finalityDelayMs) return { status: 'submitted' };
      return { status: 'final', finalAt: new Date(tx.submittedAt + finalityDelayMs) };
    },
    async readRoot(batchId) {
      const r = rootOf(contractId, batchId);
      return r && { root: r.root, previousRoot: r.previous_root, count: r.count, sealedAt: new Date(Number(BigInt(r.block_ts) / 1_000_000n)) };
    },
    reader: () => ({ network: 'local', rootOf, keysOf, last }),
    async health() { return { ok: failuresRemaining === 0, detail: path ? `file ${path}` : 'memory' }; },
    // Test hooks.
    simulateOutage(times = 1) { failuresRemaining = times; },
  };
};
