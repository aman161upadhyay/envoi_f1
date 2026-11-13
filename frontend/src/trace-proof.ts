// In-browser check of one signed case-trace record, the same way the server made it:
// digest = SHA-256 of the canonical JSON of the record, signature = Ed25519 over the 32 raw digest bytes.

export interface ProofStep {
  record: Record<string, any> & { previous?: string | null };
  digest: string;
  publicKey: string;
  signature: string;
}

export type ProofStatus = 'genuine' | 'changed' | 'badSignature' | 'brokenChain' | 'unsupported';
export interface ProofVerdict { status: ProofStatus; message: string }

export const PROOF_MESSAGES: Record<ProofStatus, string> = {
  genuine: 'This record is genuine and unchanged.',
  changed: 'This record was changed after it was recorded.',
  badSignature: "The signature doesn't match.",
  brokenChain: "This record doesn't follow the one before it.",
  unsupported: "This browser can't check Ed25519 signatures."
};

const verdict = (status: ProofStatus): ProofVerdict => ({ status, message: PROOF_MESSAGES[status] });

export function canonicalJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, entry]) => [key, sort(entry)]));
    }
    return item;
  };
  return JSON.stringify(sort(value));
}

const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], byte => parseInt(byte, 16));
const toHex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
const fromBase64 = (text: string) => Uint8Array.from(atob(text), char => char.charCodeAt(0));

export async function digestRecord(record: unknown): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(record))));
}

export async function verifyTraceStep(step: ProofStep, previous?: ProofStep | null): Promise<ProofVerdict> {
  if (!globalThis.crypto?.subtle) return verdict('unsupported');
  let key: CryptoKey;
  try { key = await crypto.subtle.importKey('spki', fromBase64(step.publicKey), { name: 'Ed25519' }, false, ['verify']); }
  catch { return verdict('unsupported'); }
  if (await digestRecord(step.record) !== step.digest) return verdict('changed');
  let valid = false;
  try { valid = await crypto.subtle.verify({ name: 'Ed25519' }, key, fromHex(step.signature), fromHex(step.digest)); }
  catch { valid = false; }
  if (!valid) return verdict('badSignature');
  if (previous && step.record.previous !== previous.digest) return verdict('brokenChain');
  return verdict('genuine');
}

/** A copy of the step with one character of its most meaningful field changed. The digest and signature are left as recorded. */
export function editedCopy(step: ProofStep): ProofStep {
  const record = structuredClone(step.record);
  const bump = (text: string) => text.length ? `${text.slice(0, -1)}${text.endsWith('1') ? '2' : '1'}` : '1';
  const details = record.details as Record<string, any> | undefined;
  if (typeof details?.amount?.units === 'string' && details.amount.units) details.amount.units = bump(details.amount.units);
  else if (typeof details?.outcome === 'string' && details.outcome) details.outcome = bump(details.outcome);
  else record.type = bump(String(record.type ?? ''));
  return { ...step, record };
}
