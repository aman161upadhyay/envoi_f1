// agent-remote-auth v1 (revision 2) §2-§4, task RA-A1: discovery, clients and the authorization request.
// Module checks consume the published fixtures; server checks drive the real routes with the flags set
// only in this test's child process. Nothing here registers a provider or calls a real host.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  authorizationServerMetadata, clientIdUrlRejection, clientMetadataCacheSeconds, clientMetadataRejection, createAuthorizationRequestSealer,
  createAuthorizeRequestHandler, createClientMetadataFetch, createClientResolver, parsePreRegisteredClients, protectedResourceMetadata,
  redirectMatches, redirectUriRejection, remoteAuthEndpointServed, remoteAuthLimits
} from '../src/agent-remote-auth.js';
import { createWakeDestination } from '../src/http-wake-destination.js';
import { onboardingFlagErrors, readOnboardingFlags, routeAvailability } from '../src/onboarding-flags.js';
import { launch, owner } from './a3-harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, 'contract-fixtures', 'agent-remote-auth');
const fixture = async name => JSON.parse(await readFile(path.join(fixtureDir, `${name}.json`), 'utf8'));
const schemas = await fixture('schemas');
const origin = 'https://www.envoi-agents.com';
const flagsOf = entry => readOnboardingFlags({ ENVOI_PUBLIC_URL: origin, ...Object.fromEntries(Object.entries(entry.flags).map(([name, on]) => [name, String(on)])) });
const keyMaterial = crypto.createHash('sha256').update('agent-remote-auth test key').digest();

test('discovery documents equal the fixtures', async () => {
  for (const name of ['protected-resource-metadata', 'protected-resource-metadata-root']) {
    const entry = await fixture(name);
    assert.deepEqual(protectedResourceMetadata(origin), entry.response.body, name);
    assert.equal(entry.response.headers['cache-control'], remoteAuthLimits.metadataCacheControl);
  }
  const server = await fixture('authorization-server-metadata');
  assert.deepEqual(authorizationServerMetadata(origin, flagsOf(server)), server.response.body);
  const remoteOnly = authorizationServerMetadata(origin, { remoteMcpOAuth: true });
  assert.deepEqual(remoteOnly.grant_types_supported, ['authorization_code', 'refresh_token'], 'the bootstrap grant only with provider connectors');
  assert.equal(authorizationServerMetadata(origin, { providerConnectors: true }).client_id_metadata_document_supported, false, 'metadata documents only with remote MCP');
  assert.ok(!('registration_endpoint' in remoteOnly) && !('jwks_uri' in remoteOnly), 'no DCR and no JWKS');
});

test('routes availability equals the remote-auth fixtures, and public routes stay closed', async () => {
  for (const name of ['routes-available-remote-mcp', 'routes-available-provider']) {
    const entry = await fixture(name);
    assert.deepEqual(routeAvailability(flagsOf(entry), entry.response.body.asOf), entry.response.body, name);
  }
});

// M2 follow-up (#34 6355820671): which flag serves each endpoint comes from x-endpoints, for every flag combination.
test('each endpoint is served exactly by the flags x-endpoints names', () => {
  const combinations = [{}, { remoteMcpOAuth: true }, { providerConnectors: true }, { remoteMcpOAuth: true, providerConnectors: true }];
  for (const endpoint of schemas['x-endpoints']) {
    for (const flags of combinations) {
      const expected = endpoint.flags === 'ENVOI_PROVIDER_CONNECTORS' ? Boolean(flags.providerConnectors) : Boolean(flags.remoteMcpOAuth || flags.providerConnectors);
      assert.ok(['either route flag', 'ENVOI_PROVIDER_CONNECTORS'].includes(endpoint.flags), `known flags value for ${endpoint.path}`);
      assert.equal(remoteAuthEndpointServed(endpoint.path.replace('{handle}', 'v1.x'), flags), expected, `${endpoint.method} ${endpoint.path} with ${JSON.stringify(flags)}`);
    }
  }
});

test('remote route flags are strict and fail closed without their dependencies', () => {
  const core = { ENVOI_AGENT_REGISTRATION_V2: 'true', ENVOI_INSTALLATIONS_V2: 'true', ENVOI_PUBLIC_URL: origin };
  assert.deepEqual(readOnboardingFlags({}), { installations: false, registration: false, authenticatedRest: false, caseSessions: false, httpWake: false }, 'default off, unchanged shape');
  assert.equal(readOnboardingFlags({ ...core, ENVOI_REMOTE_MCP_OAUTH: 'true' }).remoteMcpOAuth, true);
  assert.equal(readOnboardingFlags({ ...core, ENVOI_PROVIDER_CONNECTORS: 'true' }).providerConnectors, true);
  for (const name of ['ENVOI_REMOTE_MCP_OAUTH', 'ENVOI_PROVIDER_CONNECTORS']) {
    assert.deepEqual(onboardingFlagErrors({ ...core, [name]: 'TRUE' }), [`${name} must be true or false`]);
    assert.match(onboardingFlagErrors({ [name]: 'true', ENVOI_PUBLIC_URL: origin }).join(), new RegExp(`${name} requires ENVOI_AGENT_REGISTRATION_V2 and ENVOI_INSTALLATIONS_V2`));
    for (const url of [undefined, '', 'not a url', 'http://www.envoi-agents.com', 'https://www.envoi-agents.com/app', 'https://user@www.envoi-agents.com', 'http://localhost:8787']) {
      assert.match(onboardingFlagErrors({ ...core, ENVOI_PUBLIC_URL: url, [name]: 'true' }).join(), /requires ENVOI_PUBLIC_URL/, `${name} refuses ENVOI_PUBLIC_URL ${url}`);
    }
    assert.deepEqual(onboardingFlagErrors({ ...core, ENVOI_PUBLIC_URL: 'http://127.0.0.1:8443', [name]: 'true' }), [], 'a loopback http origin is allowed for local tests');
  }
});

