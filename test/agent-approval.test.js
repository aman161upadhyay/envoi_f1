// agent-registration v1 §5.3 (task A-4.1): the shared approval module. Permissions are checked
// against the canonical claim fixtures; slot counting runs on a real FileStore.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileStore } from '../src/storage.js';
import {
  activeAgentsPerHuman, agentPermissions, approvalSlotIndexPath, createAgentSlots, effectivePermissions, legacyApprovalPermissions,
  organizationMaximumPermissions, registrationPath
} from '../src/agent-approval.js';

const fixturesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'contract-fixtures');
const index = JSON.parse(await readFile(path.join(fixturesRoot, 'index.json'), 'utf8'));
const contract = index.contracts.find(entry => entry.id === 'agent-registration');
const contractDir = path.join(fixturesRoot, contract.dir);
const fixtures = await Promise.all(contract.fixtures.map(async name => JSON.parse(await readFile(path.join(contractDir, name), 'utf8'))));
const schemas = JSON.parse(await readFile(path.join(contractDir, contract.schemas), 'utf8'));

// ---- permissions ----

const permissionCases = [];
for (const fixture of fixtures) {
  (fixture.steps || [{ request: fixture.request, response: fixture.response }]).forEach((step, stepIndex) => {
    const requested = fixture.context?.requestedPermissions;
    const granted = step.request?.body?.grantedPermissions;
    const expected = step.response?.body?.effectivePermissions;
    if (requested && granted && expected && step.response.status === 200) permissionCases.push({ fixture, stepIndex, requested, granted, expected });
  });
}

for (const { fixture, stepIndex, requested, granted, expected } of permissionCases) {
  test(`effectivePermissions matches fixture ${fixture.id} step ${stepIndex}`, () => {
    assert.deepEqual(effectivePermissions(requested, granted), expected);
  });
}

test('permission fixtures: the minimum set was exercised', () => {
  const ids = new Set(permissionCases.map(item => item.fixture.id));
  for (const id of ['claim-approve-new-agent', 'claim-approve-existing-agent']) assert.ok(ids.has(id), `${id} exercised`);
});

test('the permission list matches the contract enum and v1 has no organization ceiling', () => {
  assert.deepEqual([...agentPermissions].sort(), [...schemas.definitions.permission.enum].sort());
  assert.deepEqual(organizationMaximumPermissions(), agentPermissions);
  assert.notEqual(organizationMaximumPermissions(), agentPermissions, 'a fresh copy each call');
});

test('effectivePermissions: requested ∩ granted ∩ maximum, request order, deduped, unknown dropped, plus receive', () => {
  assert.deepEqual(
    effectivePermissions(['execute_cases', 'send_agent_messages', 'send_agent_messages', 'bogus', 'create_assets'], ['send_agent_messages', 'execute_cases', 'create_assets', 'bogus', 'use_email_transport']),
    ['execute_cases', 'send_agent_messages', 'create_assets', 'receive_agent_messages']
  );
  // Granted but not requested is dropped silently.
  assert.deepEqual(effectivePermissions(['send_agent_messages'], ['send_agent_messages', 'use_email_transport']), ['send_agent_messages', 'receive_agent_messages']);
  // Requested and granted but above the maximum is dropped.
  assert.deepEqual(effectivePermissions(['send_agent_messages', 'execute_cases'], ['send_agent_messages', 'execute_cases'], ['send_agent_messages']), ['send_agent_messages', 'receive_agent_messages']);
  // An unknown permission is dropped even when the maximum lists it.
  assert.deepEqual(effectivePermissions(['bogus'], ['bogus'], ['bogus']), ['receive_agent_messages']);
  // receive keeps its requested position when requested and granted; otherwise it is appended.
  assert.deepEqual(effectivePermissions(['receive_agent_messages', 'send_agent_messages'], ['receive_agent_messages', 'send_agent_messages']), ['receive_agent_messages', 'send_agent_messages']);
  assert.deepEqual(effectivePermissions(['receive_agent_messages', 'send_agent_messages'], ['send_agent_messages']), ['send_agent_messages', 'receive_agent_messages']);
  assert.deepEqual(effectivePermissions([], []), ['receive_agent_messages']);
  assert.deepEqual(effectivePermissions(['send_agent_messages'], [], []), ['receive_agent_messages']);
});

test('legacyApprovalPermissions: defaults, known only, request order, always adds receive', () => {
  assert.deepEqual(legacyApprovalPermissions(undefined), ['send_agent_messages', 'receive_agent_messages']);
  assert.deepEqual(legacyApprovalPermissions(null), ['send_agent_messages', 'receive_agent_messages']);
  assert.deepEqual(legacyApprovalPermissions('send_agent_messages'), ['send_agent_messages', 'receive_agent_messages']);
  assert.deepEqual(legacyApprovalPermissions([]), ['receive_agent_messages']);
  assert.deepEqual(legacyApprovalPermissions(['execute_cases']), ['execute_cases', 'receive_agent_messages']);
  assert.deepEqual(legacyApprovalPermissions(['bogus', 'create_assets', 'send_agent_messages']), ['create_assets', 'send_agent_messages', 'receive_agent_messages']);
  assert.deepEqual(legacyApprovalPermissions(['receive_agent_messages', 'execute_cases']), ['receive_agent_messages', 'execute_cases']);
  const input = ['send_agent_messages'];
  legacyApprovalPermissions(input);
  assert.deepEqual(input, ['send_agent_messages'], 'the input is not mutated');
});

