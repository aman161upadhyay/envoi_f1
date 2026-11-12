// The key-free verification commands: verify:deployment (fake NEAR state) and check:run
// (local proofs, plus the CLI's exit codes).
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { NearUnavailable } from '../adapters/near/rpc.mjs';
import { createLocalAdapters } from '../adapters/local/store.mjs';
import { hashJson, publicHex, sign } from '../packages/core/crypto.mjs';
import { displayPermission } from '../packages/core/policy.mjs';
import { buildTree, ZERO_ROOT } from '../packages/core/tree.mjs';
import { makeEvidence } from '../packages/core/evidence.mjs';
import { deploymentAccounts, verifyDeployment } from '../packages/check/deployment.mjs';
import { checkRun, editProof, proofsInRun } from '../packages/check/run.mjs';

const run = promisify(execFile);
const accounts = deploymentAccounts({ owner: 'demo.testnet' });
const R = n => String(n).repeat(64);
const bytes = value => Array.from(new TextEncoder().encode(JSON.stringify(value)));
const fc = (receiver, methods) => ({ access_key: { permission: { FunctionCall: { receiver_id: receiver, method_names: methods } } } });
const full = { access_key: { permission: 'FullAccess' } };

function fakeChain(overrides = {}) {
  const state = {
    chain: 'testnet',
    keys: { [accounts.agent]: [fc(accounts.spend, ['pay'])], [accounts.publisher]: [full, fc(accounts.record, ['seal', 'register_evidence_key'])], [accounts.record]: [] },
    roots: { 1: { root: R(1), previous_root: ZERO_ROOT, count: 2 }, 2: { root: R(2), previous_root: R(1), count: 1 } },
    last: [2, R(2)],
    publisher: accounts.publisher,
    vault: height => '2000000000000000000000000',
    seals: { SEALTX: { batch_id: 2, root: R(2), previous_root: R(1), count: 1 } },
    ...overrides
  };
  const rpc = async (method, params) => {
    if (state.down) throw new NearUnavailable();
    if (method === 'status') return { chain_id: state.chain };
    if (method === 'EXPERIMENTAL_protocol_config') return { runtime_config: { storage_amount_per_byte: '10000000000000000000' } };
    if (method === 'block') return { header: { height: 1000 } };
    if (method === 'tx') {
      const args = state.seals[params.tx_hash];
      return { final_execution_status: 'FINAL', status: { SuccessValue: '' }, transaction_outcome: { block_hash: 'B' },
        transaction: { receiver_id: accounts.record, actions: [{ FunctionCall: { method_name: 'seal', args: btoa(JSON.stringify(args)) } }] } };
    }
    if (params.request_type === 'view_account') return { code_hash: params.account_id.startsWith('record.') ? 'RecordHash' : params.account_id.startsWith('spend.') ? 'SpendHash' : '11111111111111111111111111111111', amount: String(10n ** 24n), storage_usage: 1000 };
    if (params.request_type === 'view_access_key_list') return { keys: state.keys[params.account_id] ?? [full] };
    if (params.request_type === 'call_function') {
      const args = JSON.parse(atob(params.args_base64));
      const reply = { publisher: state.publisher, evidence_key: null, last: state.last, root_of: state.roots[args.batch_id] ?? null,
        vault_of: params.block_id !== undefined ? state.vault(params.block_id) : '0' }[params.method_name];
      return { result: bytes(reply) };
    }
    throw new Error('unexpected ' + method);
  };
  const readers = { spendGuard: { readOutcome: async tx => (tx === 'REFUSED' ? { status: 'refused', reason: 'not_payee', amount: '20000000000000000000000000', to: 'attacker.testnet' } : { status: 'paid', amount: '1', to: 'ledger.testnet' }) } };
  return { rpc, archivalRpc: rpc, readers, state };
}

const verify = (chain, options = {}) => verifyDeployment({ accounts, ...chain, expectedRecordHash: 'RecordHash', ...options });
const statusOf = (result, id) => result.rows.find(row => row.id === id)?.status;

test('a matching, locked deployment verifies', async () => {
  const result = await verify(fakeChain(), { seals: ['SEALTX'], refusals: ['REFUSED'] });
  assert.equal(result.verdict, 'verified', JSON.stringify(result.rows.filter(r => r.status !== 'PASS')));
  assert.match(result.rows.find(r => r.id === 'batch chain').detail, /2 batches/);
});

