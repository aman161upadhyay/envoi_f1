import { setTimeout } from 'node:timers/promises';
import { FileStore } from '../src/storage.js';
import { createCaseTraceSealer } from '../src/case-trace-sealer.js';
import { createRpc, DEFAULT_RPC } from '../frontend/guard-demo/adapters/near/rpc.mjs';
import { nearReaders } from '../frontend/guard-demo/adapters/near/read.mjs';
import { loadScopedKey } from '../frontend/guard-demo/adapters/near/key-file.mjs';
import { validAccount } from '../frontend/guard-demo/packages/core/policy.mjs';
import { testnetSealer } from '../frontend/guard-demo/apps/server/testnet-sealer.mjs';

const env = process.env;
const publisher = env.NEAR_PUBLISHER_ACCOUNT;
const recordContract = env.NEAR_RECORD_CONTRACT;
if (![publisher, recordContract].every(account => validAccount(account) && account.endsWith('.testnet'))
  || publisher === recordContract || env.NEAR_ENABLE_CASE_TRACE_SEALS !== 'yes') {
  throw new Error('Configure separate testnet publisher and record accounts and enable case trace sealing.');
}
if (!env.DATABASE_URL && !(env.ENVOI_DATA_DIR && process.argv.includes('--offline-file-store') && process.argv.includes('--once'))) {
  throw new Error('Set DATABASE_URL or use --once --offline-file-store with ENVOI_DATA_DIR and the server stopped.');
}
const network = 'near-testnet';
const rpcUrl = env.NEAR_RPC_URL || DEFAULT_RPC[network];
const rpc = createRpc(rpcUrl);
if ((await rpc('status', [])).chain_id !== 'testnet') throw new Error('Testnet required.');
const { publicRecord } = nearReaders({ rpcUrl, recordContract, publisher });
const { codeHash } = await publicRecord.describeContract();
if (!env.NEAR_RECORD_CODE_HASH || codeHash !== env.NEAR_RECORD_CODE_HASH) {
  throw new Error('The trace record contract does not match the configured code hash.');
}
const keys = await loadScopedKey(env.NEAR_PUBLISHER_PRIVATE_KEY, env.NEAR_PUBLISHER_PUBLIC_KEY);
const store = env.DATABASE_URL
  ? new (await import('../src/postgres-storage.js')).PostgresStore(env.DATABASE_URL, { applicationName: 'envoi-case-trace-sealer' })
  : new FileStore(env.ENVOI_DATA_DIR);
const sealNext = createCaseTraceSealer({ store, transport: testnetSealer({ rpc, keys, publisher, recordContract, publicRecord }),
  scope: { network, recordContract, publisher, codeHash } });
const stopping = new AbortController();
process.once('SIGINT', () => stopping.abort());
process.once('SIGTERM', () => stopping.abort());
try {
  do {
    try {
      const result = await sealNext();
      console.log(result ? `Case trace batch ${result.batchId} is ${result.status}.` : 'No case traces are queued.');
      if (result?.status === 'blocked' || process.argv.includes('--once') && result?.status === 'pending') {
        process.exitCode = 2;
        break;
      }
    } catch {
      console.error('The case trace seal could not be confirmed. The queue was retained.');
      if (process.argv.includes('--once')) {
        process.exitCode = 1;
        break;
      }
    }
    if (process.argv.includes('--once') || stopping.signal.aborted) break;
    await setTimeout(30_000, undefined, { signal: stopping.signal }).catch(error => {
      if (error.name !== 'AbortError') throw error;
    });
  } while (!stopping.signal.aborted);
} finally {
  await store.close?.();
}
