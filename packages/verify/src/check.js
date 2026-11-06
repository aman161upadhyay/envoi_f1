// The proof checker. Pure function of (proof, readers). Every message here is UI copy from
// the feature spec, so /verify and the CLI say exactly the same thing.
import { hexToBytes } from './bytes.js';
import { canonicalHash, detailsHash, keyFingerprint, recordHash } from './hash.js';
import { verifyInclusion } from './merkle.js';
import { verifyEd25519 } from './signatures.js';
import { verifyPermissionAssertion } from './webauthn.js';

export const MESSAGES = Object.freeze({
  envoi_signature: { ok: 'Recorded by envoi', fail: "This record wasn't signed by envoi, or it was edited." },
  owner_signature: { ok: name => `Permission signed by ${name} with a passkey`, demo: name => `Permission signed by ${name} with a demo device`, fail: "The permission wasn't signed by the person named." },
  owner_key_listed: { ok: name => `${name}'s device was listed on the public record before they signed`, fail: "The device that signed wasn't listed when this permission was signed." },
  unchanged: { ok: 'Nothing has changed since it was recorded', fail: 'This record was changed after it was recorded.' },
  in_batch: { ok: 'Part of a sealed batch', fail: "This record isn't part of the sealed batch it claims." },
  on_chain: { ok: 'On the public record', fail: "We couldn't find this record on the public record.", pending: 'Not on the public record yet.' },
  private_check: { ok: 'Private check signed by a verified sealed machine', fail: "The private check on this record can't be confirmed.", mock: 'Simulated check' },
  unreachable: "Couldn't reach the public record. Try again later.",
  bad_file: "This isn't an envoi proof file.",
  verdict: {
    genuine: 'This record is genuine and unchanged.',
    untrusted: "This record can't be trusted.",
    incomplete: 'Not fully checked yet.',
    pending: 'Signed by envoi and the owner, waiting to be sealed.',
    bad_file: "This isn't an envoi proof file.",
  },
});

// Device clocks and block times differ slightly; a key listed up to 2 minutes after the
// browser's issuedAt still counts as "listed before signing".
export const KEY_LISTING_SKEW_MS = 120_000;

const nsToDate = ns => new Date(Number(BigInt(ns) / 1_000_000n));

const registryOf = proof => proof.registry ?? (proof.seals?.[0] ? { network: proof.seals[0].network, contractId: proof.seals[0].contractId } : null);

const tryRead = async fn => {
  try { return { value: await fn() }; } catch (error) { return { error }; }
};

const looksLikeProof = p => p && typeof p === 'object' && p.format === 'envoi.proof/v1'
  && p.record && typeof p.recordHash === 'string' && p.envoiSignature && p.batch && Array.isArray(p.seals);

