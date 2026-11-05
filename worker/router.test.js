import assert from 'node:assert/strict';
import test from 'node:test';
import { CONTAINER_ENV_KEYS, CONTAINER_LEGACY_FALLBACKS } from './runtime-config.js';
import { LEGACY_ENVIRONMENT_FALLBACKS } from '../src/envoi-environment.js';
import { onboardingFlagNames } from '../src/onboarding-flags.js';
import {
  createForwardedRequest,
  environmentFingerprint,
  isAllowedHostname,
  parseAllowedHostnames,
  releaseIsStale,
  selectEnvironment,
  serviceUnavailableResponse,
  settingsChanged,
  withNoStoreHeaders
} from './router.js';

test('only the exact successful public wake key endpoint preserves its bounded cache', () => {
  const response = () => new Response('{}', { headers: { 'cache-control': 'public, max-age=300, s-maxage=0' } });
  assert.equal(withNoStoreHeaders(response(), '/.well-known/envoi-wake-keys.json').headers.get('cache-control'), 'public, max-age=300, s-maxage=0');
  for (const pathname of ['', '/api/agent/status', '/.well-known/envoi-wake-keys.json/']) assert.equal(withNoStoreHeaders(response(), pathname).headers.get('cache-control'), 'private, no-store');
  assert.equal(withNoStoreHeaders(new Response('{}', { status: 500 }), '/.well-known/envoi-wake-keys.json').headers.get('cache-control'), 'private, no-store');
});

test('only the successful agent-remote-auth discovery documents keep their public cache', () => {
  const response = (status = 200, cacheControl = 'public, max-age=300') => new Response('{}', { status, headers: { 'cache-control': cacheControl } });
  for (const pathname of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server']) {
    assert.equal(withNoStoreHeaders(response(), pathname).headers.get('cache-control'), 'public, max-age=300', pathname);
    assert.equal(withNoStoreHeaders(response(404), pathname).headers.get('cache-control'), 'private, no-store', `${pathname}: FEATURE_DISABLED is never cached`);
    assert.equal(withNoStoreHeaders(response(200, 'public, max-age=86400'), pathname).headers.get('cache-control'), 'private, no-store', `${pathname}: only the contracted value passes`);
  }
  for (const pathname of ['/oauth/authorize', '/oauth/token', '/authorize-agent', '/.well-known/openid-configuration', '/.well-known/oauth-authorization-server/x']) {
    assert.equal(withNoStoreHeaders(response(), pathname).headers.get('cache-control'), 'private, no-store', pathname);
  }
});

test('allowed hostnames are normalized and enforced', () => {
  assert.deepEqual([...parseAllowedHostnames(' WWW.ENVOI-AGENTS.COM., beta.example.com ')], [
    'www.envoi-agents.com',
    'beta.example.com'
  ]);
  assert.equal(isAllowedHostname(new URL('https://www.envoi-agents.com/api'), 'www.envoi-agents.com'), true);
  assert.equal(isAllowedHostname(new URL('https://attacker.example/api'), 'www.envoi-agents.com'), false);
  assert.equal(isAllowedHostname(new URL('https://preview.workers.dev/api'), ''), false);
  assert.equal(isAllowedHostname(new URL('https://preview.workers.dev/api'), undefined), false);
});

test('only allowlisted non-empty environment values reach the container', () => {
  assert.deepEqual(selectEnvironment(
    { SAFE: 'value', EMPTY: '', SECRET_NOT_LISTED: 'never' },
    ['SAFE', 'EMPTY'],
    { NODE_ENV: 'production' }
  ), { NODE_ENV: 'production', SAFE: 'value' });
});

// N2-config-2: only the data encryption key is still forwarded from its legacy name; staging holds it
// only as SINALOA_DATA_ENCRYPTION_KEY. Every other retired name reaches the container as nothing.
test('the container receives only ENVOI_* names, plus the one honoured legacy key', () => {
  assert.deepEqual(selectEnvironment({ SINALOA_PUBLIC_URL: 'https://www.envoi-agents.com' }, ['ENVOI_PUBLIC_URL']), {});
  assert.deepEqual(selectEnvironment({ SINALOA_RELEASE_SHA: 'a'.repeat(40), ENVOI_RELEASE_SHA: 'b'.repeat(40) }, ['ENVOI_RELEASE_SHA']), { ENVOI_RELEASE_SHA: 'b'.repeat(40) });
  assert.deepEqual(selectEnvironment({ SINALOA_DATA_ENCRYPTION_KEY: 'k'.repeat(40) }, ['ENVOI_DATA_ENCRYPTION_KEY']), { ENVOI_DATA_ENCRYPTION_KEY: 'k'.repeat(40) });
  assert.deepEqual(selectEnvironment({ SINALOA_DATA_ENCRYPTION_KEY: 'k'.repeat(40), ENVOI_DATA_ENCRYPTION_KEY: 'k'.repeat(40) }, ['ENVOI_DATA_ENCRYPTION_KEY']), { ENVOI_DATA_ENCRYPTION_KEY: 'k'.repeat(40) });
  assert.throws(() => selectEnvironment({ ENVOI_DATA_ENCRYPTION_KEY: 'new-private', SINALOA_DATA_ENCRYPTION_KEY: 'old-private' }, ['ENVOI_DATA_ENCRYPTION_KEY']),
    error => /Conflicting Envoi environment settings/.test(error.message) && !/private/.test(error.message));
});

