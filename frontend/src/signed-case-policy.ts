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
  signing: { ownerAccount: string; recordContract: string; network: string };
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
}

export interface OwnerDeviceSignature<Document> {
  document: Document;
  keyType: 'demo_device';
  publicKey: string;
  signature: string;
}

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

export async function signOwnerDocument<Document extends { ownerId: string }>(
  document: Document
): Promise<OwnerDeviceSignature<Document>> {
  const keys = await ownerDevice(document.ownerId);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical(document))));
  return {
    document,
    keyType: 'demo_device',
    publicKey: hex(await crypto.subtle.exportKey('raw', keys.publicKey)),
    signature: hex(await crypto.subtle.sign('Ed25519', keys.privateKey, digest))
  };
}
