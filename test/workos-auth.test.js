import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/storage.js';
import { authFlowCookieHeader, authFlowCookieName, createCsrfToken, csrfCookieHeader, membershipCanManage, parseCookies, providerMembershipCanManage, safeReturnPath, sessionCookieHeader, verifyCsrfRequest, WorkOSAuthService } from '../src/workos-auth.js';

test('management authority follows active provider membership after role changes', () => {
  const membership = { status: 'active', role: { slug: 'admin' } };
  assert.equal(providerMembershipCanManage(membership), true);
  membership.role.slug = 'member';
  assert.equal(providerMembershipCanManage(membership), false);
  assert.equal(providerMembershipCanManage({ status: 'inactive', role: { slug: 'admin' } }), false);
  assert.equal(providerMembershipCanManage({ status: 'active' }), false);
  assert.equal(providerMembershipCanManage(null), false);
});

test('enrollment management requires both current local and provider authority', () => {
  const localAdmin = { status: 'active', role: 'admin', providerMembership: { status: 'active', role: { slug: 'admin' } } };
  assert.equal(membershipCanManage(localAdmin, 'workos'), true);
  assert.equal(membershipCanManage({ ...localAdmin, role: 'member' }, 'workos'), false);
  assert.equal(membershipCanManage({ ...localAdmin, providerMembership: { status: 'active', role: { slug: 'member' } } }, 'workos'), false);
  assert.equal(membershipCanManage({ ...localAdmin, providerMembership: null }, 'workos'), false);
  assert.equal(membershipCanManage({ status: 'active', role: 'owner' }, 'local'), true);
});

test('WorkOS return paths cannot escape the application origin', () => {
  assert.equal(safeReturnPath('/inbox?workspace=one#latest'), '/inbox?workspace=one#latest');
  assert.equal(safeReturnPath('/\\evil.example'), '/');
  assert.equal(safeReturnPath('//evil.example'), '/');
  assert.equal(safeReturnPath('/%5cevil.example'), '/');
  assert.equal(safeReturnPath('/%255cevil.example'), '/');
  assert.equal(safeReturnPath('https://evil.example'), '/');
});

test('WorkOS cookie mutations require a matching CSRF token and exact origin', () => {
  const previousPublicUrl = process.env.ENVOI_PUBLIC_URL;
  process.env.ENVOI_PUBLIC_URL = 'https://app.sinaloa.example';
  try {
    const token = createCsrfToken();
    const cookie = csrfCookieHeader(token).split(';')[0];
    assert.equal(verifyCsrfRequest({ headers: { cookie, origin: 'https://app.sinaloa.example', 'x-envoi-csrf': token } }), true);
    assert.equal(verifyCsrfRequest({ headers: { cookie, origin: 'https://evil.example', 'x-envoi-csrf': token } }), false);
    assert.equal(verifyCsrfRequest({ headers: { cookie, origin: 'https://app.sinaloa.example', 'x-envoi-csrf': 'wrong' } }), false);
  } finally {
    if (previousPublicUrl === undefined) delete process.env.ENVOI_PUBLIC_URL;
    else process.env.ENVOI_PUBLIC_URL = previousPublicUrl;
  }
});

test('malformed cookies do not bypass admission or crash CSRF validation', () => {
  assert.deepEqual(parseCookies('envoi_session=%E0%A4%A; envoi_csrf=valid'), { envoi_csrf: 'valid' });
  assert.equal(verifyCsrfRequest({ headers: { cookie: 'envoi_session=%E0%A4%A; envoi_csrf=%E0%A4%A', origin: 'http://localhost:3000', host: 'localhost:3000', 'x-envoi-csrf': 'valid' } }), false);
});

