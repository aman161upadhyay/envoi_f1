// Facts must be loaded from current persisted state inside the caller's mutation lock.
export const authorizationActions = Object.freeze({
  'agent.discover': 'send_agent_messages',
  'a2a.send': 'send_agent_messages',
  'a2a.taskRead': 'send_agent_messages',
  'case.create': 'execute_cases',
  'case.appendEvent': 'execute_cases',
  'case.evaluatePolicy': 'execute_cases',
  'case.propose': 'execute_cases',
  'case.counterProposal': 'execute_cases',
  'case.acceptProposal': 'execute_cases',
  'case.act': 'execute_cases',
  'case.complete': 'execute_cases',
  'asset.grant': 'create_assets'
});
export function authorize(request, facts) {
  const deny = reason => ({ allowed: false, reason });
  if (!request || !facts || !request.actorAgentId || !request.action) return deny('INVALID_REQUEST');
  const { identity, installation, permissions, relationship, caseRecord, resourceGrant, policy, humanApproval } = facts;
  if (!identity || identity.id !== request.actorAgentId || identity.status !== 'active') return deny('IDENTITY_INACTIVE');
  if (request.installationId) {
    if (!installation || installation.id !== request.installationId || installation.agentId !== request.actorAgentId || installation.status !== 'active') return deny('INSTALLATION_INACTIVE');
  } else if (facts.installationRequired) return deny('INSTALLATION_REQUIRED');
  const requiredPermission = authorizationActions[request.action];
  if (!requiredPermission || !Array.isArray(permissions) || !permissions.includes(requiredPermission)) return deny('PERMISSION_DENIED');
  if (facts.relationshipGrant) {
    if (facts.contactBlocked === true || !request.relationshipId || relationship?.id !== request.relationshipId || relationship.status !== 'active' || relationship.actorAgentId !== request.actorAgentId || !relationship.grants?.includes(facts.relationshipGrant)) return deny('RELATIONSHIP_DENIED');
  }
  if (request.caseId) {
    if (!caseRecord || caseRecord.id !== request.caseId || !(caseRecord.schemaVersion ? caseRecord.participants : caseRecord.participantAgentIds)?.includes(request.actorAgentId)) return deny('CASE_MEMBERSHIP_DENIED');
  } else if (facts.caseRequired) return deny('CASE_REQUIRED');
  if (request.resourceId) {
    if (!resourceGrant || resourceGrant.resourceId !== request.resourceId || resourceGrant.agentId !== request.actorAgentId || resourceGrant.active !== true) return deny('RESOURCE_DENIED');
  } else if (facts.resourceRequired) return deny('RESOURCE_REQUIRED');
  if (policy?.allowed === false || facts.policyRequired && policy?.allowed !== true) return deny('POLICY_DENIED');
  if (humanApproval?.required === true && humanApproval?.approved !== true) return deny('HUMAN_APPROVAL_REQUIRED');
  return { allowed: true, reason: 'ALLOW' };
}
