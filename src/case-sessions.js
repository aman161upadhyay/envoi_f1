// case-session v1 (docs/architecture/agent-native-v2/handoffs.md#case-session-v1): a short-lived,
// server-bound scope a host mints for one model turn on one claimed piece of work. The server
// keeps only the token's SHA-256. Ends are recorded eagerly, in the transaction of the action that
// causes them (§6.2), and every use re-derives the conditions as defense in depth. Once ended, a
// session stays ended.
import crypto from 'node:crypto';
import path from 'node:path';

export const caseSessionTokenPrefix = 'envoi_case_session_';
export const caseSessionIdPrefix = 'case_session_';
export const caseSessionTtlMs = 900_000;
export const caseSessionRetentionMs = 24 * 60 * 60_000;
export const caseSessionLeaseTokenMaxLength = 256;
// §1: activeUntil is kept at least 60 s ahead, refreshed at least every 20 s; checks read the
// epoch from a cache no more than 5 s old.
export const caseSessionsHeartbeatMs = 20_000;
export const caseSessionsActiveWindowMs = 60_000;
export const caseSessionsEpochCacheMs = 5_000;

export const caseSessionsEpochPath = path.join('config', 'case-sessions-epoch');
export const caseSessionPath = (inboxId, sessionId) => path.join('inboxes', inboxId, 'case-sessions', `${sessionId}.json`);
export const caseSessionTokenPath = tokenHash => path.join('auth', 'case-sessions', `${tokenHash}.json`);
export const caseSessionTokenDir = path.join('auth', 'case-sessions');
// The latest session minted for each work item, so settlement, claim and mint find it without a
// scan, and control changes scan only these pointers (§16).
export const caseSessionWorkPath = (inboxId, workId) => path.join('inboxes', inboxId, 'case-session-work', `${workId}.json`);
export const caseSessionWorkDir = inboxId => path.join('inboxes', inboxId, 'case-session-work');

// §6.2, x-ended-precedence. `expired` is recorded only, never derived from these conditions.
export const endedPrecedence = Object.freeze(['credential_ended', 'agent_paused', 'case_controlled', 'work_ineligible', 'work_settled', 'ended_by_host', 'superseded', 'lease_lost']);
// §9: the reasons that also write a case_session.ended event.
export const eventReasons = new Set(['case_controlled', 'agent_paused']);

// §5, x-case-tools, in table order.
const agentWork = ['agent_message', 'human_decision'];
const everyWork = ['agent_message', 'human_instruction', 'human_decision'];
export const caseToolTable = Object.freeze([
  { name: 'envoi_case_snapshot', needs: ['read'], workKinds: everyWork },
  { name: 'envoi_case_reply', needs: ['send_agent_messages'], workKinds: everyWork },
  { name: 'envoi_case_propose', needs: ['send_agent_messages'], workKinds: agentWork },
  { name: 'envoi_case_decide', needs: ['execute_cases'], workKinds: agentWork },
  { name: 'envoi_authority_check', needs: ['execute_cases'], workKinds: agentWork },
  { name: 'envoi_request_human', needs: ['execute_cases'], workKinds: agentWork },
  { name: 'envoi_case_list_assets', needs: ['read'], workKinds: everyWork },
  { name: 'envoi_case_share_asset', needs: ['create_assets'], workKinds: agentWork },
  { name: 'envoi_case_complete', needs: ['execute_cases', 'send_agent_messages'], workKinds: agentWork }
]);

const allows = (permissions, need) => need === 'read'
  ? permissions.includes('send_agent_messages') || permissions.includes('receive_agent_messages')
  : permissions.includes(need);

// The x-case-tools rows the permissions and work kind allow, limited to the tools this server
// implements (§6.4), in table order.
export function allowedCaseTools(permissions, workKind, implemented) {
  const held = Array.isArray(permissions) ? permissions : [];
  return caseToolTable
    .filter(row => row.workKinds.includes(workKind) && row.needs.every(need => allows(held, need)) && implemented.has(row.name))
    .map(row => row.name);
}

