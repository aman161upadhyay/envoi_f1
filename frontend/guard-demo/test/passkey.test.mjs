// Passkey-signed permissions and envoi's evidence key listed on the record contract.
// A software P-256 authenticator stands in for Face ID / Touch ID / Windows Hello; its output
// has the same shape a browser returns from navigator.credentials.get().
import assert from 'node:assert/strict';
import test from 'node:test';
import { fromHex, hashJson, publicHex, sign } from '../packages/core/crypto.mjs';
import { displayPermission } from '../packages/core/policy.mjs';
import { buildTree, ZERO_ROOT } from '../packages/core/tree.mjs';
import { makeEvidence } from '../packages/core/evidence.mjs';
import { derToRaw, fromBase64Url, passkeyPublicHex, rawToDer, toBase64Url, verifyPasskeySignature } from '../packages/core/webauthn.mjs';
import { checkProof } from '../packages/check/index.mjs';
import { createLocalAdapters } from '../adapters/local/store.mjs';
import { nearReaders } from '../adapters/near/read.mjs';
import { serveChecker } from '../apps/server/check-site.mjs';

const owner = 'dana.northwind.near';
const agent = 'milo.northwind.near';
const to = 'ledger-payee.northwind.near';
const amount = n => String(BigInt(n) * 10n ** 24n);
const RP_ID = 'envoi.example';
const ORIGIN = 'https://app.envoi.example';
const statusOf = (result, id) => result.checks.find(row => row.id === id)?.status;
const sha256 = async bytes => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));

async function softwarePasskey() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKey = await passkeyPublicHex(pair.publicKey);
  async function signHash(hash, { rpId = RP_ID, origin = ORIGIN, flags = 0x05, type = 'webauthn.get' } = {}) {
    const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type, challenge: toBase64Url(fromHex(hash, 32)), origin, crossOrigin: false }));
    const authenticatorData = new Uint8Array([...(await sha256(new TextEncoder().encode(rpId))), flags, 0, 0, 0, 1]);
    const signed = new Uint8Array([...authenticatorData, ...(await sha256(clientDataJSON))]);
    const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, signed));
    return { authenticatorData: toBase64Url(authenticatorData), clientDataJSON: toBase64Url(clientDataJSON), signature: toBase64Url(rawToDer(raw)) };
  }
  return { publicKey, signHash };
}

// A sealed proof whose rule is signed by a passkey, with envoi's key on the local evidence list.
async function fixture({ keyListedAt = 50, revokeKeyAt, signOptions, listOwnerKeyAs = 'passkey' } = {}) {
  let now = keyListedAt;
  const adapters = createLocalAdapters(':memory:', () => now);
  const passkey = await softwarePasskey();
  const envoiKeys = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  const envoiPublic = await publicHex(envoiKeys.publicKey);
  await adapters.evidenceRegistry.register('ev-1', envoiPublic);
  if (revokeKeyAt !== undefined) { now = revokeKeyAt; await adapters.evidenceRegistry.revoke('ev-1'); }
  now = 60;
  if (listOwnerKeyAs === 'passkey') await adapters.ownerRegistry.register(owner, { type: 'passkey', label: 'MacBook', publicKey: passkey.publicKey });
  const payees = [{ account: to, label: 'Ledger Co', maxPerPayment: amount(1) }];
  const document = { schema: 'envoi.permissions/v1', owner, agent, version: 1, previousHash: ZERO_ROOT, issuedAtMs: 101,
    rules: { spend_money: { payees, dailyCap: amount(2), unit: 'yoctoNEAR' }, share_files: { default: 'off', allow: [] }, send_messages: 'allowed' } };
  document.display = displayPermission(document);
  const permissionHash = await hashJson(document);
  await adapters.spendGuard.registerAgent(owner, agent, 'ab'.repeat(32));
  await adapters.spendGuard.setPolicy(owner, agent, { payees, dailyCap: amount(2), paused: false }, permissionHash);
  const evidence = await makeEvidence({ seq: 1, type: 'share_blocked', agent, counterparty: to, caseRef: 'invoice-1042',
    summary: "Milo tried to share budget.xlsx with Ledger's agent.", previousHash: ZERO_ROOT, permissionHash,
    createdAtMs: 103, details: { file: 'budget.xlsx' } }, envoiKeys);
  const tree = await buildTree([evidence.recordHash, await hashJson('other record')]);
  const batch = { batchId: 1, root: tree.root, previousRoot: ZERO_ROOT, count: 2, leafIndex: 0, siblings: tree.path(0) };
  const { txRef } = await adapters.publicRecord.seal(batch);
  const permission = { document, keyType: 'passkey', ownerKey: passkey.publicKey, rpId: RP_ID,
    signature: await passkey.signHash(permissionHash, signOptions), registry: { network: 'local', contract: 'local-record' } };
  const proof = { format: 'envoi.proof/v1', ...evidence, permission, batch, seal: { network: 'local', contract: 'local-record', txRef } };
  // No evidenceKeys map: envoi's key must come from the evidence list.
  const trust = { ...adapters, recordContract: 'local-record', spendContract: 'local-spend' };
  return { adapters, passkey, proof, trust, permissionHash, envoiKeys };
}

