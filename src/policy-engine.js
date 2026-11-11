import crypto from 'node:crypto';

export const POLICY_ENGINE_SCHEMA_VERSION = '1.1';

const SAFE_INTERNAL_ACTIONS = new Set([
  'case.classify',
  'case.progress',
  'case.note',
  'case.complete',
  'proposal.create',
  'proposal.counter',
  'proposal.accept',
  'message.draft',
  // provider-gateway-native v1: a reply in the already claimed canonical case.
  'message.reply'
]);
const POLICY_ACTION = /^(calendar\.|email\.|payment\.|contract\.|asset\.share(?:\.|$)|external\.)/;
const SIGNED_INTERNAL_ACTIONS = new Set(['case.appendEvent', 'asset.read', 'asset.upload', 'asset.edit']);

export const canonicalValue = value => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalValue(value[key])]));
  return value;
};

export const valueDigest = value => crypto.createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex');

export function classifyAction(action) {
  const normalized = String(action || '').trim();
  if (SAFE_INTERNAL_ACTIONS.has(normalized)) return 'safeInternal';
  if (POLICY_ACTION.test(normalized)) return 'policy';
  return 'unknown';
}

export const requiresPolicyEvaluation = action => classifyAction(action) !== 'safeInternal';

const isoInstant = value => {
  if (value == null || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const strictInteger = (value, name, { minimum, maximum } = {}) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || (minimum !== undefined && number < minimum) || (maximum !== undefined && number > maximum)) {
    throw new TypeError(`${name} is invalid`);
  }
  return number;
};

const normalizedCounterparty = value => {
  if (typeof value === 'string') return value.trim().toLowerCase();
  if (!value || typeof value !== 'object') return '';
  const type = String(value.type || 'party').trim().toLowerCase();
  const identifier = String(value.email || value.address || value.agentId || value.id || '').trim().toLowerCase();
  return identifier ? `${type}:${identifier}` : '';
};

function exactNearAmount(source) {
  const { units, unit, network } = source;
  if (typeof units !== 'string' || !/^[1-9][0-9]{0,38}$/.test(units) || BigInt(units) >= 2n ** 128n
    || unit !== 'yoctoNEAR' || !['near-mainnet', 'near-testnet'].includes(network)) return null;
  return { units, unit, network };
}

export function actionBinding(actionPayload = {}, executeAtToleranceSeconds = 60, { exactNear = false } = {}) {
  const payload = actionPayload && typeof actionPayload === 'object' && !Array.isArray(actionPayload) ? canonicalValue(actionPayload) : {};
  const nearPayee = exactNear && typeof payload.payee === 'string' && /^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(payload.payee)
    ? payload.payee : null;
  const counterparties = [...new Set([
    ...(Array.isArray(payload.counterparties) ? payload.counterparties : []),
    payload.counterparty,
    payload.recipientEmail,
    payload.recipientAgentId,
    nearPayee
  ].filter(Boolean).map(normalizedCounterparty).filter(Boolean))].sort();
  const amountSource = payload.amount && typeof payload.amount === 'object' ? payload.amount : payload;
  const minorUnits = amountSource.minorUnits ?? amountSource.amountMinor ?? null;
  const currency = amountSource.currency == null ? null : String(amountSource.currency).trim().toUpperCase();
  const amount = exactNear ? nearPayee && exactNearAmount(amountSource)
    : minorUnits == null && currency == null ? null : { minorUnits: Number(minorUnits), currency };
  const exactAt = isoInstant(payload.executeAt);
  const explicitNotBefore = isoInstant(payload.executeNotBefore || payload.notBefore);
  const explicitNotAfter = isoInstant(payload.executeNotAfter || payload.notAfter || payload.start);
  const executionWindowValid = !(
    (payload.executeAt != null && !exactAt)
    || ((payload.executeNotBefore != null || payload.notBefore != null) && !explicitNotBefore)
    || ((payload.executeNotAfter != null || payload.notAfter != null || payload.start != null) && !explicitNotAfter)
  );
  const toleranceMs = strictInteger(executeAtToleranceSeconds, 'executeAtToleranceSeconds', { minimum: 0, maximum: 3600 }) * 1000;
  const executionWindow = {
    exactAt,
    toleranceSeconds: executeAtToleranceSeconds,
    notBefore: exactAt ? new Date(new Date(exactAt).getTime() - toleranceMs).toISOString() : explicitNotBefore,
    notAfter: exactAt ? new Date(new Date(exactAt).getTime() + toleranceMs).toISOString() : explicitNotAfter
  };
  return {
    actionPayload: payload,
    actionPayloadDigest: valueDigest(payload),
    counterparties,
    counterpartyDigest: valueDigest(counterparties),
    amount,
    amountDigest: valueDigest(amount),
    executionWindow,
    executionWindowDigest: valueDigest(executionWindow),
    executionWindowValid
  };
}