export const isHumanDecision = message => message?.kind === 'humanDecision' && message.type === 'humanDecision';
export function workKindOf(message, isHumanInstruction) {
  if (isHumanInstruction(message)) return 'human_instruction';
  if (isHumanDecision(message)) return 'human_decision';
  if (message?.senderInboxId && message.senderAgentId) return 'agent_message';
  return null;
}

export const newCaseSessionToken = () => `${caseSessionTokenPrefix}${crypto.randomBytes(32).toString('base64url')}`;
export const hasCaseSessionTokenFormat = raw => typeof raw === 'string' && /^envoi_case_session_[A-Za-z0-9_-]{43}$/.test(raw);
export const validCaseSessionId = value => typeof value === 'string' && /^case_session_[A-Za-z0-9_-]{1,120}$/.test(value);
export const validLeaseToken = value => typeof value === 'string' && value.length >= 1 && value.length <= caseSessionLeaseTokenMaxLength;

const live = claim => ['claimed', 'acknowledged'].includes(claim?.status);
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const after = (instant, now) => Boolean(instant) && new Date(instant) > new Date(now);

// §3 row 10 and §7.3: why a lease token does not hold this host's live lease, or null when it does.
// Checked in the contract's order.
export function leaseStaleReason(claim, familyId, leaseTokenHash, now) {
  if (!claim) return 'superseded';
  if (claim.credentialFamilyId !== familyId) return 'other_installation';
  if (claim.leaseTokenHash !== leaseTokenHash) return 'superseded';
  if (['completed', 'failed'].includes(claim.status) || claim.failure) return 'settled';
  if (claim.reofferWithoutAttempt === true) return 'released';
  if (!live(claim) || !after(claim.leaseExpiresAt, now)) return 'expired';
  return null;
}

// §6.2 step 5: which conditions hold now for an unrecorded session, from stored facts. Pure, so
// precedence and x-implied-conditions can be checked without a server.
export function sessionConditions(session, { family, agent, caseRecord, ineligibleReason, claim, message, pointer }, now) {
  return {
    credential_ended: !family || Boolean(family.revokedAt) || !after(family.refreshExpiresAt, now)
      || !agent || !['active', 'paused'].includes(agent.status) || agent.onboardingStatus !== 'approved',
    agent_paused: agent?.status === 'paused',
    case_controlled: ['paused', 'revoked'].includes(caseRecord?.state),
    work_ineligible: Boolean(ineligibleReason),
    work_settled: ['processed', 'failed'].includes(message?.status) || ['completed', 'failed'].includes(claim?.status)
      || Boolean(claim?.failure && claim.fence === session.fence),
    ended_by_host: false,
    superseded: Boolean(pointer) && pointer.sessionId !== session.id,
    lease_lost: !claim || claim.fence !== session.fence || claim.leaseTokenHash !== session.leaseTokenHash || !live(claim) || !after(claim.leaseExpiresAt, now)
  };
}
export const firstCondition = conditions => endedPrecedence.find(reason => conditions[reason]) || null;

export const publicSessionEnd = session => ({ id: session.id, status: 'ended', endedReason: session.endedReason, endedAt: session.endedAt });

