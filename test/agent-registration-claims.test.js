// agent-registration v1 §1–§5 (task A-4.2) end to end through the HTTP API: registration,
// polling, the bootstrap token's lack of rights, and the human claim (lookup, approve, reject,
// list, withdraw) with its holds, slots and limits. FileStore always, PostgreSQL when
// DATABASE_URL is set (CI test:postgres).
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentStatus, api, launch, owner } from './a3-harness.js';
import {
  approveBody, approveRequest, assertCode, assertContract, backends, claims, documents, freshIp, launchRegistration, lookup, newAgentTarget,
  PAST, poll, register, registered, registrationParts, rejectRequest, sameNetwork, withdrawRequest
} from './agent-registration-harness.js';

const suffixes = { FileStore: '71', PostgreSQL: '72' };
const installationsRoute = who => `/api/inboxes/${who.inbox.id}/agents/${who.agent.id}/installations`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const code = created => created.claim.verificationCode;
const unique = () => `a${Math.random().toString(36).slice(2, 10)}`;

test('[FileStore] with the registration flag off every registration and claim route is disabled', { timeout: 60000 }, async t => {
  const server = await launch({ ENVOI_INSTALLATIONS_V2: 'true' });
  t.after(() => server.stop());
  assertCode(await register(server.baseUrl), 'FEATURE_DISABLED');
  assertCode(await api(server.baseUrl, '/api/agent-registrations/registration_example', { token: 'envoi_reg_PLACEHOLDER' }), 'FEATURE_DISABLED');
  const who = await owner(server.baseUrl, '7001');
  assertCode(await lookup(server.baseUrl, who, 'F7KQ-PM4D'), 'FEATURE_DISABLED');
  assertCode(await api(server.baseUrl, '/api/agent-claims', { session: who.session }), 'FEATURE_DISABLED');
  assertCode(await withdrawRequest(server.baseUrl, who, 'registration_example'), 'FEATURE_DISABLED');
});

test('[FileStore] staging exception permits a named owner to approve four additional agents', { timeout: 90000 }, async t => {
  const backend = backends.find(item => item.name === 'FileStore');
  const initial = await launchRegistration(backend, { ENVOI_DEPLOYMENT_ENVIRONMENT: 'staging' });
  const who = await owner(initial.baseUrl, '7099');
  await initial.stop(true);
  const server = await launchRegistration(backend, {
    ENVOI_DEPLOYMENT_ENVIRONMENT: 'staging',
    ENVOI_STAGING_UNCAPPED_AGENT_HUMAN_IDS: who.human.id
  }, initial.dataDir);
  t.after(() => server.stop());
  assert.equal((await api(server.baseUrl, '/api/auth/me', { session: who.session })).status, 200);
  for (let index = 0; index < 4; index += 1) {
    const created = await registered(server.baseUrl);
    const approved = await approveRequest(server.baseUrl, who, created.registrationId,
      approveBody(code(created), newAgentTarget(who, unique())));
    assert.equal(approved.status, 200, approved.text);
  }
});

