import { canonical, hashJson, verify } from '../packages/core/crypto.mjs';
import { verifyPasskeySignature } from '../packages/core/webauthn.mjs';
import { displayPermission } from '../packages/core/policy.mjs';

export function passkeyOrigins(env = process.env) {
  const values = (env.NEAR_PASSKEY_ORIGINS || 'http://localhost:4173').split(',').map(value => value.trim());
  for (const value of values) {
    const url = new URL(value);
    if (url.origin !== value || !(url.protocol === 'https:' || url.protocol === 'http:' && url.hostname === 'localhost')) {
      throw new Error('Configure exact HTTPS or localhost passkey origins.');
    }
  }
  return values;
}

export async function validatePermissionFile(signed, { owner, agent, registry, policy, allowedOrigins }) {
  const { document, publicKey, signature } = signed;
  const keyType = signed.keyType ?? 'demo_device';
  const hash = await hashJson(document);
  if (document.schema !== 'envoi.permissions/v1' || document.owner !== owner || document.agent !== agent ||
      !Number.isSafeInteger(document.issuedAtMs) || document.issuedAtMs < 0 || document.issuedAtMs > Date.now() ||
      canonical(displayPermission(document)) !== canonical(document.display)) throw new Error('Invalid signed permission document.');
  let valid = false;
  if (keyType === 'demo_device') valid = await verify(publicKey, signature, hash);
  else if (keyType === 'passkey') {
    if (!Array.isArray(allowedOrigins) || !allowedOrigins.length) throw new Error('Configure trusted passkey origins.');
    valid = await verifyPasskeySignature({ publicKey, signature, hash, rpId: signed.rpId, allowedOrigins });
  }
  if (!valid) throw new Error('The owner permission signature did not verify.');
  if (!registry || registry.type !== keyType || registry.registeredAtMs > document.issuedAtMs ||
      registry.revokedAtMs !== undefined && registry.revokedAtMs <= document.issuedAtMs) {
    throw new Error('The owner signing key was not active when the permission was signed.');
  }
  const expected = document.rules.spend_money;
  const payees = entries => entries.map(entry => [entry.account, entry.maxPerPayment]).sort(([a], [b]) => a.localeCompare(b));
  if (!policy || policy.policyHash !== hash || policy.version !== document.version || policy.paused ||
      policy.dailyCap !== expected.dailyCap || canonical(payees(policy.payees)) !== canonical(payees(expected.payees))) {
    throw new Error('The spending contract does not match the signed permission.');
  }
  return { hash, permission: {
    document, ownerKey: publicKey, signature, keyType,
    ...(keyType === 'passkey' ? { rpId: signed.rpId } : {})
  } };
}
