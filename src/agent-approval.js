// One approval module for the legacy pending-agent approve route and the agent-registration v1
// claim (§5.3, v3 §41): permissions and agent-slot counting are decided here for both paths.
import path from 'node:path';

export const agentPermissions = ['send_agent_messages', 'receive_agent_messages', 'create_assets', 'execute_cases', 'use_email_transport'];
const permissionSet = new Set(agentPermissions);
// v1 has no per-organization ceilings yet (§5.3).
export const organizationMaximumPermissions = () => [...agentPermissions];
export const activeAgentsPerHuman = 2;

// Today's legacy rule: keep known permissions in request order and always add receive.
export function legacyApprovalPermissions(requested) {
  const permissions = (Array.isArray(requested) ? requested : ['send_agent_messages', 'receive_agent_messages']).filter(permission => permissionSet.has(permission));
  if (!permissions.includes('receive_agent_messages')) permissions.push('receive_agent_messages');
  return permissions;
}

// §5.3: requested ∩ granted ∩ organization maximum, plus receive_agent_messages, in the
// requested order. Anything granted but not requested is dropped silently.
export function effectivePermissions(requested, granted, maximum = organizationMaximumPermissions()) {
  const allowed = new Set(maximum);
  const grantedSet = new Set(granted);
  const effective = [];
  for (const permission of requested) {
    if (permissionSet.has(permission) && allowed.has(permission) && grantedSet.has(permission) && !effective.includes(permission)) effective.push(permission);
  }
  if (!effective.includes('receive_agent_messages')) effective.push('receive_agent_messages');
  return effective;
}

// Approvals that may need a slot when they activate, indexed by the principal human the slot is
// charged to (§5.3). The registration document stays the source of truth for liveness.
export const approvalSlotIndexDir = humanId => path.join('auth', 'agent-registration-approvals', 'by-principal', humanId);
export const approvalSlotIndexPath = (humanId, registrationId) => path.join(approvalSlotIndexDir(humanId), `${registrationId}.json`);
export const approverIndexDir = humanId => path.join('auth', 'agent-registration-approvals', 'by-approver', humanId);
export const approverIndexPath = (humanId, registrationId) => path.join(approverIndexDir(humanId), `${registrationId}.json`);
export const registrationPath = registrationId => path.join('auth', 'agent-registrations', `${registrationId}.json`);

// A live approval: still approved and inside its activation window (§2, derived from time).
export const liveApproval = (registration, now = new Date()) => registration?.status === 'approved' && new Date(registration.activationExpiresAt) > now;

const liveFamily = (family, now) => !family.revokedAt && new Date(family.refreshExpiresAt) > now;

export function createAgentSlots({ store, uncappedHumanIds = new Set() }) {
  const isUncappedHuman = humanId => uncappedHumanIds.has(humanId);
  const familiesOf = (inboxId, agentId) => store.listJson(path.join('auth', 'agent-credential-families', inboxId, agentId));
  const agentHasLiveFamily = async (inboxId, agentId, now) => (await familiesOf(inboxId, agentId)).some(family => liveFamily(family, now));

  // Today's assertActiveAgentSlot: an active or paused agent uses its principal's slot while it
  // has a live family or no family at all. Plus every live approval that will need a slot.
  async function usedSlots(humanId, { excludingAgentId = null, excludingRegistrationId = null } = {}) {
    const now = new Date();
    let used = 0;
    for (const directory of await store.listJson(path.join('directory', 'agents'))) {
      if (!['active', 'paused'].includes(directory.status) || directory.agentId === excludingAgentId) continue;
      const agent = await store.getJson(path.join('inboxes', directory.inboxId, 'agents', `${directory.agentId}.json`));
      if (agent?.principalHumanId !== humanId || !['active', 'paused'].includes(agent.status)) continue;
      const families = await familiesOf(directory.inboxId, agent.id);
      if (!families.length || families.some(family => liveFamily(family, now))) used += 1;
    }
    for (const index of await store.listJson(approvalSlotIndexDir(humanId))) {
      if (!index?.registrationId || index.registrationId === excludingRegistrationId) continue;
      const registration = await store.getJson(registrationPath(index.registrationId));
      if (!liveApproval(registration, now) || registration.principalHumanId !== humanId) continue;
      const target = registration.target;
      if (target?.kind === 'new_agent') used += 1;
      else if (target?.kind === 'existing_agent' && target.agentInboxId && target.agentId !== excludingAgentId) {
        // An agent with no family already counts itself; only all-dead families need a new slot.
        const families = await familiesOf(target.agentInboxId, target.agentId);
        if (families.length && !families.some(family => liveFamily(family, now))) used += 1;
      }
    }
    return used;
  }

  async function assertActiveAgentSlot(humanId, options = {}) {
    if (isUncappedHuman(humanId)) return;
    if (await usedSlots(humanId, options) >= activeAgentsPerHuman) {
      throw Object.assign(new Error('Beta limit of two active agents per human reached'), { statusCode: 409, code: 'ACTIVE_AGENT_LIMIT' });
    }
  }

  return { usedSlots, assertActiveAgentSlot, agentHasLiveFamily, isUncappedHuman };
}