// A resolver whose metadata fetch returns the fixture's document, or fails when the fixture has none.
const fixtureResolver = (entry, options = {}) => createClientResolver({
  origin, flags: flagsOf(entry), preRegistered: options.preRegistered || new Map(),
  fetchClientMetadata: async () => (entry.context?.clientMetadataDocument ? { document: entry.context.clientMetadataDocument, cacheControl: 'max-age=600' } : { rejection: 'fetch_failed' })
});

test('every authorize fixture: the same checks, in order, give the contracted redirect', async () => {
  const names = (await readdir(fixtureDir)).filter(name => name.startsWith('authorize-')).map(name => name.replace(/\.json$/, ''));
  assert.equal(names.length, 12, 'all twelve authorize fixtures (revision 3 adds the two check-11 cases)');
  const realSealer = createAuthorizationRequestSealer({ keyMaterial });
  for (const name of names) {
    const entry = await fixture(name);
    const url = new URL(entry.request.path, origin);
    // Check 11's fixtures state the encoded length the server would issue (context.sealedHandleLength), because the
    // exact length depends on this implementation's sealing format. Seal to exactly that length here; the real
    // encoding's boundary is covered by the check-11 test below.
    const length = entry.context?.sealedHandleLength;
    const sealer = length ? { seal: () => `v1.${'A'.repeat(length - 3)}`, open: () => null } : realSealer;
    const handler = createAuthorizeRequestHandler({ origin, flags: flagsOf(entry), resolveClient: fixtureResolver(entry), sealer });
    const outcome = await handler(url.searchParams);
    if (entry.response.status === 404) {
      assert.deepEqual(outcome, { featureDisabled: true }, name);
      assert.equal(entry.response.body.code, 'FEATURE_DISABLED');
      continue;
    }
    const expected = entry.response.headers.location;
    if (!expected.includes('PLACEHOLDER_authorization_request_handle')) {
      assert.equal(outcome.location, expected, name);
      continue;
    }
    // Success: a sealed handle that binds the validated request, and nothing else in the URL.
    const location = new URL(outcome.location);
    assert.equal(`${location.origin}${location.pathname}`, `${origin}/authorize-agent`, name);
    assert.deepEqual([...location.searchParams.keys()], ['request'], `${name}: only the handle`);
    const handle = location.searchParams.get('request');
    assert.ok(handle.length <= remoteAuthLimits.authorizationRequestHandleMaxLength, `${name}: handle length`);
    if (length) { assert.equal(handle.length, length, `${name}: issued at exactly the stated length`); continue; }
    for (const secret of [url.searchParams.get('code_challenge'), url.searchParams.get('state'), url.searchParams.get('client_id')]) assert.ok(!handle.includes(secret), `${name}: the handle cannot be read`);
    const opened = sealer.open(handle);
    assert.deepEqual(
      { clientId: opened.clientId, redirectUri: opened.redirectUri, codeChallenge: opened.codeChallenge, state: opened.state, resource: opened.resource, scopes: opened.scopes, connectionRoute: opened.connectionRoute },
      { clientId: url.searchParams.get('client_id'), redirectUri: url.searchParams.get('redirect_uri'), codeChallenge: url.searchParams.get('code_challenge'), state: url.searchParams.get('state'), resource: `${origin}/mcp`, scopes: url.searchParams.get('scope').split(' '), connectionRoute: 'remote_mcp_oauth' },
      `${name}: the handle binds the request, loopback port included`);
    assert.equal(opened.exp - opened.iat, schemas['x-limits'].authorizationRequestTtlSeconds);
    const verifier = entry.context.codeVerifier;
    if (verifier) assert.equal(crypto.createHash('sha256').update(verifier).digest('base64url'), opened.codeChallenge, `${name}: the fixture's S256 pair`);
  }
});