test('WorkOS auth uses one-time PKCE state and maps provider users to stable humans', async () => {
  const store = new FileStore(await mkdtemp(path.join(tmpdir(), 'sinaloa-workos-')));
  await store.init();
  const calls = { organizations: [], memberships: [] };
  const user = { id: 'user_workos_1', email: 'rachel@example.com', emailVerified: true, name: 'Rachel Gonsalves', firstName: 'Rachel', lastName: 'Gonsalves' };
  const fakeWorkos = {
    userManagement: {
      getAuthorizationUrlWithPKCE: async options => ({ url: `https://auth.example.test/?state=state_1&screen=${options.screenHint}`, state: 'state_1', codeVerifier: 'verifier_1' }),
      authenticateWithCode: async options => {
        assert.equal(options.codeVerifier, 'verifier_1');
        assert.equal(options.session.sealSession, true);
        return { user, accessToken: 'access', refreshToken: 'refresh', sealedSession: 'sealed_session_1' };
      },
      loadSealedSession: ({ sessionData }) => ({
        authenticate: async () => sessionData === 'sealed_session_1' ? { authenticated: true, user, sessionId: 'session_1', organizationId: 'org_workos_1', role: 'admin', permissions: ['workspace:manage'] } : { authenticated: false, reason: 'invalid_session_cookie' },
        getLogoutUrl: async () => 'https://auth.example.test/logout'
      }),
      listOrganizationMemberships: async ({ userId, organizationId, statuses }) => ({ data: userId === user.id && organizationId === 'org_workos_1' && statuses.includes('active') ? [{ id: 'membership_1', userId, organizationId, status: 'active', role: { slug: 'admin' } }] : [] }),
      createOrganizationMembership: async input => { calls.memberships.push(input); return { id: 'membership_1', ...input }; }
    },
    organizations: {
      createOrganization: async (input, options) => { calls.organizations.push({ input, options }); return { id: 'org_workos_1', name: input.name }; }
    }
  };
  const auth = new WorkOSAuthService(store, { clientId: 'client_1', apiKey: 'sk_test_1', cookiePassword: '12345678901234567890123456789012', redirectUri: 'https://sinaloa.test/api/auth/workos/callback', issuer: 'https://issuer.example.test', workos: fakeWorkos, invitedEmails: 'rachel@example.com' });
  const started = await auth.startAuthorization({ screenHint: 'sign-up', returnTo: '/onboarding' });
  assert.match(started.url, /screen=sign-up/);
  const completed = await auth.completeAuthorization({ code: 'code_1', state: 'state_1', browserBinding: started.browserBinding, ipAddress: '127.0.0.1', userAgent: 'test' });
  assert.equal(completed.sealedSession, 'sealed_session_1');
  assert.equal(completed.returnTo, '/onboarding');
  assert.equal(completed.human.email, 'rachel@example.com');
  await assert.rejects(() => auth.completeAuthorization({ code: 'code_1', state: 'state_1', browserBinding: started.browserBinding }), /already used/);

  const cookie = sessionCookieHeader('sealed_session_1');
  const human = await auth.getHuman({ headers: { cookie } });
  assert.equal(human.id, completed.human.id);
  const writeTransaction = store.withTransaction.bind(store);
  let repeatedWrites = 0;
  store.withTransaction = (...args) => { repeatedWrites += 1; return writeTransaction(...args); };
  assert.equal((await auth.getHuman({ headers: { cookie } })).id, human.id);
  assert.equal(repeatedWrites, 0, 'unchanged authenticated reads need no write lock');
  store.withTransaction = writeTransaction;
  assert.equal(human.providerUserId, 'user_workos_1');
  assert.equal(human.organizationId, 'org_workos_1');
  assert.equal(human.role, 'admin');
  assert.equal((await auth.getSession({ headers: { cookie } })).assurance, 'provider');
  assert.equal(await auth.getHuman({ headers: { cookie: cookie.replace('sealed_session_1', 'invalid_session') } }), null);
  user.id = 'user_other';
  const otherHuman = await auth.getHuman({ headers: { cookie } });
  assert.notEqual(otherHuman.id, human.id);
  assert.equal(otherHuman.providerUserId, 'user_other');
  user.id = 'user_workos_1';
  const providerMembership = await auth.getOrganizationMembership(human.providerUserId, human.organizationId);
  assert.equal(providerMembership.status, 'active');
  assert.equal(providerMembership.role.slug, 'admin');

  const organization = await auth.createProviderOrganization({ name: 'Sinaloa Test', externalId: 'org_local_1', idempotencyKey: 'org-create-1', userId: human.providerUserId });
  assert.equal(organization.id, 'org_workos_1');
  assert.equal(calls.organizations[0].options.idempotencyKey, 'org-create-1');
  assert.deepEqual(calls.memberships[0], { organizationId: 'org_workos_1', userId: 'user_workos_1', roleSlug: 'admin' });
});