// Records and the epoch. Events go to the session's own inbox, which every caller holds the lock
// of. `recordAudit(inboxId, type, data, at)` writes one inside the caller's transaction for the
// paths that have no writeAudit of their own (the credential revocation helpers).
export function createCaseSessions({ store, enabled, hashSecret, recordAudit }) {
  let epochCache = null;

  const auditWith = (writeAudit, inboxId) => writeAudit
    ? (type, data, at) => writeAudit(type, data, at, inboxId)
    : (type, data, at) => recordAudit(inboxId, type, data, at);

  // Records one end. A session past expiresAt is recorded as expired instead, with no event (§6.2).
  async function recordEnd(session, reason, at, writeAudit) {
    const current = await store.getJson(caseSessionPath(session.inboxId, session.id));
    if (!current || current.endedReason) return current;
    const expired = reason === 'expired' || !after(current.expiresAt, at);
    const endedReason = expired ? 'expired' : reason;
    const ended = { ...current, status: 'ended', endedReason, endedAt: expired ? current.expiresAt : at, updatedAt: at };
    await store.putJson(caseSessionPath(current.inboxId, current.id), ended);
    const write = auditWith(writeAudit, current.inboxId);
    await write('agent.case_session_ended', { agentId: current.agentId, sessionId: current.id, workId: current.workId, caseId: current.caseId, endedReason }, at);
    if (!expired && eventReasons.has(endedReason)) {
      await write('case_session.ended', { agentId: current.agentId, workId: current.workId, caseId: current.caseId, sessionId: current.id, reason: endedReason }, at);
    }
    return ended;
  }

  // Ends every still-recorded-usable session whose pointer matches, in the caller's transaction.
  async function endWhere(inboxId, matches, reason, at, writeAudit) {
    if (!enabled) return [];
    const pointers = (await store.listJson(caseSessionWorkDir(inboxId))).filter(matches);
    const ended = [];
    for (const pointer of pointers) {
      const session = await store.getJson(caseSessionPath(inboxId, pointer.sessionId));
      if (session && !session.endedReason) ended.push(await recordEnd(session, reason, at, writeAudit));
    }
    return ended;
  }

  return {
    enabled,
    recordEnd,
    endWhere,
    // Hot paths (claim, complete, fail): only the work's latest session can still be usable, because
    // every mint ends the one before it.
    async endForWork(inboxId, workId, reason, at, writeAudit) {
      if (!enabled) return [];
      const pointer = await store.getJson(caseSessionWorkPath(inboxId, workId));
      const session = pointer ? await store.getJson(caseSessionPath(inboxId, pointer.sessionId)) : null;
      return session && !session.endedReason ? [await recordEnd(session, reason, at, writeAudit)] : [];
    },
    endForAgent: (inboxId, agentId, reason, at, writeAudit) => endWhere(inboxId, pointer => pointer.agentId === agentId, reason, at, writeAudit),
    endForFamily: (inboxId, agentId, familyId, reason, at, writeAudit) => endWhere(inboxId, pointer => pointer.agentId === agentId && pointer.familyId === familyId, reason, at, writeAudit),
    endForCase: (inboxId, caseId, reason, at, writeAudit) => endWhere(inboxId, pointer => pointer.caseId === caseId, reason, at, writeAudit),
    pointer: (inboxId, workId) => store.getJson(caseSessionWorkPath(inboxId, workId)),
    get: (inboxId, sessionId) => store.getJson(caseSessionPath(inboxId, sessionId)),

    // The session a bearer names, or null. Format first: reveals nothing and costs no lookup.
    async byToken(raw) {
      if (!hasCaseSessionTokenFormat(raw)) return null;
      const tokenHash = hashSecret(raw);
      const index = await store.getJson(caseSessionTokenPath(tokenHash));
      if (!index?.inboxId || !validCaseSessionId(index.sessionId)) return null;
      const session = await store.getJson(caseSessionPath(index.inboxId, index.sessionId));
      return session?.tokenHash === tokenHash ? session : null;
    },

    // §3 row 11, inside the caller's transaction: writes the record, its token index and the work
    // pointer, and returns the raw token once.
    async create(fields, at, writeAudit) {
      const token = newCaseSessionToken();
      const tokenHash = hashSecret(token);
      const session = {
        id: `${caseSessionIdPrefix}${crypto.randomBytes(16).toString('hex')}`,
        tokenHash, status: 'active', ...fields,
        createdAt: at, expiresAt: new Date(Math.min(new Date(at).getTime() + caseSessionTtlMs, fields.signedPolicyExpiresAtMs ?? Infinity)).toISOString(),
        endedReason: null, endedAt: null, updatedAt: at
      };
      await store.putJsonBatch([
        { path: caseSessionPath(session.inboxId, session.id), value: session },
        { path: caseSessionTokenPath(tokenHash), value: { tokenHash, sessionId: session.id, inboxId: session.inboxId, agentId: session.agentId, createdAt: at, expiresAt: session.expiresAt } },
        { path: caseSessionWorkPath(session.inboxId, session.workId), value: { workId: session.workId, caseId: session.caseId, agentId: session.agentId, familyId: session.familyId, sessionId: session.id, fence: session.fence, createdAt: at, expiresAt: session.expiresAt } }
      ]);
      await writeAudit('agent.case_session_created', {
        agentId: session.agentId, installationId: session.installationId, workId: session.workId, caseId: session.caseId,
        sessionId: session.id, fence: session.fence, allowedTools: session.allowedTools, expiresAt: session.expiresAt
      }, at, session.inboxId);
      return { session, token };
    },

    // §1. A flag-off server moves the epoch at startup; a flag-on server moves it only when no
    // server has kept activeUntil fresh, which covers a code rollback.
    async startEpoch(now = new Date()) {
      const at = now.toISOString();
      const next = await store.updateJson(caseSessionsEpochPath, current => {
        if (!enabled) return { ...(current || {}), epoch: at };
        // Unparseable or future-dated fields count as lapsed: the epoch moves, which refuses old sessions.
        const epoch = instant(current?.epoch);
        const activeUntil = instant(current?.activeUntil);
        const stale = epoch === null || epoch > now.getTime() || activeUntil === null || activeUntil <= now.getTime()
          || activeUntil > now.getTime() + 2 * caseSessionsActiveWindowMs;
        return { epoch: stale ? at : current.epoch, activeUntil: new Date(now.getTime() + caseSessionsActiveWindowMs).toISOString() };
      });
      epochCache = { epoch: next.epoch, readAt: Date.now() };
      return next;
    },
    async heartbeat(now = new Date()) {
      if (!enabled) return null;
      const activeUntil = new Date(now.getTime() + caseSessionsActiveWindowMs).toISOString();
      return store.updateJson(caseSessionsEpochPath, current => {
        const epoch = instant(current?.epoch);
        const kept = instant(current?.activeUntil);
        return {
          epoch: epoch === null || epoch > now.getTime() ? now.toISOString() : current.epoch,
          activeUntil: kept !== null && kept > Date.parse(activeUntil) && kept <= now.getTime() + 2 * caseSessionsActiveWindowMs ? current.activeUntil : activeUntil
        };
      });
    },
    async epoch() {
      if (epochCache && Date.now() - epochCache.readAt < caseSessionsEpochCacheMs) return epochCache.epoch;
      const stored = await store.getJson(caseSessionsEpochPath);
      epochCache = { epoch: instant(stored?.epoch) === null ? null : stored.epoch, readAt: Date.now() };
      return epochCache.epoch;
    },

    // §13 retention: records nothing else ended get `expired` once past expiresAt; a record and its
    // token index go 24 h after expiresAt. `withLock(session, operation)` runs under the session's
    // work locks, so a delete never races a mint rewriting the work pointer. At most `limit` records
    // change per run; one failing record does not stop the others.
    async cleanup(withLock, now = new Date(), { limit = 500 } = {}) {
      let expired = 0;
      let deleted = 0;
      let failed = 0;
      for (const index of await store.listJson(caseSessionTokenDir)) {
        if (expired + deleted >= limit) break;
        if (!index?.tokenHash) continue;
        try {
          const session = index.inboxId && validCaseSessionId(index.sessionId) ? await store.getJson(caseSessionPath(index.inboxId, index.sessionId)) : null;
          const retainedUntil = new Date(new Date(index.expiresAt).getTime() + caseSessionRetentionMs);
          if (!session) {
            // The inbox was deleted with its history: the index names nothing any more.
            if (!after(retainedUntil, now)) { await store.deleteJson(caseSessionTokenPath(index.tokenHash)); deleted += 1; }
            continue;
          }
          if (!session.endedReason && !after(session.expiresAt, now)) {
            await withLock(session, writeAudit => recordEnd(session, 'expired', now.toISOString(), writeAudit));
            expired += 1;
          }
          if (!after(retainedUntil, now)) {
            await withLock(session, async () => {
              const pointer = await store.getJson(caseSessionWorkPath(session.inboxId, session.workId));
              if (pointer?.sessionId === session.id) await store.deleteJson(caseSessionWorkPath(session.inboxId, session.workId));
              await store.deleteJson(caseSessionPath(session.inboxId, session.id));
              await store.deleteJson(caseSessionTokenPath(index.tokenHash));
            });
            deleted += 1;
          }
        } catch { failed += 1; }
      }
      return { expired, deleted, failed };
    }
  };
}