test('deployment problems are caught', async () => {
  assert.equal(statusOf(await verify(fakeChain(), { expectedRecordHash: 'Other' }), 'record code'), 'FAIL', 'wrong code hash');
  assert.equal(statusOf(await verify(fakeChain({ chain: 'mainnet' })), 'network'), 'FAIL', 'wrong network');
  const extraKey = fakeChain();
  extraKey.state.keys[accounts.agent].push(full);
  assert.equal(statusOf(await verify(extraKey), 'agent key'), 'FAIL', 'agent holds a full-access key');
  const wideAgent = fakeChain();
  wideAgent.state.keys[accounts.agent] = [fc(accounts.spend, ['pay', 'set_policy'])];
  assert.equal(statusOf(await verify(wideAgent), 'agent key'), 'FAIL', 'agent key can do more than pay');
  const noRegister = fakeChain();
  noRegister.state.keys[accounts.publisher] = [fc(accounts.record, ['seal'])];
  assert.equal(statusOf(await verify(noRegister), 'publisher key'), 'FAIL', 'publisher key without register_evidence_key');
  const broken = fakeChain();
  broken.state.roots[2] = { root: R(2), previous_root: R(9), count: 1 };
  assert.equal(statusOf(await verify(broken), 'batch chain'), 'FAIL', 'broken link');
  const wrongPublisher = fakeChain({ publisher: 'someone.testnet' });
  assert.equal(statusOf(await verify(wrongPublisher), 'record publisher'), 'FAIL');
  const badSeal = fakeChain();
  badSeal.state.seals.SEALTX = { batch_id: 2, root: R(7), previous_root: R(1), count: 1 };
  assert.equal(statusOf(await verify(badSeal, { seals: ['SEALTX'] }), 'seal SEALTX…'), 'FAIL', 'seal arguments differ from root_of');
});

test('refusals must be refused and leave the vault unchanged', async () => {
  assert.equal(statusOf(await verify(fakeChain(), { refusals: ['PAID'] }), 'refusal PAID…'), 'FAIL', 'a paid payment is not a refusal');
  const moved = fakeChain({ vault: height => (height < 1000 ? '2000000000000000000000000' : '1000000000000000000000000') });
  assert.equal(statusOf(await verify(moved, { refusals: ['REFUSED'] }), 'refusal REFUSED…'), 'FAIL', 'vault changed');
});

test('not locked, low storage and outages are "not finished", not failures', async () => {
  const unlocked = fakeChain();
  unlocked.state.keys[accounts.record] = [full];
  const result = await verify(unlocked);
  assert.equal(statusOf(result, 'record lock'), 'WAIT');
  assert.equal(result.verdict, 'partial');
  assert.equal(statusOf(await verify(unlocked, { requireLocked: true }), 'record lock'), 'FAIL');
  const down = await verify(fakeChain({ down: true }));
  assert.equal(down.verdict, 'partial');
  assert.ok(down.rows.every(row => row.status === 'WAIT'));
});

