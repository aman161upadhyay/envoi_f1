import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { planRemoteMcpAuthorization } from './authorization-plan.mjs';

const fixture = async name => JSON.parse(await readFile(
  new URL(`../../../test/contract-fixtures/agent-remote-auth/${name}.json`, import.meta.url), 'utf8'));

async function inputs() {
  const [resource, server, authorize] = await Promise.all([
    fixture('protected-resource-metadata'),
    fixture('authorization-server-metadata'),
    fixture('authorize-redirects-to-consent'),
  ]);
  return {
    origin: 'https://www.envoi-agents.com',
    protectedResource: resource.response.body,
    authorizationServer: server.response.body,
    clientMetadata: authorize.context.clientMetadataDocument,
    redirectUri: authorize.context.clientMetadataDocument.redirect_uris[0],
    codeVerifier: authorize.context.codeVerifier,
    state: new URL(authorize.request.path, 'https://www.envoi-agents.com').searchParams.get('state'),
    expected: authorize,
  };
}

test('approved remote-auth discovery and PKCE fixture produce the exact authorization request', async () => {
  const { expected, ...input } = await inputs();
  const plan = planRemoteMcpAuthorization(input);
  const expectedUrl = new URL(expected.request.path, input.origin);
  assert.equal(plan.authorizationUrl, expectedUrl.href);
  assert.deepEqual(Object.keys(plan), ['authorizationUrl', 'issuer', 'resource']);
  assert.equal(plan.resource, `${input.origin}/mcp`);
  assert.doesNotMatch(JSON.stringify(plan), new RegExp(input.codeVerifier));
  assert.doesNotMatch(JSON.stringify(plan), /refresh_token|access_token|wake|reachable/i);
});

test('trusted issuer, resource, client and redirect must agree before a browser URL is built', async () => {
  const { expected: _expected, ...input } = await inputs();
  const changes = [
    { origin: 'https://other.example' },
    { origin: 'https://www.envoi-agents.com/path' },
    { protectedResource: { ...input.protectedResource, resource: 'https://other.example/mcp' } },
    { protectedResource: { ...input.protectedResource, scopes_supported: 3 } },
    { protectedResource: { ...input.protectedResource, scopes_supported: undefined } },
    { authorizationServer: { ...input.authorizationServer, issuer: 'https://other.example' } },
    { authorizationServer: { ...input.authorizationServer, scopes_supported: 3 } },
    { authorizationServer: { ...input.authorizationServer, code_challenge_methods_supported: ['plain'] } },
    { authorizationServer: { ...input.authorizationServer, client_id_metadata_document_supported: false } },
    { clientMetadata: { ...input.clientMetadata, client_id: 'http://other.example/client.json' } },
    { clientMetadata: { ...input.clientMetadata, client_id: 'https://127.0.0.1/client.json' } },
    { clientMetadata: { ...input.clientMetadata, token_endpoint_auth_method: 'client_secret_basic' } },
    { redirectUri: 'https://other.example/callback' },
    { redirectUri: 'http://localhost/callback' },
    { redirectUri: 'https://127.0.0.1/callback' },
  ];
  for (const change of changes) {
    assert.throws(() => planRemoteMcpAuthorization({ ...input, ...change }),
      /Invalid remote MCP authorization setup/, JSON.stringify(change));
  }
});

test('the caller must hold a valid private verifier and state; scopes stay within the approved set', async () => {
  const { expected: _expected, ...input } = await inputs();
  for (const codeVerifier of ['short', 'A'.repeat(129), 'A'.repeat(42) + '!']) {
    assert.throws(() => planRemoteMcpAuthorization({ ...input, codeVerifier }), /Invalid remote MCP/);
  }
  for (const state of ['', 'A'.repeat(513), 'line\nbreak']) {
    assert.throws(() => planRemoteMcpAuthorization({ ...input, state }), /Invalid remote MCP/);
  }
  for (const scopes of [[], ['envoi.send'], ['envoi.agent', 'envoi.agent'], ['envoi.agent', 'use_email_transport']]) {
    assert.throws(() => planRemoteMcpAuthorization({ ...input, scopes }), /Invalid remote MCP/);
  }
  const narrowed = planRemoteMcpAuthorization({ ...input, scopes: ['envoi.agent'] });
  assert.equal(new URL(narrowed.authorizationUrl).searchParams.get('scope'), 'envoi.agent');
});

