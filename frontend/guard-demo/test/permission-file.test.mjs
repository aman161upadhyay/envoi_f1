import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePermissionFile, passkeyOrigins } from '../scripts/permission-file.mjs';
import { hashJson, publicHex, sign, fromHex, hex } from '../packages/core/crypto.mjs';
import { rawToDer, toBase64Url } from '../packages/core/webauthn.mjs';
import { displayPermission } from '../packages/core/policy.mjs';

async function fixture(passkey) {
  const document = {
    schema: 'envoi.permissions/v1', owner: 'owner.testnet', agent: 'milo.testnet', version: 2,
    issuedAtMs: 1000, previousHash: '0'.repeat(64),
    rules: {
      spend_money: { payees: [{ account: 'ledger.testnet', label: 'Ledger Co', maxPerPayment: '1' }], dailyCap: '2', unit: 'yoctoNEAR' },
      share_files: { default: 'off', allow: [] }, send_messages: 'allowed'
    }
  };
  document.display = displayPermission(document);
  const hash = await hashJson(document);
  let signed;
  if (passkey) {
    const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const publicKey = hex(await crypto.subtle.exportKey('raw', keys.publicKey));
    const client = new TextEncoder().encode(JSON.stringify({
      type: 'webauthn.get', challenge: toBase64Url(fromHex(hash, 32)), origin: 'http://localhost:4173'
    }));
    const auth = new Uint8Array(37);
    auth.set(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('localhost'))));
    auth[32] = 5;
    const data = new Uint8Array(69);
    data.set(auth);
    data.set(new Uint8Array(await crypto.subtle.digest('SHA-256', client)), 37);
    const signature = rawToDer(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, data)));
    signed = { document, keyType: 'passkey', rpId: 'localhost', publicKey, signature: {
      authenticatorData: toBase64Url(auth), clientDataJSON: toBase64Url(client), signature: toBase64Url(signature)
    } };
  } else {
    const keys = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
    signed = { document, publicKey: await publicHex(keys.publicKey), signature: await sign(keys.privateKey, hash) };
  }
  const options = {
    owner: document.owner, agent: document.agent, allowedOrigins: passkeyOrigins({}),
    registry: { type: passkey ? 'passkey' : 'demo_device', registeredAtMs: 500 },
    policy: { ...document.rules.spend_money, policyHash: hash, version: 2, paused: false }
  };
  return { signed, options };
}

test('runner accepts old demo-device files and exports passkey metadata for the checker', async () => {
  for (const passkey of [false, true]) {
    const { signed, options } = await fixture(passkey);
    const result = await validatePermissionFile(signed, options);
    assert.equal(result.permission.keyType, passkey ? 'passkey' : 'demo_device');
    assert.equal(result.permission.ownerKey, signed.publicKey);
    assert.deepEqual(result.permission.signature, signed.signature);
    assert.equal(result.permission.rpId, passkey ? 'localhost' : undefined);
  }
});

test('runner rejects wrong origins, changed limits, unavailable registration and revoked signers', async () => {
  const { signed, options } = await fixture(true);
  await assert.rejects(validatePermissionFile(signed, { ...options, allowedOrigins: ['https://other.example'] }), /signature/);
  await assert.rejects(validatePermissionFile(signed, { ...options, registry: null }), /not active/);
  await assert.rejects(validatePermissionFile(signed, {
    ...options, registry: { ...options.registry, revokedAtMs: 900 }
  }), /not active/);
  await assert.rejects(validatePermissionFile(signed, { ...options, policy: { ...options.policy, dailyCap: '3' } }), /does not match/);
  const edited = structuredClone(signed);
  edited.document.display[0] += ' edited';
  await assert.rejects(validatePermissionFile(edited, options), /Invalid signed/);
  await assert.rejects(validatePermissionFile({ ...signed, keyType: 'unknown' }, options), /signature/);
  assert.throws(() => passkeyOrigins({ NEAR_PASSKEY_ORIGINS: 'http://example.com' }), /exact HTTPS/);
});
