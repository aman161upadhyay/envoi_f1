// agent-remote-auth v1 (approved revision 4, Policy B) §6.1, task RA-A2: the authorization code exchange on the real server.
// Every test runs on FileStore, and on PostgreSQL when DATABASE_URL is set (CI test:postgres). Each Policy B replay row
// of the contract is its own case, so a row that regressed to Policy A would fail here, not only in the fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { nearReplayCancellationFixture } from './agent-registration-harness.js';
import {
  api, assertOAuthError, installationsRoute, launch, listFilesRecursive, assertRemote, assertStored, assertTokenResponse, backends, clientSecret, codeParams, confidentialClient, connect, documents, edit, exchange, familyParts, formPost, freshIp, installationView, freshOwner, owner,
  publicClient, refreshParams, registrationParts, remoteFixture, remoteServer, restart, retryApprove, revokePost, stored, tokenPost, withdrawRequest, accessParts, refreshParts, codeParts, sha256, PAST
} from './agent-remote-auth-token-harness.js';

const newOwner = freshOwner;

for (const backend of backends) {
  test(`[${backend.name}] an OAuth code replay revokes the family during a NEAR outage`, { timeout: 120000 }, async t => {
    const near = await nearReplayCancellationFixture(t);
    let server = await remoteServer(t, backend);
    const who = await newOwner(server);
    const grant = await connect(server, who);
    assertTokenResponse(await exchange(server, grant));
    const { registration } = await stored(documents(t, server), grant.registrationId);
    server = await restart(t, server, {
      ...near.env, ENVOI_NEAR_PAYMENT_AGENT_ACCOUNTS: JSON.stringify({ [registration.agentId]: 'milo.testnet' })
    });
    const docs = documents(t, server);
    const payment = await near.seed(docs, registration);
    assertOAuthError(await exchange(server, grant), 'invalid_grant');
    const { family } = await stored(docs, grant.registrationId);
    assert.equal(family.revokedReason, 'revoked');
    assert.deepEqual(await docs.get(payment.pending), payment.record);
    const installation = await installationView(server, who, registration);
    assert.deepEqual([installation.status, installation.endedReason], ['ended', 'activation_replay']);
    near.recover();
    await near.assertDrained(docs, payment);
  });

  test(`[${backend.name}] the exchange issues oauth_ tokens, an audience-bound family and an on_demand installation`, { timeout: 120000 }, async t => {
    const server = await remoteServer(t, backend);
    const docs = documents(t, server);
    const who = await newOwner(server);
    const grant = await connect(server, who);
    const res = await exchange(server, grant);
    const tokens = assertTokenResponse(res);
    assert.equal(tokens.expires_in, 900);

    const { registration, family } = await stored(docs, grant.registrationId);
    assert.equal(registration.status, 'activated');
    assert.equal(registration.oauth.codeUsedAt, registration.activatedAt);
    assert.equal(registration.tokenHash, undefined, 'no bootstrap token');
    assertStored('storedOAuthRegistration', { ...registration, status: 'activated' });
    assert.equal(family.audience, server.resource);
    assert.equal(family.oauthClientId, publicClient.clientId);
    assertStored('storedCredentialFamily', family);
    const accessRecord = await docs.get(accessParts(tokens.access_token));
    const refreshRecord = await docs.get(refreshParts(tokens.refresh_token));
    assert.deepEqual([accessRecord.tokenType, refreshRecord.tokenType], ['oauth_access', 'oauth_refresh']);
    assert.equal(accessRecord.usedAt, null, 'an access token is unused until its first /mcp request');
    assertStored('storedCredentialRecord', { tokenHash: sha256(tokens.access_token), ...accessRecord });
    assertStored('storedCredentialRecord', { tokenHash: sha256(tokens.refresh_token), ...refreshRecord });
    const codeIndex = await docs.get(codeParts(grant.code));
    assert.equal(codeIndex.usedAt, registration.activatedAt);
    assertStored('storedOAuthCode', codeIndex);

    // The installation is the owner's: remote_mcp_oauth, on_demand, active; neither the audience nor the client shows.
    const installation = await installationView(server, who, registration);
    assert.deepEqual([installation.connectionRoute, installation.deliveryMode, installation.status, installation.runtime], ['remote_mcp_oauth', 'on_demand', 'active', { type: 'remote_mcp', version: null }]);
    const view = JSON.stringify(installation);
    assert.ok(!view.includes(server.resource) && !view.includes(publicClient.clientId) && !view.includes('audience') && !view.includes('oauthClientId'));
    const agent = await docs.get(['inboxes', registration.agentInboxId, 'agents', `${registration.agentId}.json`]);
    assert.deepEqual([agent.status, agent.onboardingStatus], ['active', 'approved']);
    assert.deepEqual([...agent.permissions].sort(), ['receive_agent_messages', 'send_agent_messages']);

    // The consent retry now reports the exchange as completed, and never a code.
    const retried = await api(server.baseUrl, `/api/oauth/authorization-requests/${encodeURIComponent(grant.handle)}/approve`, { session: who.session, body: { target: registration.target.kind === 'new_agent' ? { kind: 'new_agent', workspaceInboxId: registration.target.workspaceInboxId, name: registration.target.name, localPart: registration.target.localPart } : registration.target, grantedPermissions: ['send_agent_messages', 'receive_agent_messages'], policyProfile: 'default' } });
    assert.equal(retried.status, 200, retried.text);
    assert.equal(retried.payload.status, 'completed');
    assert.ok(!('redirectTo' in retried.payload) && !retried.text.includes('envoi_oauth_code_'));

    // No raw code, token or verifier anywhere in storage or the logs (FileStore: every file; PostgreSQL: the log only).
    const logs = server.stdout + server.stderr;
    for (const secret of [grant.code, grant.verifier, tokens.access_token, tokens.refresh_token]) assert.ok(!logs.includes(secret), 'no secret in the logs');
    if (backend.name === 'FileStore') {
      for (const file of await listFilesRecursive(server.dataDir)) {
        const content = await readFile(file, 'utf8');
        for (const secret of [grant.code, grant.verifier, tokens.access_token, tokens.refresh_token]) assert.ok(!content.includes(secret), `${path.relative(server.dataDir, file)} holds no secret`);
      }
    }
  });

  test(`[${backend.name}] Policy B: every replay row of the approved revision 4 revokes only a genuine replay`, { timeout: 300000 }, async t => {
    const server = await remoteServer(t, backend);
    const docs = documents(t, server);

    // A connected installation, its owner, and what to check afterwards.
    async function connected(options = {}) {
      const who = await newOwner(server);
      const grant = await connect(server, who, options);
      assertTokenResponse(await exchange(server, grant));
      const { registration } = await stored(docs, grant.registrationId);
      return { who, grant, registration };
    }
    const status = async ({ who, registration }) => {
      const installation = await installationView(server, who, registration);
      const family = (await stored(docs, registration.id)).family;
      return { installation, family };
    };
    async function assertNotRevoked(connection, message) {
      const { installation, family } = await status(connection);
      assert.equal(installation.status, 'active', `${message}: the installation stays active`);
      assert.equal(family.revokedAt, null, `${message}: the family stays live`);
    }
    // The genuine replay is the control: it must still revoke, so a case that refused earlier did not consume the code.
    async function assertGenuineReplayRevokes(connection, grant) {
      assertOAuthError(await exchange(server, grant), 'invalid_grant');
      const { installation, family } = await status(connection);
      assert.deepEqual([installation.status, installation.endedReason], ['ended', 'activation_replay']);
      assert.equal(family.revokedReason, 'revoked');
      const registration = (await stored(docs, connection.registration.id)).registration;
      const installationRecord = await docs.get(['auth', 'agent-installations', registration.agentInboxId, registration.agentId, `${registration.installationId}.json`]);
      assert.ok(installationRecord.replayDetectedAt, 'the installation records replayDetectedAt');
      const agent = await docs.get(['inboxes', registration.agentInboxId, 'agents', `${registration.agentId}.json`]);
      assert.deepEqual([agent.status, agent.onboardingStatus], ['active', 'approved'], 'the identity is not frozen');
    }

    // Row: the same client, correct verifier, redirect_uri and resource, code unexpired (token-code-reused). It revokes.
    const genuine = await connected();
    await assertGenuineReplayRevokes(genuine, genuine.grant);
    const sibling = await remoteFixture('token-code-reused');
    assert.equal(sibling.steps[1].response.body.error, 'invalid_grant');

    // Rows that fail an earlier check revoke nothing, and the genuine replay still revokes afterwards.
    const rows = [
      ['missing verifier', grant => exchange(server, { ...grant, verifier: undefined }, { code_verifier: undefined }), 'invalid_request'],
      ['malformed verifier', grant => exchange(server, grant, { code_verifier: 'too-short' }), 'invalid_request'],
      ['well-formed but wrong verifier', grant => exchange(server, grant, { code_verifier: 'A'.repeat(43) }), 'invalid_grant'],
      ['wrong redirect_uri', grant => exchange(server, grant, { redirect_uri: grant.redirectUri.replace('53682', '53683') }), 'invalid_grant'],
      ['wrong resource', grant => exchange(server, grant, { resource: `${server.origin}/other` }), 'invalid_target']
    ];
    for (const [label, replay, error] of rows) {
      const connection = await connected();
      assertOAuthError(await replay(connection.grant), error);
      await assertNotRevoked(connection, label);
      await assertGenuineReplayRevokes(connection, connection.grant);
    }

    // The identical request after the code's 60 s: time-controlled by moving the stored expiry into the past.
    const expired = await connected();
    await edit(docs, codeParts(expired.grant.code), value => { value.expiresAt = PAST; });
    await edit(docs, registrationParts(expired.registration.id), value => { value.activationExpiresAt = PAST; });
    assertOAuthError(await exchange(server, expired.grant), 'invalid_grant');
    await assertNotRevoked(expired, 'an expired code');

    // Another client presents the code: unknown to it (row 4). The confidential client authenticates correctly.
    const owned = await connected();
    const intruder = { ...owned.grant, client: confidentialClient };
    assertOAuthError(await exchange(server, intruder), 'invalid_grant');
    await assertNotRevoked(owned, 'another client');

    // A confidential client whose authentication fails (row 3) revokes nothing, and carries the Basic challenge.
    const confidential = await connected({ client: confidentialClient });
    const wrongSecret = await exchange(server, confidential.grant, {}, { basic: { id: confidentialClient.clientId, secret: `${clientSecret}-wrong` } });
    assertOAuthError(wrongSecret, 'invalid_client');
    assert.equal(wrongSecret.headers.get('www-authenticate'), 'Basic realm="Envoi"');
    await assertNotRevoked(confidential, 'a failed client authentication');
    await assertGenuineReplayRevokes(confidential, confidential.grant);

    // An installation that already ended is not revoked again: the owner's revoke stays how it ended.
    const ended = await connected();
    const revoke = await api(server.baseUrl, `${installationsRoute(ended.registration.agentInboxId, ended.registration.agentId)}/${ended.registration.installationId}/revoke`, { session: ended.who.session, body: {} });
    assert.equal(revoke.status, 200, revoke.text);
    const before = await status(ended);
    assert.deepEqual([before.installation.status, before.installation.endedReason], ['ended', 'revoked']);
    assertOAuthError(await exchange(server, ended.grant), 'invalid_grant');
    const after = await status(ended);
    assert.deepEqual([after.installation.endedReason, after.installation.endedAt], ['revoked', before.installation.endedAt], 'nothing further changed');
    assert.equal((await docs.get(['auth', 'agent-installations', ended.registration.agentInboxId, ended.registration.agentId, `${ended.registration.installationId}.json`])).replayDetectedAt, null);

    // Fixture agreement: every no-revoke row of the approved fixtures names the same error as the server gave.
    const approved = Object.fromEntries(await Promise.all(['token-code-reused-missing-verifier', 'token-code-reused-malformed-verifier', 'token-code-reused-wrong-verifier', 'token-code-reused-wrong-redirect', 'token-code-reused-wrong-resource', 'token-code-reused-expired', 'token-code-reused-other-client', 'token-code-reused-confidential-auth-failed', 'token-code-reused-installation-ended']
      .map(async id => { const fixture = await remoteFixture(id); return [id, (fixture.response ?? fixture.steps.find(step => step.request.path === '/oauth/token' && step.response.status >= 400).response).body.error]; })));
    assert.deepEqual(approved, {
      'token-code-reused-missing-verifier': 'invalid_request', 'token-code-reused-malformed-verifier': 'invalid_request', 'token-code-reused-wrong-verifier': 'invalid_grant',
      'token-code-reused-wrong-redirect': 'invalid_grant', 'token-code-reused-wrong-resource': 'invalid_target', 'token-code-reused-expired': 'invalid_grant',
      'token-code-reused-other-client': 'invalid_grant', 'token-code-reused-confidential-auth-failed': 'invalid_client', 'token-code-reused-installation-ended': 'invalid_grant'
    });
  });

  test(`[${backend.name}] concurrent exchanges of one code activate once and the second holder revokes it`, { timeout: 120000 }, async t => {
    const server = await remoteServer(t, backend);
    const docs = documents(t, server);
    const who = await newOwner(server);
    const grant = await connect(server, who);
    const results = await Promise.all([exchange(server, grant), exchange(server, grant), exchange(server, grant)]);
    const winners = results.filter(res => res.status === 200);
    assert.equal(winners.length, 1, `exactly one activation: ${results.map(res => res.status)}`);
    for (const loser of results.filter(res => res.status !== 200)) assertOAuthError(loser, 'invalid_grant');
    const { registration } = await stored(docs, grant.registrationId);
    // Two holders of one code: the installation the first exchange created is ended, as agent-registration §6.1 row 7a does.
    const installation = await installationView(server, who, registration);
    assert.deepEqual([installation.status, installation.endedReason], ['ended', 'activation_replay']);
  });

  test(`[${backend.name}] unused codes: a refused exchange consumes nothing, and a withdrawn or lapsed approval is invalid_grant`, { timeout: 120000 }, async t => {
    const server = await remoteServer(t, backend);
    const docs = documents(t, server);
    const who = await newOwner(server);

    // A failed PKCE check on an unused code leaves it usable.
    const first = await connect(server, who);
    assertOAuthError(await exchange(server, first, { code_verifier: 'B'.repeat(43) }), 'invalid_grant');
    assert.equal((await docs.get(codeParts(first.code))).usedAt, null);
    assertTokenResponse(await exchange(server, first));

    // token-approval-withdrawn: the owner withdrew before the exchange; the registration stays withdrawn.
    const second = await newOwner(server);
    const withdrawn = await connect(server, second);
    const gone = await withdrawRequest(server.baseUrl, second, withdrawn.registrationId);
    assert.equal(gone.status, 200, gone.text);
    const retriedWithdrawn = await retryApprove(server, withdrawn);
    assert.deepEqual([retriedWithdrawn.status, retriedWithdrawn.payload.status, 'redirectTo' in retriedWithdrawn.payload], [200, 'withdrawn', false], 'consent-approve-retry-withdrawn');
    assertOAuthError(await exchange(server, withdrawn), 'invalid_grant');
    assert.equal((await docs.get(registrationParts(withdrawn.registrationId))).status, 'withdrawn');

    // An approval that lapsed unexchanged.
    const lapsed = await connect(server, await newOwner(server));
    await edit(docs, codeParts(lapsed.code), value => { value.expiresAt = PAST; });
    await edit(docs, registrationParts(lapsed.registrationId), value => { value.activationExpiresAt = PAST; });
    const retriedLapsed = await retryApprove(server, lapsed);
    assert.deepEqual([retriedLapsed.status, retriedLapsed.payload.status, 'redirectTo' in retriedLapsed.payload], [200, 'expired', false], 'consent-approve-retry-expired');
    assertOAuthError(await exchange(server, lapsed), 'invalid_grant');

    // Row 10: a re-check that fails at exchange time (here the route flag's client vanishing is covered elsewhere; the owner
    // losing the workspace is what the registration re-check reads) withdraws the registration.
    const recheck = await connect(server, await newOwner(server));
    await edit(docs, registrationParts(recheck.registrationId), value => { value.approverHumanId = 'human_missing'; });
    assertOAuthError(await exchange(server, recheck), 'invalid_grant');
    assert.equal((await docs.get(registrationParts(recheck.registrationId))).status, 'withdrawn');
  });

  test(`[${backend.name}] an existing agent reconnects: the earlier installation is replaced and its tokens end`, { timeout: 120000 }, async t => {
    const server = await remoteServer(t, backend);
    const docs = documents(t, server);
    const who = await newOwner(server);
    const listed = await api(server.baseUrl, installationsRoute(who.inbox.id, who.agent.id), { session: who.session });
    const current = listed.payload.installations.find(item => item.status === 'active');
    assert.ok(current, 'the enrolled agent has an active legacy installation');
    const grant = await connect(server, who, { target: { kind: 'existing_agent', agentId: who.agent.id, replacesInstallationId: current.id } });
    assertTokenResponse(await exchange(server, grant));
    const { registration } = await stored(docs, grant.registrationId);
    assert.equal(registration.agentId, who.agent.id);
    const after = await api(server.baseUrl, installationsRoute(who.inbox.id, who.agent.id), { session: who.session });
    const byId = Object.fromEntries(after.payload.installations.map(item => [item.id, item]));
    assert.deepEqual([byId[current.id].status, byId[current.id].endedReason], ['ended', 'replaced']);
    assert.deepEqual([byId[registration.installationId].status, byId[registration.installationId].connectionRoute], ['active', 'remote_mcp_oauth']);
    const old = await api(server.baseUrl, '/api/agent/status', { token: who.agentApiToken });
    assert.equal(old.payload?.code, 'CREDENTIAL_REVOKED', 'the replaced installation\'s access token is refused');
  });
}

