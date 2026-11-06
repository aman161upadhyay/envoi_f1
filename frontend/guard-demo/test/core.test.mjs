import assert from 'node:assert/strict';
import test from 'node:test';
import { canonical, hashJson, publicHex, sign } from '../packages/core/crypto.mjs';
import { displayPermission } from '../packages/core/policy.mjs';
import { buildTree, verifyPath, ZERO_ROOT } from '../packages/core/tree.mjs';
import { makeEvidence } from '../packages/core/evidence.mjs';
import { checkProof } from '../packages/check/index.mjs';
import { createLocalAdapters } from '../adapters/local/store.mjs';

const keys = () => crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
const owner = 'dana.northwind.near';
const agent = 'milo.northwind.near';
const to = 'ledger-payee.northwind.near';
const unit = 10n ** 24n;
const amount = n => String(BigInt(n) * unit);

test('canonical JSON sorts nested keys, preserves Unicode and rejects fractions and lone surrogates', () => {
  assert.equal(canonical({ z: ['🚀', true], a: { y: 1, b: null } }), '{"a":{"b":null,"y":1},"z":["🚀",true]}');
  assert.throws(() => canonical({ a: 0.5 }));
  assert.throws(() => canonical('\uD800'));
  assert.throws(() => canonical(Array(1)));
});

test('inclusion paths bind position and count for odd trees', async () => {
  const hashes = await Promise.all([1, 2, 3, 4, 5].map(hashJson));
  const tree = await buildTree(hashes);
  for (const [leafIndex, hash] of hashes.entries()) {
    const batch = { leafIndex, count: hashes.length, root: tree.root, siblings: tree.path(leafIndex) };
    assert.equal(await verifyPath(hash, batch), true);
    assert.equal(await verifyPath(hash, { ...batch, leafIndex: (leafIndex + 1) % hashes.length }), false);
  }
});

test('refusals preserve balances, policy ownership and daily caps', async () => {
  const { db, spendGuard: spend } = createLocalAdapters();
  try {
    await spend.registerAgent(owner, agent, 'ab'.repeat(32));
    await spend.deposit(owner, amount(3));
    const policy = { payees: [{ account: to, maxPerPayment: amount(1) }], dailyCap: amount(2), paused: false };
    await assert.rejects(spend.setPolicy(agent, agent, policy, ZERO_ROOT), /Owner required/);
    await spend.setPolicy(owner, agent, policy, ZERO_ROOT);
    const refused = await spend.pay(agent, 'attacker.northwind.near', amount(20), 'invoice-1042');
    assert.equal(refused.reason, 'not_payee');
    assert.equal(await spend.vaultOf(owner), amount(3));
    assert.equal((await spend.pay(agent, to, amount(2), 'invoice-1042')).reason, 'over_max');
    for (let i = 0; i < 2; i++) assert.equal((await spend.pay(agent, to, amount(1), 'invoice-1042')).status, 'paid');
    assert.equal((await spend.pay(agent, to, amount(1), 'invoice-1042')).reason, 'over_daily_cap');
    assert.equal(await spend.vaultOf(owner), amount(1));
  } finally { db.close(); }
});

test('proof verifier rejects all twelve specified tamper classes', async () => {
  const adapters = createLocalAdapters(':memory:', () => 100);
  try {
    const { ownerRegistry, spendGuard, publicRecord } = adapters;
    const ownerKeys = await keys();
    const envoiKeys = await keys();
    const ownerKey = await publicHex(ownerKeys.publicKey);
    await ownerRegistry.register(owner, { type: 'demo_device', label: 'Demo device', publicKey: ownerKey });
    const payees = [{ account: to, label: 'Ledger Co', maxPerPayment: amount(1) }];
    const document = { schema: 'envoi.permissions/v1', owner, agent, version: 1, previousHash: ZERO_ROOT, issuedAtMs: 101,
      rules: { spend_money: { payees, dailyCap: amount(2), unit: 'yoctoNEAR' }, share_files: { default: 'off', allow: [] }, send_messages: 'allowed' } };
    document.display = displayPermission(document);
    const permissionHash = await hashJson(document);
    await spendGuard.registerAgent(owner, agent, 'ab'.repeat(32));
    await spendGuard.setPolicy(owner, agent, { payees, dailyCap: amount(2), paused: false }, permissionHash);
    const caseRef = 'invoice-1042';
    const outcome = await spendGuard.pay(agent, 'attacker.northwind.near', amount(20), caseRef);
    const another = await spendGuard.pay(agent, 'attacker.northwind.near', amount(20), caseRef);
    const chainRef = { network: 'local', txRef: outcome.txRef };
    const evidence = await makeEvidence({ seq: 1, type: 'pay_refused', agent, counterparty: to, caseRef,
      summary: 'Payment refused.', previousHash: ZERO_ROOT, permissionHash, chainRef, createdAtMs: 102,
      details: { to: outcome.to, amount: outcome.amount, reason: outcome.reason } }, envoiKeys);
    const tree = await buildTree([evidence.recordHash, await hashJson('other record')]);
    const batch = { batchId: 1, root: tree.root, previousRoot: ZERO_ROOT, count: 2, leafIndex: 0, siblings: tree.path(0) };
    const { txRef } = await publicRecord.seal(batch);
    const permission = { document, ownerKey, signature: await sign(ownerKeys.privateKey, permissionHash), registry: { network: 'local', contract: 'local-record' } };
    const proof = { format: 'envoi.proof/v1', ...evidence, permission, batch,
      seal: { network: 'local', contract: 'local-record', txRef }, chainEvent: { ...chainRef, contract: 'local-spend' } };
    const trust = { evidenceKeys: { 'ev-1': evidence.envoi.publicKey }, ...adapters, recordContract: 'local-record', spendContract: 'local-spend' };
    const good = await checkProof(proof, trust);
    assert.equal(good.verdict, 'partial');
    assert.deepEqual(good.checks.filter(row => row.status !== 'PASS'), [{ id: 'locked_record', status: 'SKIP' }]);
    const otherKeys = await keys();
    const otherKey = await publicHex(otherKeys.publicKey);
    const otherSignature = await sign(otherKeys.privateKey, permissionHash);
    const flip = value => (value[0] === '0' ? '1' : '0') + value.slice(1);
    const changes = [
      p => p.record.summary += '!',
      p => p.details.reason += '!',
      p => p.detailsSalt = flip(p.detailsSalt),
      p => p.record.salt = flip(p.record.salt),
      p => p.record.previousHash = flip(p.record.previousHash),
      p => p.envoi.signature = flip(p.envoi.signature),
      p => p.envoi.publicKey = otherKey,
      p => p.permission.signature = flip(p.permission.signature),
      p => p.permission.document.display[0] += '!',
      p => { p.permission.ownerKey = otherKey; p.permission.signature = otherSignature; },
      p => p.batch.siblings[0].hash = flip(p.batch.siblings[0].hash),
      p => p.chainEvent.txRef = another.txRef
    ];
    for (const [index, change] of changes.entries()) {
      const edited = structuredClone(proof);
      change(edited);
      assert.equal((await checkProof(edited, trust)).verdict, 'failed', `tamper case ${index + 1}`);
    }
  } finally { adapters.db.close(); }
});