test('WorkOS email verification alone does not admit an uninvited human', async () => {
  const store = new FileStore(await mkdtemp(path.join(tmpdir(), 'sinaloa-workos-uninvited-')));
  await store.init();
  const user = { id: 'user_uninvited', email: 'outsider@example.com', emailVerified: true };
  const workos = { userManagement: {
    getAuthorizationUrlWithPKCE: async () => ({ url: 'https://auth.example.test/', state: 'state_uninvited', codeVerifier: 'verifier_uninvited' }),
    authenticateWithCode: async () => ({ user, sealedSession: 'sealed_uninvited' }),
    loadSealedSession: () => ({ authenticate: async () => ({ authenticated: true, user, sessionId: 'session_uninvited' }) })
  } };
  const auth = new WorkOSAuthService(store, { clientId: 'client_1', apiKey: 'sk_test_1', cookiePassword: '12345678901234567890123456789012', redirectUri: 'https://sinaloa.test/callback', workos, invitedEmails: 'rachel@example.com' });
  const started = await auth.startAuthorization();
  await assert.rejects(() => auth.completeAuthorization({ code: 'code_uninvited', state: 'state_uninvited', browserBinding: started.browserBinding }), { statusCode: 403 });
  assert.deepEqual(await store.listJson('humans'), []);
  const req = { headers: { cookie: 'envoi_session=sealed' } };
  assert.equal(await auth.getHuman(req), null);
  assert.equal(await auth.getHuman({ headers: { cookie: 'envoi_session=%E0%A4%A' } }), null);
});

const admittedUser = { id: 'user_fixture', email: 'fixture@example.com', emailVerified: true, name: 'Fixture' };
async function fixtureAuth(workos) {
  workos = { ...workos, userManagement: {
    getSessionFromCookie: async () => ({
      accessToken: `header.${Buffer.from(JSON.stringify({ sid: 'session_fixture', iat: Math.floor(Date.now() / 1000) - 60, exp: Math.floor(Date.now() / 1000) - 1 })).toString('base64url')}.signature`,
      refreshToken: 'fixture_refresh'
    }),
    ...workos.userManagement
  } };
  const store = new FileStore(await mkdtemp(path.join(tmpdir(), 'sinaloa-workos-fixture-')));
  await store.init();
  const auth = new WorkOSAuthService(store, {
    clientId: 'client_fixture', apiKey: 'fixture', cookiePassword: '12345678901234567890123456789012',
    redirectUri: 'https://fixture.example/api/auth/workos/callback', invitedEmails: admittedUser.email, workos
  });
  return { store, auth };
}
const cookieRequest = (value = 'expired_cookie') => ({ headers: { cookie: `envoi_session=${value}` } });
const cookieResponses = new WeakMap();
function emittedSessionCookie(auth, req) {
  if (cookieResponses.has(req)) return null;
  const res = {
    headers: new Map(), headersSent: false,
    getHeader(name) { return this.headers.get(name); },
    setHeader(name, value) { this.headers.set(name, value); },
    writeHead() { this.headersSent = true; }
  };
  cookieResponses.set(req, res);
  auth.bindResponse(req, res);
  res.writeHead(200);
  const header = (res.getHeader('Set-Cookie') || []).find(cookie => cookie.startsWith('envoi_session='));
  return header && !header.includes('Max-Age=0') ? parseCookies(header.split(';')[0]).envoi_session : null;
}

test('authorization binding cookie is private, short-lived and secure in production', () => {
  const previousMode = process.env.ENVOI_AUTH_MODE;
  process.env.ENVOI_AUTH_MODE = 'production';
  try {
    const header = authFlowCookieHeader('binding');
    assert.match(header, new RegExp(`^${authFlowCookieName()}=binding;`));
    assert.match(header, /Path=\/api\/auth\/workos/);
    assert.match(header, /HttpOnly/);
    assert.match(header, /SameSite=Lax/);
    assert.match(header, /Secure/);
    assert.match(header, /Max-Age=600/);
    assert.doesNotMatch(header, /Domain=/);
    assert.match(authFlowCookieHeader('', { clear: true }), /Max-Age=0/);
  } finally {
    if (previousMode === undefined) delete process.env.ENVOI_AUTH_MODE;
    else process.env.ENVOI_AUTH_MODE = previousMode;
  }
});

