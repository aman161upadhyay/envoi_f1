import { afterEach, expect, test, vi } from 'vitest';
import { requireOwnerSignature } from '../../src/signed-case-policy.js';
import { rawToDer, toBase64Url } from '../guard-demo/packages/core/webauthn.mjs';
import {
  preferredOwnerSigningMethod, readOwnerPasskey, setupOwnerPasskey, signOwnerDocument,
  type OwnerSigningContext
} from '../src/signed-case-policy';

const origin = 'https://envoi.test';
const rpId = 'envoi.test';
const signing: OwnerSigningContext = {
  ownerAccount: 'owner.testnet', recordContract: 'record.testnet', network: 'near-testnet',
  passkey: { rpId, origins: [origin] }
};

afterEach(() => vi.unstubAllGlobals());

async function installAuthenticator() {
  const bytes = new Map<string, string>();
  const encoder = new TextEncoder();
  const rawId = Uint8Array.of(7, 4, 1);
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const publicKey = await crypto.subtle.exportKey('spki', keys.publicKey);
  const rpHash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(rpId)));
  let userVerified = true;
  vi.stubGlobal('location', new URL(origin));
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('PublicKeyCredential', class {});
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => bytes.get(key) ?? null,
    setItem: (key: string, value: string) => { bytes.set(key, value); }
  });
  const create = vi.fn(async ({ publicKey: options }: CredentialCreationOptions) => {
    expect(options?.rp.id).toBe(rpId);
    expect(new TextDecoder().decode(options?.user.id as Uint8Array)).toBe(signing.ownerAccount);
    expect(options?.authenticatorSelection?.userVerification).toBe('required');
    return { rawId, response: { getPublicKey: () => publicKey, getPublicKeyAlgorithm: () => -7 } };
  });
  const get = vi.fn(async ({ publicKey: options }: CredentialRequestOptions) => {
    expect(options?.rpId).toBe(rpId);
    expect(options?.allowCredentials?.[0]?.id).toEqual(rawId);
    expect(options?.userVerification).toBe('required');
    const clientDataJSON = encoder.encode(JSON.stringify({
      type: 'webauthn.get', challenge: toBase64Url(options?.challenge as Uint8Array), origin
    }));
    const authenticatorData = new Uint8Array(37);
    authenticatorData.set(rpHash);
    authenticatorData[32] = userVerified ? 5 : 1;
    const clientHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataJSON));
    const payload = new Uint8Array(authenticatorData.length + clientHash.length);
    payload.set(authenticatorData);
    payload.set(clientHash, authenticatorData.length);
    const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, payload));
    return { response: { authenticatorData, clientDataJSON, signature: rawToDer(signature) } };
  });
  vi.stubGlobal('navigator', { credentials: { create, get } });
  return { create, get, clearVerification: () => { userVerified = false; } };
}

test('the browser passkey produces policy and approval signatures accepted by the server verifier', async () => {
  const authenticator = await installAuthenticator();
  const ownerId = 'owner-1';
  const nowMs = Date.now();
  expect(preferredOwnerSigningMethod(ownerId, signing)).toBe('demo_device');
  const publicKey = await setupOwnerPasskey(ownerId, signing);
  expect(publicKey).toMatch(/^04[0-9a-f]{128}$/);
  expect(await setupOwnerPasskey(ownerId, signing)).toBe(publicKey);
  expect(authenticator.create).toHaveBeenCalledTimes(1);
  expect(preferredOwnerSigningMethod(ownerId, signing)).toBe('passkey');
  const registry = vi.fn(async (owner, key, kind) => owner === signing.ownerAccount && key === publicKey && kind === 'passkey'
    ? { registered_at_ms: nowMs - 1, revoked_at_ms: null } : null);
  const server = { ownerAccount: signing.ownerAccount, registry, nowMs, rpId, allowedOrigins: [origin] };
  for (const schema of ['envoi.case-policy/v1', 'envoi.case-approval/v1']) {
    const document = { schema, ownerId, issuedAtMs: nowMs, expiresAtMs: nowMs + 10_000, target: { amount: '17', note: 'case' } };
    const envelope = await signOwnerDocument(document, 'passkey', signing);
    expect(envelope).toMatchObject({ keyType: 'passkey', publicKey, document });
    await expect(requireOwnerSignature(envelope, server)).resolves.toMatch(/^[0-9a-f]{64}$/);
    await expect(requireOwnerSignature({ ...envelope, document: { ...document, target: { amount: '18' } } }, server))
      .rejects.toMatchObject({ code: 'OWNER_SIGNATURE_INVALID' });
  }
  expect(authenticator.get).toHaveBeenCalledTimes(2);
  expect(registry).toHaveBeenCalledTimes(2);
});

test('passkeys stay scoped to the owner, configured registry and allowed origin', async () => {
  const authenticator = await installAuthenticator();
  const nowMs = Date.now();
  const document = { ownerId: 'owner-1', issuedAtMs: nowMs, expiresAtMs: nowMs + 10_000 };
  await setupOwnerPasskey(document.ownerId, signing);
  expect(readOwnerPasskey('owner-2', signing)).toBeNull();
  expect(readOwnerPasskey(document.ownerId, { ...signing, ownerAccount: 'other.testnet' })).toBeNull();
  expect(readOwnerPasskey(document.ownerId, { ...signing, recordContract: 'other.testnet' })).toBeNull();
  const otherOrigin = { ...signing, passkey: { rpId, origins: ['https://other.envoi.test'] } };
  await expect(signOwnerDocument(document, 'passkey', otherOrigin)).rejects.toThrow('Create and register');
  expect(authenticator.get).not.toHaveBeenCalled();
  authenticator.clearVerification();
  await expect(signOwnerDocument(document, 'passkey', signing)).rejects.toThrow('could not be verified');
});
