import { canonical, hashDetails, hashJson, verify } from '../core/crypto.mjs';
import { displayPermission, validAccount } from '../core/policy.mjs';
import { verifyPath } from '../core/tree.mjs';
import { verifyPasskeySignature } from '../core/webauthn.mjs';
import { messageFor, VERDICT_MESSAGES } from './messages.mjs';

// An outage is "not checked", never a failure and never a pass. Only errors explicitly marked
// as unavailability (see adapters/near/rpc.mjs) qualify; every other error still fails the check.
const isUnavailable = error => error?.code === 'NEAR_UNAVAILABLE';

const looksLikeProof = proof => Boolean(proof && typeof proof === 'object' && !Array.isArray(proof) &&
  proof.format === 'envoi.proof/v1' && proof.record && typeof proof.record === 'object' &&
  typeof proof.recordHash === 'string' && proof.envoi && proof.permission && proof.batch && proof.seal);

export async function checkProof(proof, trust = {}) {
  if (!looksLikeProof(proof)) {
    const checks = [{ id: 'format', status: 'FAIL' }];
    return { checks: checks.map(row => ({ ...row, message: messageFor(row) })), verdict: 'failed', reason: 'bad_file',
      message: VERDICT_MESSAGES.bad_file };
  }
  const checks = [];
  const check = async (id, verifyCheck) => {
    let row;
    try {
      const result = await verifyCheck();
      row = result === undefined ? { id, status: 'SKIP', reason: 'not_configured' } : { id, status: result ? 'PASS' : 'FAIL' };
    } catch (error) {
      row = isUnavailable(error) ? { id, status: 'SKIP', reason: 'unavailable' } : { id, status: 'FAIL' };
    }
    checks.push({ ...row, message: messageFor(row) });
  };
  const { record, envoi, permission, batch, seal, chainEvent } = proof ?? {};
  // envoi's key is trusted from a key map the checker was given, otherwise from the record
  // contract's evidence key list: listed no later than the record and not revoked before it.
  await check('envoi_signature', async () => {
    const pinned = trust.evidenceKeys?.[envoi.keyId];
    if (pinned !== undefined) return pinned === envoi.publicKey && await verify(pinned, envoi.signature, proof.recordHash);
    if (!trust.evidenceRegistry) return false;
    if (envoi.registry && (envoi.registry.network !== trust.evidenceRegistry.network || envoi.registry.contract !== trust.recordContract)) return false;
    const listed = await trust.evidenceRegistry.lookup(envoi.keyId);
    return Boolean(listed && listed.publicKey === envoi.publicKey && Number.isSafeInteger(record.createdAtMs) &&
      listed.registeredAtMs <= record.createdAtMs && (listed.revokedAtMs === undefined || listed.revokedAtMs > record.createdAtMs)) &&
      await verify(listed.publicKey, envoi.signature, proof.recordHash);
  });
  await check('content', async () => {
    if (proof.format !== 'envoi.proof/v1' || record.schema !== 'envoi.evidence/v1' || await hashJson(record) !== proof.recordHash) return false;
    if (Object.hasOwn(proof, 'details') !== Object.hasOwn(proof, 'detailsSalt')) return false;
    if (Object.hasOwn(proof, 'details') && await hashDetails(proof.detailsSalt, proof.details) !== record.detailsHash) return false;
    if (!record.chainRef) return !chainEvent;
    return Boolean(chainEvent && chainEvent.network === record.chainRef.network && chainEvent.txRef === record.chainRef.txRef);
  });
  // `keyType` is 'demo_device' (Ed25519, the default for older proofs) or 'passkey' (WebAuthn).
  const keyType = permission.keyType ?? 'demo_device';
  await check('owner_signature', async () => {
    const { document, ownerKey, signature } = permission;
    const hash = await hashJson(document);
    if (document.schema !== 'envoi.permissions/v1' || document.agent !== record.agent || !validAccount(document.owner) ||
        !(document.issuedAtMs <= record.createdAtMs) || hash !== record.permissionHash) return false;
    if (keyType === 'demo_device') return verify(ownerKey, signature, hash);
    if (keyType === 'passkey') {
      return verifyPasskeySignature({ publicKey: ownerKey, hash, signature, rpId: permission.rpId, allowedOrigins: trust.passkeyOrigins });
    }
    return false;
  });
  const registry = trust.ownerRegistry;
  await check('registry', async () => {
    if (!registry) return undefined;
    if (permission.registry.network !== registry.network || permission.registry.contract !== trust.recordContract) return false;
    const key = await registry.lookup(permission.document.owner, permission.ownerKey);
    return Boolean(key && key.type === keyType && key.registeredAtMs <= permission.document.issuedAtMs &&
      (key.revokedAtMs === undefined || key.revokedAtMs > permission.document.issuedAtMs));
  });
  await check('display', () => canonical(permission.document.display) === canonical(displayPermission(permission.document)));
  await check('chain_policy', async () => {
    if (!trust.spendGuard) return undefined;
    if (chainEvent) {
      const outcome = await trust.spendGuard.readOutcome(chainEvent.txRef, record.agent);
      return outcome?.policyHash === record.permissionHash;
    }
    const policy = await trust.spendGuard.getPolicy(record.agent);
    return policy?.policyHash === record.permissionHash;
  });
  if (record?.chainRef || chainEvent) {
    await check('chain_event', async () => {
      const guard = trust.spendGuard;
      if (!guard) return undefined;
      if (chainEvent.network !== guard.network || chainEvent.contract !== trust.spendContract) return false;
      const outcome = await guard.readOutcome(chainEvent.txRef, record.agent);
      const status = { pay_refused: 'refused', paid: 'paid' }[record.type];
      return Boolean(outcome && status && outcome.status === status && outcome.agent === record.agent &&
        outcome.caseRef === record.caseRef && outcome.txRef === chainEvent.txRef &&
        (!proof.details || ['to', 'amount', 'reason'].every(key => proof.details[key] === outcome[key])));
    });
  }
  await check('batch_path', () => verifyPath(proof.recordHash, batch));
  await check('sealed', async () => {
    if (!trust.publicRecord) return undefined;
    if (seal.network !== trust.publicRecord.network || seal.contract !== trust.recordContract) return false;
    const anchored = await trust.publicRecord.readRoot(batch.batchId);
    return Boolean(anchored && anchored.root === batch.root && anchored.previousRoot === batch.previousRoot &&
      anchored.count === batch.count && (trust.publicRecord.verifySeal
        ? await trust.publicRecord.verifySeal(seal.txRef, batch)
        : anchored.txRef === seal.txRef && await trust.publicRecord.status(seal.txRef) === 'final'));
  });
  await check('locked_record', async () => {
    if (!trust.publicRecord || trust.publicRecord.network === 'local') return undefined;
    const contract = await trust.publicRecord.describeContract();
    return contract.address === trust.recordContract && contract.locked && contract.codeHash === trust.recordCodeHash;
  });
  if (record?.type?.startsWith('screen_')) {
    await check('private_check', async () => {
      if (!proof.privateCheck || await hashJson(proof.privateCheck) !== record.privateCheckHash) return false;
      return trust.verifyScreen ? trust.verifyScreen(proof.privateCheck) : undefined;
    });
  }
  const verdict = checks.some(row => row.status === 'FAIL') ? 'failed' :
    checks.some(row => row.status === 'SKIP') ? 'partial' : 'verified';
  const unreachable = verdict === 'partial' && checks.some(row => row.reason === 'unavailable');
  return { checks, verdict, ...(unreachable ? { reason: 'unavailable' } : {}),
    message: VERDICT_MESSAGES[unreachable ? 'unavailable' : verdict] };
}
