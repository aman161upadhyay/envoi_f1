// Transaction lookups must keep working days after sealing (regular RPC nodes forget old
// transactions), and a made-up transaction hash must fail rather than read "not checked".
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRpc, DEFAULT_ARCHIVAL_RPC, DEFAULT_RPC, isNearUnavailable } from '../adapters/near/rpc.mjs';
import { nearReaders } from '../adapters/near/read.mjs';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const unknownTx = () => json({ error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_TRANSACTION' } } });

test('transaction lookups ask archival nodes first, other calls do not', async () => {
  const calls = [];
  const rpc = createRpc(['https://regular.example'], async url => { calls.push(url); return json({ result: { ok: true } }); },
    { archivalUrls: ['https://archive.example'] });
  await rpc('tx', {});
  await rpc('query', {});
  assert.deepEqual(calls, ['https://archive.example', 'https://regular.example']);
});

test('an unknown transaction is asked of every node before it counts as missing', async () => {
  const calls = [];
  const rpc = createRpc(['https://regular.example'], async url => {
    calls.push(url);
    return url === 'https://archive.example' ? unknownTx() : json({ result: { found: true } });
  }, { archivalUrls: ['https://archive.example'] });
  assert.deepEqual(await rpc('tx', {}), { found: true }, 'an archive trailing by a few blocks');
  assert.deepEqual(calls, ['https://archive.example', 'https://regular.example']);

  const nobody = createRpc(['https://a.example', 'https://b.example'], async () => unknownTx(), { archivalUrls: ['https://archive.example'] });
  await assert.rejects(nobody('tx', {}), error => error.rpcError === 'UNKNOWN_TRANSACTION' && !isNearUnavailable(error));

  const archiveSaysNoRestDown = createRpc(['https://regular.example'], async url => {
    if (url === 'https://archive.example') return unknownTx();
    throw new TypeError('fetch failed');
  }, { archivalUrls: ['https://archive.example'] });
  await assert.rejects(archiveSaysNoRestDown('tx', {}), error => error.rpcError === 'UNKNOWN_TRANSACTION');
});

test('outside transaction lookups an unknown answer is final at once', async () => {
  const calls = [];
  const rpc = createRpc(['https://a.example', 'https://b.example'], async url => { calls.push(url); return unknownTx(); });
  await assert.rejects(rpc('query', {}), error => error.rpcError === 'UNKNOWN_TRANSACTION');
  assert.deepEqual(calls, ['https://a.example']);
});

test('HTTP 408 is an outage, not a refusal', async () => {
  const rpc = createRpc(['https://a.example'], async () => json({}, 408));
  await assert.rejects(rpc('status', []), error => isNearUnavailable(error));
});

test('default endpoints come with their archival nodes; custom URLs do not', async () => {
  for (const network of ['near-testnet', 'near-mainnet']) {
    const calls = [];
    const rpc = createRpc(DEFAULT_RPC[network], async url => { calls.push(url); return json({ result: {} }); });
    await rpc('tx', {});
    assert.equal(calls[0], DEFAULT_ARCHIVAL_RPC[network][0], network);
  }
  const calls = [];
  const proxy = createRpc('/testnet-rpc', async url => { calls.push(url); return json({ result: {} }); });
  await proxy('tx', {});
  assert.deepEqual(calls, ['/testnet-rpc'], 'the browser proxy does its own archival lookups');
});

test('NEAR readers look transactions up without waiting, through archival nodes by default', async () => {
  const seen = [];
  const fetcher = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    seen.push([url, method, params.wait_until]);
    return unknownTx();
  };
  const readers = nearReaders({ recordContract: 'record.testnet', spendContract: 'spend.testnet', publisher: 'pub.testnet', fetcher });
  assert.equal(await readers.publicRecord.status('GhmaBHFUYE6nojGAApmUiAT5tEjfqz3Aq1hNHNN8Po28').catch(error => error.rpcError), 'UNKNOWN_TRANSACTION');
  assert.equal(seen[0][0], DEFAULT_ARCHIVAL_RPC['near-testnet'][0]);
  assert.ok(seen.every(([, method, wait]) => method === 'tx' && wait === 'NONE'));

  seen.length = 0;
  const custom = nearReaders({ rpcUrl: 'https://my-node.example', recordContract: 'record.testnet', spendContract: 'spend.testnet', publisher: 'pub.testnet', fetcher });
  await custom.publicRecord.status('GhmaBHFUYE6nojGAApmUiAT5tEjfqz3Aq1hNHNN8Po28').catch(() => {});
  assert.deepEqual(seen.map(([url]) => url), ['https://my-node.example'], 'NEAR_RPC_URL pins one endpoint');
});

// End to end through the checker: the same genuine proof, with NEAR either unreachable or
// denying the seal transaction exists, must give two different verdicts.
test('checker: an unreachable NEAR and a missing seal transaction give distinct verdicts', async () => {
  const { hashJson, publicHex, sign } = await import('../packages/core/crypto.mjs');
  const { displayPermission } = await import('../packages/core/policy.mjs');
  const { buildTree, ZERO_ROOT } = await import('../packages/core/tree.mjs');
  const { makeEvidence } = await import('../packages/core/evidence.mjs');
  const { checkProof } = await import('../packages/check/index.mjs');
  const { createLocalAdapters } = await import('../adapters/local/store.mjs');
  const owner = 'dana.northwind.near';
  const agent = 'milo.northwind.near';
  const adapters = createLocalAdapters(':memory:', () => 100);
  try {
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
    const evidence = await makeEvidence({ seq: 1, type: 'share_blocked', agent, counterparty: 'x.near', caseRef: 'c', summary: 's',
      previousHash: ZERO_ROOT, permissionHash, createdAtMs: 103, details: {} }, envoiKeys);
    const tree = await buildTree([evidence.recordHash]);
    const batch = { batchId: 4, root: tree.root, previousRoot: ZERO_ROOT, count: 1, leafIndex: 0, siblings: tree.path(0) };
    const proof = { format: 'envoi.proof/v1', ...evidence, batch,
      permission: { document, ownerKey, signature: await sign(ownerKeys.privateKey, permissionHash), registry: { network: 'local', contract: 'record.testnet' } },
      seal: { network: 'near-testnet', contract: 'record.testnet', txRef: '6X5bHczCKB6Fn6U4jtAEHH9JS6WLGnrdAf5abNdEAy4F' } };
    const rootBytes = Array.from(new TextEncoder().encode(JSON.stringify({ root: batch.root, previous_root: ZERO_ROOT, count: 1, sealed_at_ms: 104 })));
    const verdictWith = async txReply => {
      const fetcher = async (_url, init) => {
        const { method, params } = JSON.parse(init.body);
        if (method === 'query' && params.request_type === 'view_account') return json({ result: { code_hash: 'CodeHash1111' } });
        if (method === 'query' && params.request_type === 'view_access_key_list') return json({ result: { keys: [] } });
        if (method === 'query') return json({ result: { result: rootBytes } });
        return txReply();
      };
      const near = nearReaders({ recordContract: 'record.testnet', spendContract: 'spend.testnet', publisher: 'pub.testnet', fetcher });
      return checkProof(proof, { evidenceKeys: { 'ev-1': evidence.envoi.publicKey }, ...adapters, publicRecord: near.publicRecord,
        recordContract: 'record.testnet', recordCodeHash: 'CodeHash1111', spendContract: 'local-spend' });
    };
    const down = await verdictWith(async () => { throw new TypeError('fetch failed'); });
    if (down.verdict !== 'partial') console.log('DEBUG', JSON.stringify(down.checks.map(c => [c.id, c.status, c.reason])));
    assert.equal(down.verdict, 'partial');
    assert.equal(down.reason, 'unavailable');
    const missing = await verdictWith(unknownTx);
    assert.equal(missing.verdict, 'failed');
    assert.equal(missing.checks.find(row => row.id === 'sealed').status, 'FAIL');
  } finally { adapters.db.close(); }
});