export function createWorkspacePolicy(input = {}) {
  const policy = {
    schemaVersion: POLICY_ENGINE_SCHEMA_VERSION,
    id: String(input.id || 'sinaloa-default-authority'),
    version: String(input.version || '').trim(),
    decisionTtlSeconds: strictInteger(input.decisionTtlSeconds ?? 600, 'decisionTtlSeconds', { minimum: 30, maximum: 3600 }),
    executeAtToleranceSeconds: strictInteger(input.executeAtToleranceSeconds ?? 60, 'executeAtToleranceSeconds', { minimum: 0, maximum: 3600 }),
    maxPaymentMinorWithoutHuman: strictInteger(input.maxPaymentMinorWithoutHuman ?? 0, 'maxPaymentMinorWithoutHuman', { minimum: 0 }),
    consequentialActionsEnabled: input.consequentialActionsEnabled === true,
    externalEmailEnabled: input.externalEmailEnabled === true,
    calendarWritesEnabled: input.calendarWritesEnabled === true
  };
  if (input.agreements) policy.agreements = { requireHumanApproval: input.agreements.requireHumanApproval !== false };
  if (!policy.id || !/^[A-Za-z0-9._:-]{1,128}$/.test(policy.id)) throw new TypeError('policy id is invalid');
  if (!policy.version || !/^[A-Za-z0-9._:-]{1,64}$/.test(policy.version)) throw new TypeError('policy version is invalid');
  return Object.freeze({ ...policy, digest: valueDigest(policy) });
}

function normalizeKeyring({ signingKey = null, keyring = null } = {}) {
  if (keyring) {
    const activeKeyId = String(keyring.activeKeyId || '');
    const keys = keyring.keys && typeof keyring.keys === 'object' ? keyring.keys : {};
    if (!activeKeyId || typeof keys[activeKeyId] !== 'string' || keys[activeKeyId].length < 32) throw new TypeError('Active policy signing key is invalid');
    return { activeKeyId, keys };
  }
  if (signingKey) return { activeKeyId: 'legacy', keys: { legacy: signingKey } };
  return null;
}

function integrityDigest(value, key) {
  return key ? crypto.createHmac('sha256', key).update(JSON.stringify(canonicalValue(value))).digest('hex') : valueDigest(value);
}

const earliestInstant = (...values) => values.map(isoInstant).filter(Boolean).sort()[0] || null;
const denied = reasonCode => ({ decision: 'deny', reasonCode });