// agent-registration v1 §12: the server reads the Phase B flags, so the Worker must forward them.
test('the container receives the onboarding flags', () => {
  for (const name of onboardingFlagNames) assert.ok(CONTAINER_ENV_KEYS.includes(name), name);
  const flags = { ENVOI_INSTALLATIONS_V2: 'true', ENVOI_AGENT_REGISTRATION_V2: 'true', ENVOI_AUTHENTICATED_REST_ROUTE: 'false' };
  assert.deepEqual(selectEnvironment(flags, CONTAINER_ENV_KEYS, {}), flags);
});

test('the container receives Monad settings and the issuer secret', () => {
  const names = ['ENVOI_MONAD_PERMISSIONS', 'ENVOI_MONAD_RPC_URL', 'ENVOI_MONAD_ISSUER_ADDRESS', 'ENVOI_MONAD_ISSUER_PRIVATE_KEY', 'ENVOI_MONAD_PAID_ORGANIZATION_IDS', 'ENVOI_MONAD_MAX_TRANSACTIONS'];
  for (const name of names) assert.ok(CONTAINER_ENV_KEYS.includes(name), name);
  const settings = { ENVOI_MONAD_RPC_URL: 'https://testnet-rpc.monad.xyz', ENVOI_MONAD_ISSUER_PRIVATE_KEY: 'issuer-secret' };
  assert.deepEqual(selectEnvironment(settings, CONTAINER_ENV_KEYS, {}), settings);
});

test('the Worker and the server honour the same legacy names', () => {
  assert.deepEqual(CONTAINER_LEGACY_FALLBACKS, LEGACY_ENVIRONMENT_FALLBACKS);
  assert.ok(Object.keys(CONTAINER_LEGACY_FALLBACKS).every(name => CONTAINER_ENV_KEYS.includes(name)));
});

test('forwarded headers are derived from the trusted request URL and Cloudflare IP', async () => {
  const original = new Request('https://www.envoi-agents.com:8443/api/messages?cursor=a%2Fb', {
    method: 'POST',
    headers: {
      'cf-connecting-ip': '203.0.113.42',
      'x-forwarded-for': '198.51.100.99',
      'x-envoi-mcp-dispatch': 'forged-by-a-client',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ hello: 'world' })
  });

  const forwarded = createForwardedRequest(original);
  assert.equal(new URL(forwarded.url).pathname, '/api/messages');
  assert.equal(new URL(forwarded.url).search, '?cursor=a%2Fb');
  assert.equal(forwarded.headers.get('x-forwarded-proto'), 'https');
  assert.equal(forwarded.headers.get('x-forwarded-host'), 'www.envoi-agents.com:8443');
  assert.equal(forwarded.headers.get('x-forwarded-port'), '8443');
  assert.equal(forwarded.headers.get('x-forwarded-for'), '203.0.113.42');
  assert.equal(forwarded.headers.get('x-real-ip'), '203.0.113.42');
  assert.equal(forwarded.headers.get('x-envoi-mcp-dispatch'), null, 'the internal dispatch marker is never forwarded from outside');
  assert.deepEqual(await forwarded.json(), { hello: 'world' });
});

test('forwarded headers discard spoofed client IP data outside Cloudflare', () => {
  const forwarded = createForwardedRequest(new Request('http://127.0.0.1:8787/health', {
    headers: { 'x-forwarded-for': '198.51.100.99', 'x-real-ip': '198.51.100.99' }
  }));
  assert.equal(forwarded.headers.has('x-forwarded-for'), false);
  assert.equal(forwarded.headers.has('x-real-ip'), false);
});

test('proxied responses remain streaming-compatible and cannot be cached', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('event: ready\n\n'));
      controller.close();
    }
  });
  const response = withNoStoreHeaders(new Response(stream, {
    headers: { 'content-type': 'text/event-stream' }
  }));

  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('cdn-cache-control'), 'no-store');
  assert.equal(await response.text(), 'event: ready\n\n');
});

test('container failures return a sanitized retryable response', async () => {
  const response = serviceUnavailableResponse();
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '5');
  assert.deepEqual(await response.json(), {
    error: 'SERVICE_UNAVAILABLE',
    message: 'Envoi is temporarily unavailable'
  });
});