test('authorize: parameter, scope and state rules beyond the fixtures', async () => {
  const entry = await fixture('authorize-redirects-to-consent');
  const sealer = createAuthorizationRequestSealer({ keyMaterial });
  const handler = createAuthorizeRequestHandler({ origin, flags: flagsOf(entry), resolveClient: fixtureResolver(entry), sealer });
  const base = new URL(entry.request.path, origin).searchParams;
  const run = async edit => { const params = new URLSearchParams(base); edit(params); return (await handler(params)).location; };
  const clientError = (error, withState = true) => {
    const url = new URL('https://assistant.example.com/oauth/callback');
    url.searchParams.append('error', error); url.searchParams.append('error_description', schemas['x-oauth-errors'][error].description);
    if (withState) url.searchParams.append('state', base.get('state'));
    url.searchParams.append('iss', origin);
    return url.href;
  };
  assert.equal(await run(params => params.append('scope', 'envoi.agent')), `${origin}/authorize-agent?error=invalid_request`, 'a repeated parameter never reaches the client');
  assert.equal(await run(params => params.set('response_type', 'token')), clientError('unsupported_response_type'));
  assert.equal(await run(params => params.delete('code_challenge')), clientError('invalid_request'));
  assert.equal(await run(params => params.set('code_challenge', 'short')), clientError('invalid_request'));
  assert.equal(await run(params => params.delete('code_challenge_method')), clientError('invalid_request'), 'absent method counts as plain');
  assert.equal(await run(params => params.set('resource', `${origin}/mcp/`)), clientError('invalid_target'));
  for (const scope of ['', 'envoi.agent envoi.agent', 'envoi.agent envoi.email', 'envoi.agent  envoi.send']) assert.equal(await run(params => params.set('scope', scope)), clientError('invalid_scope'), `scope "${scope}"`);
  assert.equal(await run(params => params.set('state', 'x'.repeat(513))), clientError('invalid_request', false), 'an invalid state is not echoed');
  assert.equal(await run(params => params.set('state', 'tab\there')), clientError('invalid_request', false));
  const defaults = sealer.open(new URL(await run(params => { params.delete('scope'); params.delete('state'); })).searchParams.get('request'));
  assert.deepEqual([defaults.scopes, defaults.state], [['envoi.agent', 'envoi.send'], null], 'no scope asks for envoi.agent envoi.send; state is optional');
  const ordered = sealer.open(new URL(await run(params => params.set('scope', 'envoi.cases envoi.agent'))).searchParams.get('request'));
  assert.deepEqual(ordered.scopes, ['envoi.agent', 'envoi.cases'], 'scopes kept in x-scopes order');
  // The redirect check comes before every client-facing error: an unknown URI never receives one.
  assert.equal(await run(params => { params.set('redirect_uri', 'https://assistant.example.com/oauth/callback?x=1'); params.set('response_type', 'token'); }), `${origin}/authorize-agent?error=invalid_redirect_uri`);
});

test('the sealed handle is tamper-evident, expires, and needs the server key', () => {
  let now = Date.parse('2026-10-22T12:00:00.000Z');
  const sealer = createAuthorizationRequestSealer({ keyMaterial, now: () => now });
  const handle = sealer.seal({ clientId: 'client_example', scopes: ['envoi.agent'] });
  assert.equal(sealer.open(handle).clientId, 'client_example');
  assert.notEqual(sealer.seal({ clientId: 'client_example', scopes: ['envoi.agent'] }), handle, 'a fresh IV each time');
  const flipped = handle.slice(0, -2) + (handle.at(-2) === 'A' ? 'B' : 'A') + handle.at(-1);
  for (const bad of [flipped, handle.replace('v1.', 'v2.'), `${handle}=`, 'v1.', '', null, 'v1.' + 'A'.repeat(3000)]) assert.equal(sealer.open(bad), null, `refused: ${String(bad).slice(0, 12)}`);
  assert.equal(createAuthorizationRequestSealer({ keyMaterial: crypto.randomBytes(32), now: () => now }).open(handle), null, 'another key cannot open it');
  now += 600_000 - 1000;
  assert.ok(sealer.open(handle), 'valid until 600 s');
  now += 1000;
  assert.equal(sealer.open(handle), null, 'expired at 600 s');
});

test('an authorization request too large to seal is refused, not truncated', async () => {
  // Random, so deflate cannot shrink it below the limit.
  const longId = `https://assistant.example.com/${crypto.randomBytes(1500).toString('base64url').slice(0, 1900)}.json`;
  const document = { client_id: longId, client_name: 'Long', redirect_uris: ['https://assistant.example.com/cb'] };
  const flags = { registration: true, installations: true, remoteMcpOAuth: true };
  const resolveClient = createClientResolver({ origin, flags, fetchClientMetadata: async () => ({ document }) });
  const handler = createAuthorizeRequestHandler({ origin, flags, resolveClient, sealer: createAuthorizationRequestSealer({ keyMaterial }) });
  const params = new URLSearchParams({ response_type: 'code', client_id: longId, redirect_uri: 'https://assistant.example.com/cb', code_challenge: 'M3FIpMlzNJLst5kEE-j8UdR1OBkXmRHcAX4RQoA2lHM', code_challenge_method: 'S256', resource: `${origin}/mcp`, state: crypto.randomBytes(400).toString('base64url').slice(0, 512) });
  const location = new URL((await handler(params)).location);
  assert.equal(location.searchParams.get('error'), 'invalid_request');
  assert.equal(location.origin, 'https://assistant.example.com');
});

