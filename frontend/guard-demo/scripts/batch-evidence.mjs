import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { EvidenceStore } from '../apps/server/evidence-store.mjs';
import { EvidenceBatcher } from '../apps/server/evidence-batcher.mjs';
import { testnetSealer } from '../apps/server/testnet-sealer.mjs';
import { createRpc, DEFAULT_RPC } from '../adapters/near/rpc.mjs';
import { nearReaders } from '../adapters/near/read.mjs';
import { loadScopedKey } from '../adapters/near/key-file.mjs';
import { validAccount } from '../packages/core/policy.mjs';

const env = process.env;
const publisher = env.NEAR_PUBLISHER_ACCOUNT;
const recordContract = env.NEAR_RECORD_CONTRACT;
if (![publisher, recordContract].every(account => validAccount(account) && account.endsWith('.testnet'))) {
  throw new Error('Configure the testnet publisher and record contract.');
}
const rpcUrl = env.NEAR_RPC_URL || DEFAULT_RPC['near-testnet'];
const rpc = createRpc(rpcUrl);
if ((await rpc('status', [])).chain_id !== 'testnet') throw new Error('Testnet required.');
const readers = nearReaders({ rpcUrl, recordContract, publisher });
const contract = await readers.publicRecord.describeContract();
if (!env.NEAR_RECORD_CODE_HASH || contract.codeHash !== env.NEAR_RECORD_CODE_HASH) {
  throw new Error('The record contract does not match the published hash.');
}
const keys = await loadScopedKey(env.NEAR_PUBLISHER_PRIVATE_KEY, env.NEAR_PUBLISHER_PUBLIC_KEY);
const path = env.NEAR_EVIDENCE_DB || 'data/evidence.sqlite';
await mkdir(dirname(path), { recursive: true });
const store = new EvidenceStore(path, { network: 'near-testnet', recordContract, publisher });
const batcher = new EvidenceBatcher({
  store, transport: testnetSealer({ rpc, keys, publisher, recordContract, publicRecord: readers.publicRecord }),
  intervalMs: env.DEMO_MODE === '1' ? 120000 : 600000
});
let timer;
let stopped = false;
async function stop() {
  if (stopped) return;
  stopped = true;
  clearInterval(timer);
  try { await batcher.running; } finally { store.close(); }
}
async function tick() {
  try {
    const batch = await batcher.tick({ force: process.argv.includes('--force') });
    console.log(batch ? 'Batch ' + batch.id + ': ' + batch.status + (batch.error ? ' - ' + batch.error : '') : 'No batch due.');
    if (batch?.status === 'blocked' || process.argv.includes('--once') && batch && batch.status !== 'final') process.exitCode = 2;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
await tick();
if (process.argv.includes('--once')) await stop();
else {
  timer = setInterval(() => { if (!stopped) void tick(); }, 30000);
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
}
