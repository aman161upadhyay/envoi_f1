// agent-remote-auth v1 (approved revision 4) §6.2 refresh and §7 revocation, with agent-registration v1 revision 5 §14.5
// storage: rotation, the 60 s recovery envelope, successor use, genuine replay, client binding, restart, concurrency and the
// revocation endpoint, on the real server. FileStore always, and PostgreSQL when DATABASE_URL is set (CI test:postgres).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  api, assertOAuthError, assertStored, assertTokenResponse, backends, clientSecret, confidentialClient, connect, documents, edit, exchange, familyParts, installationView, freshOwner, owner,
  publicClient, recoveryParts, refreshParams, refreshParts, accessParts, restart, revokePost, remoteServer, sha256, stored, tokenPost, PAST, freshIp, openStore
} from './agent-remote-auth-token-harness.js';
import { reapAgentRotationRecovery } from '../src/agent-rotation-recovery.js';

const newOwner = freshOwner;
const agentUrl = (registration, action) => `/api/inboxes/${registration.agentInboxId}/agents/${registration.agentId}/${action}`;

// A connected installation and its first tokens.
async function connected(server, docs, options = {}) {
  const who = await newOwner(server);
  const grant = await connect(server, who, options);
  const tokens = assertTokenResponse(await exchange(server, grant));
  const { registration } = await stored(docs, grant.registrationId);
  return { who, grant, tokens, registration, familyPath: familyParts(registration.agentInboxId, registration.agentId, registration.credentialFamilyId) };
}
const refresh = (server, connection, token, extra = {}, options = {}) => tokenPost(server, refreshParams(publicClient, token, extra), options);

