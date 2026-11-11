import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { valueDigest } from '../src/policy-engine.js';
import { verifyPath } from '../frontend/guard-demo/packages/core/tree.mjs';
import { nearReaders } from '../frontend/guard-demo/adapters/near/read.mjs';

async function verify() {
  const [, , file] = process.argv;
  const trustedKey = process.env.ENVOI_CASE_TRACE_PUBLIC_KEY;
  if (!file || !trustedKey) throw new Error('Pass a case record file and configure its trusted Ed25519 public key.');
  const { record, digest, signature, seal } = JSON.parse(await readFile(file, 'utf8'));
  const bytes = Buffer.from(trustedKey, 'base64');
  const key = crypto.createPublicKey({ key: bytes, format: 'der', type: 'spki' });
  const keyId = crypto.createHash('sha256').update(bytes).digest('hex');
  if (key.asymmetricKeyType !== 'ed25519' || record?.schema !== 'envoi.case-trace/v1' || record.keyId !== keyId
    || valueDigest(record) !== digest || !/^[0-9a-f]{128}$/.test(signature)
    || !crypto.verify(null, Buffer.from(digest, 'hex'), key, Buffer.from(signature, 'hex'))) {
    throw new Error('The case trace signature did not verify.');
  }
  if (!seal) {
    console.log(record.sensitive ? 'Signed case trace verified. Seal pending.' : 'Signed off-chain case trace verified.');
    return record.sensitive ? 2 : 0;
  }
  if (!record.sensitive || seal.status !== 'final' || !await verifyPath(digest, seal)) throw new Error('The trace inclusion proof did not verify.');
  const { NEAR_RECORD_CONTRACT, NEAR_RECORD_CODE_HASH, NEAR_PUBLISHER_ACCOUNT, NEAR_RPC_URL } = process.env;
  if (seal.network !== 'near-testnet' || !NEAR_RECORD_CONTRACT || !NEAR_RECORD_CODE_HASH || !NEAR_PUBLISHER_ACCOUNT) {
    console.log('Trace signature and inclusion verified. Public record was not checked.');
    return 2;
  }
  if (seal.recordContract !== NEAR_RECORD_CONTRACT || seal.publisher !== NEAR_PUBLISHER_ACCOUNT || seal.codeHash !== NEAR_RECORD_CODE_HASH) {
    throw new Error('The trace seal does not match the trusted deployment.');
  }
  const { publicRecord } = nearReaders({ rpcUrl: NEAR_RPC_URL, recordContract: NEAR_RECORD_CONTRACT, publisher: NEAR_PUBLISHER_ACCOUNT });
  const [contract, root, finalized] = await Promise.all([
    publicRecord.describeContract(), publicRecord.readRoot(seal.batchId), publicRecord.verifySeal(seal.txRef, seal)
  ]);
  if (!finalized || contract.codeHash !== NEAR_RECORD_CODE_HASH || root?.root !== seal.root ||
    root.previousRoot !== seal.previousRoot || root.count !== seal.count) throw new Error('The finalized public seal did not verify.');
  console.log(contract.locked ? 'Case trace and locked NEAR seal verified.' : 'Case trace and NEAR seal verified. The record account still has access keys.');
  return contract.locked ? 0 : 2;
}

try { process.exitCode = await verify(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
