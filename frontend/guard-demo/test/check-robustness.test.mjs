// Checker cases beyond the twelve tamper classes in core.test.mjs: proofs pointing at the wrong
// batch or contract, owner keys listed late or revoked, files that aren't proofs, NEAR outages,
// RPC fallback, and the CLI's exit codes.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { hashJson, publicHex, sign } from '../packages/core/crypto.mjs';
import { displayPermission } from '../packages/core/policy.mjs';
import { buildTree, ZERO_ROOT } from '../packages/core/tree.mjs';
import { makeEvidence } from '../packages/core/evidence.mjs';
import { checkProof } from '../packages/check/index.mjs';
import { VERDICT_MESSAGES } from '../packages/check/messages.mjs';
import { createLocalAdapters } from '../adapters/local/store.mjs';
import { nearReaders } from '../adapters/near/read.mjs';
import { createRpc, isNearUnavailable, NearUnavailable } from '../adapters/near/rpc.mjs';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../packages/check/cli.mjs', import.meta.url));
const keys = () => crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
const owner = 'dana.northwind.near';
const agent = 'milo.northwind.near';
const to = 'ledger-payee.northwind.near';
const amount = n => String(BigInt(n) * 10n ** 24n);
const statusOf = (result, id) => result.checks.find(row => row.id === id)?.status;

// A genuine, sealed, offline proof for a blocked file share. Options move the owner key listing
// or revocation in time relative to the permission's issuedAtMs (101).
async function fixture({ registerAt = 100, revokeAt } = {}) {
  let now = registerAt;
  const adapters = createLocalAdapters(':memory:', () => now);
  const ownerKeys = await keys();
  const envoiKeys = await keys();
  const ownerKey = await publicHex(ownerKeys.publicKey);
  await adapters.ownerRegistry.register(owner, { type: 'demo_device', label: 'Demo device', publicKey: ownerKey });
  if (revokeAt !== undefined) { now = revokeAt; await adapters.ownerRegistry.revoke(owner, ownerKey); }
  now = 102;
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
  const tree = await buildTree([evidence.recordHash, await hashJson('other record'), await hashJson('third record')]);
  const batch = { batchId: 1, root: tree.root, previousRoot: ZERO_ROOT, count: 3, leafIndex: 0, siblings: tree.path(0) };
  const { txRef } = await adapters.publicRecord.seal(batch);
  const permission = { document, ownerKey, signature: await sign(ownerKeys.privateKey, permissionHash), registry: { network: 'local', contract: 'local-record' } };
  const proof = { format: 'envoi.proof/v1', ...evidence, permission, batch, seal: { network: 'local', contract: 'local-record', txRef } };
  const trust = { evidenceKeys: { 'ev-1': evidence.envoi.publicKey }, ...adapters, recordContract: 'local-record', spendContract: 'local-spend' };
  return { adapters, proof, trust };
}

const withFixture = async (options, fn) => {
  const f = await fixture(options);
  try { await fn(f); } finally { f.adapters.db.close(); }
};

test('the offline baseline is partial only because the contract lock is not checkable locally', () => withFixture({}, async ({ proof, trust }) => {
  const result = await checkProof(proof, trust);
  assert.equal(result.verdict, 'partial');
  assert.deepEqual(result.checks.filter(row => row.status !== 'PASS').map(row => [row.id, row.reason]), [['locked_record', 'not_configured']]);
  assert.equal(result.message, VERDICT_MESSAGES.partial);
  assert.ok(result.checks.every(row => typeof row.message === 'string' && row.message.length > 0));
}));

test('a proof naming a batch that was never sealed fails', () => withFixture({}, async ({ proof, trust }) => {
  proof.batch.batchId = 99;
  const result = await checkProof(proof, trust);
  assert.equal(statusOf(result, 'sealed'), 'FAIL');
  assert.equal(result.verdict, 'failed');
}));

test('a proof sealed in a different record contract fails', () => withFixture({}, async ({ proof, trust }) => {
  proof.seal.contract = 'someone-else-record';
  assert.equal(statusOf(await checkProof(proof, trust), 'sealed'), 'FAIL');
}));

test('a proof claiming a different seal transaction fails', () => withFixture({}, async ({ proof, trust }) => {
  proof.seal.txRef = '00000000-0000-4000-8000-000000000000';
  assert.equal(statusOf(await checkProof(proof, trust), 'sealed'), 'FAIL');
}));

test('an owner key listed after the rule was signed fails the registry check', () => withFixture({ registerAt: 150 }, async ({ proof, trust }) => {
  const result = await checkProof(proof, trust);
  assert.equal(statusOf(result, 'registry'), 'FAIL');
  assert.equal(result.verdict, 'failed');
}));

test('an owner key revoked before the rule was signed fails the registry check', () => withFixture({ revokeAt: 100 }, async ({ proof, trust }) => {
  assert.equal(statusOf(await checkProof(proof, trust), 'registry'), 'FAIL');
}));

test('a key revoked after signing still verifies that earlier rule', () => withFixture({ revokeAt: 200 }, async ({ proof, trust }) => {
  assert.equal(statusOf(await checkProof(proof, trust), 'registry'), 'PASS');
}));

test('files that are not proofs are reported as such', async () => {
  for (const junk of [null, undefined, 'text', 42, [], {}, { format: 'envoi.proof/v1' }, { format: 'other', record: {} }]) {
    const result = await checkProof(junk, {});
    assert.equal(result.verdict, 'failed');
    assert.equal(result.reason, 'bad_file');
    assert.equal(result.message, VERDICT_MESSAGES.bad_file);
  }
});

