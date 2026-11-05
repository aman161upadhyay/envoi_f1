import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateReleaseTargets } from '../scripts/check-deployment.mjs';
import { smokeDeployment } from '../scripts/smoke-deployment.mjs';

const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));

test('release configuration permits staging workers.dev and only the beta custom domain', () => {
  assert.doesNotThrow(() => validateReleaseTargets(config));
});

for (const [description, mutate] of [
  ['deploying staging to the old production Worker', candidate => { candidate.env.staging.name = 'sinaloa'; }],
  ['deploying beta to the old production Worker', candidate => { candidate.env.beta.name = 'sinaloa'; }],
  ['enabling beta preview URLs', candidate => { candidate.env.beta.preview_urls = true; }],
  ['re-enabling beta workers.dev', candidate => { candidate.env.beta.workers_dev = true; }],
  ['disabling staging workers.dev', candidate => { candidate.env.staging.workers_dev = false; }],
  ['discarding dashboard runtime variables', candidate => { candidate.keep_vars = false; }],
  ['changing the old production Worker identity', candidate => { candidate.name = 'sinaloa-beta'; }],
  ['binding beta to the old production hostname', candidate => { candidate.env.beta.routes = [{ pattern: 'sinaloa-inbox.com', custom_domain: true }]; }],
  ['adding a beta workers.dev route', candidate => { candidate.env.beta.routes.push({ pattern: 'sinaloa-beta.rachelgonsalves821.workers.dev' }); }],
  ['broadening beta edge hostname admission', candidate => { candidate.env.beta.vars.ENVOI_EDGE_ALLOWED_HOSTS += ',sinaloa-beta.rachelgonsalves821.workers.dev'; }],
  ['moving beta browser auth to workers.dev', candidate => { candidate.env.beta.vars.ENVOI_PUBLIC_URL = 'https://sinaloa-beta.rachelgonsalves821.workers.dev'; }],
  ['using the staging callback for beta', candidate => { candidate.env.beta.vars.WORKOS_REDIRECT_URI = 'https://sinaloa-staging.rachelgonsalves821.workers.dev/api/auth/workos/callback'; }],
]) {
  test(`release target validation rejects ${description}`, () => {
    const candidate = structuredClone(config);
    mutate(candidate);
    assert.throws(() => validateReleaseTargets(candidate), assert.AssertionError);
  });
}

const releaseSha = '0123456789abcdef0123456789abcdef01234567';
function smokeResponses(overrides = {}) {
  return async url => {
    const pathname = url.pathname;
    if (pathname === '/health') return Response.json({ service: 'sinaloa', mode: 'production', configurationValidated: true, releaseSha, ...overrides.health });
    if (pathname === '/ready') return Response.json({ ready: true, mode: 'production', configurationValidated: true, releaseSha, ...overrides.ready });
    if (pathname === '/api/onboarding/routes') return Response.json({registrationEnabled:true,installationsEnabled:true,
      routes:[{connectionRoute:'remote_mcp_oauth',available:true}],deliveryModes:[{deliveryMode:'on_demand',available:true}],...overrides.dots});
    if (pathname === '/api/auth/config') return Response.json({ enabled: true });
    if (pathname === '/api/auth/workos/sign-in') {
      const authorization = new URL('https://auth.example.test/authorize');
      authorization.searchParams.set('redirect_uri', overrides.callback || 'https://www.envoi-agents.com/api/auth/workos/callback');
      return new Response(null, { status: 302, headers: { location: authorization.href } });
    }
    if (pathname === '/team/') return new Response(null, { status: 301, headers: { location: '/#team' } });
    if (pathname === '/') return new Response('<html>Break your agents out of their silos <a href="/create-account/">Start now</a></html>', { headers: { 'content-type': 'text/html' } });
    if (pathname === '/product/') return overrides.missingProduct ? new Response(null, { status: 404 }) : new Response('<html>Track your agents work in different email threads</html>', { headers: { 'content-type': 'text/html' } });
    if (pathname === '/create-account/') return new Response('<html>Create your account <a href="/api/auth/workos/sign-up?returnTo=%2Fapp">Continue to sign up</a></html>', { headers: { 'content-type': 'text/html' } });
    if (pathname === '/app') return new Response('<html><div id="root"></div></html>', { headers: { 'content-type': 'text/html', 'x-robots-tag': 'noindex, nofollow' } });
    return new Response('<html><script src="/app.js"></script></html>', { headers: { 'content-type': 'text/html' } });
  };
}

test('release smoke confirms the recorded SHA on health and readiness', async () => {
  await assert.doesNotReject(() => smokeDeployment('https://www.envoi-agents.com/', releaseSha, { fetchImpl: smokeResponses(), log() {} }));
});

for (const dots of [
  {registrationEnabled:false}, {installationsEnabled:false},
  {routes:[{connectionRoute:'remote_mcp_oauth',available:false}]},
  {deliveryModes:[{deliveryMode:'on_demand',available:false}]}
]) test(`production smoke rejects healthy service with disabled Dots ${JSON.stringify(dots)}`,async()=>{
  await assert.rejects(()=>smokeDeployment('https://www.envoi-agents.com/',releaseSha,{fetchImpl:smokeResponses({dots}),log(){}}),
    /Production Dots OAuth\/on-demand route is unavailable/);
});

test('release smoke refuses a backend that still returns 404 for the Product page', async () => {
  await assert.rejects(() => smokeDeployment('https://www.envoi-agents.com/', releaseSha, { fetchImpl: smokeResponses({ missingProduct: true }), log() {} }), /\/product\/ returned 404/);
});

for (const endpoint of ['health', 'ready']) {
  for (const [description, returnedSha] of [['another release', 'f'.repeat(40)], ['missing release evidence', undefined]]) {
    test(`release smoke rejects ${description} from /${endpoint}`, async () => {
      await assert.rejects(
        () => smokeDeployment('https://www.envoi-agents.com/', releaseSha, { fetchImpl: smokeResponses({ [endpoint]: { releaseSha: returnedSha } }), log() {} }),
        new RegExp(`/${endpoint} did not confirm the expected release SHA`)
      );
    });
  }
}

test('invalid release SHA fails before contacting the deployment', async () => {
  await assert.rejects(
    () => smokeDeployment('https://www.envoi-agents.com/', 'short-sha', { fetchImpl() { assert.fail('No request should be made'); }, log() {} }),
    /full 40-hex release SHA/
  );
});

test('release smoke rejects a stale WorkOS callback from the running container', async () => {
  await assert.rejects(
    () => smokeDeployment('https://www.envoi-agents.com/', releaseSha, { fetchImpl: smokeResponses({ callback: 'https://beta.sinaloa-inbox.com/api/auth/workos/callback' }), log() {} }),
    /WorkOS sign-in does not return to the deployment origin/
  );
});

test('read-only smoke remains compatible when no expected SHA is supplied', async () => {
  await assert.doesNotReject(() => smokeDeployment('https://www.envoi-agents.com/', undefined, { fetchImpl: smokeResponses({ health: { releaseSha: undefined }, ready: { releaseSha: undefined } }), log() {} }));
});