const withFixture = async (options, fn) => {
  const f = await fixture(options);
  try { await fn(f); } finally { f.adapters.db.close(); }
};

test('DER and raw ECDSA signatures convert both ways', async () => {
  for (let i = 0; i < 20; i += 1) {
    const raw = crypto.getRandomValues(new Uint8Array(64));
    if (i % 4 === 0) raw[0] = 0;            // short r
    if (i % 4 === 1) raw[32] = 0x80;         // s needs a leading zero
    assert.deepEqual(derToRaw(rawToDer(raw)), raw);
  }
  assert.throws(() => derToRaw(Uint8Array.of(0x30, 0x02, 0x02, 0x00)));
});

test('a passkey-signed rule with envoi\'s key from the evidence list passes every local check', () => withFixture({}, async ({ proof, trust }) => {
  const result = await checkProof(proof, trust);
  assert.deepEqual(result.checks.filter(row => row.status !== 'PASS').map(row => row.id), ['locked_record']);
  assert.equal(result.verdict, 'partial');
}));

test('passkey signatures are bound to the permission, the site and user verification', async () => {
  const passkey = await softwarePasskey();
  const hash = await hashJson({ rule: 'a' });
  const other = await hashJson({ rule: 'b' });
  const ok = await passkey.signHash(hash);
  const check = (signature, overrides = {}) => verifyPasskeySignature({ publicKey: passkey.publicKey, hash, signature, rpId: RP_ID, ...overrides });
  assert.equal(await check(ok), true);
  assert.equal(await check(await passkey.signHash(other)), false, 'signed a different permission');
  assert.equal(await check(await passkey.signHash(hash, { rpId: 'evil.example' })), false, 'authenticator data for another site');
  assert.equal(await check(await passkey.signHash(hash, { origin: 'https://evil.example' })), false, 'page on another site');
  assert.equal(await check(await passkey.signHash(hash, { origin: 'https://notenvoi.example' })), false, 'look-alike host');
  assert.equal(await check(await passkey.signHash(hash, { flags: 0x01 })), false, 'user not verified');
  assert.equal(await check(await passkey.signHash(hash, { type: 'webauthn.create' })), false, 'registration, not signing');
  assert.equal(await check(ok, { allowedOrigins: ['https://other.envoi.example'] }), false, 'origin not on the allow list');
  assert.equal(await check(ok, { allowedOrigins: [ORIGIN] }), true);
  const flipped = fromBase64Url(ok.signature);
  flipped[flipped.length - 1] ^= 1;
  assert.equal(await check({ ...ok, signature: toBase64Url(flipped) }), false, 'signature byte');
  const stranger = await softwarePasskey();
  assert.equal(await check(ok, { publicKey: stranger.publicKey }), false, 'other device');
  assert.equal(await check(ok, { publicKey: '02' + passkey.publicKey.slice(2, 66) }), false, 'compressed key');
});

test('tampering with a passkey proof fails it', async () => {
  const cases = {
    'rule edited after signing': p => { p.permission.document.display[0] += '!'; },
    'claims a demo-device signature': p => { p.permission.keyType = 'demo_device'; },
    'unknown key type': p => { p.permission.keyType = 'hardware'; },
    'rp id changed': p => { p.permission.rpId = 'evil.example'; },
    'other passkey swapped in': async (p, { permissionHash }) => {
      const stranger = await softwarePasskey();
      p.permission.ownerKey = stranger.publicKey;
      p.permission.signature = await stranger.signHash(permissionHash);
    }
  };
  for (const [name, edit] of Object.entries(cases)) {
    await withFixture({}, async f => {
      await edit(f.proof, f);
      assert.equal((await checkProof(f.proof, f.trust)).verdict, 'failed', name);
    });
  }
});

test('a passkey that was never listed on the record fails the registry check', () => withFixture({ listOwnerKeyAs: 'none' }, async ({ proof, trust }) => {
  const result = await checkProof(proof, trust);
  assert.equal(statusOf(result, 'owner_signature'), 'PASS');
  assert.equal(statusOf(result, 'registry'), 'FAIL');
}));

