#!/usr/bin/env node
// envoi-verify <proof.json> [--json] [--local-store <file>] [--rpc-testnet <url>] [--rpc-mainnet <url>]
// Exit codes: 0 genuine, 1 can't be trusted, 2 not fully checked (network) or not sealed yet, 3 bad file or usage.
import fs from 'node:fs';
import { checkProof } from '../src/check.js';
import { createNearReader } from '../src/near-reader.js';

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const asJson = args.includes('--json') ? (args.splice(args.indexOf('--json'), 1), true) : false;
const localStore = flag('--local-store');
const rpcTestnet = flag('--rpc-testnet');
const rpcMainnet = flag('--rpc-mainnet');
const file = args[0];

if (!file) {
  console.error('usage: envoi-verify <proof.json> [--json] [--local-store <file>] [--rpc-testnet <url>] [--rpc-mainnet <url>]');
  process.exit(3);
}

let proof;
try { proof = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { proof = null; }

const readers = {
  'near-testnet': createNearReader({ network: 'near-testnet', ...(rpcTestnet && { rpcUrl: rpcTestnet }) }),
  'near-mainnet': createNearReader({ network: 'near-mainnet', ...(rpcMainnet && { rpcUrl: rpcMainnet }) }),
};
if (localStore) {
  const state = JSON.parse(fs.readFileSync(localStore, 'utf8'));
  readers.local = {
    network: 'local',
    rootOf: (_c, batchId) => state.roots?.[String(batchId)] ?? null,
    keysOf: (_c, keyRef) => (state.keys ?? []).filter(k => k.key_ref === keyRef),
    last: () => [state.lastBatchId, state.lastRoot],
  };
}

const result = await checkProof(proof, { readers });
if (asJson) console.log(JSON.stringify(result, null, 2));
else {
  const icon = { ok: '✓', fail: '✗', warn: '!', pending: '…', note: '·' };
  for (const c of result.checks) console.log(`${icon[c.status] ?? '?'} ${c.message}${c.explorerUrl ? `  ${c.explorerUrl}` : ''}`);
  console.log('-'.repeat(60));
  console.log(result.message);
}
process.exit({ genuine: 0, untrusted: 1, incomplete: 2, pending: 2, bad_file: 3 }[result.verdict] ?? 3);