// agent-remote-auth revision 3, check 11 (kept in approved revision 4): measured on the encoded handle, after check 10. With the
// "v1." prefix and unpadded base64url, a handle length of 4n + 1 after the prefix cannot occur, so 2,048 itself is
// unreachable: the exact boundary is the largest accepted length (2,047) and the smallest refused one (2,049).
test('check 11: the exact encoded-length boundary, state and iss kept, nothing truncated', async () => {
  const limit = remoteAuthLimits.authorizationRequestHandleMaxLength;
  const flags = { registration: true, installations: true, remoteMcpOAuth: true };
  // Deterministic: the sealed length depends on the compressed payload, which carries iat/exp, so one constant clock is
  // used for the search, the handler and open; and the input is derived from a fixed seed, because with random input a
  // one-character step can grow the payload by two bytes and skip a target length (about 7% of random inputs did). The
  // search also tries several contents per length. The boundary assertions below are unchanged.
  const fixedNow = Date.UTC(2026, 9, 22, 12);
  const sealer = createAuthorizationRequestSealer({ keyMaterial, now: () => fixedNow });
  let random = '';
  for (let block = 0; random.length < 1300 + 8 + remoteAuthLimits.stateMaxLength; block += 1) random += crypto.createHash('sha512').update(`agent-remote-auth check 11 ${block}`).digest('base64url');
  const clientId = `https://assistant.example.com/${random.slice(0, 1300)}.json`;
  const redirectUri = 'https://assistant.example.com/cb';
  const document = { client_id: clientId, client_name: 'Long', redirect_uris: [redirectUri] };
  const handler = createAuthorizeRequestHandler({ origin, flags, sealer, resolveClient: createClientResolver({ origin, flags, fetchClientMetadata: async () => ({ document }) }) });
  const paramsFor = state => new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, code_challenge: 'M3FIpMlzNJLst5kEE-j8UdR1OBkXmRHcAX4RQoA2lHM', code_challenge_method: 'S256', resource: `${origin}/mcp`, state });
  // The length the sealer gives for this exact request (the IV is random but fixed in size).
  const sealedLength = state => sealer.seal({ clientId, connectionRoute: 'remote_mcp_oauth', redirectUri, codeChallenge: 'M3FIpMlzNJLst5kEE-j8UdR1OBkXmRHcAX4RQoA2lHM', scopes: ['envoi.agent', 'envoi.send'], state, resource: `${origin}/mcp` }).length;
  const found = {};
  for (let size = 1; size <= remoteAuthLimits.stateMaxLength && !(found.at && found.over); size += 1) {
    for (let offset = 0; offset < 8 && !(found.at && found.over); offset += 1) {
      const state = random.slice(1300 + offset, 1300 + offset + size);
      const length = sealedLength(state);
      if (length === limit - 1 && !found.at) found.at = state;
      if (length === limit + 1 && !found.over) found.over = state;
    }
  }
  assert.ok(found.at && found.over, 'inputs that seal to 2,047 and 2,049 characters exist');
  const accepted = new URL((await handler(paramsFor(found.at))).location);
  assert.equal(`${accepted.origin}${accepted.pathname}`, `${origin}/authorize-agent`, 'at 2,047 the handle is issued');
  assert.equal(accepted.searchParams.get('request').length, limit - 1);
  assert.equal(sealer.open(accepted.searchParams.get('request')).state, found.at, 'nothing truncated in the accepted handle');
  const refused = new URL((await handler(paramsFor(found.over))).location);
  assert.equal(`${refused.origin}${refused.pathname}`, redirectUri, 'at 2,049 it goes to the checked redirect URI');
  assert.deepEqual([refused.searchParams.get('error'), refused.searchParams.get('state'), refused.searchParams.get('iss')], ['invalid_request', found.over, origin], 'invalid_request with the full state and iss');
  // Check 11 runs last: an earlier failure in the same oversized request is reported first.
  const earlier = new URL((await handler(new URLSearchParams({ ...Object.fromEntries(paramsFor(found.over)), scope: 'envoi.send' }))).location);
  assert.equal(earlier.searchParams.get('error'), 'invalid_scope', 'check 9 is reported before check 11');
});

test('redirect URI rules and matching (x-redirect-rules)', () => {
  for (const ok of ['https://a.example/cb', 'https://a.example:8443/cb?x=1', 'http://127.0.0.1/cb', 'http://127.0.0.1:53682/cb', 'http://[::1]:9/cb']) assert.equal(redirectUriRejection(ok), null, ok);
  for (const [bad, reason] of [['http://localhost/cb', 'not_loopback'], ['http://a.example/cb', 'not_loopback'], ['https://203.0.113.5/cb', 'address_literal'], ['https://[2001:db8::1]/cb', 'address_literal'], ['https://u:p@a.example/cb', 'userinfo'], ['https://a.example/cb#x', 'fragment'], ['com.example.app:/cb', 'scheme'], ['', 'invalid']]) {
    assert.equal(redirectUriRejection(bad), reason, bad);
  }
  assert.equal(redirectMatches(['https://a.example/cb'], 'https://a.example/cb'), true);
  for (const near of ['https://a.example/cb/', 'https://A.example/cb', 'https://a.example/cb?x', 'https://a.example:443/cb']) assert.equal(redirectMatches(['https://a.example/cb'], near), false, `exact match only: ${near}`);
  assert.equal(redirectMatches(['http://127.0.0.1/cb'], 'http://127.0.0.1:53682/cb'), true, 'the loopback port is ignored');
  assert.equal(redirectMatches(['http://127.0.0.1:1/cb'], 'http://127.0.0.1:2/cb'), true);
  assert.equal(redirectMatches(['http://127.0.0.1/cb'], 'http://127.0.0.1:53682/other'), false, 'only the port is ignored');
  assert.equal(redirectMatches(['http://127.0.0.1/cb'], 'http://[::1]:53682/cb'), false, 'the loopback address itself must match');
  assert.equal(redirectMatches(['http://127.0.0.1/cb'], 'http://localhost:53682/cb'), false);
  assert.equal(redirectMatches(['https://a.example/cb'], 'https://a.example:9999/cb'), false, 'no port exception for https');
});