for (const backend of backends) {
  test(`[${backend.name}] refresh rotates, keeps a 60 s envelope, and a lost response is recovered identically, also after a restart`, { timeout: 180000 }, async t => {
    let server = await remoteServer(t, backend);
    const docs = documents(t, server);
    const connection = await connected(server, docs);
    const { tokens } = connection;

    // agent-registration §14.2: an oauth_ token is refused outside its own endpoints, and trying revokes nothing.
    const onRest = await api(server.baseUrl, '/api/agent/status', { token: tokens.access_token });
    assert.deepEqual([onRest.status, onRest.payload?.code], [401, 'AUTHENTICATION_REQUIRED'], 'oauth-token-refused-on-rest');
    const onInbox = await api(server.baseUrl, `/api/inboxes/${connection.registration.agentInboxId}/messages`, { token: tokens.access_token });
    assert.deepEqual([onInbox.status, onInbox.payload?.code], [401, 'AUTHENTICATION_REQUIRED']);
    const onAgentToken = await api(server.baseUrl, '/api/agent-token', { body: { agentRefreshToken: tokens.refresh_token, rotationId: 'rotation-id-for-test' } });
    assert.deepEqual([onAgentToken.status, onAgentToken.payload?.code], [401, 'REFRESH_TOKEN_INVALID']);
    assert.equal((await docs.get(refreshParts(tokens.refresh_token))).usedAt, null, 'the A1 refresh route consumed nothing');
    assert.equal((await docs.get(connection.familyPath)).revokedAt, null, 'and revoked nothing');

    // Rows 7 and 8 refuse before anything is consumed: the token is still current afterwards.
    assertOAuthError(await refresh(server, connection, tokens.refresh_token, { scope: 'envoi.agent' }), 'invalid_scope');
    assertOAuthError(await refresh(server, connection, tokens.refresh_token, { resource: `${server.origin}/other` }), 'invalid_target');
    assert.equal((await docs.get(refreshParts(tokens.refresh_token))).usedAt, null, 'a refused refresh consumed nothing');

    const first = await refresh(server, connection, tokens.refresh_token);
    const successor = assertTokenResponse(first);
    assert.notEqual(successor.access_token, tokens.access_token);
    assert.notEqual(successor.refresh_token, tokens.refresh_token);

    // §14.5: the old record is used; both successors point at the envelope; the envelope validates and holds no raw token.
    const oldRecord = await docs.get(refreshParts(tokens.refresh_token));
    assert.ok(oldRecord.usedAt, 'the old refresh token is marked used');
    const [successorAccess, successorRefresh] = [await docs.get(accessParts(successor.access_token)), await docs.get(refreshParts(successor.refresh_token))];
    assert.deepEqual([successorAccess.tokenType, successorRefresh.tokenType], ['oauth_access', 'oauth_refresh']);
    assert.deepEqual([successorAccess.recoveryTokenHash, successorRefresh.recoveryTokenHash, successorAccess.usedAt, successorRefresh.usedAt], [sha256(tokens.refresh_token), sha256(tokens.refresh_token), null, null]);
    const envelope = await docs.get(recoveryParts(tokens.refresh_token));
    assertStored('storedOAuthRefreshRecovery', envelope);
    assert.deepEqual([envelope.successorAccessHash, envelope.successorRefreshHash, envelope.familyId, envelope.oauthClientId], [sha256(successor.access_token), sha256(successor.refresh_token), connection.registration.credentialFamilyId, publicClient.clientId]);
    assert.equal(Date.parse(envelope.expiresAt) - Date.parse(envelope.createdAt), 60_000, 'the envelope lives 60 s');
    const stored1 = JSON.stringify(envelope);
    assert.ok(![successor.access_token, successor.refresh_token, tokens.refresh_token].some(secret => stored1.includes(secret)), 'the envelope holds no raw token');
    const family = await docs.get(connection.familyPath);
    assert.ok(Date.parse(family.refreshExpiresAt) >= Date.parse(oldRecord.expiresAt), 'refreshExpiresAt is extended by the rotation');

    // The same client repeats the old token within 60 s: the identical response, no new records.
    const again = await refresh(server, connection, tokens.refresh_token);
    assert.equal(again.status, 200, again.text);
    assert.equal(again.text, first.text, 'the identical response');
    assert.deepEqual(await docs.get(recoveryParts(tokens.refresh_token)), envelope, 'a recovery writes nothing');

    // A restart in between: the envelope is in storage, so the identical response still comes back.
    server = await restart(t, server);
    const afterRestart = await refresh(server, connection, tokens.refresh_token);
    assert.equal(afterRestart.text, first.text, 'identical after a restart');

    // Another client with the same token: unknown here, and nothing is revoked.
    const other = await tokenPost(server, { grant_type: 'refresh_token', refresh_token: successor.refresh_token }, { basic: { id: confidentialClient.clientId, secret: clientSecret } });
    assertOAuthError(other, 'invalid_grant');
    assert.equal((await docs.get(connection.familyPath)).revokedAt, null, 'another client revokes nothing');
    assertOAuthError(await tokenPost(server, refreshParams(confidentialClient, successor.refresh_token)), 'invalid_client');
    assertOAuthError(await refresh(server, connection, 'envoi_agent_refresh_unknownunknownunknownunknownunknownunknown'), 'invalid_grant');
    assertOAuthError(await refresh(server, connection, connection.who.agentRefreshToken), 'invalid_grant');
    assert.equal((await docs.get(connection.familyPath)).revokedAt, null);

    // The successor refresh token's first use is the next rotation: it retires the first envelope, so the first token is now
    // replay. Scope may be sent, in any order; it must equal the current scopes.
    const second = assertTokenResponse(await refresh(server, connection, successor.refresh_token, { scope: 'envoi.send envoi.agent', resource: server.resource }));
    assert.equal(await docs.get(recoveryParts(tokens.refresh_token)), null, 'the first envelope is deleted by the successor\'s first use');
    assert.deepEqual(await docs.get(accessParts(successor.access_token)).then(record => record.recoveryTokenHash), null, 'recoveryTokenHash is cleared on the sibling');
    assert.ok(await docs.get(recoveryParts(successor.refresh_token)), 'the second rotation has its own envelope');
    const replay = await refresh(server, connection, tokens.refresh_token);
    assertOAuthError(replay, 'invalid_grant');
    const revokedFamily = await docs.get(connection.familyPath);
    assert.equal(revokedFamily.revokedReason, 'refresh_replay');
    assert.equal(await docs.get(recoveryParts(successor.refresh_token)), null, 'revoking the family deletes its envelopes');
    const installation = await installationView(server, connection.who, connection.registration);
    assert.deepEqual([installation.status, installation.endedReason], ['ended', 'refresh_replay']);
    const agent = await docs.get(['inboxes', connection.registration.agentInboxId, 'agents', `${connection.registration.agentId}.json`]);
    assert.deepEqual([agent.status, agent.onboardingStatus], ['active', 'approved'], 'the identity is not frozen');
    // Every token of the family is refused now, including the newest.
    assertOAuthError(await refresh(server, connection, second.refresh_token), 'invalid_grant');
    const events = await api(server.baseUrl, `/api/inboxes/${connection.registration.agentInboxId}/events/delta?limit=200`, { session: connection.who.session });
    assert.ok(events.payload.events.some(event => event.type === 'agent.refresh_replay_detected'), 'the replay is audited');
    assert.ok(events.payload.events.some(event => event.type === 'agent.refresh_recovered'), 'a recovery is audited');
    const logs = server.stdout + server.stderr;
    assert.ok(![tokens.refresh_token, successor.refresh_token, second.refresh_token].some(secret => logs.includes(secret)), 'no token in the logs');
  });

  test(`[${backend.name}] a replay after the 60 s window, or after a successor was used, revokes the family`, { timeout: 180000 }, async t => {
    const server = await remoteServer(t, backend);
    const docs = documents(t, server);

    // Time-controlled: the envelope's expiry moved into the past.
    const lapsed = await connected(server, docs);
    const rotated = assertTokenResponse(await refresh(server, lapsed, lapsed.tokens.refresh_token));
    await edit(docs, recoveryParts(lapsed.tokens.refresh_token), value => { value.expiresAt = PAST; });
    assertOAuthError(await refresh(server, lapsed, lapsed.tokens.refresh_token), 'invalid_grant');
    assert.equal((await docs.get(lapsed.familyPath)).revokedReason, 'refresh_replay');
    assertOAuthError(await refresh(server, lapsed, rotated.refresh_token), 'invalid_grant');

    // A successor access token that was used (here: its first-use write, which /mcp makes) makes the old token replay.
    const used = await connected(server, docs);
    const next = assertTokenResponse(await refresh(server, used, used.tokens.refresh_token));
    await edit(docs, accessParts(next.access_token), value => { value.usedAt = new Date().toISOString(); });
    assertOAuthError(await refresh(server, used, used.tokens.refresh_token), 'invalid_grant');
    assert.equal((await docs.get(used.familyPath)).revokedReason, 'refresh_replay');

    // The recovery envelope is bound to the client and the family: a different client's request never decrypts it.
    const bound = await connected(server, docs);
    const secondTokens = assertTokenResponse(await refresh(server, bound, bound.tokens.refresh_token));
    assertOAuthError(await tokenPost(server, { grant_type: 'refresh_token', refresh_token: bound.tokens.refresh_token }, { basic: { id: confidentialClient.clientId, secret: clientSecret } }), 'invalid_grant');
    assert.equal((await docs.get(bound.familyPath)).revokedAt, null, 'a different client\'s attempt revokes nothing');
    assert.equal(assertTokenResponse(await refresh(server, bound, bound.tokens.refresh_token)).refresh_token, secondTokens.refresh_token, 'the real client still recovers');
  });

  test(`[${backend.name}] concurrent refreshes of one token rotate once and every caller gets the identical response`, { timeout: 180000 }, async t => {
    const server = await remoteServer(t, backend);
    const docs = documents(t, server);
    const connection = await connected(server, docs);
    const results = await Promise.all(Array.from({ length: 6 }, () => refresh(server, connection, connection.tokens.refresh_token)));
    for (const res of results) assert.equal(res.status, 200, res.text);
    assert.equal(new Set(results.map(res => res.text)).size, 1, 'one successor pair for every caller');
    const familyId = connection.registration.credentialFamilyId;
    const accessRecords = (await docs.list(['auth', 'agent-credentials'])).filter(record => record.familyId === familyId);
    const refreshRecords = (await docs.list(['auth', 'agent-refresh-credentials'])).filter(record => record.familyId === familyId);
    assert.deepEqual([accessRecords.length, refreshRecords.length], [2, 2], 'the original pair and one successor pair');
    assert.equal((await docs.get(connection.familyPath)).revokedAt, null);
  });

  test(`[${backend.name}] a paused agent refreshes; a revoked, expired or removed one cannot`, { timeout: 180000 }, async t => {
    const server = await remoteServer(t, backend);
    const docs = documents(t, server);

    const paused = await connected(server, docs);
    const pause = await api(server.baseUrl, agentUrl(paused.registration, 'pause'), { session: paused.who.session, body: {} });
    assert.equal(pause.status, 200, pause.text);
    const afterPause = assertTokenResponse(await refresh(server, paused, paused.tokens.refresh_token));
    assert.ok(afterPause.refresh_token, 'token-refresh-paused: refresh succeeds while the agent is paused');
    assert.equal((await docs.get(['inboxes', paused.registration.agentInboxId, 'agents', `${paused.registration.agentId}.json`])).status, 'paused');

    const revoked = await connected(server, docs);
    const ownerRevoke = await api(server.baseUrl, `${agentUrl(revoked.registration, 'installations')}/${revoked.registration.installationId}/revoke`, { session: revoked.who.session, body: {} });
    assert.equal(ownerRevoke.status, 200, ownerRevoke.text);
    assertOAuthError(await refresh(server, revoked, revoked.tokens.refresh_token), 'invalid_grant');
    assert.equal((await docs.get(revoked.familyPath)).revokedReason, 'revoked');

    const expired = await connected(server, docs);
    await edit(docs, expired.familyPath, value => { value.refreshExpiresAt = PAST; });
    assertOAuthError(await refresh(server, expired, expired.tokens.refresh_token), 'invalid_grant');

    const frozen = await connected(server, docs);
    const revokeAgent = await api(server.baseUrl, agentUrl(frozen.registration, 'credentials/revoke'), { session: frozen.who.session, body: {} });
    assert.equal(revokeAgent.status, 200, revokeAgent.text);
    assertOAuthError(await refresh(server, frozen, frozen.tokens.refresh_token), 'invalid_grant');
  });

  // M4 (review 6349153739): "a secret sent by a public client is invalid_client" (§6), also in the body, on every endpoint
  // that authenticates the client; the refusal creates no grant, rotates nothing and revokes nothing.
  test(`[${backend.name}] a public client that sends client_secret in the body is invalid_client at exchange, refresh and revocation`, { timeout: 180000 }, async t => {
    const server = await remoteServer(t, backend);
    const docs = documents(t, server);
    for (const secret of ['not-a-real-secret', '']) {
      // Code exchange: refused at client authentication, so the code is still unused and the approval still waits.
      const who = await newOwner(server);
      const grant = await connect(server, who);
      const refused = await exchange(server, grant, { client_secret: secret });
      assertOAuthError(refused, 'invalid_client');
      assert.equal(refused.headers.get('www-authenticate'), null, 'no Basic challenge: the client did not use Basic');
      const { registration: waiting } = await stored(docs, grant.registrationId);
      assert.deepEqual([waiting.status, waiting.oauth.codeUsedAt], ['approved', null], 'no grant was created');
      const tokens = assertTokenResponse(await exchange(server, grant));
      const { registration } = await stored(docs, grant.registrationId);
      const familyPath = familyParts(registration.agentInboxId, registration.agentId, registration.credentialFamilyId);
      // Refresh: refused, and the refresh token is still unused.
      assertOAuthError(await tokenPost(server, refreshParams(publicClient, tokens.refresh_token, { client_secret: secret })), 'invalid_client');
      assert.equal((await docs.get(refreshParts(tokens.refresh_token))).usedAt, null, 'nothing rotated');
      // Revocation: refused, and the family is still live.
      assertOAuthError(await revokePost(server, { token: tokens.refresh_token, client_id: publicClient.clientId, client_secret: secret }), 'invalid_client');
      assert.equal((await docs.get(familyPath)).revokedAt, null, 'nothing revoked');
      // The same requests without the secret still work, so the refusals changed nothing.
      assertTokenResponse(await tokenPost(server, refreshParams(publicClient, tokens.refresh_token)));
    }
  });

  // M5 (review 6349153739): §7 "An unknown, expired or already-revoked token: 200, and nothing changes" applies to the token's
  // own expiry, not only its family's. A valid token of the same family still revokes it.
  test(`[${backend.name}] revocation with an expired token is an empty 200 that leaves its live family alone`, { timeout: 180000 }, async t => {
    const server = await remoteServer(t, backend);
    const docs = documents(t, server);
    const connection = await connected(server, docs);
    await edit(docs, accessParts(connection.tokens.access_token), record => { record.expiresAt = PAST; });
    const expiredAccess = await revokePost(server, { token: connection.tokens.access_token, token_type_hint: 'access_token', client_id: publicClient.clientId });
    assert.deepEqual([expiredAccess.status, expiredAccess.text], [200, '']);
    assert.equal((await docs.get(connection.familyPath)).revokedAt, null, 'an expired access token revoked nothing');
    assert.equal((await installationView(server, connection.who, connection.registration)).status, 'active');
    // An expired refresh token likewise; then the family, still live, refreshes normally.
    const other = await connected(server, docs);
    const liveRefresh = other.tokens.refresh_token;
    await edit(docs, refreshParts(liveRefresh), record => { record.expiresAt = PAST; });
    assert.equal((await revokePost(server, { token: liveRefresh, client_id: publicClient.clientId })).status, 200);
    assert.equal((await docs.get(other.familyPath)).revokedAt, null, 'an expired refresh token revoked nothing');
    assertTokenResponse(await refresh(server, connection, connection.tokens.refresh_token));
    // Positive control: a live access token of a live family revokes it.
    const control = await connected(server, docs);
    assert.equal((await revokePost(server, { token: control.tokens.access_token, token_type_hint: 'access_token', client_id: publicClient.clientId })).status, 200);
    assert.equal((await docs.get(control.familyPath)).revokedReason, 'revoked');
  });

  test(`[${backend.name}] revocation: the client ends its own installation, and nothing else changes`, { timeout: 180000 }, async t => {
    const server = await remoteServer(t, backend);
    const docs = documents(t, server);

    // A refresh token revokes the family: the installation ends as revoked, the identity stays.
    const byRefresh = await connected(server, docs);
    const revoke = await revokePost(server, { token: byRefresh.tokens.refresh_token, token_type_hint: 'refresh_token', client_id: publicClient.clientId });
    assert.equal(revoke.status, 200, revoke.text);
    assert.equal(revoke.text, '', 'the body is empty');
    assert.equal(revoke.headers.get('cache-control'), 'no-store');
    const installation = await installationView(server, byRefresh.who, byRefresh.registration);
    assert.deepEqual([installation.status, installation.endedReason], ['ended', 'revoked']);
    const agent = await docs.get(['inboxes', byRefresh.registration.agentInboxId, 'agents', `${byRefresh.registration.agentId}.json`]);
    assert.deepEqual([agent.status, agent.onboardingStatus], ['active', 'approved']);
    assertOAuthError(await refresh(server, byRefresh, byRefresh.tokens.refresh_token), 'invalid_grant');
    const events = await api(server.baseUrl, `/api/inboxes/${byRefresh.registration.agentInboxId}/events/delta?limit=200`, { session: byRefresh.who.session });
    const revoked = events.payload.events.find(event => event.type === 'agent.installation_revoked');
    assert.equal(revoked?.actor, 'client');
    // Revoking it again changes nothing.
    const endedAt = installation.endedAt;
    assert.equal((await revokePost(server, { token: byRefresh.tokens.refresh_token, client_id: publicClient.clientId })).status, 200);
    assert.equal((await installationView(server, byRefresh.who, byRefresh.registration)).endedAt, endedAt);

    // An access token revokes the family too.
    const byAccess = await connected(server, docs);
    assert.equal((await revokePost(server, { token: byAccess.tokens.access_token, token_type_hint: 'access_token', client_id: publicClient.clientId })).status, 200);
    assert.equal((await docs.get(byAccess.familyPath)).revokedReason, 'revoked');

    // An unknown token is a 200 that changes nothing (RFC 7009 §2.2); so is an expired family.
    assert.equal((await revokePost(server, { token: 'envoi_agent_refresh_unknownunknownunknownunknownunknownunknown', client_id: publicClient.clientId })).status, 200);
    assert.equal((await revokePost(server, { token: 'not-even-a-token', client_id: publicClient.clientId })).status, 200);

    // Another client's token, and a token of a family with no client (local_helper), are unauthorized_client and untouched.
    const mine = await connected(server, docs);
    assertOAuthError(await revokePost(server, { token: mine.tokens.refresh_token }, { basic: { id: confidentialClient.clientId, secret: clientSecret } }), 'unauthorized_client');
    assert.equal((await docs.get(mine.familyPath)).revokedAt, null, 'another client revoked nothing');
    assertOAuthError(await revokePost(server, { token: mine.who.agentApiToken, token_type_hint: 'refresh_token', client_id: publicClient.clientId }), 'unauthorized_client');
    assertOAuthError(await revokePost(server, { token: mine.who.agentRefreshToken, client_id: publicClient.clientId }), 'unauthorized_client');
    const helper = await api(server.baseUrl, '/api/agent/status', { token: mine.who.agentApiToken });
    assert.equal(helper.status, 200, 'the local helper credential still works');
    // Client authentication applies: no client, no revocation.
    assertOAuthError(await revokePost(server, { token: mine.tokens.refresh_token }), 'invalid_client');
    assertOAuthError(await revokePost(server, { client_id: publicClient.clientId }), 'invalid_request');
    assert.equal((await docs.get(mine.familyPath)).revokedAt, null);
  });

  test(`[${backend.name}] stored OAuth records are removed with the family's envelopes and reaped when they lapse`, { timeout: 120000 }, async t => {
    const server = await remoteServer(t, backend);
    const docs = documents(t, server);
    const connection = await connected(server, docs);
    assertTokenResponse(await refresh(server, connection, connection.tokens.refresh_token));
    assert.ok(await docs.get(recoveryParts(connection.tokens.refresh_token)));
    // The owner's revoke deletes the family's envelopes, best effort.
    const ownerRevoke = await api(server.baseUrl, `${agentUrl(connection.registration, 'installations')}/${connection.registration.installationId}/revoke`, { session: connection.who.session, body: {} });
    assert.equal(ownerRevoke.status, 200, ownerRevoke.text);
    assert.equal(await docs.get(recoveryParts(connection.tokens.refresh_token)), null);
    const ip = freshIp();
    assertOAuthError(await tokenPost(server, refreshParams(publicClient, connection.tokens.refresh_token), { ip }), 'invalid_grant');

    // The reaper deletes an envelope after expiresAt and keeps one that is still inside its 60 s.
    const store = await openStore(t, server);
    const live = await connected(server, docs);
    assertTokenResponse(await refresh(server, live, live.tokens.refresh_token));
    const lapsed = await connected(server, docs);
    assertTokenResponse(await refresh(server, lapsed, lapsed.tokens.refresh_token));
    await edit(docs, recoveryParts(lapsed.tokens.refresh_token), value => { value.expiresAt = PAST; });
    // PostgreSQL is shared by the suite and can contain other expired envelopes.
    assert.ok(await reapAgentRotationRecovery(store) >= 1);
    assert.equal(await docs.get(recoveryParts(lapsed.tokens.refresh_token)), null);
    assert.ok(await docs.get(recoveryParts(live.tokens.refresh_token)), 'a live envelope is kept');
  });
}
