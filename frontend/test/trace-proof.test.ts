import { describe, expect, it } from 'vitest';
import { canonicalJson, digestRecord, editedCopy, verifyTraceStep, type ProofStep } from '../src/trace-proof';
import { buildAcmeTrace } from '../src/preview-acme';

const toHex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');

async function signed(record: Record<string, unknown>, pair: CryptoKeyPair): Promise<ProofStep> {
  const digest = await digestRecord(record);
  const raw = Uint8Array.from(digest.match(/../g)!, byte => parseInt(byte, 16));
  const signature = toHex(await crypto.subtle.sign('Ed25519', pair.privateKey, raw));
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  return { record, digest, signature, publicKey: btoa(String.fromCharCode(...spki)) };
}

describe('trace proof', () => {
  it('sorts keys recursively like the server', () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: [{ y: 1, x: 2 }] } })).toBe('{"a":{"c":[{"x":2,"y":1}],"d":1},"b":1}');
  });

  it('passes a genuine record, fails a one-character edit, and fails a broken chain', async () => {
    const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
    const first = await signed({ id: 'a', index: 1, previous: null, type: 'policy.evaluated', details: { outcome: 'allowed' } }, pair);
    const second = await signed({ id: 'b', index: 2, previous: first.digest, type: 'payment.confirmed', details: { outcome: 'confirmed', amount: { units: '500' } } }, pair);
    expect((await verifyTraceStep(second, first)).status).toBe('genuine');

    const edited = editedCopy(second);
    expect(edited.record).not.toEqual(second.record);
    expect((await verifyTraceStep(edited, first)).status).toBe('changed');

    const unrelated = await signed({ id: 'c', index: 3, previous: 'f'.repeat(64), type: 'x', details: {} }, pair);
    expect((await verifyTraceStep(unrelated, first)).status).toBe('brokenChain');
  });

  it('fails when the signature does not match the digest', async () => {
    const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
    const step = await signed({ id: 'a', index: 1, previous: null, type: 't', details: {} }, pair);
    const other = await signed({ id: 'z', index: 1, previous: null, type: 't', details: {} }, pair);
    expect((await verifyTraceStep({ ...step, signature: other.signature })).status).toBe('badSignature');
  });

  it('verifies the Acme replay trace and chains it', async () => {
    const trace = await buildAcmeTrace();
    const oldestFirst = [...trace.steps].reverse();
    for (const [index, step] of oldestFirst.entries()) {
      expect((await verifyTraceStep(step, oldestFirst[index - 1])).status).toBe('genuine');
      expect((await verifyTraceStep(editedCopy(step), oldestFirst[index - 1])).status).toBe('changed');
    }
  });
});

describe('seal labels', () => {
  const base = { record: { id: 'a', type: 't', at: '2026-11-12T14:00:00.000Z', sensitive: true, details: {} } };
  it('says Sealed on NEAR only for a final seal on a near network', async () => {
    const { sealStatus, traceSource } = await import('../src/CaseTracePanel');
    expect(sealStatus({ ...base, seal: { status: 'final', network: 'near-testnet', txRef: 'abc' } })).toEqual({ text: 'Sealed on NEAR', href: 'https://testnet.nearblocks.io/txns/abc' });
    expect(sealStatus({ ...base, seal: { status: 'final', network: 'offline-replay', txRef: null } })).toEqual({ text: 'Sealed locally' });
    expect(sealStatus({ ...base, seal: null })).toEqual({ text: 'Awaiting seal' });
    expect(traceSource({ ...base, seal: { status: 'final', network: 'offline-replay', txRef: null } })).toBe('Offline replay');
    expect(traceSource({ ...base, seal: { status: 'final', network: 'near-testnet', txRef: 'abc' } })).toBe('NEAR testnet');
    expect(traceSource({ ...base, seal: null })).toBe('Signed by Envoi');
  });
});
