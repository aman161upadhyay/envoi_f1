import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const schema = JSON.parse(readFileSync(new URL('./agent-interface.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
const validateCaseSchema = ajv.compile(schema);
const validateActionSchema = ajv.compile({ $ref: `${schema.$id}#/definitions/Action` });

export const CASE_STATES = Object.freeze(schema.definitions.caseState.enum);
export const COLLABORATION_MODES = Object.freeze(schema.definitions.collaborationMode.enum);
export const EVENT_TYPES = Object.freeze(schema.definitions.Event.properties.type.enum);
export const HUMAN_ACTIONS = Object.freeze(['approveOnce', 'decline', 'editProposal', 'pause', 'resume', 'revoke', 'takeOver']);

const normalTransitions = {
  new: ['classifying', 'inProgress'],
  classifying: ['inProgress', 'waitingForHuman'],
  inProgress: ['waitingForExternalParty', 'waitingForHuman', 'tentativeHold', 'authorized', 'executing', 'completed'],
  waitingForExternalParty: ['inProgress', 'tentativeHold', 'received'],
  waitingForHuman: ['inProgress', 'authorized'],
  tentativeHold: ['waitingForHuman', 'authorized', 'expired'],
  authorized: ['executing', 'completed'],
  executing: ['sent'],
  sent: ['received'],
  received: ['accepted'],
  accepted: ['completed']
};
const exceptionStates = new Set(['failed', 'unknownExternalResult', 'expired', 'paused', 'revoked', 'disputed']);
const terminalStates = new Set(['completed', 'failed', 'unknownExternalResult', 'expired', 'revoked']);

export const isActiveCase = value => Boolean(value?.schemaVersion && CASE_STATES.includes(value.state) && !terminalStates.has(value.state));

const domainError = (message, statusCode = 400, details) => Object.assign(new Error(message), { statusCode, details });
const clone = value => structuredClone(value);

export function assertValidCase(value) {
  if (!validateCaseSchema(value)) throw domainError('Case does not satisfy the Agent Interface schema', 422, validateCaseSchema.errors);
  return value;
}

export function assertValidAction(value) {
  if (!validateActionSchema(value)) throw domainError('Action does not satisfy the Agent Interface schema', 422, validateActionSchema.errors);
  return value;
}

export function createCase({ id, objective, collaborationMode = 'collaboration', principal, actingAgent, participants = [], constraints = {}, deadline = null, createdAt }) {
  const value = {
    id,
    schemaVersion: '1.0',
    objective: String(objective || '').trim(),
    collaborationMode,
    state: 'new',
    principal,
    actingAgent,
    participants: [...new Set([actingAgent, ...participants].filter(Boolean))],
    constraints: constraints && typeof constraints === 'object' && !Array.isArray(constraints) ? constraints : {},
    deadline: deadline || null,
    authorityRefs: [],
    events: [],
    evidence: [],
    proposals: [],
    policyEvaluations: [],
    receipt: null,
    createdAt,
    updatedAt: createdAt
  };
  return assertValidCase(value);
}

export function canTransition(from, to) {
  if (from === to) return true;
  if (terminalStates.has(from)) return false;
  if (from === 'paused') return to !== 'paused' && !terminalStates.has(to) && CASE_STATES.includes(to);
  return Boolean(normalTransitions[from]?.includes(to) || exceptionStates.has(to));
}

export function transitionCase(caseInput, nextState, { actor, at, reasonCode = null } = {}) {
  if (!CASE_STATES.includes(nextState)) throw domainError(`Unknown case state: ${nextState}`);
  if (!canTransition(caseInput.state, nextState)) throw domainError(`Case cannot transition from ${caseInput.state} to ${nextState}`, 409);
  if (nextState === 'completed' && !caseInput.receipt) throw domainError('A durable receipt is required before a case can be completed', 409);
  const value = clone(caseInput);
  const previousState = value.state;
  value.state = nextState;
  value.updatedAt = at;
  if (previousState !== nextState) appendEvent(value, {
    id: `evt_${crypto.randomUUID()}`,
    type: 'stateChange',
    actor,
    createdAt: at,
    payload: { from: previousState, to: nextState, reasonCode },
    linkedPolicyEvaluation: null,
    precedingEventRef: value.events.at(-1)?.id || null
  });
  return assertValidCase(value);
}

export function appendEvent(caseInput, event) {
  if (!EVENT_TYPES.includes(event.type)) throw domainError(`Unknown event type: ${event.type}`);
  if (!event.id || !event.actor || !event.createdAt || !event.payload || typeof event.payload !== 'object') throw domainError('Event id, actor, createdAt, and structured payload are required');
  if (caseInput.events.some(item => item.id === event.id)) return caseInput;
  caseInput.events.push({
    ...event,
    linkedPolicyEvaluation: event.linkedPolicyEvaluation || null,
    precedingEventRef: event.precedingEventRef || caseInput.events.at(-1)?.id || null
  });
  caseInput.updatedAt = event.createdAt;
  return caseInput;
}

export function addPolicyEvaluation(caseInput, evaluation, { eventId, at } = {}) {
  const value = clone(caseInput);
  if (!value.policyEvaluations.some(item => item.id === evaluation.id)) value.policyEvaluations.push(evaluation);
  if (!value.authorityRefs.includes(evaluation.id)) value.authorityRefs.push(evaluation.id);
  appendEvent(value, {
    id: eventId || `evt_${crypto.randomUUID()}`,
    type: 'policyEvaluation',
    actor: evaluation.actor,
    createdAt: at || evaluation.effectiveAt,
    payload: { requestedAction: evaluation.requestedAction, decision: evaluation.decision, reasonCode: evaluation.reasonCode },
    linkedPolicyEvaluation: evaluation.id,
    precedingEventRef: value.events.at(-1)?.id || null
  });
  return assertValidCase(value);
}

export function addProposal(caseInput, proposal) {
  const value = clone(caseInput);
  if (value.proposals.some(item => item.id === proposal.id)) throw domainError('Proposal ID already exists', 409);
  value.proposals.push(proposal);
  value.updatedAt = proposal.updatedAt;
  return assertValidCase(value);
}

export function counterProposal(caseInput, proposalId, { options, at }) {
  const value = clone(caseInput);
  const proposal = value.proposals.find(item => item.id === proposalId);
  if (!proposal) throw domainError('Proposal not found', 404);
  if (!['open', 'countered'].includes(proposal.status)) throw domainError(`Proposal cannot be countered from ${proposal.status}`, 409);
  proposal.options = proposal.options.map(option => ({ ...option, expired: true }));
  proposal.options.push(...options);
  proposal.status = 'countered';
  proposal.updatedAt = at;
  value.updatedAt = at;
  return assertValidCase(value);
}

export function acceptProposal(caseInput, proposalId, optionId, evaluation, { actor, idempotencyKey, actionId, externalRefs = {}, at }) {
  let value = addPolicyEvaluation(caseInput, evaluation, { at });
  const proposal = value.proposals.find(item => item.id === proposalId);
  if (!proposal) throw domainError('Proposal not found', 404);
  const option = proposal.options.find(item => item.id === optionId && !item.expired);
  if (!option) throw domainError('Proposal option is missing or expired', 409);
  if (!['open', 'countered'].includes(proposal.status)) throw domainError(`Proposal cannot be accepted from ${proposal.status}`, 409);
  const action = assertValidAction({
    id: actionId,
    actionKey: 'acceptProposal',
    actor,
    idempotencyKey,
    outcome: evaluation.decision === 'allow' ? 'ok' : evaluation.decision === 'needsHuman' ? 'needsApproval' : 'denied',
    reasonCode: evaluation.reasonCode,
    externalRefs: { ...externalRefs, proposalId, optionId },
    createdAt: at
  });
  if (action.outcome === 'needsApproval') value = transitionCase(value, 'waitingForHuman', { actor, at, reasonCode: evaluation.reasonCode });
  if (action.outcome === 'ok') {
    proposal.status = 'accepted';
    proposal.acceptedOptionId = optionId;
    proposal.options = proposal.options.map(item => ({ ...item, expired: item.id !== optionId }));
    value = transitionCase(value, 'authorized', { actor, at, reasonCode: evaluation.reasonCode });
  }
  appendEvent(value, {
    id: `evt_${crypto.randomUUID()}`,
    type: 'decision',
    actor,
    createdAt: at,
    payload: { action },
    linkedPolicyEvaluation: evaluation.id,
    precedingEventRef: value.events.at(-1)?.id || null
  });
  return { case: assertValidCase(value), action };
}

export function applyHumanAction(caseInput, actionInput, { at, preserveState = false }) {
  if (!HUMAN_ACTIONS.includes(actionInput.actionKey)) throw domainError('Unsupported human action', 400);
  const action = assertValidAction({ ...actionInput, outcome: 'ok', reasonCode: actionInput.reasonCode || null, externalRefs: actionInput.externalRefs || {}, createdAt: at });
  let value = clone(caseInput);
  const existing = value.events.find(event => event.payload?.action?.idempotencyKey === action.idempotencyKey);
  if (existing) return { case: value, action: existing.payload.action, replay: true };
  const targetState = { approveOnce: 'authorized', pause: 'paused', revoke: 'revoked', takeOver: 'paused', decline: 'revoked' }[action.actionKey];
  if (value.state === 'paused' && action.actionKey !== 'resume' && action.actionKey !== 'revoke') throw domainError('Paused case requires an authenticated human resume', 409);
  if (action.actionKey === 'resume') {
    if (value.state !== 'paused') throw domainError('Case is not paused', 409);
    const pauseEvent = [...value.events].reverse().find(event => event.type === 'stateChange' && event.payload?.to === 'paused');
    if (!pauseEvent || !pauseEvent.payload?.from) throw domainError('Paused case has no previous state', 409);
    value = transitionCase(value, pauseEvent.payload.from, { actor: action.actor, at, reasonCode: 'resume' });
  }
  if (targetState && !preserveState) value = transitionCase(value, targetState, { actor: action.actor, at, reasonCode: action.actionKey });
  appendEvent(value, {
    id: `evt_${crypto.randomUUID()}`,
    type: 'humanAction',
    actor: action.actor,
    createdAt: at,
    payload: { action, actorType: 'human' },
    linkedPolicyEvaluation: action.externalRefs.policyEvaluationId || null,
    precedingEventRef: value.events.at(-1)?.id || null
  });
  return { case: assertValidCase(value), action, replay: false };
}

export function applyAgentAction(caseInput, actionInput, { at, nextState = null }) {
  if (HUMAN_ACTIONS.includes(actionInput.actionKey)) throw domainError('Human action requires an authenticated human session', 403);
  if (caseInput.state === 'paused' || caseInput.state === 'revoked') throw domainError('Case is paused or revoked', 409);
  const action = assertValidAction({ ...actionInput, reasonCode: actionInput.reasonCode || null, externalRefs: actionInput.externalRefs || {}, createdAt: at });
  let value = clone(caseInput);
  const existing = value.events.find(event => event.payload?.action?.idempotencyKey === action.idempotencyKey);
  if (existing) return { case: value, action: existing.payload.action, replay: true };
  const outcomeState = { needsApproval: 'waitingForHuman', failed: 'failed', unknown: 'unknownExternalResult' }[action.outcome];
  if (outcomeState) value = transitionCase(value, outcomeState, { actor: action.actor, at, reasonCode: action.reasonCode || action.outcome });
  else if (action.outcome === 'ok' && nextState) value = transitionCase(value, nextState, { actor: action.actor, at, reasonCode: action.actionKey });
  appendEvent(value, {
    id: `evt_${crypto.randomUUID()}`,
    type: action.outcome === 'failed' || action.outcome === 'unknown' ? 'error' : action.outcome === 'needsApproval' || action.outcome === 'denied' ? 'decision' : 'toolAction',
    actor: action.actor,
    createdAt: at,
    payload: { action },
    linkedPolicyEvaluation: action.externalRefs.policyEvaluationId || null,
    precedingEventRef: value.events.at(-1)?.id || null
  });
  return { case: assertValidCase(value), action, replay: false };
}

export function completeCase(caseInput, receipt, { actor, at }) {
  if (caseInput.receipt) throw domainError('Case already has a receipt', 409);
  const withReceipt = clone(caseInput);
  withReceipt.receipt = receipt;
  let value = transitionCase(withReceipt, 'completed', { actor, at, reasonCode: 'receiptConfirmed' });
  appendEvent(value, { id: `evt_${crypto.randomUUID()}`, type: 'receipt', actor, createdAt: at, payload: { receipt }, linkedPolicyEvaluation: receipt.authorityBasis, precedingEventRef: value.events.at(-1)?.id || null });
  return assertValidCase(value);
}

export function verifiedHumanCaseDecision(caseInput, actionId, result) {
  if (!actionId) return null;
  const event = caseInput.events.find(item => item.type === 'humanAction' && item.payload?.action?.id === actionId);
  const action = event?.payload?.action;
  return action?.actionKey === 'approveOnce'
    && action.actor === event.actor
    && action.externalRefs?.serverAuthenticatedHuman === true
    && action.externalRefs?.caseId === caseInput.id
    && action.externalRefs?.requestedAction === 'case.complete'
    && action.externalRefs?.result === result ? action : null;
}

const nativeMessageType = message => ({ offer: 'proposal', counteroffer: 'counterproposal', accept: 'decision', reject: 'decision', receipt: 'completion' }[message.intent] || message.type || 'message');
const nativeOption = (message, value) => ({ id: `option_${message.id}`, value, sourceConfidence: 'enteredForCase', expired: false, outOfPolicyFlags: [] });

export function advanceNativeCase(caseInput, message, deliveryState, at, { scopedAccept = false, scopedReject = false, scopedCompletion = null } = {}) {
  let value = clone(caseInput);
  const eventId = `evt_${message.id}`;
  const existing = value.events.find(item => item.id === eventId);
  if (existing) {
    existing.payload = { ...existing.payload, deliveryState };
    value.updatedAt = at;
    return assertValidCase(value);
  }
  if (value.receipt || ['failed', 'expired', 'revoked'].includes(value.state)) throw domainError('Case is already terminal', 409);
  const type = nativeMessageType(message);
  const payload = {
    messageId: message.id,
    messageType: type,
    actorType: 'agent',
    text: message.text,
    data: message.payload || null,
    senderAgentId: message.senderAgentId,
    recipientAgentId: message.recipientAgentId,
    recipientEmail: message.recipientEmail,
    transport: 'native',
    deliveryState,
    authorityClaim: message.unverifiedAuthorityClaim || null,
    signatureClaim: message.unverifiedSignatureClaim || null,
    verifiedHumanApproval: false
  };
  const proposalInput = message.payload?.proposal || message.proposal;
  if (type === 'proposal') {
    if (!proposalInput || typeof proposalInput !== 'object' || Array.isArray(proposalInput)) throw domainError('Structured proposal is required', 400);
    const proposalId = `proposal_${message.id}`;
    value = addProposal(value, { id: proposalId, kind: 'negotiation', options: [nativeOption(message, proposalInput)], status: 'open', acceptedOptionId: null, expiresAt: null, createdAt: at, updatedAt: at });
    payload.proposalId = proposalId;
  }
  if (type === 'counterproposal') {
    const reference = message.payload?.counterproposal?.proposalMessageId || message.payload?.decision?.proposalMessageId;
    const prior = value.events.find(item => item.payload?.messageId === reference);
    const proposalId = prior?.payload?.proposalId;
    if (!proposalId) throw domainError('Counterproposal must reference a proposal in this case', 409);
    const counter = message.payload?.counterproposal || message.payload?.decision?.details || {};
    value = counterProposal(value, proposalId, { options: [nativeOption(message, counter)], at });
    payload.proposalId = proposalId;
  }
  if (type === 'decision') {
    const reference = message.payload?.decision?.proposalMessageId;
    const prior = value.events.find(item => item.payload?.messageId === reference);
    const proposal = value.proposals.find(item => item.id === prior?.payload?.proposalId);
    // case-tools v1: only a scoped case-tool reject withdraws the proposal; legacy native rejects
    // leave it as it was.
    if (scopedReject && message.payload?.decision?.kind === 'reject' && proposal) {
      proposal.status = 'withdrawn'; proposal.updatedAt = at; payload.proposalId = proposal.id;
    }
    if (message.payload?.decision?.kind === 'accept' || message.intent === 'accept') {
      if (!proposal) throw domainError('Decision must reference a proposal in this case', 409);
      proposal.status = 'accepted';
      proposal.acceptedOptionId = proposal.options.findLast(item => !item.expired)?.id || null;
      proposal.updatedAt = at;
      payload.proposalId = proposal.id;
    }
  }
  appendEvent(value, { id: eventId, type: type === 'decision' ? 'decision' : 'message', actor: message.senderAgentId, createdAt: message.createdAt, payload,
    ...(message.privateScreening ? { privateScreening: message.privateScreening } : {}),
    linkedPolicyEvaluation: null, precedingEventRef: value.events.at(-1)?.id || null });
  if (value.state === 'new') value = transitionCase(value, 'inProgress', { actor: message.senderAgentId, at, reasonCode: 'caseStarted' });
  if (type === 'decision' && (message.payload?.decision?.kind === 'accept' || message.intent === 'accept')) {
    if (!scopedAccept) value = transitionCase(value, 'waitingForHuman', { actor: message.senderAgentId, at, reasonCode: 'agentDecisionNeedsHumanReview' });
  }
  if (type === 'completion') {
    const completion = message.payload?.completion;
    if (!completion || typeof completion.result !== 'string' || !completion.result.trim()) throw domainError('Completion result is required', 400);
    const claimedBasis = completion.authorityBasis || null;
    const humanDecision = scopedCompletion?.humanDecision || verifiedHumanCaseDecision(value, claimedBasis, completion.result);
    if (claimedBasis && !humanDecision) throw domainError('Completion authority is not a verified human case decision', 409);
    const approvalRequired = value.events.some(item => item.type === 'decision' && item.payload?.messageType === 'decision' && item.payload?.data?.decision?.kind === 'accept');
    if ((approvalRequired || value.state === 'waitingForHuman') && !humanDecision) throw domainError('Authenticated human case decision is required', 409);
    const receipt = {
      id: `receipt_${message.id}`,
      result: completion.result,
      counterparties: [...value.participants],
      externalIds: {},
      authorityBasis: humanDecision?.id || 'nativeAgentCompletion',
      humanApprovalStatus: humanDecision ? 'approved' : 'notRequired',
      evidenceRefs: scopedCompletion?.evidenceRefs || (Array.isArray(completion.evidenceRefs) ? completion.evidenceRefs : []),
      createdAt: at
    };
    value = completeCase(value, receipt, { actor: message.senderAgentId, at });
  }
  return assertValidCase(value);
}
