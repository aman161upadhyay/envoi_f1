import { readFile, writeFile } from 'node:fs/promises';
import { nearReaders } from '../adapters/near/read.mjs';
import { createRpc, DEFAULT_RPC } from '../adapters/near/rpc.mjs';
import { loadScopedKey } from '../adapters/near/key-file.mjs';
import { callWithScopedKey } from '../adapters/near/sign.mjs';
import { makeEvidence } from '../packages/core/evidence.mjs';
import { hashJson, publicHex } from '../packages/core/crypto.mjs';
import { buildTree, ZERO_ROOT } from '../packages/core/tree.mjs';
import { checkProof } from '../packages/check/index.mjs';
import { PUBLISHER_METHODS, registerEvidenceKey } from './evidence-key.mjs';

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
const evidence = await makeEvidence({
  seq: 1, type: 'permission_changed', agent: document.agent, counterparty: publisher, caseRef: 'record-upgrade-check',
  summary: 'The testnet evidence registry and seal were verified.',
  previousHash: ZERO_ROOT, permissionHash: await hashJson(document),
  details: { purpose: 'Deployment verification', evidenceKeyId: keyId },
  createdAtMs: Math.max(Date.now(), registration.registeredAtMs)
}, evidenceKeys);
evidence.envoi.keyId = keyId;
const tip = await rpc('query', { request_type: 'call_function', finality: 'final', account_id: recordContract,
  method_name: 'last', args_base64: 'e30=' });
const [last, previousRoot] = JSON.parse(Buffer.from(tip.result));
const tree = await buildTree([evidence.recordHash]);
const batch = { batchId: last + 1, previousRoot, root: tree.root, count: 1, leafIndex: 0, siblings: [] };
const txRef = await callWithScopedKey({ rpc, keys, sender: publisher, receiver: recordContract,
  method: 'seal', methods: PUBLISHER_METHODS,
  args: { batch_id: batch.batchId, root: batch.root, previous_root: previousRoot, count: 1 } });
const proof = {
  format: 'envoi.proof/v1', ...evidence, batch, seal: { network: 'near-testnet', contract: recordContract, txRef },
  permission: { document, ownerKey: signed.publicKey, signature: signed.signature, keyType: signed.keyType ?? 'demo_device',
    ...(signed.rpId ? { rpId: signed.rpId } : {}), registry: { network: 'near-testnet', contract: recordContract } }
};
const result = await checkProof(proof, {
  ...readers, recordContract, spendContract: env.NEAR_SPEND_CONTRACT, recordCodeHash: env.NEAR_RECORD_CODE_HASH
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
