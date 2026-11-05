import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function smokeDeployment(origin, expectedSha, { fetchImpl = fetch, log = console.log } = {}) {
  const target = new URL(origin || '');
  if (target.protocol !== 'https:' || target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
    throw new Error('Pass the HTTPS deployment origin, without credentials, a path, query or fragment');
  }
  if (expectedSha !== undefined && !/^[a-f0-9]{40}$/i.test(expectedSha)) {
    throw new Error('Pass the full 40-hex release SHA as the optional second smoke argument');
  }
  const paths = ['/health', '/ready', ...(target.origin === 'https://www.envoi-agents.com' ? ['/api/onboarding/routes'] : []),
    '/api/auth/config', '/', '/product/', '/create-account/', '/app'];
  for (const pathname of paths) {
    const response = await fetchImpl(new URL(pathname, target), { redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`${pathname} returned ${response.status}`);
    if (pathname === '/ready' || pathname === '/health') {
      const body = await response.json();
      if (pathname === '/ready') {
        if (body.ready !== true || body.configurationValidated !== true || body.mode !== 'production') throw new Error('Production readiness was not confirmed');
      } else if (!['envoi', 'sinaloa'].includes(body.service) || body.mode !== 'production' || body.configurationValidated !== true) {
        throw new Error('Unexpected service or non-production mode');
      }
      if (expectedSha !== undefined && body.releaseSha !== expectedSha) {
        throw new Error(`${pathname} did not confirm the expected release SHA`);
      }
    } else if (pathname === '/api/onboarding/routes') {
      const body = await response.json().catch(() => null);
      if (body?.registrationEnabled !== true || body?.installationsEnabled !== true
        || !body.routes?.some(route => route.connectionRoute === 'remote_mcp_oauth' && route.available === true)
        || !body.deliveryModes?.some(mode => mode.deliveryMode === 'on_demand' && mode.available === true)) {
        throw new Error('Production Dots OAuth/on-demand route is unavailable despite service health');
      }
    } else if (pathname === '/' || pathname === '/product/' || pathname === '/create-account/' || pathname === '/app') {
      const html = await response.text();
      const expected = pathname === '/' ? 'Break your agents out of their silos' : pathname === '/product/' ? 'Track your agents work in different email threads' : pathname === '/create-account/' ? 'Create your account' : 'id="root"';
      if (!(response.headers.get('content-type') || '').includes('text/html') || !html.includes(expected)) throw new Error(`${pathname} frontend page is missing`);
      if (pathname === '/' && !html.includes('href="/create-account/"')) throw new Error('Marketing signup page link is missing');
      if (pathname === '/create-account/' && !html.includes('sign-up?returnTo=%2Fapp')) throw new Error('Account creation does not return to the workspace');
      if (pathname === '/app' && response.headers.get('x-robots-tag') !== 'noindex, nofollow') throw new Error('Workspace indexing guard is missing');
    } else { await response.body?.cancel(); }
    log(`${pathname}: passed`);
  }
  const team = await fetchImpl(new URL('/team/', target), { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  if (team.status !== 301 || team.headers.get('location') !== '/#team') throw new Error('Legacy team redirect is missing');
  await team.body?.cancel();
  log('/team/: passed');
  const signIn = await fetchImpl(new URL('/api/auth/workos/sign-in', target), { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  const authorizationUrl = new URL(signIn.headers.get('location') || '/', target);
  if (signIn.status !== 302 || authorizationUrl.protocol !== 'https:' || authorizationUrl.searchParams.get('redirect_uri') !== new URL('/api/auth/workos/callback', target).href) {
    throw new Error('WorkOS sign-in does not return to the deployment origin');
  }
  await signIn.body?.cancel();
  log('/api/auth/workos/sign-in: passed');
  log('Public smoke checks passed. Human sign-in completion, two-agent messaging and real upload/scanning still require acceptance tests.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await smokeDeployment(process.argv[2], process.argv[3]);
}