test('client metadata URL and document rules (x-client-metadata-checks)', () => {
  const cases = [
    [`https://a.example/${'x'.repeat(2048)}`, 'url_too_long'], ['not a url', 'url_invalid'], ['http://a.example/c.json', 'scheme_not_https'],
    ['https://u@a.example/c.json', 'userinfo_present'], ['https://a.example:8443/c.json', 'port_not_allowed'], ['https://a.example', 'path_missing'], ['https://a.example/', 'path_missing'],
    ['https://a.example/c.json?x=1', 'query_present'], ['https://a.example/c.json#x', 'fragment_present'], [`${origin}/client.json`, 'self_origin']
  ];
  for (const [id, reason] of cases) assert.equal(clientIdUrlRejection(id, origin), reason, id);
  assert.equal(clientIdUrlRejection('https://a.example:443/c.json', origin), null);
  const id = 'https://a.example/c.json';
  const good = { client_id: id, client_name: 'A', redirect_uris: ['https://a.example/cb'] };
  assert.equal(clientMetadataRejection(good, id), null);
  const bad = [
    [[], 'not_json'], [{ ...good, client_id: `${id}/` }, 'client_id_mismatch'], [{ ...good, client_name: '' }, 'client_name_invalid'], [{ ...good, client_name: 'x'.repeat(81) }, 'client_name_invalid'],
    [{ ...good, client_name: 'A‮evil' }, 'client_name_invalid'], [{ ...good, redirect_uris: [] }, 'redirect_uris_invalid'], [{ ...good, redirect_uris: Array(11).fill('https://a.example/cb') }, 'redirect_uris_invalid'],
    [{ ...good, redirect_uris: ['http://localhost/cb'] }, 'redirect_uris_invalid'], [{ ...good, token_endpoint_auth_method: 'client_secret_basic' }, 'auth_method_not_none'],
    [{ ...good, grant_types: ['refresh_token'] }, 'grant_types_invalid'], [{ ...good, grant_types: ['authorization_code', 'bad grant'] }, 'grant_types_invalid'],
    [{ ...good, response_types: ['code', 'token'] }, 'response_types_invalid'], [{ ...good, logo_uri: 'http://a.example/l.png' }, 'not_json']
  ];
  for (const [document, reason] of bad) assert.equal(clientMetadataRejection(document, id), reason, JSON.stringify(document).slice(0, 60));
  for (const [header, seconds] of [[undefined, 300], ['max-age=10', 300], ['max-age=600', 600], ['public, max-age=999999', 86_400], ['no-store', 300], ['no-store, max-age=9000', 300]]) assert.equal(clientMetadataCacheSeconds(header), seconds, String(header));
});

test('client resolver: route flags, caching per exact id, and no cache for failures', async () => {
  let now = 0, fetches = 0, fail = true;
  const id = 'https://a.example/c.json';
  const preRegistered = parsePreRegisteredClients(JSON.stringify([
    { clientId: 'client_provider-x', clientName: 'Provider X', connectionRoute: 'provider_connector', redirectUris: ['https://p.example/cb'], tokenEndpointAuthMethod: 'client_secret_basic', clientSecretSha256: 'a'.repeat(64), bootstrapCode: true, provider: 'Provider X' }
  ]));
  const resolver = flags => createClientResolver({ origin, flags, preRegistered, now: () => now, fetchClientMetadata: async () => { fetches += 1; return fail ? { rejection: 'fetch_failed' } : { document: { client_id: id, client_name: 'A', redirect_uris: ['https://a.example/cb'] }, cacheControl: 'max-age=400' }; } });
  const remoteOnly = resolver({ remoteMcpOAuth: true });
  assert.equal(await remoteOnly('client_provider-x'), null, 'a pre-registered client is unknown while its route flag is off');
  assert.equal((await resolver({ providerConnectors: true })('client_provider-x')).provider, 'Provider X');
  assert.equal(await resolver({ providerConnectors: true })(id), null, 'metadata documents need ENVOI_REMOTE_MCP_OAUTH');
  assert.equal(await remoteOnly(id), null); assert.equal(await remoteOnly(id), null); assert.equal(fetches, 2, 'a failed fetch is not cached');
  fail = false;
  assert.equal((await remoteOnly(id)).registration, 'metadata_document');
  fail = true;
  assert.ok(await remoteOnly(id), 'cached'); assert.equal(fetches, 3);
  now += 400_000;
  assert.equal(await remoteOnly(id), null, 'refetched after max-age'); assert.equal(fetches, 4);
});

