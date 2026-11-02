import test from 'node:test';
import assert from 'node:assert/strict';
import { authorize } from '../src/authorization-v2.js';
import { relationshipRecord, revokeRelationship, trustedDiscovery, validateRelationshipGrants } from '../src/relationships.js';
import { readOnboardingFlags } from '../src/onboarding-flags.js';
import { a2aAgentCard, parseA2ATextMessage, projectA2ATask } from '../src/a2a/adapter.js';
import { CASE_STATES } from '../src/agent-interface.js';
import { signDiscoveryInvitation, verifyDiscoveryInvitation } from '../src/discovery-invitations.js';

const active = { id: 'agent_a', status: 'active' };
const installation = { id: 'installation_a', agentId: 'agent_a', status: 'active' };
const request = { actorAgentId: 'agent_a', installationId: 'installation_a', action: 'agent.discover' };
const facts = { identity: active, installation, installationRequired: true, permissions: ['send_agent_messages'] };

test('D1 grants are distinct, directed, and revocable without changing contact state', () => {
  assert.deepEqual(validateRelationshipGrants(['allowInvitations', 'shareAssets']), ['shareAssets', 'allowInvitations']);
  assert.throws(() => validateRelationshipGrants(['shareAssets', 'shareAssets']), /distinct supported/);
  assert.throws(() => validateRelationshipGrants(['all']), /distinct supported/);
  const granted = relationshipRecord({ inboxId: 'inbox_a', actorAgentId: 'agent_a', targetAgentId: 'agent_b', grants: ['shareAssets'], now: '2026-10-23T00:00:00Z', humanId: 'human_a' });
  assert.equal(granted.actorAgentId, 'agent_a');
  assert.equal(granted.targetAgentId, 'agent_b');
  assert.deepEqual(granted.grants, ['shareAssets']);
  const revoked = revokeRelationship(granted, '2026-10-24T00:00:00Z', 'human_a');
  assert.equal(revoked.status, 'revoked');
  assert.deepEqual(revoked.grants, []);
  assert.equal(granted.status, 'active');
});

test('D1 exact address projects verified reachable identity and visible trust', () => {
  const directory = { agentId: 'agent_b', address: 'b@envoi.mail', status: 'active', verified: true };
  assert.equal(trustedDiscovery({ ...directory, verified: false }), null);
  assert.equal(trustedDiscovery({ ...directory, status: 'revoked' }), null);
  assert.equal(trustedDiscovery({ ...directory, status: 'paused' }).trust, 'exact_address');
  assert.deepEqual(trustedDiscovery(directory), { agentId: 'agent_b', address: 'b@envoi.mail', trust: 'exact_address', grants: [] });
  assert.equal(trustedDiscovery(directory, { approvedContact: { approved: true } }).trust, 'approved_contact');
  assert.equal(trustedDiscovery(directory, { approvedContact: { approved: true, blocked: true } }).trust, 'exact_address');
  assert.equal(trustedDiscovery(directory, { sameOrganization: true }).trust, 'same_organization');
  assert.equal(trustedDiscovery(directory, { relationship: { status: 'active', grants: ['shareAssets'] } }).trust, 'relationship');
});

test('D2 authorization checks its ordered gates and denies missing facts', () => {
  assert.deepEqual(authorize(request, facts), { allowed: true, reason: 'ALLOW' });
  assert.equal(authorize({ ...request, action: 'unknown.action' }, facts).reason, 'PERMISSION_DENIED');
  assert.equal(authorize({ ...request, action: 'case.propose', caseId: 'case_a' }, { ...facts, permissions: ['execute_cases'], caseRecord: { id: 'case_a', schemaVersion: '1.0', participants: ['agent_a'] } }).reason, 'ALLOW');
  assert.equal(authorize(request, { ...facts, identity: { ...active, status: 'paused' } }).reason, 'IDENTITY_INACTIVE');
  assert.equal(authorize(request, { ...facts, installation: { ...installation, status: 'ended' } }).reason, 'INSTALLATION_INACTIVE');
  assert.equal(authorize(request, { ...facts, permissions: [] }).reason, 'PERMISSION_DENIED');
  assert.equal(authorize({ ...request, relationshipId: 'agent_a:agent_b' }, { ...facts, relationshipGrant: 'shareAssets' }).reason, 'RELATIONSHIP_DENIED');
  assert.equal(authorize({ ...request, relationshipId: 'agent_a:agent_b' }, { ...facts, relationshipGrant: 'shareAssets', relationship: { id: 'agent_a:agent_b', actorAgentId: 'agent_a', status: 'active', grants: ['shareAssets'] }, contactBlocked: true }).reason, 'RELATIONSHIP_DENIED');
  assert.equal(authorize({ ...request, caseId: 'case_a' }, { ...facts, caseRecord: { id: 'case_a', participantAgentIds: [] } }).reason, 'CASE_MEMBERSHIP_DENIED');
  assert.equal(authorize({ ...request, resourceId: 'asset_a' }, facts).reason, 'RESOURCE_DENIED');
  assert.equal(authorize(request, { ...facts, policyRequired: true }).reason, 'POLICY_DENIED');
  assert.equal(authorize(request, { ...facts, humanApproval: { required: true, approved: false } }).reason, 'HUMAN_APPROVAL_REQUIRED');
});

