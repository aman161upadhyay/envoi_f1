// agent-registration v1 §2–§5 (task A-4.2): pending registrations, status polling and the human
// claim. A registration grants nothing; its state lives in path-keyed documents on both stores
// (§9), every window ends by time, and every decision moves through a locked conditional write.
import crypto from 'node:crypto';
import path from 'node:path';
import { agentPermissions, approvalSlotIndexPath, approverIndexDir, approverIndexPath, effectivePermissions, liveApproval, organizationMaximumPermissions, registrationPath } from './agent-approval.js';
import { newestActiveInstallation } from './agent-installations.js';
import { routeAvailable, browserPollAvailable, providerGatewayAuthority } from './onboarding-flags.js';
import { oauthGrantablePermissions, scopeForPermissions } from './agent-remote-auth.js';
import { approverEmailHint, displayName, displayVerificationCode, generateBootstrapToken, generateVerificationCode, hashToken, isBootstrapToken, normalizeVerificationCode, sourceHmac, sourceKey, tokenLikePattern, unsafeNameCharacters, validRequestedName, verificationCodeHmac } from './agent-registration-codes.js';

export const registrationTtlSeconds = 600;
export const activationWindowSeconds = 600;
export const activationRecoverySeconds = 300;
export const pollAfterSeconds = 5;
export const approvalsAwaitingActivationPerHuman = 3;
export const ownerClaimListMax = 20;
export const listWindowMs = 24 * 3_600_000;
export const registrationBodyMaxBytes = 4096;

export const tokenIndexPath = tokenHash => path.join('auth', 'agent-registration-tokens', `${tokenHash}.json`);
export const codeIndexPath = codeHmac => path.join('auth', 'agent-registration-codes', `${codeHmac}.json`);
export const addressKey = address => encodeURIComponent(String(address).toLowerCase());
export const addressHoldPath = address => path.join('auth', 'agent-address-holds', `${addressKey(address)}.json`);
// Hourly buckets by creation time: cleanup and the owner list read only the buckets they need.
export const hourBucket = iso => String(iso).slice(0, 13).replace(/[^0-9T]/g, '');
export const createdBucketPath = (createdAt, registrationId) => path.join('auth', 'agent-registration-created', hourBucket(createdAt), `${registrationId}.json`);
export const createdBucketDir = bucket => path.join('auth', 'agent-registration-created', bucket);
export const decidedBucketPath = (createdAt, registrationId) => path.join('auth', 'agent-registration-approvals', 'by-hour', hourBucket(createdAt), `${registrationId}.json`);
export const decidedBucketDir = bucket => path.join('auth', 'agent-registration-approvals', 'by-hour', bucket);
export const activationRecoveryPath = tokenHash => path.join('auth', 'agent-registration-recovery', `${tokenHash}.json`);
export const activationRecoveryDir = path.join('auth', 'agent-registration-recovery');
export const cleanupCursorPath = path.join('auth', 'agent-registration-cleanup', 'cursor.json');
export const retainRecordsMs = 24 * 3_600_000;
export const registrationLockKey = registrationId => `registration:${registrationId}`;
// agent-registration §14 (revision 5): the records an agent-remote-auth consent writes. Keys are SHA-256 hex of the
// raw handle or code; neither raw value is ever stored.
export const consentDecisionPath = handleDigest => path.join('auth', 'oauth-consent-decisions', `${handleDigest}.json`);
export const oauthCodePath = codeHash => path.join('auth', 'oauth-codes', `${codeHash}.json`);
export const oauthCleanupRoot = path.join('auth', 'oauth-cleanup');
export const oauthCleanupDir = bucket => path.join(oauthCleanupRoot, bucket);
// The hour a cleanup bucket name (hourBucket) starts at, in ms, or null for anything else.
export const oauthCleanupBucketStartMs = bucket => {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})$/.exec(String(bucket));
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4])) : null;
};
// Hour buckets one sweep run walks at most; a longer backfill resumes from the cursor on later runs.
export const oauthCleanupBucketsPerRun = 168;
// The cursor format that records complete coverage behind its position. An earlier format (no version, written by the
// RA-A1 part 2 sweep that started at now - 30 days) proves nothing about older buckets, so it starts a backfill.
export const oauthCleanupCursorVersion = 2;
export const oauthCleanupPath = (createdAt, key) => path.join(oauthCleanupDir(hourBucket(createdAt)), `${key}.json`);
export const oauthCleanupCursorPath = path.join('auth', 'oauth-cleanup-cursor', 'cursor.json');
export const consentLockKey = handleDigest => `oauth-consent:${handleDigest}`;
// agent-remote-auth x-limits.authorizationCodeTtlSeconds: the code, and so the approval, lives 60 s.
export const consentCodeTtlSeconds = 60;
// x-limits.bootstrapCodeTtlSeconds: a bootstrap code, and so its approval, lives 600 s.
export const bootstrapCodeTtlSeconds = 600;
export const sha256Hex = value => crypto.createHash('sha256').update(String(value)).digest('hex');
export const addressHoldLockKey = address => `address-hold:${addressKey(address)}`;

const registrationIdPattern = /^registration_[A-Za-z0-9_-]{1,80}$/;
const inboxIdPattern = /^inbox_[A-Za-z0-9_-]{1,80}$/;
const agentIdPattern = /^agent_[A-Za-z0-9_-]{1,80}$/;
const installationIdPattern = /^installation_[A-Za-z0-9_-]{1,80}$/;
const localPartPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const runtimeTypePattern = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const helperNamePattern = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const helperVersionPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/;
const capabilityKeys = ['persistentProcess', 'outboundHttps', 'sse', 'webhook', 'scheduledPolling', 'a2a'];
const connectionRouteValues = ['local_helper', 'remote_mcp_oauth', 'provider_connector', 'authenticated_rest'];

export const coded = (statusCode, code, message, publicFields) => Object.assign(new Error(message), { statusCode, code, ...(publicFields ? { publicFields } : {}) });
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const closed = (value, allowed) => isObject(value) && Object.keys(value).every(key => allowed.includes(key));
const permissionList = value => Array.isArray(value) && value.length >= 1 && value.length <= 5 && new Set(value).size === value.length && value.every(item => agentPermissions.includes(item));
const validLocalPart = value => typeof value === 'string' && value.length >= 3 && value.length <= 32 && localPartPattern.test(value);
const validRuntime = value => closed(value, ['type', 'version']) && 'type' in value && 'version' in value && typeof value.type === 'string' && runtimeTypePattern.test(value.type)
  && (value.version === null || (typeof value.version === 'string' && value.version.length >= 1 && value.version.length <= 32 && versionPattern.test(value.version)));