test('pre-registered client configuration fails closed', () => {
  const base = { clientId: 'client_example', clientName: 'Example', connectionRoute: 'remote_mcp_oauth', redirectUris: ['https://e.example/cb'], tokenEndpointAuthMethod: 'none', bootstrapCode: false, provider: 'Example' };
  assert.equal(parsePreRegisteredClients(JSON.stringify([base])).size, 1);
  assert.equal(parsePreRegisteredClients(undefined).size, 0);
  const invalid = [
    'not json', '{}', [{ ...base, clientId: 'https://e.example/c.json' }], [base, base], [{ ...base, extra: 1 }], [{ ...base, connectionRoute: 'local_helper' }],
    [{ ...base, redirectUris: ['http://localhost/cb'] }], [{ ...base, tokenEndpointAuthMethod: 'client_secret_basic' }], [{ ...base, clientSecretSha256: 'a'.repeat(64) }],
    [{ ...base, bootstrapCode: true }], [{ ...base, redirectUris: [] }], [{ ...base, clientName: 'Bad​' }], [{ ...base, provider: '' }]
  ];
  for (const value of invalid) assert.throws(() => parsePreRegisteredClients(typeof value === 'string' ? value : JSON.stringify(value)), /ENVOI_OAUTH_CLIENTS/, JSON.stringify(value).slice(0, 80));
  const bootstrapOnly = { ...base, clientId: 'client_boot', connectionRoute: 'provider_connector', redirectUris: [], tokenEndpointAuthMethod: 'client_secret_basic', clientSecretSha256: 'b'.repeat(64), bootstrapCode: true };
  assert.equal(parsePreRegisteredClients(JSON.stringify([bootstrapOnly])).get('client_boot').redirectUris.length, 0, 'only a bootstrap client may have no redirect URI');
});

// A fake https.request: records the request options and answers with the given response.
const fakeRequest = ({ status = 200, headers = { 'content-type': 'application/json' }, chunks = ['{}'], never = false, delayMs = 0, seen = [] } = {}) => (target, options, callback) => {
  seen.push({ target: target.href, options });
  const req = new PassThrough();
  req.destroy = () => {};
  req.end = () => {
    if (never) return;
    (delayMs ? fn => setTimeout(fn, delayMs) : setImmediate)(() => {
      const response = new PassThrough();
      Object.assign(response, { statusCode: status, headers });
      callback(response);
      for (const chunk of chunks) response.write(chunk);
      response.end();
    });
  };
  return req;
};

test('metadata fetch: pinned to checked addresses, no redirects, size, type and time limits', async () => {
  const id = 'https://assistant.example.com/oauth/envoi-client.json';
  const document = { client_id: id, client_name: 'A', redirect_uris: ['https://assistant.example.com/cb'] };
  const answers = { 'assistant.example.com': ['93.184.215.14'], 'internal.example.net': ['10.0.0.8'] };
  const resolver = { setServers() {}, resolve4: async name => answers[name] || [], resolve6: async () => [] };
  const destination = createWakeDestination({ env: { ENVOI_PUBLIC_URL: origin }, resolver });
  const seen = [];
  const ok = await createClientMetadataFetch({ destination, request: fakeRequest({ chunks: [JSON.stringify(document)], headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'max-age=900' }, seen }) })(id);
  assert.deepEqual(ok, { document, cacheControl: 'max-age=900' });
  assert.equal(seen[0].options.method, 'GET'); assert.deepEqual(seen[0].options.headers, { accept: 'application/json' }, 'no cookies and no credentials');
  await new Promise(resolve => seen[0].options.lookup('assistant.example.com', { all: true }, (error, list) => { assert.deepEqual(list, [{ address: '93.184.215.14', family: 4 }], 'the connection is pinned'); resolve(); }));
  const fetchWith = options => createClientMetadataFetch({ destination, request: fakeRequest(options), limits: { ...remoteAuthLimits.clientMetadata, fetchTimeoutMs: 50 } })(id);
  assert.deepEqual(await fetchWith({ status: 302, headers: { location: 'https://elsewhere.example/c.json' } }), { rejection: 'fetch_failed' }, 'redirects are never followed');
  assert.deepEqual(await fetchWith({ status: 404 }), { rejection: 'fetch_failed' });
  assert.deepEqual(await fetchWith({ headers: { 'content-type': 'text/html' } }), { rejection: 'not_json' });
  assert.deepEqual(await fetchWith({ chunks: ['{"a":'] }), { rejection: 'not_json' });
  assert.deepEqual(await fetchWith({ chunks: ['x'.repeat(3000), 'x'.repeat(3000)] }), { rejection: 'body_too_large' });
  assert.deepEqual(await fetchWith({ never: true }), { rejection: 'fetch_failed' }, 'the deadline covers the whole fetch');
  const fetchId = clientId => createClientMetadataFetch({ destination, request: fakeRequest() })(clientId);
  assert.deepEqual(await fetchId('https://internal.example.net/c.json'), { rejection: 'http_wake_address_rules' }, 'private addresses are refused before connecting');
  assert.deepEqual(await fetchId('https://printer.local/c.json'), { rejection: 'http_wake_name_rules' }, 'reserved names are refused');
});

