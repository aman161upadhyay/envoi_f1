import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';

const digest = fields => createHash('sha256').update(JSON.stringify(fields)).digest();

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
      const message = digest(['envoi.near.payment/v1', contract, owner, agent, to, amount,
        caseRef, policyHash, policyVersion, expiresAtMs]);
      return { expires_at_ms: expiresAtMs, signature: sign(null, message, key).toString('hex') };
    },
    cancel({ contract, owner, agent, references }) {
      const message = digest(['envoi.near.payment.cancel/v1', contract, owner, agent, references]);
      return sign(null, message, key).toString('hex');
    }
  };
}
