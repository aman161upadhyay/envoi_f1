import path from 'node:path';
import { assertSafeIdentifier } from './path-safety.js';

export const relationshipGrants = Object.freeze(['shareAssets', 'autoAcceptSelectedTasks', 'richerProfileVisibility', 'allowInvitations']);
const grantSet = new Set(relationshipGrants);

export function validateRelationshipGrants(grants) {
  if (!Array.isArray(grants) || grants.length === 0 || grants.length > grantSet.size || grants.some(grant => !grantSet.has(grant)) || new Set(grants).size !== grants.length) {
    throw Object.assign(new Error('A relationship requires distinct supported grants'), { statusCode: 400 });
  }
  return relationshipGrants.filter(grant => grants.includes(grant));
}

export function relationshipPath(inboxId, actorAgentId, targetAgentId) {
  for (const id of [inboxId, actorAgentId, targetAgentId]) assertSafeIdentifier(id, 'relationship identifier');
  return path.join('inboxes', inboxId, 'relationships', actorAgentId, `${targetAgentId}.json`);
}

export function relationshipRecord({ inboxId, actorAgentId, targetAgentId, grants, now, previous = null, humanId }) {
  if (actorAgentId === targetAgentId) throw Object.assign(new Error('An agent cannot grant a relationship to itself'), { statusCode: 400 });
  const normalized = validateRelationshipGrants(grants);
  return {
    id: `${actorAgentId}:${targetAgentId}`, inboxId, actorAgentId, targetAgentId,
    status: 'active', grants: normalized,
    createdAt: previous?.createdAt || now, updatedAt: now, updatedByHumanId: humanId
  };
}

export function revokeRelationship(previous, now, humanId) {
  if (!previous) throw Object.assign(new Error('Relationship not found'), { statusCode: 404 });
  return { ...previous, status: 'revoked', grants: [], updatedAt: now, updatedByHumanId: humanId };
}

export function trustedDiscovery(directory, { approvedContact = null, relationship = null, sameOrganization = false, signedInvitation = false } = {}) {
  if (!directory || !['active', 'paused'].includes(directory.status) || directory.verified !== true) return null;
  return {
    agentId: directory.agentId,
    address: directory.address,
    trust: relationship?.status === 'active' ? 'relationship' : approvedContact?.approved === true && approvedContact.blocked !== true ? 'approved_contact' : sameOrganization ? 'same_organization' : signedInvitation ? 'signed_invitation' : 'exact_address',
    grants: relationship?.status === 'active' ? (Array.isArray(relationship.grants) ? relationship.grants : []).filter(grant => grantSet.has(grant)) : []
  };
}