test('missing or another browser binding cannot consume a valid PKCE flow', async () => {
  let exchanges = 0;
  const { auth, store } = await fixtureAuth({ userManagement: {
    getAuthorizationUrlWithPKCE: async () => ({ url: 'https://auth.example/', state: 'binding_state', codeVerifier: 'verifier' }),
    authenticateWithCode: async () => { exchanges += 1; return { user: admittedUser, sealedSession: 'bound_cookie' }; },
    loadSealedSession: () => ({ authenticate: async () => ({ authenticated: true, user: admittedUser, sessionId: 'session_fixture' }) })
  } });
  const started = await auth.startAuthorization();
  const flow = (await store.listJson(path.join('auth', 'workos-flows')))[0];
  assert.notEqual(flow.browserBindingHash, started.browserBinding);
  assert.match(flow.browserBindingHash, /^[a-f0-9]{64}$/);
  await assert.rejects(auth.completeAuthorization({ code: 'code', state: 'binding_state' }), { statusCode: 401 });
  await assert.rejects(auth.completeAuthorization({ code: 'code', state: 'binding_state', browserBinding: 'A'.repeat(43) }), { statusCode: 401 });
  assert.equal(exchanges, 0);
  assert.equal((await store.listJson(path.join('auth', 'workos-flows')))[0].usedAt, null);
  const result = await auth.completeAuthorization({ code: 'code', state: 'binding_state', browserBinding: started.browserBinding });
  assert.equal(result.human.email, admittedUser.email);
  assert.equal(exchanges, 1);
  await assert.rejects(auth.completeAuthorization({ code: 'code', state: 'binding_state', browserBinding: started.browserBinding }), { statusCode: 401 });
  assert.equal(exchanges, 1);
});

test('revoked provider sessions prompt one fresh sign-in without issuing a dead cookie', async () => {
  let authorizationCount = 0;
  let sessionId = 'session_revoked';
  const maxAges = [];
  const revokedSessions = [];
  const { auth, store } = await fixtureAuth({ userManagement: {
    getAuthorizationUrlWithPKCE: async options => {
      maxAges.push(options.maxAge);
      authorizationCount += 1;
      return { url: 'https://auth.example/', state: `state_${authorizationCount}`, codeVerifier: 'verifier' };
    },
    authenticateWithCode: async () => ({ user: admittedUser, sealedSession: 'sealed' }),
    loadSealedSession: () => ({ authenticate: async () => ({ authenticated: true, user: admittedUser, sessionId }) }),
    revokeSession: async ({ sessionId: revokedSessionId }) => { revokedSessions.push(revokedSessionId); }
  } });
  await store.putJson(auth.sessionPath(sessionId), { sessionId, revokedAt: store.now(), replays: [] });
  const first = await auth.startAuthorization({ returnTo: '/inbox' });
  const denied = await auth.completeAuthorization({ code: 'first', state: 'state_1', browserBinding: first.browserBinding });
  assert.deepEqual(denied, { reauthenticate: true, forceFresh: false, returnTo: '/inbox' });
  assert.deepEqual(await store.listJson('humans'), []);

  const fresh = await auth.startAuthorization({ returnTo: denied.returnTo, forceFresh: true });
  assert.deepEqual(maxAges, [undefined, 0]);
  const stillDenied = await auth.completeAuthorization({ code: 'second', state: 'state_2', browserBinding: fresh.browserBinding });
  assert.deepEqual(stillDenied, { reauthenticate: true, forceFresh: true, returnTo: '/inbox' });
  assert.deepEqual(revokedSessions, ['session_revoked', 'session_revoked']);
  assert.deepEqual(await store.listJson('humans'), []);

  const next = await auth.startAuthorization({ returnTo: denied.returnTo, forceFresh: true });
  sessionId = 'session_new';
  const accepted = await auth.completeAuthorization({ code: 'third', state: 'state_3', browserBinding: next.browserBinding });
  assert.equal(accepted.human.email, admittedUser.email);
  assert.equal(accepted.returnTo, '/inbox');
});

