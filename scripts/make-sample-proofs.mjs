#!/usr/bin/env node
// Writes sample proofs for judges and docs:
//   samples/proofs/genuine-blocked-share.json   passes every check
//   samples/proofs/tampered-summary.json        one word edited, fails "changed after it was recorded"
//   samples/proofs/local-record.json            the local public record they were sealed on
// Usage: node scripts/make-sample-proofs.mjs [--network local|near-testnet|near-mainnet]
// For NEAR networks the publisher env vars from .env.example must be set; the script registers
// the keys and seals one batch, so it spends a little gas.
import fs from 'node:fs';
import path from 'node:path';
import {
  assembleProof, buildBatch, buildRecord, createDemoDevice, generateEd25519, keyFingerprint,
  randomHex, signPermissionVersion, signRecordHash,
} from '../packages/verify/src/index.js';
import { createLocalPublicRecord } from '../src/public-record/local.js';

const argNetwork = process.argv.includes('--network') ? process.argv[process.argv.indexOf('--network') + 1] : 'local';
const outDir = path.resolve('samples/proofs');
fs.mkdirSync(outDir, { recursive: true });
const localPath = path.join(outDir, 'local-record.json');

let chain;
if (argNetwork === 'local') {
  if (fs.existsSync(localPath)) fs.rmSync(localPath);
  chain = createLocalPublicRecord({ path: localPath });
} else {
  const { createPublicRecords } = await import('../src/public-record/index.js');
  [chain] = await createPublicRecords({ ...process.env, PUBLIC_RECORD_NETWORKS: argNetwork });
}

const envoiKey = { keyId: `ev-sample-${Date.now()}`, ...(await generateEd25519()) };
await chain.registerKey({ kind: 'envoi', keyRef: 'envoi', keyId: envoiKey.keyId, fingerprint: await keyFingerprint(envoiKey.publicJwk), alg: 'Ed25519' });
const device = await createDemoDevice();
const ownerRef = randomHex();
await chain.registerKey({ kind: 'owner_demo', keyRef: ownerRef, keyId: 'demo-device', fingerprint: await keyFingerprint(device.publicJwk), alg: 'ES256' });

const document = {
  schema: 'envoi.permissions/v1', workspaceId: 'ws_sample', agentId: 'ag_milo', agentAccount: 'a7f3c2.agents.envoi.testnet', version: 1, previousHash: null,
  rules: { receive_messages: 'allowed', send_messages: 'allowed', share_files: 'off', submit_forms: 'ask_first',
    spend_money: { level: 'ask_first', perTx: '5', daily: '10', unit: 'NEAR', allowlist: [] } },
  issuedAt: new Date(Date.now() + 5000).toISOString(), issuedBy: 'owner_rachel',
};
const permissionVersion = await signPermissionVersion({
  document, device, rpId: 'localhost', rpOrigin: 'http://localhost:5173', ownerRef, ownerName: 'Rachel Gonsalves (sample)', method: 'demo_device',
});

const now = new Date().toISOString();
const share = await buildRecord({
  id: 'ev_sample_1', workspaceId: 'ws_sample', seq: 1, type: 'permission_blocked', agentId: 'ag_milo', caseId: 'case_q4_hiring',
  summary: "Milo tried to share budget.xlsx with Ledger's agent. Blocked because Share files is Off.",
  ruleVersionHash: permissionVersion.documentHash, firstAt: now, lastAt: now,
  details: { file: 'budget.xlsx', counterparty: 'finance@ledger.example', note: 'Fictional sample data' },
});
const pay = await buildRecord({
  id: 'ev_sample_2', workspaceId: 'ws_sample', seq: 2, type: 'payment_blocked', agentId: 'ag_milo', caseId: 'case_q4_hiring',
  summary: 'Milo tried to pay 20 NEAR to refunds-ledger.testnet. Blocked because the payment is over Milo\'s 5 NEAR limit.',
  ruleVersionHash: permissionVersion.documentHash, previousHash: share.recordHash, firstAt: now, lastAt: now,
  details: { to: 'refunds-ledger.testnet', amount: '20', unit: 'NEAR' },
});

const last = await chain.reader().last(chain.contractId);
const batchId = Number(last?.[0] ?? 0) + 1;
const previousRoot = last?.[1] ?? null;
const batch = await buildBatch({ batchId, recordHashes: [share.recordHash, pay.recordHash], previousRoot });
const receipt = await chain.publish({ batchId, root: batch.root, previousRoot, count: batch.count });
const seals = [{ network: chain.network, contractId: chain.contractId, batchId, txRef: receipt.txRef, ...(receipt.explorerUrl && { explorerUrl: receipt.explorerUrl }) }];

const genuine = await assembleProof({ built: share, envoiSignature: await signRecordHash(share.recordHash, envoiKey), permissionVersion, batch, leafIndex: 0, seals });
const tampered = structuredClone(genuine);
tampered.record.summary = tampered.record.summary.replace('Off', 'Allowed');

const suffix = argNetwork === 'local' ? '' : `-${argNetwork}`;
fs.writeFileSync(path.join(outDir, `genuine-blocked-share${suffix}.json`), `${JSON.stringify(genuine, null, 2)}\n`);
fs.writeFileSync(path.join(outDir, `tampered-summary${suffix}.json`), `${JSON.stringify(tampered, null, 2)}\n`);
console.log(`Sealed batch ${batchId} on ${chain.network} (${receipt.txRef}). Wrote samples to ${outDir}`);