// ---- agent slots on a real FileStore ----

const HUMAN = 'human_principal';
const OTHER = 'human_other';
const future = () => new Date(Date.now() + 3_600_000).toISOString();
const past = () => new Date(Date.now() - 3_600_000).toISOString();

async function slotStore(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'envoi-agent-slots-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new FileStore(directory);
  await store.init();
  const seed = {
    async agent(agentId, { inboxId = `inbox_${agentId}`, principalHumanId = HUMAN, status = 'active', directoryStatus = status } = {}) {
      await store.putJson(path.join('directory', 'agents', `${agentId}.json`), { agentId, inboxId, status: directoryStatus });
      await store.putJson(path.join('inboxes', inboxId, 'agents', `${agentId}.json`), { id: agentId, principalHumanId, status });
      return { agentId, inboxId };
    },
    async family(inboxId, agentId, familyId, { revokedAt = null, refreshExpiresAt = future() } = {}) {
      await store.putJson(path.join('auth', 'agent-credential-families', inboxId, agentId, `${familyId}.json`), { id: familyId, revokedAt, refreshExpiresAt });
    },
    async approval(registrationId, target, { humanId = HUMAN, principalHumanId = humanId, status = 'approved', activationExpiresAt = future() } = {}) {
      await store.putJson(approvalSlotIndexPath(humanId, registrationId), { registrationId });
      await store.putJson(registrationPath(registrationId), { status, activationExpiresAt, principalHumanId, target });
    }
  };
  return { store, seed, slots: createAgentSlots({ store }) };
}
const newAgent = { kind: 'new_agent' };
const existing = ({ agentId, inboxId }) => ({ kind: 'existing_agent', agentId, agentInboxId: inboxId });

test('slots: an empty store uses no slots', async t => {
  const { slots } = await slotStore(t);
  assert.equal(activeAgentsPerHuman, 2);
  assert.equal(await slots.usedSlots(HUMAN), 0);
  await slots.assertActiveAgentSlot(HUMAN);
});

test('slots: an active or paused agent counts with a live family or no family', async t => {
  const { seed, slots } = await slotStore(t);
  const live = await seed.agent('agent_live');
  await seed.family(live.inboxId, live.agentId, 'credential_family_dead', { revokedAt: past() });
  await seed.family(live.inboxId, live.agentId, 'credential_family_live');
  await seed.agent('agent_nofamily', { status: 'paused' });
  assert.equal(await slots.usedSlots(HUMAN), 2);
  assert.equal(await slots.agentHasLiveFamily(live.inboxId, live.agentId, new Date()), true);
});

test('slots: an agent whose families are all dead (revoked or expired) does not count', async t => {
  const { seed, slots } = await slotStore(t);
  const dead = await seed.agent('agent_dead');
  await seed.family(dead.inboxId, dead.agentId, 'credential_family_revoked', { revokedAt: past() });
  await seed.family(dead.inboxId, dead.agentId, 'credential_family_expired', { refreshExpiresAt: past() });
  assert.equal(await slots.usedSlots(HUMAN), 0);
  assert.equal(await slots.agentHasLiveFamily(dead.inboxId, dead.agentId, new Date()), false);
});

test('slots: other principals and inactive agents do not count', async t => {
  const { seed, slots } = await slotStore(t);
  await seed.agent('agent_other', { principalHumanId: OTHER });
  await seed.agent('agent_revoked', { status: 'revoked' });
  await seed.agent('agent_pending', { status: 'pending_approval' });
  // The directory says active but the agent document says revoked: the agent document wins.
  await seed.agent('agent_stale_directory', { status: 'revoked', directoryStatus: 'active' });
  assert.equal(await slots.usedSlots(HUMAN), 0);
  assert.equal(await slots.usedSlots(OTHER), 1);
});

test('slots: excludingAgentId skips that agent', async t => {
  const { seed, slots } = await slotStore(t);
  await seed.agent('agent_a');
  await seed.agent('agent_b');
  assert.equal(await slots.usedSlots(HUMAN), 2);
  assert.equal(await slots.usedSlots(HUMAN, { excludingAgentId: 'agent_a' }), 1);
});

