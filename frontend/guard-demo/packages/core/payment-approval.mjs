import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';

export function paymentApprover(encodedKey) {
  const key = createPrivateKey({ key: Buffer.from(encodedKey, 'base64'), format: 'der', type: 'pkcs8' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Payment approvals require an Ed25519 signing key.');
  const publicKey = Buffer.from(createPublicKey(key).export({ format: 'jwk' }).x, 'base64url').toString('hex');
  return {
    publicKey,
    approve({ contract, owner, agent, to, amount, caseRef, policyHash, policyVersion, expiresAtMs }) {
      if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0 ||
          !Number.isSafeInteger(policyVersion) || policyVersion < 1 || policyVersion > 0xffffffff) {
        throw new Error('Payment approval requires an expiry and a valid NEAR policy version.');
      }
      // This tuple and its order match approval_digest in the spending contract.
      const message = JSON.stringify(['envoi.near.payment/v1', contract, owner, agent, to, amount,
        caseRef, policyHash, policyVersion, expiresAtMs]);
      const digest = createHash('sha256').update(message).digest();
      return { expires_at_ms: expiresAtMs, signature: sign(null, digest, key).toString('hex') };
    }
  };
}