// M6 (review 6349153739): successes and failures, on the token and revocation endpoints alike, each count once toward the 60.
for (const backend of backends) {
  test(`[${backend.name}] the per-source limit counts each request once, successful or not, across token and revocation`, { timeout: 180000 }, async t => {
    const server = await remoteServer(t, backend);
    const who = await newOwner(server);
    const grant = await connect(server, who);
    const ip = freshIp();
    const statuses = [];
    // 1 exchange and 1 refresh that succeed, 29 revocations of an unknown token (200), 29 invalid_grant failures: 60 requests.
    const tokens = assertTokenResponse(await exchange(server, grant, {}, { ip }));
    statuses.push(200);
    const refreshed = await tokenPost(server, refreshParams(publicClient, tokens.refresh_token), { ip });
    assertTokenResponse(refreshed);
    statuses.push(refreshed.status);
    for (let index = 0; index < 29; index += 1) {
      statuses.push((await revokePost(server, { token: `envoi_agent_refresh_${'u'.repeat(43)}`, client_id: publicClient.clientId }, { ip })).status);
      const failed = await tokenPost(server, codeParams({ ...grant, resource: server.resource }, { code: `envoi_oauth_code_${'y'.repeat(43)}` }), { ip });
      assertOAuthError(failed, 'invalid_grant');
      statuses.push(failed.status);
    }
    assert.equal(statuses.length, 60);
    assert.deepEqual(statuses.filter(status => status === 429), [], 'every one of the 60 is answered');
    const sixtyFirst = await revokePost(server, { token: `envoi_agent_refresh_${'u'.repeat(43)}`, client_id: publicClient.clientId }, { ip });
    assertOAuthError(sixtyFirst, 'temporarily_unavailable', 429);
    assert.match(sixtyFirst.headers.get('retry-after'), /^[1-9]\d*$/);
    // Another source is unaffected.
    assert.equal((await revokePost(server, { token: `envoi_agent_refresh_${'u'.repeat(43)}`, client_id: publicClient.clientId })).status, 200);
  });
}