test('parallel first authentication retains one stable provider-user human identity', async () => {
  const { auth, store } = await fixtureAuth({});
  const humans = await Promise.all(Array.from({ length: 12 }, () => auth.upsertHuman(admittedUser)));
  assert.equal(new Set(humans.map(human => human.id)).size, 1);
  assert.equal((await store.listJson('humans')).length, 1);
  const index = (await store.listJson(path.join('auth', 'workos-user-index')))[0];
  assert.equal(index.humanId, humans[0].id);
  const updated = await auth.upsertHuman({ ...admittedUser, name: 'Updated fixture' });
  assert.equal(updated.id, humans[0].id);
  assert.equal(updated.displayName, 'Updated fixture');
});

test('unchanged WorkOS session avoids write transactions while revocation still denies access', async () => {
  const { auth, store } = await fixtureAuth({});
  await auth.upsertHuman(admittedUser);
  const session = { sessionId: 'session_fast_path', user: admittedUser };
  assert.ok(await auth.recordSession(session));
  const transaction = store.withTransaction.bind(store);
  let writes = 0;
  store.withTransaction = (...args) => { writes += 1; return transaction(...args); };

  assert.ok(await auth.recordSession(session));
  assert.equal(writes, 0);

  assert.equal((await auth.upsertHuman({ ...admittedUser, name: 'Changed name' })).displayName, 'Changed name');
  assert.equal(writes, 1);
  const relative = auth.sessionPath(session.sessionId);
  const record = await store.getJson(relative);
  await store.putJson(relative, { ...record, revokedAt: store.now() });
  const beforeRejectedSession = writes;
  assert.equal(await auth.recordSession(session), null);
  assert.equal(writes, beforeRejectedSession + 1);
});

test('provider-user human and index writes roll back together on failure', async () => {
  const { auth, store } = await fixtureAuth({});
  const batch = store.putJsonBatch.bind(store);
  store.putJsonBatch = async documents => {
    await batch(documents.slice(0, 1));
    throw new Error('fixture index write failure');
  };
  await assert.rejects(auth.upsertHuman(admittedUser), /fixture index write failure/);
  assert.deepEqual(await store.listJson('humans'), []);
  assert.deepEqual(await store.listJson(path.join('auth', 'workos-user-index')), []);
  store.putJsonBatch = batch;
  assert.equal((await auth.upsertHuman(admittedUser)).email, admittedUser.email);
});

test('expired provider access renews once across concurrent requests and preserves provider assurance', async () => {
  let refreshCalls = 0;
  let renewedAuthentications = 0;
  const { auth } = await fixtureAuth({ userManagement: {
    loadSealedSession: ({ sessionData }) => ({
      authenticate: async () => {
        if (sessionData === 'renewed_cookie') {
          renewedAuthentications += 1;
          return { authenticated: true, user: admittedUser, sessionId: 'session_fixture', role: 'admin' };
        }
        return { authenticated: false, reason: 'invalid_jwt' };
      },
      refresh: async () => {
        refreshCalls += 1;
        await new Promise(resolve => setImmediate(resolve));
        return { authenticated: true, sealedSession: 'renewed_cookie' };
      }
    })
  } });
  const requests = Array.from({ length: 8 }, () => cookieRequest());
  const sessions = await Promise.all(requests.map(req => auth.getSession(req)));
  assert.equal(refreshCalls, 1);
  assert.equal(renewedAuthentications, 8, 'each concurrent request verifies the shared replacement');
  assert.ok(sessions.every(session => session.user.id === admittedUser.id && session.assurance === 'provider'));
  for (const req of requests) {
    assert.equal(emittedSessionCookie(auth, req), 'renewed_cookie');
    assert.equal(emittedSessionCookie(auth, req), null);
  }
  const lateRequest = cookieRequest();
  assert.equal((await auth.getSession(lateRequest)).user.id, admittedUser.id);
  assert.equal(refreshCalls, 1);
  assert.equal(emittedSessionCookie(auth, lateRequest), 'renewed_cookie');
});