for (const backend of backends) {
  const s = suffixes[backend.name];

  test(`[${backend.name}] registration: shape, routes, validation, limits and no rights`, { timeout: 90000 }, async t => {
    const server = await launchRegistration(backend);
    t.after(() => server.stop());
    const { baseUrl } = server;

    const routes = await api(baseUrl, '/api/onboarding/routes');
    assert.deepEqual(routes.payload.routes.filter(item => item.available).map(item => item.connectionRoute), ['local_helper']);

    const created = await register(baseUrl, { requestedLocalPart: unique() });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.headers.get('cache-control'), 'no-store');
    assertContract('registrationCreated', created.payload);
    assert.match(created.payload.claim.url, /\/claim$/);
    assert.ok(!created.payload.claim.url.includes(created.payload.claim.verificationCode.slice(0, 4)), 'the claim url never contains the code');
    assert.equal(created.payload.claim.expiresAt, created.payload.expiresAt);
    assert.equal(new Date(created.payload.expiresAt) - Date.now() <= 600_000, true);

    assertCode(await register(baseUrl, { connectionRoute: 'remote_mcp_oauth' }), 'ROUTE_NOT_AVAILABLE');
    assertCode(await register(baseUrl, { connectionRoute: 'authenticated_rest' }), 'ROUTE_NOT_AVAILABLE');
    assertCode(await register(baseUrl, { unexpected: true }), 'REGISTRATION_INVALID');
    assertCode(await register(baseUrl, { requestedName: 'Agent\u202Egnp' }), 'REGISTRATION_INVALID');
    assertCode(await register(baseUrl, { requestedName: 'envoi_reg_leak' }), 'REGISTRATION_INVALID');
    assertCode(await register(baseUrl, { requestedLocalPart: 'admin' }), 'REGISTRATION_INVALID');
    assertCode(await register(baseUrl, { requestedPermissions: [] }), 'REGISTRATION_INVALID');
    const garbage = await fetch(`${baseUrl}/api/agent-registrations`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp() }, body: '{not json' });
    assertCode({ status: garbage.status, headers: garbage.headers, payload: await garbage.json(), text: '' }, 'REGISTRATION_INVALID');
    assertCode(await register(baseUrl, { requestedName: 'x', runtime: { type: 'hermes', version: 'v'.repeat(5000) } }), 'RATE_LIMITED', { reason: 'registration_limit' });

    // §2: 10 per source per hour, durable; refusals record nothing.
    const ip = freshIp();
    for (let index = 0; index < 10; index += 1) assert.equal((await register(baseUrl, {}, { ip })).status, 201);
    const limited = assertCode(await register(baseUrl, {}, { ip }), 'RATE_LIMITED', { reason: 'registration_limit' });
    assert.ok(limited.retryAfterSeconds > 3000 && limited.retryAfterSeconds <= 3600, String(limited.retryAfterSeconds));
    // A different /64 in the same /48 is a different source.
    assert.equal((await register(baseUrl, {}, { ip: sameNetwork(ip) })).status, 201);

    // A bootstrap token is an unknown bearer everywhere but status and activation.
    const token = created.payload.bootstrapToken;
    const who = await owner(baseUrl, `${s}01`);
    assertCode(await agentStatus(baseUrl, token), 'AUTHENTICATION_REQUIRED');
    assertCode(await api(baseUrl, '/mcp', { token, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }), 'AUTHENTICATION_REQUIRED');
    assertCode(await api(baseUrl, '/api/agent/work/claim', { token, body: {} }), 'AUTHENTICATION_REQUIRED');
    assertCode(await api(baseUrl, `/api/inboxes/${who.inbox.id}/messages`, { token, key: 'reg-send', body: { recipientEmail: who.agent.address, type: 'request', text: 'no' } }), 'AUTHENTICATION_REQUIRED');
  });

  test(`[${backend.name}] polling: pending, too fast, wrong token, expired`, { timeout: 60000 }, async t => {
    const server = await launchRegistration(backend);
    t.after(() => server.stop());
    const { baseUrl } = server;
    const created = await registered(baseUrl);
    const pending = await poll(baseUrl, created);
    assert.equal(pending.status, 200, pending.text);
    assert.equal(pending.headers.get('cache-control'), 'no-store');
    assertContract('registrationStatus', pending.payload);
    assert.deepEqual(pending.payload, { registrationId: created.registrationId, status: 'pending_claim', expiresAt: created.expiresAt, pollAfterSeconds: 5 });
    assertCode(await poll(baseUrl, created), 'RATE_LIMITED', { reason: 'poll_interval', retryAfterSeconds: 5 });
    const other = await registered(baseUrl);
    assertCode(await poll(baseUrl, created, other.bootstrapToken), 'REGISTRATION_TOKEN_INVALID');
    assertCode(await poll(baseUrl, created, 'envoi_reg_' + 'A'.repeat(43)), 'REGISTRATION_TOKEN_INVALID');
    assertCode(await api(baseUrl, '/api/agent-registrations/registration_unknown', { token: created.bootstrapToken }), 'REGISTRATION_TOKEN_INVALID');

    // §4: status is derived from time; no job has to run.
    await documents(t, backend, server).edit(registrationParts(created.registrationId), value => ({ ...value, expiresAt: PAST }));
    await sleep(4100);
    const expired = await poll(baseUrl, created);
    assert.deepEqual(expired.payload, { registrationId: created.registrationId, status: 'expired' });
  });

  test(`[${backend.name}] claim: lookup, approve a new agent, holds, replays and decisions`, { timeout: 120000 }, async t => {
    const server = await launchRegistration(backend);
    t.after(() => server.stop());
    const { baseUrl } = server;
    const [alice, bob] = await Promise.all([owner(baseUrl, `${s}11`), owner(baseUrl, `${s}12`)]);
    const localPart = unique();
    const created = await registered(baseUrl, { requestedLocalPart: localPart, requestedPermissions: ['send_agent_messages', 'receive_agent_messages'] });

    // Typing is case-insensitive and ignores spaces and hyphens.
    const typed = code(created).toLowerCase().replace('-', ' ');
    const looked = await lookup(baseUrl, alice, typed);
    assert.equal(looked.status, 200, looked.text);
    assertContract('claimLookup', looked.payload);
    assert.equal(looked.payload.verificationCode, code(created));
    assert.equal(looked.payload.registrationId, created.registrationId);
    assert.equal(looked.payload.requestedLocalPart, localPart);
    assert.equal(new Date(looked.payload.expiresAt) - new Date(looked.payload.createdAt), 600_000);
    assertCode(await lookup(baseUrl, alice, 'ZZZZ-ZZZZ'), 'CLAIM_CODE_INVALID');
    assertCode(await lookup(baseUrl, alice, 'not a code at all, far too long to be one'), 'CLAIM_CODE_INVALID');

    const target = newAgentTarget(alice, localPart);
    // Code before body, body before authorization.
    assertCode(await approveRequest(baseUrl, alice, created.registrationId, approveBody('ZZZZ-ZZZZ', target)), 'CLAIM_CODE_INVALID');
    assertCode(await approveRequest(baseUrl, alice, created.registrationId, approveBody(code(created), target, [])), 'CLAIM_INVALID');
    assertCode(await approveRequest(baseUrl, bob, created.registrationId, approveBody(code(created), target)), 'CLAIM_FORBIDDEN');
    assertCode(await approveRequest(baseUrl, alice, created.registrationId, approveBody(code(created), { ...target, workspaceInboxId: 'inbox_unknown' })), 'CLAIM_FORBIDDEN');

    const body = approveBody(code(created), target, ['send_agent_messages', 'receive_agent_messages', 'execute_cases']);
    const approved = await approveRequest(baseUrl, alice, created.registrationId, body);
    assert.equal(approved.status, 200, approved.text);
    assert.equal(approved.headers.get('cache-control'), 'no-store');
    assertContract('claimApproved', approved.payload);
    assert.deepEqual(approved.payload.effectivePermissions, ['send_agent_messages', 'receive_agent_messages'], 'granted but not requested is dropped');
    assert.equal(approved.payload.agent.address, `${localPart}@envoi.mail`);
    assert.equal(approved.payload.agent.id, undefined);
    assert.ok(!JSON.stringify(approved.payload).includes('envoi_agent_'), 'no credential reaches the browser');

    // §5.3 replays and decided registrations.
    const replay = await approveRequest(baseUrl, alice, created.registrationId, body);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.payload, approved.payload);
    assertCode(await approveRequest(baseUrl, alice, created.registrationId, { ...body, grantedPermissions: ['receive_agent_messages'] }), 'CLAIM_ALREADY_DECIDED');
    assertCode(await rejectRequest(baseUrl, alice, created.registrationId, code(created)), 'CLAIM_ALREADY_DECIDED');
    assertCode(await approveRequest(baseUrl, bob, created.registrationId, approveBody(code(created), newAgentTarget(bob, unique()))), 'CLAIM_CODE_INVALID');
    // Lookup only finds pending registrations.
    assertCode(await lookup(baseUrl, alice, code(created)), 'CLAIM_CODE_INVALID');

    // §4: the approved poll carries what the human beside the host confirms.
    await sleep(4100);
    const status = await poll(baseUrl, created);
    assertContract('registrationStatus', status.payload);
    assert.equal(status.payload.status, 'approved');
    assert.equal(status.payload.target, 'new_agent');
    assert.match(status.payload.approverEmailHint, /^[^@\s*]\*\*\*@/);
    assert.equal(status.payload.activationExpiresAt, approved.payload.activationExpiresAt);

    // §9: a live hold counts as taken on every path.
    const rival = await registered(baseUrl, { requestedLocalPart: localPart });
    assertCode(await approveRequest(baseUrl, bob, rival.registrationId, approveBody(code(rival), newAgentTarget(bob, localPart))), 'ADDRESS_TAKEN');
    const availability = await api(baseUrl, `/api/inboxes/${bob.inbox.parentInboxId}/agent-address-availability?localPart=${localPart}`, { session: bob.session });
    assert.equal(availability.payload.available, false, availability.text);
    const enrollment = await api(baseUrl, `/api/inboxes/${bob.inbox.parentInboxId}/agent-enrollment-tokens`, { session: bob.session, body: { agentProfile: { name: 'Rival', localPart } } });
    assert.equal(enrollment.status, 409, enrollment.text);

    // §5.4: the owner list, newest first; then withdraw releases the hold.
    const listed = await claims(baseUrl, alice);
    assert.equal(listed.status, 200, listed.text);
    assertContract('ownerClaimList', listed.payload);
    const entry = listed.payload.claims.find(item => item.registrationId === created.registrationId);
    assert.deepEqual({ status: entry.status, approvedByMe: entry.approvedByMe, installationId: entry.installationId }, { status: 'approved', approvedByMe: true, installationId: null });
    assert.equal((await claims(baseUrl, bob)).payload.claims.some(item => item.registrationId === created.registrationId), false, 'not manageable, not listed');
    assertCode(await withdrawRequest(baseUrl, bob, created.registrationId), 'CLAIM_NOT_FOUND');
    const withdrawn = await withdrawRequest(baseUrl, alice, created.registrationId);
    assert.equal(withdrawn.status, 200, withdrawn.text);
    assertContract('claimWithdrawn', withdrawn.payload);
    assert.deepEqual((await withdrawRequest(baseUrl, alice, created.registrationId)).payload, withdrawn.payload, 'withdraw replays');
    assert.equal((await api(baseUrl, `/api/inboxes/${bob.inbox.parentInboxId}/agent-address-availability?localPart=${localPart}`, { session: bob.session })).payload.available, true);
    await sleep(4100);
    assert.deepEqual((await poll(baseUrl, created)).payload, { registrationId: created.registrationId, status: 'withdrawn' });

    // Reject, and its replay.
    const rejectable = await registered(baseUrl);
    const rejected = await rejectRequest(baseUrl, bob, rejectable.registrationId, code(rejectable));
    assert.equal(rejected.status, 200, rejected.text);
    assertContract('claimRejected', rejected.payload);
    assert.deepEqual((await rejectRequest(baseUrl, bob, rejectable.registrationId, code(rejectable))).payload, rejected.payload);
    assertCode(await approveRequest(baseUrl, bob, rejectable.registrationId, approveBody(code(rejectable), newAgentTarget(bob, unique()))), 'CLAIM_ALREADY_DECIDED');
    assert.deepEqual((await poll(baseUrl, rejectable)).payload, { registrationId: rejectable.registrationId, status: 'rejected' });
  });

  test(`[${backend.name}] claim: slots, waiting approvals and existing agents`, { timeout: 120000 }, async t => {
    const server = await launchRegistration(backend);
    t.after(() => server.stop());
    const { baseUrl } = server;
    const carol = await owner(baseUrl, `${s}21`);
    const docs = documents(t, backend, server);
    const [legacy] = (await api(baseUrl, installationsRoute(carol), { session: carol.session })).payload.installations;

    // Carol's own agent holds one slot; one new-agent approval takes the second.
    const first = await registered(baseUrl);
    assert.equal((await approveRequest(baseUrl, carol, first.registrationId, approveBody(code(first), newAgentTarget(carol, unique())))).status, 200);
    const second = await registered(baseUrl);
    assertCode(await approveRequest(baseUrl, carol, second.registrationId, approveBody(code(second), newAgentTarget(carol, unique()))), 'ACTIVE_AGENT_LIMIT');

    // existing_agent: the replaced installation must be the newest active one.
    const existingTarget = replacesInstallationId => ({ kind: 'existing_agent', agentId: carol.agent.id, replacesInstallationId });
    assertCode(await approveRequest(baseUrl, carol, second.registrationId, approveBody(code(second), existingTarget(null))), 'CLAIM_STALE');
    const attach = await approveRequest(baseUrl, carol, second.registrationId, approveBody(code(second), existingTarget(legacy.id), ['send_agent_messages']));
    assert.equal(attach.status, 200, attach.text);
    assertContract('claimApproved', attach.payload);
    assert.equal(attach.payload.agent.id, carol.agent.id);
    assert.deepEqual(attach.payload.effectivePermissions, ['send_agent_messages', 'receive_agent_messages']);

    // Three approvals may wait for activation at once.
    const third = await registered(baseUrl);
    assert.equal((await approveRequest(baseUrl, carol, third.registrationId, approveBody(code(third), existingTarget(legacy.id)))).status, 200);
    const fourth = await registered(baseUrl);
    assertCode(await approveRequest(baseUrl, carol, fourth.registrationId, approveBody(code(fourth), existingTarget(legacy.id))), 'PENDING_ACTIVATION_LIMIT');

    // An approval past its activation window frees its slot and its place among the three
    // waiting (derived from time; no job runs).
    await docs.edit(registrationParts(first.registrationId), value => ({ ...value, activationExpiresAt: PAST }));
    const fifth = await registered(baseUrl);
    assert.equal((await approveRequest(baseUrl, carol, fifth.registrationId, approveBody(code(fifth), newAgentTarget(carol, unique())))).status, 200);
    const sixth = await registered(baseUrl);
    assertCode(await approveRequest(baseUrl, carol, sixth.registrationId, approveBody(code(sixth), newAgentTarget(carol, unique()))), 'ACTIVE_AGENT_LIMIT');

    // reconnect-after-installation-revoke: after an installation-only revoke the agent stays
    // attachable, with replacesInstallationId null.
    const dave = await owner(baseUrl, `${s}22`);
    const [daveInstallation] = (await api(baseUrl, installationsRoute(dave), { session: dave.session })).payload.installations;
    assert.equal((await api(baseUrl, `${installationsRoute(dave)}/${daveInstallation.id}/revoke`, { session: dave.session, body: {} })).status, 200);
    const reattach = await registered(baseUrl);
    const reattached = await approveRequest(baseUrl, dave, reattach.registrationId, approveBody(code(reattach), { kind: 'existing_agent', agentId: dave.agent.id, replacesInstallationId: null }));
    assert.equal(reattached.status, 200, reattached.text);

    // A frozen agent (agent-wide revoke) is not reconnectable.
    const erin = await owner(baseUrl, `${s}23`);
    assert.equal((await api(baseUrl, `/api/inboxes/${erin.inbox.id}/agents/${erin.agent.id}/credentials/revoke`, { session: erin.session, body: {} })).status, 200);
    const frozen = await registered(baseUrl);
    assertCode(await approveRequest(baseUrl, erin, frozen.registrationId, approveBody(code(frozen), { kind: 'existing_agent', agentId: erin.agent.id, replacesInstallationId: null })), 'AGENT_NOT_RECONNECTABLE');
    // Another human's agent is forbidden, with no existence oracle.
    assertCode(await approveRequest(baseUrl, erin, frozen.registrationId, approveBody(code(frozen), { kind: 'existing_agent', agentId: carol.agent.id, replacesInstallationId: legacy.id })), 'CLAIM_FORBIDDEN');
    assertCode(await approveRequest(baseUrl, erin, frozen.registrationId, approveBody(code(frozen), { kind: 'existing_agent', agentId: 'agent_unknown', replacesInstallationId: null })), 'CLAIM_FORBIDDEN');
  });

  test(`[${backend.name}] concurrent decisions: one wins, the loser gets a counted 404, never a 500`, { timeout: 90000 }, async t => {
    const server = await launchRegistration(backend);
    t.after(() => server.stop());
    const { baseUrl } = server;
    const [hana, ivan] = await Promise.all([owner(baseUrl, `${s}41`), owner(baseUrl, `${s}42`)]);
    for (let round = 0; round < 3; round += 1) {
      const created = await registered(baseUrl);
      const current = (await api(baseUrl, `/api/inboxes/${hana.inbox.id}/agents/${hana.agent.id}/installations`, { session: hana.session })).payload.installations.find(item => item.status === 'active');
      const results = await Promise.all([
        approveRequest(baseUrl, hana, created.registrationId, approveBody(code(created), { kind: 'existing_agent', agentId: hana.agent.id, replacesInstallationId: current?.id ?? null })),
        rejectRequest(baseUrl, ivan, created.registrationId, code(created))
      ]);
      assert.ok(!results.some(result => result.status >= 500), results.map(result => result.text).join('\n'));
      assert.equal(results.filter(result => result.status === 200).length, 1, `exactly one decision wins: ${results.map(result => result.status)}`);
      assertCode(results.find(result => result.status !== 200), 'CLAIM_CODE_INVALID');
      // Free Hana's waiting approvals so the next round is not held by the three-waiting limit.
      for (const claim of (await claims(baseUrl, hana)).payload.claims) if (claim.status === 'approved') assert.equal((await withdrawRequest(baseUrl, hana, claim.registrationId)).status, 200);
    }
  });

  test(`[${backend.name}] a burst of wrong codes is held to five failures; the owner list stays reachable`, { timeout: 90000 }, async t => {
    const server = await launchRegistration(backend);
    t.after(() => server.stop());
    const judy = await owner(server.baseUrl, `${s}43`);
    const burst = await Promise.all(Array.from({ length: 12 }, () => lookup(server.baseUrl, judy, 'ZZZZ-ZZZZ')));
    const counts = burst.reduce((map, res) => ({ ...map, [res.payload?.code]: (map[res.payload?.code] || 0) + 1 }), {});
    assert.equal(counts.CLAIM_CODE_INVALID, 5, JSON.stringify(counts));
    assert.equal(counts.RATE_LIMITED, 7, JSON.stringify(counts));
    assert.equal((await claims(server.baseUrl, judy)).status, 200, 'the §10 undo list is not behind the claim lock');
  });

  test(`[${backend.name}] claim failures lock the human, survive a restart, and spare 5xx`, { timeout: 90000 }, async t => {
    let server = await launchRegistration(backend);
    t.after(() => server.stop());
    const frank = await owner(server.baseUrl, `${s}31`);
    const created = await registered(server.baseUrl);
    for (let index = 0; index < 5; index += 1) assertCode(await lookup(server.baseUrl, frank, 'ZZZZ-ZZZZ'), 'CLAIM_CODE_INVALID');
    const locked = assertCode(await lookup(server.baseUrl, frank, code(created)), 'RATE_LIMITED', { reason: 'claim_attempts' });
    assert.ok(locked.retryAfterSeconds > 800 && locked.retryAfterSeconds <= 900, String(locked.retryAfterSeconds));
    assertCode(await approveRequest(server.baseUrl, frank, created.registrationId, approveBody(code(created), newAgentTarget(frank, unique()))), 'RATE_LIMITED', { reason: 'claim_attempts' });

    // Durable: the lock, the pending registration and its code survive a restart.
    await server.stop(true);
    server = await launchRegistration(backend, {}, backend.name === 'FileStore' ? server.dataDir : null);
    assertCode(await lookup(server.baseUrl, frank, code(created)), 'RATE_LIMITED', { reason: 'claim_attempts' });
    const grace = await owner(server.baseUrl, `${s}32`);
    assert.equal((await lookup(server.baseUrl, grace, code(created))).status, 200, 'another human is not locked out');
  });
}
