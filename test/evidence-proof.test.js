// End-to-end proof checks against the local public record: one genuine proof, then the tamper
// matrix from the build plan. Each edit must fail with the exact message the UI shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleProof, buildBatch, buildRecord, canonicalHash, checkProof, createDemoDevice, generateEd25519,
  keyFingerprint, MESSAGES, signPermissionVersion, signRecordHash,
} from '../packages/verify/src/index.js';
import { createLocalPublicRecord } from '../src/public-record/local.js';

const RP = { rpId: 'localhost', rpOrigin: 'http://localhost:5173' };
const OWNER_REF = 'a'.repeat(64);
const clone = value => structuredClone(value);
const messageOf = (result, code) => result.checks.find(c => c.code === code)?.message;
const statusOf = (result, code) => result.checks.filter(c => c.code === code).map(c => c.status);

const setup = async ({ registerOwnerKey = true, ownerKind = 'owner_demo' } = {}) => {
  const chain = createLocalPublicRecord();
  const readers = { local: chain.reader() };
  const envoiKey = { keyId: 'ev-test', ...(await generateEd25519()) };
  await chain.registerKey({ kind: 'envoi', keyRef: 'envoi', keyId: envoiKey.keyId, fingerprint: await keyFingerprint(envoiKey.publicJwk), alg: 'Ed25519' });
  const device = await createDemoDevice();
  if (registerOwnerKey) {
    await chain.registerKey({ kind: ownerKind, keyRef: OWNER_REF, keyId: 'demo-1', fingerprint: await keyFingerprint(device.publicJwk), alg: 'ES256' });
  }
  const document = {
    schema: 'envoi.permissions/v1', workspaceId: 'ws_demo', agentId: 'ag_milo', agentAccount: 'a7f3c2.agents.envoi.testnet', version: 1, previousHash: null,
    rules: { share_files: 'off', spend_money: { level: 'ask_first', perTx: '5', daily: '10', unit: 'NEAR', allowlist: [] } },
    issuedAt: new Date(Date.now() + 1000).toISOString(), issuedBy: 'owner_rachel',
  };
  const permissionVersion = await signPermissionVersion({ document, device, ...RP, ownerRef: OWNER_REF, ownerName: 'Rachel Gonsalves', method: 'demo_device' });
  return { chain, readers, envoiKey, device, permissionVersion };
};

const makeProof = async (ctx, { seal = true, leafIndex = 1, count = 5 } = {}) => {
  const built = [];
  let previousHash = null;
  for (let seq = 1; seq <= count; seq += 1) {
    const b = await buildRecord({
      id: `ev_${seq}`, workspaceId: 'ws_demo', seq, type: 'permission_blocked', agentId: 'ag_milo', caseId: 'case_q4',
      summary: 'Milo tried to share budget.xlsx with Ledger\'s agent. Blocked because Share files is Off.',
      ruleVersionHash: ctx.permissionVersion.documentHash, previousHash,
      firstAt: '2026-11-06T14:14:00Z', lastAt: '2026-11-06T14:14:00Z',
      details: { file: 'budget.xlsx', counterparty: 'finance@ledger.envoi-agents.com' },
    });
    previousHash = b.recordHash;
    built.push(b);
  }
  const batch = await buildBatch({ batchId: 1, recordHashes: built.map(b => b.recordHash), previousRoot: null });
  let seals = [];
  if (seal) {
    const receipt = await ctx.chain.publish({ batchId: 1, root: batch.root, previousRoot: null, count: batch.count });
    seals = [{ network: 'local', contractId: receipt.contractId, batchId: 1, txRef: receipt.txRef }];
  }
  const target = built[leafIndex];
  return assembleProof({
    built: target, envoiSignature: await signRecordHash(target.recordHash, ctx.envoiKey), permissionVersion: ctx.permissionVersion,
    batch, leafIndex, seals, registry: { network: 'local', contractId: 'local.envoi' },
  });
};

test('a genuine proof passes every check', async () => {
  const ctx = await setup();
  const proof = await makeProof(ctx);
  const result = await checkProof(proof, { readers: ctx.readers });
  assert.equal(result.verdict, 'genuine', JSON.stringify(result.checks, null, 1));
  assert.equal(result.message, MESSAGES.verdict.genuine);
  assert.deepEqual(result.checks.map(c => c.code), ['envoi_signature', 'owner_signature', 'owner_key_listed', 'unchanged', 'in_batch', 'on_chain']);
  assert.match(messageOf(result, 'owner_signature'), /demo device/);
});