// M1 (review 6349153739): the §3.1 deadline is one budget for destination resolution (the service's own-address
// checks and the target's names) and the HTTPS response together, not a timer that starts after DNS.
test('metadata fetch: the deadline covers destination resolution as well as the response', async () => {
  const id = 'https://assistant.example.com/oauth/envoi-client.json';
  const document = { client_id: id, client_name: 'A', redirect_uris: ['https://assistant.example.com/cb'] };
  const deadlineMs = 600;
  const slowDestination = stepMs => {
    let pending = 0, settled;
    const idle = new Promise(resolve => { settled = resolve; });
    const step = value => { pending += 1; return new Promise(resolve => setTimeout(() => { resolve(value); if (--pending === 0) settled(); }, stepMs)); };
    const resolver = { setServers() {}, resolve4: async name => step(name === 'assistant.example.com' ? ['93.184.215.14'] : []), resolve6: async () => step([]) };
    return { destination: createWakeDestination({ env: { ENVOI_PUBLIC_URL: origin }, resolver }), idle };
  };
  const run = async (stepMs, response) => {
    const { destination, idle } = slowDestination(stepMs);
    const seen = [];
    const started = Date.now();
    const result = await createClientMetadataFetch({ destination, request: fakeRequest({ chunks: [JSON.stringify(document)], seen, ...response }), limits: { ...remoteAuthLimits.clientMetadata, fetchTimeoutMs: deadlineMs } })(id);
    const elapsedMs = Date.now() - started;
    await idle;
    return { result, elapsedMs, requests: seen.length };
  };
  // Resolution alone outlasts the deadline: the fetch ends at the deadline and never connects afterwards.
  const slowDns = await run(1500, {});
  assert.deepEqual(slowDns.result, { rejection: 'fetch_failed' });
  assert.ok(slowDns.elapsedMs < 1400, `ended at the deadline, not after resolution (${slowDns.elapsedMs} ms)`);
  assert.equal(slowDns.requests, 0, 'a resolution that finishes after the deadline is not used');
  // Each part is within the deadline but together they are not (own-host and target lookups about 450 ms, then a
  // 450 ms response): a timer started after resolution would accept this.
  const split = await run(150, { delayMs: 450 });
  assert.deepEqual(split.result, { rejection: 'fetch_failed' }, 'resolution time counts towards the deadline');
  assert.equal(split.requests, 1);
  // Positive control: fast resolution and an immediate response succeed with the same deadline.
  const fast = await run(10, {});
  assert.deepEqual(fast.result, { document, cacheControl: undefined });
});

// ---------------------------------------------------------------- the real routes

const preRegistered = [{ clientId: 'client_desktop-example', clientName: 'Desktop Example', connectionRoute: 'remote_mcp_oauth', redirectUris: ['http://127.0.0.1/callback', 'https://desktop.example.org/callback'], tokenEndpointAuthMethod: 'none', bootstrapCode: false, provider: 'Example' }];
const enabledEnv = { ENVOI_AGENT_REGISTRATION_V2: 'true', ENVOI_INSTALLATIONS_V2: 'true', ENVOI_REMOTE_MCP_OAUTH: 'true', ENVOI_PUBLIC_URL: origin, ENVOI_OAUTH_CLIENTS: JSON.stringify(preRegistered) };
const get = (baseUrl, route, headers = {}) => fetch(`${baseUrl}${route}`, { redirect: 'manual', headers });
const listFiles = async dir => (await readdir(dir, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath || entry.path, entry.name)).sort();

test('[server] flags off: every agent-remote-auth endpoint is FEATURE_DISABLED', async t => {
  const server = await launch({ ENVOI_AGENT_REGISTRATION_V2: 'true', ENVOI_INSTALLATIONS_V2: 'true' }); t.after(() => server.stop());
  const expected = await fixture('discovery-feature-disabled');
  for (const endpoint of schemas['x-endpoints']) {
    const route = endpoint.path.replace('{handle}', 'v1.x');
    const response = await fetch(`${server.baseUrl}${route}`, { method: endpoint.method, redirect: 'manual', ...(endpoint.method === 'POST' ? { body: '' } : {}) });
    const body = await response.json();
    assert.equal(response.status, 404, `${endpoint.method} ${route}`);
    assert.equal(body.code, 'FEATURE_DISABLED'); assert.equal(body.message, expected.response.body.message);
  }
  assert.equal((await get(server.baseUrl, '/.well-known/openid-configuration')).status, 404, 'no OpenID Connect discovery');
});

