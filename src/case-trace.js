import crypto from 'node:crypto';
import path from 'node:path';
import { canonicalValue, valueDigest } from './policy-engine.js';

const tracedTypes = new Set([
  'case.marked_sensitive', 'case.signed_policy_updated', 'policy.evaluated', 'policy.re_evaluated',
  'case.action_recorded', 'case.human_decision_requested', 'case.human_decision_resolved',
  'group.approval_requested', 'group.approval_recorded',
  'asset.granted', 'asset.scan_clean', 'message.private_screened', 'payment.confirmed'
]);
const publicFields = [
  'actor', 'agentId', 'actorAgentId', 'recipientAgentId', 'requestedAction', 'actionKey',
  'policyEvaluationId', 'policyExecutionId', 'digest', 'version', 'grantId', 'reasonCode',
  'decision', 'outcome', 'requestId', 'actionId', 'assetId', 'createdByAgentId', 'messageId',
  'receiptDigest', 'txRef', 'payee', 'amount', 'network'
];
const root = 'case-trace';
export const traceQueue = path.join(root, 'queue');
export const traceQueuePath = id => path.join(traceQueue, `${id}.json`);
export const traceSealPath = id => path.join(root, 'seals', `${id}.json`);
export const traceCasePath = (inboxId, caseId) => path.join('inboxes', inboxId, 'case-trace', caseId);

export function createTraceSigner(encodedKey) {
  if (!encodedKey) return null;
  let key;
  try {
    key = crypto.createPrivateKey({ key: Buffer.from(encodedKey, 'base64'), format: 'der', type: 'pkcs8' });
    if (key.asymmetricKeyType !== 'ed25519') throw new Error();
  } catch {
    throw new Error('ENVOI_CASE_TRACE_SIGNING_KEY must contain a base64-encoded Ed25519 PKCS#8 key.');
  }
  const publicKey = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
  const keyId = crypto.createHash('sha256').update(publicKey).digest('hex');
  return { keyId, publicKey: publicKey.toString('base64'), sign: digest => crypto.sign(null, Buffer.from(digest, 'hex'), key).toString('hex') };
}

// Run under the inbox mutation lock so audit, trace, and queue records commit together.
export async function captureCaseTrace(store, signer, inboxId, event, sensitive) {
  if (!signer || !tracedTypes.has(event.type)) return null;
  const directory = traceCasePath(inboxId, event.caseId);
  const tipPath = path.join(directory, 'tip.json');
  const tip = await store.getJson(tipPath);
  const details = Object.fromEntries(publicFields.filter(field => Object.hasOwn(event, field)).map(field => [field, event[field]]));
  const record = {
    schema: 'envoi.case-trace/v1', inboxId, caseId: event.caseId, id: event.id,
    index: (tip?.index ?? 0) + 1, previous: tip?.digest ?? null,
    type: event.type, at: event.createdAt, sensitive, details, keyId: signer.keyId,
    sourceDigest: valueDigest([crypto.randomBytes(32).toString('hex'), canonicalValue(event)])
  };
  const digest = valueDigest(record);
  const envelope = { record, digest, publicKey: signer.publicKey, signature: signer.sign(digest) };
  const documents = [
    { path: path.join(directory, 'steps', `${record.id}.json`), value: {
      ...envelope, id: record.id, sequence: String(record.index).padStart(16, '0')
    } },
    { path: tipPath, value: { index: record.index, digest } }
  ];
  if (sensitive) documents.push({ path: traceQueuePath(record.id), value: { id: record.id, digest, createdAt: record.at } });
  await store.putJsonBatch(documents);
  return envelope;
}

export function isTracedCaseEvent(event) {
  return typeof event.caseId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(event.caseId) && tracedTypes.has(event.type);
}