test('[server] the token endpoint: parameters, client authentication and the per-source limit', { timeout: 120000 }, async t => {
  const backend = backends[0];
  const server = await remoteServer(t, backend);
  const who = await newOwner(server);
  const grant = await connect(server, who);
  const ip = freshIp();
  const post = (params, options = {}) => tokenPost(server, params, { ip, ...options });

  // Row 2 and the grant type: nothing is looked up.
  assertOAuthError(await post({}), 'invalid_request');
  assertOAuthError(await post({ grant_type: 'password', client_id: publicClient.clientId }), 'unsupported_grant_type');
  assertOAuthError(await post({ grant_type: 'urn:envoi:params:oauth:grant-type:bootstrap_code', client_id: publicClient.clientId }), 'unsupported_grant_type');
  assertOAuthError(await post({ grant_type: 'authorization_code', client_id: publicClient.clientId }), 'invalid_request');
  assertOAuthError(await formPost(server.baseUrl, '/oauth/token', {}, { ip, raw: 'grant_type=authorization_code&grant_type=refresh_token' }), 'invalid_request');
  const json = await fetch(`${server.baseUrl}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: '{}' });
  assert.equal(json.status, 400);
  assert.equal((await fetch(`${server.baseUrl}/oauth/token`, { headers: { 'x-forwarded-for': ip } })).status, 405);
  const large = await formPost(server.baseUrl, '/oauth/token', {}, { ip, raw: `grant_type=authorization_code&code=${'a'.repeat(9000)}` });
  assertOAuthError(large, 'invalid_request');

  // Row 3: client authentication.
  const params = codeParams({ ...grant, resource: server.resource });
  assertOAuthError(await post({ ...params, client_id: 'client_unknown-example' }), 'invalid_client');
  assertOAuthError(await post({ ...params, client_id: undefined }), 'invalid_client');
  const publicWithSecret = await post({ ...params }, { basic: { id: publicClient.clientId, secret: 'anything' } });
  assertOAuthError(publicWithSecret, 'invalid_client');
  assert.equal(publicWithSecret.headers.get('www-authenticate'), 'Basic realm="Envoi"', 'token-public-client-secret');
  assertOAuthError(await post({ ...params, client_id: confidentialClient.clientId }), 'invalid_client');
  const mismatch = await post({ ...params, client_id: publicClient.clientId }, { basic: { id: confidentialClient.clientId, secret: clientSecret } });
  assertOAuthError(mismatch, 'invalid_client');
  const missingClient = await post({ ...params, client_id: undefined });
  assert.equal(missingClient.headers.get('www-authenticate'), null, 'no Basic challenge when the client did not use Basic');

  // Row 4 on: unknown, and a code that is not this client's, are invalid_grant.
  assertOAuthError(await post({ ...params, code: 'envoi_oauth_code_unknownunknownunknownunknownunknownunknown' }), 'invalid_grant');
  assertOAuthError(await post({ ...params, code: 'not-a-code' }), 'invalid_request');
  assertTokenResponse(await post(params), 'envoi.agent envoi.send');

  // §6 (M6, review 6349153739): a source is limited to 60 requests a minute and every request counts once, a failure from
  // row 4 on included; there is no extra debit for failing.
  const limited = freshIp();
  const attempts = [];
  for (let attempt = 0; attempt < 61; attempt += 1) attempts.push(await tokenPost(server, { ...params, code: `envoi_oauth_code_${'z'.repeat(43)}` }, { ip: limited }));
  assert.deepEqual(attempts.slice(0, 60).map(res => res.status), Array(60).fill(400), 'all 60 failures are answered');
  attempts.slice(0, 60).forEach(res => assertOAuthError(res, 'invalid_grant'));
  const refused = attempts[60];
  assert.equal(refused.status, 429);
  assertOAuthError(refused, 'temporarily_unavailable', 429);
  assert.match(refused.headers.get('retry-after'), /^[1-9]\d*$/);
  assert.deepEqual(await remoteFixture('token-rate-limited').then(fixture => fixture.response.body.error), 'temporarily_unavailable');
  const plain = freshIp();
  for (let attempt = 0; attempt < 60; attempt += 1) assert.equal((await tokenPost(server, { grant_type: 'nope' }, { ip: plain })).status, 400);
  assert.equal((await tokenPost(server, { grant_type: 'nope' }, { ip: plain })).status, 429, 'the 61st request in a minute is refused');
});

test('[server] flags off: the token, revocation and bootstrap endpoints are FEATURE_DISABLED and store nothing', async t => {
  const server = await launch({ ENVOI_AGENT_REGISTRATION_V2: 'true', ENVOI_INSTALLATIONS_V2: 'true' });
  t.after(() => server.stop());
  for (const route of ['/oauth/token', '/oauth/revoke']) {
    const res = await formPost(server.baseUrl, route, { grant_type: 'authorization_code', token: 'x' });
    assert.equal(res.status, 404);
    assert.equal(res.payload.code, 'FEATURE_DISABLED');
  }
  const who = await owner(server.baseUrl, '8001');
  const bootstrap = await api(server.baseUrl, '/api/oauth/bootstrap-codes', { session: who.session, body: {} });
  assert.equal(bootstrap.status, 404);
  assert.equal(bootstrap.payload.code, 'FEATURE_DISABLED');
  assert.ok(!(await listFilesRecursive(server.dataDir)).some(file => /oauth-(consent-decisions|codes|cleanup)|agent-oauth-refresh-recovery|rate-limits[\\/]oauth/.test(file)), 'no remote-auth records');
});