test('a settings fingerprint ignores key order and changes with any value', async () => {
  const base = await environmentFingerprint({ ENVOI_MALWARE_SCANNER_TOKEN: 'one', ENVOI_PUBLIC_URL: 'https://www.envoi-agents.com' });
  assert.match(base, /^[a-f0-9]{64}$/);
  assert.equal(await environmentFingerprint({ ENVOI_PUBLIC_URL: 'https://www.envoi-agents.com', ENVOI_MALWARE_SCANNER_TOKEN: 'one' }), base);
  assert.notEqual(await environmentFingerprint({ ENVOI_MALWARE_SCANNER_TOKEN: 'two', ENVOI_PUBLIC_URL: 'https://www.envoi-agents.com' }), base, 'a rotated secret changes it');
  assert.notEqual(await environmentFingerprint({ ENVOI_MALWARE_SCANNER_TOKEN: 'one' }), base, 'a removed setting changes it');
  assert.doesNotMatch(base, /one|envoi-agents/, 'the fingerprint reveals no value');
});

test('a container restarts once for changed settings and never without a recorded start', () => {
  assert.equal(settingsChanged('a', 'b', null), true, 'settings changed since the container started');
  assert.equal(settingsChanged('a', 'a', null), false, 'unchanged settings');
  assert.equal(settingsChanged(undefined, 'b', null), false, 'a container started before fingerprints were recorded');
  assert.equal(settingsChanged('a', 'b', 'b'), false, 'already restarted for these settings, so no flapping');
  assert.equal(settingsChanged('a', 'c', 'b'), true, 'a later edit restarts again');
});

test('a running container is stale only when it reports a different configured release', () => {
  const deployed = 'a'.repeat(40);
  assert.equal(releaseIsStale(deployed, deployed), false);
  assert.equal(releaseIsStale(deployed, 'b'.repeat(40)), true);
  assert.equal(releaseIsStale(deployed, null), true);
  assert.equal(releaseIsStale(deployed, undefined), true);
  // Without a stamped release there is nothing to converge to, so never restart.
  assert.equal(releaseIsStale(undefined, null), false);
  assert.equal(releaseIsStale('', 'b'.repeat(40)), false);
  assert.equal(releaseIsStale('short', null), false);
});

test('human signup mode and quota reach the container and participate in settings restart', async () => {
  const closed = selectEnvironment({ ENVOI_HUMAN_SIGNUP_MODE: 'invite-only', ENVOI_PUBLIC_SIGNUP_LIMIT: '100' }, CONTAINER_ENV_KEYS);
  const open = selectEnvironment({ ENVOI_HUMAN_SIGNUP_MODE: 'public', ENVOI_PUBLIC_SIGNUP_LIMIT: '100' }, CONTAINER_ENV_KEYS);
  assert.equal(open.ENVOI_HUMAN_SIGNUP_MODE, 'public');
  assert.equal(open.ENVOI_PUBLIC_SIGNUP_LIMIT, '100');
  assert.notEqual(await environmentFingerprint(closed), await environmentFingerprint(open));
  assert.notEqual(await environmentFingerprint(open), await environmentFingerprint({ ...open, ENVOI_PUBLIC_SIGNUP_LIMIT: '99' }));
  const defaults = selectEnvironment({}, CONTAINER_ENV_KEYS);
  assert.equal(defaults.ENVOI_HUMAN_SIGNUP_MODE, undefined);
  assert.equal(defaults.ENVOI_PUBLIC_SIGNUP_LIMIT, undefined);
});

test('the staging agent-limit exception reaches the container and changes its settings fingerprint', async () => {
  const key = 'ENVOI_STAGING_UNCAPPED_AGENT_HUMAN_IDS';
  assert.ok(CONTAINER_ENV_KEYS.includes(key));
  const baseline = { ENVOI_DEPLOYMENT_ENVIRONMENT: 'staging' };
  const configured = { ...baseline, [key]: 'human_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
  assert.deepEqual(selectEnvironment(configured, CONTAINER_ENV_KEYS, {}), configured);
  assert.notEqual(await environmentFingerprint(baseline), await environmentFingerprint(configured));
});
test('the all-environment owner exception reaches the container and changes its settings fingerprint', async () => {
  const key = 'ENVOI_UNCAPPED_AGENT_HUMAN_IDS';
  assert.ok(CONTAINER_ENV_KEYS.includes(key));
  const baseline = { ENVOI_DEPLOYMENT_ENVIRONMENT: 'beta' };
  const configured = { ...baseline, [key]: 'human_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
  assert.deepEqual(selectEnvironment(configured, CONTAINER_ENV_KEYS, {}), configured);
  assert.notEqual(await environmentFingerprint(baseline), await environmentFingerprint(configured));
});