test('every leaf position in odd and even batches checks', async () => {
  const ctx = await setup();
  for (const [count, leafIndex] of [[1, 0], [2, 1], [3, 2], [7, 6], [7, 3]]) {
    const local = { ...ctx, chain: createLocalPublicRecord() };
    local.readers = { local: local.chain.reader() };
    // the new chain needs the keys listed too
    await local.chain.registerKey({ kind: 'envoi', keyRef: 'envoi', keyId: ctx.envoiKey.keyId, fingerprint: await keyFingerprint(ctx.envoiKey.publicJwk), alg: 'Ed25519' });
    await local.chain.registerKey({ kind: 'owner_demo', keyRef: OWNER_REF, keyId: 'demo-1', fingerprint: await keyFingerprint(ctx.device.publicJwk), alg: 'ES256' });
    const proof = await makeProof(local, { count, leafIndex });
    assert.equal((await checkProof(proof, { readers: local.readers })).verdict, 'genuine', `${leafIndex} of ${count}`);
  }
});

const tamper = async (edit, expectCode, expectMessage) => {
  const ctx = await setup();
  const proof = clone(await makeProof(ctx));
  await edit(proof, ctx);
  const result = await checkProof(proof, { readers: ctx.readers });
  assert.equal(result.verdict, 'untrusted', JSON.stringify(result.checks, null, 1));
  assert.equal(result.message, MESSAGES.verdict.untrusted);
  assert.ok(statusOf(result, expectCode).includes('fail'), `${expectCode} should fail: ${JSON.stringify(result.checks)}`);
  if (expectMessage) assert.equal(messageOf(result, expectCode), expectMessage);
};