test('a NEAR outage is "not fully checked", never verified and never failed', () => withFixture({}, async ({ proof, trust }) => {
  const down = async () => { throw new NearUnavailable(); };
  const outage = { ...trust,
    publicRecord: { ...trust.publicRecord, network: 'local', readRoot: down, status: down, describeContract: down },
    ownerRegistry: { ...trust.ownerRegistry, lookup: down } };
  const result = await checkProof(proof, outage);
  assert.equal(result.verdict, 'partial');
  assert.equal(result.reason, 'unavailable');
  assert.equal(result.message, VERDICT_MESSAGES.unavailable);
  for (const id of ['sealed', 'registry']) {
    const row = result.checks.find(r => r.id === id);
    assert.deepEqual([row.status, row.reason], ['SKIP', 'unavailable']);
    assert.match(row.message, /Couldn't reach the public record/);
  }
}));

test('an outage never hides a local tamper', () => withFixture({}, async ({ proof, trust }) => {
  const down = async () => { throw new NearUnavailable(); };
  proof.record.summary += '!';
  const result = await checkProof(proof, { ...trust, publicRecord: { ...trust.publicRecord, readRoot: down } });
  assert.equal(result.verdict, 'failed');
}));

test('a genuine NEAR refusal is still a failure, not an outage', () => withFixture({}, async ({ proof, trust }) => {
  const refused = async () => { const error = new Error('UNKNOWN_ACCOUNT'); error.rpcError = 'UNKNOWN_ACCOUNT'; throw error; };
  const result = await checkProof(proof, { ...trust, publicRecord: { ...trust.publicRecord, readRoot: refused } });
  assert.equal(statusOf(result, 'sealed'), 'FAIL');
  assert.equal(result.verdict, 'failed');
}));

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('RPC falls back to the next URL on outages only', async () => {
  const calls = [];
  const fetcher = async url => {
    calls.push(url);
    if (url === 'https://a.example') throw new TypeError('fetch failed');
    if (url === 'https://b.example') return jsonResponse({}, 503);
    if (url === 'https://c.example') return jsonResponse({ error: { cause: { name: 'TIMEOUT_ERROR' } } });
    return jsonResponse({ result: { ok: true } });
  };
  const rpc = createRpc(['https://a.example', 'https://b.example', 'https://c.example', 'https://d.example'], fetcher);
  assert.deepEqual(await rpc('status', []), { ok: true });
  assert.deepEqual(calls, ['https://a.example', 'https://b.example', 'https://c.example', 'https://d.example']);

  const refusing = createRpc(['https://x.example', 'https://y.example'], async url => {
    calls.push(url);
    return jsonResponse({ error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT' } } });
  });
  calls.length = 0;
  await assert.rejects(refusing('query', {}), error => error.rpcError === 'UNKNOWN_ACCOUNT' && !isNearUnavailable(error));
  assert.deepEqual(calls, ['https://x.example'], 'a real answer must not be retried elsewhere');

  const allDown = createRpc(['https://x.example', 'https://y.example'], async () => { throw new TypeError('fetch failed'); });
  await assert.rejects(allDown('query', {}), error => isNearUnavailable(error));
});

test('NEAR readers report an unreachable network as unavailable', async () => {
  const readers = nearReaders({ rpcUrl: ['https://x.example'], recordContract: 'record.testnet', spendContract: 'spend.testnet',
    publisher: 'pub.testnet', fetcher: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(readers.publicRecord.readRoot(1), error => isNearUnavailable(error));
});

test('CLI exit codes separate verified, failed, partial and bad files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'envoi-check-'));
  await withFixture({}, async ({ proof, trust }) => {
    const keysFile = join(dir, 'keys.json');
    await writeFile(keysFile, JSON.stringify(trust.evidenceKeys));
    const write = async (name, value) => { const file = join(dir, name); await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
    const exec = async args => {
      try { const { stdout } = await run(process.execPath, [cli, ...args]); return { code: 0, stdout }; }
      catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
    };
    const genuine = await exec([await write('genuine.json', proof), keysFile]);
    assert.equal(genuine.code, 2, 'offline is partial');
    assert.match(genuine.stdout, /Signatures check out/);
    assert.match(genuine.stdout, /✓ Recorded by envoi/);

    const edited = structuredClone(proof);
    edited.record.summary += '!';
    const tampered = await exec([await write('tampered.json', edited), keysFile]);
    assert.equal(tampered.code, 1);
    assert.match(tampered.stdout, /This record can't be trusted\./);

    const bad = await exec([await write('bad.json', 'not json'), keysFile]);
    assert.equal(bad.code, 3);
    assert.match(bad.stdout, /This isn't an envoi proof file\./);

    const notProof = await exec([await write('other.json', { hello: 'world' }), keysFile]);
    assert.equal(notProof.code, 3);

    const asJson = await exec([join(dir, 'genuine.json'), keysFile, '--json']);
    assert.equal(JSON.parse(asJson.stdout).verdict, 'partial');

    assert.equal((await exec([])).code, 3);
    assert.equal((await exec([join(dir, 'genuine.json'), keysFile, '--testnet', '--mainnet'])).code, 3);
    assert.equal((await exec([join(dir, 'genuine.json'), keysFile, '--bogus'])).code, 3);
  });
});
