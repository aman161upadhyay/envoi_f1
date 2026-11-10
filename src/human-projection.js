const statePresentation = Object.freeze({
  new: ['New', 'activeWork', 'Agent is preparing the case'],
  classifying: ['Classifying', 'activeWork', 'Agent is classifying the work'],
  inProgress: ['In progress', 'activeWork', 'Agent is advancing the case'],
  waitingForExternalParty: ['Waiting for external party', 'waiting', 'Waiting on an external participant'],
  waitingForHuman: ['Waiting for you', 'needsMe', 'Your decision is required'],
  tentativeHold: ['Tentative hold', 'needsMe', 'A temporary hold is awaiting your decision'],
  authorized: ['Authorized', 'activeWork', 'The approved action is ready'],
  executing: ['Executing', 'activeWork', 'Agent is executing the approved action'],
  sent: ['Sent', 'waiting', 'Sent; awaiting external receipt'],
  received: ['Received', 'waiting', 'Received; awaiting acceptance'],
  accepted: ['Accepted', 'activeWork', 'Accepted; completion is being confirmed'],
  completed: ['Completed', 'completed', 'Outcome confirmed'],
  failed: ['Failed', 'needsMe', 'The action failed and needs review'],
  unknownExternalResult: ['Unknown external result', 'needsMe', 'The external result is unconfirmed'],
  expired: ['Expired', 'completed', 'The proposal or authority expired'],
  paused: ['Paused', 'needsMe', 'Work is paused'],
  revoked: ['Revoked', 'completed', 'Authority was revoked'],
  disputed: ['Disputed', 'needsMe', 'The outcome is disputed and needs review']
});

const stateTone = state => ({
  waitingForHuman: 'attention', tentativeHold: 'tentative', completed: 'success', authorized: 'success', accepted: 'success', failed: 'danger', unknownExternalResult: 'unknown', waitingForExternalParty: 'waiting', sent: 'waiting', received: 'waiting', expired: 'danger', revoked: 'danger', disputed: 'danger'
}[state] || 'neutral');

const readableAction = value => String(value || '').replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('.', ' ').toLowerCase();

function eventSummary(event) {
  const payload = event.payload || {};
  if (event.type === 'message') return payload.text || 'A message was recorded.';
  if (event.type === 'stateChange') return `Case moved from ${statePresentation[payload.from]?.[0] || payload.from} to ${statePresentation[payload.to]?.[0] || payload.to}.`;
  if (event.type === 'policyEvaluation') return `Authority check for ${readableAction(payload.requestedAction)}: ${readableAction(payload.decision)}.`;
  if (event.type === 'receipt') return payload.receipt?.result || 'A durable outcome receipt was recorded.';
  if (payload.action) return `${readableAction(payload.action.actionKey)}: ${readableAction(payload.action.outcome)}.`;
  return payload.summary || `${readableAction(event.type)} recorded.`;
}

export function projectCaseForHuman(value) {
  const [stateLabel, bucket, nextActor] = statePresentation[value.state] || [value.state, 'activeWork', 'Status available'];
  const openProposal = [...(value.proposals || [])].reverse().find(proposal => ['open', 'countered'].includes(proposal.status));
  const relevantPolicy = [...(value.policyEvaluations || [])].reverse().find(item => item.decision === 'needsHuman') || [...(value.policyEvaluations || [])].reverse()[0] || null;
  const needsAttention = bucket === 'needsMe';
  return {
    id: value.id,
    schemaVersion: value.schemaVersion,
    objective: value.objective,
    ...(value.caseMode === 'group' ? { caseMode: 'group', members: value.members, assignments: value.assignments || [] } : {}),
    collaborationMode: value.collaborationMode || 'collaboration',
    state: value.state,
    stateLabel,
    stateTone: stateTone(value.state),
    bucket,
    needsAttention,
    nextActor,
    principal: value.principal,
    actingAgent: value.actingAgent,
    actingAgentId: value.actingAgent,
    participants: value.participants || [],
    participantIds: value.participants || [],
    constraints: value.constraints || {},
    deadline: value.deadline,
    authorityRefs: value.authorityRefs || [],
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    contextualDetail: value.deadline ? `Deadline ${value.deadline}` : openProposal?.expiresAt ? `Proposal expires ${openProposal.expiresAt}` : nextActor,
    decision: needsAttention ? {
      question: relevantPolicy?.reasonCode ? `Review required: ${readableAction(relevantPolicy.reasonCode)}.` : nextActor,
      policyEvaluationId: relevantPolicy?.id || null,
      requestedAction: relevantPolicy?.requestedAction || null,
      grantType: relevantPolicy?.grantType || null,
      expiresAt: relevantPolicy?.expiresAt || openProposal?.expiresAt || null,
      availableActions: value.state === 'waitingForHuman' || value.state === 'tentativeHold' ? ['approveOnce', 'editProposal', 'decline', 'takeOver'] : ['takeOver', 'pause']
    } : null,
    events: value.events || [],
    timeline: (value.events || []).map(event => ({ id: event.id, type: event.type, actorId: event.actor, createdAt: event.createdAt, summary: eventSummary(event), policyEvaluationId: event.linkedPolicyEvaluation, payload: event.payload })),
    policyEvaluations: value.policyEvaluations || [],
    authority: (value.policyEvaluations || []).map(item => ({ id: item.id, requestedAction: item.requestedAction, actorId: item.actor, policyId: item.matchedPolicyId, decision: item.decision, grantType: item.grantType, effectiveAt: item.effectiveAt, expiresAt: item.expiresAt, reasonCode: item.reasonCode })),
    proposals: value.proposals || [],
    evidence: value.evidence || [],
    receipt: value.receipt
  };
}

export function projectWorkspaceForHuman(cases) {
  const projected = cases.filter(value => value?.schemaVersion).map(projectCaseForHuman);
  const counts = { needsMe: 0, activeWork: 0, waiting: 0, completed: 0 };
  for (const item of projected) counts[item.bucket] += 1;
  return {
    counts,
    cases: projected.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
    generatedAt: new Date().toISOString()
  };
}
