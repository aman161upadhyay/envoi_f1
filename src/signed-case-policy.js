import crypto from 'node:crypto';
import { canonicalValue, valueDigest } from './policy-engine.js';

const identifier = /^[A-Za-z0-9._:-]{1,128}$/;
const hex32 = /^[0-9a-f]{64}$/;
const account = /^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const labels = { allow: 'Allowed', needsHuman: 'Ask first', deny: 'Off' };
const maxPolicyLifetimeMs = 30 * 24 * 60 * 60 * 1000;
const maxClockSkewMs = 60_000;

function invalid(message, code = 'SIGNED_POLICY_INVALID', statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

function keysAre(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function verifyTarget(value, depth = 0) {
  if (depth > 12) return false;
  if (typeof value === 'string') return value.length <= 16_384 && !/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value);
  if (value === null || typeof value === 'boolean' || Number.isSafeInteger(value)) return true;
  if (Array.isArray(value)) return value.length <= 100 && value.every(item => verifyTarget(item, depth + 1));
  return value && typeof value === 'object' && Object.keys(value).length <= 100
    && Object.entries(value).every(([key, item]) => identifier.test(key) && verifyTarget(item, depth + 1));
}

export function casePolicyDisplay(document) {
  const { workspaceId, caseId, ownerId, agentId, version, previousHash, issuedAtMs, expiresAtMs, grants } = document;
  if (![workspaceId, caseId, ownerId, agentId].every(id => typeof id === 'string' && identifier.test(id))
    || !Number.isSafeInteger(version) || version < 1 || !(previousHash === null || typeof previousHash === 'string' && hex32.test(previousHash))
    || !Number.isSafeInteger(issuedAtMs) || issuedAtMs <= 0 || !Number.isSafeInteger(expiresAtMs)
    || expiresAtMs <= issuedAtMs || expiresAtMs > issuedAtMs + maxPolicyLifetimeMs || expiresAtMs > 8.64e15
    || !Array.isArray(grants) || grants.length > 100) throw invalid('Invalid signed case policy.');
  const ids = new Set();
  const targets = new Set();
  const lines = [
    `Owner ${ownerId} grants agent ${agentId} access in workspace ${workspaceId}, case ${caseId}.`,
    `Policy version ${version} expires ${new Date(expiresAtMs).toISOString()}.`
  ];
  for (const grant of grants) {
    if (!keysAre(grant, ['id', 'action', 'decision', 'target']) || typeof grant.id !== 'string' || !identifier.test(grant.id)
      || typeof grant.action !== 'string' || !/^[a-z]+(?:[._][a-z0-9]+)+$/.test(grant.action) || grant.action.length > 100
      || typeof grant.decision !== 'string' || !Object.hasOwn(labels, grant.decision)
      || !grant.target || typeof grant.target !== 'object' || Array.isArray(grant.target)
      || !verifyTarget(grant.target)) throw invalid('Invalid signed case grant.');
    const target = JSON.stringify(canonicalValue(grant.target));
    const match = JSON.stringify([grant.action, target]);
    if (ids.has(grant.id) || targets.has(match)) throw invalid('Duplicate signed case grant.');
    ids.add(grant.id);
    targets.add(match);
    lines.push(`${labels[grant.decision]} · ${grant.action} · ${target}`);
  }
  return [...lines, 'All other actions are off.'];
}

export function requireCasePolicyDocument(document, context, nowMs) {
  if (!keysAre(document, ['schema', 'workspaceId', 'caseId', 'ownerId', 'agentId', 'version', 'previousHash', 'issuedAtMs', 'expiresAtMs', 'grants', 'display'])
    || document.schema !== 'envoi.case-policy/v1') throw invalid('Invalid signed case policy document.');
  for (const field of ['workspaceId', 'caseId', 'ownerId', 'agentId']) {
    if (document[field] !== context[field]) throw invalid('Signed policy does not belong to this owner, agent and case.', 'SIGNED_POLICY_SCOPE_MISMATCH', 403);
  }
  if (document.issuedAtMs > nowMs + maxClockSkewMs || document.expiresAtMs <= nowMs) {
    throw invalid('The signed policy is outside its valid time window.', 'SIGNED_POLICY_EXPIRED', 403);
  }
  if (JSON.stringify(document.display) !== JSON.stringify(casePolicyDisplay(document))) {
    throw invalid('The signed display does not match the policy grants.');
  }
}

export function evaluateSignedCaseGrant(verified, requestedAction, actionPayload = {}) {
  if (!verified) return null;
  const { document, digest } = verified;
  const actual = valueDigest(actionPayload);
  const grant = document.grants.find(entry => entry.action === requestedAction && valueDigest(entry.target) === actual);
  return {
    decision: grant?.decision ?? 'deny',
    reasonCode: ({ allow: 'ownerSignedGrant', needsHuman: 'ownerSignedApprovalRequired', deny: 'ownerSignedGrantDenied' })[grant?.decision] || 'ownerSignedGrantMissing',
    grantId: grant?.id ?? null, digest, version: document.version, expiresAt: new Date(document.expiresAtMs).toISOString()
  };
}

export function signedApprovalDocument(binding, ownerId) {
  return {
    schema: 'envoi.case-approval/v1', workspaceId: binding.workspaceId, caseId: binding.caseId, ownerId, agentId: binding.agentId,
    evaluationId: binding.id, action: binding.requestedAction, target: binding.actionPayload,
    recordDigest: binding.recordDigest, policyDigest: binding.signedPolicy.digest,
    policyVersion: binding.signedPolicy.version, issuedAtMs: Date.parse(binding.effectiveAt), expiresAtMs: Date.parse(binding.expiresAt)
  };
}

export async function requireOwnerSignature(envelope, { ownerAccount, registry, nowMs, rpId, allowedOrigins }) {
  const { document, keyType, publicKey, signature } = envelope || {};
  const validKey = typeof publicKey === 'string' && (
    keyType === 'demo_device' && hex32.test(publicKey) || keyType === 'passkey' && /^04[0-9a-f]{128}$/.test(publicKey));
  if (!document || !validKey || !ownerAccount || !Number.isSafeInteger(document.issuedAtMs)
    || !Number.isSafeInteger(document.expiresAtMs) || document.issuedAtMs > nowMs + maxClockSkewMs || document.expiresAtMs <= nowMs) {
    throw invalid('A current owner-device signature is required.', 'OWNER_SIGNATURE_REQUIRED', 403);
  }
  const digest = valueDigest(document);
  let verified = false;
  try {
    if (keyType === 'demo_device' && typeof signature === 'string' && /^[0-9a-f]{128}$/.test(signature)) {
      const key = crypto.createPublicKey({
        key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKey, 'hex').toString('base64url') }, format: 'jwk'
      });
      verified = crypto.verify(null, Buffer.from(digest, 'hex'), key, Buffer.from(signature, 'hex'));
    } else if (keyType === 'passkey' && rpId && Array.isArray(allowedOrigins) && allowedOrigins.length) {
      const { verifyPasskeySignature } = await import('../frontend/guard-demo/packages/core/webauthn.mjs');
      verified = await verifyPasskeySignature({ publicKey, hash: digest, signature, rpId, allowedOrigins });
    }
  } catch { /* Treat malformed assertions as invalid. */ }
  if (!verified) throw invalid('The owner-device signature could not be verified.', 'OWNER_SIGNATURE_INVALID', 403);
  const key = await registry(ownerAccount, publicKey, keyType);
  if (!key || !Number.isSafeInteger(key.registered_at_ms) || key.registered_at_ms > Math.min(document.issuedAtMs, nowMs)
    || key.revoked_at_ms !== null) throw invalid('The signing key is not currently registered to this owner.', 'OWNER_KEY_UNAVAILABLE', 403);
  return digest;
}