// Local proofs for check:run.
async function localRun() {
  const adapters = createLocalAdapters(':memory:', () => 100);
  const owner = 'dana.northwind.near';
  const agent = 'milo.northwind.near';
  const ownerKeys = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  const envoiKeys = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  const ownerKey = await publicHex(ownerKeys.publicKey);
  await adapters.ownerRegistry.register(owner, { type: 'demo_device', label: 'Demo device', publicKey: ownerKey });
  const payees = [{ account: 'ledger.northwind.near', label: 'Ledger Co', maxPerPayment: '1' }];
  const document = { schema: 'envoi.permissions/v1', owner, agent, version: 1, previousHash: ZERO_ROOT, issuedAtMs: 101,
    rules: { spend_money: { payees, dailyCap: '2', unit: 'yoctoNEAR' }, share_files: { default: 'off', allow: [] }, send_messages: 'allowed' } };
  document.display = displayPermission(document);
  const permissionHash = await hashJson(document);
  await adapters.spendGuard.registerAgent(owner, agent, 'ab'.repeat(32));
  await adapters.spendGuard.setPolicy(owner, agent, { payees, dailyCap: '2', paused: false }, permissionHash);
  const records = [];
  for (const [seq, summary] of [[1, 'Dana signed Milo\'s limits.'], [2, 'Sharing files is Off, so envoi blocked it.']]) {
    records.push(await makeEvidence({ seq, type: seq === 1 ? 'permission_changed' : 'share_blocked', agent, counterparty: 'x.near', caseRef: 'c',
      summary, previousHash: records.at(-1)?.recordHash ?? ZERO_ROOT, permissionHash, createdAtMs: 102 + seq, details: {} }, envoiKeys));
  }
  const tree = await buildTree(records.map(r => r.recordHash));
  const batch = { batchId: 1, root: tree.root, previousRoot: ZERO_ROOT, count: 2 };
  const { txRef } = await adapters.publicRecord.seal(batch);
  const permission = { document, ownerKey, signature: await sign(ownerKeys.privateKey, permissionHash), registry: { network: 'local', contract: 'local-record' } };
  const proofs = records.map((entry, leafIndex) => ({ format: 'envoi.proof/v1', ...entry, permission,
    batch: { ...batch, leafIndex, siblings: tree.path(leafIndex) }, seal: { network: 'local', contract: 'local-record', txRef } }));
  const evidenceKeys = { 'ev-1': records[0].envoi.publicKey };
  const trust = { evidenceKeys, ...adapters, recordContract: 'local-record', spendContract: 'local-spend' };
  return { adapters, run: { status: 'sealed', evidenceKeys, proofs }, trust };
}

test('check:run checks every proof and an edited copy of each', async () => {
  const { adapters, run: file, trust } = await localRun();
  try {
    const result = await checkRun(file, trust);
    assert.equal(result.proofs, 2);
    assert.equal(result.verdict, 'partial', 'locally the contract lock is not checkable');
    assert.ok(result.results.every(row => row.genuine.verdict === 'partial' && row.edited.verdict === 'failed'));
    assert.deepEqual(result.results[0].genuine.notPassed, [{ id: 'locked_record', status: 'SKIP', reason: 'not_configured' }]);

    const tampered = structuredClone(file);
    tampered.proofs[1].record.summary = 'Something else.';
    assert.equal((await checkRun(tampered, trust)).verdict, 'failed', 'a tampered genuine proof');
    assert.equal((await checkRun({ status: 'started', records: [] }, trust)).verdict, 'failed', 'no proofs at all');
  } finally { adapters.db.close(); }
});

test('run files in every shape are read, and the edit changes one field', async () => {
  const proof = { format: 'envoi.proof/v1', record: { summary: 'a' } };
  assert.equal(proofsInRun({ proofs: [proof, proof] }).length, 2);
  assert.equal(proofsInRun({ proof, result: {} }).length, 1);
  assert.equal(proofsInRun([proof]).length, 1);
  assert.equal(proofsInRun(proof).length, 1);
  assert.equal(proofsInRun({ status: 'started' }).length, 0);
  const edited = editProof(proof);
  assert.equal(edited.record.summary, 'a (edited)');
  assert.equal(proof.record.summary, 'a', 'the original stays untouched');
});

test('check:run CLI exit codes', async () => {
  const cli = fileURLToPath(new URL('../scripts/check-run.mjs', import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), 'envoi-run-'));
  const exec = async args => {
    try { const { stdout } = await run(process.execPath, [cli, ...args]); return { code: 0, stdout }; }
    catch (error) { return { code: error.code, stdout: error.stdout }; }
  };
  const { adapters, run: file } = await localRun();
  adapters.db.close();
  const good = join(dir, 'run.json');
  await writeFile(good, JSON.stringify(file));
  const offline = await exec([good, '--offline']);
  assert.equal(offline.code, 2, offline.stdout);
  assert.match(offline.stdout, /edited copy failed/);
  const bad = structuredClone(file);
  bad.proofs[0].record.summary = 'changed';
  const badFile = join(dir, 'bad.json');
  await writeFile(badFile, JSON.stringify(bad));
  assert.equal((await exec([badFile, '--offline'])).code, 1);
  assert.equal((await exec([join(dir, 'missing.json'), '--offline'])).code, 3);
  assert.equal((await exec([])).code, 3);
});
