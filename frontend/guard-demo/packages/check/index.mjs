import { canonical, hashDetails, hashJson, verify } from '../core/crypto.mjs';
import { displayPermission, validAccount } from '../core/policy.mjs';
import { verifyPath } from '../core/tree.mjs';

export async function checkProof(proof, trust = {}) {
  const checks = [];
  const check = async (id, verifyCheck) => {
    let status;
    try {
      const result = await verifyCheck();
      status = result === undefined ? 'SKIP' : result ? 'PASS' : 'FAIL';
    } catch {
      status = 'FAIL';
    }
    checks.push({ id, status });
  };
  const { record, envoi, permission, batch, seal, chainEvent } = proof ?? {};
  await check('envoi_signature', async () => {
    const key = trust.evidenceKeys?.[envoi.keyId];
    return key === envoi.publicKey && await verify(key, envoi.signature, proof.recordHash);
  });
  await check('content', async () => {
    if (proof.format !== 'envoi.proof/v1' || record.schema !== 'envoi.evidence/v1' || await hashJson(record) !== proof.recordHash) return false;
    if (Object.hasOwn(proof, 'details') !== Object.hasOwn(proof, 'detailsSalt')) return false;
    if (Object.hasOwn(proof, 'details') && await hashDetails(proof.detailsSalt, proof.details) !== record.detailsHash) return false;
    if (!record.chainRef) return !chainEvent;
    return Boolean(chainEvent && chainEvent.network === record.chainRef.network && chainEvent.txRef === record.chainRef.txRef);
  });
  await check('owner_signature', async () => {
    const { document, ownerKey, signature } = permission;
    const hash = await hashJson(document);
    return document.schema === 'envoi.permissions/v1' && document.agent === record.agent && validAccount(document.owner) &&
      document.issuedAtMs <= record.createdAtMs && hash === record.permissionHash && await verify(ownerKey, signature, hash);
  });
  const registry = trust.ownerRegistry;
  await check('registry', async () => {
    if (!registry) return undefined;
    if (permission.registry.network !== registry.network || permission.registry.contract !== trust.recordContract) return false;
    const key = await registry.lookup(permission.document.owner, permission.ownerKey);
    return Boolean(key && key.type === 'demo_device' && key.registeredAtMs <= permission.document.issuedAtMs &&
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
  return { checks, verdict: checks.some(row => row.status === 'FAIL') ? 'failed' :
    checks.some(row => row.status === 'SKIP') ? 'partial' : 'verified' };
}