test('human and session lookups on one request share renewal and only expose an admitted cookie', async () => {
  let expiredChecks = 0;
  let refreshCalls = 0;
  const { auth } = await fixtureAuth({ userManagement: {
    loadSealedSession: ({ sessionData }) => ({
      authenticate: async () => {
        if (sessionData === 'renewed_cookie') return { authenticated: true, user: admittedUser, sessionId: 'session_fixture' };
        expiredChecks += 1;
        return { authenticated: false, reason: 'invalid_jwt' };
      },
      refresh: async () => { refreshCalls += 1; return { authenticated: true, sealedSession: 'renewed_cookie' }; }
    })
  } });
  const req = cookieRequest();
  const [human, session] = await Promise.all([auth.getHuman(req), auth.getSession(req)]);
  assert.equal(human.providerUserId, admittedUser.id);
  assert.equal(session.assurance, 'provider');
  assert.equal(expiredChecks, 1);
  assert.equal(refreshCalls, 1);
  assert.equal(emittedSessionCookie(auth, req), 'renewed_cookie');
});

test('terminal and recoverable provider failures never grant access', async t => {
  for (const scenario of ['revoked', 'unavailable', 'invalid-renewed-jwt', 'uninvited', 'unverified']) {
    await t.test(scenario, async () => {
      const { auth, store } = await fixtureAuth({ userManagement: {
        loadSealedSession: ({ sessionData }) => ({
          authenticate: async () => {
            if (sessionData !== 'renewed_cookie' || scenario === 'invalid-renewed-jwt') return { authenticated: false, reason: 'invalid_jwt' };
            return { authenticated: true, user: scenario === 'uninvited' ? { ...admittedUser, email: 'outsider@example.com' }
              : scenario === 'unverified' ? { ...admittedUser, emailVerified: false } : admittedUser, sessionId: 'session_fixture' };
          },
          refresh: async () => {
            if (scenario === 'revoked') return { authenticated: false, reason: 'session_revoked' };
            if (scenario === 'unavailable') throw new Error('provider unavailable');
            return { authenticated: true, sealedSession: 'renewed_cookie' };
          }
        })
      } });
      const req = cookieRequest();
      if (scenario === 'unavailable' || scenario === 'invalid-renewed-jwt') {
        await assert.rejects(auth.getHuman(req), { statusCode: 503, code: 'auth_unavailable' });
      } else assert.equal(await auth.getHuman(req), null);
      assert.equal(emittedSessionCookie(auth, req), null);
      assert.deepEqual(await store.listJson('humans'), []);
    });
  }
});

test('malformed sealed cookies fail closed and never attempt provider refresh', async () => {
  let refreshCalls = 0;
  const { auth } = await fixtureAuth({ userManagement: {
    loadSealedSession: () => ({ authenticate: async () => ({ authenticated: false, reason: 'invalid_session_cookie' }), refresh: async () => { refreshCalls += 1; } })
  } });
  const req = cookieRequest('bad_cookie');
  assert.equal(await auth.getSession(req), null);
  assert.equal(refreshCalls, 0);
  assert.equal(emittedSessionCookie(auth, req), null);
});

test('already valid provider sessions do not renew and memoize authentication per request', async () => {
  let authentications = 0;
  let refreshCalls = 0;
  const { auth } = await fixtureAuth({ userManagement: {
    loadSealedSession: () => ({
      authenticate: async () => { authentications += 1; return { authenticated: true, user: admittedUser, sessionId: 'session_fixture' }; },
      refresh: async () => { refreshCalls += 1; }
    })
  } });
  const req = cookieRequest('valid_cookie');
  await Promise.all([auth.getHuman(req), auth.getSession(req), auth.getSession(req)]);
  assert.equal(authentications, 1);
  assert.equal(refreshCalls, 0);
  assert.equal(emittedSessionCookie(auth, req), null);
});

test('logout can clear an expired revoked session and never restores a replacement cookie', async () => {
  const { auth } = await fixtureAuth({ userManagement: {
    loadSealedSession: () => ({
      authenticate: async () => ({ authenticated: false, reason: 'invalid_jwt' }),
      refresh: async () => ({ authenticated: false, reason: 'session_revoked' })
    })
  } });
  const req = cookieRequest();
  assert.deepEqual(await auth.logout(req), { revoked: true, logoutUrl: null, sessionId: 'session_fixture', providerRevoked: false });
  assert.equal(emittedSessionCookie(auth, req), null);
});