export function evaluatePolicy({
  id, workspaceId, caseId, agentId, requestedAction, actionPayload = {}, permissionGranted,
  caseDeadline = null, requestedExpiresAt = null, contactApproved = null,
  calendarConnectorAvailable = null, outsideWorkingHours = false, proposalDigest = null,
  allowedOptionIds = [], policy = createWorkspacePolicy({ version: '2026-09-27' }),
  previousRecordDigest = null, phase = 'evaluation', executionId = null, sourceEvaluationId = null, grantType = 'oneTime',
  signingKey = null, keyring = null, humanDecisionRequired = null, signedGrant = null, now = new Date().toISOString()
}) {
  const issuedAt = isoInstant(now);
  if (!issuedAt) throw new Error('A valid policy evaluation time is required');
  const action = String(requestedAction || '').trim();
  if (!action) throw new Error('A requested action is required');
  const actionClass = signedGrant && SIGNED_INTERNAL_ACTIONS.has(action) ? 'safeInternal' : classifyAction(action);
  const exactNear = action === 'payment.near' && Boolean(signedGrant);
  const binding = actionBinding(actionPayload, policy.executeAtToleranceSeconds, { exactNear });
  const deadline = isoInstant(caseDeadline);
  const requestedExpiry = isoInstant(requestedExpiresAt);
  const maximumExpiry = new Date(new Date(issuedAt).getTime() + (humanDecisionRequired === true ? 86400 : policy.decisionTtlSeconds) * 1000).toISOString();
  const expiresAt = earliestInstant(requestedExpiry, maximumExpiry, deadline, binding.executionWindow.notAfter, signedGrant?.expiresAt) || maximumExpiry;
  let result = permissionGranted ? { decision: 'allow', reasonCode: 'withinServerPolicy' } : denied('missingPermission');

  if (actionClass === 'unknown') result = denied('unsupportedAction');
  else if (requestedExpiresAt && !requestedExpiry) result = denied('invalidEvaluationExpiry');
  else if (!binding.executionWindowValid) result = denied('invalidExecutionWindow');
  else if (new Date(expiresAt) <= new Date(issuedAt)) result = denied('authorityExpired');
  else if (deadline && new Date(deadline) <= new Date(issuedAt)) result = denied('caseDeadlineExpired');
  else if (binding.executionWindow.notBefore && binding.executionWindow.notAfter && binding.executionWindow.notBefore > binding.executionWindow.notAfter) result = denied('invalidExecutionWindow');
  else if (binding.executionWindow.notBefore && new Date(binding.executionWindow.notBefore) > new Date(expiresAt)) result = denied('executionOutsideAuthorityWindow');
  else if (/^(payment\.|contract\.|asset\.share|external\.)/.test(action) && !policy.consequentialActionsEnabled) result = denied('consequentialActionsDisabled');
  else if (/^email\./.test(action) && !policy.externalEmailEnabled) result = denied('externalEmailDisabled');
  else if (/^calendar\./.test(action) && !policy.calendarWritesEnabled) result = denied('calendarWritesDisabled');
  else if (/^email\./.test(action) && contactApproved !== true) result = denied('externalContactNotApproved');
  else if (/^calendar\./.test(action) && calendarConnectorAvailable !== true) result = permissionGranted ? { decision: 'needsHuman', reasonCode: 'calendarConnectorUnavailable' } : result;
  else if (/^calendar\./.test(action) && outsideWorkingHours) result = permissionGranted ? { decision: 'needsHuman', reasonCode: 'outsideWorkingHours' } : result;
  else if (/^(email\.|payment\.|contract\.|asset\.share|external\.)/.test(action) && !binding.counterparties.length) result = denied('counterpartyRequired');
  else if (exactNear && !binding.amount) result = denied('validPaymentAmountRequired');
  else if (exactNear && permissionGranted) result = { decision: 'needsHuman', reasonCode: 'paymentExceedsAutomaticLimit' };
  else if (!exactNear && /^payment\./.test(action) && (!binding.amount || !Number.isSafeInteger(binding.amount.minorUnits) || binding.amount.minorUnits <= 0 || !/^[A-Z]{3}$/.test(binding.amount.currency || ''))) result = denied('validPaymentAmountRequired');
  else if (!exactNear && /^payment\./.test(action) && binding.amount.minorUnits > policy.maxPaymentMinorWithoutHuman) result = permissionGranted ? { decision: 'needsHuman', reasonCode: 'paymentExceedsAutomaticLimit' } : result;
  else if (/^(contract\.|asset\.share|external\.)/.test(action)) result = permissionGranted ? { decision: 'needsHuman', reasonCode: 'consequentialExternalCommitment' } : result;
  if (permissionGranted && result.decision !== 'deny' && humanDecisionRequired === true) result = { decision: 'needsHuman', reasonCode: 'agreementNeedsHumanDecision' };
  if (result.decision !== 'deny' && signedGrant?.decision === 'deny') result = denied(signedGrant.reasonCode);
  if (result.decision === 'allow' && signedGrant) result = { decision: signedGrant.decision, reasonCode: signedGrant.reasonCode };

  const keys = normalizeKeyring({ signingKey, keyring });
  const unsigned = {
    schemaVersion: POLICY_ENGINE_SCHEMA_VERSION,
    id, phase, executionId, sourceEvaluationId, grantType, workspaceId, caseId, agentId, requestedAction: action, actionClass,
    policy: { id: policy.id, version: policy.version, digest: policy.digest },
    ...(signedGrant ? { signedPolicy: { digest: signedGrant.digest, version: signedGrant.version, grantId: signedGrant.grantId } } : {}),
    decision: result.decision, reasonCode: result.reasonCode, reasons: [result.reasonCode],
    ...binding, proposalDigest, allowedOptionIds: [...new Set(allowedOptionIds)].sort(),
    effectiveAt: issuedAt, expiresAt, previousRecordDigest,
    integrityAlgorithm: keys ? 'hmac-sha256' : 'sha256',
    integrityKeyId: keys?.activeKeyId ?? null
  };
  const key = keys?.keys[keys.activeKeyId] ?? null;
  return Object.freeze({ ...unsigned, recordDigest: integrityDigest(unsigned, key) });
}

