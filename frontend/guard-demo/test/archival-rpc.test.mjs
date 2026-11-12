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