test('envoi\'s key must be on the evidence list, before the record, and not revoked before it', async () => {
  await withFixture({ keyListedAt: 200 }, async ({ proof, trust }) => {
    assert.equal(statusOf(await checkProof(proof, trust), 'envoi_signature'), 'FAIL', 'listed after the record');
  });
  await withFixture({ revokeKeyAt: 80 }, async ({ proof, trust }) => {
    assert.equal(statusOf(await checkProof(proof, trust), 'envoi_signature'), 'FAIL', 'revoked before the record');
  });
  await withFixture({ revokeKeyAt: 500 }, async ({ proof, trust }) => {
    assert.equal(statusOf(await checkProof(proof, trust), 'envoi_signature'), 'PASS', 'revoked after the record');
  });
  await withFixture({}, async ({ proof, trust }) => {
    proof.envoi.keyId = 'ev-9';
    assert.equal(statusOf(await checkProof(proof, trust), 'envoi_signature'), 'FAIL', 'key id not listed');
  });
  await withFixture({}, async ({ proof, trust }) => {
    const impostor = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
    proof.envoi.publicKey = await publicHex(impostor.publicKey);
    proof.envoi.signature = await sign(impostor.privateKey, proof.recordHash);
    assert.equal(statusOf(await checkProof(proof, trust), 'envoi_signature'), 'FAIL', 'different key under the same id');
  });
  await withFixture({}, async ({ proof, trust }) => {
    proof.envoi.registry = { network: 'near-mainnet', contract: 'record.envoi.near' };
    assert.equal(statusOf(await checkProof(proof, trust), 'envoi_signature'), 'FAIL', 'names a different record contract');
  });
  await withFixture({}, async ({ proof, trust }) => {
    const { evidenceRegistry, ...noRegistry } = trust;
    assert.equal(statusOf(await checkProof(proof, noRegistry), 'envoi_signature'), 'FAIL', 'no source of trust for envoi\'s key');
  });
});

test('a pinned key map still overrides the evidence list', () => withFixture({ keyListedAt: 200 }, async ({ proof, trust }) => {
  const result = await checkProof(proof, { ...trust, evidenceKeys: { 'ev-1': proof.envoi.publicKey } });
  assert.equal(statusOf(result, 'envoi_signature'), 'PASS');
}));

test('the local registries enforce the contract\'s key rules', async () => {
  const adapters = createLocalAdapters(':memory:', () => 1);
  try {
    const passkey = await softwarePasskey();
    await assert.rejects(adapters.ownerRegistry.register(owner, { type: 'passkey', label: 'x', publicKey: 'ab'.repeat(32) }));
    await assert.rejects(adapters.ownerRegistry.register(owner, { type: 'demo_device', label: 'x', publicKey: passkey.publicKey }));
    await assert.rejects(adapters.ownerRegistry.register(owner, { type: 'hardware', label: 'x', publicKey: 'ab'.repeat(32) }));
    await adapters.ownerRegistry.register(owner, { type: 'passkey', label: 'MacBook', publicKey: passkey.publicKey });
    assert.equal((await adapters.ownerRegistry.lookup(owner, passkey.publicKey)).type, 'passkey');
    await adapters.evidenceRegistry.register('ev-1', 'cd'.repeat(32));
    await assert.rejects(adapters.evidenceRegistry.register('ev-1', 'ef'.repeat(32)), /already used/);
    await assert.rejects(adapters.evidenceRegistry.register('EV 1', 'ef'.repeat(32)));
  } finally { adapters.db.close(); }
});

test('NEAR readers map the contract\'s evidence_key view', async () => {
  const replies = {
    'ev-1': { public_key: 'cd'.repeat(32), registered_at_ms: 10, revoked_at_ms: null },
    'ev-2': { public_key: 'ef'.repeat(32), registered_at_ms: 10, revoked_at_ms: 20 },
    'ev-3': null
  };
  const fetcher = async (_url, init) => {
    const { params } = JSON.parse(init.body);
    assert.equal(params.method_name, 'evidence_key');
    const { key_id } = JSON.parse(atob(params.args_base64));
    const bytes = Array.from(new TextEncoder().encode(JSON.stringify(replies[key_id])));
    return new Response(JSON.stringify({ result: { result: bytes } }), { status: 200 });
  };
  const { evidenceRegistry } = nearReaders({ rpcUrl: 'https://rpc.example', recordContract: 'record.testnet', spendContract: 'spend.testnet', publisher: 'pub.testnet', fetcher });
  assert.deepEqual(await evidenceRegistry.lookup('ev-1'), { publicKey: 'cd'.repeat(32), registeredAtMs: 10 });
  assert.deepEqual(await evidenceRegistry.lookup('ev-2'), { publicKey: 'ef'.repeat(32), registeredAtMs: 10, revokedAtMs: 20 });
  assert.equal(await evidenceRegistry.lookup('ev-3'), null);
});

test('the checker site serves the passkey modules to the browser', async () => {
  const server = await serveChecker({ evidenceKeys: {}, genuine: {}, edited: {} }, 0);
  try {
    for (const route of ['/packages/core/webauthn.mjs', '/packages/core/passkey.mjs']) {
      let status;
      server.emit('request', { url: route, method: 'GET' }, { setHeader() {}, writeHead(code) { status = code; return this; }, end() {} });
      assert.equal(status, 200, route);
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});