export function verifyDecisionRecord(record, options = {}) {
  if (!record || record.schemaVersion !== POLICY_ENGINE_SCHEMA_VERSION || !record.recordDigest) return false;
  const { recordDigest, ...unsigned } = record;
  const keys = normalizeKeyring(options);
  if ((options.requireSigned === true || keys) && record.integrityAlgorithm !== 'hmac-sha256') return false;
  let key = null;
  if (record.integrityAlgorithm === 'hmac-sha256') {
    key = keys?.keys?.[record.integrityKeyId];
    if (!key) return false;
  } else if (record.integrityAlgorithm !== 'sha256') return false;
  const expected = integrityDigest(unsigned, key);
  const actualBytes = Buffer.from(recordDigest);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && crypto.timingSafeEqual(actualBytes, expectedBytes);
}

export function verifyDecisionChain(records, options = {}) {
  if (!records.length) return true;
  const byDigest = new Map();
  const children = new Map();
  for (const record of records) {
    if (!verifyDecisionRecord(record, options) || byDigest.has(record.recordDigest)) return false;
    byDigest.set(record.recordDigest, record);
    const parent = record.previousRecordDigest ?? null;
    const siblings = children.get(parent) || [];
    siblings.push(record);
    children.set(parent, siblings);
  }
  if ((children.get(null) || []).length !== 1) return false;
  for (const [parent, linked] of children) {
    if (parent !== null && !byDigest.has(parent)) return false;
    if (linked.length !== 1) return false;
  }
  let current = children.get(null)[0];
  let visited = 0;
  while (current) {
    visited += 1;
    current = (children.get(current.recordDigest) || [])[0] || null;
  }
  return visited === records.length;
}

export function assertExactBinding(record, { requestedAction, actionPayload = {}, proposalDigest = null, optionId = null, signingKey = null, keyring = null, at = new Date().toISOString() }) {
  if (!verifyDecisionRecord(record, { signingKey, keyring, requireSigned: Boolean(keyring || signingKey) })) throw Object.assign(new Error('Policy decision record failed integrity verification'), { statusCode: 409 });
  if (record.requestedAction !== requestedAction) throw Object.assign(new Error('Policy decision does not authorize this action'), { statusCode: 403 });
  const current = actionBinding(actionPayload, record.executionWindow?.toleranceSeconds ?? 60, {
    exactNear: record.requestedAction === 'payment.near' && Boolean(record.signedPolicy)
  });
  for (const field of ['actionPayloadDigest', 'counterpartyDigest', 'amountDigest', 'executionWindowDigest']) {
    if (record[field] !== current[field]) throw Object.assign(new Error('Action authority binding changed after policy evaluation'), { statusCode: 409 });
  }
  if (proposalDigest !== null && record.proposalDigest !== proposalDigest) throw Object.assign(new Error('Proposal changed after policy evaluation'), { statusCode: 409 });
  if (optionId && !record.allowedOptionIds.includes(optionId)) throw Object.assign(new Error('Policy decision does not authorize this proposal option'), { statusCode: 403 });
  const executionTime = new Date(at);
  if (Number.isNaN(executionTime.getTime())) throw Object.assign(new Error('Execution time is invalid'), { statusCode: 409 });
  if (new Date(record.expiresAt) <= executionTime) throw Object.assign(new Error('Policy decision expired before execution'), { statusCode: 409 });
  if (record.executionWindow.notBefore && new Date(record.executionWindow.notBefore) > executionTime) throw Object.assign(new Error('Action is earlier than its authorized execution window'), { statusCode: 409 });
  if (record.executionWindow.notAfter && new Date(record.executionWindow.notAfter) < executionTime) throw Object.assign(new Error('Action is later than its authorized execution window'), { statusCode: 409 });
  return current;
}