test('D0 flags default off and A2A requires relationship and installation flags', () => {
  assert.equal(readOnboardingFlags({}).relationships, undefined);
  assert.throws(() => readOnboardingFlags({ ENVOI_RELATIONSHIPS_V2: 'true' }), /ENVOI_RELATIONSHIPS_V2 requires ENVOI_INSTALLATIONS_V2/);
  assert.throws(() => readOnboardingFlags({ ENVOI_A2A_GATEWAY: 'true' }), /requires ENVOI_RELATIONSHIPS_V2 and ENVOI_INSTALLATIONS_V2/);
  assert.throws(() => readOnboardingFlags({ ENVOI_A2A_GATEWAY: 'true', ENVOI_RELATIONSHIPS_V2: 'true', ENVOI_INSTALLATIONS_V2: 'true' }), /requires ENVOI_PUBLIC_URL/);
  assert.equal(readOnboardingFlags({ ENVOI_A2A_GATEWAY: 'true', ENVOI_RELATIONSHIPS_V2: 'true', ENVOI_INSTALLATIONS_V2: 'true', ENVOI_PUBLIC_URL: 'https://agents.example.test' }).a2aGateway, true);
});

test('D3 accepts only the advertised immediate text subset and projects canonical Cases', () => {
  const message = { message: { messageId: 'message-1', role: 'ROLE_USER', parts: [{ text: 'Hello' }] }, configuration: { returnImmediately: true } };
  assert.deepEqual(parseA2ATextMessage(message), { messageId: 'message-1', text: 'Hello' });
  assert.throws(() => parseA2ATextMessage({ ...message, configuration: {} }), /returnImmediately/);
  assert.throws(() => parseA2ATextMessage({ ...message, message: { ...message.message, parts: [{ url: 'https://example.com' }] } }), /one user text part/);
  const persisted = { id: 'case_1', schemaVersion: '1.0', state: 'inProgress', updatedAt: '2026-10-23T00:00:00Z' };
  assert.deepEqual(projectA2ATask(persisted), { id: 'case_1', contextId: 'case_1', status: { state: 'TASK_STATE_WORKING', timestamp: persisted.updatedAt }, artifacts: [] });
  assert.throws(() => projectA2ATask({ ...persisted, schemaVersion: null }), /persisted Envoi Case/);
  assert.throws(() => projectA2ATask(persisted, { artifacts: [{ id: 'asset_1' }] }), /authorized HTTPS/);
  for (const state of CASE_STATES) assert.ok(projectA2ATask({ ...persisted, state }).status.state.startsWith('TASK_STATE_'), state);
  const card = a2aAgentCard({ name: 'Envoi', description: 'Gateway', url: 'https://example.com/a2a' });
  assert.equal(card.capabilities.streaming, false);
  assert.deepEqual(card.securityRequirements, [{ schemes: { envoiBearer: { list: [] } } }]);
  assert.equal(Object.hasOwn(card, 'security'), false);
});

test('D1 signed invitations bind audience, expiry, and signature', () => {
  const key = Buffer.alloc(32, 7);
  const issuedAt = '2026-10-23T12:00:00.000Z';
  const payload = { id: 'invitation_1', issuerAgentId: 'agent_a', issuerInboxId: 'inbox_a', recipientAgentId: 'agent_b', recipientInboxId: 'inbox_b', issuedAt, expiresAt: '2026-10-24T12:00:00.000Z' };
  const token = signDiscoveryInvitation(payload, key);
  assert.deepEqual(verifyDiscoveryInvitation(token, key, new Date('2026-10-23T13:00:00.000Z')), payload);
  assert.equal(verifyDiscoveryInvitation(token, Buffer.alloc(32, 8), new Date('2026-10-23T13:00:00.000Z')), null);
  assert.equal(verifyDiscoveryInvitation(`${token.slice(0, -1)}x`, key, new Date('2026-10-23T13:00:00.000Z')), null);
  assert.equal(verifyDiscoveryInvitation(token, key, new Date('2026-10-24T12:00:00.000Z')), null);
});
