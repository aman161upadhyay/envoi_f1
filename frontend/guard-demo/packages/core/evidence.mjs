import { hashDetails, hashJson, publicHex, randomSalt, sign } from './crypto.mjs';

export async function makeEvidence({ seq, type, agent, counterparty, caseRef, summary, chainRef = null,
  previousHash, details, permissionHash, privateCheck, createdAtMs }, keys) {
  const detailsSalt = randomSalt();
  const record = {
    schema: 'envoi.evidence/v1',
    id: crypto.randomUUID(),
    seq, type, agent, counterparty, caseRef, summary,
    detailsHash: await hashDetails(detailsSalt, details),
    chainRef, permissionHash, createdAtMs,
    ...(privateCheck ? { privateCheckHash: await hashJson(privateCheck) } : {}),
    salt: randomSalt(),
    previousHash
  };
  const recordHash = await hashJson(record);
  return {
    record, recordHash, details, detailsSalt,
    ...(privateCheck ? { privateCheck } : {}),
    envoi: {
      keyId: 'ev-1',
      publicKey: await publicHex(keys.publicKey),
      signature: await sign(keys.privateKey, recordHash)
    }
  };
}