export function createSignedPolicyRegistry({ rpcUrl, recordContract, fetcher = fetch }) {
  return async (owner, publicKey, keyType) => {
    if (![owner, recordContract].every(value => typeof value === 'string' && account.test(value)) || !rpcUrl) {
      throw invalid('The owner key registry is unavailable.', 'OWNER_REGISTRY_UNAVAILABLE', 503);
    }
    try {
      const response = await fetcher(rpcUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(3000),
        body: JSON.stringify({ jsonrpc: '2.0', id: 'envoi-owner-keys', method: 'query', params: {
          request_type: 'call_function', finality: 'final', account_id: recordContract, method_name: 'owner_keys',
          args_base64: Buffer.from(JSON.stringify({ owner })).toString('base64')
        } })
      });
      if (!response.ok) throw new Error('Registry request failed');
      const { id, result } = await response.json();
      if (id !== 'envoi-owner-keys' || !Array.isArray(result?.result)) throw new Error('Registry response is invalid');
      const keys = JSON.parse(Buffer.from(result.result).toString('utf8'));
      if (!Array.isArray(keys)) throw new Error('Registry response is invalid');
      return keys.find(key => key?.public_key === publicKey && key.key_type === keyType) || null;
    } catch {
      throw invalid('The owner key registry is unavailable.', 'OWNER_REGISTRY_UNAVAILABLE', 503);
    }
  };
}