// Mirrors schemas.json registrationCreateRequest; test/agent-registration-validation.test.js
// checks that both agree.
export function validRegistrationCreate(value) {
  if (!closed(value, ['requestedName', 'requestedLocalPart', 'requestedPermissions', 'connectionRoute', 'runtime', 'deliveryCapabilities', 'helper'])) return false;
  if (!validRequestedName(value.requestedName)) return false;
  if ('requestedLocalPart' in value && !validLocalPart(value.requestedLocalPart)) return false;
  if (!permissionList(value.requestedPermissions)) return false;
  if (!connectionRouteValues.includes(value.connectionRoute)) return false;
  if (!validRuntime(value.runtime)) return false;
  const capabilities = value.deliveryCapabilities;
  if (!closed(capabilities, capabilityKeys) || !capabilityKeys.every(key => typeof capabilities[key] === 'boolean')) return false;
  if ('helper' in value) {
    const helper = value.helper;
    if (!closed(helper, ['name', 'version']) || typeof helper.name !== 'string' || !helperNamePattern.test(helper.name) || typeof helper.version !== 'string' || !helperVersionPattern.test(helper.version)) return false;
  }
  return true;
}

// Mirrors claimApproveRequest, apart from verificationCode, which every claim route checks first.
export function validApproveBody(value) {
  if (!closed(value, ['verificationCode', 'target', 'grantedPermissions', 'policyProfile'])) return false;
  if (value.policyProfile !== 'default' || !permissionList(value.grantedPermissions)) return false;
  const target = value.target;
  if (target?.kind === 'new_agent') {
    return closed(target, ['kind', 'workspaceInboxId', 'name', 'localPart']) && typeof target.workspaceInboxId === 'string' && inboxIdPattern.test(target.workspaceInboxId)
      && validRequestedName(target.name) && validLocalPart(target.localPart);
  }
  if (target?.kind === 'existing_agent') {
    return closed(target, ['kind', 'agentId', 'replacesInstallationId']) && 'replacesInstallationId' in target && typeof target.agentId === 'string' && agentIdPattern.test(target.agentId)
      && (target.replacesInstallationId === null || (typeof target.replacesInstallationId === 'string' && installationIdPattern.test(target.replacesInstallationId)));
  }
  return false;
}
export const validCodeOnlyBody = value => closed(value, ['verificationCode']);

const plus = (iso, ms) => new Date(new Date(iso).getTime() + ms).toISOString();
const timingEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// §4: status is derived from time on every route, whether or not a job has run.
export function derivedStatus(registration, now = new Date()) {
  if (registration.status === 'pending_claim' && new Date(registration.expiresAt) <= now) return 'expired';
  if (registration.status === 'approved' && new Date(registration.activationExpiresAt) <= now) return 'expired';
  return registration.status;
}
// §2: the token record becomes a tombstone when the recovery window ends.
export const recoveryWindowOver = (registration, now = new Date()) => registration.status === 'activated' && new Date(plus(registration.activatedAt, activationRecoverySeconds * 1000)) <= now;

function responseAgent(registration) {
  const target = registration.target;
  return { ...(target.kind === 'existing_agent' ? { id: target.agentId } : {}), name: target.agentName, address: target.address };
}

export function statusView(registration, now = new Date()) {
  const status = derivedStatus(registration, now);
  const base = { registrationId: registration.id, status };
  if (status === 'pending_claim') return { ...base, expiresAt: registration.expiresAt, pollAfterSeconds };
  if (status === 'approved') {
    return { ...base, target: registration.target.kind, workspaceName: registration.workspaceName, agent: responseAgent(registration), effectivePermissions: registration.effectivePermissions, activationExpiresAt: registration.activationExpiresAt, approverEmailHint: registration.approverEmailHint };
  }
  if (status === 'activated') return { ...base, installationId: registration.installationId };
  return base;
}

// §4: first character of the verified email local part, ***, the full domain. Local development
// auth has phone-only humans, so outside production a human with no email gets a fixed hint.
// null otherwise (an email the schema pattern cannot express, e.g. a punycode TLD, or no email in
// production): approve then refuses rather than show the helper a hint that misstates the approver.
export function hintForHuman(human, { production = false } = {}) {
  const hint = approverEmailHint(human?.email);
  if (hint) return hint;
  return !production && !human?.email ? 'd***@development.invalid' : null;
}