test('tamper: edited summary text', () => tamper(p => { p.record.summary = p.record.summary.replace('Off', 'Allowed'); }, 'unchanged', MESSAGES.unchanged.fail));
test('tamper: edited salt', () => tamper(p => { p.record.salt = 'b'.repeat(64); }, 'unchanged', MESSAGES.unchanged.fail));
test('tamper: edited details', () => tamper(p => { p.details.file = 'other.xlsx'; }, 'unchanged', MESSAGES.unchanged.fail));
test('tamper: recomputed record hash still breaks the signature', async () => {
  const { recordHash } = await import('../packages/verify/src/hash.js');
  await tamper(async p => { p.record.occurrences = 2; p.recordHash = await recordHash(p.record); }, 'envoi_signature', MESSAGES.envoi_signature.fail);
});
test('tamper: one signature byte', () => tamper(p => {
  const s = p.envoiSignature.signature;
  p.envoiSignature.signature = (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
}, 'envoi_signature', MESSAGES.envoi_signature.fail));
test('tamper: signed by a key that is not listed', () => tamper(async p => {
  const other = { keyId: 'ev-test', ...(await generateEd25519()) };
  p.envoiSignature = await signRecordHash(p.recordHash, other);
}, 'envoi_signature', MESSAGES.envoi_signature.fail));
test('tamper: rule in force swapped for another document', () => tamper(async p => {
  p.permissionVersion.document.rules.share_files = 'allowed';
  p.permissionVersion.documentHash = await canonicalHash(p.permissionVersion.document);
}, 'owner_signature', MESSAGES.owner_signature.fail));
test('tamper: owner signature byte', () => tamper(p => {
  const s = p.permissionVersion.assertion.signature;
  p.permissionVersion.assertion.signature = s.slice(0, 20) + (s[20] === 'A' ? 'B' : 'A') + s.slice(21);
}, 'owner_signature', MESSAGES.owner_signature.fail));
test('tamper: owner key swapped in the file', () => tamper(async p => {
  const imposter = await createDemoDevice();
  const signed = await imposter.sign({ documentHash: p.permissionVersion.documentHash, ...RP });
  p.permissionVersion.ownerPublicKey = imposter.publicJwk;
  p.permissionVersion.assertion = signed;
}, 'owner_key_listed', MESSAGES.owner_key_listed.fail));
test('tamper: removed sibling', () => tamper(p => { p.batch.siblings.pop(); }, 'in_batch', MESSAGES.in_batch.fail));
test('tamper: leaf index moved', () => tamper(p => { p.batch.leafIndex = 2; }, 'in_batch', MESSAGES.in_batch.fail));
test('tamper: root not on chain', () => tamper(p => { p.seals[0].batchId = 99; }, 'on_chain', MESSAGES.on_chain.fail));
test('tamper: batch root replaced', () => tamper(p => { p.batch.root = 'c'.repeat(64); }, 'in_batch', MESSAGES.in_batch.fail));

test('owner key listed after the permission was signed fails', async () => {
  const ctx = await setup({ registerOwnerKey: false });
  const proof = await makeProof(ctx);
  proof.permissionVersion.document.issuedAt = '2020-01-01T00:00:00Z';
  // re-sign honestly so only the timing is wrong
  const { signPermissionVersion: sign } = await import('../packages/verify/src/build.js');
  proof.permissionVersion = await sign({ document: proof.permissionVersion.document, device: ctx.device, ...RP, ownerRef: OWNER_REF, ownerName: 'Rachel Gonsalves', method: 'demo_device' });
  await ctx.chain.registerKey({ kind: 'owner_demo', keyRef: OWNER_REF, keyId: 'demo-1', fingerprint: await keyFingerprint(ctx.device.publicJwk), alg: 'ES256' });
  const result = await checkProof(proof, { readers: ctx.readers });
  assert.equal(messageOf(result, 'owner_key_listed'), MESSAGES.owner_key_listed.fail);
  assert.equal(result.verdict, 'untrusted');
});

test('a demo key cannot pass as a real passkey', async () => {
  const ctx = await setup({ ownerKind: 'owner_demo' });
  const proof = await makeProof(ctx);
  proof.permissionVersion.method = 'passkey';
  const result = await checkProof(proof, { readers: ctx.readers });
  assert.equal(result.verdict, 'untrusted');
  assert.equal(messageOf(result, 'owner_key_listed'), MESSAGES.owner_key_listed.fail);
});

test('unsealed record reads "waiting to be sealed"', async () => {
  const ctx = await setup();
  const proof = await makeProof(ctx, { seal: false });
  const result = await checkProof(proof, { readers: ctx.readers });
  assert.equal(result.verdict, 'pending');
  assert.equal(result.message, MESSAGES.verdict.pending);
});

test('unreachable network is "not fully checked", never genuine', async () => {
  const ctx = await setup();
  const proof = await makeProof(ctx);
  const down = { local: { rootOf: async () => { throw new Error('down'); }, keysOf: async () => { throw new Error('down'); } } };
  const result = await checkProof(proof, { readers: down });
  assert.equal(result.verdict, 'incomplete');
  assert.equal(result.message, MESSAGES.verdict.incomplete);
  assert.equal(messageOf(result, 'on_chain'), MESSAGES.unreachable);
});

test('not a proof file', async () => {
  for (const junk of [null, {}, { format: 'other' }, 'text', []]) {
    const result = await checkProof(junk, {});
    assert.equal(result.verdict, 'bad_file');
    assert.equal(result.message, MESSAGES.bad_file);
  }
});

const privateCheckProof = async ({ mock = false, tamperText = false } = {}) => {
  const { Wallet } = await import('ethers');
  const tee = Wallet.createRandom();
  const requestHash = '1'.repeat(64);
  const responseHash = '2'.repeat(64);
  const model = 'zai-org/GLM-5.1-FP8';
  const signedText = `${model}:${requestHash}:${responseHash}`;
  const privateCheck = {
    verdict: 'likely_injection', reason: 'Asks the agent to ignore its rules and send money.', model, chatId: 'chatcmpl-test',
    requestHash, responseHash, signatureKind: 'provider_tee', signedText: tamperText ? signedText.replace('1', '3') : signedText,
    signature: await tee.signMessage(signedText), signingAddress: tee.address,
    attestation: { nonce: 'n'.repeat(64), checkedAt: '2026-11-06T14:14:00Z', checks: [{ name: 'nonce', ok: true }] }, mock,
  };
  const ctx = await setup();
  const b = await buildRecord({
    id: 'ev_pc', workspaceId: 'ws_demo', seq: 1, type: 'injection_flagged', agentId: 'ag_milo',
    summary: "Ledger's agent sent Milo a message that looked like hidden instructions.", ruleVersionHash: ctx.permissionVersion.documentHash,
    firstAt: '2026-11-06T14:14:00Z', lastAt: '2026-11-06T14:14:00Z', privateCheck,
  });
  const batch = await buildBatch({ batchId: 1, recordHashes: [b.recordHash] });
  const receipt = await ctx.chain.publish({ batchId: 1, root: batch.root, previousRoot: null, count: 1 });
  const proof = await assembleProof({
    built: b, envoiSignature: await signRecordHash(b.recordHash, ctx.envoiKey), permissionVersion: ctx.permissionVersion, batch, leafIndex: 0,
    seals: [{ network: 'local', contractId: receipt.contractId, batchId: 1 }],
  });
  return { proof, readers: ctx.readers };
};

test('private check signed by the TEE address passes', async () => {
  const { proof, readers } = await privateCheckProof();
  const result = await checkProof(proof, { readers });
  assert.equal(result.verdict, 'genuine', JSON.stringify(result.checks, null, 1));
  assert.equal(messageOf(result, 'private_check'), MESSAGES.private_check.ok);
});

test('private check whose signed text does not bind the hashes fails', async () => {
  const { proof, readers } = await privateCheckProof({ tamperText: true });
  const result = await checkProof(proof, { readers });
  assert.equal(result.verdict, 'untrusted');
});

test('simulated private check is labeled, never "signed by a verified sealed machine"', async () => {
  const { proof, readers } = await privateCheckProof({ mock: true });
  const result = await checkProof(proof, { readers });
  assert.equal(messageOf(result, 'private_check'), MESSAGES.private_check.mock);
});

test('redacted proof (no details) still checks', async () => {
  const ctx = await setup();
  const proof = await makeProof(ctx);
  delete proof.details;
  delete proof.detailsSalt;
  assert.equal((await checkProof(proof, { readers: ctx.readers })).verdict, 'genuine');
});
