import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { authorizationServerMetadata, clientMetadataRejection, createAuthorizationRequestSealer,
  createAuthorizeRequestHandler, createClientResolver } from '../src/agent-remote-auth.js';
import { authenticateClient } from '../src/agent-remote-auth-token.js';
import { api, connect, exchange, freshOwner, remoteServer, documents, edit,
  accessParts, PAST, publicClient, refreshParams, tokenPost, assertTokenResponse } from './agent-remote-auth-token-harness.js';

const read = async file => JSON.parse(await readFile(new URL(file, import.meta.url), 'utf8'));
const registry = await read('./contract-fixtures/index.json');
const entry = registry.contracts.find(row => row.id === 'agent-remote-auth-cimd-grants');
const rows = await Promise.all(entry.fixtures.map(file => read('./contract-fixtures/' + entry.dir + '/' + file)));
const current = rows.find(row => row.id === 'current-chatgpt-extra-grant').document;
const origin = 'https://www.envoi-agents.com', flags = { remoteMcpOAuth: true };
for (const row of rows) test('CIMD grant validator: ' + row.id, () => {
  assert.equal(clientMetadataRejection(row.document, row.document.client_id), row.expected.valid ? null : row.expected.rejection);
});
test('additional grants retain public authentication and all other identity checks', async () => {
  const resolver = createClientResolver({ origin, flags, fetchClientMetadata: async () => ({ document: current }), observe: () => {} });
  const auth = await authenticateClient({ bodyClientId: current.client_id, resolveClient: resolver });
  assert.equal(auth.client.tokenEndpointAuthMethod, 'none');
  assert.equal(auth.client.bootstrapCode, false);
  assert.deepEqual(authorizationServerMetadata(origin, flags).grant_types_supported, ['authorization_code', 'refresh_token']);
  assert.equal(clientMetadataRejection({ ...current, grant_types: ['authorization_code', 'implicit'] }, current.client_id), null);
  for (const [patch, rejection] of [
    [{ client_id: 'https://wrong.example/client.json' }, 'client_id_mismatch'],
    [{ redirect_uris: ['https://127.0.0.1/callback'] }, 'redirect_uris_invalid'],
    [{ token_endpoint_auth_methods_supported: ['private_key_jwt'] }, 'auth_method_not_none'],
    [{ response_types: ['token'] }, 'response_types_invalid']
  ]) assert.equal(clientMetadataRejection({ ...current, ...patch }, current.client_id), rejection);
  const sparse = ['authorization_code']; sparse.length = 2;
  assert.equal(clientMetadataRejection({ ...current, grant_types: sparse }, current.client_id), 'grant_types_invalid');
});
test('client-rejection diagnostics are bounded, private and cannot alter authorization', async () => {
  const records = []; let fetches = 0;
  const resolver = createClientResolver({ origin, flags, observe: value => records.push(value),
    fetchClientMetadata: async () => { fetches++; return { document: { ...current, grant_types: ['refresh_token'], private: 'DO_NOT_LOG' } }; } });
  assert.equal(await resolver(current.client_id), null);
  assert.equal(await resolver(current.client_id), null);
  assert.equal(fetches, 2, 'rejected metadata is never cached');
  assert.equal(records[0].event, 'envoi.oauth_client_rejected');
  assert.equal(records[0].reason, 'grant_types_invalid');
  assert.match(records[0].clientIdHash, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(records).includes(current.client_id));
  assert.ok(!JSON.stringify(records).includes('DO_NOT_LOG'));
  const throwing = createClientResolver({ origin, flags, observe: () => { throw Error('DO_NOT_LOG'); },
    fetchClientMetadata: async () => ({ rejection: 'DO_NOT_LOG' }) });
  assert.equal(await throwing(current.client_id), null);
  assert.equal(await resolver('https://unsafe.example/client.json?secret=DO_NOT_LOG'), null);
  assert.ok(!JSON.stringify(records).includes('DO_NOT_LOG'));
});
test('actual local HTTP authorization accepts the current client and preserves PKCE/resource checks', async t => {
  const fixture = await read('./contract-fixtures/agent-remote-auth/authorize-redirects-to-consent.json');
  const resolveClient = createClientResolver({ origin, flags, observe: () => {},
    fetchClientMetadata: async () => ({ document: current }) });
  const handler = createAuthorizeRequestHandler({ origin, flags, resolveClient,
    sealer: createAuthorizationRequestSealer({ keyMaterial: crypto.randomBytes(32) }) });
  const server = createServer(async (req, res) => {
    try { const out = await handler(new URL(req.url, origin).searchParams); res.writeHead(302, { location: out.location }); res.end(); }
    catch { res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const query = new URL(fixture.request.path, origin).searchParams;
  query.set('client_id', current.client_id); query.set('redirect_uri', current.redirect_uris[0]);
  const request = async params => fetch('http://127.0.0.1:' + server.address().port + '/oauth/authorize?' + params, { redirect: 'manual' });
  const accepted = await request(query);
  assert.equal(accepted.status, 302);
  assert.ok(new URL(accepted.headers.get('location')).searchParams.has('request'));
  for (const [field, value, error] of [['code_challenge_method', 'plain', 'invalid_request'], ['resource', 'https://wrong.example/mcp', 'invalid_target']]) {
    const bad = new URLSearchParams(query); bad.set(field, value);
    assert.equal(new URL((await request(bad)).headers.get('location')).searchParams.get('error'), error);
  }
});
test('local token endpoint still refuses unsupported grants and refreshes the existing family', { timeout: 30000 }, async t => {
  // Real FileStore HTTP/token lifecycle; the metadata authorization test above
  // injects public metadata. No live host or production credentials are used.
  const server = await remoteServer(t, { name: 'FileStore', env: {} });
  for (const grant_type of ['urn:ietf:params:oauth:grant-type:jwt-bearer', 'client_credentials', 'password', 'implicit']) {
    const denied = await tokenPost(server, { grant_type, client_id: publicClient.clientId });
    assert.equal(denied.payload.error, 'unsupported_grant_type');
  }
  const who = await freshOwner(server), grant = await connect(server, who);
  const tokens = assertTokenResponse(await exchange(server, grant));
  const docs = documents(t, server);
  const info = token => api(server.baseUrl, '/mcp', { token, headers: { accept: 'application/json, text/event-stream' },
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'envoi_agent_info', arguments: {} } } });
  const originalInfo = JSON.parse((await info(tokens.access_token)).payload.result.content[0].text);
  await edit(docs, accessParts(tokens.access_token), row => ({ ...row, expiresAt: PAST }));
  const expired = await info(tokens.access_token);
  assert.equal(expired.status, 401); assert.match(expired.headers.get('www-authenticate'), /invalid_token/);
  const next = assertTokenResponse(await tokenPost(server, refreshParams(publicClient, tokens.refresh_token)));
  const good = await info(next.access_token);
  assert.equal(good.status, 200);
  const data = JSON.parse(good.payload.result.content[0].text);
  assert.equal(data.address, originalInfo.address);
  assert.equal(data.agentId, originalInfo.agentId);
});
