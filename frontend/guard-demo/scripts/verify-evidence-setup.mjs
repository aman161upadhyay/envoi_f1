import { passkeyOrigins } from './permission-file.mjs';
import { EvidenceStore } from '../apps/server/evidence-store.mjs';
import { EvidenceBatcher } from '../apps/server/evidence-batcher.mjs';
import { testnetSealer } from '../apps/server/testnet-sealer.mjs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { nearReaders } from '../adapters/near/read.mjs';
import { createRpc, DEFAULT_RPC } from '../adapters/near/rpc.mjs';
import { loadScopedKey } from '../adapters/near/key-file.mjs';
import { hashJson, publicHex } from '../packages/core/crypto.mjs';
import { checkProof } from '../packages/check/index.mjs';
import { registerEvidenceKey } from './evidence-key.mjs';

const env = process.env;
const recordContract = env.NEAR_RECORD_CONTRACT;
const publisher = env.NEAR_PUBLISHER_ACCOUNT;
if (recordContract !== 'record.envoi-pr302-20261106.testnet' || publisher !== 'publisher.envoi-pr302-20261106.testnet') {
  throw new Error('This verification uses the disposable PR302 testnet deployment.');
}
const rpcUrl = env.NEAR_RPC_URL || DEFAULT_RPC['near-testnet'];
const rpc = createRpc(rpcUrl);
if ((await rpc('status', [])).chain_id !== 'testnet') throw new Error('Testnet required.');
const readers = nearReaders({ rpcUrl, recordContract, publisher, spendContract: env.NEAR_SPEND_CONTRACT });
const contract = await readers.publicRecord.describeContract();
if (contract.codeHash !== env.NEAR_RECORD_CODE_HASH) throw new Error('The published contract hash does not match testnet.');
const keys = await loadScopedKey(env.NEAR_PUBLISHER_PRIVATE_KEY, env.NEAR_PUBLISHER_PUBLIC_KEY);
const evidenceKeys = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
const keyId = 'ev-' + crypto.randomUUID().replaceAll('-', '').slice(0, 24);
const registration = await registerEvidenceKey({
  rpc, keys, publisher, recordContract, registry: readers.evidenceRegistry,
  keyId, publicKey: await publicHex(evidenceKeys.publicKey)
});
const signed = JSON.parse(await readFile(env.NEAR_SIGNED_POLICY_FILE || 'signed-policy.json', 'utf8'));
const document = signed.document;
const path = env.NEAR_EVIDENCE_DB || 'data/evidence.sqlite';
await mkdir(dirname(path), { recursive: true });
const store = new EvidenceStore(path, { network: 'near-testnet', recordContract, publisher });
try {
  const permission = {
    document, ownerKey: signed.publicKey, signature: signed.signature, keyType: signed.keyType ?? 'demo_device',
    ...(signed.rpId ? { rpId: signed.rpId } : {}), registry: { network: 'near-testnet', contract: recordContract }
  };
  await store.savePermission(permission);
  await store.append(keyId, {
    type: 'permission_changed', agent: document.agent, counterparty: publisher, caseRef: 'record-upgrade-check',
    summary: 'The testnet evidence registry and seal were verified.',
    permissionHash: await hashJson(document),
    details: { purpose: 'Deployment verification', evidenceKeyId: keyId },
    createdAtMs: Math.max(Date.now(), registration.registeredAtMs)
  }, evidenceKeys, keyId);
  const batcher = new EvidenceBatcher({ store, transport: testnetSealer({
    rpc, keys, publisher, recordContract, publicRecord: readers.publicRecord
  }) });
  let batch;
  do {
    batch = await batcher.tick({ force: true });
    if (batch && batch.status !== 'final') throw new Error('The durable seal is ' + batch.status + '. Use evidence:batch to recover it.');
  } while (store.pendingRecords().length);
  const proof = await store.proofFor(keyId, undefined, {
    network: 'near-testnet', contract: recordContract, spendContract: env.NEAR_SPEND_CONTRACT
  });
  const txRef = proof.seal.txRef;
  const result = await checkProof(proof, {
    ...readers, recordContract, spendContract: env.NEAR_SPEND_CONTRACT, recordCodeHash: env.NEAR_RECORD_CODE_HASH, passkeyOrigins: passkeyOrigins()
  });
  const file = 'testnet-run-evidence-' + keyId + '.json';
  await writeFile(file, JSON.stringify({ proof, result, registration }, null, 2), { flag: 'wx' });
  for (const row of result.checks) console.log(row.status, row.id, row.message);
  console.log('Registration:', registration.txRef);
  console.log('Seal:', txRef);
  console.log('Proof saved:', file);
  if (result.checks.some(row => row.status !== 'PASS' && !(row.id === 'locked_record' && !contract.locked))) {
    throw new Error('Evidence deployment verification did not pass.');
  }
} finally { store.close(); }