export function createAgentRegistrations({
  store, flags, codeKey, limits, pollLimiter, agentSlots, installations, withInboxMutation, canManageLive,
  normalizeLocalPart, addressForLocalPart, identityTaken, semanticDigest, memberOf = async () => true, log = event => console.log(JSON.stringify(event)),
  production = process.env.ENVOI_AUTH_MODE === 'production'
}) {
  const now = () => new Date();
  const nowIso = () => store.now();
  const getRegistration = id => registrationIdPattern.test(String(id)) ? store.getJson(registrationPath(id)) : Promise.resolve(null);
  // Keyed, so a stored or logged sourceHash cannot be reversed by enumerating IPv4 addresses.
  const sourceKeyBuffer = sourceKey(codeKey);
  const sourceHash = ip => sourceHmac(ip, sourceKeyBuffer).slice(0, 32);

  function assertRegistrationEnabled(message = 'Agent-led setup is not available yet.') {
    if (!flags.registration) throw coded(404, 'FEATURE_DISABLED', message);
  }

  // §9 address holds: live while the holding registration is approved and inside its window.
  async function liveHold(address, exceptRegistrationId = null) {
    const hold = await store.getJson(addressHoldPath(address));
    if (!hold?.registrationId || hold.registrationId === exceptRegistrationId) return null;
    const registration = await store.getJson(registrationPath(hold.registrationId));
    return liveApproval(registration, now()) ? hold : null;
  }
  const addressTaken = async (address, exceptRegistrationId = null) => await identityTaken(address) || Boolean(await liveHold(address, exceptRegistrationId));

  // ------------------------------------------------------------------ §3 registration

  async function create(input, { ip, claimUrl, authority } = {}) {
    assertRegistrationEnabled();
    if (!validRegistrationCreate(input)) throw coded(400, 'REGISTRATION_INVALID', 'The registration request is not valid.');
    if (input.requestedLocalPart !== undefined) {
      try { normalizeLocalPart(input.requestedLocalPart); } catch { throw coded(400, 'REGISTRATION_INVALID', 'The registration request is not valid.'); }
    }
    if (!routeAvailable(flags, input.connectionRoute)) throw coded(400, 'ROUTE_NOT_AVAILABLE', 'That connection route is not available.');
    const gateway = authority === providerGatewayAuthority && browserPollAvailable(flags);
    const limited = await limits.consumeCreation(ip);
    if (!limited.allowed) {
      log({ event: 'agent_registration.limited', source: sourceHash(ip), route: input.connectionRoute, reason: 'registration_limit' });
      throw coded(429, 'RATE_LIMITED', 'Too many setup attempts. Try again later.', { retryAfterSeconds: limited.retryAfterSeconds, reason: 'registration_limit' });
    }
    const createdAt = nowIso();
    const expiresAt = plus(createdAt, registrationTtlSeconds * 1000);
    const bootstrapToken = generateBootstrapToken();
    const registration = {
      id: store.id('registration'), status: 'pending_claim', createdAt, expiresAt, tokenHash: hashToken(bootstrapToken), codeHmac: null,
      requested: { name: input.requestedName, localPart: input.requestedLocalPart ?? null, permissions: [...input.requestedPermissions] },
      connectionRoute: input.connectionRoute, runtime: { type: input.runtime.type, version: input.runtime.version },
      deliveryCapabilities: { ...input.deliveryCapabilities }, helper: input.helper ? { ...input.helper } : null, sourceHash: sourceHash(ip),
      ...(gateway ? { providerBrowserPoll: true } : {})
    };
    let code = null;
    await store.withTransaction([registrationLockKey(registration.id)], async () => {
      // A new code that collides with a live one is drawn again (§2).
      for (let attempt = 0; attempt < 8 && !code; attempt += 1) {
        const drawn = generateVerificationCode();
        const codeHmac = verificationCodeHmac(drawn.normalized, codeKey);
        const existing = await store.getJson(codeIndexPath(codeHmac));
        const holder = existing?.registrationId ? await store.getJson(registrationPath(existing.registrationId)) : null;
        if (holder && derivedStatus(holder, now()) === 'pending_claim') continue;
        await store.putJson(codeIndexPath(codeHmac), { registrationId: registration.id });
        registration.codeHmac = codeHmac;
        code = drawn;
      }
      if (!code) throw new Error('Could not draw a free verification code');
      await store.putJsonBatch([
        { path: tokenIndexPath(registration.tokenHash), value: { registrationId: registration.id } },
        { path: registrationPath(registration.id), value: registration },
        { path: createdBucketPath(createdAt, registration.id), value: { registrationId: registration.id, createdAt } }
      ]);
    });
    log({ event: 'agent_registration.created', source: registration.sourceHash, route: registration.connectionRoute });
    return {
      registrationId: registration.id, status: 'pending_claim', bootstrapToken,
      claim: { url: claimUrl, verificationCode: code.display, expiresAt }, expiresAt, pollAfterSeconds
    };
  }

  // §2: a body over 4,096 bytes is over a creation limit, logged like the others.
  function oversized(ip) {
    log({ event: 'agent_registration.limited', source: sourceHash(ip), route: null, reason: 'registration_limit' });
    return coded(429, 'RATE_LIMITED', 'Too many setup attempts. Try again later.', { retryAfterSeconds: 3600, reason: 'registration_limit' });
  }

  // The registration a bootstrap token belongs to, or REGISTRATION_TOKEN_INVALID (§4, §6.1 row 3).
  async function registrationForToken(rawToken, registrationId) {
    const invalid = () => coded(401, 'REGISTRATION_TOKEN_INVALID', 'This setup is no longer valid.');
    if (!isBootstrapToken(rawToken) || !registrationIdPattern.test(String(registrationId))) throw invalid();
    const tokenHash = hashToken(rawToken);
    const index = await store.getJson(tokenIndexPath(tokenHash));
    if (index?.registrationId !== registrationId) throw invalid();
    const registration = await store.getJson(registrationPath(registrationId));
    if (!registration || !timingEqual(registration.tokenHash, tokenHash)) throw invalid();
    return registration;
  }
  const recoveryExpired = () => coded(401, 'ACTIVATION_RECOVERY_EXPIRED', 'Setup can no longer be recovered. Ask the owner to reconnect.');

  // ------------------------------------------------------------------ §4 status

  async function status(rawToken, registrationId) {
    assertRegistrationEnabled();
    const registration = await registrationForToken(rawToken, registrationId);
    if (recoveryWindowOver(registration, now())) throw recoveryExpired();
    const retryAfterSeconds = pollLimiter.check(registration.id);
    if (retryAfterSeconds) throw coded(429, 'RATE_LIMITED', 'Polling too quickly.', { retryAfterSeconds, reason: 'poll_interval' });
    return statusView(registration, now());
  }

  // ------------------------------------------------------------------ §5 claim

  // §2 claim failures, at most 5 per human per 15 minutes. Each lookup, approve or reject
  // reserves one attempt before it runs, in the same transaction as the limit check, so a burst
  // of concurrent attempts cannot all slip under it. A wrong code keeps the reservation as the
  // failure; every other outcome (a match, a replay, any other error, a 5xx) releases it. The
  // counter's transactions never run inside a decision's lock.
  async function claimAttempt(human, work) {
    const attempt = await limits.reserveClaimAttempt(human.id);
    if (attempt.retryAfterSeconds) throw coded(429, 'RATE_LIMITED', 'Too many incorrect codes. Try again later.', { retryAfterSeconds: attempt.retryAfterSeconds, reason: 'claim_attempts' });
    let failed = false;
    try { return await work(); }
    catch (error) { failed = error?.code === 'CLAIM_CODE_INVALID'; throw error; }
    finally {
      if (!failed) await limits.releaseClaimAttempt(human.id, attempt.reserved).catch(() => log({ event: 'agent_registration.claim_release_failed' }));
    }
  }
  const codeInvalid = () => coded(404, 'CLAIM_CODE_INVALID', 'That code is not valid. Check the code your agent shows.');
  const codeMatches = (registration, normalized) => Boolean(registration && normalized && timingEqual(registration.codeHmac, verificationCodeHmac(normalized, codeKey)));
  // The identical body, apart from the code (which codeMatches binds and is never stored in clear).
  const decisionDigest = (kind, input) => {
    const { verificationCode: _code, ...rest } = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    return semanticDigest({ kind, body: rest });
  };

  // §5.3 precedence step 3, shared by approve and reject. Returns { replay } for this human's own
  // identical decision, or the pending registration; throws otherwise.
  async function decisionTarget(human, registration, normalized, kind, input) {
    if (codeMatches(registration, normalized) && registration.decision?.humanId === human.id) {
      if (registration.decision.kind === kind && registration.decision.digest === decisionDigest(kind, input)) return { replay: registration.decision.response };
      throw coded(409, 'CLAIM_ALREADY_DECIDED', kind === 'approve' && registration.decision.kind === 'approve'
        ? 'You already approved this agent. Withdraw it and have the agent register again to change the decision.'
        : 'You already decided this registration.');
    }
    if (!codeMatches(registration, normalized) || derivedStatus(registration, now()) !== 'pending_claim') throw codeInvalid();
    return { registration };
  }

  async function lookup(human, input) {
    assertRegistrationEnabled('This feature is not available.');
    return claimAttempt(human, () => lookupCode(input));
  }
  async function lookupCode(input) {
    const normalized = normalizeVerificationCode(input?.verificationCode);
    if (!normalized) throw codeInvalid();
    const index = await store.getJson(codeIndexPath(verificationCodeHmac(normalized, codeKey)));
    const registration = index?.registrationId ? await store.getJson(registrationPath(index.registrationId)) : null;
    if (!codeMatches(registration, normalized) || derivedStatus(registration, now()) !== 'pending_claim') throw codeInvalid();
    if (!validCodeOnlyBody(input)) throw coded(400, 'CLAIM_INVALID', 'The claim request is not valid.');
    const maximum = organizationMaximumPermissions();
    return {
      registrationId: registration.id, verificationCode: displayVerificationCode(normalized),
      requestedName: displayName(registration.requested.name, registration.requested.localPart || 'agent'), requestedLocalPart: registration.requested.localPart,
      requestedPermissions: registration.requested.permissions, grantablePermissions: registration.requested.permissions.filter(permission => maximum.includes(permission)),
      connectionRoute: registration.connectionRoute, runtime: registration.runtime, deliveryCapabilities: registration.deliveryCapabilities,
      createdAt: registration.createdAt, expiresAt: registration.expiresAt
    };
  }

  const workspaceNameOf = async inbox => {
    const parent = inbox.kind === 'agent' && inbox.parentInboxId ? await store.getJson(path.join('inboxes', inbox.parentInboxId, 'inbox.json')) : null;
    const source = parent || inbox;
    return displayName(source.name, 'workspace');
  };
  const localPartOf = address => String(address).split('@')[0];

  // The approval's target, resolved and authorized (§5.1 "Managing the target", CLAIM_FORBIDDEN).
  async function resolveTarget(human, target) {
    const forbidden = () => coded(403, 'CLAIM_FORBIDDEN', 'You cannot connect agents there.');
    if (target.kind === 'new_agent') {
      const inbox = await store.getJson(path.join('inboxes', target.workspaceInboxId, 'inbox.json'));
      if (!inbox || inbox.kind !== 'workspace' || inbox.status === 'removed' || !await canManageLive(human, inbox)) throw forbidden();
      return { inbox };
    }
    const directory = await store.getJson(path.join('directory', 'agents', `${target.agentId}.json`));
    const inbox = directory?.inboxId ? await store.getJson(path.join('inboxes', directory.inboxId, 'inbox.json')) : null;
    const agent = inbox ? await store.getJson(path.join('inboxes', inbox.id, 'agents', `${target.agentId}.json`)) : null;
    if (!agent || inbox.ownerAgentId !== agent.id || inbox.status === 'removed' || !await canManageLive(human, inbox)) throw forbidden();
    return { inbox, agent };
  }

  async function liveApprovalsBy(humanId) {
    let count = 0;
    for (const index of await store.listJson(approverIndexDir(humanId))) {
      if (liveApproval(await store.getJson(registrationPath(index.registrationId)), now())) count += 1;
    }
    return count;
  }

  async function approve(human, registrationId, input) {
    assertRegistrationEnabled('This feature is not available.');
    return claimAttempt(human, () => approveCode(human, registrationId, input));
  }
  async function approveCode(human, registrationId, input) {
    const normalized = normalizeVerificationCode(input?.verificationCode);
    const found = await decisionTarget(human, await getRegistration(registrationId), normalized, 'approve', input || {});
    if (found.replay) return found.replay;
    if (!validApproveBody(input)) {
      throw coded(400, 'CLAIM_INVALID', Array.isArray(input?.grantedPermissions) && !input.grantedPermissions.length ? 'Choose at least one permission.' : 'The approval request is not valid.');
    }
    const target = input.target;
    let address = null;
    if (target.kind === 'new_agent') {
      try { address = addressForLocalPart(normalizeLocalPart(target.localPart)); }
      catch { throw coded(400, 'CLAIM_INVALID', 'Choose another agent address.'); }
    }
    // §5.3 step 5 (CLAIM_FORBIDDEN): after the code, state and body checks, and before the target
    // is resolved, so every target gets the same answer. Not a claim failure: claimAttempt
    // releases the slot.
    const approverHint = hintForHuman(human, { production });
    if (!approverHint) throw coded(403, 'CLAIM_FORBIDDEN', 'Your account cannot approve agents: its sign-in email cannot be shown to the agent\'s host.');
    const resolved = await resolveTarget(human, target);
    const principalHumanId = target.kind === 'new_agent' ? human.id : resolved.agent.principalHumanId || resolved.inbox.ownerHumanId;
    const lockKeys = [registrationLockKey(registrationId), `human:${principalHumanId}:active-agents`, `human:${human.id}:agent-approvals`, ...(address ? [addressHoldLockKey(address)] : [])];
    const outcome = await withInboxMutation(resolved.inbox.id, async writeAudit => {
      // First decision wins: re-read under the lock.
      const again = await decisionTarget(human, await getRegistration(registrationId), normalized, 'approve', input);
      if (again.replay) return again.replay;
      const registration = again.registration;
      const at = nowIso();
      let agentFields;
      if (target.kind === 'existing_agent') {
        const agent = await store.getJson(path.join('inboxes', resolved.inbox.id, 'agents', `${target.agentId}.json`));
        if (!agent || agent.onboardingStatus !== 'approved' || !['active', 'paused'].includes(agent.status)) throw coded(409, 'AGENT_NOT_RECONNECTABLE', 'That agent cannot be reconnected here.');
        const current = newestActiveInstallation(await installations.list(resolved.inbox.id, agent));
        if ((current?.id ?? null) !== target.replacesInstallationId) throw coded(409, 'CLAIM_STALE', 'This agent\'s connection changed. Review it again.');
        if (!await agentSlots.agentHasLiveFamily(resolved.inbox.id, agent.id, now())) await assertSlot(principalHumanId, { excludingAgentId: agent.id });
        agentFields = { agentId: agent.id, agentInboxId: resolved.inbox.id, agentName: displayName(agent.name, localPartOf(agent.address)), address: agent.address, accessGeneration: agent.accessGeneration || 0, replacesInstallationId: target.replacesInstallationId };
      } else {
        if (await identityTaken(address) || await liveHold(address, registration.id)) throw coded(409, 'ADDRESS_TAKEN', 'That agent address is already taken.');
        await assertSlot(human.id);
        agentFields = { workspaceInboxId: resolved.inbox.id, organizationId: resolved.inbox.organizationId, agentName: displayName(target.name, localPartOf(address)), name: target.name, localPart: localPartOf(address), address };
      }
      if (!agentSlots.isUncappedHuman?.(human.id) && await liveApprovalsBy(human.id) >= approvalsAwaitingActivationPerHuman) throw coded(409, 'PENDING_ACTIVATION_LIMIT', 'Too many approvals are still waiting for their agents.');
      const activationExpiresAt = plus(at, activationWindowSeconds * 1000);
      const effective = effectivePermissions(registration.requested.permissions, input.grantedPermissions);
      const approved = {
        ...registration, status: 'approved', target: { kind: target.kind, ...agentFields }, workspaceName: await workspaceNameOf(resolved.inbox),
        approverHumanId: human.id, principalHumanId, approverEmailHint: approverHint, effectivePermissions: effective, policyProfile: 'default',
        approvedAt: at, activationExpiresAt
      };
      const response = {
        registrationId: registration.id, status: 'approved', target: target.kind, workspaceName: approved.workspaceName, agent: responseAgent(approved),
        effectivePermissions: effective, policyProfile: 'default', activationExpiresAt
      };
      approved.decision = { kind: 'approve', humanId: human.id, digest: decisionDigest('approve', input), response, decidedAt: at };
      const documents = [
        { path: registrationPath(registration.id), value: approved },
        { path: approvalSlotIndexPath(principalHumanId, registration.id), value: { registrationId: registration.id } },
        { path: approverIndexPath(human.id, registration.id), value: { registrationId: registration.id } },
        { path: decidedBucketPath(registration.createdAt, registration.id), value: { registrationId: registration.id } }
      ];
      // Replacing an ended hold: read, check, put, inside this transaction (§9).
      if (address) documents.push({ path: addressHoldPath(address), value: { registrationId: registration.id, expiresAt: activationExpiresAt } });
      await store.putJsonBatch(documents);
      await writeAudit('agent.registration_approved', { registrationId: registration.id, target: target.kind, ...(target.kind === 'existing_agent' ? { agentId: target.agentId } : { address }), effectivePermissions: effective, humanId: human.id }, at);
      return response;
    }, [], lockKeys);
    return outcome;
  }
  async function assertSlot(humanId, options = {}) {
    try { await agentSlots.assertActiveAgentSlot(humanId, options); }
    catch (error) {
      if (error.code === 'ACTIVE_AGENT_LIMIT') throw coded(409, 'ACTIVE_AGENT_LIMIT', 'You already have the maximum number of agents.');
      throw error;
    }
  }

  async function reject(human, registrationId, input) {
    assertRegistrationEnabled('This feature is not available.');
    return claimAttempt(human, () => rejectCode(human, registrationId, input));
  }
  async function rejectCode(human, registrationId, input) {
    const normalized = normalizeVerificationCode(input?.verificationCode);
    const found = await decisionTarget(human, await getRegistration(registrationId), normalized, 'reject', input || {});
    if (found.replay) return found.replay;
    if (!validCodeOnlyBody(input)) throw coded(400, 'CLAIM_INVALID', 'The claim request is not valid.');
    return store.withTransaction([registrationLockKey(registrationId)], async () => {
      const again = await decisionTarget(human, await getRegistration(registrationId), normalized, 'reject', input);
      if (again.replay) return again.replay;
      const at = nowIso();
      const response = { registrationId, status: 'rejected' };
      await store.putJsonBatch([
        { path: registrationPath(registrationId), value: { ...again.registration, status: 'rejected', rejectedAt: at, decision: { kind: 'reject', humanId: human.id, digest: decisionDigest('reject', input), response, decidedAt: at } } }
      ]);
      // A pending registration belongs to no workspace, so its rejection is logged, not audited
      // into an inbox feed.
      log({ event: 'agent.registration_rejected', registrationId, humanId: human.id });
      return response;
    });
  }

  // §5.4: approvals of registrations created in the last 24 hours whose target the caller can
  // manage now, whoever approved them.
  // Not behind the claim-failure lock: the list and withdraw are the §10 undo, and stay reachable.
  // The live provider check runs only for workspaces the human is a local member of.
  async function listClaims(human) {
    assertRegistrationEnabled('This feature is not available.');
    const current = now();
    const manageable = new Map();
    const canManageTarget = async target => {
      const inboxId = target.kind === 'new_agent' ? target.workspaceInboxId : target.agentInboxId;
      if (!manageable.has(inboxId)) {
        const inbox = await store.getJson(path.join('inboxes', inboxId, 'inbox.json'));
        manageable.set(inboxId, Boolean(inbox && inbox.status !== 'removed' && await memberOf(human, inbox.organizationId) && await canManageLive(human, inbox)));
      }
      return manageable.get(inboxId);
    };
    const claims = [];
    for (let hour = 0; hour <= 24; hour += 1) {
      const bucket = hourBucket(new Date(current.getTime() - hour * 3_600_000).toISOString());
      for (const index of await store.listJson(decidedBucketDir(bucket))) {
        const registration = await store.getJson(registrationPath(index.registrationId));
        if (!registration?.approvedAt || new Date(registration.createdAt) <= new Date(current.getTime() - listWindowMs)) continue;
        if (!await canManageTarget(registration.target)) continue;
        const status = derivedStatus(registration, current);
        claims.push({
          registrationId: registration.id, status, target: registration.target.kind, agent: responseAgent(registration),
          effectivePermissions: registration.effectivePermissions, approvedAt: registration.approvedAt, activationExpiresAt: registration.activationExpiresAt,
          installationId: status === 'activated' ? registration.installationId : null, approvedByMe: registration.approverHumanId === human.id
        });
      }
    }
    claims.sort((a, b) => b.approvedAt.localeCompare(a.approvedAt) || b.registrationId.localeCompare(a.registrationId));
    return { claims: claims.slice(0, ownerClaimListMax) };
  }

  async function withdraw(human, registrationId) {
    assertRegistrationEnabled('This feature is not available.');
    const notFound = () => coded(404, 'CLAIM_NOT_FOUND', 'That approval cannot be withdrawn.');
    const replayed = registration => registration?.status === 'withdrawn' && registration.withdrawnBy === 'owner' && registration.withdrawnByHumanId === human.id;
    const registration = await getRegistration(registrationId);
    if (replayed(registration)) return { registrationId, status: 'withdrawn' };
    if (!registration || derivedStatus(registration, now()) !== 'approved') throw notFound();
    const inboxId = registration.target.kind === 'new_agent' ? registration.target.workspaceInboxId : registration.target.agentInboxId;
    const inbox = await store.getJson(path.join('inboxes', inboxId, 'inbox.json'));
    if (!inbox || !await canManageLive(human, inbox)) throw notFound();
    const address = registration.target.kind === 'new_agent' ? registration.target.address : null;
    return withInboxMutation(inboxId, async writeAudit => {
      const current = await getRegistration(registrationId);
      if (replayed(current)) return { registrationId, status: 'withdrawn' };
      if (!current || derivedStatus(current, now()) !== 'approved') throw notFound();
      const at = nowIso();
      await store.putJson(registrationPath(registrationId), { ...current, status: 'withdrawn', withdrawnAt: at, withdrawnByHumanId: human.id, withdrawnBy: 'owner' });
      if (address && (await store.getJson(addressHoldPath(address)))?.registrationId === registrationId) await store.deleteJson(addressHoldPath(address));
      await writeAudit('agent.registration_withdrawn', { registrationId, humanId: human.id, target: current.target.kind }, at);
      return { registrationId, status: 'withdrawn' };
    }, [], [registrationLockKey(registrationId), `human:${registration.principalHumanId}:active-agents`, ...(address ? [addressHoldLockKey(address)] : [])]);
  }

  // §2 cleanup: each registration and everything indexed by it is kept at least 24 h after
  // creation and deleted by 25 h, whatever its state; a hold goes only if it still names this
  // registration. Recovery envelopes go when their 300 s window ends. Run every few minutes.
  async function deleteRegistration(registrationId, createdAt) {
    await store.withTransaction([registrationLockKey(registrationId)], async () => {
      const registration = await store.getJson(registrationPath(registrationId));
      if (registration) {
        const codeIndex = registration.codeHmac ? await store.getJson(codeIndexPath(registration.codeHmac)) : null;
        if (codeIndex?.registrationId === registrationId) await store.deleteJson(codeIndexPath(registration.codeHmac));
        if (registration.tokenHash) {
          await store.deleteJson(tokenIndexPath(registration.tokenHash));
          await store.deleteJson(activationRecoveryPath(registration.tokenHash));
        }
        // §14.6: an OAuth registration's code index, consent decision and their cleanup entries go with it, in this
        // transaction. A child that names another registration is not this one's and stays.
        if (registration.oauth) await deleteOAuthChildren(registration);
        const address = registration.target?.kind === 'new_agent' ? registration.target.address : null;
        if (address && (await store.getJson(addressHoldPath(address)))?.registrationId === registrationId) await store.deleteJson(addressHoldPath(address));
        if (registration.principalHumanId) await store.deleteJson(approvalSlotIndexPath(registration.principalHumanId, registrationId));
        if (registration.approverHumanId) await store.deleteJson(approverIndexPath(registration.approverHumanId, registrationId));
        await store.deleteJson(decidedBucketPath(registration.createdAt, registrationId));
        await store.deleteJson(registrationPath(registrationId));
      }
      await store.deleteJson(createdBucketPath(createdAt, registrationId));
    });
  }

  async function deleteOAuthChildren(registration) {
    const { codeHash, handleDigest } = registration.oauth;
    const code = codeHash ? await store.getJson(oauthCodePath(codeHash)) : null;
    if (code?.registrationId === registration.id) {
      await store.deleteJson(oauthCodePath(codeHash));
      await store.deleteJson(oauthCleanupPath(registration.createdAt, codeHash));
    }
    const decision = handleDigest ? await store.getJson(consentDecisionPath(handleDigest)) : null;
    if (decision?.registrationId === registration.id) {
      await store.deleteJson(consentDecisionPath(handleDigest));
      await store.deleteJson(oauthCleanupPath(registration.createdAt, handleDigest));
    }
  }

  // §14.6, the index sweep. A record with a registration is never deleted here while that registration exists: it is
  // revisited on a later run, and registration cleanup deletes it with its parent. An orphan (its registration gone,
  // for example deleted by an older server) is deleted, then its entry. A denial goes after its handleExpiresAt.
  //
  // Coverage is complete and each run is bounded. Without a cursor, the first run starts at the oldest indexed bucket,
  // however old. A run walks at most oauthCleanupBucketsPerRun hour buckets and saves where it stopped, so a backfill
  // resumes across runs and restarts. Once a walk reaches the current hour, the next one starts again at the earliest
  // bucket that still held a kept entry. The cursor is maintenance metadata only (no keys, records or grant state); it
  // is written only when its position changes, and not at all while nothing has ever been indexed. A cursor of an earlier
  // format (an upgrade) is treated as no cursor: the backfill starts at the oldest indexed bucket and then writes this one.
  async function sweepOAuthCleanup(current = now(), { maxBuckets = oauthCleanupBucketsPerRun } = {}) {
    const hourMs = 3_600_000;
    const currentHour = Math.floor(current.getTime() / hourMs) * hourMs;
    const stored = await store.getJson(oauthCleanupCursorPath);
    const cursor = stored?.version === oauthCleanupCursorVersion && Number.isFinite(stored.nextBucketStartMs) ? stored : null;
    let start;
    if (cursor) start = Math.floor(cursor.nextBucketStartMs / hourMs) * hourMs;
    else {
      const first = await store.firstJsonPath(oauthCleanupRoot);
      if (!first) return 0;
      start = Math.min(oauthCleanupBucketStartMs(String(first).replaceAll('\\', '/').split('/')[2]) ?? currentHour, currentHour);
    }
    let keptFromMs = Number.isFinite(cursor?.keptFromMs) ? cursor.keptFromMs : null;
    let deleted = 0;
    let hour = start;
    for (let walked = 0; hour <= currentHour && walked < maxBuckets; hour += hourMs, walked += 1) {
      const bucket = hourBucket(new Date(hour).toISOString());
      let kept = false;
      for (const entry of await store.listJson(oauthCleanupDir(bucket))) {
        if (!entry?.key || !/^[a-f0-9]{64}$/.test(entry.key)) continue;
        const recordPath = entry.kind === 'oauth_code' ? oauthCodePath(entry.key) : consentDecisionPath(entry.key);
        const lockKeys = [consentLockKey(entry.key), ...(entry.registrationId ? [registrationLockKey(entry.registrationId)] : [])];
        const removed = await store.withTransaction(lockKeys, async () => {
          const due = entry.registrationId === null
            ? Date.parse(entry.deleteAfter) <= current.getTime()
            : !(await store.getJson(registrationPath(entry.registrationId)));
          if (!due) return false;
          await store.deleteJson(recordPath);
          await store.deleteJson(oauthCleanupPath(entry.createdAt, entry.key));
          return true;
        });
        if (removed) deleted += 1; else kept = true;
      }
      if (kept && (keptFromMs === null || hour < keptFromMs)) keptFromMs = hour;
    }
    const next = hour > currentHour ? { nextBucketStartMs: keptFromMs ?? currentHour, keptFromMs: null } : { nextBucketStartMs: hour, keptFromMs };
    if (cursor?.nextBucketStartMs !== next.nextBucketStartMs || (cursor?.keptFromMs ?? null) !== next.keptFromMs) {
      await store.putJson(oauthCleanupCursorPath, { version: oauthCleanupCursorVersion, ...next, ranAt: current.toISOString() });
    }
    return deleted;
  }

  async function cleanup(current = now()) {
    let deleted = 0;
    for (const envelope of await store.listJson(activationRecoveryDir)) {
      if (envelope?.tokenHash && new Date(envelope.expiresAt) <= current) await store.deleteJson(activationRecoveryPath(envelope.tokenHash));
    }
    const cutoff = current.getTime() - retainRecordsMs;
    const cursor = await store.getJson(cleanupCursorPath);
    // Hour buckets by creation time, from the cursor (or 26 h before the cutoff) to the newest
    // hour holding a record past 24 h. A bucket is finished once its whole hour is past 24 h.
    let hour = Math.floor((cursor?.nextBucketStartMs ?? cutoff - 26 * 3_600_000) / 3_600_000) * 3_600_000;
    let nextBucketStartMs = hour;
    for (; hour <= cutoff; hour += 3_600_000) {
      const bucket = hourBucket(new Date(hour).toISOString());
      for (const index of await store.listJson(createdBucketDir(bucket))) {
        if (index?.registrationId && new Date(index.createdAt).getTime() <= cutoff) {
          await deleteRegistration(index.registrationId, index.createdAt);
          deleted += 1;
        }
      }
      if (hour + 3_600_000 <= cutoff) nextBucketStartMs = hour + 3_600_000;
    }
    await store.putJson(cleanupCursorPath, { nextBucketStartMs, ranAt: current.toISOString() });
    await sweepOAuthCleanup(current);
    return deleted;
  }

  // ------------------------------------------------------------------ agent-remote-auth §5 consent
  // The consent page's approval is the human claim (agent-remote-auth §5.2): the same target, permission, slot, hold and
  // management rules as approveCode, with the sealed handle in place of the verification code. Records are
  // agent-registration §14.3-§14.4's. The authorization code is returned to the caller once and stored only as a hash.

  const requestInvalid = () => coded(404, 'AUTHORIZATION_REQUEST_INVALID', 'This connection request is no longer valid. Start again from your assistant.');
  const consentAlreadyDecided = () => coded(409, 'CLAIM_ALREADY_DECIDED', 'You already decided this request.');
  const consentDigest = input => semanticDigest({ kind: 'oauth_consent', body: input });
  const validConsentBody = input => Boolean(input) && typeof input === 'object' && !Array.isArray(input) && !('verificationCode' in input) && validApproveBody(input);

  // agent-remote-auth §5.2, retrying an approval: derived from the stored registration alone, so a restart changes nothing.
  function consentDecided(registration) {
    const status = registration.status === 'activated' ? 'completed'
      : registration.status === 'withdrawn' ? 'withdrawn'
        : derivedStatus(registration, now()) === 'expired' ? 'expired' : 'pending_exchange';
    return {
      status, registrationId: registration.id, target: registration.target.kind, workspaceName: registration.workspaceName,
      agent: responseAgent(registration), effectivePermissions: registration.effectivePermissions, policyProfile: registration.policyProfile,
      codeExpiresAt: registration.activationExpiresAt
    };
  }

  // This human's decision on a handle, or null when nobody decided it. Another human's decision, an approval whose
  // registration was cleaned up, or a denial past its handle's expiry is indistinguishable from an unusable handle.
  async function consentDecisionFor(human, handleDigest) {
    const decision = await store.getJson(consentDecisionPath(handleDigest));
    if (!decision) return null;
    if (decision.humanId !== human.id) throw requestInvalid();
    if (decision.decision === 'denied') {
      if (new Date(decision.handleExpiresAt) <= now()) throw requestInvalid();
      return { decision };
    }
    const registration = await getRegistration(decision.registrationId);
    if (!registration?.oauth || registration.oauth.handleDigest !== handleDigest) throw requestInvalid();
    return { decision, registration };
  }

  // For the consent view (agent-remote-auth §5.1): this human's decision as shown to them, or null.
  async function consentViewDecision(human, handleDigest) {
    const found = await consentDecisionFor(human, handleDigest);
    if (!found) return null;
    return found.decision.decision === 'denied' ? { status: 'denied' } : consentDecided(found.registration);
  }

  // agent-remote-auth §5.2 (consent) and §8 (bootstrap issue): one approval module, with the sealed handle or the pre-registered
  // client in place of the verification code. `request` is the opened handle (consent; null when it cannot be opened) or the
  // bootstrap client (null when it is not a bootstrap client). Returns { decided } for this human's identical consent retry, or
  // { approved, code } with the code returned to the caller once and stored only as a hash.
  async function approveOAuth({ human, mode, request, handleDigest, input }) {
    assertRegistrationEnabled('This feature is not available.');
    const limited = await limits.consumeConsentApproval(human.id);
    if (!limited.allowed) throw coded(429, 'RATE_LIMITED', 'Too many approvals. Try again later.', { retryAfterSeconds: limited.retryAfterSeconds });
    const consent = mode === 'consent';
    const digest = consentDigest(input ?? null);
    const decidedReplay = found => {
      if (found.decision.decision === 'approved' && found.decision.bodyDigest === digest) return { decided: consentDecided(found.registration) };
      throw consentAlreadyDecided();
    };
    if (consent) {
      const existing = await consentDecisionFor(human, handleDigest);
      if (existing) return decidedReplay(existing);
    }
    if (!request) throw requestInvalid();
    if (!validConsentBody(input)) {
      throw coded(400, 'CLAIM_INVALID', Array.isArray(input?.grantedPermissions) && !input.grantedPermissions.length ? 'Choose at least one permission.' : 'The approval request is not valid.');
    }
    const target = input.target;
    let address = null;
    if (target.kind === 'new_agent') {
      try { address = addressForLocalPart(normalizeLocalPart(target.localPart)); }
      catch { throw coded(400, 'CLAIM_INVALID', 'Choose another agent address.'); }
    }
    const approverHint = hintForHuman(human, { production });
    if (!approverHint) throw coded(403, 'CLAIM_FORBIDDEN', 'Your account cannot approve agents: its sign-in email cannot be shown.');
    const resolved = await resolveTarget(human, target);
    const principalHumanId = target.kind === 'new_agent' ? human.id : resolved.agent.principalHumanId || resolved.inbox.ownerHumanId;
    const registrationId = store.id('registration');
    const lockKeys = [...(consent ? [consentLockKey(handleDigest)] : []), registrationLockKey(registrationId), `human:${principalHumanId}:active-agents`, `human:${human.id}:agent-approvals`, ...(address ? [addressHoldLockKey(address)] : [])];
    return withInboxMutation(resolved.inbox.id, async writeAudit => {
      // First decision wins: re-read under the handle's lock.
      if (consent) {
        const again = await consentDecisionFor(human, handleDigest);
        if (again) return decidedReplay(again);
      }
      let agentFields;
      if (target.kind === 'existing_agent') {
        const agent = await store.getJson(path.join('inboxes', resolved.inbox.id, 'agents', `${target.agentId}.json`));
        if (!agent || agent.onboardingStatus !== 'approved' || !['active', 'paused'].includes(agent.status)) throw coded(409, 'AGENT_NOT_RECONNECTABLE', 'That agent cannot be reconnected here.');
        const current = newestActiveInstallation(await installations.list(resolved.inbox.id, agent));
        if ((current?.id ?? null) !== target.replacesInstallationId) throw coded(409, 'CLAIM_STALE', 'This agent\'s connection changed. Review it again.');
        if (!await agentSlots.agentHasLiveFamily(resolved.inbox.id, agent.id, now())) await assertSlot(principalHumanId, { excludingAgentId: agent.id });
        agentFields = { agentId: agent.id, agentInboxId: resolved.inbox.id, agentName: displayName(agent.name, localPartOf(agent.address)), address: agent.address, accessGeneration: agent.accessGeneration || 0, replacesInstallationId: target.replacesInstallationId };
      } else {
        if (await identityTaken(address) || await liveHold(address)) throw coded(409, 'ADDRESS_TAKEN', 'That agent address is already taken.');
        await assertSlot(human.id);
        agentFields = { workspaceInboxId: resolved.inbox.id, organizationId: resolved.inbox.organizationId, agentName: displayName(target.name, localPartOf(address)), name: target.name, localPart: localPartOf(address), address };
      }
      if (!agentSlots.isUncappedHuman?.(human.id) && await liveApprovalsBy(human.id) >= approvalsAwaitingActivationPerHuman) throw coded(409, 'PENDING_ACTIVATION_LIMIT', 'Too many approvals are still waiting for their agents.');
      const at = nowIso();
      const activationExpiresAt = plus(at, (consent ? consentCodeTtlSeconds : bootstrapCodeTtlSeconds) * 1000);
      // A bootstrap body may name any registration permission (its request enum), but an OAuth grant holds only the four with a
      // scope (agent-remote-auth §4.3, §8), as consent's scope-derived request already does. receive_agent_messages stays
      // mandatory and narrowing is unchanged (effectivePermissions).
      const requestedPermissions = consent ? request.permissions : oauthGrantablePermissions(input.grantedPermissions);
      const effective = effectivePermissions(requestedPermissions, input.grantedPermissions);
      const code = `${consent ? 'envoi_oauth_code_' : 'envoi_boot_'}${crypto.randomBytes(32).toString('base64url')}`;
      const codeHash = sha256Hex(code);
      const connectionRoute = consent ? request.connectionRoute : 'provider_connector';
      const registration = {
        id: registrationId, status: 'approved', createdAt: at, connectionRoute,
        runtime: { type: connectionRoute === 'provider_connector' ? 'provider' : 'remote_mcp', version: null },
        requested: { permissions: [...requestedPermissions] },
        target: { kind: target.kind, ...agentFields }, workspaceName: await workspaceNameOf(resolved.inbox),
        approverHumanId: human.id, principalHumanId, approverEmailHint: approverHint, effectivePermissions: effective, policyProfile: 'default',
        approvedAt: at, activationExpiresAt,
        oauth: {
          source: mode, clientId: request.clientId, redirectUri: consent ? request.redirectUri : null, codeChallenge: consent ? request.codeChallenge : null,
          resource: request.resource, scope: scopeForPermissions(effective), handleDigest: consent ? handleDigest : null, codeHash, codeUsedAt: null
        },
        decision: { kind: 'approve', humanId: human.id, digest, decidedAt: at }
      };
      const documents = [
        { path: registrationPath(registrationId), value: registration },
        { path: oauthCodePath(codeHash), value: { codeHash, kind: consent ? 'authorization_code' : 'bootstrap_code', registrationId, clientId: request.clientId, expiresAt: activationExpiresAt, usedAt: null } },
        { path: oauthCleanupPath(at, codeHash), value: { kind: 'oauth_code', key: codeHash, registrationId, createdAt: at, deleteAfter: null } },
        { path: createdBucketPath(at, registrationId), value: { registrationId, createdAt: at } },
        { path: decidedBucketPath(at, registrationId), value: { registrationId } },
        { path: approvalSlotIndexPath(principalHumanId, registrationId), value: { registrationId } },
        { path: approverIndexPath(human.id, registrationId), value: { registrationId } }
      ];
      if (consent) {
        documents.push(
          { path: consentDecisionPath(handleDigest), value: { handleDigest, humanId: human.id, decision: 'approved', bodyDigest: digest, registrationId, decidedAt: at, handleExpiresAt: request.expiresAt } },
          { path: oauthCleanupPath(at, handleDigest), value: { kind: 'consent_decision', key: handleDigest, registrationId, createdAt: at, deleteAfter: null } }
        );
      }
      if (address) documents.push({ path: addressHoldPath(address), value: { registrationId, expiresAt: activationExpiresAt } });
      await store.putJsonBatch(documents);
      await writeAudit('agent.registration_approved', { registrationId, target: target.kind, ...(target.kind === 'existing_agent' ? { agentId: target.agentId } : { address }), effectivePermissions: effective, humanId: human.id, connectionRoute }, at);
      const { status: _pending, ...approved } = consentDecided(registration);
      return { approved, code };
    }, [], lockKeys);
  }
  const approveConsent = (human, request, handleDigest, input) => approveOAuth({ human, mode: 'consent', request, handleDigest, input });
  // agent-remote-auth §8: the owner issues a single-use bootstrap code for a pre-registered provider client. `client` is that
  // client when it is a bootstrap client whose route flag is on (else null: 404 AUTHORIZATION_REQUEST_INVALID, after the rate
  // limit); `resource` is the resource its family will be bound to. `input` is the body without clientId.
  const approveBootstrap = (human, client, resource, input) => approveOAuth({
    human, mode: 'bootstrap', request: client ? { clientId: client.clientId, resource } : null, handleDigest: null, input
  });

  // agent-remote-auth §5.3: nothing is created but the denial's decision record (agent-registration §14.4), which lives
  // until the handle expires. The same human repeating it gets the same outcome.
  async function denyConsent(human, request, handleDigest) {
    assertRegistrationEnabled('This feature is not available.');
    const denied = found => {
      if (found.decision.decision === 'denied') return { denied: true };
      throw consentAlreadyDecided();
    };
    const existing = await consentDecisionFor(human, handleDigest);
    if (existing) return denied(existing);
    if (!request) throw requestInvalid();
    return store.withTransaction([consentLockKey(handleDigest)], async () => {
      const again = await consentDecisionFor(human, handleDigest);
      if (again) return denied(again);
      const at = nowIso();
      await store.putJsonBatch([
        { path: consentDecisionPath(handleDigest), value: { handleDigest, humanId: human.id, decision: 'denied', bodyDigest: null, registrationId: null, decidedAt: at, handleExpiresAt: request.expiresAt } },
        { path: oauthCleanupPath(at, handleDigest), value: { kind: 'consent_decision', key: handleDigest, registrationId: null, createdAt: at, deleteAfter: request.expiresAt } }
      ]);
      return { denied: true };
    });
  }

  return { create, oversized, status, lookup, approve, reject, listClaims, withdraw, cleanup, registrationForToken, liveHold, addressTaken, getRegistration, recoveryExpired,
    approveConsent, approveBootstrap, denyConsent, consentViewDecision, sweepOAuthCleanup };
}

export { tokenLikePattern, unsafeNameCharacters };
