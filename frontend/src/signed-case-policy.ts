import { createPasskey, signWithPasskey, type OwnerPasskey, type PasskeyAssertion } from '../guard-demo/packages/core/passkey.mjs';
import { verifyPasskeySignature } from '../guard-demo/packages/core/webauthn.mjs';

export type OwnerSigningMethod = 'demo_device' | 'passkey';

export interface OwnerSigningContext {
  ownerAccount: string;
  recordContract: string;
  network: string;
  passkey?: { rpId: string; origins: string[] } | null;
}

export interface SignedCaseGrant {
  id: string;
  action: string;
  decision: 'allow' | 'needsHuman' | 'deny';
  target: Record<string, unknown>;
}

export interface SignedPolicyDocument {
  schema: 'envoi.case-policy/v1';
  workspaceId: string;
  ownerId: string;
  agentId: string;
  caseId: string;
  version: number;
  previousHash: string | null;
  issuedAtMs: number;
  expiresAtMs: number;
  grants: SignedCaseGrant[];
  display: string[];
}

export interface SignedPolicyDraft {
  workspaceId: string;
  caseId: string;
  ownerId: string;
  agentId: string;
  version: number;
  previousHash: string | null;
  active: SignedPolicyDocument | null;
  signing: OwnerSigningContext;
}

export interface SignedApprovalDraft {
  document: {
    schema: 'envoi.case-approval/v1';
    ownerId: string;
    caseId: string;
    evaluationId: string;
    action: string;
    target: Record<string, unknown>;
    policyVersion: number;
    expiresAtMs: number;
  };
  display?: string[];
  signing?: OwnerSigningContext;
}

export type OwnerDeviceSignature<Document> = { document: Document; publicKey: string } & (
  { keyType: 'demo_device'; signature: string } |
  { keyType: 'passkey'; signature: PasskeyAssertion }
);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function hex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function ownerDevice(ownerId: string, create = false): Promise<CryptoKeyPair> {
  if (!globalThis.crypto?.subtle || !globalThis.indexedDB) throw new Error('Device signing requires a secure browser session.');
  const generated = create ? await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']) as CryptoKeyPair : undefined;
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open('envoi-owner-device', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('keys');
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
    open.onblocked = () => reject(new Error('Close other Envoi tabs before setting up this device.'));
  });
  try {
    return await new Promise<CryptoKeyPair>((resolve, reject) => {
      const transaction = db.transaction('keys', create ? 'readwrite' : 'readonly');
      const store = transaction.objectStore('keys');
      const read = store.get(ownerId);
      let keys: CryptoKeyPair | undefined;
      read.onsuccess = () => {
        keys = read.result ?? generated;
        if (!read.result && generated) store.add(generated, ownerId);
      };
      transaction.oncomplete = () => keys ? resolve(keys) : reject(new Error('Set up and register a device key in Case permissions first.'));
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

export async function setupOwnerDevice(ownerId: string): Promise<string> {
  const keys = await ownerDevice(ownerId, true);
  return hex(await crypto.subtle.exportKey('raw', keys.publicKey));
}

export function supportsOwnerPasskey(context?: OwnerSigningContext): boolean {
  const config = context?.passkey;
  if (!config || !globalThis.isSecureContext || !globalThis.PublicKeyCredential ||
    !globalThis.navigator?.credentials || !config.origins.includes(location.origin)) return false;
  return location.hostname === config.rpId || location.hostname.endsWith(`.${config.rpId}`);
}

function passkeyStorageKey(ownerId: string, context: OwnerSigningContext, rpId: string): string {
  return 'envoi-case-passkey:' + JSON.stringify([location.origin, context.network, context.recordContract, context.ownerAccount, ownerId, rpId]);
}

export function readOwnerPasskey(ownerId: string, context?: OwnerSigningContext): OwnerPasskey | null {
  if (!context?.passkey || !supportsOwnerPasskey(context)) return null;
  try {
    const passkey = JSON.parse(localStorage.getItem(passkeyStorageKey(ownerId, context, context.passkey.rpId)) || 'null');
    return passkey?.rpId === context.passkey.rpId && /^[A-Za-z0-9_-]+$/.test(passkey.credentialId ?? '') &&
      /^04[0-9a-f]{128}$/.test(passkey.publicKey ?? '') ? passkey : null;
  } catch { return null; }
}

export function preferredOwnerSigningMethod(ownerId: string, context?: OwnerSigningContext): OwnerSigningMethod {
  return readOwnerPasskey(ownerId, context) ? 'passkey' : 'demo_device';
}

export async function setupOwnerPasskey(ownerId: string, context: OwnerSigningContext): Promise<string> {
  if (!context.passkey || !supportsOwnerPasskey(context)) throw new Error('Passkey setup requires a secure Envoi site configured for this passkey.');
  const stored = readOwnerPasskey(ownerId, context);
  if (stored) return stored.publicKey;
  const passkey = await createPasskey({ ownerAccount: context.ownerAccount, rpId: context.passkey.rpId, rpName: 'Envoi' });
  try { localStorage.setItem(passkeyStorageKey(ownerId, context, passkey.rpId), JSON.stringify(passkey)); }
  catch { throw new Error('This browser could not save the passkey reference. Enable site storage and try again.'); }
  return passkey.publicKey;
}

export async function signOwnerDocument<Document extends { ownerId: string }>(
  document: Document,
  method: OwnerSigningMethod = 'demo_device',
  context?: OwnerSigningContext
): Promise<OwnerDeviceSignature<Document>> {
  if (!globalThis.crypto?.subtle) throw new Error('Device signing requires a secure browser session.');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical(document))));
  if (method === 'passkey') {
    const passkey = readOwnerPasskey(document.ownerId, context);
    if (!passkey || !context?.passkey) throw new Error('Create and register a passkey in Case permissions first.');
    const hash = hex(digest);
    const signature = await signWithPasskey({ credentialId: passkey.credentialId, rpId: passkey.rpId, hash });
    if (!await verifyPasskeySignature({ publicKey: passkey.publicKey, rpId: passkey.rpId, signature, hash,
      allowedOrigins: [location.origin] })) throw new Error('The passkey signature could not be verified.');
    return { document, keyType: 'passkey', publicKey: passkey.publicKey, signature };
  }
  const keys = await ownerDevice(document.ownerId);
  return {
    document,
    keyType: 'demo_device',
    publicKey: hex(await crypto.subtle.exportKey('raw', keys.publicKey)),
    signature: hex(await crypto.subtle.sign('Ed25519', keys.privateKey, digest))
  };
}