test('valid explicit HTTPS default ports retain the registered redirect string', async () => {
  const { expected: _expected, ...input } = await inputs();
  const clientId = 'https://assistant.example.com:443/oauth/envoi-client.json';
  const redirectUri = 'https://assistant.example.com:443/oauth/callback';
  const plan = planRemoteMcpAuthorization({ ...input, clientMetadata: {
    ...input.clientMetadata, client_id: clientId, redirect_uris: [redirectUri],
  }, redirectUri });
  const params = new URL(plan.authorizationUrl).searchParams;
  assert.equal(params.get('client_id'), clientId);
  assert.equal(params.get('redirect_uri'), redirectUri);
});

test('a hostname containing hex letters remains a valid HTTPS redirect', async () => {
  const { expected: _expected, ...input } = await inputs();
  const redirectUri = 'https://face.example/callback';
  const plan = planRemoteMcpAuthorization({ ...input, clientMetadata: {
    ...input.clientMetadata, redirect_uris: [redirectUri],
  }, redirectUri });
  assert.equal(new URL(plan.authorizationUrl).searchParams.get('redirect_uri'), redirectUri);
});

// Consume the same approved amendment vectors as the server validator; no copied fixtures.
const cimdRegistry = JSON.parse(await readFile(new URL('../../../test/contract-fixtures/index.json', import.meta.url), 'utf8'));
const cimdEntry = cimdRegistry.contracts.find(contract => contract.id === 'agent-remote-auth-cimd');
const cimdCases = await Promise.all(cimdEntry.fixtures.map(async name => {
  const bytes = await readFile(new URL(`../../../test/contract-fixtures/${cimdEntry.dir}/${name}`, import.meta.url), 'utf8');
  return JSON.parse(bytes);
}));
for (const row of cimdCases) {
  test(`approved CIMD client planner: ${row.id}`, async () => {
    const { expected: _expected, ...input } = await inputs();
    const current = { ...input, clientMetadata: row.document, redirectUri: row.document.redirect_uris[0] };
    if (!row.expected.valid) {
      assert.throws(() => planRemoteMcpAuthorization(current), /Invalid remote MCP authorization setup/);
      return;
    }
    const result = planRemoteMcpAuthorization(current);
    const params = new URL(result.authorizationUrl).searchParams;
    assert.equal(params.get('client_id'), row.document.client_id);
    assert.equal(params.get('redirect_uri'), row.document.redirect_uris[0]);
    assert.equal(params.get('code_challenge_method'), 'S256');
    assert.equal(params.get('resource'), `${input.origin}/mcp`);
    assert.equal(params.get('scope'), 'envoi.agent envoi.send');
    assert.equal(params.has('client_assertion'), false);
    assert.equal(params.has('client_secret'), false);
    assert.equal(JSON.stringify(result).includes(input.codeVerifier), false);
  });
}

const grantEntry = cimdRegistry.contracts.find(contract => contract.id === 'agent-remote-auth-cimd-grants');
for (const file of grantEntry.fixtures) {
  const row = JSON.parse(await readFile(new URL('../../../test/contract-fixtures/' + grantEntry.dir + '/' + file, import.meta.url), 'utf8'));
  test('approved CIMD grant client planner: ' + row.id, async () => {
    const { expected: _expected, ...input } = await inputs();
    const current = { ...input, clientMetadata: row.document, redirectUri: row.document.redirect_uris[0] };
    if (!row.expected.valid) return assert.throws(() => planRemoteMcpAuthorization(current), /Invalid remote MCP authorization setup/);
    const params = new URL(planRemoteMcpAuthorization(current).authorizationUrl).searchParams;
    assert.equal(params.get('response_type'), 'code');
    assert.equal(params.get('code_challenge_method'), 'S256');
    assert.equal(params.get('scope'), 'envoi.agent envoi.send');
    assert.equal(params.has('client_assertion'), false);
  });
}

test('modern public capabilities do not relax trusted issuer, redirect, PKCE or scope checks', async () => {
  const { expected: _expected, ...input } = await inputs();
  const document = cimdCases.find(row => row.id === 'modern-chatgpt-preference').document;
  const current = { ...input, clientMetadata: document, redirectUri: document.redirect_uris[0] };
  const sparseMethods = ['none']; sparseMethods.length = 2;
  for (const edit of [
    { redirectUri: 'https://attacker.invalid/callback' },
    { protectedResource: { ...current.protectedResource, resource: 'https://other.example/mcp' } },
    { authorizationServer: { ...current.authorizationServer, issuer: 'https://other.example' } },
    { codeVerifier: 'short' }, { scopes: ['envoi.agent', 'envoi.email'] },
    { clientMetadata: { ...document, client_id: 'https://127.0.0.1/client.json' } },
    { clientMetadata: { ...document, token_endpoint_auth_methods_supported: sparseMethods } }
  ]) assert.throws(() => planRemoteMcpAuthorization({ ...current, ...edit }), /Invalid remote MCP authorization setup/);
});
