import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { evaluatePolicy, valueDigest, verifyDecisionRecord } from '../src/policy-engine.js';
import { casePolicyDisplay, evaluateSignedCaseGrant, requireCasePolicyDocument, requireOwnerSignature } from '../src/signed-case-policy.js';

const nowMs = Date.now();
const context = { workspaceId: 'inbox_1', caseId: 'case_1', ownerId: 'human_1', agentId: 'agent_1' };
const target = { assetId: 'asset_1', assetVersion: 'v1', recipientAgentId: 'agent_2' };
const document = {
  schema: 'envoi.case-policy/v1', ...context, version: 1, previousHash: null, issuedAtMs: nowMs - 1000, expiresAtMs: nowMs + 60_000,
  grants: [{ id: 'share-report', action: 'asset.share', decision: 'needsHuman', target }]
};
document.display = casePolicyDisplay(document);

test('an owner-device signature binds every grant, target, display line and identity', async () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const publicKey = Buffer.from(keys.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex');
  const signature = crypto.sign(null, Buffer.from(valueDigest(document), 'hex'), keys.privateKey).toString('hex');
  const envelope = { document, keyType: 'demo_device', publicKey, signature };
  const config = { ownerAccount: 'owner.testnet', nowMs, registry: async (owner, key, type) => {
    assert.deepEqual([owner, key, type], ['owner.testnet', publicKey, 'demo_device']);
    return { registered_at_ms: nowMs - 2000, revoked_at_ms: null };
  } };
  assert.doesNotThrow(() => requireCasePolicyDocument(document, context, nowMs));
  assert.throws(() => requireCasePolicyDocument(document, { ...context, caseId: 'case_2' }, nowMs), /does not belong/);
  assert.throws(() => requireCasePolicyDocument({ ...document, display: [] }, context, nowMs), /display does not match/);
  assert.equal(await requireOwnerSignature(envelope, config), valueDigest(document));
  await assert.rejects(requireOwnerSignature({ ...envelope, document: { ...document, version: 2 } }, config), { code: 'OWNER_SIGNATURE_INVALID' });
  await assert.rejects(requireOwnerSignature(envelope, { ...config, registry: async () => ({ registered_at_ms: nowMs, revoked_at_ms: null }) }), { code: 'OWNER_KEY_UNAVAILABLE' });
  await assert.rejects(requireOwnerSignature(envelope, { ...config, registry: async () => ({ registered_at_ms: nowMs - 2000, revoked_at_ms: nowMs }) }), { code: 'OWNER_KEY_UNAVAILABLE' });
});

test('signed grants match exact resources and can only narrow existing checks', () => {
  const signed = { document, digest: valueDigest(document) };
  assert.equal(evaluateSignedCaseGrant(signed, 'asset.share', { ...target, assetVersion: 'v2' }).decision, 'deny');
  assert.equal(evaluateSignedCaseGrant(signed, 'asset.share', { ...target, recipientAgentId: 'agent_3' }).decision, 'deny');
  assert.equal(evaluateSignedCaseGrant(signed, 'asset.share', { ...target, recipientEmail: 'a@example.com' }).decision, 'deny');
  assert.equal(evaluateSignedCaseGrant(signed, 'asset.share', target).decision, 'needsHuman');
  const signedGrant = { ...evaluateSignedCaseGrant(signed, 'asset.share', target), decision: 'allow' };
  const input = { id: 'evaluation', workspaceId: 'inbox_1', caseId: 'case_1', agentId: 'agent_1', requestedAction: 'case.note',
    actionPayload: {}, signedGrant, signingKey: 'existing-test-key', now: new Date(nowMs).toISOString() };
  const binding = evaluatePolicy({ ...input, permissionGranted: true, humanDecisionRequired: true });
  assert.equal(binding.decision, 'needsHuman');
  assert.equal(binding.signedPolicy.digest, signed.digest);
  assert.equal(Date.parse(binding.expiresAt), document.expiresAtMs);
  assert.equal(verifyDecisionRecord(binding, { signingKey: input.signingKey }), true);
  assert.equal(verifyDecisionRecord({ ...binding, signedPolicy: { ...binding.signedPolicy, version: 2 } }, { signingKey: input.signingKey }), false);
  assert.equal(evaluatePolicy({ ...input, permissionGranted: false }).decision, 'deny');
});