test('slots: a live new_agent approval counts; an expired or non-approved one does not', async t => {
  const { seed, slots } = await slotStore(t);
  await seed.approval('registration_live', newAgent);
  assert.equal(await slots.usedSlots(HUMAN), 1);
  await seed.approval('registration_expired', newAgent, { activationExpiresAt: past() });
  await seed.approval('registration_activated', newAgent, { status: 'activated' });
  await seed.approval('registration_withdrawn', newAgent, { status: 'withdrawn' });
  assert.equal(await slots.usedSlots(HUMAN), 1);
});

test('slots: an approval charged to another principal does not count', async t => {
  const { seed, slots } = await slotStore(t);
  // Indexed under HUMAN but the registration names another principal.
  await seed.approval('registration_mismatch', newAgent, { principalHumanId: OTHER });
  assert.equal(await slots.usedSlots(HUMAN), 0);
});

test('slots: an existing_agent approval counts only when the agent has families and all are dead', async t => {
  const { seed, slots } = await slotStore(t);
  const dead = await seed.agent('agent_dead');
  await seed.family(dead.inboxId, dead.agentId, 'credential_family_revoked', { revokedAt: past() });
  await seed.family(dead.inboxId, dead.agentId, 'credential_family_expired', { refreshExpiresAt: past() });
  await seed.approval('registration_dead', existing(dead));
  assert.equal(await slots.usedSlots(HUMAN), 1, 'all-dead families: the approval needs a slot');

  const live = await seed.agent('agent_live');
  await seed.family(live.inboxId, live.agentId, 'credential_family_live');
  await seed.approval('registration_live', existing(live));
  assert.equal(await slots.usedSlots(HUMAN), 2, 'live family: the agent counts itself, the approval adds nothing');

  const none = await seed.agent('agent_none', { principalHumanId: OTHER });
  await seed.approval('registration_none', existing(none), { humanId: OTHER });
  assert.equal(await slots.usedSlots(OTHER), 1, 'no family: the agent counts itself, the approval adds nothing');

  await seed.approval('registration_dead_expired', existing(dead), { activationExpiresAt: past() });
  assert.equal(await slots.usedSlots(HUMAN), 2, 'an expired existing_agent approval does not count');
});

test('slots: excludingAgentId also skips an existing_agent approval of that agent', async t => {
  const { seed, slots } = await slotStore(t);
  const dead = await seed.agent('agent_dead');
  await seed.family(dead.inboxId, dead.agentId, 'credential_family_revoked', { revokedAt: past() });
  await seed.approval('registration_dead', existing(dead));
  assert.equal(await slots.usedSlots(HUMAN), 1);
  assert.equal(await slots.usedSlots(HUMAN, { excludingAgentId: 'agent_dead' }), 0);
});

test('slots: excludingRegistrationId skips that approval', async t => {
  const { seed, slots } = await slotStore(t);
  await seed.approval('registration_one', newAgent);
  await seed.approval('registration_two', newAgent);
  assert.equal(await slots.usedSlots(HUMAN), 2);
  assert.equal(await slots.usedSlots(HUMAN, { excludingRegistrationId: 'registration_one' }), 1);
});

test('slots: an index entry with no registration document does not count', async t => {
  const { store, slots } = await slotStore(t);
  await store.putJson(approvalSlotIndexPath(HUMAN, 'registration_missing'), { registrationId: 'registration_missing' });
  await store.putJson(approvalSlotIndexPath(HUMAN, 'registration_blank'), {});
  assert.equal(await slots.usedSlots(HUMAN), 0);
});

test('assertActiveAgentSlot throws ACTIVE_AGENT_LIMIT at two used slots', async t => {
  const { seed, slots } = await slotStore(t);
  await seed.agent('agent_a');
  await slots.assertActiveAgentSlot(HUMAN);
  await seed.approval('registration_new', newAgent);
  await assert.rejects(slots.assertActiveAgentSlot(HUMAN), error => error.code === 'ACTIVE_AGENT_LIMIT' && error.statusCode === 409);
  await slots.assertActiveAgentSlot(HUMAN, { excludingAgentId: 'agent_a' });
  await slots.assertActiveAgentSlot(HUMAN, { excludingRegistrationId: 'registration_new' });
  await slots.assertActiveAgentSlot(OTHER);
});

test('staging exception allows only the two configured existing principals past two slots', async t => {
  const { store, seed } = await slotStore(t);
  await seed.agent('first');
  await seed.agent('second');
  await seed.agent('other_first', { principalHumanId: OTHER });
  await seed.agent('other_second', { principalHumanId: OTHER });
  const configured = createAgentSlots({ store, uncappedHumanIds: new Set([HUMAN]) });
  assert.equal(configured.isUncappedHuman(HUMAN), true);
  assert.equal(configured.isUncappedHuman(OTHER), false);
  await configured.assertActiveAgentSlot(HUMAN);
  await assert.rejects(configured.assertActiveAgentSlot(OTHER), error => error.code === 'ACTIVE_AGENT_LIMIT');
  const defaultSlots = createAgentSlots({ store });
  await assert.rejects(defaultSlots.assertActiveAgentSlot(HUMAN), error => error.code === 'ACTIVE_AGENT_LIMIT');
});