export const checkProof = async (proof, { readers = {} } = {}) => {
  if (!looksLikeProof(proof)) {
    return { verdict: 'bad_file', message: MESSAGES.verdict.bad_file, checks: [{ code: 'format', status: 'fail', message: MESSAGES.bad_file }] };
  }
  const checks = [];
  const add = (code, status, message, extra = {}) => checks.push({ code, status, message, ...extra });
  const registry = registryOf(proof);
  const registryReader = registry ? readers[registry.network] : null;
  const pv = proof.permissionVersion ?? null;
  const ownerName = pv?.ownerName || 'the owner';

  // 1. envoi signature, by a key listed on NEAR.
  {
    const { keyId, publicKey, signature } = proof.envoiSignature;
    let validSig = false;
    try { validSig = await verifyEd25519(publicKey, hexToBytes(proof.recordHash), signature); } catch { validSig = false; }
    if (!validSig) add('envoi_signature', 'fail', MESSAGES.envoi_signature.fail);
    else if (!registryReader) add('envoi_signature', 'warn', MESSAGES.unreachable);
    else {
      const read = await tryRead(() => registryReader.keysOf(registry.contractId, 'envoi'));
      if (read.error) add('envoi_signature', 'warn', MESSAGES.unreachable);
      else {
        const fingerprint = await keyFingerprint(publicKey);
        const listed = (read.value ?? []).some(k => k.kind === 'envoi' && k.key_id === keyId && k.fingerprint === fingerprint);
        add('envoi_signature', listed ? 'ok' : 'fail', listed ? MESSAGES.envoi_signature.ok : MESSAGES.envoi_signature.fail);
      }
    }
  }

  // 2. owner signature over the rule in force, and 3. that device was listed in time.
  if (pv) {
    const result = await verifyPermissionAssertion({
      documentHash: pv.documentHash, rpId: pv.rpId, rpOrigin: pv.rpOrigin, ownerPublicKey: pv.ownerPublicKey, assertion: pv.assertion,
    }).catch(() => ({ ok: false }));
    const demo = pv.method === 'demo_device';
    add('owner_signature', result.ok ? 'ok' : 'fail',
      result.ok ? (demo ? MESSAGES.owner_signature.demo(ownerName) : MESSAGES.owner_signature.ok(ownerName)) : MESSAGES.owner_signature.fail,
      result.ok ? { userVerified: result.userVerified, method: pv.method } : {});

    if (!registryReader) add('owner_key_listed', 'warn', MESSAGES.unreachable);
    else {
      const read = await tryRead(() => registryReader.keysOf(registry.contractId, pv.ownerRef));
      if (read.error) add('owner_key_listed', 'warn', MESSAGES.unreachable);
      else {
        const fingerprint = await keyFingerprint(pv.ownerPublicKey);
        const wantKind = demo ? 'owner_demo' : 'owner';
        const entry = (read.value ?? []).find(k => k.fingerprint === fingerprint && k.kind === wantKind);
        const issuedAt = Date.parse(pv.document?.issuedAt);
        const inTime = entry && Number.isFinite(issuedAt) && nsToDate(entry.block_ts).getTime() <= issuedAt + KEY_LISTING_SKEW_MS;
        add('owner_key_listed', inTime ? 'ok' : 'fail', inTime ? MESSAGES.owner_key_listed.ok(ownerName) : MESSAGES.owner_key_listed.fail,
          inTime ? { listedAt: nsToDate(entry.block_ts).toISOString() } : {});
      }
    }
  }

  // 4. unchanged: record hash, details, private check and rule binding all recompute.
  {
    const r = proof.record;
    let ok = true;
    try {
      if ((await recordHash(r)) !== proof.recordHash) ok = false;
      if (ok && proof.details != null) {
        if (!proof.detailsSalt || (await detailsHash(proof.detailsSalt, proof.details)) !== r.detailsHash) ok = false;
      }
      if (ok && proof.privateCheck != null && (await canonicalHash(proof.privateCheck)) !== r.privateCheckHash) ok = false;
      if (ok && pv) {
        if ((await canonicalHash(pv.document)) !== pv.documentHash) ok = false;
        if (r.ruleVersionHash !== pv.documentHash) ok = false;
      }
    } catch { ok = false; }
    add('unchanged', ok ? 'ok' : 'fail', ok ? MESSAGES.unchanged.ok : MESSAGES.unchanged.fail);
  }

  // 5. inclusion in the batch.
  {
    const b = proof.batch;
    const result = await verifyInclusion({ recordHash: proof.recordHash, leafIndex: b.leafIndex, count: b.count, siblings: b.siblings, root: b.root })
      .catch(() => ({ ok: false }));
    add('in_batch', result.ok ? 'ok' : 'fail', result.ok ? MESSAGES.in_batch.ok : MESSAGES.in_batch.fail);
  }

  // 6. the root is on NEAR at that batch ID (each network the proof names).
  if (proof.seals.length === 0) add('on_chain', 'pending', MESSAGES.on_chain.pending);
  for (const seal of proof.seals) {
    const reader = readers[seal.network];
    if (!reader) { add('on_chain', 'warn', MESSAGES.unreachable, { network: seal.network }); continue; }
    const read = await tryRead(() => reader.rootOf(seal.contractId, seal.batchId));
    if (read.error) { add('on_chain', 'warn', MESSAGES.unreachable, { network: seal.network }); continue; }
    const onChain = read.value;
    const matches = onChain && onChain.root === proof.batch.root
      && (onChain.previous_root ?? null) === (proof.batch.previousRoot ?? null)
      && Number(onChain.count) === proof.batch.count;
    if (!matches) add('on_chain', 'fail', MESSAGES.on_chain.fail, { network: seal.network });
    else {
      const sealedAt = nsToDate(onChain.block_ts).toISOString();
      add('on_chain', 'ok', `${MESSAGES.on_chain.ok} since ${sealedAt}`, { network: seal.network, sealedAt, explorerUrl: seal.explorerUrl ?? null });
    }
  }

  // 7. private check signature (optional section).
  if (proof.privateCheck) {
    const pc = proof.privateCheck;
    if (pc.mock) add('private_check', 'note', MESSAGES.private_check.mock);
    else {
      const bound = typeof pc.signedText === 'string' && pc.signedText.includes(pc.requestHash) && pc.signedText.includes(pc.responseHash)
        && (pc.signatureKind !== 'provider_tee' || pc.signedText.startsWith(`${pc.model}:`));
      let recovered = null;
      let loadFailed = false;
      try {
        const { verifyMessage } = await import('ethers');
        recovered = verifyMessage(pc.signedText, pc.signature);
      } catch (error) {
        loadFailed = error?.code === 'ERR_MODULE_NOT_FOUND';
      }
      if (loadFailed) add('private_check', 'warn', MESSAGES.unreachable);
      else {
        const ok = bound && recovered && recovered.toLowerCase() === String(pc.signingAddress).toLowerCase();
        add('private_check', ok ? 'ok' : 'fail', ok ? MESSAGES.private_check.ok : MESSAGES.private_check.fail);
      }
    }
  }

  const has = status => checks.some(c => c.status === status);
  const verdict = has('fail') ? 'untrusted' : has('warn') ? 'incomplete' : has('pending') ? 'pending' : 'genuine';
  return { verdict, message: MESSAGES.verdict[verdict], checks };
};
