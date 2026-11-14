// agent-registration v1 §6 (task A-4.3) end to end: activation for new and existing agents, the
// §6.1 precedence rows, lost-response recovery (also across a restart), replay detection that
// ends one installation without freezing the identity, the tombstone, and the activation-time
// re-checks. FileStore always, PostgreSQL when DATABASE_URL is set (CI test:postgres).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { workosActivationFixture } from './workos-activation-harness.js';
import { agentStatus, api, newRotationId, owner, pauseAgent, refresh } from './a3-harness.js';
import {
  approveBody, approveRequest, assertCode, assertContract, backends, documents, launchRegistration, lookup, newAgentTarget,
  nearReplayCancellationFixture, PAST, poll, registered, registrationParts, rejectRequest, withdrawRequest
} from './agent-registration-harness.js';

const suffixes = { FileStore: '81', PostgreSQL: '82' };
const code = created => created.claim.verificationCode;
const unique = () => `a${Math.random().toString(36).slice(2, 10)}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const activationId = () => `activation_${crypto.randomBytes(6).toString('hex')}`;
const activate = (baseUrl, created, body = {}) => api(baseUrl, '/api/agent-installations/activate', {
  token: body.token ?? created.bootstrapToken,
  body: { registrationId: created.registrationId, activationId: activationId(), deliveryMode: 'envoi_link', ...Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'token')) }
});
// a3-pause-auth: a revoked credential is 401 CREDENTIAL_REVOKED with the family's reason.
function assertRevoked(res, reason) {
  assert.equal(res.status, 401, res.text);
  assert.equal(res.payload?.code, 'CREDENTIAL_REVOKED', res.text);
  assert.equal(res.payload.reason, reason);
}
const installationsRoute = (inboxId, agentId) => `/api/inboxes/${inboxId}/agents/${agentId}/installations`;

async function approvedNew(baseUrl, who, overrides = {}) {
  const localPart = unique();
  const created = await registered(baseUrl, { requestedLocalPart: localPart, ...overrides });
  const approved = await approveRequest(baseUrl, who, created.registrationId, approveBody(code(created), newAgentTarget(who, localPart, 'New agent')));
  assert.equal(approved.status, 200, approved.text);
  return { created, localPart };
}

for (const backend of backends) {
  const s = suffixes[backend.name];

  test(`[${backend.name}] WorkOS activation resolves the durable owner and rechecks membership for same-identity reconnect`, { timeout: 120000 }, async t => {
    const f = await workosActivationFixture(t, backend);
    const { baseUrl } = f.server;
    const { created } = await approvedNew(baseUrl, f.who);
    await f.assertNoTransientIdentityPersisted();
    const before = (await f.calls()).length;
    const activated = await activate(baseUrl, created);
    assert.equal(activated.status, 201, activated.text);
    assert.equal((await f.calls()).length, before + 1, 'activation performs a fresh WorkOS membership lookup');
    await f.assertNoTransientIdentityPersisted();
    const reconnect = await registered(baseUrl);
    assert.equal((await approveRequest(baseUrl, f.who, reconnect.registrationId, approveBody(code(reconnect), {
      kind: 'existing_agent', agentId: activated.payload.agent.id, replacesInstallationId: activated.payload.installation.id
    }))).status, 200);
    const replacement = await activate(baseUrl, reconnect);
    assert.equal(replacement.status, 201, replacement.text);
    assert.equal(replacement.payload.agent.id, activated.payload.agent.id);
    assert.equal(replacement.payload.inboxId, activated.payload.inboxId);
    assert.equal(replacement.payload.agent.address, activated.payload.agent.address);
    assertRevoked(await agentStatus(baseUrl, activated.payload.agentApiToken), 'replaced');
  });

  for (const variant of ['missing-user-id', 'missing-index', 'wrong-index', 'wrong-human-id', 'wrong-provider', 'unverified', 'uninvited', 'local-demoted', 'provider-demoted', 'provider-removed']) {
    test(`[${backend.name}] WorkOS activation denies ${variant} after approval`, { timeout: 120000 }, async t => {
      const f = await workosActivationFixture(t, backend);
      const { baseUrl } = f.server;
      const { created } = await approvedNew(baseUrl, f.who);
      if (variant === 'missing-user-id') await f.docs.edit(f.humanParts, value => ({ ...value, workosUserId: null }));
      if (variant === 'missing-index') await f.docs.remove(f.indexParts);
      if (variant === 'wrong-index') await f.docs.put(f.indexParts, { humanId: 'human_unrelated_fixture' });
      if (variant === 'wrong-human-id') await f.docs.edit(f.humanParts, value => ({ ...value, id: 'human_unrelated_fixture' }));
      if (variant === 'wrong-provider') await f.docs.edit(f.humanParts, value => ({ ...value, authProvider: 'local' }));
      if (variant === 'unverified') await f.docs.edit(f.humanParts, value => ({ ...value, emailVerified: false }));
      if (variant === 'uninvited') await f.docs.edit(f.humanParts, value => ({ ...value, email: 'uninvited@example.test' }));
      if (variant === 'local-demoted') await f.docs.edit(f.membershipParts, value => ({ ...value, role: 'member' }));
      if (variant === 'provider-demoted') await f.changeProvider({ role: 'member' });
      if (variant === 'provider-removed') await f.changeProvider({ active: false });
      assertCode(await activate(baseUrl, created), 'REGISTRATION_ENDED', { reason: 'withdrawn' });
      const stored = await f.docs.get(registrationParts(created.registrationId));
      assert.equal(stored.withdrawnBy, 'recheck');
      assert.equal(stored.activatedInstallationId, undefined);
    });
  }

  test(`[${backend.name}] WorkOS activation fails closed during provider outage and retries the same activation`, { timeout: 120000 }, async t => {
    const f = await workosActivationFixture(t, backend);
    const { baseUrl } = f.server;
    const { created } = await approvedNew(baseUrl, f.who);
    await f.changeProvider({ unavailable: true });
    const id = activationId();
    const refused = await activate(baseUrl, created, { activationId: id });
    assert.ok(refused.status >= 500, refused.text);
    assert.equal((await f.docs.get(registrationParts(created.registrationId))).status, 'approved');
    await f.changeProvider({ unavailable: false });
    const activated = await activate(baseUrl, created, { activationId: id });
    assert.equal(activated.status, 201, activated.text);
    const replay = await activate(baseUrl, created, { activationId: id });
    assert.equal(replay.status, 200, replay.text);
    assert.equal(replay.payload.installation.id, activated.payload.installation.id);
  });

  test(`[${backend.name}] the local-helper journey: activate, connect, recover, replay, reconnect the same identity`, { timeout: 120000 }, async t => {
    let server = await launchRegistration(backend);
    t.after(() => server.stop());
    const near = await nearReplayCancellationFixture(t);
    const owner1 = await owner(server.baseUrl, `${s}01`);
    // The owner's own agent uses one slot; the new agent takes the other.
    const { created, localPart } = await approvedNew(server.baseUrl, owner1);
    const id = activationId();
    const first = await activate(server.baseUrl, created, { activationId: id });
    assert.equal(first.status, 201, first.text);
    assert.equal(first.headers.get('cache-control'), 'no-store');
    assertContract('activated', first.payload);
    const { installation, agent, inboxId } = first.payload;
    assert.deepEqual({ status: installation.status, legacy: installation.legacy, connectionRoute: installation.connectionRoute, deliveryMode: installation.deliveryMode },
      { status: 'active', legacy: false, connectionRoute: 'local_helper', deliveryMode: 'envoi_link' });
    assert.deepEqual(installation.runtime, { type: 'hermes', version: '0.9.0' });
    assert.equal(agent.address, `${localPart}@envoi.mail`);
    assert.equal(agent.status, 'active');
    assert.deepEqual(first.payload.effectivePermissions, ['send_agent_messages', 'receive_agent_messages']);

    // CONNECTED: authenticated status after activation, carrying the installation.
    const status = await agentStatus(server.baseUrl, first.payload.agentApiToken);
    assert.equal(status.status, 200, status.text);
    // case-session v1 §1 adds caseSessions to every status response; this schema predates it.
    const { caseSessions, httpWake, ...registrationStatus } = status.payload;
    assert.deepEqual(httpWake, { available: false, version: 1, subscription: null });
    assert.deepEqual(caseSessions, { available: false, version: 1 });
    assertContract('agentStatusWithInstallation', registrationStatus);
    assert.deepEqual(status.payload.installation, { id: installation.id, connectionRoute: 'local_helper', deliveryMode: 'envoi_link', legacy: false });
    assert.equal((await refresh(server.baseUrl, first.payload.agentRefreshToken, newRotationId())).status, 200, 'refresh continues through /api/agent-token');

    // Polling inside the recovery window: status only, never credentials.
    await sleep(4100);
    const polled = await poll(server.baseUrl, created);
    assertContract('registrationStatus', polled.payload);
    assert.deepEqual(polled.payload, { registrationId: created.registrationId, status: 'activated', installationId: installation.id });
    const listed = (await api(server.baseUrl, '/api/agent-claims', { session: owner1.session })).payload.claims.find(item => item.registrationId === created.registrationId);
    assert.deepEqual({ status: listed.status, installationId: listed.installationId }, { status: 'activated', installationId: installation.id });

    // Row 7: the lost response comes back identical, also after a restart.
    const recovered = await activate(server.baseUrl, created, { activationId: id });
    assert.equal(recovered.status, 200, recovered.text);
    assert.deepEqual(recovered.payload, first.payload);
    await server.stop(true);
    server = await launchRegistration(backend, {
      ...near.env, ENVOI_NEAR_PAYMENT_AGENT_ACCOUNTS: JSON.stringify({ [agent.id]: 'milo.testnet' })
    }, backend.name === 'FileStore' ? server.dataDir : null);
    const afterRestart = await activate(server.baseUrl, created, { activationId: id });
    assert.equal(afterRestart.status, 200, afterRestart.text);
    assert.deepEqual(afterRestart.payload, first.payload);

    // Row 7a: a second holder of the bootstrap token ends the installation, not the identity.
    const docs = documents(t, backend, server);
    const payment = await near.seed(docs, await docs.get(registrationParts(created.registrationId)));
    assertCode(await activate(server.baseUrl, created, { activationId: activationId() }), 'ACTIVATION_REPLAY');
    assertRevoked(await agentStatus(server.baseUrl, first.payload.agentApiToken), 'revoked');
    assert.deepEqual(await docs.get(payment.pending), payment.record);
    near.recover();
    const stored = await docs.get(['inboxes', inboxId, 'agents', `${agent.id}.json`]);
    assert.deepEqual({ status: stored.status, onboardingStatus: stored.onboardingStatus }, { status: 'active', onboardingStatus: 'approved' });
    const ended = (await api(server.baseUrl, installationsRoute(inboxId, agent.id), { session: owner1.session })).payload.installations;
    assert.deepEqual(ended.map(item => [item.id, item.status, item.endedReason]), [[installation.id, 'ended', 'activation_replay']]);
    // Row 6: an ended installation is never recovered, whatever the activationId.
    assertCode(await activate(server.baseUrl, created, { activationId: id }), 'ACTIVATION_RECOVERY_EXPIRED');

    // The owner attaches a new registration to the same identity: address and history are kept.
    const again = await registered(server.baseUrl, { runtime: { type: 'openclaw', version: null } });
    const attach = await approveRequest(server.baseUrl, owner1, again.registrationId, approveBody(code(again), { kind: 'existing_agent', agentId: agent.id, replacesInstallationId: null }, ['receive_agent_messages']));
    assert.equal(attach.status, 200, attach.text);
    const reattached = await activate(server.baseUrl, again);
    assert.equal(reattached.status, 201, reattached.text);
    assertContract('activated', reattached.payload);
    assert.equal(reattached.payload.agent.id, agent.id);
    assert.equal(reattached.payload.agent.address, agent.address);
    assert.equal(reattached.payload.inboxId, inboxId);
    assert.deepEqual(reattached.payload.effectivePermissions, ['receive_agent_messages'], 'permissions are decided again');
    assert.equal((await agentStatus(server.baseUrl, reattached.payload.agentApiToken)).status, 200);
    await near.assertDrained(docs, payment);
  });

  test(`[${backend.name}] §6.1 rows: precedence before and after approval`, { timeout: 120000 }, async t => {
    const server = await launchRegistration(backend);
    t.after(() => server.stop());
    const { baseUrl } = server;
    const who = await owner(baseUrl, `${s}11`);
    const pending = await registered(baseUrl);
    assertCode(await api(baseUrl, '/api/agent-installations/activate', { token: pending.bootstrapToken, body: { registrationId: pending.registrationId, deliveryMode: 'envoi_link' } }), 'ACTIVATION_ID_REQUIRED');
    assertCode(await activate(baseUrl, pending, { activationId: 'short' }), 'ACTIVATION_ID_REQUIRED');
    assertCode(await activate(baseUrl, pending, { token: 'envoi_reg_' + 'B'.repeat(43) }), 'REGISTRATION_TOKEN_INVALID');
    assertCode(await activate(baseUrl, pending, { registrationId: 'registration_other' }), 'REGISTRATION_TOKEN_INVALID');
    assertCode(await activate(baseUrl, pending, { capabilities: { sse: true } }), 'ACTIVATION_INVALID');
    assertCode(await activate(baseUrl, pending, { deliveryMode: 'webhook' }), 'DELIVERY_MODE_NOT_AVAILABLE');
    assertCode(await activate(baseUrl, pending), 'REGISTRATION_PENDING');

    const rejectable = await registered(baseUrl);
    assert.equal((await rejectRequest(baseUrl, who, rejectable.registrationId, code(rejectable))).status, 200);
    assertCode(await activate(baseUrl, rejectable), 'REGISTRATION_ENDED', { reason: 'rejected' });

    const withdrawn = await approvedNew(baseUrl, who);
    assert.equal((await withdrawRequest(baseUrl, who, withdrawn.created.registrationId)).status, 200);
    assertCode(await activate(baseUrl, withdrawn.created), 'REGISTRATION_ENDED', { reason: 'withdrawn' });

    const docs = documents(t, backend, server);
    const expiring = await approvedNew(baseUrl, who);
    // An invalid body consumes nothing: the approval stays live (fixture activation-invalid).
    assertCode(await activate(baseUrl, expiring.created, { extra: 1 }), 'ACTIVATION_INVALID');
    await docs.edit(registrationParts(expiring.created.registrationId), value => ({ ...value, activationExpiresAt: PAST }));
    assertCode(await activate(baseUrl, expiring.created), 'REGISTRATION_ENDED', { reason: 'expired' });
    // The expired approval released its hold: the address is free again.
    const free = await api(baseUrl, `/api/inboxes/${who.inbox.parentInboxId}/agent-address-availability?localPart=${expiring.localPart}`, { session: who.session });
    assert.equal(free.payload.available, true, free.text);
  });

  test(`[${backend.name}] existing agents: paused stays paused, earlier installations are replaced, failed re-checks withdraw`, { timeout: 120000 }, async t => {
    const server = await launchRegistration(backend);
    t.after(() => server.stop());
    const { baseUrl } = server;
    const who = await owner(baseUrl, `${s}21`);
    const [legacy] = (await api(baseUrl, installationsRoute(who.inbox.id, who.agent.id), { session: who.session })).payload.installations;
    const created = await registered(baseUrl);
    assert.equal((await approveRequest(baseUrl, who, created.registrationId, approveBody(code(created), { kind: 'existing_agent', agentId: who.agent.id, replacesInstallationId: legacy.id }, ['send_agent_messages']))).status, 200);
    await pauseAgent(baseUrl, who);
    const activated = await activate(baseUrl, created);
    assert.equal(activated.status, 201, activated.text);
    assertContract('activated', activated.payload);
    assert.equal(activated.payload.agent.status, 'paused', 'a paused agent stays paused');
    assert.deepEqual(activated.payload.effectivePermissions, ['send_agent_messages', 'receive_agent_messages']);
    assertRevoked(await agentStatus(baseUrl, who.agentApiToken), 'replaced');
    const paused = await agentStatus(baseUrl, activated.payload.agentApiToken);
    assert.equal(paused.status, 200, paused.text);
    assert.equal(paused.payload.state, 'paused');
    const list = (await api(baseUrl, installationsRoute(who.inbox.id, who.agent.id), { session: who.session })).payload.installations;
    assert.deepEqual(list.map(item => [item.legacy, item.status, item.endedReason]), [[false, 'active', null], [true, 'ended', 'replaced']]);

    // Row 11: the agent-wide revoke after approval fails the re-check; the approval is withdrawn.
    const later = await registered(baseUrl);
    assert.equal((await approveRequest(baseUrl, who, later.registrationId, approveBody(code(later), { kind: 'existing_agent', agentId: who.agent.id, replacesInstallationId: activated.payload.installation.id }))).status, 200);
    assert.equal((await api(baseUrl, `/api/inboxes/${who.inbox.id}/agents/${who.agent.id}/credentials/revoke`, { session: who.session, body: {} })).status, 200);
    assertCode(await activate(baseUrl, later), 'REGISTRATION_ENDED', { reason: 'withdrawn' });
    await sleep(4100);
    assert.deepEqual((await poll(baseUrl, later)).payload, { registrationId: later.registrationId, status: 'withdrawn' });
  });

  test(`[${backend.name}] the tombstone: after the recovery window nothing activates or revokes`, { timeout: 90000 }, async t => {
    const server = await launchRegistration(backend);
    t.after(() => server.stop());
    const { baseUrl } = server;
    const who = await owner(baseUrl, `${s}31`);
    const { created } = await approvedNew(baseUrl, who);
    const activated = await activate(baseUrl, created);
    assert.equal(activated.status, 201, activated.text);
    await documents(t, backend, server).edit(registrationParts(created.registrationId), value => ({ ...value, activatedAt: PAST }));
    assertCode(await activate(baseUrl, created), 'ACTIVATION_RECOVERY_EXPIRED');
    assertCode(await poll(baseUrl, created), 'ACTIVATION_RECOVERY_EXPIRED');
    assert.equal((await agentStatus(baseUrl, activated.payload.agentApiToken)).status, 200, 'a late retry revokes nothing');
    // Lookups never find it again.
    assertCode(await lookup(baseUrl, who, code(created)), 'CLAIM_CODE_INVALID');
  });
}