// M2 (review 6349153739): with both flags off, FEATURE_DISABLED comes before the session, CSRF and account checks,
// so a signed-in owner's browser gets the same answer as anyone else.
test('[server] flags off: a signed-in owner without a valid CSRF token still gets FEATURE_DISABLED', async t => {
  const server = await launch({ ENVOI_AGENT_REGISTRATION_V2: 'true', ENVOI_INSTALLATIONS_V2: 'true', ENVOI_REMOTE_MCP_OAUTH: 'false', ENVOI_PROVIDER_CONNECTORS: 'false' }); t.after(() => server.stop());
  const who = await owner(server.baseUrl, String(4000 + crypto.randomInt(5000)));
  const cookie = who.session.headers(server.baseUrl, 'GET').cookie;
  assert.match(cookie, /envoi_session=/, 'a real owner session');
  const variants = [
    ['no CSRF header', { cookie }],
    ['a wrong CSRF header', { cookie, 'x-envoi-csrf': 'not-the-token', origin: server.baseUrl }],
    ['another account', { ...who.session.headers(server.baseUrl, 'POST'), 'x-envoi-expected-human': 'human_someone_else' }]
  ];
  for (const endpoint of schemas['x-endpoints'].filter(entry => entry.method === 'POST')) {
    const route = endpoint.path.replace('{handle}', 'v1.x');
    for (const [label, headers] of variants) {
      const response = await fetch(`${server.baseUrl}${route}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });
      const body = await response.json();
      assert.deepEqual([response.status, body.code], [404, 'FEATURE_DISABLED'], `${route} with ${label}`);
    }
  }
  // The checks themselves are unchanged for other routes: the same session without CSRF is refused there.
  const other = await fetch(`${server.baseUrl}/api/inboxes`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{"name":"x"}' });
  assert.equal(other.status, 403, 'CSRF still applies to ordinary routes');
});

test('[server] discovery, authorize and consent shell on the real routes; nothing is stored', async t => {
  const server = await launch(enabledEnv); t.after(() => server.stop());
  const { baseUrl } = server;
  for (const [route, name] of [['/.well-known/oauth-protected-resource/mcp', 'protected-resource-metadata'], ['/.well-known/oauth-protected-resource', 'protected-resource-metadata-root'], ['/.well-known/oauth-authorization-server', null]]) {
    const response = await get(baseUrl, route, { host: 'attacker.example' });
    assert.equal(response.status, 200, route);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=300');
    const body = await response.json();
    assert.deepEqual(body, name ? (await fixture(name)).response.body : authorizationServerMetadata(origin, { remoteMcpOAuth: true }), `${route}: built from ENVOI_PUBLIC_URL, never Host`);
  }
  assert.equal((await fetch(`${baseUrl}/.well-known/oauth-authorization-server`, { method: 'POST', body: '' })).status, 405);
  assert.equal((await get(baseUrl, '/.well-known/openid-configuration')).status, 404);
  const before = await listFiles(server.dataDir);
  const query = new URLSearchParams({ response_type: 'code', client_id: 'client_desktop-example', redirect_uri: 'http://127.0.0.1:53682/callback', code_challenge: 'M3FIpMlzNJLst5kEE-j8UdR1OBkXmRHcAX4RQoA2lHM', code_challenge_method: 'S256', resource: `${origin}/mcp`, state: 'state-1' });
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const response = await get(baseUrl, `/oauth/authorize?${query}`);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.match(response.headers.get('location'), /^https:\/\/www\.envoi-agents\.com\/authorize-agent\?request=v1\.[A-Za-z0-9_-]+$/);
  }
  const after = await listFiles(server.dataDir);
  // M7 (review 6349153739): the cleanup jobs write their own cursors on their own schedule, at startup and then on an
  // interval, so either may appear between the two inventories. Exactly those two files are maintenance metadata, and
  // the OAuth cursor may hold positions only. Every other new file, and anything holding grant state, fails.
  const maintenance = [path.join(server.dataDir, 'auth', 'agent-registration-cleanup', 'cursor.json'), path.join(server.dataDir, 'auth', 'oauth-cleanup-cursor', 'cursor.json')];
  assert.deepEqual(after.filter(file => !before.includes(file) && !maintenance.includes(file)), [], 'an unauthenticated authorization GET writes nothing');
  if (after.includes(maintenance[1])) {
    assert.deepEqual(Object.keys(JSON.parse(await readFile(maintenance[1], 'utf8'))).sort(), ['keptFromMs', 'nextBucketStartMs', 'ranAt', 'version'], 'the OAuth cleanup cursor holds positions only');
  }
  const unknown = await get(baseUrl, `/oauth/authorize?${new URLSearchParams({ ...Object.fromEntries(query), client_id: 'client_unknown' })}`);
  assert.equal(unknown.headers.get('location'), `${origin}/authorize-agent?error=invalid_client`);
  const wrongRedirect = await get(baseUrl, `/oauth/authorize?${new URLSearchParams({ ...Object.fromEntries(query), redirect_uri: 'http://127.0.0.1:53682/other' })}`);
  assert.equal(wrongRedirect.headers.get('location'), `${origin}/authorize-agent?error=invalid_redirect_uri`);
  const plain = await get(baseUrl, `/oauth/authorize?${new URLSearchParams({ ...Object.fromEntries(query), code_challenge_method: 'plain' })}`);
  assert.equal(new URL(plain.headers.get('location')).searchParams.get('error'), 'invalid_request');
  assert.equal(new URL(plain.headers.get('location')).origin, 'http://127.0.0.1:53682', 'errors after the redirect check go to the checked URI');
  const shell = await get(baseUrl, '/authorize-agent?request=v1.x');
  assert.equal(shell.status, 200); assert.match(shell.headers.get('content-type'), /text\/html/);
  // The token and revocation endpoints exist since RA-A2 (agent-remote-auth-token.test.js); an empty body is an OAuth error.
  for (const route of ['/oauth/token', '/oauth/revoke']) {
    const empty = await fetch(`${baseUrl}${route}`, { method: 'POST', body: '' });
    assert.equal(empty.status, 400, route);
    assert.equal((await empty.json()).error, 'invalid_request');
  }
  assert.doesNotMatch(server.stdout + server.stderr, /M3FIpMlzNJLst5kEE|state-1|v1\.[A-Za-z0-9_-]{40}/, 'no challenge, state or handle in the logs');
});

test('[server] startup fails closed on an invalid remote-auth configuration', async () => {
  for (const env of [
    { ENVOI_REMOTE_MCP_OAUTH: 'true', ENVOI_PUBLIC_URL: origin },
    { ...enabledEnv, ENVOI_PUBLIC_URL: '' },
    { ...enabledEnv, ENVOI_OAUTH_CLIENTS: '[{"clientId":"bad"}]' },
    { ...enabledEnv, ENVOI_PROVIDER_CONNECTORS: 'yes' }
  ]) {
    await assert.rejects(launch(env), /Server exited/, JSON.stringify(env).slice(0, 120));
  }
});
