import './envoi-environment-bootstrap.js';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { reapAgentRotationRecovery } from './agent-rotation-recovery.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { FileStore } from './storage.js';
import { joinWaitlist } from './waitlist.js';
import { createWaitlistSheetSync } from './waitlist-sheet-sync.js';
import { workspaceHistory, parseHistoryCursors } from './workspace-history.js';
import { fetchEventPage } from './event-history.js';
import { createHumanAuth } from './human-auth.js';
import { authFlowCookieHeader, authFlowCookieName, createCsrfToken, csrfCookieHeader, csrfCookieName, membershipCanManage, parseCookies, retiredCookieClears, retiredCookiesIn, sessionCookieHeader, sessionCookieName, verifyCsrfRequest } from './workos-auth.js';
import { installSessionCookieResponse } from './session-response.js';
import { operationalBacklogSnapshot } from './operational-backlog.js';
import { DeliveryWorker } from './delivery-worker.js';
import { createConsumerIdentity, consumerLogger } from './consumer-identity.js';
import { createEmailTransport } from './email-transport.js';
import { createProtocolMessage } from './protocol-v1.js';
import { createObjectStorageAdapter, DocumentObjectMetadataStore, FailClosedScanner, HttpMalwareScanner, ObjectStorageService, PersistentQuotaLedger } from './object-storage.js';
import { PostgresMalwareScanJobStore } from './object-scan-lifecycle.js';
import { validateProductionConfiguration } from './production-config.js';
import { evaluateReadiness } from './readiness.js';
import { dependencyReadinessChecks } from './dependency-readiness.js';
import { configuredDeploymentIdentity, ensureDeploymentIdentity, stagingUncappedAgentHumanIds, verifyDeploymentIdentityBeforeInit } from './deployment-identity.js';
import { clientIp, errorBody, publicHttpError, requestIdFrom } from './http-security.js';
import { createPkcePair, exchangeCalendarAuthorizationCode } from './calendar-oauth.js';
import { assertSafeIdentifier, assertSafeRequestTarget, resolvePathWithin } from './path-safety.js';
import { marketingRoute, nonceStaticHtml } from './marketing-routes.js';
import { claimIdempotency, completeIdempotency, replayResponse, scopedIdempotencyPath, semanticDigest, validateIdempotencyKey } from './idempotency.js';
import { humanConversationMessagingEnabled } from './human-messaging.js';
import { createHumanInstructions, isHumanInstruction, assertHumanInstructionWork, humanInstructionCaseDocuments, humanInstructionReplyDocuments, validateHumanInstructionInput } from './human-instructions.js';
import { handleAgentMcp } from './agent-mcp.js';
import { enrollmentConnectionStatus, validateConnectionReport, validateConnectorRuntime } from './agent-connection.js';
import {
  assertExactBinding,
  createWorkspacePolicy,
  evaluatePolicy,
  requiresPolicyEvaluation,
  valueDigest,
  verifyDecisionChain,
  verifyDecisionRecord
} from './policy-engine.js';
import {
  acceptProposal,
  advanceNativeCase,
  addPolicyEvaluation,
  addProposal,
  appendEvent,
  applyAgentAction,
  applyHumanAction,
  completeCase,
  counterProposal,
  createCase as createAgentCase,
  isActiveCase,
  transitionCase,
  verifiedHumanCaseDecision
} from './agent-interface.js';
import { projectCaseForHuman, projectWorkspaceForHuman } from './human-projection.js';
import { attachInboxPreferencesToView, createInboxPreferencesHttp } from './inbox-preferences-http.js';
import { getPrefsForCases } from './inbox-preferences.js';
import { createProviderMembershipCache, streamRecheckMs } from './provider-membership.js';
import { agentPresenceDir, agentPresencePath, agentStatusPresence, createPresenceRecorder, ownerConnection, reportedFamily } from './agent-presence.js';
import { createAgentSlots, legacyApprovalPermissions } from './agent-approval.js';
import { createInstallationReader, installationSummary, ownerInstallationList, publicInstallation } from './agent-installations.js';
import { readOnboardingFlags, routeAvailability } from './onboarding-flags.js';
import { activationRecoveryPath, activationRecoverySeconds, addressHoldLockKey, addressHoldPath, createAgentRegistrations, derivedStatus, oauthCodePath, recoveryWindowOver, registrationBodyMaxBytes, registrationLockKey } from './agent-registration.js';
import { decryptActivation, displayName, encryptActivation, validActivationId, verificationCodeKey } from './agent-registration-codes.js';
import { registrationPath } from './agent-approval.js';
import { installationPath } from './agent-installations.js';
import { deliveryModeAvailable, remoteRouteAvailable, routeAvailable } from './onboarding-flags.js';
import { authenticateClient, bootstrapGrantParameters, codeGrantParameters, grantTypes, insufficientScopeChallenge, mcpChallenge, oauthError, oauthFamilyLockKey, oauthRefreshRecoveryDir, oauthRefreshRecoveryPath, oauthSuccess, oauthTokenTypes, openRefreshRecovery, parseTokenForm, pkceMatches, refreshGrantParameters, refreshRecoverySeconds, sameScopes, sealRefreshRecovery, tokenRequestMaxBytes, tokenResponse } from './agent-remote-auth-token.js';
import { createPollLimiter, createRegistrationLimits } from './agent-registration-limits.js';
import { allowedCaseTools, isHumanDecision, caseSessionTokenPath, caseSessionTokenPrefix, caseSessionsHeartbeatMs, createCaseSessions, firstCondition, leaseStaleReason, publicSessionEnd, sessionConditions, validCaseSessionId, validLeaseToken, workKindOf } from './case-sessions.js';
import { createCaseSessionMcp } from './case-session-mcp.js';
import { authorityToolError, createCaseTools, caseToolError, humanDecisionWorkMessage } from './case-tools.js';
import { createCaseReferenceCodec, projectCaseSnapshot } from './case-tools-projection.js';
import { createHttpWake } from './http-wake.js';
import { createMcpWakeTools } from './mcp-wake-tools.js';
import { createProviderEventWake } from './provider-event-wake.js';
import { createCanonicalBrowserGateway } from './provider-browser-poll-canonical.js';
import { commitment, createMonadPermissionLayer, permissionSnapshot } from './monad-permissions.js';
import { createMonadAccess } from './monad-access.js';
import { providerGatewayAuthority, browserPollAvailable } from './onboarding-flags.js';
import { authorizationServerMetadata, consentClient, consentRedirect, createAuthorizationRequestSealer, createAuthorizeRequestHandler, createClientMetadataFetch, createClientResolver, oauthErrorDescriptions, oauthGrantablePermissions, parsePreRegisteredClients, permissionsForScopes, protectedResourceMetadata, remoteAuthEnabled, remoteAuthEndpointServed, remoteAuthLimits, remoteAuthOrigin, remoteAuthScopes, resourceFor, scopeForPermissions } from './agent-remote-auth.js';
import { organizationMaximumPermissions } from './agent-approval.js';
import { sha256Hex } from './agent-registration.js';
import { createWakeDestination } from './http-wake-destination.js';

const productionConfig = validateProductionConfiguration();
// agent-registration v1 §1: fails closed in every mode, before anything starts.
const onboardingFlags = readOnboardingFlags();
// agent-remote-auth v1 §3.2: pre-registered clients are operator configuration; an invalid entry fails closed.
const oauthClients = parsePreRegisteredClients(process.env.ENVOI_OAUTH_CLIENTS);
const releaseSha = process.env.ENVOI_RELEASE_SHA || null;
const deploymentIdentity = configuredDeploymentIdentity();
// Connectors refuse to start unless /health reports exactly this identity, so it changes
// only together with the connector check (integrations/connector/core.ts).
const serviceIdentity = 'envoi';
const host = process.env.ENVOI_HOST || '127.0.0.1';
const port = Number(process.env.ENVOI_PORT || 8787);
const dataDir = path.resolve(process.env.ENVOI_DATA_DIR || 'data');
const maxBodyBytes = Number(process.env.ENVOI_MAX_BODY_BYTES || 10 * 1024 * 1024);
const corsOrigin = process.env.ENVOI_CORS_ORIGIN || 'http://localhost:3000';
const agentDomain = process.env.ENVOI_AGENT_DOMAIN || 'envoi.mail';
const deliveryMaxAttempts = Number(process.env.ENVOI_DELIVERY_MAX_ATTEMPTS || 5);
const externalEmailEnabled = process.env.ENVOI_ENABLE_EXTERNAL_EMAIL === 'true';
const calendarWritesEnabled = process.env.ENVOI_ENABLE_CALENDAR_WRITES === 'true';
const consequentialActionsEnabled = process.env.ENVOI_ENABLE_CONSEQUENTIAL_ACTIONS === 'true';
const policyActiveKeyId = process.env.ENVOI_POLICY_ACTIVE_KEY_ID || 'primary';
const policySigningKeys = (() => {
  const configured = process.env.ENVOI_POLICY_SIGNING_KEYS ? JSON.parse(process.env.ENVOI_POLICY_SIGNING_KEYS) : {};
  const single = process.env.ENVOI_POLICY_SIGNING_KEY || process.env.ENVOI_DATA_ENCRYPTION_KEY || 'sinaloa-development-policy-signing-key';
  return { ...configured, [policyActiveKeyId]: configured[policyActiveKeyId] || single };
})();
const policyKeyring = Object.freeze({ activeKeyId: policyActiveKeyId, keys: Object.freeze(policySigningKeys) });
const emailTransport = createEmailTransport();
const agentAccessTokenTtlSeconds = Math.max(60, Number(process.env.ENVOI_AGENT_ACCESS_TOKEN_TTL_SECONDS || 900));
const agentRefreshTokenTtlDays = Math.max(1, Number(process.env.ENVOI_AGENT_REFRESH_TOKEN_TTL_DAYS || 30));
const agentRotationRecoveryMs = 5 * 60_000;
const configuredAgentWorkLeaseMs = Number(process.env.ENVOI_AGENT_WORK_LEASE_MS || 60_000);
const agentWorkLeaseMs = Number.isFinite(configuredAgentWorkLeaseMs) ? Math.max(1_000, Math.min(300_000, configuredAgentWorkLeaseMs)) : 60_000;
const configuredAgentWorkMaxAttempts = Number(process.env.ENVOI_AGENT_WORK_MAX_ATTEMPTS || 5);
const agentWorkMaxAttempts = Number.isSafeInteger(configuredAgentWorkMaxAttempts) && configuredAgentWorkMaxAttempts > 0 ? Math.min(20, configuredAgentWorkMaxAttempts) : 5;
const configuredAgentWorkRetryBaseMs = Number(process.env.ENVOI_AGENT_WORK_RETRY_BASE_MS || 5_000);
const agentWorkRetryBaseMs = Number.isSafeInteger(configuredAgentWorkRetryBaseMs) && configuredAgentWorkRetryBaseMs > 0 ? configuredAgentWorkRetryBaseMs : 5_000;
const calendarProviders = Object.freeze({
  google: {
    label: 'Google Calendar',
    clientId: process.env.GOOGLE_CALENDAR_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CALENDAR_CLIENT_SECRET,
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.events.freebusy']
  },
  outlook: {
    label: 'Outlook Calendar',
    clientId: process.env.MICROSOFT_CALENDAR_CLIENT_ID,
    clientSecret: process.env.MICROSOFT_CALENDAR_CLIENT_SECRET,
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: ['openid', 'email', 'offline_access', 'User.Read', 'Calendars.ReadWrite']
  }
});
const allowedPermissions = new Set(['send_agent_messages', 'receive_agent_messages', 'create_assets', 'execute_cases', 'use_email_transport']);
const actionPermission = actionKey => actionKey.startsWith('message.') ? 'send_agent_messages' : actionKey.startsWith('email.') ? 'use_email_transport' : 'execute_cases';
const acknowledgementStateRank = Object.freeze({ delivered: 0, acknowledged: 1, processed: 2 });
if (process.env.ENVOI_EXPECTED_DATABASE_FINGERPRINT && !process.env.DATABASE_URL) throw new Error('ENVOI_EXPECTED_DATABASE_FINGERPRINT requires DATABASE_URL');
const consumerIdentity = createConsumerIdentity({ connectionString: process.env.DATABASE_URL, releaseSha });
const logConsumer = consumerLogger(consumerIdentity);
const store = process.env.DATABASE_URL ? new (await import('./postgres-storage.js')).PostgresStore(process.env.DATABASE_URL, { applicationName: consumerIdentity.applicationName }) : new FileStore(dataDir);
const monadPermissions = createMonadPermissionLayer({
  store, enabled: process.env.ENVOI_MONAD_PERMISSIONS === 'true'
});
const monadAccess = createMonadAccess({
  store, available: monadPermissions.enabled,
  paidOrganizationIds: process.env.ENVOI_MONAD_PAID_ORGANIZATION_IDS
});
const monadRequest = Symbol('monad-request');
const monadPermissionDenied = Symbol('monad-permission-denied');
const monadViolationRetry = monadPermissions.enabled
  ? setInterval(() => { void monadPermissions.flushViolations().catch(() => {}); }, 30_000)
  : null;
monadViolationRetry?.unref?.();
if (monadPermissions.enabled) void monadPermissions.flushViolations().catch(() => {});
const auth = createHumanAuth(store);
const presenceRecorder = createPresenceRecorder({
  store,
  now: () => store.now(),
  familyPath: (inboxId, agentId, familyId) => agentCredentialFamilyPath(inboxId, agentId, familyId),
  // Name and code only: messages can carry storage paths.
  onError: error => console.error(JSON.stringify({ event: 'envoi.agent_presence_write_failed', name: error?.name, code: error?.code }))
});
const rememberedProviderMembership = createProviderMembershipCache({ lookup: (userId, organizationId) => auth.getOrganizationMembership(userId, organizationId) });
// How long an open event stream trusts one answer from WorkOS before asking again.
const streamMembershipRecheckMs = streamRecheckMs(process.env.ENVOI_STREAM_MEMBERSHIP_RECHECK_MS);
const streams = new Map();
const rateBuckets = new Map();
const emailRateBuckets = new Map();
const sseCounts = new Map();
const requestTimeoutMs = Number(process.env.ENVOI_REQUEST_TIMEOUT_MS || 30_000);
const calendarOAuthTimeoutMs = Number(process.env.ENVOI_CALENDAR_OAUTH_TIMEOUT_MS || 15_000);
const maxSsePerPrincipal = Number(process.env.ENVOI_MAX_SSE_PER_PRINCIPAL || 10);
const objectStorageProvider = process.env.ENVOI_OBJECT_STORAGE_PROVIDER || 'local';
const objectMaxBytes = Number(process.env.ENVOI_OBJECT_MAX_BYTES || 25 * 1024 * 1024);
const objectQuotaBytes = Number(process.env.ENVOI_WORKSPACE_OBJECT_QUOTA_BYTES || 1024 * 1024 * 1024);
const objectStorageRequestTimeoutMs = Number(process.env.ENVOI_S3_REQUEST_TIMEOUT_MS || 30_000);
const objectScanWorkerIntervalMs = Number(process.env.ENVOI_SCAN_WORKER_INTERVAL_MS || 1_000);
const objectScanRetentionIntervalMs = Number(process.env.ENVOI_SCAN_RETENTION_INTERVAL_MS || 60_000);
const operationalBacklogLogIntervalMs = Number(process.env.ENVOI_OPERATIONAL_BACKLOG_LOG_INTERVAL_MS || 60_000);
if (!Number.isSafeInteger(objectScanWorkerIntervalMs) || objectScanWorkerIntervalMs < 1) throw new TypeError('ENVOI_SCAN_WORKER_INTERVAL_MS must be a positive integer');
if (!Number.isSafeInteger(objectScanRetentionIntervalMs) || objectScanRetentionIntervalMs < 1) throw new TypeError('ENVOI_SCAN_RETENTION_INTERVAL_MS must be a positive integer');
if (!Number.isSafeInteger(operationalBacklogLogIntervalMs) || operationalBacklogLogIntervalMs < 10_000) throw new TypeError('ENVOI_OPERATIONAL_BACKLOG_LOG_INTERVAL_MS must be an integer of at least 10000');
const objectAllowedMimeTypes = (process.env.ENVOI_OBJECT_ALLOWED_MIME_TYPES || 'application/pdf,image/jpeg,image/png,text/plain,text/csv,application/json').split(',').map(value => value.trim()).filter(Boolean);
const objectStorageAdapter = createObjectStorageAdapter(objectStorageProvider === 's3' ? {
  provider: 's3',
  endpoint: process.env.ENVOI_S3_ENDPOINT || `https://s3.${process.env.ENVOI_S3_REGION || 'ca-central-1'}.amazonaws.com`,
  bucket: process.env.ENVOI_S3_BUCKET,
  region: process.env.ENVOI_S3_REGION || 'ca-central-1',
  accessKeyId: process.env.ENVOI_S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.ENVOI_S3_SECRET_ACCESS_KEY,
  sessionToken: process.env.ENVOI_S3_SESSION_TOKEN,
  requestTimeoutMs: objectStorageRequestTimeoutMs,
  maxObjectBytes: objectMaxBytes,
  allowedMimeTypes: objectAllowedMimeTypes
} : { provider: 'local', root: path.join(dataDir, 'object-storage'), maxObjectBytes: objectMaxBytes, allowedMimeTypes: objectAllowedMimeTypes });
const objectScanner = process.env.ENVOI_MALWARE_SCANNER_URL ? new HttpMalwareScanner({ endpoint: process.env.ENVOI_MALWARE_SCANNER_URL, token: process.env.ENVOI_MALWARE_SCANNER_TOKEN || null }) : new FailClosedScanner();
const scanJobStore = process.env.DATABASE_URL ? new PostgresMalwareScanJobStore(store) : null;
const objectQuotaLedger = new PersistentQuotaLedger(store, { defaultQuotaBytes: objectQuotaBytes });
const scanLifecycle = {
  maxAttempts: Number(process.env.ENVOI_SCAN_MAX_ATTEMPTS || 5),
  leaseMs: Number(process.env.ENVOI_SCAN_LEASE_MS || 60_000),
  retryBaseMs: Number(process.env.ENVOI_SCAN_RETRY_BASE_MS || 5_000),
  retryMaxMs: Number(process.env.ENVOI_SCAN_RETRY_MAX_MS || 15 * 60_000),
  infectedRetentionMs: Number(process.env.ENVOI_SCAN_INFECTED_RETENTION_MS || 30 * 24 * 60 * 60_000),
  deadLetterRetentionMs: Number(process.env.ENVOI_SCAN_DEAD_LETTER_RETENTION_MS || 7 * 24 * 60 * 60_000),
  completedJobRetentionMs: Number(process.env.ENVOI_SCAN_COMPLETED_JOB_RETENTION_MS || 90 * 24 * 60 * 60_000),
  retentionRetryMs: Number(process.env.ENVOI_SCAN_RETENTION_RETRY_MS || 60 * 60_000)
};
const objectStorage = new ObjectStorageService({ adapter: objectStorageAdapter, metadataStore: new DocumentObjectMetadataStore(store), quotaLedger: objectQuotaLedger, scanner: objectScanner, scanJobStore, scanLifecycle, maxObjectBytes: objectMaxBytes, allowedMimeTypes: objectAllowedMimeTypes });
if (scanJobStore && !['processNextScan', 'reapScanRetention'].every(method => typeof objectStorage[method] === 'function')) throw new TypeError('Object storage durable scan lifecycle is not configured');
const readinessTimeoutMs = Number(process.env.ENVOI_READINESS_TIMEOUT_MS || 5_000);

let scanLifecycleStopping = false;
let objectScanRun = null;
let objectScanRetentionRun = null;
const scanWorkerId = `scan-${process.pid}-${crypto.randomUUID()}`;
const scanRetentionWorkerId = `scan-retention-${process.pid}-${crypto.randomUUID()}`;

function runObjectScans() {
  if (!scanJobStore || scanLifecycleStopping || objectScanRun) return objectScanRun;
  const run = (async () => {
    while (!scanLifecycleStopping && await objectStorage.processNextScan(scanWorkerId)) {}
  })().catch(error => console.error('Object scan worker failed', { name: error?.name || 'Error', code: error?.code || 'SCAN_FAILED' }))
    .finally(() => { if (objectScanRun === run) objectScanRun = null; });
  objectScanRun = run;
  return run;
}

function runObjectScanRetention() {
  if (!scanJobStore || scanLifecycleStopping || objectScanRetentionRun) return objectScanRetentionRun;
  const run = (async () => {
    while (!scanLifecycleStopping && await objectStorage.reapScanRetention(scanRetentionWorkerId)) {}
  })().catch(error => console.error('Object scan retention worker failed', { name: error?.name || 'Error', code: error?.code || 'SCAN_RETENTION_FAILED' }))
    .finally(() => { if (objectScanRetentionRun === run) objectScanRetentionRun = null; });
  objectScanRetentionRun = run;
  return run;
}

async function readinessReport() {
  const checks = dependencyReadinessChecks({ store, adapter: objectStorageAdapter,
    provider: objectStorageProvider, env: process.env, externalEmailEnabled, emailTransport });
  const report = await evaluateReadiness(checks, { timeoutMs: readinessTimeoutMs, at: store.now() });
  return { ...report, service: serviceIdentity, mode: productionConfig.mode, configurationValidated: productionConfig.validated, releaseSha, deploymentEnvironment: deploymentIdentity.environment };
}

const rateIdentity = req => hashSecret(String(req.headers.authorization || req.headers.cookie || clientIp(req))).slice(0, 32);
const ratePolicy = (req, pathname) => {
  if (pathname === '/api/waitlist') return { limit: 10, windowMs: 60 * 60_000 };
  if (pathname === '/api/email-webhooks/resend') return { limit: 600, windowMs: 60_000 };
  if (pathname.startsWith('/api/auth/')) return { limit: 60, windowMs: 60_000 };
  if (pathname.includes('/asset-uploads') || pathname.startsWith('/api/object-storage/')) return { limit: 120, windowMs: 60_000 };
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return { limit: 180, windowMs: 60_000 };
  return { limit: 1200, windowMs: 60_000 };
};
const consumeRateLimit = (req, res, pathname, identityKey = rateIdentity(req)) => {
  const policy = ratePolicy(req, pathname);
  const now = Date.now();
  const key = `${identityKey}:${req.method}:${policy.limit}`;
  let bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) bucket = { count: 0, resetAt: now + policy.windowMs };
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  if (rateBuckets.size > 50_000) for (const [candidate, value] of rateBuckets) if (value.resetAt <= now) rateBuckets.delete(candidate);
  res.setHeader('ratelimit-limit', String(policy.limit));
  res.setHeader('ratelimit-remaining', String(Math.max(0, policy.limit - bucket.count)));
  res.setHeader('ratelimit-reset', String(Math.ceil(bucket.resetAt / 1000)));
  if (bucket.count <= policy.limit) return true;
  res.setHeader('retry-after', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
  return false;
};
const consumeExternalEmailLimit = (agentId, recipientEmail) => {
  const now = Date.now();
  const windowMs = 60 * 60_000;
  const limits = [
    { key: `agent:${agentId}`, limit: Number(process.env.ENVOI_EXTERNAL_EMAIL_AGENT_HOURLY_LIMIT || 100) },
    { key: `recipient:${agentId}:${externalContactKey(recipientEmail)}`, limit: Number(process.env.ENVOI_EXTERNAL_EMAIL_RECIPIENT_HOURLY_LIMIT || 20) }
  ];
  for (const policy of limits) {
    const current = emailRateBuckets.get(policy.key);
    if (current && current.resetAt > now && current.count >= policy.limit) return false;
  }
  for (const policy of limits) {
    const current = emailRateBuckets.get(policy.key);
    emailRateBuckets.set(policy.key, !current || current.resetAt <= now ? { count: 1, resetAt: now + windowMs } : { ...current, count: current.count + 1 });
  }
  if (emailRateBuckets.size > 20_000) for (const [key, value] of emailRateBuckets) if (value.resetAt <= now) emailRateBuckets.delete(key);
  return true;
};

const applyHeaders = (res, origin, nonce) => {
  const origins = corsOrigin.split(',').map((item) => item.trim());
  const allowedOrigin = corsOrigin === '*' ? '*' : origins.includes(origin) ? origin : '';
  if (allowedOrigin) {
    res.setHeader('access-control-allow-origin', allowedOrigin);
    res.setHeader('vary', 'Origin');
    if (allowedOrigin !== '*') res.setHeader('access-control-allow-credentials', 'true');
  }
  res.setHeader('access-control-allow-headers', 'content-type, authorization, idempotency-key, mcp-protocol-version, if-none-match, x-request-id, x-envoi-csrf, x-envoi-expected-human, traceparent, x-amz-checksum-sha256, x-amz-meta-sinaloa-sha256');
  res.setHeader('access-control-allow-methods', 'GET, HEAD, POST, PUT, OPTIONS');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  res.setHeader('x-dns-prefetch-control', 'off');
  res.setHeader('content-security-policy', `default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; form-action 'self'; script-src 'nonce-${nonce}' 'strict-dynamic' https://*.posthog.com; style-src 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' https://www.envoi-agents.com https://*.posthog.com`);
  if (process.env.ENVOI_AUTH_MODE === 'production') res.setHeader('strict-transport-security', 'max-age=63072000; includeSubDomains; preload');
};
const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const redirect = (res, location, headers = {}) => { res.writeHead(302, { location, 'cache-control': 'no-store', ...headers }); res.end(); };
const fail = (res, status, message) => json(res, status, { error: message });
const slugify = (value) => value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
const reservedAgentLocalParts = new Set(['admin', 'administrator', 'agents', 'abuse', 'billing', 'contact', 'help', 'info', 'mail', 'noreply', 'no-reply', 'postmaster', 'root', 'security', 'support', 'system']);
function normalizeAgentLocalPart(value) {
  if (typeof value !== 'string') throw Object.assign(new Error('Agent address name is required'), { statusCode: 400 });
  const localPart = value.trim().toLowerCase();
  if (localPart.length < 3 || localPart.length > 32 || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(localPart) || reservedAgentLocalParts.has(localPart)) {
    throw Object.assign(new Error('Choose 3–32 letters, numbers, periods or hyphens; start with a letter and avoid reserved names'), { statusCode: 400 });
  }
  return localPart;
}
const agentAddressForLocalPart = localPart => `${localPart}@${agentDomain}`;
const identityKey = (address) => encodeURIComponent(address.toLowerCase());
const normalizedEmail = value => String(value || '').trim().toLowerCase();
const validEmail = value => /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value) && value.length <= 254 && !/[\r\n]/.test(value);
const externalContactKey = address => hashSecret(normalizedEmail(address)).slice(0, 40);
const externalContactPath = (inboxId, address) => path.join('inboxes', inboxId, 'external-contacts', `${externalContactKey(address)}.json`);
const invitationPath = (inboxId, invitationId) => path.join('inboxes', inboxId, 'invitations', `${invitationId}.json`);
const externalAddressDirectoryPath = address => path.join('directory', 'email-addresses', `${identityKey(address)}.json`);
const nativeAddressDirectoryPath = address => path.join('directory', 'native-addresses', `${identityKey(address)}.json`);
const replyAddressDirectoryPath = address => path.join('directory', 'email-replies', `${identityKey(address)}.json`);
// agent-registration v1 §9: a live address hold counts as taken everywhere except the holding
// registration's own activation.
const reserveIdentity = async (address, value, { holdRegistrationId = null } = {}) => {
  if (await registrations.liveHold(address, holdRegistrationId)) return false;
  const relative = path.join('identities', `${identityKey(address)}.json`);
  return store.putJsonIfAbsent(relative, value);
};
const identityTaken = async address => Boolean(await store.getJson(path.join('identities', `${identityKey(address)}.json`)));
const canAct = (agent, permission) => agent.status === 'active' && agent.onboardingStatus === 'approved' && agent.permissions?.includes(permission);
// A paused agent stays addressable: it may receive and observe, but not act.
const canReceive = agent => ['active', 'paused'].includes(agent?.status) && agent.onboardingStatus === 'approved' && agent.permissions?.includes('receive_agent_messages');
const codedError = (statusCode, code, message, publicFields) => Object.assign(new Error(message), { statusCode, code, ...(publicFields ? { publicFields } : {}) });
const credentialMessages = {
  AUTHENTICATION_REQUIRED: 'A valid agent credential is required.',
  CREDENTIAL_EXPIRED: 'This agent credential expired after inactivity. Ask the owner to reconnect this agent.',
  ACCESS_TOKEN_EXPIRED: 'The access token expired. Refresh it and retry.',
  ROTATION_ID_REQUIRED: 'This connector is out of date. Update it to keep this agent connected.',
  REFRESH_TOKEN_INVALID: 'This refresh token is not valid. Ask the owner to reconnect this agent.',
  REFRESH_REPLAY: 'This refresh token was used twice, so the credential was revoked for safety. Ask the owner to reconnect the agent.',
  REFRESH_RECOVERY_EXPIRED: 'The refresh could not be recovered in time. Ask the owner to reconnect this agent.'
};
const revokedMessages = {
  revoked: 'This agent credential was revoked.',
  replaced: 'This connection was replaced by a newer reconnect of the same agent.',
  refresh_replay: 'This credential was revoked because a refresh token was used twice.'
};
const credentialError = (code, reason) => code === 'CREDENTIAL_REVOKED'
  ? codedError(401, code, revokedMessages[reason] || revokedMessages.revoked, { reason: revokedMessages[reason] ? reason : 'revoked' })
  : codedError(code === 'ROTATION_ID_REQUIRED' ? 400 : 401, code, credentialMessages[code]);
const agentPausedError = () => codedError(409, 'AGENT_PAUSED', 'This agent is paused by its owner.');
const insufficientScopeMessages = {
  receive_agent_messages: 'This connection may not receive work.', send_agent_messages: 'This connection may not send messages.',
  create_assets: 'This connection may not share files.', execute_cases: 'This connection may not act on cases.'
};
// case-session v1 §12.
const caseSessionErrors = {
  featureDisabled: () => codedError(404, 'FEATURE_DISABLED', 'Case sessions are not available on this server.'),
  requestInvalid: () => codedError(400, 'CASE_SESSION_REQUEST_INVALID', 'The request body is not valid for this route.'),
  workNotFound: () => codedError(404, 'WORK_NOT_FOUND', 'Work was not found for this agent.'),
  notEligible: reason => codedError(409, 'WORK_NOT_ELIGIBLE', 'This work can no longer be handled.', { reason }),
  leaseStale: reason => codedError(409, 'WORK_LEASE_STALE', 'This work lease is no longer live for this host.', { reason }),
  notFound: () => codedError(404, 'CASE_SESSION_NOT_FOUND', 'Case session was not found.'),
  ended: reason => codedError(401, 'CASE_SESSION_ENDED', 'This case session has ended.', { reason }),
  expired: () => codedError(401, 'CASE_SESSION_EXPIRED', 'This case session has expired.')
};
// case-session v1 §7.3: with the flag on, these settlement errors carry a code; the status and
// message stay as they were, and with the flag off nothing changes.
const settlementError = (statusCode, message, code, reason = null) => caseSessions.enabled
  ? codedError(statusCode, code, message, reason ? { reason } : undefined)
  : Object.assign(new Error(message), { statusCode });
const hashSecret = value => crypto.createHash('sha256').update(value).digest('hex');
const publicEmailAddressForAgent = agent => emailTransport.addressForSlug(agent.slug);
const publicIdentity = (slug) => ({
  type: 'agent-email',
  address: `${slug}@${agentDomain}`,
  domain: agentDomain,
  status: 'sandbox',
  transport: 'native',
  externalAddress: emailTransport.addressForSlug(slug),
  externalTransportStatus: emailTransport.ready ? 'ready' : 'unconfigured'
});
const connectorEncryptionKey = () => crypto.createHash('sha256').update(process.env.ENVOI_DATA_ENCRYPTION_KEY || 'sinaloa-development-only').digest();
const encryptConnectorTokens = value => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', connectorEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
};
const publicEmailTransportStatus = () => ({
  enabled: externalEmailEnabled,
  ready: externalEmailEnabled && emailTransport.ready,
  reason: !externalEmailEnabled ? 'disabledByConfiguration' : emailTransport.ready ? null : emailTransport.status().reason || 'providerNotReady'
});
const publicEmailTransportProjection = (agents, contacts) => ({
  ...emailTransport.status(),
  ...publicEmailTransportStatus(),
  internalAgentDomain: agentDomain,
  agents: agents.map(agent => ({
    agentId: agent.id,
    platformAddress: agent.address,
    publicEmailAddress: externalEmailEnabled ? publicEmailAddressForAgent(agent) : null,
    permitted: canAct(agent, 'use_email_transport')
  })),
  contacts: contacts.sort((left, right) => String(left.email).localeCompare(String(right.email)))
});
const publicAgent = agent => {
  const value = {
    ...agent,
    platformAddress: agent.address,
    publicEmailAddress: externalEmailEnabled ? publicEmailAddressForAgent(agent) : null,
    publicEmailTransport: publicEmailTransportStatus()
  };
  delete value.credentialHash;
  return value;
};
const publicCalendarConnector = connector => {
  const value = { ...connector };
  delete value.tokenSetEncrypted;
  return value;
};
const bearerToken = req => (req.headers.authorization || '').startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
// envoi-names v1 §2: the only accepted formats. Credentials are stored hashed, so a pre-cutover
// sinaloa_* token would still resolve by hash; the prefix check refuses it explicitly.
const agentCredentialPrefixes = { access: 'envoi_agent_access_', refresh: 'envoi_agent_refresh_', mcp_read: 'envoi_mcp_read_', oauth_access: 'envoi_agent_access_', oauth_refresh: 'envoi_agent_refresh_' };
const hasAgentCredentialFormat = (raw, tokenType) => Boolean(agentCredentialPrefixes[tokenType]) && String(raw || '').startsWith(agentCredentialPrefixes[tokenType]);
const agentCredentialPath = tokenHash => path.join('auth', 'agent-credentials', `${tokenHash}.json`);
const agentRefreshCredentialPath = tokenHash => path.join('auth', 'agent-refresh-credentials', `${tokenHash}.json`);
const agentRotationRecoveryPath = tokenHash => path.join('auth', 'agent-rotation-recovery', `${tokenHash}.json`);
const agentCredentialFamilyPath = (inboxId, agentId, familyId) => path.join('auth', 'agent-credential-families', inboxId, agentId, `${familyId}.json`);
const enrollmentIndexPath = (inboxId, enrollmentId) => path.join('inboxes', inboxId, 'agent-enrollments', `${enrollmentId}.json`);
const expiresAfter = milliseconds => new Date(Date.now() + milliseconds).toISOString();
const mcpReadTokenTtlMs = 5 * 60_000;
function scopedMcpReadRequest(req, inboxId, caseId) {
  if (req.method !== 'GET' || !caseId) return false;
  const url = new URL(req.url, 'http://localhost');
  const base = `/api/inboxes/${inboxId}`;
  if (url.pathname === `${base}/cases/${caseId}`) return url.search === '';
  return url.pathname === `${base}/messages`
    && url.searchParams.get('caseId') === caseId
    && [...url.searchParams.keys()].every(key => ['caseId', 'limit', 'before'].includes(key));
}

// `oauth` issues the agent-remote-auth token types (agent-registration §14.2): the raw formats are unchanged, the stored
// records are oauth_access and oauth_refresh, so a server that predates them refuses the tokens everywhere. A family is
// all one kind: it has an audience exactly when its records are oauth_ types. `recoveryTokenHash` names the refresh
// recovery envelope of the rotation that issued the two successors (§14.5).
async function issueAgentCredentials(agentId, inboxId, familyId = store.id('credential_family'), rollRefreshExpiry = false, newFamilyFields = {}, { oauth = false, recoveryTokenHash = null } = {}) {
  const issuedAt = store.now();
  const familyPath = agentCredentialFamilyPath(inboxId, agentId, familyId);
  const existingFamily = await store.getJson(familyPath);
  if (existingFamily?.revokedAt) throw Object.assign(new Error('Agent credential family is revoked'), { statusCode: 401 });
  const family = existingFamily || {
    id: familyId,
    agentId,
    inboxId,
    createdAt: issuedAt,
    refreshExpiresAt: expiresAfter(agentRefreshTokenTtlDays * 86_400_000),
    rotationCounter: 0,
    revokedAt: null,
    ...newFamilyFields
  };
  if (new Date(family.refreshExpiresAt) <= new Date()) throw Object.assign(new Error('Agent credential family is expired'), { statusCode: 401 });
  if (rollRefreshExpiry) family.refreshExpiresAt = expiresAfter(agentRefreshTokenTtlDays * 86_400_000);
  const agentApiToken = `${agentCredentialPrefixes.access}${crypto.randomBytes(32).toString('base64url')}`;
  const agentRefreshToken = `${agentCredentialPrefixes.refresh}${crypto.randomBytes(48).toString('base64url')}`;
  const agentTokenExpiresAt = expiresAfter(agentAccessTokenTtlSeconds * 1000);
  const agentRefreshTokenExpiresAt = family.refreshExpiresAt;
  family.rotationCounter = Number(family.rotationCounter || 0) + 1;
  family.updatedAt = issuedAt;
  await store.putJsonBatch([
    document(agentCredentialPath(hashSecret(agentApiToken)), { tokenType: oauth ? 'oauth_access' : 'access', agentId, inboxId, familyId, issuedAt, expiresAt: agentTokenExpiresAt, revokedAt: null, ...(oauth ? { usedAt: null, recoveryTokenHash } : {}) }),
    document(agentRefreshCredentialPath(hashSecret(agentRefreshToken)), { tokenType: oauth ? 'oauth_refresh' : 'refresh', agentId, inboxId, familyId, issuedAt, expiresAt: agentRefreshTokenExpiresAt, usedAt: null, revokedAt: null, ...(oauth ? { recoveryTokenHash } : {}) }),
    document(familyPath, family)
  ]);
  return { agentApiToken, agentRefreshToken, agentTokenExpiresAt, agentRefreshTokenExpiresAt, tokenType: 'Bearer' };
}

const invalidAgentRefresh = () => Object.assign(new Error('Agent refresh token is invalid, expired, or already used'), { statusCode: 401 });
const rotationRecoveryKey = rawRefreshToken => crypto.hkdfSync('sha256', Buffer.from(rawRefreshToken), connectorEncryptionKey(), Buffer.from('envoi-agent-rotation-recovery-v1'), 32);
const rotationRecoveryContext = (tokenHash, familyId, rotationIdHash) => `${tokenHash}:${familyId}:${rotationIdHash}`;
function encryptAgentRotation(rawRefreshToken, context, successor) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', rotationRecoveryKey(rawRefreshToken), iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(successor), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}
function decryptAgentRotation(rawRefreshToken, context, encrypted) {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', rotationRecoveryKey(rawRefreshToken), Buffer.from(encrypted.iv, 'base64'));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
  } catch { throw invalidAgentRefresh(); }
}

async function rotateAgentCredentials(rawRefreshToken, rotationId, { onRotated = () => {} } = {}) {
  // Checked before any lookup: reveals nothing about the token and never consumes it.
  if (typeof rotationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(rotationId)) throw credentialError('ROTATION_ID_REQUIRED');
  if (!hasAgentCredentialFormat(rawRefreshToken, 'refresh')) throw credentialError('REFRESH_TOKEN_INVALID');
  const tokenHash = hashSecret(rawRefreshToken);
  const rotationIdHash = hashSecret(rotationId);
  const refreshPath = agentRefreshCredentialPath(tokenHash);
  const pending = await store.getJson(refreshPath);
  if (!pending?.inboxId) throw credentialError('REFRESH_TOKEN_INVALID');
  // Set when the request is an A1 recovery of a successor already issued, for the audit below.
  let recovered = false;
  // Session-end events of a replay, published once the revocation commits.
  const replayEvents = [];
  const writeReplayAudit = async (type, data, createdAt, targetInboxId) => {
    const record = await auditRecord(targetInboxId, type, data, createdAt);
    await store.putJson(record.document.path, record.document.value);
    replayEvents.push({ inboxId: targetInboxId, event: record.event });
    return record.event;
  };
  const rotate = async () => {
    const current = await store.getJson(refreshPath);
    if (!current || current.tokenType !== 'refresh') throw credentialError('REFRESH_TOKEN_INVALID');
    const familyPath = agentCredentialFamilyPath(current.inboxId, current.agentId, current.familyId);
    const family = await store.getJson(familyPath);
    const agent = await store.getJson(path.join('inboxes', current.inboxId, 'agents', `${current.agentId}.json`));
    if (!family || family.revokedAt || current.revokedAt || !agent || ['revoked', 'removed'].includes(agent.status)) throw credentialError('CREDENTIAL_REVOKED', family?.revokedReason);
    if (new Date(family.refreshExpiresAt) <= new Date()) throw credentialError('CREDENTIAL_EXPIRED');
    if (current.usedAt) {
      if (!current.usedRotationIdHash) throw credentialError('REFRESH_TOKEN_INVALID');
      if (current.usedRotationIdHash !== rotationIdHash) {
        // Two holders of one refresh token: revoke the family rather than let either keep it.
        // Returned, not thrown, so the revocation commits with the transaction.
        const revokedAt = store.now();
        await store.putJson(familyPath, { ...family, revokedAt, revokedReason: 'refresh_replay', updatedAt: revokedAt });
        await caseSessions.endForFamily(current.inboxId, current.agentId, current.familyId, 'credential_ended', revokedAt, writeReplayAudit);
        return { replayed: { inboxId: current.inboxId, agentId: current.agentId, familyId: current.familyId } };
      }
      const recovery = await store.getJson(agentRotationRecoveryPath(tokenHash));
      if (!recovery || recovery.rotationIdHash !== rotationIdHash || recovery.familyId !== current.familyId || new Date(recovery.expiresAt) <= new Date()) throw credentialError('REFRESH_RECOVERY_EXPIRED');
      try {
        const successor = decryptAgentRotation(rawRefreshToken, rotationRecoveryContext(tokenHash, current.familyId, rotationIdHash), recovery.encrypted);
        recovered = true;
        return successor;
      } catch { throw credentialError('REFRESH_RECOVERY_EXPIRED'); }
    }
    if (new Date(current.expiresAt) <= new Date()) throw credentialError('REFRESH_TOKEN_INVALID');
    if (agent.onboardingStatus !== 'approved' || !['active', 'paused'].includes(agent.status)) throw Object.assign(new Error('Agent is not active and approved'), { statusCode: 401 });
    const claimed = await store.claimJson(refreshPath, 'usedAt', store.now());
    if (!claimed) throw credentialError('REFRESH_TOKEN_INVALID');
    // Remember which rotation consumed the token so replay and late recovery stay distinguishable.
    await store.putJson(refreshPath, { ...claimed, usedRotationIdHash: rotationIdHash });
    const successor = await issueAgentCredentials(current.agentId, current.inboxId, current.familyId, true);
    await store.putJson(agentRotationRecoveryPath(tokenHash), {
      tokenHash, familyId: current.familyId, rotationIdHash,
      expiresAt: expiresAfter(agentRotationRecoveryMs),
      encrypted: encryptAgentRotation(rawRefreshToken, rotationRecoveryContext(tokenHash, current.familyId, rotationIdHash), successor)
    });
    return successor;
  };
  const result = typeof store.withTransaction === 'function' ? await store.withTransaction([inboxMutationKey(pending.inboxId)], rotate) : await rotate();
  if (!result.replayed) {
    // A new successor or an A1 recovery of the same one: both are a successful refresh.
    onRotated({ inboxId: pending.inboxId, agentId: pending.agentId, familyId: pending.familyId });
    // Gate GA: a recovered lost refresh response is otherwise invisible to the owner. Only recoveries
    // are audited: they are rare, while an event per ordinary refresh (about 4 an hour per agent) would
    // flood the owner's activity. Ids and a timestamp only, never a credential. Best-effort: the rotation
    // has already committed.
    if (recovered) {
      await audit(pending.inboxId, 'agent.refresh_recovered', {
        agentId: pending.agentId, credentialFamilyId: pending.familyId, refreshExpiresAt: result.agentRefreshTokenExpiresAt
      }).catch(error => console.error('Refresh recovery audit failed', { name: error?.name || 'Error', agentId: pending.agentId, credentialFamilyId: pending.familyId }));
    }
    return result;
  }
  for (const committed of replayEvents) publish(committed.inboxId, committed.event);
  const { inboxId, agentId, familyId } = result.replayed;
  await audit(inboxId, 'agent.refresh_replay_detected', { agentId, credentialFamilyId: familyId });
  closeAgentStreams(inboxId, agentId, { code: 'CREDENTIAL_REVOKED', reason: 'refresh_replay' }, familyId);
  throw credentialError('REFRESH_REPLAY');
}

// Resolves a bearer credential to one stable outcome (a3-pause-auth v1 §2.1). Pending
// agents keep their legacy behaviour (`legacy`), since the contract does not cover them.
async function resolveAgentCredential(req, { inboxId = null, tokenTypes = ['access'] } = {}) {
  const raw = bearerToken(req);
  if (!raw) return { error: credentialError('AUTHENTICATION_REQUIRED') };
  const tokenHash = hashSecret(raw);
  const index = await store.getJson(agentCredentialPath(tokenHash));
  // An oauth_access token is accepted at /mcp only, and by the REST call a /mcp tool call makes for itself (agent-remote-auth §9).
  const accepted = oauthAccessAllowed(req, tokenHash) ? [...tokenTypes, 'oauth_access'] : tokenTypes;
  if (!index?.inboxId || !index.familyId || !accepted.includes(index.tokenType) || !hasAgentCredentialFormat(raw, index.tokenType) || (inboxId && index.inboxId !== inboxId)) return { error: credentialError('AUTHENTICATION_REQUIRED') };
  const [family, agent] = await Promise.all([
    store.getJson(agentCredentialFamilyPath(index.inboxId, index.agentId, index.familyId)),
    store.getJson(path.join('inboxes', index.inboxId, 'agents', `${index.agentId}.json`))
  ]);
  // A family has an audience exactly when its records are oauth_ types; one that disagrees, one issued for another resource
  // and one whose client or route is no longer configured are refused like an unknown token.
  if (family && !oauthFamilyConsistent(index, family)) return { error: credentialError('AUTHENTICATION_REQUIRED') };
  if (!family || family.revokedAt || index.revokedAt || !agent || ['revoked', 'removed'].includes(agent.status)) return { error: credentialError('CREDENTIAL_REVOKED', family?.revokedReason) };
  if (new Date(family.refreshExpiresAt) <= new Date()) return { error: credentialError('CREDENTIAL_EXPIRED') };
  if (new Date(index.expiresAt) <= new Date()) return { error: credentialError('ACCESS_TOKEN_EXPIRED') };
  if (agent.onboardingStatus !== 'approved' || !['active', 'paused'].includes(agent.status)) return { legacy: true };
  return { identity: { agent, familyId: index.familyId, inboxId: index.inboxId, tokenType: index.tokenType, caseId: index.caseId, paused: agent.status === 'paused', oauth: index.tokenType === 'oauth_access', credential: { tokenHash, usedAt: index.usedAt ?? null } } };
}

// agent-remote-auth §9 "Audience" and agent-registration §14.2. The marker for the REST call a /mcp tool call makes for
// itself is a random value held only in this process and valid for one outer request: no header an external request can
// send, and no loopback address, is enough on its own.
const internalDispatches = new Map();
const internalDispatchTtlMs = 60_000;
function registerInternalDispatch(tokenHash) {
  const nowMs = Date.now();
  for (const [nonce, entry] of internalDispatches) if (entry.expires <= nowMs) internalDispatches.delete(nonce);
  const nonce = crypto.randomBytes(24).toString('base64url');
  internalDispatches.set(nonce, { tokenHash, expires: nowMs + internalDispatchTtlMs });
  return { nonce, release: () => internalDispatches.delete(nonce) };
}
const internalDispatchAllows = (req, tokenHash) => {
  const nonce = req.headers['x-envoi-mcp-dispatch'];
  const entry = typeof nonce === 'string' ? internalDispatches.get(nonce) : null;
  return Boolean(entry && entry.tokenHash === tokenHash && entry.expires > Date.now());
};
const requestPath = req => String(req.url || '').split('?', 1)[0];
const oauthAccessAllowed = (req, tokenHash) => remoteAuthEnabled(onboardingFlags) && (requestPath(req) === '/mcp' || internalDispatchAllows(req, tokenHash));
// The route a family's client belongs to: a pre-registered client names it; every URL client is remote_mcp_oauth. A client the
// operator removed is unknown, so its tokens stop working with it.
const oauthClientRouteOn = clientId => remoteRouteAvailable(onboardingFlags, /^client_/.test(String(clientId)) ? oauthClients.get(clientId)?.connectionRoute : 'remote_mcp_oauth');
function oauthFamilyConsistent(index, family) {
  const oauthRecord = index.tokenType === 'oauth_access';
  if (Boolean(family.audience) !== oauthRecord) {
    if (family.audience || oauthRecord) console.error('Credential kind does not match its family', { agentId: index.agentId, credentialFamilyId: index.familyId, tokenType: index.tokenType });
    return false;
  }
  return !oauthRecord || (family.audience === remoteAuth.resource && oauthClientRouteOn(family.oauthClientId));
}

const getAgentPrincipal = async (req, inboxId) => {
  const raw = bearerToken(req);
  if (!raw) return null;
  const credentialHash = hashSecret(raw);
  const index = await store.getJson(agentCredentialPath(credentialHash));
  if (!index || index.inboxId !== inboxId) return null;
  if (!index.tokenType) {
    if (process.env.ENVOI_AUTH_MODE === 'production') return null;
  } else {
    const accepted = oauthAccessAllowed(req, credentialHash) ? ['access', 'mcp_read', 'oauth_access'] : ['access', 'mcp_read'];
    if (!accepted.includes(index.tokenType) || !hasAgentCredentialFormat(raw, index.tokenType) || index.revokedAt || new Date(index.expiresAt) <= new Date()) return null;
    if (index.tokenType === 'mcp_read' && !scopedMcpReadRequest(req, inboxId, index.caseId)) return null;
    const family = await store.getJson(agentCredentialFamilyPath(index.inboxId, index.agentId, index.familyId));
    if (!family || family.revokedAt || new Date(family.refreshExpiresAt) <= new Date() || !oauthFamilyConsistent(index, family)) return null;
  }
  const agent = await store.getJson(path.join('inboxes', inboxId, 'agents', `${index.agentId}.json`));
  if (agent?.onboardingStatus !== 'approved') return null;
  return agent.status === 'active' || agent.status === 'paused' && ['GET', 'HEAD'].includes(req.method) ? agent : null;
};
async function issueMcpReadToken(identity, caseId) {
  if (caseId && !await getCase(identity.inboxId, caseId)) throw Object.assign(new Error('Case not found'), { statusCode: 404 });
  const raw = `${agentCredentialPrefixes.mcp_read}${crypto.randomBytes(32).toString('base64url')}`;
  const expiresAt = expiresAfter(mcpReadTokenTtlMs);
  await store.putJson(agentCredentialPath(hashSecret(raw)), {
    tokenType: 'mcp_read', agentId: identity.agent.id, inboxId: identity.inboxId,
    familyId: identity.familyId, caseId, issuedAt: store.now(), expiresAt, revokedAt: null
  });
  await audit(identity.inboxId, 'agent.mcp_read_token_issued', { agentId: identity.agent.id, caseId, expiresAt });
  return { mcpAccessToken: raw, tokenType: 'Bearer', scope: 'case_read', caseId, expiresAt };
}
const workClaimPath = (inboxId, workId) => path.join('inboxes', inboxId, 'work-claims', `${workId}.json`);
const liveClaim = (claim, at) => ['claimed', 'acknowledged'].includes(claim?.status) && new Date(claim.leaseExpiresAt) > new Date(at);
// Offered again as the same attempt (a3 §3); releasedAt tells a release from an expiry (case-session §16).
const releasedClaim = (claim, at) => ({ ...claim, status: 'retryable', retryAt: at, leaseExpiresAt: null, reofferWithoutAttempt: true, releasedAt: at, updatedAt: at });

// Active or paused access credential; callers decide what a paused agent may do.
const pausedAgentRoutes = new Set(['POST /api/agent/work/claim', 'POST /api/agent/connection-status', 'GET /api/agent/status']);
// case-session v1 §8: ending a session is always safe, so it also works while the agent is paused.
const caseSessionEndRoute = /^\/api\/agent\/work\/[^/]+\/session\/end$/;
// a3-pause-auth v1 §2.1 and §3, applied before any route handler so precedence is uniform.
// a5-presence §3: a request authenticated by a family's access token records presence once its
// outcome is known, outside the request's transaction. Handlers add the work-loop fields.
const presenceTrack = Symbol('agent-presence');
function trackAgentPresence(req, res, identity) {
  if (req[presenceTrack] || !['access', 'oauth_access'].includes(identity.tokenType)) return;
  req[presenceTrack] = { ref: { inboxId: identity.inboxId, agentId: identity.agent.id, familyId: identity.familyId }, workLoop: false, processed: false, errorCode: null, recorded: false };
  res.once('finish', () => flushAgentPresence(req, res));
  // A client that disconnects after the response started still made the request.
  res.once('close', () => { if (res.headersSent) flushAgentPresence(req, res); });
}
function notePresence(req, flags) { if (req[presenceTrack]) Object.assign(req[presenceTrack], flags); }
function flushAgentPresence(req, res) {
  const track = req[presenceTrack];
  if (!track || track.recorded || res.statusCode === 401) return;
  track.recorded = true;
  const fields = ['lastSeenAt'];
  if (track.workLoop && track.errorCode !== 'AGENT_PAUSED') fields.push('lastWorkClaimAt');
  if (track.processed) fields.push('lastProcessedAt');
  void presenceRecorder.record(track.ref, fields);
}

async function enforceAgentCredential(req, url, res) {
  try { await checkAgentCredential(req, url, res); }
  catch (error) {
    // With a route flag on, every 401 from /mcp carries the RFC 9728 challenge (set where the response is written).
    if (url.pathname === '/mcp' && error.statusCode === 401 && !remoteAuthEnabled(onboardingFlags)) res.setHeader('www-authenticate', 'Bearer realm="Envoi agent MCP"');
    throw error;
  }
}

async function checkAgentCredential(req, url, res) {
  const agentRoute = url.pathname === '/mcp' || url.pathname.startsWith('/api/agent/') || url.pathname.startsWith('/api/inboxes/');
  const raw = agentRoute ? bearerToken(req) : null;
  if (!raw) {
    if (url.pathname.startsWith('/api/agent/') || url.pathname === '/mcp') throw credentialError('AUTHENTICATION_REQUIRED');
    return;
  }
  const inboxRoute = url.pathname.startsWith('/api/inboxes/');
  if (inboxRoute) {
    // Human bearer sessions and legacy untyped development tokens keep their per-route handling.
    // Pre-cutover sinaloa_* credentials fall through to resolveAgentCredential, which refuses them.
    // agent-registration v1 §2: a bootstrap token is an unrecognized bearer on every other
    // authenticated route, and so is a case session token outside /mcp (case-session v1 §6.1).
    if (raw.startsWith('envoi_reg_') || raw.startsWith(caseSessionTokenPrefix)) throw credentialError('AUTHENTICATION_REQUIRED');
    if (!/^(?:envoi|sinaloa)_(?:agent_access|mcp_read)_/.test(raw)) return;
    const index = await store.getJson(agentCredentialPath(hashSecret(raw)));
    if (index && !index.tokenType) return;
  }
  let routeInboxId = null;
  if (inboxRoute) {
    try { routeInboxId = decodeURIComponent(url.pathname.split('/')[3] || ''); } catch { routeInboxId = ''; }
  }
  const resolved = await resolveAgentCredential(req, { inboxId: routeInboxId, tokenTypes: url.pathname.startsWith('/api/agent/') ? ['access'] : ['access', 'mcp_read'] });
  if (resolved.error) throw resolved.error;
  const identity = resolved.identity;
  if (identity) trackAgentPresence(req, res, identity);
  if (identity && await monadAccess.active(identity.inboxId)) {
    req[monadRequest] = {
      requestId: crypto.randomUUID(), inboxId: identity.inboxId, agentId: identity.agent.id,
      method: req.method, pathname: url.pathname,
      permissionFingerprint: commitment('permission', permissionSnapshot(identity.inboxId, identity.agent))
    };
    try { await monadPermissions.ensurePermission(identity.inboxId, identity.agent); }
    catch { throw codedError(503, 'MONAD_PERMISSION_UNAVAILABLE', 'The current agent permission could not be verified on Monad.'); }
  }
  // agent-registration §14.2: the first outer /mcp request an oauth_access token authenticates records usedAt before it is
  // dispatched (and retires the refresh recovery envelope that named it). The REST call a tool call makes never does.
  if (identity?.oauth && url.pathname === '/mcp') await markOAuthAccessUsed(identity.credential.tokenHash, { familyId: identity.familyId, usedAt: identity.credential.usedAt });
  if (!identity?.paused) return;
  const readOnly = ['GET', 'HEAD'].includes(req.method) && inboxRoute;
  const pausedAllowed = readOnly || pausedAgentRoutes.has(`${req.method} ${url.pathname}`) || req.method === 'POST' && caseSessionEndRoute.test(url.pathname)
    || url.pathname.startsWith('/api/agent/wake-subscriptions');
  if (identity.tokenType === 'mcp_read' || url.pathname === '/mcp' || !pausedAllowed) throw agentPausedError();
}

async function getAgentWorkIdentity(req) {
  const resolved = await resolveAgentCredential(req);
  return resolved.identity ? { agent: resolved.identity.agent, familyId: resolved.identity.familyId, inboxId: resolved.identity.inboxId, paused: resolved.identity.paused, oauth: resolved.identity.oauth } : null;
}
async function getMcpIdentity(req) {
  const full = await getAgentWorkIdentity(req);
  if (full) {
    const family = await store.getJson(agentCredentialFamilyPath(full.inboxId, full.agent.id, full.familyId));
    const installation = onboardingFlags.installations ? await installations.forFamily(full.inboxId, full.agent, full.familyId) : null;
    return { ...full, family, installationId: installation?.status === 'active' ? installation.id : null,
      connectionRoute: family?.audience ? oauthClients.get(family.oauthClientId)?.connectionRoute || 'remote_mcp_oauth' : 'local_helper' };
  }
  const raw = bearerToken(req);
  if (!hasAgentCredentialFormat(raw, 'mcp_read')) return null;
  const index = await store.getJson(agentCredentialPath(hashSecret(raw)));
  if (!index || index.tokenType !== 'mcp_read' || index.revokedAt || new Date(index.expiresAt) <= new Date()) return null;
  const family = await store.getJson(agentCredentialFamilyPath(index.inboxId, index.agentId, index.familyId));
  if (!family || family.revokedAt || new Date(family.refreshExpiresAt) <= new Date()) return null;
  const agent = await store.getJson(path.join('inboxes', index.inboxId, 'agents', `${index.agentId}.json`));
  if (!agent || !['active', 'paused'].includes(agent.status) || agent.onboardingStatus !== 'approved') return null;
  return { agent, familyId: index.familyId, inboxId: index.inboxId, mcpScope: { caseId: index.caseId } };
}
const body = async (req, limit = maxBodyBytes) => {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > limit) {
      const error = new Error(`Request body exceeds ${limit} bytes`);
      error.statusCode = 413;
      throw error;
    }
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch {
    const error = new Error('Request body must be valid JSON');
    error.statusCode = 400;
    throw error;
  }
};
const rawBody = async (req) => {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBodyBytes) throw Object.assign(new Error(`Request body exceeds ${maxBodyBytes} bytes`), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
};
const rawBuffer = async (req) => {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > objectMaxBytes) throw Object.assign(new Error(`Request body exceeds ${objectMaxBytes} bytes`), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};
const publicBaseUrl = req => (process.env.ENVOI_PUBLIC_URL || `http://${req.headers.host || `${host}:${port}`}`).replace(/\/$/, '');
const mcpOriginAllowed = req => {
  if (!req.headers.origin) return true;
  const allowed = corsOrigin.split(',').map(value => value.trim()).filter(value => value && value !== '*');
  if (process.env.ENVOI_PUBLIC_URL) {
    try { allowed.push(new URL(process.env.ENVOI_PUBLIC_URL).origin); }
    catch { return false; }
  }
  return allowed.includes(req.headers.origin);
};
const browserObjectUrl = (value, req) => {
  if (!value?.url?.startsWith('local-object://')) return value;
  const parsed = new URL(value.url);
  return { ...value, url: `${publicBaseUrl(req)}/api/object-storage/local-${parsed.hostname}/${parsed.pathname.slice(1)}` };
};
const eventCursor = event => event.cursor || (event.sequence ? String(event.sequence).padStart(20, '0') : `${event.createdAt}|${event.id}`);
const normalizeStreamEvent = event => ({ ...event, cursor: eventCursor(event) });
const sendStreamEvent = (subscription, event) => {
  // Serialize authorization and delivery so replay/live events retain cursor order.
  subscription.pendingWrites = (subscription.pendingWrites || 0) + 1;
  if (subscription.pendingWrites > 500) subscription.close?.('replay_required', { cursor: subscription.cursor || null, hasMore: true });
  subscription.writeQueue = (subscription.writeQueue || Promise.resolve()).then(async () => {
    if (subscription.res.writableEnded || subscription.res.destroyed) return;
    if (subscription.authorize && !await subscription.authorize()) {
      subscription.close(subscription.authFailureEvent);
      return;
    }
    if (subscription.res.writableEnded || subscription.res.destroyed) return;
    const normalized = normalizeStreamEvent(event);
    if (subscription.sentIds.has(normalized.id)) return;
    subscription.sentIds.add(normalized.id);
    if (subscription.sentIds.size > 500) subscription.sentIds.delete(subscription.sentIds.values().next().value);
    subscription.cursor = normalized.cursor;
    subscription.res.write(`id: ${normalized.cursor}\nevent: ${normalized.type}\ndata: ${JSON.stringify(normalized)}\n\n`);
  }).catch(() => subscription.close?.('replay_error')).finally(() => { subscription.pendingWrites -= 1; });
  return subscription.writeQueue;
};
const publish = (inboxId, event) => {
  for (const subscription of streams.get(inboxId) || []) {
    if (subscription.replaying) {
      if (subscription.buffer.size >= 500) subscription.overflow = true;
      else subscription.buffer.set(event.id, event);
    } else sendStreamEvent(subscription, event);
  }
};
// Not a persisted event: no SSE id, so the client's cursor does not move.
// With familyId, only that installation's streams end; other installations keep theirs.
const closeAgentStreams = (inboxId, agentId, ended = { code: 'CREDENTIAL_REVOKED', reason: 'revoked' }, familyId = null) => {
  const subscriptions = streams.get(inboxId);
  if (!subscriptions) return;
  for (const subscription of [...subscriptions]) {
    if (subscription.agentId !== agentId || (familyId && subscription.familyId !== familyId)) continue;
    subscription.close?.('credential.ended', ended);
  }
  if (!subscriptions.size) streams.delete(inboxId);
};
const disconnectHumanStreams = sessionKey => {
  if (!sessionKey) return;
  for (const subscriptions of streams.values()) {
    for (const subscription of [...subscriptions]) {
      if (subscription.sessionKey === sessionKey) subscription.close('session.revoked');
    }
  }
};
const audit = (inboxId, type, data) => withInboxMutation(inboxId, writeAudit => writeAudit(type, data));

const document = (relative, value) => ({ path: relative, value });
const messagePath = (inboxId, messageId) => path.join('inboxes', inboxId, 'messages', `${messageId}.json`);
const deliveryReceiptPath = (inboxId, receiptId) => path.join('inboxes', inboxId, 'delivery-receipts', `${receiptId}.json`);
const agentWorkAttempts = claim => Number(claim?.attempts || claim?.fence || 0);
const agentWorkRetryDelay = attempts => Math.min(15 * 60_000, agentWorkRetryBaseMs * 2 ** Math.min(20, Math.max(0, attempts - 1)));
async function failAgentWorkPermanently(message, claim, reasonCode, at, writeAudit) {
  claim.status = 'failed';
  claim.failure = { retryable: false, reasonCode, createdAt: at };
  claim.leaseExpiresAt = null;
  claim.retryAt = null;
  claim.updatedAt = at;
  const failed = { ...message, status: 'failed', failedAt: at, updatedAt: at };
  const receipt = {
    id: `delivery_receipt_${message.id}_failed`, type: 'delivery', messageId: message.id,
    ...workSenderFields(message), recipientAgentId: message.recipientAgentId,
    state: 'failed', reasonCode, attempts: agentWorkAttempts(claim), createdAt: at
  };
  const documents = [document(workClaimPath(claim.inboxId, message.id), claim), ...await workCaseDocuments(message, failed, 'failed', at)];
  for (const targetInboxId of workInboxIds(message)) {
    const targetInbox = await store.getJson(path.join('inboxes', targetInboxId, 'inbox.json'));
    if (!targetInbox) continue;
    documents.push(document(messagePath(targetInboxId, message.id), failed), document(deliveryReceiptPath(targetInboxId, receipt.id), receipt));
    await writeAudit('message.failed', { messageId: message.id, caseId: message.caseId, ...workSenderFields(message), recipientAgentId: message.recipientAgentId, reasonCode }, at, targetInboxId);
  }
  await store.putJsonBatch(documents);
  await caseSessions.endForWork(claim.inboxId, message.id, 'work_settled', at, writeAudit);
  return receipt;
}
const workSenderFields = message => isHumanDecision(message) && message.senderType === 'system' ? { senderType: 'system' }
  : isHumanInstruction(message) || isHumanDecision(message)
  ? { senderType: 'human', senderHumanId: message.senderHumanId }
  : { senderAgentId: message.senderAgentId };
const workInboxIds = message => new Set(isHumanInstruction(message) || isHumanDecision(message)
  ? [message.recipientInboxId] : [message.senderInboxId, message.recipientInboxId]);
const workCaseDocuments = async (current, updated, state, at) => isHumanDecision(current) ? [] : isHumanInstruction(current)
  ? humanInstructionCaseDocuments(store, current, state, at)
  : (await nativeCaseDocuments(updated, state, at, { revealRecipient: true })).documents;
async function assertHumanInstructionAuthority(message, identity) {
  const context = await assertHumanInstructionWork(store, message, identity);
  for (const humanId of new Set([message.senderHumanId, context.inbox.ownerHumanId])) {
    assertSafeIdentifier(humanId, 'humanId');
    const human = await store.getJson(path.join('humans', `${humanId}.json`));
    if (human?.id !== humanId || !await canManageInbox(human, context.inbox, { maxAgeMs: 0 })) {
      throw Object.assign(new Error('Instruction human no longer has workspace administrator authority'), { statusCode: 403 });
    }
  }
  return context;
}
const auditRecord = async (inboxId, type, data, createdAt = store.now()) => {
  const event = { id: store.id('evt'), type, createdAt, sequence: await store.nextEventSequence(inboxId), ...data };
  event.cursor = eventCursor(event);
  return { event, document: document(path.join('inboxes', inboxId, 'events', `${event.id}.json`), event) };
};

const inboxMutationKey = inboxId => `inbox:${inboxId}:mutations`;
const caseMutationKey = caseId => `case:${caseId}:mutations`;
const enrollmentMutationKey = tokenHash => `enrollment:${tokenHash}:mutations`;
const humanAgentLimitKey = humanId => `human:${humanId}:active-agents`;
// One slot rule for every path (agent-registration v1 §5.3): live approvals count too.
const agentSlots = createAgentSlots({
  store,
  uncappedHumanIds: stagingUncappedAgentHumanIds(process.env.ENVOI_STAGING_UNCAPPED_AGENT_HUMAN_IDS, deploymentIdentity.environment)
});
const assertActiveAgentSlot = (humanId, excludingAgentId = null) => agentSlots.assertActiveAgentSlot(humanId, { excludingAgentId });
const installations = createInstallationReader({ store, agentCredentialFamilyPath });
// case-session v1: session records, the sessions epoch and the case tools this server implements.
// C-A1 implements none, so a session carries no tools until C-A2 (§6.4).
const caseSessions = createCaseSessions({
  store, enabled: onboardingFlags.caseSessions, hashSecret,
  recordAudit: async (inboxId, type, data, createdAt) => {
    const record = await auditRecord(inboxId, type, data, createdAt);
    await store.putJson(record.document.path, record.document.value);
    return record.event;
  }
});
let caseReferenceCodec;
const referenceCodec = Object.fromEntries(['ref', 'resolve', 'sealCursor', 'openCursor'].map(name => [name, (...args) => caseReferenceCodec[name](...args)]));
const caseSessionMcp = createCaseSessionMcp(createCaseTools({ store, codec: referenceCodec,
  withSession: withLiveCaseTool, load: loadCaseToolContext, send: sendCaseToolMessage,
  evaluate: evaluateCaseToolAuthority, authorize: authorizeCaseTool, requestHuman: requestCaseToolHuman,
  share: shareCaseToolAsset, readContent: readCaseToolContent, complete: completeCaseTool
}));
// agent-remote-auth v1 §2-§4 (RA-A1): discovery, clients and the authorization request. Nothing here
// writes storage. The issuer comes from ENVOI_PUBLIC_URL only (startup refuses a route flag without it).
const remoteAuth = (() => {
  const origin = remoteAuthOrigin(process.env.ENVOI_PUBLIC_URL);
  const resolveClient = createClientResolver({
    origin, flags: onboardingFlags, preRegistered: oauthClients,
    fetchClientMetadata: createClientMetadataFetch({ destination: createWakeDestination({ env: process.env }) })
  });
  const sealer = createAuthorizationRequestSealer({ keyMaterial: connectorEncryptionKey() });
  return { origin, resource: origin ? resourceFor(origin) : null, sealer, resolveClient, authorize: createAuthorizeRequestHandler({ origin, flags: onboardingFlags, resolveClient, sealer }) };
})();
// x-endpoints: every agent-remote-auth endpoint. Anything else under these prefixes answers FEATURE_DISABLED.
const remoteAuthPath = pathname => pathname === '/.well-known/oauth-protected-resource' || pathname === '/.well-known/oauth-protected-resource/mcp'
  || pathname === '/.well-known/oauth-authorization-server' || pathname.startsWith('/oauth/') || pathname.startsWith('/api/oauth/');
const remoteAuthDisabled = () => codedError(404, 'FEATURE_DISABLED', 'Remote connections are not available on this server.');
async function handleRemoteAuthRoute(req, res, url) {
  if (!remoteAuthEnabled(onboardingFlags)) throw remoteAuthDisabled();
  const { origin } = remoteAuth;
  const metadata = url.pathname === '/.well-known/oauth-authorization-server' ? authorizationServerMetadata(origin, onboardingFlags)
    : url.pathname.startsWith('/.well-known/oauth-protected-resource') ? protectedResourceMetadata(origin) : null;
  if (metadata) {
    if (req.method !== 'GET') return fail(res, 405, 'Method not allowed');
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': remoteAuthLimits.metadataCacheControl });
    return res.end(JSON.stringify(metadata));
  }
  if (url.pathname === '/oauth/authorize') {
    if (req.method !== 'GET') return fail(res, 405, 'Method not allowed');
    const outcome = await remoteAuth.authorize(url.searchParams);
    if (outcome.featureDisabled) throw remoteAuthDisabled();
    res.writeHead(302, { location: outcome.location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-length': 0 });
    return res.end();
  }
  if (url.pathname === '/oauth/token' || url.pathname === '/oauth/revoke') return handleOAuthEndpoint(req, res, url);
  if (url.pathname === '/api/oauth/bootstrap-codes') return handleBootstrapIssue(req, res);
  const consentRoute = url.pathname.match(/^\/api\/oauth\/authorization-requests\/([^/]+)(?:\/(approve|deny))?$/);
  if (consentRoute) return handleConsentRoute(req, res, consentRoute);
  throw remoteAuthDisabled();
}

// agent-remote-auth §5 (approved revision 4): the owner consent routes. A human session is required; CSRF and
// ACCOUNT_CHANGED were checked before any handler, and getHuman re-evaluates the allowlist and assurance rule.
// The handle is addressed by its SHA-256 only in storage; an unusable one is 404, identical in every case.
async function handleConsentRoute(req, res, route) {
  const action = route[2] || null;
  if (action ? req.method !== 'POST' : req.method !== 'GET') return fail(res, 405, 'Method not allowed');
  const human = await auth.getHuman(req);
  if (!human) throw codedError(401, 'AUTHENTICATION_REQUIRED', 'Please sign in again.');
  let handle;
  try { handle = decodeURIComponent(route[1]); } catch { handle = ''; }
  const invalid = () => codedError(404, 'AUTHORIZATION_REQUEST_INVALID', 'This connection request is no longer valid. Start again from your assistant.');
  if (!handle || handle.length > remoteAuthLimits.authorizationRequestHandleMaxLength) throw invalid();
  const handleDigest = sha256Hex(handle);
  const { origin, sealer } = remoteAuth;
  const opened = sealer.open(handle);
  // The approval code is handed back here and never stored; nothing below logs it.
  const consentRequest = sealed => sealed && {
    ...sealed, permissions: permissionsForScopes(sealed.scopes), scopeFor: scopeForPermissions, expiresAt: new Date(sealed.exp * 1000).toISOString()
  };
  res.setHeader('cache-control', 'no-store');
  if (action === 'approve') {
    const input = await readJsonBody(req);
    const outcome = await registrations.approveConsent(human, consentRequest(opened), handleDigest, input.invalid ? null : input.value);
    if (outcome.decided) return json(res, 200, outcome.decided);
    return json(res, 200, { redirectTo: consentRedirect(opened, origin, { code: outcome.code }), ...outcome.approved });
  }
  if (action === 'deny') {
    const decided = await registrations.consentViewDecision(human, handleDigest);
    const sealed = opened || (decided ? sealer.open(handle, { allowExpired: true }) : null);
    await registrations.denyConsent(human, consentRequest(sealed), handleDigest);
    return json(res, 200, { redirectTo: consentRedirect(sealed, origin, { error: 'access_denied', error_description: oauthErrorDescriptions.access_denied }) });
  }
  const decision = await registrations.consentViewDecision(human, handleDigest);
  const sealed = opened || (decision ? sealer.open(handle, { allowExpired: true }) : null);
  if (!sealed) throw invalid();
  const client = await remoteAuth.resolveClient(sealed.clientId);
  if (!client && !decision) throw invalid();
  const requestedPermissions = permissionsForScopes(sealed.scopes);
  const maximum = organizationMaximumPermissions();
  return json(res, 200, {
    client: consentClient(client, sealed), connectionRoute: sealed.connectionRoute,
    requestedPermissions, grantablePermissions: requestedPermissions.filter(permission => maximum.includes(permission)),
    expiresAt: new Date(sealed.exp * 1000).toISOString(), ...(decision ? { decision } : {})
  });
}

const httpWakeEnabled = onboardingFlags.httpWake;
const httpWake = createHttpWake({ store, enabled: httpWakeEnabled, installationsEnabled: onboardingFlags.installations,
  mcpWakeEnabled: Boolean(onboardingFlags.mcpWake), mcpEventsEnabled: Boolean(onboardingFlags.mcpEvents), grokTriggerEnabled: Boolean(onboardingFlags.grokTrigger),
  facts: async sub => {
    const [family, agent] = await Promise.all([store.getJson(agentCredentialFamilyPath(sub.inboxId, sub.agentId, sub.familyId)),
      store.getJson(path.join('inboxes', sub.inboxId, 'agents', `${sub.agentId}.json`))]);
    // Installation documents are immutable. Their current lifecycle is derived from
    // the family by the canonical reader, including installation-end/revoke state.
    const installation = sub.installationId && agent ? await installations.forFamily(sub.inboxId, agent, sub.familyId) : null;
    return { family, agent, installation: installation?.id === sub.installationId ? installation : null };
  },
  audit: async (inboxId, type, data, at) => {
    if (!inboxId) { await store.putJson(path.join('http-wake', 'epoch-audit', `${store.id('evt')}.json`), { type, data, createdAt: at }); return; }
    const record = await auditRecord(inboxId, type, data, at); await store.putJson(record.document.path, record.document.value);
  }
});
const mcpWakeTools = createMcpWakeTools({ httpWake, enabled: Boolean(onboardingFlags.mcpWake), clientFor: identity => oauthClients.get(identity.family?.oauthClientId) });
const providerEventWake = createProviderEventWake({ httpWake, store, key: connectorEncryptionKey(),
  mcpEventsEnabled: Boolean(onboardingFlags.mcpEvents), grokTriggerEnabled: Boolean(onboardingFlags.grokTrigger),
  validateCursor: async (identity, cursor) => {
    try { await resumeEventCursor(identity.inboxId, cursor); }
    catch (error) { if (error.code === 'EVENT_CURSOR_INVALID') throw Object.assign(new Error('Invalid cursor'), { rpcCode: -32602 }); throw error; }
  },
  authorizeOwner: async identity => {
    const { ownerRequest: req, ownerHumanId } = identity;
    const human = req && await auth.getHuman(req);
    const inbox = await store.getJson(path.join('inboxes', identity.inboxId, 'inbox.json'));
    const agent = await store.getJson(path.join('inboxes', identity.inboxId, 'agents', `${identity.agent.id}.json`));
    if (!human || human.id !== ownerHumanId || !inbox || !agent || !verifyCsrfRequest(req)
      || !await canManageInbox(human, inbox, { maxAgeMs: 0 })) throw codedError(403, 'AUTHENTICATION_REQUIRED', 'Workspace access is required.');
    if (req.method === 'PUT') {
      const family = await store.getJson(agentCredentialFamilyPath(identity.inboxId, agent.id, identity.family.id));
      const installation = await installations.forFamily(identity.inboxId, agent, identity.family.id);
      if (!family || family.revokedAt || Date.parse(family.refreshExpiresAt) <= Date.now() || installation?.status !== 'active'
        || installation.id !== identity.installationId || !canAct(agent, 'receive_agent_messages')) throw credentialError('CREDENTIAL_REVOKED');
    }
  },
  eventHistory: async (identity, cursor) => {
    // Same durable a4 event history, bounded to 72 hours/1000 retained rows.
    const rows = await store.queryJson(path.join('inboxes', identity.inboxId, 'events'), { sortField: 'cursor', order: 'desc', limit: 1000 });
    const retained = rows.filter(event => Date.parse(event.createdAt) > Date.now() - 72 * 3600000).reverse();
    const truncated = Boolean(cursor && (retained.length ? cursor < retained[0].cursor : rows.length));
    const events = [];
    for (const event of retained) {
      if (cursor && event.cursor <= cursor || event.agentId && event.agentId !== identity.agentId || event.recipientAgentId && event.recipientAgentId !== identity.agentId) continue;
      let type, reason;
      if (event.type === 'message.delivered' && event.recipientAgentId === identity.agentId) { type = 'wake.work_available'; reason = 'message_delivered'; }
      else if (event.type === 'work.available' && event.agentId === identity.agentId) { type = 'wake.work_available'; reason = ['human_instruction', 'case_resumed', 'counterparty_resumed', 'agent_resumed'].includes(event.reason) ? event.reason : 'work_due'; }
      else if (event.type === 'agent.resumed' && event.agentId === identity.agentId) { type = 'wake.work_available'; reason = 'agent_resumed'; }
      else if (event.type === 'agent.paused' && event.agentId === identity.agentId) { type = 'wake.control_changed'; reason = 'agent_paused'; }
      if (type) events.push({ type, reason, cursor: event.cursor });
    }
    return { cursor: retained.at(-1)?.cursor || cursor || null, truncated, events };
  }
});
const registrationLimits = createRegistrationLimits({ store });
const registrations = createAgentRegistrations({
  store, flags: onboardingFlags,
  codeKey: verificationCodeKey(Buffer.from(process.env.ENVOI_DATA_ENCRYPTION_KEY || 'sinaloa-development-only')),
  limits: registrationLimits, pollLimiter: createPollLimiter(), agentSlots, installations, withInboxMutation,
  canManageLive: (human, inbox) => canManageInbox(human, inbox, { maxAgeMs: 0 }),
  normalizeLocalPart: normalizeAgentLocalPart, addressForLocalPart: agentAddressForLocalPart, identityTaken, semanticDigest,
  memberOf: async (human, organizationId) => Boolean(organizationId && await getMembership(organizationId, human.id))
});
async function withInboxMutation(inboxId, operation, relatedInboxIds = [], additionalLockKeys = [], allowRemoved = false, transactionOptions = {}) {
  const committedEvents = [];
  const run = async () => {
    if (!allowRemoved && (await store.getJson(path.join('inboxes', inboxId, 'inbox.json')))?.status === 'removed') throw Object.assign(new Error('Removed agent history is read-only'), { statusCode: 409 });
    return operation(async (type, data, createdAt = store.now(), targetInboxId = inboxId) => {
    const record = await auditRecord(targetInboxId, type, data, createdAt);
    await store.putJson(record.document.path, record.document.value);
    committedEvents.push({ inboxId: targetInboxId, event: record.event });
    if (httpWakeEnabled) {
      if (type === 'work.available' && ['human_instruction', 'human_decision', 'case_resumed', 'counterparty_resumed', 'agent_resumed'].includes(data.reason)) await httpWake.trigger({ inboxId: targetInboxId, agentId: data.agentId, reason: data.reason, cursor: record.event.cursor });
      if (type === 'agent.resumed') await httpWake.trigger({ inboxId: targetInboxId, agentId: data.agentId, reason: 'agent_resumed', cursor: record.event.cursor });
      if (type === 'agent.paused') await httpWake.pause(targetInboxId, data.agentId, record.event.cursor);
    }
    return record.event;
    });
  };
  const result = typeof store.withTransaction === 'function'
    ? await store.withTransaction([...new Set([inboxId, ...relatedInboxIds])].map(inboxMutationKey).concat(additionalLockKeys), run, transactionOptions)
    : await run();
  for (const committed of committedEvents) publish(committed.inboxId, committed.event);
  return result;
}

async function withCaseMutation(inboxId, caseId, operation, { allowPaused = false } = {}) {
  const binding = await store.getJson(caseBindingPath(caseId));
  const related = binding?.inboxIds?.filter(id => id !== inboxId) || [];
  return withInboxMutation(inboxId, async writeAudit => {
    const current = await store.getJson(caseBindingPath(caseId));
    if (current && current.inboxIds.some(id => id !== inboxId && !related.includes(id))) {
      throw Object.assign(new Error('Case participants changed while acquiring the mutation lock; retry'), { statusCode: 409 });
    }
    if (!allowPaused) await assertCaseProgressAllowed(inboxId, caseId);
    return operation(writeAudit);
  }, related, [caseMutationKey(caseId)]);
}
async function assertCaseProgressAllowed(inboxId, caseId) {
  const value = await getCase(inboxId, caseId);
  if (value?.state === 'paused' || value?.state === 'revoked') throw codedError(409, 'CASE_CONTROLLED', 'This case is paused or revoked by a human.', { caseId });
}

// `writeAudit` is the caller's transaction writer, so the session-end audits are published with it.
async function revokeAgentCredentialFamilies(inboxId, agentId, humanId, revokedAt = store.now(), revokedReason = 'revoked', writeAudit = null) {
  const families = await store.listJson(path.join('auth', 'agent-credential-families', inboxId, agentId));
  const active = families.filter(family => !family.revokedAt);
  await store.putJsonBatch(active.map(family => document(agentCredentialFamilyPath(inboxId, agentId, family.id), {
    ...family,
    revokedAt,
    revokedReason,
    revokedByHumanId: humanId,
    updatedAt: revokedAt
  })));
  for (const family of active) if (family.audience) await deleteOAuthRecoveries(family.id).catch(() => {});
  await caseSessions.endForAgent(inboxId, agentId, 'credential_ended', revokedAt, writeAudit);
  if (httpWakeEnabled) for (const family of active) await httpWake.endForFamily(inboxId, agentId, family.id);
  return active.length;
}

// Ends one installation (agent-registration v1 §6.5) without freezing the identity.
async function revokeCredentialFamily(inboxId, agentId, familyId, humanId, revokedAt = store.now(), revokedReason = 'revoked', writeAudit = null) {
  const familyPath = agentCredentialFamilyPath(inboxId, agentId, familyId);
  const family = await store.getJson(familyPath);
  if (!family || family.revokedAt) return null;
  const revoked = { ...family, revokedAt, revokedReason, revokedByHumanId: humanId, updatedAt: revokedAt };
  await store.putJson(familyPath, revoked);
  if (family.audience) await deleteOAuthRecoveries(family.id).catch(() => {});
  await caseSessions.endForFamily(inboxId, agentId, familyId, 'credential_ended', revokedAt, writeAudit);
  if (httpWakeEnabled) await httpWake.endForFamily(inboxId, agentId, familyId);
  return revoked;
}

async function freezeAgentRecord(inboxId, agent, humanId, revokedAt) {
  const frozen = { ...agent, status: 'revoked', onboardingStatus: 'revoked', permissions: [], revokedAt, revokedByHumanId: humanId, accessGeneration: (agent.accessGeneration || 0) + 1, updatedAt: revokedAt };
  const documents = [
    document(path.join('inboxes', inboxId, 'agents', `${agent.id}.json`), frozen),
    document(path.join('directory', 'agents', `${agent.id}.json`), { agentId: agent.id, inboxId, address: agent.address, externalAddress: externalEmailEnabled ? publicEmailAddressForAgent(agent) : null, status: 'revoked', verified: true }),
    document(nativeAddressDirectoryPath(agent.address), { agentId: agent.id, inboxId, address: agent.address, status: 'revoked', verified: true })
  ];
  if (externalEmailEnabled && publicEmailAddressForAgent(agent)) documents.push(document(externalAddressDirectoryPath(publicEmailAddressForAgent(agent)), { agentId: agent.id, inboxId, address: publicEmailAddressForAgent(agent), status: 'revoked' }));
  await store.putJsonBatch(documents);
  return frozen;
}

// Freezes agents whose families were all revoked before the agent-wide revoke froze in its own
// mutation (ce07de5). agent-registration v1 §6.5 and §12: it must never freeze an agent whose
// families ended by a per-installation revoke, a replay or a replacement. Those all carry a
// revokedReason (a50766c), so only families without one are reconciled, and the job runs one
// last time behind a marker and then retires.
const legacyRevocationMarkerPath = path.join('system', 'agent-revocations-reconciled-v1.json');
async function reconcileLegacyAgentRevocations() {
  if (await store.getJson(legacyRevocationMarkerPath)) return;
  const directory = await store.listJson(path.join('directory', 'agents'));
  for (const entry of directory) {
    if (!['active', 'paused'].includes(entry.status)) continue;
    await withInboxMutation(entry.inboxId, async writeAudit => {
      const agent = await store.getJson(path.join('inboxes', entry.inboxId, 'agents', `${entry.agentId}.json`));
      if (!agent || !['active', 'paused'].includes(agent.status)) return;
      const families = await store.listJson(path.join('auth', 'agent-credential-families', entry.inboxId, entry.agentId));
      if (!families.length || families.some(family => !family.revokedAt || family.revokedReason)) return;
      const revokedAt = families.map(family => family.revokedAt).sort().at(-1);
      await freezeAgentRecord(entry.inboxId, agent, families.find(family => family.revokedByHumanId)?.revokedByHumanId || null, revokedAt);
      await writeAudit('agent.revocation_reconciled', { agentId: agent.id });
    });
  }
  await store.putJson(legacyRevocationMarkerPath, { reconciledAt: store.now(), releaseSha });
}

function setCaseMessageDeliveryState(value, message, state, at) {
  const eventId = `evt_${message.id}`;
  const existing = value.events.find(item => item.id === eventId);
  if (existing) {
    existing.payload = { ...existing.payload, deliveryState: state };
    value.updatedAt = at;
    return value;
  }
  appendEvent(value, {
    id: eventId,
    type: 'message',
    actor: message.senderAgentId,
    createdAt: message.createdAt,
    payload: {
      messageId: message.id,
      messageType: message.type,
      text: message.text,
      data: message.payload,
      senderAgentId: message.senderAgentId,
      recipientAgentId: message.recipientAgentId,
      recipientEmail: message.recipientEmail,
      subject: message.subject,
      transport: message.transport || 'native',
      deliveryState: state
    },
    linkedPolicyEvaluation: null,
    precedingEventRef: value.events.at(-1)?.id || null
  });
  value.updatedAt = at;
  return value;
}

async function getMembership(organizationId, humanId) {
  if (!organizationId || !humanId) return null;
  const membership = await store.getJson(path.join('organizations', organizationId, 'members', `${humanId}.json`));
  return membership?.status === 'active' ? membership : null;
}

async function getAuthorizedMembership(organizationId, human, { maxAgeMs } = {}) {
  if (!human) return null;
  const membership = await getMembership(organizationId, human.id);
  if (!membership || auth.provider !== 'workos') return membership;
  const organization = await store.getJson(path.join('organizations', organizationId, 'organization.json'));
  if (!organization?.workosOrganizationId || !human.providerUserId || typeof auth.getOrganizationMembership !== 'function') return null;
  const current = await rememberedProviderMembership(human, organization.workosOrganizationId, { maxAgeMs });
  return current ? { ...membership, providerMembership: current } : null;
}

async function canAccessInbox(human, inbox, options) {
  return Boolean(await getAuthorizedMembership(inbox.organizationId, human, options));
}

async function canManageInbox(human, inbox, options) {
  if (inbox.status === 'removed') return false;
  const membership = await getAuthorizedMembership(inbox.organizationId, human, options);
  return membershipCanManage(membership, auth.provider);
}

async function listHumanOrganizations(humanId) {
  const references = await store.listJson(path.join('humans', humanId, 'organizations'));
  const organizations = await Promise.all(references.map(reference => store.getJson(path.join('organizations', reference.organizationId, 'organization.json'))));
  return organizations.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
}

async function createOrganization(human, input = {}, idempotencyKey) {
  const name = String(input.name || '').trim();
  if (!name) throw Object.assign(new Error('Organization name is required'), { statusCode: 400 });
  const safeKey = validateIdempotencyKey(idempotencyKey);
  const requestDigest = semanticDigest({ name });
  const idempotencyPath = safeKey ? scopedIdempotencyPath('organizations', human.id, human.id, safeKey) : null;
  let idempotencyClaim = null;
  if (idempotencyPath) {
    idempotencyClaim = await claimIdempotency(store, idempotencyPath, { principalId: human.id, requestDigest, createdAt: store.now() });
    if (idempotencyClaim.replay) return idempotencyClaim.replay;
  }
  try {
    const organizationId = store.id('org');
    let providerOrganization = null;
    if (auth.provider === 'workos') {
      providerOrganization = await auth.createProviderOrganization({
        name,
        externalId: organizationId,
        idempotencyKey: safeKey || organizationId,
        userId: human.providerUserId
      });
    }
    const organization = {
      id: organizationId,
      name,
      slug: slugify(name) || organizationId.slice(-8),
      ownerHumanId: human.id,
      workosOrganizationId: providerOrganization?.id || null,
      status: 'active',
      createdAt: store.now(),
      updatedAt: store.now()
    };
    const membership = { organizationId, humanId: human.id, role: 'owner', status: 'active', createdAt: organization.createdAt };
    await Promise.all([
      store.putJson(path.join('organizations', organizationId, 'organization.json'), organization),
      store.putJson(path.join('organizations', organizationId, 'members', `${human.id}.json`), membership),
      store.putJson(path.join('humans', human.id, 'organizations', `${organizationId}.json`), { organizationId, role: 'owner' }),
      ...(providerOrganization ? [store.putJson(path.join('auth', 'workos-organization-index', `${encodeURIComponent(providerOrganization.id)}.json`), { organizationId })] : [])
    ]);
    if (idempotencyPath) await completeIdempotency(store, idempotencyPath, { principalId: human.id, requestDigest, response: organization, createdAt: organization.createdAt });
    return organization;
  } catch (error) {
    if (idempotencyPath && idempotencyClaim?.claimed) await store.deleteJson(idempotencyPath).catch(() => {});
    throw error;
  }
}

async function ensureOrganization(human, requestedId) {
  if (requestedId) {
    const organizationId = assertSafeIdentifier(requestedId, 'organizationId');
    const organization = await store.getJson(path.join('organizations', organizationId, 'organization.json'));
    if (!organization || !await getAuthorizedMembership(organizationId, human)) throw Object.assign(new Error('Active organization membership required'), { statusCode: 403 });
    return organization;
  }
  const existingOrganizations = await listHumanOrganizations(human.id);
  let existing = null;
  for (const organization of existingOrganizations) {
    if (await getAuthorizedMembership(organization.id, human)) { existing = organization; break; }
  }
  return existing || createOrganization(human, { name: `${human.displayName || 'My'} workspace` }, `personal-${human.id}`);
}

async function createDedicatedAgentInbox({ sourceInbox, organizationId, ownerHumanId, agent, status = 'pending_approval', inboxId = store.id('inbox') }) {
  const createdAt = agent.createdAt || store.now();
  const inbox = {
    id: inboxId,
    organizationId,
    name: `${agent.name} inbox`,
    ownerAgentId: agent.id,
    ownerHumanId,
    parentInboxId: sourceInbox?.id || null,
    kind: 'agent',
    status,
    createdAt
  };
  await store.ensureInbox(inboxId);
  await Promise.all([
    store.putJson(path.join('inboxes', inboxId, 'inbox.json'), inbox),
    store.putJson(path.join('organizations', organizationId, 'workspaces', `${inboxId}.json`), { inboxId, createdAt }),
    store.putJson(path.join('inboxes', inboxId, 'agents', `${agent.id}.json`), agent),
    store.putJson(path.join('inboxes', inboxId, 'contacts', `${agent.id}.json`), { agentId: agent.id, approved: true, blocked: false, updatedAt: createdAt })
  ]);
  return inbox;
}

async function synchronizePublicEmailDirectory() {
  const entries = await store.listJson(path.join('directory', 'agents'));
  for (const entry of entries) {
    if (entry.status !== 'active' || !entry.inboxId || !entry.agentId) continue;
    const agentPath = path.join('inboxes', entry.inboxId, 'agents', `${entry.agentId}.json`);
    const agent = await store.getJson(agentPath);
    if (!agent?.slug) continue;
    const externalAddress = externalEmailEnabled ? publicEmailAddressForAgent(agent) : null;
    agent.identity = { ...(agent.identity || publicIdentity(agent.slug)), externalAddress, externalTransportStatus: publicEmailTransportStatus().ready ? 'ready' : 'disabled' };
    const documents = [
      document(agentPath, agent),
      document(path.join('directory', 'agents', `${agent.id}.json`), { ...entry, address: agent.address, externalAddress, verified: true }),
      document(nativeAddressDirectoryPath(agent.address), { agentId: agent.id, inboxId: entry.inboxId, address: agent.address, status: agent.status, verified: true })
    ];
    if (externalAddress) documents.push(document(externalAddressDirectoryPath(externalAddress), { agentId: agent.id, inboxId: entry.inboxId, address: externalAddress, status: agent.status }));
    await store.putJsonBatch(documents);
  }
}

const calendarConnectorPath = (inboxId, provider) => path.join('inboxes', inboxId, 'calendar-connectors', `${provider}.json`);
const calendarProviderStatus = () => Object.fromEntries(Object.entries(calendarProviders).map(([id, provider]) => [id, { id, label: provider.label, configured: Boolean(provider.clientId && provider.clientSecret) }]));
const calendarRedirectUri = (provider, req) => process.env[provider === 'google' ? 'GOOGLE_CALENDAR_REDIRECT_URI' : 'MICROSOFT_CALENDAR_REDIRECT_URI'] || `${(process.env.ENVOI_PUBLIC_URL || `http://${req.headers.host || `${host}:${port}`}`).replace(/\/$/, '')}/api/calendar-oauth/${provider}/callback`;
const tokenAccountLabel = tokenSet => {
  try {
    const payload = JSON.parse(Buffer.from(String(tokenSet.id_token || '').split('.')[1], 'base64url').toString('utf8'));
    return payload.email || payload.preferred_username || payload.name || null;
  } catch {
    return null;
  }
};

async function listMessages(inboxId, caseId, { limit = 100, before = null } = {}) {
  return store.queryJson(path.join('inboxes', inboxId, 'messages'), { limit, before, filters: caseId ? { caseId } : {}, sortField: 'createdAt' });
}

async function listCases(inboxId, { limit = 100, before = null } = {}) {
  return store.queryJson(path.join('inboxes', inboxId, 'cases'), { limit, before, sortField: 'updatedAt' });
}

const caseRecordPath = (inboxId, caseId) => path.join('inboxes', inboxId, 'cases', `${caseId}.json`);
const caseBindingPath = caseId => path.join('shared-case-bindings', `${caseId}.json`);
const sharedCasePath = caseId => path.join('shared-cases', `${caseId}.json`);
const assetGrantPath = (recipientInboxId, assetId) => path.join('inboxes', recipientInboxId, 'asset-grants', `${assetId}.json`);
const objectMetadataPath = assetId => path.join('object-storage', 'metadata', `${assetId}.json`);
const pairIds = ids => [...new Set(ids)].sort();
const caseParticipantMismatch = () => Object.assign(new Error('Case ID belongs to another participant pair'), { statusCode: 403, code: 'CASE_PARTICIPANT_MISMATCH' });
const nativeIdempotencyConflict = () => Object.assign(new Error('Idempotency key was already used for a different message'), { statusCode: 409, code: 'IDEMPOTENCY_CONFLICT' });
const matchesCasePair = (binding, message) => JSON.stringify(binding.agentIds) === JSON.stringify(pairIds([message.senderAgentId, message.recipientAgentId]))
  && JSON.stringify(binding.inboxIds) === JSON.stringify(pairIds([message.senderInboxId, message.recipientInboxId]));
async function sharedCaseForAsset(caseId) {
  const [binding, value] = await Promise.all([store.getJson(caseBindingPath(caseId)), store.getJson(sharedCasePath(caseId))]);
  return binding?.agentIds?.length === 2 && binding?.inboxIds?.length === 2 && value?.id === caseId
    && JSON.stringify(pairIds(value.participants || [])) === JSON.stringify(binding.agentIds) ? { binding, value } : null;
}
const agentFamilies = (inboxId, agentId) => store.listJson(path.join('auth', 'agent-credential-families', inboxId, agentId));
async function agentControlState(inboxId, agent, families = null) {
  families ??= await agentFamilies(inboxId, agent.id);
  const credentialRevoked = agent.status === 'revoked' || families.length > 0 && families.every(family => family.revokedAt);
  return { ...publicAgent(agent), ...(credentialRevoked ? { status: 'revoked', permissions: [] } : {}), paused: agent.status === 'paused', credentialRevoked };
}
// a5-presence §4.2: owner views only, kept out of agentControlState because authorization uses
// that. A failed presence read omits connection, and the client shows "Status unknown".
// Never call it inside a mutation: a failed read there would abort the PostgreSQL transaction.
// Pass the families the state was built from, so both read one consistent listing.
async function withOwnerConnection(inboxId, state, families = null) {
  try {
    const family = reportedFamily(families ?? await agentFamilies(inboxId, state.id));
    const record = family ? await store.getJson(agentPresencePath(inboxId, state.id, family.id)) : null;
    // a5-presence-on-demand §2: the reported family's installation decides whether it is on demand. A family with no
    // installationId is a legacy envoi_link installation. A family naming an installation whose document cannot be read omits
    // the connection; it never falls back to the rows for a running host.
    let onDemand = false;
    if (family?.installationId) {
      const installation = await store.getJson(installationPath(inboxId, state.id, family.installationId));
      if (!installation) throw new Error('The reported family names an installation that cannot be read');
      onDemand = installation.deliveryMode === 'on_demand';
    }
    return { ...state, connection: ownerConnection(state, family, record, store.now(), { onDemand }) };
  } catch {
    console.error(JSON.stringify({ event: 'envoi.agent_presence_read_failed' }));
    return state;
  }
}
async function ownerAgentState(inboxId, agent) {
  const families = await agentFamilies(inboxId, agent.id);
  return withOwnerConnection(inboxId, await agentControlState(inboxId, agent, families), families);
}
async function assetPair(asset, recipientAgentId, recipientInboxId) {
  if (!asset?.key || !asset.caseId || !asset.workspaceId || !asset.createdByAgentId || asset.createdByAgentId === recipientAgentId) return null;
  const shared = await sharedCaseForAsset(asset.caseId);
  if (!shared || !matchesCasePair(shared.binding, { senderAgentId: asset.createdByAgentId, recipientAgentId, senderInboxId: asset.workspaceId, recipientInboxId })) return null;
  const [ownerDirectory, recipientDirectory] = await Promise.all([
    store.getJson(path.join('directory', 'agents', `${asset.createdByAgentId}.json`)),
    store.getJson(path.join('directory', 'agents', `${recipientAgentId}.json`))
  ]);
  return ownerDirectory?.inboxId === asset.workspaceId && recipientDirectory?.inboxId === recipientInboxId ? shared : null;
}
async function assetRelationshipBlocked(asset, recipientAgentId, recipientInboxId) {
  const [ownerContact, recipientContact] = await Promise.all([
    store.getJson(path.join('inboxes', asset.workspaceId, 'contacts', `${recipientAgentId}.json`)),
    store.getJson(path.join('inboxes', recipientInboxId, 'contacts', `${asset.createdByAgentId}.json`))
  ]);
  return Boolean(ownerContact?.blocked || recipientContact?.blocked);
}
async function assetReader(req, inbox) {
  const [human, agent] = await Promise.all([auth.getHuman(req), getAgentPrincipal(req, inbox.id)]);
  return { agent, manager: await canManageInbox(human, inbox) };
}
async function assetReadAccess(asset, inbox, reader) {
  if (!asset) return { allowed: false };
  if (asset.caseId) {
    const shared = await sharedCaseForAsset(asset.caseId);
    if (!shared || shared.value.state === 'paused' || shared.value.state === 'revoked') return { allowed: false };
    const agents = await Promise.all(shared.binding.agentIds.map(async id => {
      const directory = await store.getJson(path.join('directory', 'agents', `${id}.json`));
      return directory ? store.getJson(path.join('inboxes', directory.inboxId, 'agents', `${id}.json`)) : null;
    }));
    if (agents.some(agent => !agent || agent.status !== 'active')) return { allowed: false };
  }
  if ((asset.workspaceId || asset.inboxId) === inbox.id) return { allowed: Boolean(reader.manager || reader.agent?.id === asset.createdByAgentId && canAct(reader.agent, 'create_assets')), owner: true };
  const grant = await store.getJson(assetGrantPath(inbox.id, asset.id));
  if (!grant || grant.assetId !== asset.id || grant.caseId !== asset.caseId || grant.ownerInboxId !== asset.workspaceId
    || grant.ownerAgentId !== asset.createdByAgentId || grant.recipientInboxId !== inbox.id
    || !reader.manager && (reader.agent?.id !== grant.recipientAgentId || !canAct(reader.agent, 'receive_agent_messages'))
    || !await assetPair(asset, grant.recipientAgentId, inbox.id)) return { allowed: false };
  if (await assetRelationshipBlocked(asset, grant.recipientAgentId, inbox.id)) return { allowed: false, blocked: true };
  return { allowed: true, owner: false, grant };
}
async function saveCase(inboxId, value) {
  const binding = await store.getJson(caseBindingPath(value.id));
  if (!binding) return store.putJson(caseRecordPath(inboxId, value.id), value);
  if (!binding.inboxIds.includes(inboxId) || JSON.stringify(pairIds(value.participants)) !== JSON.stringify(binding.agentIds)) throw caseParticipantMismatch();
  const documents = [document(sharedCasePath(value.id), value)];
  for (const participantInboxId of binding.inboxIds) {
    if (participantInboxId === inboxId || await store.getJson(caseRecordPath(participantInboxId, value.id))) documents.push(document(caseRecordPath(participantInboxId, value.id), value));
  }
  await store.putJsonBatch(documents);
}
const getCase = async (inboxId, caseId) => {
  const local = await store.getJson(caseRecordPath(inboxId, caseId));
  if (!local) return null;
  const binding = await store.getJson(caseBindingPath(caseId));
  const value = binding?.inboxIds?.includes(inboxId) ? await store.getJson(sharedCasePath(caseId)) : local;
  if (!value) throw Object.assign(new Error('Bound case has no canonical record'), { statusCode: 409 });
  return value?.schemaVersion && !value.collaborationMode ? { ...value, collaborationMode: 'collaboration' } : value;
};
const isCaseParticipant = (value, agentId) => Boolean(agentId && (value?.actingAgent === agentId || value?.participants?.includes(agentId)));

function proposalFromInput(input, now) {
  const options = Array.isArray(input.options) ? input.options.map(item => ({
    id: item.id || store.id('option'),
    value: item.value && typeof item.value === 'object' ? item.value : {},
    sourceConfidence: item.sourceConfidence || 'enteredForCase',
    expired: Boolean(item.expired),
    outOfPolicyFlags: Array.isArray(item.outOfPolicyFlags) ? [...new Set(item.outOfPolicyFlags)] : []
  })) : [];
  if (!options.length) throw Object.assign(new Error('At least one structured proposal option is required'), { statusCode: 400 });
  return { id: store.id('proposal'), kind: input.kind, options, status: 'open', acceptedOptionId: null, expiresAt: input.expiresAt || null, createdAt: now, updatedAt: now };
}

function policyEvaluationFromInput(input, actor, now) {
  return {
    id: input.id,
    requestedAction: input.requestedAction,
    actor,
    matchedPolicyId: input.matchedPolicyId || null,
    decision: input.decision,
    grantType: input.grantType || 'oneTime',
    effectiveAt: now,
    expiresAt: input.expiresAt || null,
    reasonCode: input.reasonCode
  };
}

const policyBindingPath = (inboxId, evaluationId) => path.join('inboxes', inboxId, 'policy-bindings', `${evaluationId}.json`);
const policyExecutionPath = (inboxId, executionId) => path.join('inboxes', inboxId, 'policy-executions', `${executionId}.json`);
const minutesFromClock = value => {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes >= 0 && minutes < 1440 ? minutes : null;
};
const zonedMinutes = (instant, timezone) => {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant));
    return Number(parts.find(part => part.type === 'hour')?.value) * 60 + Number(parts.find(part => part.type === 'minute')?.value);
  } catch { return null; }
};

async function activeWorkspacePolicy(inboxId) {
  const configured = await store.getJson(path.join('inboxes', inboxId, 'policies', 'active.json')) || {};
  return createWorkspacePolicy({
    ...configured,
    id: configured.id || 'sinaloa-default-authority',
    version: configured.version || process.env.ENVOI_POLICY_VERSION || '2026-09-27',
    decisionTtlSeconds: configured.decisionTtlSeconds ?? Number(process.env.ENVOI_POLICY_DECISION_TTL_SECONDS || 600),
    executeAtToleranceSeconds: configured.executeAtToleranceSeconds ?? Number(process.env.ENVOI_POLICY_EXECUTE_AT_TOLERANCE_SECONDS || 60),
    maxPaymentMinorWithoutHuman: configured.maxPaymentMinorWithoutHuman ?? Number(process.env.ENVOI_POLICY_MAX_AUTOMATIC_PAYMENT_MINOR || 0),
    consequentialActionsEnabled: consequentialActionsEnabled && configured.consequentialActionsEnabled !== false,
    externalEmailEnabled: externalEmailEnabled && configured.externalEmailEnabled !== false,
    calendarWritesEnabled: calendarWritesEnabled && configured.calendarWritesEnabled !== false
    ,...(onboardingFlags.caseSessions ? { agreements: { requireHumanApproval: configured.agreements?.requireHumanApproval !== false } } : {})
  });
}

async function policyDecisionChain(inboxId) {
  const decisions = [
    ...await store.listJson(path.join('inboxes', inboxId, 'policy-bindings')),
    ...await store.listJson(path.join('inboxes', inboxId, 'policy-executions'))
  ];
  if (!verifyDecisionChain(decisions, { keyring: policyKeyring, requireSigned: true })) {
    throw Object.assign(new Error('Policy decision history failed integrity verification'), { statusCode: 409, code: 'POLICY_CHAIN_INVALID' });
  }
  const referenced = new Set(decisions.map(decision => decision.previousRecordDigest).filter(Boolean));
  return { records: decisions, latest: decisions.find(decision => !referenced.has(decision.recordDigest)) || null };
}

async function evaluateServerPolicy(inboxId, agent, caseRecord, input, options = {}) {
  const requestedAction = String(input.requestedAction || '');
  const requiredPermission = actionPermission(requestedAction);
  const actionPayload = {
    ...(input.actionPayload && typeof input.actionPayload === 'object' && !Array.isArray(input.actionPayload) ? input.actionPayload : {}),
    ...(input.recipientEmail && !input.actionPayload?.recipientEmail ? { recipientEmail: normalizedEmail(input.recipientEmail) } : {})
  };
  const recipientEmail = normalizedEmail(actionPayload.recipientEmail);
  const contact = requestedAction.startsWith('email.') && validEmail(recipientEmail) ? await store.getJson(externalContactPath(inboxId, recipientEmail)) : null;
  const connectors = requestedAction.startsWith('calendar.') ? await store.listJson(path.join('inboxes', inboxId, 'calendar-connectors')) : [];
  const startBoundary = minutesFromClock(caseRecord.constraints?.workingHoursStart);
  const endBoundary = minutesFromClock(caseRecord.constraints?.workingHoursEnd);
  const scheduleOptions = requestedAction.startsWith('calendar.') ? (caseRecord.proposals || []).filter(proposal => ['open', 'countered'].includes(proposal.status) && proposal.kind === 'schedule').flatMap(proposal => proposal.options.filter(option => !option.expired)) : [];
  const outsideWorkingHours = scheduleOptions.some(option => {
    const candidate = zonedMinutes(option.value?.start, option.value?.timezone || caseRecord.constraints?.timezone || 'UTC');
    return candidate != null && ((startBoundary != null && candidate < startBoundary) || (endBoundary != null && candidate > endBoundary));
  });
  const policy = await activeWorkspacePolicy(inboxId);
  const chain = await policyDecisionChain(inboxId);
  const record = evaluatePolicy({
    id: options.id || input.id || store.id(options.phase === 'execution' ? 'policy_exec' : 'policy_eval'),
    executionId: options.executionId || null,
    workspaceId: inboxId,
    caseId: caseRecord.id,
    agentId: agent.id,
    requestedAction,
    actionPayload,
    permissionGranted: canAct(agent, requiredPermission),
    caseDeadline: caseRecord.deadline,
    requestedExpiresAt: input.expiresAt,
    contactApproved: contact ? contact.approved && !contact.blocked && ['outbound', 'both'].includes(contact.direction || 'both') : false,
    calendarConnectorAvailable: connectors.some(connector => connector.status === 'connected'),
    outsideWorkingHours,
    proposalDigest: valueDigest(caseRecord.proposals || []),
    allowedOptionIds: (caseRecord.proposals || []).flatMap(proposal => proposal.options.filter(option => !option.expired).map(option => option.id)),
    policy,
    previousRecordDigest: chain.latest?.recordDigest || null,
    phase: options.phase || 'evaluation',
    sourceEvaluationId: options.sourceEvaluationId || null,
    grantType: input.grantType || 'oneTime',
    humanDecisionRequired: onboardingFlags.caseSessions && requestedAction === 'proposal.accept' ? policy.agreements?.requireHumanApproval !== false
      : onboardingFlags.caseSessions && requestedAction === 'case.complete' ? caseToolCompletionNeedsHuman(caseRecord, agent.id) : input.humanDecisionRequired === true ? true : null,
    keyring: policyKeyring,
    now: store.now()
  });
  if (await monadAccess.active(inboxId)) {
    if (record.decision === 'deny') {
      try {
        await monadPermissions.recordViolation({
          requestId: crypto.randomUUID(), inboxId, agentId: agent.id,
          method: 'POLICY', pathname: requestedAction, status: 403,
          reasonCode: record.reasonCode,
          permissionFingerprint: commitment('permission', permissionSnapshot(inboxId, agent))
        });
      } catch { /* The durable outbox retries an unsent violation. */ }
    }
  }
  return {
    decision: record.decision,
    reasonCode: record.reasonCode,
    matchedPolicyId: `${policy.id}@${policy.version}`,
    expiresAt: record.expiresAt,
    binding: record
  };
}

const hasHumanApprovalForEvaluation = (caseRecord, evaluationId, inboxId = null) => caseRecord.events.some(event =>
  event.type === 'humanAction'
  && event.payload?.action?.actionKey === 'approveOnce'
  && event.payload.action.externalRefs?.policyEvaluationId === evaluationId
  && (!inboxId || event.payload.action.externalRefs?.sourceInboxId === inboxId)
);

const actionRequestDigest = input => {
  const externalRefs = { ...(input.externalRefs || {}) };
  delete externalRefs.policyExecutionId;
  delete externalRefs.requestDigest;
  return valueDigest({
    actor: input.actor,
    actionKey: input.actionKey,
    outcome: input.outcome ?? null,
    nextState: input.nextState ?? null,
    policyEvaluationId: input.policyEvaluationId ?? externalRefs.policyEvaluationId ?? null,
    actionPayload: input.actionPayload || {},
    externalRefs,
    reasonCode: input.reasonCode ?? null
  });
};

async function validatedPolicyBinding(inboxId, caseRecord, principal, evaluationId, { requestedAction, actionPayload, proposalId, optionId, executionId = store.id('action'), allowPendingHuman = false, writeAudit = (type, data) => audit(inboxId, type, data) } = {}) {
  const evaluation = caseRecord.policyEvaluations.find(item => item.id === evaluationId);
  const binding = evaluation ? await store.getJson(policyBindingPath(inboxId, evaluation.id)) : null;
  await policyDecisionChain(inboxId);
  if (!evaluation || !binding || !verifyDecisionRecord(binding, { keyring: policyKeyring, requireSigned: true }) || evaluation.actor !== principal.id || binding.agentId !== principal.id || binding.caseId !== caseRecord.id) {
    throw Object.assign(new Error('A current server-issued policy evaluation for this agent and case is required'), { statusCode: 403 });
  }
  const proposalStateDigest = valueDigest(caseRecord.proposals || []);
  assertExactBinding(binding, { requestedAction: requestedAction || binding.requestedAction, actionPayload: actionPayload || {}, proposalDigest: proposalId ? proposalStateDigest : null, optionId, keyring: policyKeyring, at: store.now() });
  if (evaluation.decision === 'deny') throw Object.assign(new Error(`Policy denied this action: ${evaluation.reasonCode}`), { statusCode: 403 });
  const humanApproved = hasHumanApprovalForEvaluation(caseRecord, evaluation.id, onboardingFlags.caseSessions && ['proposal.accept', 'case.complete', 'message.reply'].includes(binding.requestedAction) ? inboxId : null);
  if (evaluation.decision === 'needsHuman' && !humanApproved && !allowPendingHuman) {
    throw Object.assign(new Error('This action requires human approval'), { statusCode: 409 });
  }
  if (proposalId && !caseRecord.proposals.some(proposal => proposal.id === proposalId)) throw Object.assign(new Error('Proposal not found'), { statusCode: 404 });
  if (evaluation.decision === 'needsHuman' && !humanApproved && allowPendingHuman) {
    return { evaluation, binding, refreshed: binding, humanApproved: false, executionId };
  }
  const priorExecutions = await store.listJson(path.join('inboxes', inboxId, 'policy-executions'));
  if (binding.grantType === 'oneTime' && priorExecutions.some(record => record.sourceEvaluationId === evaluation.id)) throw Object.assign(new Error('This one-time policy evaluation has already been consumed'), { statusCode: 409 });

  const refreshed = await evaluateServerPolicy(inboxId, principal, caseRecord, {
    requestedAction: binding.requestedAction,
    actionPayload: binding.actionPayload,
    expiresAt: binding.expiresAt,
    grantType: binding.grantType || 'oneTime'
  }, { id: store.id('policy_exec'), phase: 'execution', executionId, sourceEvaluationId: evaluation.id });
  const executionPath = policyExecutionPath(inboxId, binding.grantType === 'oneTime' ? evaluation.id : refreshed.binding.id);
  const persisted = binding.grantType === 'oneTime'
    ? await store.putJsonIfAbsent(executionPath, refreshed.binding)
    : (await store.putJson(executionPath, refreshed.binding), true);
  if (!persisted) throw Object.assign(new Error('This one-time policy evaluation has already been consumed'), { statusCode: 409 });
  await writeAudit('policy.re_evaluated', {
    caseId: caseRecord.id,
    policyEvaluationId: evaluation.id,
    policyExecutionId: refreshed.binding.id,
    executionId,
    requestedAction: refreshed.binding.requestedAction,
    decision: refreshed.decision,
    reasonCode: refreshed.reasonCode,
    previousRecordDigest: refreshed.binding.previousRecordDigest,
    recordDigest: refreshed.binding.recordDigest
  });
  if (refreshed.decision === 'deny') throw Object.assign(new Error(`Current policy denied this action: ${refreshed.reasonCode}`), { statusCode: 403 });
  const approvalApplies = humanApproved && refreshed.binding.policy.digest === binding.policy.digest;
  if (onboardingFlags.caseSessions && humanApproved && !approvalApplies) throw Object.assign(new Error('Current policy requires a new human approval'), { statusCode: 409 });
  if (refreshed.decision === 'needsHuman' && !approvalApplies && !allowPendingHuman) {
    throw Object.assign(new Error('Current policy requires a new human approval'), { statusCode: 409 });
  }
  return { evaluation, binding, refreshed: refreshed.binding, humanApproved: approvalApplies, executionId };
}

async function ensureStructuredCase(inbox, input, actorAgentId, at) {
  const caseId = input.caseId ? assertSafeIdentifier(input.caseId, 'caseId') : store.id('case');
  const existing = await getCase(inbox.id, caseId);
  if (existing?.schemaVersion) return existing;
  let value = createAgentCase({
    id: caseId,
    objective: input.objective || input.text?.slice(0, 160) || 'Agent communication',
    collaborationMode: input.collaborationMode || ({ proposal: 'negotiation', counterproposal: 'negotiation', knowledge: 'knowledgeSharing', artifact: 'artifactCreation' }[input.type] || 'collaboration'),
    principal: inbox.ownerHumanId,
    actingAgent: actorAgentId,
    participants: [actorAgentId, input.recipientAgentId].filter(Boolean),
    constraints: input.constraints || {},
    deadline: input.deadline || null,
    createdAt: existing?.createdAt || at
  });
  value = transitionCase(value, 'inProgress', { actor: actorAgentId, at, reasonCode: existing ? 'legacyCaseMigrated' : 'caseStarted' });
  return value;
}

async function nativeCaseDocuments(message, state, at, { revealRecipient = false, scopedAccept = false, scopedReject = false, scopedCompletion = null } = {}) {
  const bindingPath = caseBindingPath(message.caseId);
  let binding = await store.getJson(bindingPath);
  if (binding && !matchesCasePair(binding, message)) throw caseParticipantMismatch();
  let current = binding ? await store.getJson(sharedCasePath(message.caseId)) : null;
  if (binding && !current) throw Object.assign(new Error('Bound case has no canonical record'), { statusCode: 409 });
  if (!binding) {
    const [senderCase, recipientCase, senderInbox] = await Promise.all([
      store.getJson(caseRecordPath(message.senderInboxId, message.caseId)),
      store.getJson(caseRecordPath(message.recipientInboxId, message.caseId)),
      store.getJson(path.join('inboxes', message.senderInboxId, 'inbox.json'))
    ]);
    const legacy = senderCase || recipientCase;
    if (legacy && (JSON.stringify(pairIds(legacy.participants || [])) !== JSON.stringify(pairIds([message.senderAgentId, message.recipientAgentId]))
      || senderCase && recipientCase && JSON.stringify(senderCase) !== JSON.stringify(recipientCase))) throw caseParticipantMismatch();
    current = legacy || createAgentCase({
      id: message.caseId,
      objective: message.text?.slice(0, 160) || 'Agent communication',
      collaborationMode: ['proposal', 'counterproposal', 'decision'].includes(message.type) ? 'negotiation' : 'collaboration',
      principal: senderInbox.ownerHumanId,
      actingAgent: message.senderAgentId,
      participants: [message.senderAgentId, message.recipientAgentId],
      createdAt: message.createdAt
    });
    binding = { caseId: message.caseId, agentIds: pairIds([message.senderAgentId, message.recipientAgentId]), inboxIds: pairIds([message.senderInboxId, message.recipientInboxId]), createdAt: at };
  }
  const updated = advanceNativeCase(current, message, state, at, { scopedAccept, scopedReject, scopedCompletion });
  const documents = [document(bindingPath, binding), document(sharedCasePath(message.caseId), updated), document(caseRecordPath(message.senderInboxId, message.caseId), updated)];
  if (revealRecipient || await store.getJson(caseRecordPath(message.recipientInboxId, message.caseId))) {
    documents.push(document(caseRecordPath(message.recipientInboxId, message.caseId), updated));
  }
  const visibleDocuments = [];
  for (const entry of documents) {
    const target = entry.path.match(/^inboxes[\\/]([^\\/]+)[\\/]/);
    if (target && (await store.getJson(path.join('inboxes', target[1], 'inbox.json')))?.historyDeleted) continue;
    visibleDocuments.push(entry);
  }
  return { case: updated, documents: visibleDocuments };
}

const permanentDeliveryError = (message, reasonCode) => Object.assign(new Error(message), { permanent: true, ...(reasonCode ? { reasonCode } : {}) });

async function enqueueNativeMessage(message, senderInbox, recipientInboxId, eventType = 'message.queued', writeAudit = null, agentRequest = null, caseOptions = {}) {
  if (!writeAudit) {
    const queued = await withInboxMutation(senderInbox.id, auditWriter => enqueueNativeMessage(message, senderInbox, recipientInboxId, eventType, auditWriter, agentRequest), [recipientInboxId], [caseMutationKey(message.caseId)]);
    deliveryWorker.kick();
    return queued;
  }
  const [senderAgent, recipientAgent] = await Promise.all([
    store.getJson(path.join('inboxes', senderInbox.id, 'agents', `${message.senderAgentId}.json`)),
    store.getJson(path.join('inboxes', recipientInboxId, 'agents', `${message.recipientAgentId}.json`))
  ]);
  if (!senderAgent || !canAct(senderAgent, 'send_agent_messages')) throw Object.assign(new Error('Sender agent is no longer approved to send messages'), { statusCode: 403 });
  if (!recipientAgent || !canReceive(recipientAgent)) throw Object.assign(new Error('Recipient agent is unavailable'), { statusCode: 404 });
  let senderCredentialFamilyId;
  if (agentRequest) {
    const currentPrincipal = await getAgentPrincipal(agentRequest, senderInbox.id);
    if (!currentPrincipal || currentPrincipal.id !== senderAgent.id) throw Object.assign(new Error('Valid sender agent credential required'), { statusCode: 401 });
    senderCredentialFamilyId = (await store.getJson(agentCredentialPath(hashSecret(bearerToken(agentRequest)))))?.familyId;
  } else {
    const families = await store.listJson(path.join('auth', 'agent-credential-families', senderInbox.id, senderAgent.id));
    senderCredentialFamilyId = families.find(family => !family.revokedAt && new Date(family.refreshExpiresAt) > new Date())?.id;
  }
  if (!senderCredentialFamilyId) throw Object.assign(new Error('An active sender agent credential is required'), { statusCode: 401 });
  const existing = await store.getJson(messagePath(senderInbox.id, message.id));
  if (existing) {
    if (existing.requestHash && existing.requestHash !== message.requestHash) throw nativeIdempotencyConflict();
    if (existing.status !== 'pendingContactApproval') return existing;
  }
  const queuedAt = store.now();
  const queued = { ...message, recipientInboxId, status: 'queued', queuedAt, updatedAt: queuedAt };
  const shared = await nativeCaseDocuments(queued, 'queued', queuedAt, caseOptions);
  const auditData = {
    messageId: queued.id,
    caseId: queued.caseId,
    conversationId: queued.conversationId,
    senderAgentId: queued.senderAgentId,
    recipientAgentId: queued.recipientAgentId,
    recipientEmail: queued.recipientEmail,
    senderInboxId: senderInbox.id,
    recipientInboxId
  };
  const outbox = {
    id: `delivery_${queued.id}`,
    kind: 'nativeAgentMessage',
    messageId: queued.id,
    senderInboxId: senderInbox.id,
    recipientInboxId,
    senderCredentialFamilyId,
    orderingKey: queued.caseId,
    requestHash: queued.requestHash,
    status: 'queued',
    attempts: 0,
    maxAttempts: deliveryMaxAttempts,
    availableAt: queuedAt,
    createdAt: queued.createdAt,
    updatedAt: queuedAt
  };
  const delivery = await store.enqueueOutbox([
    document(messagePath(senderInbox.id, queued.id), queued),
    ...shared.documents
  ], outbox);
  if (delivery.requestHash && delivery.requestHash !== queued.requestHash) throw nativeIdempotencyConflict();
  await writeAudit(eventType, auditData, queuedAt);
  return delivery.enqueueCreated ? queued : await store.getJson(messagePath(senderInbox.id, queued.id), queued);
}

async function deliverNativeAgentMessage(outbox) {
  const queued = await store.getJson(messagePath(outbox.senderInboxId, outbox.messageId));
  if (!queued) throw permanentDeliveryError('Queued message no longer exists');
  const sender = await store.getJson(path.join('inboxes', outbox.senderInboxId, 'agents', `${queued.senderAgentId}.json`));
  if (!sender || !canAct(sender, 'send_agent_messages')) throw permanentDeliveryError('Sender agent is no longer approved to send messages');
  const senderFamilies = outbox.senderCredentialFamilyId
    ? [await store.getJson(agentCredentialFamilyPath(outbox.senderInboxId, queued.senderAgentId, outbox.senderCredentialFamilyId))]
    : await store.listJson(path.join('auth', 'agent-credential-families', outbox.senderInboxId, queued.senderAgentId));
  if (!senderFamilies.some(family => family && !family.revokedAt && new Date(family.refreshExpiresAt) > new Date())) throw permanentDeliveryError('Sender agent credential is revoked or expired');
  const directory = await store.getJson(path.join('directory', 'agents', `${queued.recipientAgentId}.json`));
  if (!directory) throw permanentDeliveryError('Recipient agent is unavailable', 'RECIPIENT_DIRECTORY_MISSING');
  if (!['active', 'paused'].includes(directory.status)) throw permanentDeliveryError('Recipient agent is unavailable', 'RECIPIENT_DIRECTORY_STATUS');
  if (directory.inboxId !== outbox.recipientInboxId) throw permanentDeliveryError('Recipient agent is unavailable', 'RECIPIENT_DIRECTORY_INBOX_MISMATCH');
  const recipient = await store.getJson(path.join('inboxes', directory.inboxId, 'agents', `${queued.recipientAgentId}.json`));
  if (!recipient || !canReceive(recipient)) throw permanentDeliveryError('Recipient is not approved to receive messages');
  const contact = await store.getJson(path.join('inboxes', directory.inboxId, 'contacts', `${queued.senderAgentId}.json`));
  const senderContact = await store.getJson(path.join('inboxes', outbox.senderInboxId, 'contacts', `${queued.recipientAgentId}.json`));
  if (contact?.blocked || senderContact?.blocked) throw permanentDeliveryError('The agent relationship is blocked for delivery');
  try { await assertCaseProgressAllowed(outbox.senderInboxId, queued.caseId); }
  catch (error) { throw permanentDeliveryError(error.message); }

  const deliveredAt = store.now();
  const delivered = { ...queued, status: 'delivered', deliveredAt };
  const receipt = {
    id: `delivery_receipt_${queued.id}_delivered`,
    type: 'delivery',
    messageId: queued.id,
    senderAgentId: queued.senderAgentId,
    recipientAgentId: queued.recipientAgentId,
    state: 'delivered',
    attempt: Number(outbox.attempts || 0) + 1,
    createdAt: deliveredAt
  };
  const documents = [];
  const events = [];
  documents.push(...(await nativeCaseDocuments(delivered, 'delivered', deliveredAt, { revealRecipient: true })).documents);
  for (const targetInboxId of new Set([outbox.senderInboxId, outbox.recipientInboxId])) {
    const targetInbox = await store.getJson(path.join('inboxes', targetInboxId, 'inbox.json'));
    if (!targetInbox) throw permanentDeliveryError('Delivery target workspace no longer exists');
    const auditEntry = await auditRecord(targetInboxId, 'message.delivered', {
      messageId: delivered.id,
      caseId: delivered.caseId,
      senderAgentId: delivered.senderAgentId,
      recipientAgentId: delivered.recipientAgentId,
      senderInboxId: outbox.senderInboxId,
      recipientInboxId: outbox.recipientInboxId,
      deliveryId: outbox.id
    }, deliveredAt);
    documents.push(
      document(messagePath(targetInboxId, delivered.id), delivered),
      document(deliveryReceiptPath(targetInboxId, receipt.id), receipt),
      auditEntry.document
    );
    events.push({ inboxId: targetInboxId, event: auditEntry.event });
  }
  // http-wake v1 §6.5: the wake is written in the delivery's own transaction (the worker runs this
  // and completeOutbox in one withTransaction), so it commits with the delivery or not at all.
  if (httpWakeEnabled) await httpWake.trigger({ inboxId: outbox.recipientInboxId, agentId: queued.recipientAgentId, reason: 'message_delivered', cursor: events.find(entry => entry.inboxId === outbox.recipientInboxId)?.event.cursor || null });
  return { documents, result: { messageId: delivered.id, receiptId: receipt.id, deliveredAt }, events };
}

async function deliverExternalEmail(outbox) {
  emailTransport.assertReady();
  const queued = await store.getJson(messagePath(outbox.senderInboxId, outbox.messageId));
  if (!queued) throw permanentDeliveryError('Queued external email no longer exists');
  const sender = await store.getJson(path.join('inboxes', outbox.senderInboxId, 'agents', `${queued.senderAgentId}.json`));
  if (!sender || !canAct(sender, 'use_email_transport')) throw permanentDeliveryError('Sender is not approved to use external email');
  const contact = await store.getJson(externalContactPath(outbox.senderInboxId, queued.recipientEmail));
  if (!contact?.approved || contact.blocked || !['outbound', 'both'].includes(contact.direction || 'both')) throw permanentDeliveryError('External recipient is not an approved outbound contact');
  const externalAddress = publicEmailAddressForAgent(sender);
  if (!externalAddress) throw permanentDeliveryError('Sender has no configured public email address');
  const provider = await emailTransport.send({
    from: `${String(sender.name || sender.slug).replace(/[<>\r\n]/g, '')} <${externalAddress}>`,
    to: queued.recipientEmail,
    subject: queued.subject,
    text: queued.text,
    html: queued.html || undefined,
    replyTo: queued.replyAddress,
    idempotencyKey: `external-email/${queued.id}`
  });
  const acceptedAt = store.now();
  const accepted = { ...queued, status: 'accepted', externalDeliveryState: 'accepted', provider: provider.provider, providerMessageId: provider.providerMessageId, acceptedAt, updatedAt: acceptedAt };
  const receipt = { id: `delivery_receipt_${queued.id}_accepted`, type: 'email', transport: 'email', messageId: queued.id, senderAgentId: queued.senderAgentId, recipientEmail: queued.recipientEmail, state: 'accepted', provider: provider.provider, providerMessageId: provider.providerMessageId, attempt: Number(outbox.attempts || 0) + 1, createdAt: acceptedAt };
  const inbox = await store.getJson(path.join('inboxes', outbox.senderInboxId, 'inbox.json'));
  const currentCase = await ensureStructuredCase(inbox, { ...accepted, caseId: accepted.caseId }, accepted.senderAgentId, accepted.createdAt);
  const updatedCase = setCaseMessageDeliveryState(structuredClone(currentCase), accepted, 'accepted', acceptedAt);
  const auditEntry = await auditRecord(outbox.senderInboxId, 'email.accepted', { messageId: accepted.id, caseId: accepted.caseId, senderAgentId: accepted.senderAgentId, recipientEmail: accepted.recipientEmail, provider: provider.provider, providerMessageId: provider.providerMessageId, deliveryId: outbox.id }, acceptedAt);
  return {
    documents: [
      document(messagePath(outbox.senderInboxId, accepted.id), accepted),
      document(caseRecordPath(outbox.senderInboxId, updatedCase.id), updatedCase),
      document(deliveryReceiptPath(outbox.senderInboxId, receipt.id), receipt),
      document(path.join('email-provider-index', provider.provider, `${identityKey(provider.providerMessageId)}.json`), { inboxId: outbox.senderInboxId, messageId: accepted.id, providerMessageId: provider.providerMessageId }),
      auditEntry.document
    ],
    result: { messageId: accepted.id, receiptId: receipt.id, acceptedAt, ...provider },
    events: [{ inboxId: outbox.senderInboxId, event: auditEntry.event }]
  };
}

const emailEventState = type => ({
  'email.sent': 'accepted',
  'email.delivered': 'delivered',
  'email.delivery_delayed': 'retrying',
  'email.bounced': 'deadLettered',
  'email.complained': 'deadLettered',
  'email.failed': 'deadLettered',
  'email.suppressed': 'deadLettered'
}[type] || null);

async function prepareEmailDelivery(outbox) {
  if (outbox.kind === 'nativeAgentMessage') {
    const message = await store.getJson(messagePath(outbox.senderInboxId, outbox.messageId));
    return { lockKeys: message?.caseId ? [caseMutationKey(message.caseId)] : [] };
  }
  if (outbox.kind !== 'emailWebhook') return {};
  const event = outbox.emailEvent;
  if (!event?.type) throw permanentDeliveryError('Email webhook event is invalid');
  if (event.type !== 'email.received') {
    if (!event.data?.email_id || !emailEventState(event.type)) return {};
    const index = await store.getJson(path.join('email-provider-index', 'resend', `${identityKey(event.data.email_id)}.json`));
    if (!index?.inboxId) throw new Error('Provider message index is not available yet');
    return { lockKeys: [`inbox:${index.inboxId}:mutations`], context: { index } };
  }
  // Provider payload is immutable; retrieve it before opening a database
  // transaction, then revalidate every mutable routing/permission record inside.
  const inbound = await emailTransport.retrieveInbound(event.data?.email_id);
  const recipients = [...new Set([...(inbound.received_for || []), ...(inbound.to || [])].map(normalizedEmail).filter(Boolean))];
  for (const recipient of recipients) {
    const route = await store.getJson(replyAddressDirectoryPath(recipient));
    if (route?.inboxId && route?.agentId) return { lockKeys: [`inbox:${route.inboxId}:mutations`], context: { inbound, recipients, route, routeAddress: recipient } };
  }
  throw permanentDeliveryError('Inbound email is not addressed to a verified reply alias');
}

async function processInboundEmail(event, prepared) {
  if (!prepared?.route) throw new Error('Inbound email routing was not prepared');
  const { inbound, recipients } = prepared;
  const route = await store.getJson(replyAddressDirectoryPath(prepared.routeAddress));
  if (!route?.inboxId || !route?.agentId) throw permanentDeliveryError('Inbound email is not addressed to a verified reply alias');
  if (route.inboxId !== prepared.route.inboxId || route.agentId !== prepared.route.agentId || route.caseId !== prepared.route.caseId) throw new Error('Inbound email route changed; retry routing');
  const recipient = await store.getJson(path.join('inboxes', route.inboxId, 'agents', `${route.agentId}.json`));
  if (!recipient || !canReceive(recipient)) throw permanentDeliveryError('Inbound recipient is unavailable');
  const senderEmailMatch = String(inbound.from || '').match(/<([^<>]+)>\s*$/);
  const senderEmail = normalizedEmail(senderEmailMatch?.[1] || inbound.from);
  if (!validEmail(senderEmail)) throw permanentDeliveryError('Inbound sender address is invalid');
  const contact = await store.getJson(externalContactPath(route.inboxId, senderEmail));
  if (!contact?.approved || contact.blocked || !['inbound', 'both'].includes(contact.direction || 'both')) throw permanentDeliveryError('Inbound sender is not an approved contact');
  if (Array.isArray(inbound.attachments) && inbound.attachments.length) throw permanentDeliveryError('Inbound attachments remain quarantined until object scanning is configured');
  const inbox = await store.getJson(path.join('inboxes', route.inboxId, 'inbox.json'));
  if (!inbox) throw permanentDeliveryError('Inbound recipient workspace no longer exists');
  const messageId = `msg_email_${hashSecret(String(inbound.id || event.data?.email_id)).slice(0, 32)}`;
  const existing = await store.getJson(messagePath(route.inboxId, messageId));
  if (existing) return { documents: [], result: { messageId, replay: true }, events: [] };
  const createdAt = inbound.created_at || event.created_at || store.now();
  const externalParticipantId = `external_email_${hashSecret(senderEmail).slice(0, 24)}`;
  const message = {
    id: messageId,
    caseId: route.caseId || store.id('case'),
    inboxId: route.inboxId,
    transport: 'email',
    direction: 'inbound',
    senderType: 'externalHuman',
    senderEmail,
    senderDisplayName: String(inbound.from || senderEmail).replace(/\s*<[^<>]+>\s*$/, '').trim() || senderEmail,
    recipientAgentId: route.agentId,
    recipientEmail: recipients.find(address => address === route.address) || recipients[0],
    subject: String(inbound.subject || '(no subject)').slice(0, 200),
    type: 'email',
    text: String(inbound.text || '[HTML-only email retained by the configured provider]').slice(0, 500_000),
    payload: { provider: 'resend', providerMessageId: inbound.id, internetMessageId: inbound.message_id || null, attachmentCount: 0 },
    createdAt,
    receivedAt: store.now(),
    status: 'received',
    externalDeliveryState: 'received'
  };
  const currentCase = await ensureStructuredCase(inbox, { ...message, objective: message.subject }, recipient.id, createdAt);
  if (!currentCase.participants.includes(externalParticipantId)) currentCase.participants.push(externalParticipantId);
  appendEvent(currentCase, { id: `evt_${message.id}`, type: 'message', actor: externalParticipantId, createdAt, payload: { messageId: message.id, messageType: 'email', text: message.text, subject: message.subject, senderEmail, recipientAgentId: recipient.id, deliveryState: 'received' }, linkedPolicyEvaluation: null, precedingEventRef: currentCase.events.at(-1)?.id || null });
  const receipt = { id: `delivery_receipt_${message.id}_received`, type: 'email', transport: 'email', messageId: message.id, senderEmail, recipientAgentId: recipient.id, state: 'received', provider: 'resend', providerMessageId: inbound.id, createdAt: message.receivedAt };
  const auditEntry = await auditRecord(route.inboxId, 'email.received', { messageId: message.id, caseId: message.caseId, senderEmail, recipientAgentId: recipient.id, providerMessageId: inbound.id }, message.receivedAt);
  return { documents: [document(messagePath(route.inboxId, message.id), message), document(caseRecordPath(route.inboxId, currentCase.id), currentCase), document(deliveryReceiptPath(route.inboxId, receipt.id), receipt), auditEntry.document], result: { inboxId: route.inboxId, messageId: message.id, receiptId: receipt.id }, events: [{ inboxId: route.inboxId, event: auditEntry.event }] };
}

async function processOutboundEmailEvent(event, prepared) {
  const providerMessageId = event.data?.email_id;
  const state = emailEventState(event.type);
  if (!providerMessageId || !state) return { documents: [], result: { ignored: true }, events: [] };
  const index = await store.getJson(path.join('email-provider-index', 'resend', `${identityKey(providerMessageId)}.json`));
  if (!index) throw new Error('Provider message index is not available yet');
  if (index.inboxId !== prepared?.index?.inboxId || index.messageId !== prepared?.index?.messageId) throw new Error('Provider message route changed; retry routing');
  const message = await store.getJson(messagePath(index.inboxId, index.messageId));
  if (!message) return { documents: [], result: { ignored: true, reason: 'unknown_message' }, events: [] };
  const at = event.created_at || store.now();
  const updated = { ...message, status: state, externalDeliveryState: event.type.slice('email.'.length), updatedAt: at, ...(state === 'delivered' ? { deliveredAt: at } : {}) };
  const inbox = await store.getJson(path.join('inboxes', index.inboxId, 'inbox.json'));
  const currentCase = await ensureStructuredCase(inbox, { ...updated, caseId: updated.caseId }, updated.senderAgentId, updated.createdAt);
  const updatedCase = setCaseMessageDeliveryState(structuredClone(currentCase), updated, state, at);
  const receipt = { id: `delivery_receipt_${updated.id}_${event.type.replaceAll('.', '_')}`, type: 'email', transport: 'email', messageId: updated.id, senderAgentId: updated.senderAgentId, recipientEmail: updated.recipientEmail, state: updated.externalDeliveryState, provider: 'resend', providerMessageId, createdAt: at };
  const auditEntry = await auditRecord(index.inboxId, event.type, { messageId: updated.id, caseId: updated.caseId, senderAgentId: updated.senderAgentId, recipientEmail: updated.recipientEmail, providerMessageId }, at);
  const documents = [document(messagePath(index.inboxId, updated.id), updated), document(caseRecordPath(index.inboxId, updatedCase.id), updatedCase), document(deliveryReceiptPath(index.inboxId, receipt.id), receipt), auditEntry.document];
  if (['email.complained', 'email.suppressed'].includes(event.type)) {
    const contact = await store.getJson(externalContactPath(index.inboxId, updated.recipientEmail));
    if (contact) documents.push(document(externalContactPath(index.inboxId, updated.recipientEmail), { ...contact, blocked: true, blockedReason: event.type, updatedAt: at }));
  }
  return { documents, result: { inboxId: index.inboxId, messageId: updated.id, state: updated.externalDeliveryState }, events: [{ inboxId: index.inboxId, event: auditEntry.event }] };
}

async function processEmailWebhook(outbox, prepared) {
  const event = outbox.emailEvent;
  if (!event?.type) throw permanentDeliveryError('Email webhook event is invalid');
  return event.type === 'email.received' ? processInboundEmail(event, prepared) : processOutboundEmailEvent(event, prepared);
}

// a4-wake §1: a cursor is the event sequence as exactly 20 digits; anything else, or one beyond
// the inbox's newest event (another inbox, a restored database), is refused rather than
// silently skipping events.
const eventCursorPattern = /^[0-9]{20}$/;
const eventHistoryUnavailable = () => codedError(503, 'EVENT_HISTORY_UNAVAILABLE', 'Event history is temporarily unavailable. Retry shortly.');
async function newestEventCursor(inboxId) {
  const [newest] = await store.queryJson(path.join('inboxes', inboxId, 'events'), { sortField: 'cursor', order: 'desc', limit: 1 });
  if (newest && !eventCursorPattern.test(String(newest.cursor || ''))) throw eventHistoryUnavailable();
  return newest?.cursor || null;
}
async function resumeEventCursor(inboxId, raw) {
  const newest = await newestEventCursor(inboxId);
  if (!raw) return { cursor: '', newest };
  if (!eventCursorPattern.test(raw) || !newest || raw > newest) throw codedError(400, 'EVENT_CURSOR_INVALID', 'The event cursor is invalid. Reconnect with from=latest.');
  return { cursor: raw, newest };
}
async function eventPage(inboxId, options) {
  try { return await fetchEventPage(store, inboxId, options); }
  catch (error) { if (error.statusCode === 503) throw eventHistoryUnavailable(); throw error; }
}
// A credential that is a real agent token but not valid for this route gets a stable code.
async function rejectAgentToken(req) {
  const raw = bearerToken(req);
  const index = raw ? await store.getJson(agentCredentialPath(hashSecret(raw))) : null;
  if (index?.tokenType) throw credentialError('AUTHENTICATION_REQUIRED');
}

// Inbound work this agent could claim now or once it may act: delivered, unsettled messages.
async function hasClaimableInbound(inboxId, agentId, { caseId = null, senderAgentId = null } = {}) {
  const [messages, claims] = await Promise.all([
    store.listJson(path.join('inboxes', inboxId, 'messages')),
    store.listJson(path.join('inboxes', inboxId, 'work-claims'))
  ]);
  const settled = new Set(claims.filter(claim => ['completed', 'failed'].includes(claim.status)).map(claim => claim.workId));
  return messages.some(message => message.recipientInboxId === inboxId && message.recipientAgentId === agentId
    && ['delivered', 'acknowledged'].includes(message.status) && !settled.has(message.id)
    && (!caseId || message.caseId === caseId) && (!senderAgentId || message.senderAgentId === senderAgentId));
}

async function holdIfSenderPaused(outbox) {
  if (!['nativeAgentMessage', 'externalEmail'].includes(outbox.kind) || !outbox.messageId) return;
  const queued = await store.getJson(messagePath(outbox.senderInboxId, outbox.messageId));
  if (!queued?.senderAgentId) return;
  const sender = await store.getJson(path.join('inboxes', outbox.senderInboxId, 'agents', `${queued.senderAgentId}.json`));
  if (sender?.status === 'paused') throw Object.assign(new Error('Sender agent is paused'), { hold: 'sender_paused' });
}

async function heldMessageDocuments(record, reason, heldAt) {
  if (!record.messageId) return [];
  const message = await store.getJson(messagePath(record.senderInboxId, record.messageId));
  return message ? [document(messagePath(record.senderInboxId, message.id), { ...message, status: 'held', heldReason: reason, heldAt, updatedAt: heldAt })] : [];
}

async function releasedMessageDocuments(record, at) {
  if (!record.messageId) return [];
  const message = await store.getJson(messagePath(record.senderInboxId, record.messageId));
  if (!message || message.status !== 'held') return [];
  const { heldReason: _reason, heldAt: _heldAt, ...rest } = message;
  return [document(messagePath(record.senderInboxId, message.id), { ...rest, status: record.status === 'retrying' ? 'retrying' : 'queued', updatedAt: at })];
}

async function cancelHeldSends(inboxId, humanId, at, writeAudit) {
  for (;;) {
    const held = await store.queryOutbox({ senderInboxId: inboxId, status: 'held', limit: 200 });
    let cancelled = 0;
    for (const record of held) {
      const message = record.messageId ? await store.getJson(messagePath(inboxId, record.messageId)) : null;
      const documents = [];
      if (message) {
        const { heldReason: _reason, heldAt: _heldAt, ...rest } = message;
        documents.push(document(messagePath(inboxId, message.id), { ...rest, status: 'cancelled', cancelledAt: at, cancelledReason: 'agent_access_ended', updatedAt: at }));
      }
      if (!await store.cancelHeldOutbox(record.id, documents)) continue;
      cancelled += 1;
      await writeAudit('message.cancelled', { messageId: record.messageId, caseId: record.orderingKey, humanId }, at);
    }
    if (!cancelled) return;
  }
}

async function releaseHeldSends(inboxId, at = store.now()) {
  const released = await store.releaseHeldOutbox({ senderInboxId: inboxId });
  await store.putJsonBatch((await Promise.all(released.map(record => releasedMessageDocuments(record, at)))).flat());
  return released.length;
}

async function deliverQueuedMessage(outbox, prepared) {
  await holdIfSenderPaused(outbox);
  if (outbox.kind === 'nativeAgentMessage') return deliverNativeAgentMessage(outbox);
  if (outbox.kind === 'externalEmail') return deliverExternalEmail(outbox);
  if (outbox.kind === 'emailWebhook') return processEmailWebhook(outbox, prepared);
  throw permanentDeliveryError(`Unsupported outbox kind: ${outbox.kind}`);
}

async function recordDeliveryFailure(outbox, error, { attempt, deadLettered }) {
  if (outbox.kind === 'emailWebhook') {
    if (!deadLettered) return { documents: [], events: [] };
    const at = store.now();
    const quarantine = {
      id: outbox.id,
      provider: outbox.provider,
      webhookId: outbox.webhookId,
      eventType: outbox.emailEvent?.type || null,
      providerMessageId: outbox.emailEvent?.data?.email_id || null,
      state: 'quarantined',
      reason: String(error?.message || error).slice(0, 1000),
      quarantinedAt: at
    };
    return { documents: [document(path.join('email-quarantine', `${outbox.id}.json`), quarantine)], events: [] };
  }
  const queued = await store.getJson(messagePath(outbox.senderInboxId, outbox.messageId));
  if (!queued) return { documents: [], events: [] };
  const at = store.now();
  const state = deadLettered ? 'deadLettered' : 'retrying';
  const failed = { ...queued, status: state, lastDeliveryError: String(error?.message || error).slice(0, 1000), deliveryAttempts: attempt, updatedAt: at };
  const documents = [document(messagePath(outbox.senderInboxId, failed.id), failed)];
  const events = [];
  const senderInbox = await store.getJson(path.join('inboxes', outbox.senderInboxId, 'inbox.json'));
  if (senderInbox) {
    if (outbox.kind === 'nativeAgentMessage') documents.push(...(await nativeCaseDocuments(failed, state, at)).documents);
    else {
      const currentCase = await ensureStructuredCase(senderInbox, { ...failed, caseId: failed.caseId }, failed.senderAgentId, failed.createdAt);
      const updatedCase = setCaseMessageDeliveryState(structuredClone(currentCase), failed, state, at);
      documents.push(document(caseRecordPath(outbox.senderInboxId, updatedCase.id), updatedCase));
    }
  }
  const auditEntry = await auditRecord(outbox.senderInboxId, deadLettered ? 'message.dead_lettered' : 'message.retry_scheduled', {
    messageId: failed.id,
    deliveryId: outbox.id,
    attempt,
    error: failed.lastDeliveryError
  }, at);
  documents.push(auditEntry.document);
  events.push({ inboxId: outbox.senderInboxId, event: auditEntry.event });
  if (deadLettered) {
    const receipt = {
      id: `delivery_receipt_${failed.id}_failed`,
      type: 'delivery',
      messageId: failed.id,
      senderAgentId: failed.senderAgentId,
      recipientAgentId: failed.recipientAgentId,
      state,
      attempt,
      error: failed.lastDeliveryError,
      createdAt: at
    };
    documents.push(document(deliveryReceiptPath(outbox.senderInboxId, receipt.id), receipt));
  }
  return { documents, events };
}

const deliveryWorker = new DeliveryWorker({
  store,
  workerId: consumerIdentity.workerId,
  observe: logConsumer,
  deploymentEnvironment: deploymentIdentity.environment,
  prepare: prepareEmailDelivery,
  deliver: deliverQueuedMessage,
  onFailure: recordDeliveryFailure,
  onHold: async (record, reason) => ({ documents: await heldMessageDocuments(record, reason, store.now()), events: [] }),
  onHeld: async record => {
    const released = await withInboxMutation(record.senderInboxId, async () => {
      const queued = record.messageId ? await store.getJson(messagePath(record.senderInboxId, record.messageId)) : null;
      const sender = queued?.senderAgentId ? await store.getJson(path.join('inboxes', record.senderInboxId, 'agents', `${queued.senderAgentId}.json`)) : null;
      return sender?.status === 'paused' ? 0 : releaseHeldSends(record.senderInboxId);
    }, [], [], true);
    if (released) deliveryWorker.kick();
  },
  onSettled: async (_record, events) => {
    for (const { inboxId, event } of events) publish(inboxId, event);
  }
});

async function participantDirectoryForHuman(inbox, agents, cases) {
  const localAgents = new Map(agents.map(agent => [agent.id, agent]));
  const externalHumans = new Map();
  const ids = new Set();
  for (const value of cases) {
    [value.actingAgent, value.principal, ...(value.participants || [])].filter(Boolean).forEach(id => ids.add(id));
    for (const event of value.events || []) {
      [event.actor, event.payload?.senderAgentId, event.payload?.recipientAgentId, event.payload?.senderHumanId]
        .filter(Boolean)
        .forEach(id => ids.add(id));
      if (String(event.actor || '').startsWith('external_email_') && event.payload?.senderEmail) externalHumans.set(event.actor, event.payload.senderEmail);
    }
  }
  const entries = await Promise.all([...ids].slice(0, 500).map(async id => {
    const local = localAgents.get(id);
    if (local) return [id, { id, type: 'internalAgent', displayName: local.name, address: local.address, organizationId: local.organizationId || inbox.organizationId, inboxId: inbox.id, accessState: local.status === 'active' ? 'active' : 'unavailable' }];
    if (externalHumans.has(id)) {
      const email = externalHumans.get(id);
      const contact = await store.getJson(externalContactPath(inbox.id, email));
      return [id, { id, type: 'human', displayName: contact?.displayName || email, address: email, organizationId: null, inboxId: inbox.id, accessState: contact?.blocked ? 'revoked' : 'active' }];
    }
    if (id === inbox.ownerHumanId || String(id).startsWith('human_')) return [id, { id, type: 'human', displayName: id === inbox.ownerHumanId ? 'Human principal' : 'Human participant', address: null, organizationId: inbox.organizationId, inboxId: inbox.id, accessState: 'active' }];
    const directory = await store.getJson(path.join('directory', 'agents', `${id}.json`));
    if (!directory) return [id, { id, type: 'externalAgent', displayName: String(id), address: null, organizationId: null, inboxId: null, accessState: 'unavailable' }];
    const external = await store.getJson(path.join('inboxes', directory.inboxId, 'agents', `${id}.json`));
    return [id, { id, type: directory.inboxId === inbox.id ? 'internalAgent' : 'externalAgent', displayName: external?.name || directory.address || String(id), address: external?.address || directory.address || null, organizationId: external?.organizationId || null, inboxId: directory.inboxId, accessState: directory.status === 'active' ? 'active' : 'unavailable' }];
  }));
  return Object.fromEntries(entries);
}

async function humanView(inboxId, inbox, cursors = {}) {
  const [agents, calendarConnectors, page] = await Promise.all([
    store.listJson(path.join('inboxes', inboxId, 'agents')),
    store.listJson(path.join('inboxes', inboxId, 'calendar-connectors')),
    workspaceHistory(store, inboxId, cursors)
  ]);
  const { items: { cases, messages, assets, recentEvents: events, deliveryReceipts, invitations, contacts: externalContacts }, history } = page;
  const grants = await store.listJson(path.join('inboxes', inboxId, 'asset-grants'));
  const sharedAssets = [];
  for (const grant of grants) {
    const asset = await store.getJson(objectMetadataPath(grant.assetId));
    if (!asset || asset.state !== 'clean' || assets.some(item => item.id === asset.id)) continue;
    const access = await assetReadAccess(asset, inbox, { agent: null, manager: true });
    if (access.allowed && !access.owner) sharedAssets.push({ ...asset, grant: access.grant });
  }
  const visibleAssets = [...assets, ...sharedAssets];
  const visibleHistory = { ...history, assets: { ...history.assets, total: history.assets.total + sharedAssets.length } };
  const projection = projectWorkspaceForHuman(cases);
  const participantDirectory = await participantDirectoryForHuman(inbox, agents, cases);
  const projectedInvitations = invitations
    .map(invitation => ({
      ...invitation,
      direction: invitation.recipientInboxId === inboxId ? 'incoming' : 'outgoing',
      actionable: invitation.recipientInboxId === inboxId && invitation.state === 'pending'
    }))
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  const pendingInvitations = projectedInvitations.filter(invitation => invitation.actionable).length;
  return {
    inbox,
    mode: 'human-observer',
    capabilities: ['observe_agent_communications', 'approve_or_pause_agent_actions', 'review_assets', 'manage_calendar_connectors'],
    history: visibleHistory,
    countScope: { navigation: 'loaded-history', summaryTotals: 'workspace' },
    summary: { agents: agents.length, cases: history.cases.total, messages: history.messages.total, assets: visibleHistory.assets.total, needsMe: projection.counts.needsMe + pendingInvitations },
    navigation: { ...projection.counts, needsMe: projection.counts.needsMe + pendingInvitations },
    caseQueue: projection.cases,
    participantDirectory,
    agents: await Promise.all(agents.map(agent => ownerAgentState(inboxId, agent))),
    cases,
    messages,
    assets: visibleAssets,
    calendarProviders: calendarProviderStatus(),
    calendarConnectors: calendarConnectors.map(publicCalendarConnector),
    invitations: projectedInvitations,
    contacts: externalContacts.sort((left, right) => String(left.email).localeCompare(String(right.email))),
    publicEmailTransport: publicEmailTransportProjection(agents, externalContacts),
    deliveryReceipts: deliveryReceipts.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    recentEvents: events.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100)
  };
}

async function agentView(inboxId, inbox, agentId) {
  const agent = await store.getJson(path.join('inboxes', inboxId, 'agents', `${agentId}.json`));
  if (!agent) return null;
  const [cases, messages, assets, deliveryReceipts, calendarConnectors] = await Promise.all([
    listCases(inboxId),
    listMessages(inboxId),
    store.listJson(path.join('inboxes', inboxId, 'assets')),
    store.listJson(path.join('inboxes', inboxId, 'delivery-receipts')),
    store.listJson(path.join('inboxes', inboxId, 'calendar-connectors'))
  ]);
  return {
    inbox,
    mode: 'agent-operator',
    agent: publicAgent(agent),
    capabilities: [...new Set((Array.isArray(agent.permissions) ? agent.permissions : [])
      .filter(permission => allowedPermissions.has(permission) && canAct(agent, permission)))],
    queue: {
      assignedMessages: messages.filter((item) => item.recipientAgentId === agentId),
      authoredMessages: messages.filter((item) => item.senderAgentId === agentId),
      activeCases: cases.filter(item => item.schemaVersion
        ? isActiveCase(item) && isCaseParticipant(item, agentId)
        : item.status === 'active' && item.participantAgentIds?.includes(agentId)),
      createdAssets: assets.filter((item) => item.createdByAgentId === agentId),
      calendarConnectors: calendarConnectors.map(publicCalendarConnector),
      deliveryReceipts: deliveryReceipts.filter(item => item.senderAgentId === agentId || item.recipientAgentId === agentId)
    }
  };
}

const inboxPreferencesHttp = createInboxPreferencesHttp({
  store,
  requireHuman: req => auth.getHuman(req),
  requireInboxAccess: async (req, { human, inboxId }) => {
    const inbox = await store.getJson(path.join('inboxes', inboxId, 'inbox.json'));
    if (!inbox) throw Object.assign(new Error('Inbox not found'), { statusCode: 404 });
    if (!await canAccessInbox(human, inbox)) throw Object.assign(new Error('Workspace membership required'), { statusCode: 403 });
    return inbox;
  },
  requireCaseAccess: async (req, { inbox, caseId }) => {
    const workCase = await getCase(inbox.id, caseId);
    return workCase?.schemaVersion ? projectCaseForHuman(workCase) : null;
  },
  readBody: body,
  writeJson: json,
  mutationAuthorization: async (req, { human, inbox, caseId }) => {
    const session = await auth.getSession(req);
    if (!session) throw Object.assign(new Error('Authenticated human session required'), { statusCode: 401 });
    return {
      lockKeys: [inboxMutationKey(inbox.id), ...(caseId ? [caseMutationKey(caseId)] : []), ...(session.sessionId && typeof auth.sessionKey === 'function' ? [auth.sessionKey(session.sessionId)] : [])],
      authorize: async () => {
        if (!await auth.getSession(req)) throw Object.assign(new Error('Authenticated human session required'), { statusCode: 401 });
        const currentHuman = await auth.getHuman(req);
        if (!currentHuman) throw Object.assign(new Error('Authenticated human session required'), { statusCode: 401 });
        if (currentHuman.id !== human.id) throw Object.assign(new Error('Human session changed'), { statusCode: 409, code: 'ACCOUNT_CHANGED' });
        const currentInbox = await store.getJson(path.join('inboxes', inbox.id, 'inbox.json'));
        if (!currentInbox || currentInbox.organizationId !== inbox.organizationId || !await canAccessInbox(currentHuman, currentInbox, { maxAgeMs: 0 })) throw Object.assign(new Error('Workspace membership required'), { statusCode: 403 });
      }
    };
  }
});

// Reads a JSON body up to the server's general limit (413 beyond it). An unparseable body comes
// back as `invalid`, so each route answers with its own contract code. With `stopAfter`, reading
// stops once the body is longer and it comes back as `tooLarge`. Bytes are decoded once, so a
// character split across chunks stays intact.
async function readJsonBody(req, { stopAfter = null } = {}) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (stopAfter !== null && bytes > stopAfter) return { bytes, value: null, invalid: false, tooLarge: true };
    if (bytes > maxBodyBytes) throw Object.assign(new Error(`Request body exceeds ${maxBodyBytes} bytes`), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!bytes) return { bytes: 0, value: {}, invalid: false };
  try { return { bytes, value: JSON.parse(Buffer.concat(chunks).toString('utf8')), invalid: false }; }
  catch { return { bytes, value: null, invalid: true }; }
}

// agent-registration v1 §6.1–§6.3 (task A-4.3): one-time private activation with a bootstrap
// token, recovery of a lost response by activationId, and replay detection. The first matching
// row of the §6.1 table wins.
const activationDeliveryModes = ['envoi_link', 'webhook', 'provider', 'poll', 'on_demand', 'a2a'];
const validActivationBody = value => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => ['registrationId', 'activationId', 'deliveryMode'].includes(key))
  && typeof value.registrationId === 'string' && /^registration_[A-Za-z0-9_-]{1,80}$/.test(value.registrationId)
  && validActivationId(value.activationId) && activationDeliveryModes.includes(value.deliveryMode);
const connectorRuntimeOf = type => { try { return validateConnectorRuntime(type); } catch { return null; } };
const registrationEnded = reason => codedError(409, 'REGISTRATION_ENDED', {
  rejected: 'The owner rejected this agent.', expired: 'This setup expired.', withdrawn: 'The owner withdrew this approval.'
}[reason] || 'This setup ended.', { reason });

async function activateRegistration(rawToken, input, authority) {
  if (!onboardingFlags.registration) throw codedError(404, 'FEATURE_DISABLED', 'Agent-led setup is not available yet.');
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  // Row 2, checked before the token: nothing is consumed.
  if (!validActivationId(body.activationId)) throw codedError(400, 'ACTIVATION_ID_REQUIRED', 'This helper must be updated.');
  const registration = await registrations.registrationForToken(rawToken, body.registrationId);
  if (recoveryWindowOver(registration, new Date())) throw registrations.recoveryExpired();
  if (!validActivationBody(body)) throw codedError(400, 'ACTIVATION_INVALID', 'This activation request is not valid.');
  if (registration.providerBrowserPoll && authority !== providerGatewayAuthority) throw codedError(400, 'DELIVERY_MODE_NOT_AVAILABLE', 'This installation requires private gateway activation.');
  const activationIdHash = hashSecret(body.activationId);
  if (registration.status === 'activated') return activatedAgain(rawToken, registration.id, activationIdHash);
  const gatewayPoll = authority === providerGatewayAuthority && registration.providerBrowserPoll && browserPollAvailable(onboardingFlags) && body.deliveryMode === 'poll';
  if (!gatewayPoll && !deliveryModeAvailable(onboardingFlags, body.deliveryMode)) throw codedError(400, 'DELIVERY_MODE_NOT_AVAILABLE', 'That delivery mode is not available.');
  const status = derivedStatus(registration, new Date());
  if (status === 'pending_claim') throw codedError(409, 'REGISTRATION_PENDING', 'Waiting for the owner to approve.');
  if (status !== 'approved') throw registrationEnded(status);
  const outcome = await runActivation(registration, (current, plannedInboxId, writeAudit) => commitActivation(rawToken, current, body, activationIdHash, plannedInboxId, writeAudit));
  if (outcome.again) return activatedAgain(rawToken, registration.id, activationIdHash);
  if (outcome.ended) throw outcome.recheck ? codedError(409, 'REGISTRATION_ENDED', 'This approval no longer holds. Ask the owner.', { reason: 'withdrawn' }) : registrationEnded(outcome.ended);
  await settleActivation(outcome.activated);
  return { status: 201, body: outcome.activated.response };
}

// §6.1 rows 7-11 in one transaction under the registration's lock: re-read, re-check, then `commit` creates the agent
// (new_agent), the installation and its family. Returns { again }, { ended, recheck? } or { activated }.
async function runActivation(registration, commit) {
  const { target } = registration;
  const isNew = target.kind === 'new_agent';
  const plannedInboxId = isNew ? store.id('inbox') : null;
  return withInboxMutation(isNew ? target.workspaceInboxId : target.agentInboxId, async writeAudit => {
    const current = await store.getJson(registrationPath(registration.id));
    if (current?.status === 'activated') return { again: true };
    const currentStatus = current ? derivedStatus(current, new Date()) : 'expired';
    if (currentStatus !== 'approved') return { ended: currentStatus };
    if (!await activationRechecksPass(current)) {
      // Row 11: the decision no longer holds. The registration becomes withdrawn, which ends its
      // hold and slot; committed before the error is returned.
      const at = store.now();
      await store.putJson(registrationPath(current.id), { ...current, status: 'withdrawn', withdrawnAt: at, withdrawnBy: 'recheck' });
      if (isNew && (await store.getJson(addressHoldPath(target.address)))?.registrationId === current.id) await store.deleteJson(addressHoldPath(target.address));
      await writeAudit('agent.registration_withdrawn', { registrationId: current.id, target: target.kind, reason: 'recheck' }, at);
      return { ended: 'withdrawn', recheck: true };
    }
    return { activated: await commit(current, plannedInboxId, writeAudit) };
  }, isNew ? [plannedInboxId] : [], [
    registrationLockKey(registration.id), humanAgentLimitKey(registration.principalHumanId),
    ...(isNew ? [addressHoldLockKey(target.address)] : [])
  ]);
}

async function settleActivation({ agent, inboxId, existing }) {
  if (!existing) return;
  // Every earlier installation was replaced: end their streams, then, as a3 §4 reconnect does,
  // release held sends of an active agent.
  closeAgentStreams(inboxId, agent.id, { code: 'CREDENTIAL_REVOKED', reason: 'replaced' });
  if (agent.status === 'active' && await withInboxMutation(inboxId, () => releaseHeldSends(inboxId))) deliveryWorker.kick();
}

// §6.1 row 11 re-checks, inside the activation's lock. False means the approval no longer holds.
async function activationRechecksPass(registration) {
  const { target } = registration;
  const approver = auth.provider === 'workos'
    ? await auth.getStoredHumanForAuthorization(registration.approverHumanId)
    : await store.getJson(path.join('humans', `${registration.approverHumanId}.json`));
  if (!approver || (auth.provider === 'workos' && typeof auth.admitted === 'function' && !auth.admitted(approver))) return false;
  if (!(registration.oauth ? remoteRouteAvailable(onboardingFlags, registration.connectionRoute) : routeAvailable(onboardingFlags, registration.connectionRoute))) return false;
  const inbox = await store.getJson(path.join('inboxes', target.kind === 'new_agent' ? target.workspaceInboxId : target.agentInboxId, 'inbox.json'));
  if (!inbox || !await canManageInbox(approver, inbox, { maxAgeMs: 0 })) return false;
  const slotFree = async options => {
    try { await agentSlots.assertActiveAgentSlot(registration.principalHumanId, { ...options, excludingRegistrationId: registration.id }); return true; }
    catch (error) { if (error.code === 'ACTIVE_AGENT_LIMIT') return false; throw error; }
  };
  if (target.kind === 'new_agent') {
    if ((await store.getJson(addressHoldPath(target.address)))?.registrationId !== registration.id) return false;
    if (await identityTaken(target.address)) return false;
    return slotFree({});
  }
  const agent = await store.getJson(path.join('inboxes', target.agentInboxId, 'agents', `${target.agentId}.json`));
  if (!agent || inbox.ownerAgentId !== agent.id || agent.onboardingStatus !== 'approved' || !['active', 'paused'].includes(agent.status)) return false;
  if ((agent.accessGeneration || 0) !== (target.accessGeneration || 0)) return false;
  const newest = (await installations.list(target.agentInboxId, agent)).find(item => item.status === 'active') || null;
  if ((newest?.id ?? null) !== target.replacesInstallationId) return false;
  if (!await agentSlots.agentHasLiveFamily(target.agentInboxId, agent.id, new Date())) return slotFree({ excludingAgentId: agent.id });
  return true;
}

// §6.3: the installation and its credential family together; for new_agent also the agent.
// `oauth` is the agent-remote-auth exchange (§6.1, §8): the family gets an audience and the client, the tokens are oauth_
// types, the code index and the registration record the use, and there is no lost-response envelope. Returns the token
// response in place of the activation body.
async function commitActivation(rawToken, registration, body, activationIdHash, plannedInboxId, writeAudit, { oauth = false } = {}) {
  const { target } = registration;
  // An OAuth installation never activates a permission without a scope (agent-remote-auth §4.3), whatever its record holds.
  const permissions = oauth ? oauthGrantablePermissions(registration.effectivePermissions) : registration.effectivePermissions;
  const activatedAt = store.now();
  const familyId = store.id('credential_family');
  const installationId = store.id('installation');
  const runtime = connectorRuntimeOf(registration.runtime.type);
  let agent;
  let inbox;
  let replaced = 0;
  if (target.kind === 'new_agent') {
    const workspace = await store.getJson(path.join('inboxes', target.workspaceInboxId, 'inbox.json'));
    if (!await reserveIdentity(target.address, { status: 'reserved' }, { holdRegistrationId: registration.id })) throw new Error('The held address could not be reserved');
    agent = {
      id: store.id('agent'), organizationId: workspace.organizationId, name: target.name, slug: target.localPart, address: target.address, identity: publicIdentity(target.localPart),
      principalHumanId: registration.principalHumanId, capabilities: [], permissions, ...(runtime ? { runtime } : {}),
      createdAt: activatedAt, status: 'active', onboardingStatus: 'approved', approvedAt: activatedAt, approvedByHumanId: registration.approverHumanId
    };
    inbox = await createDedicatedAgentInbox({ sourceInbox: workspace, organizationId: workspace.organizationId, ownerHumanId: registration.principalHumanId, agent, status: 'active', inboxId: plannedInboxId });
    await store.putJsonBatch([
      document(path.join('directory', 'agents', `${agent.id}.json`), { agentId: agent.id, inboxId: inbox.id, address: agent.address, externalAddress: externalEmailEnabled ? publicEmailAddressForAgent(agent) : null, status: agent.status, verified: true }),
      document(nativeAddressDirectoryPath(agent.address), { agentId: agent.id, inboxId: inbox.id, address: agent.address, status: agent.status, verified: true })
    ]);
    if (externalEmailEnabled && publicEmailAddressForAgent(agent)) await store.putJson(externalAddressDirectoryPath(publicEmailAddressForAgent(agent)), { agentId: agent.id, inboxId: inbox.id, address: publicEmailAddressForAgent(agent), status: agent.status });
    await store.deleteJson(addressHoldPath(target.address));
    await writeAudit('agent.inbox_created', { agentId: agent.id, inboxId: inbox.id, humanId: registration.approverHumanId }, activatedAt, workspace.id);
  } else {
    inbox = await store.getJson(path.join('inboxes', target.agentInboxId, 'inbox.json'));
    const current = await store.getJson(path.join('inboxes', inbox.id, 'agents', `${target.agentId}.json`));
    // Permissions are decided again; a paused agent stays paused (a3 §4).
    agent = { ...current, permissions, updatedAt: activatedAt };
    replaced = await revokeAgentCredentialFamilies(inbox.id, agent.id, registration.approverHumanId, activatedAt, 'replaced', writeAudit);
    const heldLeases = (await store.listJson(path.join('inboxes', inbox.id, 'work-claims')))
      .filter(claim => claim.agentId === agent.id && ['claimed', 'acknowledged'].includes(claim.status) && new Date(claim.leaseExpiresAt) > new Date(activatedAt));
    await store.putJsonBatch([
      document(path.join('inboxes', inbox.id, 'agents', `${agent.id}.json`), agent),
      ...heldLeases.map(claim => document(workClaimPath(inbox.id, claim.workId), { ...claim, status: 'retryable', retryAt: activatedAt, leaseExpiresAt: null, reofferWithoutAttempt: true, releasedAt: activatedAt, updatedAt: activatedAt }))
    ]);
    if (heldLeases.length) await writeAudit('work.available', { agentId: agent.id, reason: 'lease_released' }, activatedAt, inbox.id);
  }
  const credentials = await issueAgentCredentials(agent.id, inbox.id, familyId, false, {
    installationId, ...(runtime ? { runtime } : {}), ...(oauth ? { audience: registration.oauth.resource, oauthClientId: registration.oauth.clientId } : {})
  }, { oauth });
  await store.putJson(installationPath(inbox.id, agent.id, installationId), {
    id: installationId, agentId: agent.id, credentialFamilyId: familyId, registrationId: registration.id,
    connectionRoute: registration.connectionRoute, deliveryMode: body.deliveryMode, runtime: { type: registration.runtime.type, version: registration.runtime.version },
    createdAt: activatedAt, activatedAt, replayDetectedAt: null
  });
  const installation = oauth ? null : await installations.forFamily(inbox.id, agent, familyId);
  const response = oauth ? tokenResponse({
    accessToken: credentials.agentApiToken, refreshToken: credentials.agentRefreshToken, expiresIn: agentAccessTokenTtlSeconds, scope: scopeForPermissions(permissions)
  }) : {
    installation: publicInstallation(installation),
    agent: { id: agent.id, name: displayName(agent.name, String(agent.address).split('@')[0]), address: agent.address, status: agent.status },
    inboxId: inbox.id, effectivePermissions: registration.effectivePermissions,
    agentApiToken: credentials.agentApiToken, agentRefreshToken: credentials.agentRefreshToken,
    agentTokenExpiresAt: credentials.agentTokenExpiresAt, agentRefreshTokenExpiresAt: credentials.agentRefreshTokenExpiresAt, tokenType: credentials.tokenType
  };
  if (oauth) {
    // agent-registration §14.3: one transaction sets the code index's usedAt, the registration's status and its codeUsedAt.
    // There is no lost-response recovery: a token response that never arrives needs a new authorization (§6.1).
    const codeIndex = await store.getJson(oauthCodePath(registration.oauth.codeHash));
    await store.putJsonBatch([
      document(oauthCodePath(registration.oauth.codeHash), { ...codeIndex, usedAt: activatedAt }),
      document(registrationPath(registration.id), {
        ...registration, status: 'activated', activatedAt, installationId, agentId: agent.id, agentInboxId: inbox.id, credentialFamilyId: familyId,
        oauth: { ...registration.oauth, codeUsedAt: activatedAt }
      })
    ]);
  } else {
    // §6.2: the lost-response envelope, under a key only the raw bootstrap token derives.
    await store.putJson(activationRecoveryPath(registration.tokenHash), {
      tokenHash: registration.tokenHash, registrationId: registration.id, activationIdHash,
      expiresAt: new Date(new Date(activatedAt).getTime() + activationRecoverySeconds * 1000).toISOString(),
      encrypted: encryptActivation(rawToken, connectorEncryptionKey(), registration.id, activationIdHash, response)
    });
    await store.putJson(registrationPath(registration.id), {
      ...registration, status: 'activated', activatedAt, activationIdHash, installationId, agentId: agent.id, agentInboxId: inbox.id, credentialFamilyId: familyId
    });
  }
  await writeAudit('agent.installation_activated', {
    agentId: agent.id, installationId, credentialFamilyId: familyId, registrationId: registration.id, target: target.kind,
    connectionRoute: registration.connectionRoute, deliveryMode: body.deliveryMode, permissions, humanId: registration.approverHumanId,
    ...(replaced ? { replacedFamilyCount: replaced } : {})
  }, activatedAt, inbox.id);
  return { response, agent, inboxId: inbox.id, existing: target.kind === 'existing_agent' };
}

// §6.1 row 7a: two holders of one bootstrap token (or, for agent-remote-auth §6.1 row 9, one used code). The installation
// this activation created ends; the identity is not frozen. Committed before the error is returned, inside the
// registration's lock.
async function revokeReplayedActivation(current, writeAudit) {
  const at = store.now();
  await revokeCredentialFamily(current.agentInboxId, current.agentId, current.credentialFamilyId, null, at, 'revoked', writeAudit);
  const stored = await store.getJson(installationPath(current.agentInboxId, current.agentId, current.installationId));
  await store.putJson(installationPath(current.agentInboxId, current.agentId, current.installationId), { ...stored, replayDetectedAt: at });
  if (current.tokenHash) await store.deleteJson(activationRecoveryPath(current.tokenHash));
  const heldLeases = (await store.listJson(path.join('inboxes', current.agentInboxId, 'work-claims')))
    .filter(claim => claim.agentId === current.agentId && claim.credentialFamilyId === current.credentialFamilyId && ['claimed', 'acknowledged'].includes(claim.status) && new Date(claim.leaseExpiresAt) > new Date(at));
  await store.putJsonBatch(heldLeases.map(claim => document(workClaimPath(current.agentInboxId, claim.workId), { ...claim, status: 'retryable', retryAt: at, leaseExpiresAt: null, reofferWithoutAttempt: true, releasedAt: at, updatedAt: at })));
  await writeAudit('agent.activation_replay_detected', { agentId: current.agentId, installationId: current.installationId, credentialFamilyId: current.credentialFamilyId, registrationId: current.id }, at);
  if (heldLeases.length) await writeAudit('work.available', { agentId: current.agentId, reason: 'lease_released' }, at);
  return { replayed: current };
}

// §6.1 rows 6, 7 and 7a: a registration that already activated.
async function activatedAgain(rawToken, registrationId, activationIdHash) {
  const registration = await store.getJson(registrationPath(registrationId));
  const outcome = await withInboxMutation(registration.agentInboxId, async writeAudit => {
    const current = await store.getJson(registrationPath(registrationId));
    const agent = await store.getJson(path.join('inboxes', current.agentInboxId, 'agents', `${current.agentId}.json`));
    const installation = agent ? await installations.forFamily(current.agentInboxId, agent, current.credentialFamilyId) : null;
    // Row 6: an ended installation's history is never rewritten.
    if (!installation || installation.status !== 'active') return { recoveryExpired: true };
    if (current.activationIdHash === activationIdHash) {
      const envelope = await store.getJson(activationRecoveryPath(current.tokenHash));
      const body = envelope?.registrationId === current.id && envelope.activationIdHash === activationIdHash
        ? decryptActivation(rawToken, connectorEncryptionKey(), current.id, activationIdHash, envelope.encrypted) : null;
      return body ? { body } : { recoveryExpired: true };
    }
    return revokeReplayedActivation(current, writeAudit);
  }, [], [registrationLockKey(registrationId)]);
  if (outcome.recoveryExpired) throw registrations.recoveryExpired();
  if (outcome.replayed) {
    closeAgentStreams(outcome.replayed.agentInboxId, outcome.replayed.agentId, { code: 'CREDENTIAL_REVOKED', reason: 'revoked' }, outcome.replayed.credentialFamilyId);
    throw codedError(401, 'ACTIVATION_REPLAY', 'This setup was already used. Ask the owner to reconnect.');
  }
  return { status: 200, body: outcome.body };
}

// ------------------------------------------------------------------ agent-remote-auth §6-§8 (task RA-A2)
// The token, revocation and bootstrap-code endpoints. Policy B (approved revision 4): a used code is always denied, and only
// an otherwise valid replay revokes the installation its first exchange created. Nothing below logs or stores a raw code,
// token, verifier or secret: codes and tokens are looked up by SHA-256 only.

const sendOAuth = (res, result) => {
  res.writeHead(result.status, result.body === undefined ? { ...result.headers, 'content-length': 0 } : result.headers);
  res.end(result.body === undefined ? undefined : JSON.stringify(result.body));
};
async function readLimitedBody(req, limit) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// POST /oauth/token and POST /oauth/revoke. Neither reads cookies or takes a CSRF header. Every request, successful or not,
// counts once toward the per-source limit (agent-remote-auth §6, x-limits.tokenRequestsPerSourcePerMinute, 60 a minute).
async function handleOAuthEndpoint(req, res, url) {
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  const source = clientIp(req);
  const limited = await registrationLimits.consumeTokenRequest(source);
  if (!limited.allowed) return sendOAuth(res, oauthError('temporarily_unavailable', { retryAfterSeconds: limited.retryAfterSeconds }));
  const result = url.pathname === '/oauth/token' ? await oauthTokenRequest(req) : await oauthRevokeRequest(req);
  return sendOAuth(res, result);
}

async function readTokenForm(req) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/x-www-form-urlencoded')) return { invalid: true };
  const raw = await readLimitedBody(req, tokenRequestMaxBytes);
  return raw === null ? { invalid: true } : parseTokenForm(raw);
}
const authenticateOAuthClient = (req, params) => authenticateClient({
  authorization: req.headers.authorization, bodyClientId: params.get('client_id'), bodySecret: params.has('client_secret'), resolveClient: remoteAuth.resolveClient
});

async function oauthTokenRequest(req) {
  const form = await readTokenForm(req);
  if (form.invalid) return oauthError('invalid_request');
  const { params } = form;
  const grantType = params.get('grant_type');
  if (!grantType) return oauthError('invalid_request');
  const bootstrap = grantType === grantTypes.bootstrap;
  if (!Object.values(grantTypes).includes(grantType) || (bootstrap && !onboardingFlags.providerConnectors)) return oauthError('unsupported_grant_type');
  // Row 2: parameters, before any lookup.
  const parsed = bootstrap ? bootstrapGrantParameters(params) : grantType === grantTypes.refresh_token ? refreshGrantParameters(params) : codeGrantParameters(params);
  if (!parsed) return oauthError('invalid_request');
  // Row 3.
  const authenticated = await authenticateOAuthClient(req, params);
  if (authenticated.error) return authenticated.error;
  const { client } = authenticated;
  if (bootstrap && !(client.bootstrapCode && client.tokenEndpointAuthMethod === 'client_secret_basic')) return oauthError('unauthorized_client');
  if (grantType === grantTypes.refresh_token) return refreshOAuthToken(client, parsed);
  return exchangeOAuthCode(client, parsed, bootstrap ? 'bootstrap_code' : 'authorization_code');
}

// §6.1 rows 4-10, and §8's bootstrap exchange (rows 4, 5 and 8, then 9 and 10, applied to the code). Each row decides before
// the next is read; the reuse check is row 9, after every check that makes a request valid.
async function exchangeOAuthCode(client, p, kind) {
  const failed = (error = 'invalid_grant') => oauthError(error);
  const codeHash = sha256Hex(p.code);
  const index = await store.getJson(oauthCodePath(codeHash));
  // Row 4: the code exists and was issued to this client. An orphan (its registration gone) is unknown and revokes nothing.
  if (!index || index.kind !== kind || index.clientId !== client.clientId) return failed();
  const registration = await registrations.getRegistration(index.registrationId);
  if (!registration?.oauth || registration.oauth.codeHash !== codeHash || registration.oauth.clientId !== client.clientId
    || registration.oauth.source !== (kind === 'bootstrap_code' ? 'bootstrap' : 'consent')) return failed();
  // Row 5.
  if (new Date(index.expiresAt) <= new Date()) return failed();
  if (kind === 'authorization_code') {
    // Row 6: exactly the redirect_uri of the authorization request, loopback port included. Row 7: PKCE S256.
    if (registration.oauth.redirectUri !== p.redirectUri) return failed();
    if (!pkceMatches(p.verifier, registration.oauth.codeChallenge)) return failed();
  }
  // Row 8: the resource of the request, of the approval and of this server are one.
  if (p.resource !== registration.oauth.resource || p.resource !== remoteAuth.resource) return failed('invalid_target');
  // Row 9: a used code is always denied. Reaching here means every earlier row passed, so this is an otherwise valid replay:
  // it ends the installation the first exchange created, if that is still active.
  if (index.usedAt || registration.oauth.codeUsedAt || registration.status === 'activated') {
    await endReplayedOAuthInstallation(registration.id);
    return failed();
  }
  // Row 10 and the activation (agent-registration §6.1 row 11 and §6.3), for deliveryMode on_demand.
  const outcome = await runActivation(registration, (current, plannedInboxId, writeAudit) => commitActivation(null, current, { deliveryMode: 'on_demand' }, null, plannedInboxId, writeAudit, { oauth: true }));
  // A concurrent exchange won the activation lock: this is the second holder of one code.
  if (outcome.again) {
    await endReplayedOAuthInstallation(registration.id);
    return failed();
  }
  if (outcome.ended) return failed();
  await settleActivation(outcome.activated);
  return oauthSuccess(outcome.activated.response);
}

// §6.1 "A used code": ends the installation the first exchange created while it is still active, as agent-registration §6.1
// row 7a does. The identity is not frozen.
async function endReplayedOAuthInstallation(registrationId) {
  const registration = await store.getJson(registrationPath(registrationId));
  if (!registration?.agentInboxId || !registration.credentialFamilyId) return;
  const outcome = await withInboxMutation(registration.agentInboxId, async writeAudit => {
    const current = await store.getJson(registrationPath(registrationId));
    const agent = await store.getJson(path.join('inboxes', current.agentInboxId, 'agents', `${current.agentId}.json`));
    const installation = agent ? await installations.forFamily(current.agentInboxId, agent, current.credentialFamilyId) : null;
    if (!installation || installation.status !== 'active') return { ended: true };
    return revokeReplayedActivation(current, writeAudit);
  }, [], [registrationLockKey(registrationId)]);
  if (outcome.replayed) closeAgentStreams(outcome.replayed.agentInboxId, outcome.replayed.agentId, { code: 'CREDENTIAL_REVOKED', reason: 'revoked' }, outcome.replayed.credentialFamilyId);
}

// agent-registration §14.5: the first use of either successor deletes the envelope that names it and clears recoveryTokenHash on
// both successors, in one write under the family lock (held by the caller). `keepPath` is a record the caller rewrites itself.
async function retireOAuthRecovery(recoveryTokenHash, keepPath = null) {
  const envelope = await store.getJson(oauthRefreshRecoveryPath(recoveryTokenHash));
  if (!envelope) return;
  const writes = [];
  for (const target of [agentCredentialPath(envelope.successorAccessHash), agentRefreshCredentialPath(envelope.successorRefreshHash)]) {
    if (target === keepPath) continue;
    const record = await store.getJson(target);
    if (record?.recoveryTokenHash) writes.push(document(target, { ...record, recoveryTokenHash: null }));
  }
  if (writes.length) await store.putJsonBatch(writes);
  await store.deleteJson(oauthRefreshRecoveryPath(recoveryTokenHash));
}

// §14.2: the first outer /mcp request an oauth_access token authenticates records `usedAt`, before it is dispatched, with a
// conditional write under the family lock that a refresh also takes. It is the first use that retires a recovery envelope.
async function markOAuthAccessUsed(tokenHash, record) {
  if (record.usedAt) return;
  await store.withTransaction([oauthFamilyLockKey(record.familyId)], async () => {
    const target = agentCredentialPath(tokenHash);
    const current = await store.getJson(target);
    if (!current || current.usedAt) return;
    if (current.recoveryTokenHash) await retireOAuthRecovery(current.recoveryTokenHash, target);
    await store.putJson(target, { ...current, usedAt: store.now(), recoveryTokenHash: null });
  });
}

// Revoking a family also deletes its recovery envelopes. Best effort: a revoked family is refused anyway.
async function deleteOAuthRecoveries(familyId) {
  for (const envelope of await store.listJson(oauthRefreshRecoveryDir)) {
    if (envelope?.familyId === familyId && /^[a-f0-9]{64}$/.test(envelope.tokenHash || '')) await store.deleteJson(oauthRefreshRecoveryPath(envelope.tokenHash));
  }
}

// §6.2. Rows 4-8 run under the family's lock together with the inbox lock the A1 rotation takes.
async function refreshOAuthToken(client, p) {
  const failed = (error = 'invalid_grant') => oauthError(error);
  // Row 4: an oauth_refresh token of a family issued to this client. An A1 `refresh`, a token of another client and an
  // unknown token are all unknown here.
  if (!hasAgentCredentialFormat(p.token, 'refresh')) return failed();
  const tokenHash = hashSecret(p.token);
  const refreshPath = agentRefreshCredentialPath(tokenHash);
  const pending = await store.getJson(refreshPath);
  if (pending?.tokenType !== 'oauth_refresh' || !pending.inboxId || !pending.agentId || !pending.familyId) return failed();
  const familyPath = agentCredentialFamilyPath(pending.inboxId, pending.agentId, pending.familyId);
  const pendingFamily = await store.getJson(familyPath);
  if (!pendingFamily?.audience || pendingFamily.oauthClientId !== client.clientId) return failed();
  const replayEvents = [];
  const writeReplayAudit = async (type, data, createdAt, targetInboxId) => {
    const record = await auditRecord(targetInboxId, type, data, createdAt);
    await store.putJson(record.document.path, record.document.value);
    replayEvents.push({ inboxId: targetInboxId, event: record.event });
    return record.event;
  };
  let recovered = false;
  const rotate = async () => {
    const current = await store.getJson(refreshPath);
    const family = await store.getJson(familyPath);
    const agent = await store.getJson(path.join('inboxes', pending.inboxId, 'agents', `${pending.agentId}.json`));
    if (current?.tokenType !== 'oauth_refresh' || !family?.audience || family.oauthClientId !== client.clientId) return { error: 'invalid_grant' };
    // Row 5: the family is live and the agent is still approved. A paused agent can refresh (a3 §14).
    if (family.revokedAt || current.revokedAt || new Date(family.refreshExpiresAt) <= new Date()) return { error: 'invalid_grant' };
    if (!agent || agent.onboardingStatus !== 'approved' || !['active', 'paused'].includes(agent.status)) return { error: 'invalid_grant' };
    const scope = scopeForPermissions(agent.permissions || []);
    // Rows 7 and 8 never consume a token: they are checked before anything is written.
    const scopeOrTarget = () => (p.scope !== null && !sameScopes(p.scope, scope) ? 'invalid_scope' : p.resource !== null && p.resource !== family.audience ? 'invalid_target' : null);
    const oauthFamilyRef = { familyId: family.id, oauthClientId: client.clientId };
    if (current.usedAt) {
      // Row 6: the previous token is recoverable only inside the 60 s window, by the same client, and only while neither
      // successor has been used. Anything else is replay.
      const envelope = await store.getJson(oauthRefreshRecoveryPath(tokenHash));
      if (envelope?.familyId === family.id && envelope.oauthClientId === client.clientId && new Date(envelope.expiresAt) > new Date()) {
        const [successorAccess, successorRefresh] = await Promise.all([store.getJson(agentCredentialPath(envelope.successorAccessHash)), store.getJson(agentRefreshCredentialPath(envelope.successorRefreshHash))]);
        if (successorAccess?.usedAt === null && successorRefresh?.usedAt === null && !successorAccess.revokedAt && !successorRefresh.revokedAt) {
          const response = openRefreshRecovery(p.token, connectorEncryptionKey(), oauthFamilyRef, envelope.envelope);
          if (response) {
            const invalid = scopeOrTarget();
            if (invalid) return { error: invalid };
            recovered = true;
            return { response };
          }
        }
      }
      // Two holders of one refresh token: the family is revoked. Returned, not thrown, so the revocation commits.
      const revokedAt = store.now();
      await store.putJson(familyPath, { ...family, revokedAt, revokedReason: 'refresh_replay', updatedAt: revokedAt });
      await caseSessions.endForFamily(pending.inboxId, pending.agentId, family.id, 'credential_ended', revokedAt, writeReplayAudit);
      await deleteOAuthRecoveries(family.id);
      return { replayed: { inboxId: pending.inboxId, agentId: pending.agentId, familyId: family.id } };
    }
    if (new Date(current.expiresAt) <= new Date()) return { error: 'invalid_grant' };
    const invalid = scopeOrTarget();
    if (invalid) return { error: invalid };
    // The first use of a successor refresh token is the next rotation: it retires the envelope that named it.
    if (current.recoveryTokenHash) await retireOAuthRecovery(current.recoveryTokenHash, refreshPath);
    await store.putJson(refreshPath, { ...current, usedAt: store.now(), recoveryTokenHash: null });
    const successor = await issueAgentCredentials(pending.agentId, pending.inboxId, family.id, true, {}, { oauth: true, recoveryTokenHash: tokenHash });
    const response = tokenResponse({ accessToken: successor.agentApiToken, refreshToken: successor.agentRefreshToken, expiresIn: agentAccessTokenTtlSeconds, scope });
    const createdAt = store.now();
    await store.putJson(oauthRefreshRecoveryPath(tokenHash), {
      tokenHash, familyId: family.id, oauthClientId: client.clientId,
      successorAccessHash: hashSecret(successor.agentApiToken), successorRefreshHash: hashSecret(successor.agentRefreshToken),
      envelope: sealRefreshRecovery(p.token, connectorEncryptionKey(), oauthFamilyRef, response), createdAt,
      expiresAt: new Date(new Date(createdAt).getTime() + refreshRecoverySeconds * 1000).toISOString()
    });
    return { response };
  };
  const result = await store.withTransaction([inboxMutationKey(pending.inboxId), oauthFamilyLockKey(pending.familyId)], rotate);
  if (result.error) return failed(result.error);
  if (result.response) {
    void presenceRecorder.record({ inboxId: pending.inboxId, agentId: pending.agentId, familyId: pending.familyId }, ['lastSeenAt', 'lastSuccessfulRefreshAt']);
    // Only recoveries are audited, as for A1: an event per ordinary refresh would flood the owner's activity.
    if (recovered) {
      await audit(pending.inboxId, 'agent.refresh_recovered', { agentId: pending.agentId, credentialFamilyId: pending.familyId, refreshExpiresAt: pendingFamily.refreshExpiresAt })
        .catch(error => console.error('Refresh recovery audit failed', { name: error?.name || 'Error', agentId: pending.agentId, credentialFamilyId: pending.familyId }));
    }
    return oauthSuccess(result.response);
  }
  for (const committed of replayEvents) publish(committed.inboxId, committed.event);
  const { inboxId, agentId, familyId } = result.replayed;
  await audit(inboxId, 'agent.refresh_replay_detected', { agentId, credentialFamilyId: familyId });
  closeAgentStreams(inboxId, agentId, { code: 'CREDENTIAL_REVOKED', reason: 'refresh_replay' }, familyId);
  return failed();
}

// §7, RFC 7009. A token of a family issued to this client, access or refresh, revokes the family. An unknown, expired or
// already-revoked token is a 200 that changes nothing. A token of another client, or of a family with no client, is
// unauthorized_client and changes nothing.
async function oauthRevokeRequest(req) {
  const form = await readTokenForm(req);
  if (form.invalid) return oauthError('invalid_request');
  const { params } = form;
  const token = params.get('token');
  if (!token || token.length > 512 || (params.has('token_type_hint') && params.get('token_type_hint').length > 64)) return oauthError('invalid_request');
  const authenticated = await authenticateOAuthClient(req, params);
  if (authenticated.error) return authenticated.error;
  const { client } = authenticated;
  const empty = { status: 200, headers: { 'cache-control': 'no-store', pragma: 'no-cache' } };
  const target = hasAgentCredentialFormat(token, 'refresh') ? agentRefreshCredentialPath(hashSecret(token))
    : hasAgentCredentialFormat(token, 'access') ? agentCredentialPath(hashSecret(token)) : null;
  const record = target ? await store.getJson(target) : null;
  if (!record?.familyId || !record.inboxId || !record.agentId) return empty;
  const familyPath = agentCredentialFamilyPath(record.inboxId, record.agentId, record.familyId);
  const family = await store.getJson(familyPath);
  if (!family) return empty;
  // A family with no client (local_helper) and a family of another client are not this client's to revoke.
  if (!oauthTokenTypes.includes(record.tokenType) || !family.audience || family.oauthClientId !== client.clientId) return oauthError('unauthorized_client');
  // §7: an expired or already-revoked token changes nothing, whether the token itself or its family ended (M5: a live
  // family must not be revoked through one of its expired access tokens).
  const nowMs = Date.now();
  if (family.revokedAt || record.revokedAt || Date.parse(record.expiresAt) <= nowMs || Date.parse(family.refreshExpiresAt) <= nowMs) return empty;
  const revoked = await withInboxMutation(record.inboxId, async writeAudit => {
    const current = await store.getJson(familyPath);
    if (!current || current.revokedAt) return null;
    const agent = await store.getJson(path.join('inboxes', record.inboxId, 'agents', `${record.agentId}.json`));
    const at = store.now();
    await revokeCredentialFamily(record.inboxId, record.agentId, record.familyId, null, at, 'revoked', writeAudit);
    // Leases held by this installation would block the next one until they expire.
    const held = await releaseFamilyLeases(record.inboxId, record.agentId, record.familyId, at);
    await writeAudit('agent.installation_revoked', { agentId: record.agentId, installationId: current.installationId || null, credentialFamilyId: record.familyId, actor: 'client' }, at);
    if (held) await writeAudit('work.available', { agentId: record.agentId, reason: 'lease_released' }, at);
    return agent ? record : null;
  });
  if (revoked) closeAgentStreams(record.inboxId, record.agentId, { code: 'CREDENTIAL_REVOKED', reason: 'revoked' }, record.familyId);
  return empty;
}

async function releaseFamilyLeases(inboxId, agentId, familyId, at) {
  const held = (await store.listJson(path.join('inboxes', inboxId, 'work-claims')))
    .filter(claim => claim.agentId === agentId && claim.credentialFamilyId === familyId && ['claimed', 'acknowledged'].includes(claim.status) && new Date(claim.leaseExpiresAt) > new Date(at));
  await store.putJsonBatch(held.map(claim => document(workClaimPath(inboxId, claim.workId), { ...claim, status: 'retryable', retryAt: at, leaseExpiresAt: null, reofferWithoutAttempt: true, releasedAt: at, updatedAt: at })));
  return held.length;
}

// §8 issue: POST /api/oauth/bootstrap-codes, human session and CSRF (checked before this handler). The checks and precedence
// are §5.2's, with step 3 being "the client is a bootstrap client", else 404 AUTHORIZATION_REQUEST_INVALID. The code is in
// this response only, and its approval lapses after 600 s.
async function handleBootstrapIssue(req, res) {
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  if (!onboardingFlags.providerConnectors) throw remoteAuthDisabled();
  const human = await auth.getHuman(req);
  if (!human) throw codedError(401, 'AUTHENTICATION_REQUIRED', 'Please sign in again.');
  res.setHeader('cache-control', 'no-store');
  const input = await readJsonBody(req);
  const value = !input.invalid && input.value && typeof input.value === 'object' && !Array.isArray(input.value) ? input.value : null;
  const client = typeof value?.clientId === 'string' ? await remoteAuth.resolveClient(value.clientId) : null;
  const bootstrapClient = client && client.registration === 'pre_registered' && client.bootstrapCode && client.connectionRoute === 'provider_connector' ? client : null;
  const { clientId: _clientId, ...body } = value || {};
  const outcome = await registrations.approveBootstrap(human, bootstrapClient, remoteAuth.resource, value ? body : null);
  const { approved } = outcome;
  return json(res, 201, {
    bootstrapCode: outcome.code, expiresAt: approved.codeExpiresAt, registrationId: approved.registrationId, clientName: bootstrapClient.clientName, provider: bootstrapClient.provider,
    target: approved.target, workspaceName: approved.workspaceName, agent: approved.agent, effectivePermissions: approved.effectivePermissions, policyProfile: approved.policyProfile
  });
}

// The reviewed agent-facing skill content (Lane B, integrations/onboarding/skill). It stays
// unpublished until the local-helper route is offered: with the route off it is FEATURE_DISABLED.
// skill.json lists as offered only what GET /api/onboarding/routes marks available, and names
// this deployment's own origin (ENVOI_PUBLIC_URL) in connectUrl and helperCommand. The file's
// production values stay when ENVOI_PUBLIC_URL is unset or invalid; the Host header is never used.
const connectContentDir = path.resolve('integrations', 'onboarding', 'skill');
function configuredPublicOrigin() {
  try { return process.env.ENVOI_PUBLIC_URL ? new URL(process.env.ENVOI_PUBLIC_URL).origin : null; } catch { return null; }
}
const connectContent = {
  '/connect/SKILL.md': { file: 'SKILL.md', type: 'text/markdown; charset=utf-8' },
  '/connect/HEARTBEAT.md': { file: 'HEARTBEAT.md', type: 'text/markdown; charset=utf-8' },
  '/connect/skill.json': { file: 'skill.json', type: 'application/json; charset=utf-8' }
};
async function serveConnectContent(req, res, url) {
  const entry = connectContent[url.pathname];
  if (!entry) return fail(res, 404, 'Not found');
  if (!routeAvailable(onboardingFlags, 'local_helper')) throw codedError(404, 'FEATURE_DISABLED', 'Agent-led setup is not available yet.');
  let content = await readFile(path.join(connectContentDir, entry.file));
  if (entry.file === 'skill.json') {
    const manifest = JSON.parse(content.toString('utf8'));
    const availability = routeAvailability(onboardingFlags, store.now());
    manifest.offeredConnectionRoutes = availability.routes.filter(item => item.available).map(item => item.connectionRoute);
    manifest.offeredDeliveryModes = availability.deliveryModes.filter(item => item.available).map(item => item.deliveryMode);
    const origin = configuredPublicOrigin();
    if (origin) {
      manifest.connectUrl = `${origin}/connect`;
      manifest.helperCommand = `envoi-link connect ${origin}`;
    }
    content = Buffer.from(`${JSON.stringify(manifest, null, 2)}
`);
  }
  res.writeHead(200, { 'content-type': entry.type, 'content-length': content.byteLength, 'cache-control': 'public, max-age=60', 'x-content-type-options': 'nosniff' });
  return res.end(req.method === 'HEAD' ? undefined : content);
}

async function handleAgentRegistration(req, res, registrationRoute, claimRoute) {
  const featureDisabled = message => codedError(404, 'FEATURE_DISABLED', message);
  if (registrationRoute && !registrationRoute[1]) {
    if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');
    if (!onboardingFlags.registration) throw featureDisabled('Agent-led setup is not available yet.');
    // §2: a registration body over 4,096 bytes is over a creation limit.
    const input = await readJsonBody(req, { stopAfter: registrationBodyMaxBytes });
    if (input.tooLarge) throw registrations.oversized(clientIp(req));
    return json(res, 201, await registrations.create(input.invalid ? null : input.value, { ip: clientIp(req), claimUrl: `${publicBaseUrl(req)}/claim` }));
  }
  if (registrationRoute && !registrationRoute[2]) {
    if (req.method !== 'GET') return fail(res, 405, 'Method not allowed');
    if (!onboardingFlags.registration) throw featureDisabled('Agent-led setup is not available yet.');
    return json(res, 200, await registrations.status(bearerToken(req), registrationRoute[1]));
  }
  // §5.1: the claim routes need a current human session; getHuman re-checks the allowlist and the
  // assurance rule. CSRF and ACCOUNT_CHANGED were checked before any handler.
  if (!onboardingFlags.registration) throw featureDisabled('This feature is not available.');
  const listing = Boolean(claimRoute) && !claimRoute[1] && !claimRoute[3];
  if (listing ? req.method !== 'GET' : req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  const human = await auth.getHuman(req);
  if (!human) throw codedError(401, 'AUTHENTICATION_REQUIRED', 'Please sign in again.');
  if (listing) return json(res, 200, await registrations.listClaims(human));
  if (claimRoute?.[3] === 'withdraw') return json(res, 200, await registrations.withdraw(human, claimRoute[2]));
  const input = await readJsonBody(req);
  const value = input.invalid ? null : input.value;
  if (claimRoute?.[1] === 'lookup') return json(res, 200, await registrations.lookup(human, value));
  if (registrationRoute[2] === 'approve') return json(res, 200, await registrations.approve(human, registrationRoute[1], value));
  return json(res, 200, await registrations.reject(human, registrationRoute[1], value));
}

// case-session v1 §3: why claimed work can no longer be handled, or null. The same checks the
// claim applies, for the work's counterparty and this agent.
async function workIneligibility(message, identity) {
  const workKind = workKindOf(message, isHumanInstruction);
  if (workKind === 'human_instruction') {
    try { await assertHumanInstructionAuthority(message, identity); }
    catch (error) { if ([400, 403, 404, 409, 422].includes(error.statusCode)) return 'instruction_authority_lost'; throw error; }
  } else {
    const [counterpartyInboxId, counterpartyAgentId] = workKind === 'agent_message'
      ? [message.senderInboxId, message.senderAgentId] : [message.counterpartyInboxId, message.counterpartyAgentId];
    const counterparty = counterpartyInboxId && counterpartyAgentId
      ? await store.getJson(path.join('inboxes', assertSafeIdentifier(counterpartyInboxId, 'inboxId'), 'agents', `${assertSafeIdentifier(counterpartyAgentId, 'agentId')}.json`)) : null;
    if (!counterparty || !canAct(counterparty, 'send_agent_messages')) return 'counterparty_unavailable';
    const [theirs, ours] = await Promise.all([
      store.getJson(path.join('inboxes', counterpartyInboxId, 'contacts', `${identity.agent.id}.json`)),
      store.getJson(path.join('inboxes', identity.inboxId, 'contacts', `${counterpartyAgentId}.json`))
    ]);
    if (theirs?.blocked || ours?.blocked) return 'relationship_blocked';
  }
  if (identity.agent.onboardingStatus !== 'approved' || !identity.agent.permissions?.includes('receive_agent_messages')) return 'permission_removed';
  return null;
}

// The stored facts §6.2 step 5 derives a session's conditions from.
async function caseSessionFacts(session) {
  const [family, agent, message, claim, pointer] = await Promise.all([
    store.getJson(agentCredentialFamilyPath(session.inboxId, session.agentId, session.familyId)),
    store.getJson(path.join('inboxes', session.inboxId, 'agents', `${session.agentId}.json`)),
    store.getJson(messagePath(session.inboxId, session.workId)),
    store.getJson(workClaimPath(session.inboxId, session.workId)),
    caseSessions.pointer(session.inboxId, session.workId)
  ]);
  const caseRecord = message?.caseId ? await getCase(session.inboxId, message.caseId) : null;
  // Work that no longer exists can no longer be handled.
  const ineligibleReason = !message ? 'work_missing' : agent ? await workIneligibility(message, { agent, inboxId: session.inboxId, familyId: session.familyId }) : null;
  return { family, agent, message, claim, pointer, caseRecord, ineligibleReason };
}

// The settlement lock set (§6.3): the agent's inbox, every inbox bound to the case, and the case key.
async function withCaseSessionLock(session, operation, transactionOptions = {}) {
  const message = await store.getJson(messagePath(session.inboxId, session.workId));
  const binding = session.caseId ? await store.getJson(caseBindingPath(session.caseId)) : null;
  const related = [...new Set([message?.senderInboxId, message?.counterpartyInboxId, ...(binding?.inboxIds || [])].filter(id => id && id !== session.inboxId))];
  return withInboxMutation(session.inboxId, async writeAudit => {
    const currentBinding = session.caseId ? await store.getJson(caseBindingPath(session.caseId)) : null;
    if (JSON.stringify(binding) !== JSON.stringify(currentBinding)) throw caseToolError('TOOL_BUSY');
    return operation(writeAudit);
  }, related, session.caseId ? [caseMutationKey(session.caseId)] : [], true, transactionOptions);
}

const humanRequestDir = inboxId => path.join('inboxes', inboxId, 'case-human-requests');
const humanRequestPath = (inboxId, id) => path.join(humanRequestDir(inboxId), `${id}.json`);
function caseToolCompletionApproval(value, agentId) {
  const accepted = value.proposals.filter(p => p.status === 'accepted');
  if (!accepted.length) return null;
  let approval = null;
  for (const proposal of accepted) {
    const action = [...value.events].reverse().find(e => e.payload?.action?.actionKey === 'acceptProposal' && e.payload.action.actor === agentId && e.payload.action.outcome === 'ok'
      && e.payload.action.externalRefs?.proposalId === proposal.id && e.payload.action.externalRefs?.optionId === proposal.acceptedOptionId)?.payload.action;
    const evaluation = action && value.policyEvaluations.find(e => e.id === action.externalRefs?.policyEvaluationId && e.actor === agentId && e.requestedAction === 'proposal.accept');
    approval = evaluation && [...value.events].reverse().find(e => e.type === 'humanAction' && e.payload?.action?.actionKey === 'approveOnce'
      && e.payload.action.externalRefs?.serverAuthenticatedHuman === true && e.payload.action.externalRefs?.policyEvaluationId === evaluation.id
      && e.payload.action.externalRefs?.sourceInboxId === action.externalRefs?.sourceInboxId)?.payload.action;
    if (!approval || !action.externalRefs?.sourceInboxId) return null;
  }
  return approval;
}
const caseToolCompletionNeedsHuman = (value, agentId) => value.proposals.some(p => p.status === 'accepted') && !caseToolCompletionApproval(value, agentId);

async function loadCaseToolContext(session) {
  const facts = await caseSessionFacts(session);
  const binding = await store.getJson(caseBindingPath(session.caseId));
  const counterpartyAgentId = binding?.agentIds.find(id => id !== session.agentId);
  const counterpartyDirectory = counterpartyAgentId ? await store.getJson(path.join('directory', 'agents', `${counterpartyAgentId}.json`)) : null;
  const enrichedSession = { ...session, counterpartyAgentId, counterpartyInboxId: counterpartyDirectory?.inboxId };
  const inbox = await store.getJson(path.join('inboxes', session.inboxId, 'inbox.json'));
  const messages = (await store.listJson(path.join('inboxes', session.inboxId, 'messages'))).filter(m => m.caseId === session.caseId).map(m => ({ ...m, inboxId: session.inboxId }));
  const assets = [];
  // Only this inbox's own asset records and this case's grants: object storage keeps a per-inbox
  // copy of every record, and the canonical record is re-read, so nothing system-wide is listed.
  const grants = await store.listJson(path.join('inboxes', session.inboxId, 'asset-grants'));
  const candidates = new Map();
  for (const copy of await store.listJson(path.join('inboxes', session.inboxId, 'assets'))) {
    if (copy?.caseId !== session.caseId || !copy.id) continue;
    const asset = await store.getJson(objectMetadataPath(copy.id));
    if (asset?.workspaceId === session.inboxId && asset.caseId === session.caseId) candidates.set(asset.id, asset);
  }
  for (const grant of grants.filter(g => g.caseId === session.caseId)) {
    const asset = await store.getJson(objectMetadataPath(grant.assetId)); if (asset) candidates.set(asset.id, asset);
  }
  for (const asset of candidates.values()) {
    if (asset.caseId !== session.caseId || !(await assetReadAccess(asset, inbox, { agent: facts.agent, manager: false })).allowed) continue;
    const grant = enrichedSession.counterpartyInboxId ? await store.getJson(assetGrantPath(enrichedSession.counterpartyInboxId, asset.id)) : null;
    assets.push({ ...asset, accessAllowed: true, grant: grants.find(g => g.assetId === asset.id), shared: Boolean(grant && grant.recipientAgentId === counterpartyAgentId && grant.caseId === session.caseId && grant.ownerAgentId === session.agentId) });
  }
  const policyEvaluations = [];
  for (const value of facts.caseRecord.policyEvaluations.filter(e => e.actor === session.agentId)) {
    const bound = await store.getJson(policyBindingPath(session.inboxId, value.id));
    policyEvaluations.push({ ...value, caseId: session.caseId, actionPayload: bound?.actionPayload, humanApproval: value.decision === 'needsHuman' ? hasHumanApprovalForEvaluation(facts.caseRecord, value.id, session.inboxId) ? 'approved' : 'pending' : 'not_required' });
  }
  return { session: enrichedSession, agent: facts.agent, caseRecord: facts.caseRecord, workMessage: facts.message, messages, assets, policyEvaluations,
    humanRequests: (await store.listJson(humanRequestDir(session.inboxId))).filter(r => r.caseId === session.caseId && r.agentId === session.agentId), ownHumanIds: [inbox.ownerHumanId],
    effectiveTools: session.allowedTools.filter(name => allowedCaseTools(facts.agent.permissions, session.workKind, caseSessionMcp.implemented).includes(name)) };
}

async function assertLiveToolSession(session) {
  const current = await caseSessions.get(session.inboxId, session.id);
  const epoch = await caseSessions.epoch();
  if (!current || !epoch || current.createdAt < epoch) throw credentialError('AUTHENTICATION_REQUIRED');
  if (current.endedReason) throw current.endedReason === 'expired' ? caseSessionErrors.expired() : caseSessionErrors.ended(current.endedReason);
  const at = store.now();
  if (current.expiresAt <= at) throw caseSessionErrors.expired();
  const reason = firstCondition(sessionConditions(current, await caseSessionFacts(current), at));
  if (reason) throw caseSessionErrors.ended(reason);
  return current;
}

async function withLiveCaseTool(scope, operation) {
  const session = await caseSessions.get(scope.inboxId, scope.sessionId);
  if (!session || session.agentId !== scope.agentId || session.workId !== scope.workId || session.caseId !== scope.caseId) throw credentialError('AUTHENTICATION_REQUIRED');
  try {
    return await withCaseSessionLock(session, async writeAudit => {
      const binding = await store.getJson(caseBindingPath(session.caseId));
      const current = await assertLiveToolSession(session);
      await reconcileCaseHumanRequests(session.inboxId, session.caseId, writeAudit);
      const ctx = { ...await loadCaseToolContext(current), writeAudit };
      if (!ctx.effectiveTools.includes(scope.toolName)) throw Object.assign(new Error('Tool not available'), { toolNotInSession: true });
      // A participant change while acquiring locks requires a retry, never expanded authority.
      if (JSON.stringify(binding) !== JSON.stringify(await store.getJson(caseBindingPath(session.caseId)))) throw caseToolError('TOOL_BUSY');
      const result = await operation(ctx);
      await assertLiveToolSession(current); // expiry during an awaited read/effect rolls back staged writes
      const agent = await store.getJson(path.join('inboxes', current.inboxId, 'agents', `${current.agentId}.json`));
      if (!allowedCaseTools(agent.permissions, current.workKind, caseSessionMcp.implemented).includes(scope.toolName)) throw Object.assign(new Error('Tool not available'), { toolNotInSession: true });
      return result;
    }, { lockWaitMs: 5000 });
  } catch (error) {
    if (['CASE_SESSION_ENDED', 'CASE_SESSION_EXPIRED'].includes(error.code)) await settleCaseSessionState(session);
    throw error;
  }
}

async function sendCaseToolMessage(ctx, { id, type, intent, text, payload = null, inReplyTo = null }, caseOptions = {}) {
  await assertLiveToolSession(ctx.session);
  const at = store.now(), session = ctx.session;
  if (session.workKind === 'human_instruction') {
    const reply = { id, kind: 'humanInstructionReply', inboxId: session.inboxId, caseId: session.caseId,
      senderType: 'agent', senderAgentId: session.agentId, senderInboxId: session.inboxId, recipientInboxId: session.inboxId,
      recipientHumanId: ctx.workMessage.senderHumanId, from: { agentId: ctx.agent.id, address: ctx.agent.address },
      inReplyTo: ctx.workMessage.id, type: 'message', text, status: 'delivered', createdAt: at, deliveredAt: at, updatedAt: at };
    await store.putJsonBatch([...(await humanInstructionReplyDocuments(store, ctx.workMessage, reply, at)), document(messagePath(session.inboxId, id), reply)]);
    await ctx.writeAudit('agent.instruction_replied', { messageId: id, caseId: session.caseId, inReplyTo: ctx.workMessage.id, senderAgentId: session.agentId }, at);
    return reply;
  }
  const recipient = await store.getJson(path.join('inboxes', session.counterpartyInboxId, 'agents', `${session.counterpartyAgentId}.json`));
  if (!recipient || recipient.address !== session.counterparty.address) throw caseSessionErrors.ended('work_ineligible');
  const protocol = createProtocolMessage({ messageId: id, conversationId: session.caseId, causationId: inReplyTo,
    from: { agentId: ctx.agent.id, address: ctx.agent.address }, to: [{ agentId: recipient.id, address: recipient.address }], intent, text,
    proposal: payload?.proposal || null, createdAt: at });
  const message = { id, ...protocol, caseId: session.caseId, senderInboxId: session.inboxId, recipientInboxId: session.counterpartyInboxId,
    senderType: 'agent', senderAgentId: ctx.agent.id, recipientAgentId: recipient.id, recipientEmail: recipient.address, transport: 'native', type, text, payload,
    requestHash: semanticDigest({ id, type, intent, text, payload, inReplyTo }), createdAt: at, queuedAt: at, status: 'queued' };
  const inbox = await store.getJson(path.join('inboxes', session.inboxId, 'inbox.json'));
  if (type === 'decision' && intent === 'accept') caseOptions.scopedAccept = true;
  if (type === 'decision' && intent === 'reject') caseOptions.scopedReject = true;
  return enqueueNativeMessage(message, inbox, session.counterpartyInboxId, 'message.queued', ctx.writeAudit, null, caseOptions);
}

async function evaluateCaseToolAuthority(ctx, action, proposal, option, result, id) {
  const requestedAction = action === 'accept_proposal' ? 'proposal.accept' : 'case.complete';
  const evaluated = await evaluateServerPolicy(ctx.session.inboxId, ctx.agent, ctx.caseRecord, { requestedAction,
    actionPayload: proposal ? { proposalId: proposal.id, optionId: option.id } : { result } }, { id });
  const at = store.now();
  const evaluation = policyEvaluationFromInput({ id, requestedAction, decision: evaluated.decision, matchedPolicyId: evaluated.matchedPolicyId,
    grantType: 'oneTime', expiresAt: evaluated.expiresAt, reasonCode: evaluated.reasonCode }, ctx.agent.id, at);
  await saveCase(ctx.session.inboxId, addPolicyEvaluation(ctx.caseRecord, evaluation, { at }));
  await store.putJson(policyBindingPath(ctx.session.inboxId, id), evaluated.binding);
  await ctx.writeAudit('policy.evaluated', { caseId: ctx.session.caseId, policyEvaluationId: id, requestedAction, decision: evaluation.decision, reasonCode: evaluation.reasonCode }, at);
  return evaluation;
}

async function authorizeCaseTool(ctx, authority, requestedAction, actionPayload, proposal, option, executionId) {
  try {
    const authorization = await validatedPolicyBinding(ctx.session.inboxId, ctx.caseRecord, ctx.agent, authority.id, {
      requestedAction, actionPayload, proposalId: proposal?.id, optionId: option?.id, executionId, writeAudit: ctx.writeAudit });
    if (proposal) {
      const result = acceptProposal(ctx.caseRecord, proposal.id, option.id, { ...authority, decision: 'allow' }, { actor: ctx.agent.id,
        idempotencyKey: executionId, actionId: executionId, externalRefs: { policyEvaluationId: authority.id, sourceInboxId: ctx.session.inboxId }, at: store.now() });
      await saveCase(ctx.session.inboxId, result.case);
      await ctx.writeAudit('proposal.accept_attempted', { caseId: ctx.session.caseId, proposalId: proposal.id, optionId: option.id, actor: ctx.agent.id, outcome: result.action.outcome });
    }
    return authorization;
  } catch (error) {
    throw authorityToolError(error) || error;
  }
}

async function requestCaseToolHuman(ctx, authority, question, id) {
  const record = { id, inboxId: ctx.session.inboxId, agentId: ctx.agent.id, caseId: ctx.session.caseId, policyEvaluationId: authority.id,
    counterpartyAgentId: ctx.session.counterpartyAgentId, counterpartyInboxId: ctx.session.counterpartyInboxId, counterpartyAddress: ctx.session.counterparty.address,
    question, status: 'pending', createdAt: store.now(), expiresAt: authority.expiresAt };
  await store.putJson(humanRequestPath(ctx.session.inboxId, id), record);
  await ctx.writeAudit('case.human_decision_requested', { caseId: record.caseId, agentId: record.agentId, requestId: id, policyEvaluationId: authority.id, question });
  return record;
}

async function resolveCaseHumanRequest(request, outcome, humanId, value, writeAudit) {
  const at = store.now();
  const ended = { ...request, status: outcome, resolvedAt: at, resolvedByHumanId: humanId || null };
  await store.putJson(humanRequestPath(request.inboxId, request.id), ended);
  await writeAudit('case.human_decision_resolved', { caseId: request.caseId, agentId: request.agentId, requestId: request.id, outcome }, at);
  if (['completed', 'failed', 'expired', 'revoked'].includes(value.state)) return;
  const id = `msg_human_decision_${hashSecret(request.id).slice(0, 32)}`;
  if (await store.getJson(messagePath(request.inboxId, id))) return;
  if (request.kind === 'gateway_reply') {
    const claim = await store.getJson(workClaimPath(request.inboxId, request.workId));
    if (claim?.heldForOwnerRequest === request.id && ['approved', 'declined', 'expired'].includes(outcome)) await store.putJson(workClaimPath(request.inboxId, request.workId), { ...claim, heldForOwnerRequest: null, reofferWithoutAttempt: true, updatedAt: at });
    if (['approved', 'declined', 'expired'].includes(outcome)) await writeAudit('work.available', { agentId: request.agentId, reason: 'human_decision', caseId: request.caseId }, at);
    return;
  }
  const evaluation = value.policyEvaluations.find(e => e.id === request.policyEvaluationId);
  const message = humanDecisionWorkMessage({ id, request, outcome, humanId, requestedAction: evaluation?.requestedAction, at });
  await store.putJson(messagePath(request.inboxId, id), message);
  await writeAudit('work.available', { agentId: request.agentId, reason: 'human_decision', caseId: request.caseId }, at);
}

async function reconcileCaseHumanRequests(inboxId, caseId, writeAudit) {
  const value = await getCase(inboxId, caseId);
  if (!value) return;
  const closed = ['completed', 'failed', 'expired', 'revoked'].includes(value.state);
  for (const request of await store.listJson(humanRequestDir(inboxId))) {
    if (request.caseId === caseId && request.status === 'pending' && (closed || request.expiresAt <= store.now())) await resolveCaseHumanRequest(request, 'expired', null, value, writeAudit);
  }
}

async function cleanupCaseHumanRequests() {
  if (!caseSessions.enabled) return;
  const agents = await store.listJson(path.join('directory', 'agents'));
  for (const inboxId of new Set(agents.map(a => a.inboxId).filter(Boolean))) {
    const requests = await store.listJson(humanRequestDir(inboxId));
    for (const caseId of new Set(requests.filter(r => r.status === 'pending').map(r => r.caseId))) {
      await withCaseMutation(inboxId, caseId, writeAudit => reconcileCaseHumanRequests(inboxId, caseId, writeAudit), { allowPaused: true });
    }
  }
}

async function shareCaseToolAsset(ctx, asset) {
  await assertLiveToolSession(ctx.session);
  asset = await store.getJson(objectMetadataPath(asset.id));
  if (!asset || asset.caseId !== ctx.session.caseId || asset.createdByAgentId !== ctx.agent.id || asset.workspaceId !== ctx.session.inboxId) throw caseToolError('ASSET_NOT_SHAREABLE');
  if (asset.state !== 'clean') throw caseToolError('ASSET_NOT_CLEAN');
  if (!await assetPair(asset, ctx.session.counterpartyAgentId, ctx.session.counterpartyInboxId) || await assetRelationshipBlocked(asset, ctx.session.counterpartyAgentId, ctx.session.counterpartyInboxId)) throw caseToolError('REF_NOT_FOUND');
  const location = assetGrantPath(ctx.session.counterpartyInboxId, asset.id);
  if (await store.getJson(location)) return true;
  const grant = { id: `grant_${hashSecret(`${asset.id}:${asset.caseId}:${ctx.session.counterpartyAgentId}`).slice(0, 40)}`, schemaVersion: '1.0', assetId: asset.id, caseId: asset.caseId,
    ownerInboxId: ctx.session.inboxId, ownerAgentId: ctx.agent.id, recipientInboxId: ctx.session.counterpartyInboxId, recipientAgentId: ctx.session.counterpartyAgentId,
    grantedByAgentId: ctx.agent.id, createdAt: store.now() };
  await store.putJson(location, grant);
  await ctx.writeAudit('asset.granted', { assetId: asset.id, caseId: asset.caseId, grantId: grant.id, recipientAgentId: grant.recipientAgentId, recipientInboxId: grant.recipientInboxId, actorAgentId: ctx.agent.id });
  return false;
}
async function readCaseToolContent(ctx, asset) {
  const { bytes } = await objectStorage.readCleanObject(asset.id);
  await assertLiveToolSession(ctx.session);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
async function completeCaseTool(ctx, result, authority, evidence, id) {
  let humanDecision = caseToolCompletionApproval(ctx.caseRecord, ctx.agent.id);
  if (authority) {
    await authorizeCaseTool(ctx, authority, 'case.complete', { result }, null, null, id);
    humanDecision = [...ctx.caseRecord.events].reverse().find(e => e.type === 'humanAction' && e.payload?.action?.actionKey === 'approveOnce' && e.payload.action.externalRefs?.policyEvaluationId === authority.id)?.payload.action || humanDecision;
  }
  if (caseToolCompletionNeedsHuman(ctx.caseRecord, ctx.agent.id) && !humanDecision) throw caseToolError(authority ? 'AUTHORITY_PENDING' : 'AUTHORITY_REQUIRED');
  if (ctx.humanRequests.some(r => r.status === 'pending')) throw caseToolError('AUTHORITY_PENDING');
  const humanApproval = humanDecision ? 'approved' : 'not_required';
  await sendCaseToolMessage(ctx, { id, type: 'completion', intent: 'receipt', text: result,
    payload: { completion: { result, evidence: evidence.map(a => a.id), humanApproval } } }, { scopedCompletion: { humanDecision, evidenceRefs: evidence.map(a => a.id) } });
  await ctx.writeAudit('case.completed', { caseId: ctx.session.caseId, receiptId: `receipt_${id}` });
  const binding = await store.getJson(caseBindingPath(ctx.session.caseId));
  for (const inboxId of binding?.inboxIds || [ctx.session.inboxId]) await reconcileCaseHumanRequests(inboxId, ctx.session.caseId, (type, data, at) => ctx.writeAudit(type, data, at, inboxId));
  return { humanApproval };
}

// §6.2 steps 3–5 (and §8 with endIfUsable). A recorded end always wins. Otherwise expiry, then the
// first holding condition, is recorded under the work's locks, and the session as recorded is returned.
async function settleCaseSessionState(session, { endIfUsable = null } = {}) {
  if (session.endedReason) return session;
  const now = store.now();
  if (new Date(session.expiresAt) > new Date(now) && !endIfUsable
    && !firstCondition(sessionConditions(session, await caseSessionFacts(session), now))) return session;
  return withCaseSessionLock(session, async writeAudit => {
    const current = await caseSessions.get(session.inboxId, session.id);
    if (!current || current.endedReason) return current;
    const at = store.now();
    if (new Date(current.expiresAt) <= new Date(at)) return caseSessions.recordEnd(current, 'expired', at, writeAudit);
    const facts = await caseSessionFacts(current);
    const reason = firstCondition(sessionConditions(current, facts, at)) || endIfUsable;
    if (!reason) return current;
    // §7.4: recording work_ineligible also releases the work's live lease without an attempt.
    if (reason === 'work_ineligible' && liveClaim(facts.claim, at)) await store.putJson(workClaimPath(current.inboxId, current.workId), releasedClaim(facts.claim, at));
    return caseSessions.recordEnd(current, reason, at, writeAudit);
  });
}

// §6.1–§6.2: /mcp with a session token. Steps 1–5 answer at the HTTP level; the a3 envelope
// carries the code.
async function handleCaseSessionMcp(req, res, url) {
  if (!consumeRateLimit(req, res, url.pathname)) throw codedError(429, 'RATE_LIMITED', 'Too many requests. Retry after the indicated delay.', { retryAfterSeconds: Number(res.getHeader('retry-after')) || 1 });
  const unrecognized = () => {
    res.setHeader('www-authenticate', 'Bearer realm="Envoi agent MCP"');
    return credentialError('AUTHENTICATION_REQUIRED');
  };
  if (!caseSessions.enabled) throw unrecognized();
  const found = await caseSessions.byToken(bearerToken(req));
  const epoch = found ? await caseSessions.epoch() : null;
  if (!found || !epoch || new Date(found.createdAt) < new Date(epoch)) throw unrecognized();
  const session = await settleCaseSessionState(found);
  if (!session) throw unrecognized();
  if (session.endedReason) {
    res.setHeader('www-authenticate', 'Bearer realm="Envoi agent MCP", error="invalid_token"');
    throw session.endedReason === 'expired' ? caseSessionErrors.expired() : caseSessionErrors.ended(session.endedReason);
  }
  // §6.4: the session's tools, less any the agent's current permissions no longer allow.
  const agent = await store.getJson(path.join('inboxes', session.inboxId, 'agents', `${session.agentId}.json`));
  if (agent && await monadAccess.active(session.inboxId)) {
    req[monadRequest] = {
      requestId: crypto.randomUUID(), inboxId: session.inboxId, agentId: session.agentId,
      method: req.method, pathname: url.pathname,
      permissionFingerprint: commitment('permission', permissionSnapshot(session.inboxId, agent))
    };
    try { await monadPermissions.ensurePermission(session.inboxId, agent); }
    catch { throw codedError(503, 'MONAD_PERMISSION_UNAVAILABLE', 'The current agent permission could not be verified on Monad.'); }
  }
  const permitted = new Set(allowedCaseTools(agent?.permissions, session.workKind, caseSessionMcp.implemented));
  const scope = { sessionId: session.id, agentId: session.agentId, inboxId: session.inboxId, workId: session.workId, workKind: session.workKind, caseId: session.caseId, counterparty: session.counterparty };
  return caseSessionMcp.handle(req, res, { effectiveTools: session.allowedTools.filter(name => permitted.has(name)), scope,
    onPermissionDenied: () => { req[monadPermissionDenied] = true; } });
}

// §3 and §8. Credential and pause checks have already run (rows 2–5).
async function handleCaseSessionRoute(req, res, route) {
  res.setHeader('cache-control', 'no-store');
  const identity = await getAgentWorkIdentity(req);
  if (!identity) throw credentialError('AUTHENTICATION_REQUIRED');
  const ending = Boolean(route[2]);
  let input;
  try { input = await body(req, 4096); }
  catch (error) { if ([400, 413].includes(error.statusCode)) throw caseSessionErrors.requestInvalid(); throw error; }
  const fields = ending ? ['leaseToken', 'sessionId'] : ['leaseToken'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== fields.length || !fields.every(field => Object.hasOwn(input, field))
    || !validLeaseToken(input.leaseToken) || ending && !validCaseSessionId(input.sessionId)) throw caseSessionErrors.requestInvalid();
  let workId = null;
  try { workId = assertSafeIdentifier(decodeURIComponent(route[1]), 'workId'); } catch { workId = null; }
  const leaseTokenHash = hashSecret(input.leaseToken);
  return ending ? endCaseSession(res, identity, workId, input.sessionId, leaseTokenHash) : mintCaseSession(req, res, identity, workId, leaseTokenHash);
}

async function mintCaseSession(req, res, identity, workId, leaseTokenHash) {
  if (!workId) throw caseSessionErrors.workNotFound();
  const requested = await store.getJson(messagePath(identity.inboxId, workId));
  const requestedCaseId = typeof requested?.caseId === 'string' ? assertSafeIdentifier(requested.caseId, 'caseId') : null;
  const binding = requestedCaseId ? await store.getJson(caseBindingPath(requestedCaseId)) : null;
  const related = [...new Set([requested?.senderInboxId, requested?.counterpartyInboxId, ...(binding?.inboxIds || [])].filter(id => id && id !== identity.inboxId))];
  const outcome = await withInboxMutation(identity.inboxId, async writeAudit => {
    const current = await getAgentWorkIdentity(req);
    if (!current || current.inboxId !== identity.inboxId || current.agent.id !== identity.agent.id || current.familyId !== identity.familyId) {
      throw (await resolveAgentCredential(req)).error || credentialError('AUTHENTICATION_REQUIRED');
    }
    if (current.paused) throw agentPausedError();
    const message = await store.getJson(messagePath(identity.inboxId, workId));
    const workKind = workKindOf(message, isHumanInstruction);
    if (!workKind || !requestedCaseId || message.recipientInboxId !== identity.inboxId || message.recipientAgentId !== identity.agent.id || message.caseId !== requestedCaseId) throw caseSessionErrors.workNotFound();
    const currentBinding = await store.getJson(caseBindingPath(requestedCaseId));
    if (currentBinding?.inboxIds?.some(id => id !== identity.inboxId && !related.includes(id))) throw Object.assign(new Error('Case participants changed while acquiring the mutation lock; retry'), { statusCode: 409 });
    await assertCaseProgressAllowed(identity.inboxId, requestedCaseId);
    const at = store.now();
    const claimPath = workClaimPath(identity.inboxId, workId);
    const claim = await store.getJson(claimPath);
    const ineligible = await workIneligibility(message, current);
    if (ineligible) {
      // Row 9 and §7.4: this host's live lease is released without an attempt. Returned, not
      // thrown, so the release commits with the transaction.
      if (claim?.credentialFamilyId === identity.familyId && liveClaim(claim, at)) await store.putJson(claimPath, releasedClaim(claim, at));
      await caseSessions.endForWork(identity.inboxId, workId, 'work_ineligible', at, writeAudit);
      return { error: caseSessionErrors.notEligible(ineligible) };
    }
    const stale = leaseStaleReason(claim, identity.familyId, leaseTokenHash, at);
    if (stale) return { error: caseSessionErrors.leaseStale(stale) };
    // Row 11: the previous session for this work ends, superseded if it was still usable.
    const pointer = await caseSessions.pointer(identity.inboxId, workId);
    const previous = pointer ? await caseSessions.get(identity.inboxId, pointer.sessionId) : null;
    if (previous && !previous.endedReason) {
      await caseSessions.recordEnd(previous, firstCondition(sessionConditions(previous, await caseSessionFacts(previous), at)) || 'superseded', at, writeAudit);
    }
    const installation = await installations.forFamily(identity.inboxId, current.agent, identity.familyId);
    if (!installation) throw credentialError('CREDENTIAL_REVOKED');
    let counterparty = { kind: 'human' };
    if (workKind === 'agent_message') {
      const sender = await store.getJson(path.join('inboxes', message.senderInboxId, 'agents', `${message.senderAgentId}.json`));
      counterparty = { kind: 'agent', address: sender.address };
    }
    if (workKind === 'human_decision') counterparty = { kind: 'agent', address: message.counterpartyAddress };
    const created = await caseSessions.create({
      inboxId: identity.inboxId, agentId: identity.agent.id, familyId: identity.familyId, installationId: installation.id,
      workId, workKind, caseId: requestedCaseId, fence: claim.fence, leaseTokenHash, counterparty,
      allowedTools: allowedCaseTools(current.agent.permissions, workKind, caseSessionMcp.implemented)
    }, at, writeAudit);
    return { ...created, leaseExpiresAt: claim.leaseExpiresAt };
  }, related, requestedCaseId ? [caseMutationKey(requestedCaseId)] : []);
  if (outcome.error) throw outcome.error;
  const { session, token, leaseExpiresAt } = outcome;
  return json(res, 201, {
    session: {
      id: session.id, token, tokenType: 'Bearer', status: 'active',
      transport: { kind: 'mcp_streamable_http', url: `${publicBaseUrl(req)}/mcp` },
      agentId: session.agentId, installationId: session.installationId, workId: session.workId, workKind: session.workKind,
      caseId: session.caseId, fence: session.fence, counterparty: session.counterparty, allowedTools: session.allowedTools,
      createdAt: session.createdAt, expiresAt: session.expiresAt
    },
    lease: { workId: session.workId, leaseExpiresAt }
  });
}

// §8: only the host that minted the session can end it, and ending twice repeats the first end.
async function endCaseSession(res, identity, workId, sessionId, leaseTokenHash) {
  const found = workId ? await caseSessions.get(identity.inboxId, sessionId) : null;
  const epoch = found ? await caseSessions.epoch() : null;
  if (!found || found.agentId !== identity.agent.id || found.familyId !== identity.familyId || found.workId !== workId
    || found.leaseTokenHash !== leaseTokenHash || !epoch || new Date(found.createdAt) < new Date(epoch)) throw caseSessionErrors.notFound();
  const ended = await settleCaseSessionState(found, { endIfUsable: 'ended_by_host' });
  if (!ended) throw caseSessionErrors.notFound();
  return json(res, 200, { session: publicSessionEnd(ended) });
}

// §7.4: pausing or revoking a case releases every live lease on its work without an attempt, in
// every bound inbox, and ends those sessions (case_controlled). Runs under the case's locks.
async function releaseCaseWork(inboxId, caseId, at, writeAudit) {
  if (!caseSessions.enabled) return;
  const binding = await store.getJson(caseBindingPath(caseId));
  for (const participantInboxId of binding?.inboxIds?.length ? binding.inboxIds : [inboxId]) {
    const released = [];
    for (const claim of await store.listJson(path.join('inboxes', participantInboxId, 'work-claims'))) {
      if (!liveClaim(claim, at)) continue;
      const message = await store.getJson(messagePath(participantInboxId, claim.workId));
      if (message?.caseId === caseId) released.push(document(workClaimPath(participantInboxId, claim.workId), releasedClaim(claim, at)));
    }
    await store.putJsonBatch(released);
    if (httpWakeEnabled) for (const agentId of new Set(released.map(entry => entry.value.agentId))) await httpWake.trigger({ inboxId: participantInboxId, agentId, type: 'wake.control_changed', reason: 'case_controlled', cursor: await newestEventCursor(participantInboxId) });
    await caseSessions.endForCase(participantInboxId, caseId, 'case_controlled', at, writeAudit);
  }
}

async function handleHttpWakeRoute(req, res, url) {
  if (url.pathname === '/.well-known/envoi-wake-keys.json') {
    if (req.method !== 'GET') return fail(res, 405, 'Method not allowed');
    const keys = httpWake.keys();
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300, s-maxage=0' });
    return res.end(JSON.stringify(keys));
  }
  res.setHeader('cache-control', 'no-store');
  const host = url.pathname.match(/^\/api\/agent\/wake-subscriptions(?:\/([^/]+)\/(activate|end))?$/);
  const ownerRoute = url.pathname.match(/^\/api\/inboxes\/([^/]+)\/agents\/([^/]+)\/wake-subscriptions(?:\/([^/]+)\/(revoke))?$/);
  if (!host && !ownerRoute) throw codedError(404, 'WAKE_SUBSCRIPTION_NOT_FOUND', 'Wake subscription not found.');
  if (ownerRoute) {
    const human = await auth.getHuman(req), inbox = await store.getJson(path.join('inboxes', assertSafeIdentifier(ownerRoute[1], 'inboxId'), 'inbox.json'));
    if (!human || !inbox || !await canManageInbox(human, inbox, { maxAgeMs: 0 }) || inbox.ownerAgentId !== ownerRoute[2]) throw codedError(403, 'REQUEST_FAILED', 'Workspace administrator required.');
  }
  if (req.method !== 'POST' && req.method !== 'GET' || (host?.[2] || ownerRoute?.[4]) && req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  let input;
  if (req.method === 'POST') {
    try { input = await body(req, 65536); } catch { throw codedError(400, 'WAKE_SUBSCRIPTION_INVALID', 'Invalid wake subscription request.'); }
    const fields = host ? host[2] === 'activate' ? ['challenge'] : host[2] === 'end' ? [] : ['url'] : [];
    if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).length !== fields.length || fields.some(key => !Object.hasOwn(input, key))
      || fields.some(key => typeof input[key] !== 'string') || fields.includes('url') && (input.url.length < 1 || Array.from(input.url).length > 8192)
      || fields.includes('challenge') && !/^envoi_wake_challenge_[A-Za-z0-9_-]{43}$/.test(input.challenge)) throw codedError(400, 'WAKE_SUBSCRIPTION_INVALID', 'Invalid wake subscription request.');
  }
  const initial = host ? await getAgentWorkIdentity(req) : null;
  if (host && !initial) throw credentialError('AUTHENTICATION_REQUIRED');
  const inboxId = host ? initial.inboxId : assertSafeIdentifier(ownerRoute[1], 'inboxId');
  const result = await withInboxMutation(inboxId, async () => {
    let identity;
    if (host) {
      const current = await getAgentWorkIdentity(req);
      if (!current || current.inboxId !== initial.inboxId || current.agent.id !== initial.agent.id || current.familyId !== initial.familyId) throw credentialError('CREDENTIAL_REVOKED');
      const installation = await installations.forFamily(current.inboxId, current.agent, current.familyId);
      if (!installation) throw credentialError('CREDENTIAL_REVOKED');
      identity = { inboxId: current.inboxId, agentId: current.agent.id, familyId: current.familyId, installationId: installation.id };
    } else {
      const human = await auth.getHuman(req), inbox = await store.getJson(path.join('inboxes', inboxId, 'inbox.json'));
      if (!human || !inbox || !await canManageInbox(human, inbox, { maxAgeMs: 0 }) || inbox.ownerAgentId !== ownerRoute[2]) throw codedError(403, 'REQUEST_FAILED', 'Workspace administrator required.');
    }
    // Expected refusals follow durable create counters/derived ending writes. Commit
    // them, then surface the typed error outside the transaction.
    try {
      const value = host ? req.method === 'GET' ? await httpWake.list(identity)
        : host[2] === 'activate' ? await httpWake.activate(identity, host[1], input)
        : host[2] === 'end' ? await httpWake.end(identity, host[1]) : await httpWake.create(identity, input)
        : ownerRoute[4] ? await httpWake.ownerRevoke(inboxId, ownerRoute[2], ownerRoute[3]) : await httpWake.ownerList(inboxId, ownerRoute[2]);
      return { value };
    } catch (error) {
      if ([400, 404, 409, 429].includes(error.statusCode)) return { error };
      throw error;
    }
  });
  if (result.error) {
    const error = result.error;
    if (error.retryAfter) res.setHeader('retry-after', String(error.retryAfter));
    throw codedError(error.statusCode, error.code, 'Wake subscription request could not be completed.', { ...(error.reason ? { reason: error.reason } : {}), ...(error.retryAfter ? { retryAfterSeconds: error.retryAfter } : {}) });
  }
  return json(res, host && req.method === 'POST' && !host[2] ? 201 : 200, result.value);
}

// Gateway-only browser repair: an attributable owner claim can reattach a live
// gateway installation without minting credentials or replacing its notification ledger.
// No ordinary registration/activation route can invoke this internal adapter callback.
async function reattachGatewayRegistration(rawToken, registrationId, activationId, binding, confirmed) {
  const registration = await registrations.registrationForToken(rawToken, registrationId);
  if (!browserPollAvailable(onboardingFlags) || !registration.providerBrowserPoll || registration.target?.kind !== 'existing_agent'
    || registration.approverHumanId !== confirmed.humanId) throw codedError(403, 'GATEWAY_SCOPE_DENIED', 'Browser repair is not authorized.');
  return withInboxMutation(binding.inboxId, async writeAudit => {
    const current = await registrations.getRegistration(registrationId);
    const installation = await store.getJson(installationPath(binding.inboxId, binding.agentId, binding.installationId));
    const family = await store.getJson(agentCredentialFamilyPath(binding.inboxId, binding.agentId, binding.credentialFamilyId));
    const human = await store.getJson(path.join('humans', `${confirmed.humanId}.json`));
    const inbox = await store.getJson(path.join('inboxes', binding.inboxId, 'inbox.json'));
    if (!current?.providerBrowserPoll || current.approverHumanId !== confirmed.humanId || current.target.agentId !== binding.agentId
      || current.target.agentInboxId !== binding.inboxId || current.target.replacesInstallationId !== binding.installationId
      || !installation || installation.deliveryMode !== 'poll' || installation.credentialFamilyId !== binding.credentialFamilyId
      || !family || family.revokedAt || new Date(family.refreshExpiresAt) <= new Date()
      || !human || !inbox || !await canManageInbox(human, inbox, { maxAgeMs: 0 })) throw codedError(403, 'GATEWAY_SCOPE_DENIED', 'Browser repair is no longer authorized.');
    if (current.status === 'activated') {
      if (!current.gatewayReattachment || current.activationIdHash !== hashSecret(activationId) || recoveryWindowOver(current, new Date())) throw registrations.recoveryExpired();
      return;
    }
    if (derivedStatus(current, new Date()) !== 'approved' || !await activationRechecksPass(current)) throw registrationEnded('withdrawn');
    const at = store.now();
    await store.putJson(registrationPath(current.id), { ...current, status: 'activated', gatewayReattachment: true,
      activatedAt: at, activationIdHash: hashSecret(activationId), installationId: binding.installationId,
      agentId: binding.agentId, agentInboxId: binding.inboxId, credentialFamilyId: binding.credentialFamilyId });
    await writeAudit('agent.gateway_pairing_created', { agentId: binding.agentId, installationId: binding.installationId }, at);
  }, [], [registrationLockKey(registrationId), `gateway-installation:${binding.installationId}`]);
}

async function claimCanonicalAgentWork(identity, currentIdentity, input, claimCandidates, writeAudit, { leaseMs = agentWorkLeaseMs } = {}) {
  const messages = claimCandidates
    .filter(message => (isHumanInstruction(message) || isHumanDecision(message) || message.senderInboxId && message.senderAgentId) && message.recipientInboxId === identity.inboxId && message.recipientAgentId === identity.agent.id && ['delivered', 'acknowledged'].includes(message.status))
    .sort((left, right) => String(left.deliveredAt || left.createdAt).localeCompare(String(right.deliveredAt || right.createdAt)) || String(left.id).localeCompare(String(right.id)));
  let nextAvailable = null;
  const noteAvailable = (claim, at) => {
    if ((claim.reofferWithoutAttempt === true || agentWorkAttempts(claim) < agentWorkMaxAttempts) && (!nextAvailable || at < nextAvailable)) nextAvailable = at;
  };
  for (const candidate of messages) {
    const message = await store.getJson(messagePath(identity.inboxId, candidate.id));
    if (!message || !['delivered', 'acknowledged'].includes(message.status) || message.senderInboxId !== candidate.senderInboxId
      || message.recipientInboxId !== identity.inboxId || message.recipientAgentId !== identity.agent.id
      || isHumanInstruction(message) && input.acceptHumanInstructions !== true) continue;
    const caseRecord = await getCase(identity.inboxId, message.caseId);
    if (caseRecord?.state === 'paused' || caseRecord?.state === 'revoked') continue;
    if (isHumanInstruction(message)) {
      try { await assertHumanInstructionAuthority(message, currentIdentity); }
      catch (error) { if ([400, 403, 404, 409, 422].includes(error.statusCode)) continue; throw error; }
    } else if (isHumanDecision(message)) {
      if (await workIneligibility(message, currentIdentity)) continue;
    } else {
      const senderAgent = await store.getJson(path.join('inboxes', message.senderInboxId, 'agents', `${message.senderAgentId}.json`));
      if (!senderAgent || !canAct(senderAgent, 'send_agent_messages')) continue;
      const senderContact = await store.getJson(path.join('inboxes', message.senderInboxId, 'contacts', `${identity.agent.id}.json`));
      const recipientContact = await store.getJson(path.join('inboxes', identity.inboxId, 'contacts', `${message.senderAgentId}.json`));
      if (senderContact?.blocked || recipientContact?.blocked) continue;
    }
    const claimPath = workClaimPath(identity.inboxId, message.id);
    const currentClaim = await store.getJson(claimPath);
    if (currentClaim?.heldForOwnerRequest) {
      const ownerRequest = await store.getJson(humanRequestPath(identity.inboxId, currentClaim.heldForOwnerRequest));
      if (!ownerRequest || !['approved', 'declined', 'expired'].includes(ownerRequest.status)) continue;
    }
    if (currentClaim && ['completed', 'failed'].includes(currentClaim.status)) continue;
    if (currentClaim && ['claimed', 'acknowledged'].includes(currentClaim.status) && new Date(currentClaim.leaseExpiresAt) > new Date()) {
      noteAvailable(currentClaim, currentClaim.leaseExpiresAt);
      continue;
    }
    const now = store.now();
    if (currentClaim?.status === 'retryable' && new Date(currentClaim.retryAt) > new Date(now)) {
      noteAvailable(currentClaim, currentClaim.retryAt);
      continue;
    }
    const reoffer = currentClaim?.reofferWithoutAttempt === true;
    if (currentClaim && !reoffer && agentWorkAttempts(currentClaim) >= agentWorkMaxAttempts) {
      await failAgentWorkPermanently(message, currentClaim, 'MAX_ATTEMPTS_EXCEEDED', now, writeAudit);
      continue;
    }
    const leaseToken = crypto.randomBytes(32).toString('base64url');
    const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
    const claim = {
      workId: message.id,
      messageId: message.id,
      agentId: identity.agent.id,
      inboxId: identity.inboxId,
      credentialFamilyId: identity.familyId,
      fence: Number(currentClaim?.fence || 0) + 1,
      attempts: agentWorkAttempts(currentClaim) + (reoffer ? 0 : 1),
      leaseTokenHash: hashSecret(leaseToken),
      leaseExpiresAt,
      retryAt: null,
      status: 'claimed',
      createdAt: currentClaim?.createdAt || now,
      updatedAt: now
    };
    await store.putJson(claimPath, claim);
    await caseSessions.endForWork(identity.inboxId, message.id, 'lease_lost', now, writeAudit);
    await writeAudit('agent.work_claimed', { workId: message.id, agentId: identity.agent.id, fence: claim.fence, attempts: claim.attempts, credentialFamilyId: claim.credentialFamilyId }, now);
    return { status: 200, payload: { work: { workId: message.id, message, leaseToken, leaseExpiresAt }, state: 'claimed' } };
  }
  const idle = { work: null, state: 'idle' };
  if (nextAvailable) {
    // Relative delay too, so a client with a skewed clock schedules correctly.
    const inMs = Math.max(0, Date.parse(nextAvailable) - Date.now());
    Object.assign(idle, { nextAvailableAt: new Date(Date.now() + inMs).toISOString(), nextAvailableInMs: inMs });
  }
  return { status: 200, payload: idle };
}

async function settleCanonicalAgentWork({ identity, workId, currentMessage, claim, action, idempotencyPath = null, requestDigest = null, now = store.now() }, writeAudit) {
  const claimPath = workClaimPath(identity.inboxId, workId);
  const state = action === 'acknowledge' ? 'acknowledged' : 'processed';
  if (action === 'acknowledge') {
    const replay = replayResponse(await store.getJson(idempotencyPath), { principalId: identity.agent.id, requestDigest });
    if (replay) return { status: 200, payload: replay };
  }
  if (currentMessage.status === 'processed' || claim.status === 'completed') {
    throw settlementError(409, 'Work has already been processed', 'WORK_LEASE_STALE', 'settled');
  }
  const receiptId = `delivery_receipt_${currentMessage.id}_${state}`;
  const existingReceipt = await store.getJson(deliveryReceiptPath(identity.inboxId, receiptId));
  if (existingReceipt && action === 'acknowledge' && currentMessage.status === 'acknowledged') {
    const receipt = {
      id: existingReceipt.id,
      type: 'delivery',
      messageId: currentMessage.id,
      ...workSenderFields(currentMessage),
      recipientAgentId: currentMessage.recipientAgentId,
      state: 'acknowledged',
      createdAt: existingReceipt.createdAt
    };
    const response = { workId, status: 'acknowledged', receipt };
    claim.status = 'acknowledged';
    claim.updatedAt = now;
    await store.putJson(claimPath, claim);
    await store.putJson(idempotencyPath, { principalId: identity.agent.id, requestDigest, status: 'completed', response, createdAt: now });
    return { status: 200, payload: response };
  }
  if (existingReceipt) throw settlementError(409, 'Message already has a receipt outside this work fence', 'WORK_LEASE_STALE', 'settled');
  const updated = { ...currentMessage, status: state, [`${state}At`]: now, updatedAt: now };
  const receipt = {
    id: receiptId,
    type: 'delivery',
    messageId: currentMessage.id,
    ...workSenderFields(currentMessage),
    recipientAgentId: currentMessage.recipientAgentId,
    state,
    createdAt: now
  };
  const documents = await workCaseDocuments(currentMessage, updated, state, now);
  for (const targetInboxId of workInboxIds(currentMessage)) {
    const targetInbox = await store.getJson(path.join('inboxes', targetInboxId, 'inbox.json'));
    if (!targetInbox) continue;
    documents.push(document(messagePath(targetInboxId, currentMessage.id), updated), document(deliveryReceiptPath(targetInboxId, receipt.id), receipt));
    await writeAudit(`message.${state}`, { messageId: currentMessage.id, caseId: currentMessage.caseId, ...workSenderFields(currentMessage), recipientAgentId: currentMessage.recipientAgentId }, now, targetInboxId);
  }
  claim.status = state === 'processed' ? 'completed' : 'acknowledged';
  claim.updatedAt = now;
  if (state === 'processed') claim.leaseExpiresAt = null;
  const response = { workId, status: state, receipt };
  await store.putJsonBatch(documents);
  await store.putJson(claimPath, claim);
  if (state === 'processed') await caseSessions.endForWork(identity.inboxId, workId, 'work_settled', now, writeAudit);
  if (idempotencyPath) await store.putJson(idempotencyPath, { principalId: identity.agent.id, requestDigest, status: 'completed', response, createdAt: now });
  return { status: 201, payload: response };
}


// Stage2 invokes the SAME canonical claim/settlement and scoped case services as the
// trusted local host. The adapter never calls HTTP or exposes its private credentials.
const nativeGatewayError = (code, statusCode = 409) => codedError(statusCode, code, 'This work operation is no longer authorized.');
async function gatewayWorkIdentity(binding) {
  const req = { method: 'POST', url: '/api/agent/work/claim', headers: { authorization: `Bearer ${binding.credentials?.access || ''}` } };
  const identity = await getAgentWorkIdentity(req);
  if (!identity || identity.inboxId !== binding.inboxId || identity.agent.id !== binding.agentId || identity.familyId !== binding.credentialFamilyId) throw nativeGatewayError('CREDENTIAL_REVOKED', 401);
  return identity;
}
async function gatewayWorkKeys(binding) {
  const messages = (await store.listJson(path.join('inboxes', binding.inboxId, 'messages'))).filter(message => message.recipientAgentId === binding.agentId);
  const keys = new Set([inboxMutationKey(binding.inboxId), inboxMutationKey(binding.workspaceInboxId || binding.inboxId)]);
  for (const message of messages) {
    if (message.senderInboxId) keys.add(inboxMutationKey(message.senderInboxId));
    if (!message.caseId) continue;
    keys.add(caseMutationKey(message.caseId));
    const current = await store.getJson(caseBindingPath(message.caseId));
    for (const id of current?.inboxIds || []) keys.add(inboxMutationKey(id));
  }
  return [...keys];
}
async function gatewayWorkCurrent(binding, work, requireLease = false) {
  const identity = await gatewayWorkIdentity(binding);
  if (identity.paused) return { identity };
  if (!work) return { identity };
  const message = await store.getJson(messagePath(binding.inboxId, work.workId));
  if (!message || message.recipientAgentId !== binding.agentId || message.recipientInboxId !== binding.inboxId || message.caseId !== work.caseId) throw nativeGatewayError('GATEWAY_SCOPE_DENIED', 403);
  try { await assertCaseProgressAllowed(binding.inboxId, message.caseId); }
  catch (error) { if (error.code === 'CASE_CONTROLLED') throw nativeGatewayError('GATEWAY_SCOPE_DENIED', 403); throw error; }
  if (await workIneligibility(message, identity)) throw nativeGatewayError('GATEWAY_SCOPE_DENIED', 403);
  const claim = await store.getJson(workClaimPath(binding.inboxId, message.id));
  if (requireLease && (!claim || claim.credentialFamilyId !== identity.familyId || claim.fence !== work.fence || claim.leaseTokenHash !== hashSecret(work.leaseToken)
    || !['claimed', 'acknowledged'].includes(claim.status) || Date.parse(claim.leaseExpiresAt) <= Date.now())) throw nativeGatewayError('LEASE_LOST');
  return { identity, message, claim };
}
const gatewayAudit = options => (type, data, at = store.now(), targetInboxId) => options.audit(type, data, at, targetInboxId);
function gatewayDeadline(options) {
  if (!Number.isFinite(options.runDeadline) || Date.now() > options.runDeadline) throw nativeGatewayError('GATEWAY_RUN_EXPIRED');
}
async function gatewayPrivateSession(binding, work, identity, claim, options) {
  let session = await caseSessions.get(binding.inboxId, work.caseSession.id);
  const epoch = await caseSessions.epoch();
  if (session && epoch && session.createdAt < epoch && !session.endedReason) {
    const pointer = await caseSessions.pointer(binding.inboxId, work.workId);
    if (pointer?.sessionId !== session.id || session.workId !== work.workId || session.fence !== claim.fence
      || session.familyId !== identity.familyId || session.leaseTokenHash !== claim.leaseTokenHash) throw nativeGatewayError('LEASE_LOST');
    const conditions = sessionConditions(session, await caseSessionFacts(session), store.now());
    if (firstCondition(conditions)) throw nativeGatewayError('LEASE_LOST');
    gatewayDeadline(options);
    await caseSessions.recordEnd(session, 'superseded', store.now(), gatewayAudit(options));
    const created = await caseSessions.create({ inboxId: binding.inboxId, agentId: binding.agentId, familyId: identity.familyId,
      installationId: binding.installationId, workId: work.workId, workKind: session.workKind, caseId: work.caseId,
      fence: claim.fence, leaseTokenHash: claim.leaseTokenHash, counterparty: session.counterparty,
      allowedTools: allowedCaseTools(identity.agent.permissions, session.workKind, caseSessionMcp.implemented) }, store.now(), gatewayAudit(options));
    session = created.session;
    work.caseSession = { id: session.id };
  }
  if (!session) throw nativeGatewayError('LEASE_LOST');
  try { await assertLiveToolSession(session); }
  catch (error) { if (error.statusCode && error.statusCode < 500) throw nativeGatewayError('LEASE_LOST'); throw error; }
  return session;
}

async function gatewayRelease(binding, work, options) {
  const claim = await store.getJson(workClaimPath(binding.inboxId, work.workId));
  if (!claim || claim.credentialFamilyId !== binding.credentialFamilyId || claim.fence !== work.fence || claim.leaseTokenHash !== hashSecret(work.leaseToken)
    || !['claimed', 'acknowledged'].includes(claim.status)) return;
  const at = store.now();
  await store.putJson(workClaimPath(binding.inboxId, work.workId), { ...claim, status: 'retryable', leaseExpiresAt: null, retryAt: null,
    reofferWithoutAttempt: true, updatedAt: at, ...(options.ownerRequestId ? { heldForOwnerRequest: options.ownerRequestId } : {}) });
  await caseSessions.endForWork(binding.inboxId, work.workId, options.reason === 'paused' ? 'agent_paused' : 'work_settled', at, gatewayAudit(options));
  await options.audit('agent.gateway_work_released', { agentId: binding.agentId, workId: work.workId, reason: options.reason }, at);
}
async function gatewayOwnerRequest(binding, work, ctx, text, actionPayload, options) {
  const id = `policy_eval_gateway_${semanticDigest([binding.installationId, work.workId, work.fence, work.generation, actionPayload]).slice(0, 32)}`;
  const at = store.now(), value = await getCase(binding.inboxId, work.caseId);
  const evaluated = await evaluateServerPolicy(binding.inboxId, ctx.agent, value, { requestedAction: 'message.reply', actionPayload, humanDecisionRequired: true }, { id });
  if (evaluated.decision === 'deny') throw nativeGatewayError('GATEWAY_SCOPE_DENIED', 403);
  const evaluation = policyEvaluationFromInput({ id, requestedAction: 'message.reply', decision: evaluated.decision, matchedPolicyId: evaluated.matchedPolicyId,
    grantType: 'oneTime', expiresAt: evaluated.expiresAt, reasonCode: evaluated.reasonCode }, binding.agentId, at);
  const writeAudit = gatewayAudit(options);
  if (!value.policyEvaluations.some(item => item.id === id)) {
    await saveCase(binding.inboxId, addPolicyEvaluation(value, evaluation, { at }));
    await store.putJson(policyBindingPath(binding.inboxId, id), evaluated.binding);
    await writeAudit('policy.evaluated', { caseId: work.caseId, policyEvaluationId: id, requestedAction: 'message.reply', decision: evaluated.decision }, at);
  }
  const requestId = `request_gateway_${semanticDigest([id, binding.generation]).slice(0, 32)}`;
  const prior = await store.getJson(humanRequestPath(binding.inboxId, requestId));
  if (!prior) {
    const request = await requestCaseToolHuman({ ...ctx, writeAudit }, evaluation, text, requestId);
    await store.putJson(humanRequestPath(binding.inboxId, requestId), { ...request, kind: 'gateway_reply', workId: work.workId,
      installationId: binding.installationId, generation: binding.generation, actionDigest: semanticDigest(actionPayload) });
  }
  await gatewayRelease(binding, work, { ...options, ownerRequestId: requestId, reason: 'owner_required' });
  return { state: 'owner_approval_pending', settled: false, requestId };
}
const gatewayNativeAdapter = {
  ownerInstallations: async human => {
    const result = [];
    for (const organization of await listHumanOrganizations(human.id)) {
      for (const reference of await store.listJson(path.join('organizations', organization.id, 'workspaces'))) {
        const inbox = await store.getJson(path.join('inboxes', reference.inboxId, 'inbox.json'));
        if (!inbox?.ownerAgentId || inbox.status === 'removed' || !await canManageInbox(human, inbox, { maxAgeMs: 0 })) continue;
        const agent = await store.getJson(path.join('inboxes', inbox.id, 'agents', `${inbox.ownerAgentId}.json`));
        if (!agent) continue;
        for (const installation of await installations.list(inbox.id, agent)) {
          if (installation.status === 'active' && installation.deliveryMode === 'poll') result.push({ inboxId: inbox.id,
            agentId: agent.id, installationId: installation.id, address: agent.address, permissions: agent.permissions || [] });
        }
      }
    }
    return result;
  },
  lockKeys: gatewayWorkKeys,
  authorize: async (binding, { work } = {}) => {
    const { identity } = await gatewayWorkCurrent(binding, work);
    return { paused: identity.paused, permissions: identity.agent.permissions, address: identity.agent.address };
  },
  verifyOwnerScope: async (binding, _input, req) => {
    if (!verifyCsrfRequest(req)) throw nativeGatewayError('GATEWAY_CSRF_INVALID', 403);
    const ownerPath = new URL(req.url, 'http://localhost').pathname;
    if (ownerPath !== `/api/inboxes/${binding.inboxId}/agents/${binding.agentId}/installations/${binding.installationId}/gateway-scope`) throw nativeGatewayError('GATEWAY_SCOPE_DENIED', 403);
    const human = await auth.getHuman(req);
    if (!human || human.id !== binding.ownerId) throw nativeGatewayError('AUTHENTICATION_REQUIRED', 401);
  },
  claim: async (binding, options) => store.withTransaction(await gatewayWorkKeys(binding), async () => {
    const identity = await gatewayWorkIdentity(binding);
    if (identity.paused) throw agentPausedError();
    const candidates = (await store.listJson(path.join('inboxes', binding.inboxId, 'messages')))
      .filter(message => !isHumanDecision(message) && !options.excludeWorkIds.includes(message.id));
    gatewayDeadline(options);
    const result = await claimCanonicalAgentWork(identity, identity, { acceptHumanInstructions: true }, candidates, gatewayAudit(options), { leaseMs: options.leaseSeconds * 1000 });
    const work = result.payload.work;
    if (!work) return { retryAfterSeconds: Math.max(1, Math.ceil((result.payload.nextAvailableInMs || 1800000) / 1000)) };
    const message = work.message, claim = await store.getJson(workClaimPath(binding.inboxId, work.workId));
    const workKind = workKindOf(message, isHumanInstruction);
    let counterparty = { kind: 'human' };
    if (workKind === 'agent_message') {
      const other = await store.getJson(path.join('inboxes', message.senderInboxId, 'agents', `${message.senderAgentId}.json`));
      counterparty = { kind: 'agent', address: other.address };
    }
    const created = await caseSessions.create({ inboxId: binding.inboxId, agentId: binding.agentId, familyId: binding.credentialFamilyId,
      installationId: binding.installationId, workId: work.workId, workKind, caseId: message.caseId, fence: claim.fence, leaseTokenHash: claim.leaseTokenHash,
      counterparty, allowedTools: allowedCaseTools(identity.agent.permissions, workKind, caseSessionMcp.implemented) }, store.now(), gatewayAudit(options));
    const ctx = await loadCaseToolContext(created.session);
    const shown = projectCaseSnapshot({ ...ctx, codec: referenceCodec, now: store.now() }, { eventLimit: 10 });
    return { workId: work.workId, caseId: message.caseId, kind: workKind, leaseExpiresAt: work.leaseExpiresAt, leaseToken: work.leaseToken, fence: claim.fence,
      caseSession: { id: created.session.id }, snapshot: { objective: shown.case.objective, status: shown.case.status,
        participants: [{ role: 'self', displayName: identity.agent.name || 'Your agent' }, { role: 'counterparty', displayName: counterparty.kind === 'human' ? 'Your owner' : 'Other agent' }],
        recentEvents: [...shown.recentEvents.map(event => ({ at: event.at, from: event.actor === 'you' ? 'self' : event.actor === 'your_human' ? 'owner' : 'counterparty', summary: event.text || '', truncated: event.truncated })),
          ...(shown.requestedResponse ? [{ at: shown.requestedResponse.receivedAt, from: shown.requestedResponse.from === 'your_human' ? 'owner' : 'counterparty', summary: shown.requestedResponse.text, truncated: shown.requestedResponse.truncated }] : [])].slice(-10),
        assets: shown.assets.map(asset => ({ name: asset.filename, state: asset.scan === 'clean' ? 'clean' : asset.scan === 'blocked' ? 'quarantined' : 'pending_scan' })),
        pendingProposal: shown.proposal ? { summary: JSON.stringify(shown.proposal.options.map(option => option.value)) } : null } };
  }),
  act: async (binding, work, options) => store.withTransaction(await gatewayWorkKeys(binding), async () => {
    const { identity, message, claim } = await gatewayWorkCurrent(binding, work, true);
    if (identity.paused) throw agentPausedError();
    if (options.action === 'defer') { await gatewayRelease(binding, work, { ...options, reason: 'deferred' }); return { state: 'deferred', settled: false }; }
    gatewayDeadline(options);
    const session = await gatewayPrivateSession(binding, work, identity, claim, options);
    const ctx = { ...await loadCaseToolContext(session), writeAudit: gatewayAudit(options) };
    const actionPayload = { text: options.text, caseId: work.caseId, recipient: session.counterparty, generation: binding.generation, workId: work.workId };
    const requests = ctx.humanRequests.filter(request => request.kind === 'gateway_reply' && request.workId === work.workId);
    const approval = requests.find(request => request.status === 'approved' && Date.parse(request.expiresAt) > Date.now() && request.generation === binding.generation && request.actionDigest === semanticDigest(actionPayload));
    const hasPendingDecision = ctx.humanRequests.some(request => request.status === 'pending');
    if (options.action === 'request_owner' || requests.length && !approval || hasPendingDecision) return gatewayOwnerRequest(binding, work, ctx, options.text, actionPayload, options);
    if (approval) {
      try { await validatedPolicyBinding(binding.inboxId, ctx.caseRecord, ctx.agent, approval.policyEvaluationId, { requestedAction: 'message.reply', actionPayload,
        executionId: `gateway_reply_${semanticDigest([work.workId, options.idempotencyKey]).slice(0, 32)}`, writeAudit: ctx.writeAudit }); }
      catch (error) { if (error.statusCode && error.statusCode < 500) throw nativeGatewayError('GATEWAY_SCOPE_DENIED', 403); throw error; }
    }
    else {
      const evaluated = await evaluateServerPolicy(binding.inboxId, ctx.agent, ctx.caseRecord, { requestedAction: 'message.reply', actionPayload });
      if (evaluated.decision === 'deny') throw nativeGatewayError('GATEWAY_SCOPE_DENIED', 403);
      if (evaluated.decision === 'needsHuman') return gatewayOwnerRequest(binding, work, ctx, options.text, actionPayload, options);
    }
    gatewayDeadline(options);
    const id = `msg_gateway_${semanticDigest([binding.installationId, work.workId, options.idempotencyKey]).slice(0, 40)}`;
    const reply = await sendCaseToolMessage(ctx, { id, type: 'message', intent: 'message', text: options.text, inReplyTo: message.id });
    const completed = await settleCanonicalAgentWork({ identity, workId: work.workId, currentMessage: message, claim, action: 'complete' }, ctx.writeAudit);
    await options.audit('agent.gateway_work_replied', { agentId: binding.agentId, workId: work.workId, messageId: reply.id, caseId: work.caseId });
    return { state: 'sent', settled: true, receiptId: completed.payload.receipt.id };
  }),
  renew: async (binding, work, options) => {
    const { identity, claim } = await gatewayWorkCurrent(binding, work, true);
    if (identity.paused) throw agentPausedError();
    gatewayDeadline(options);
    claim.leaseExpiresAt = new Date(Date.now() + options.leaseSeconds * 1000).toISOString(); claim.updatedAt = store.now();
    await store.putJson(workClaimPath(binding.inboxId, work.workId), claim);
    return { leaseExpiresAt: claim.leaseExpiresAt };
  },
  release: gatewayRelease
};

const browserGatewayHttp = createCanonicalBrowserGateway({
  store, flags: onboardingFlags, key: connectorEncryptionKey(), nativeAdapter: gatewayNativeAdapter, registrations, activateRegistration, reattachRegistration: reattachGatewayRegistration, rotateCredentials: rotateAgentCredentials, auth, canManageInbox,
  publicOrigin: req => publicBaseUrl(req), clientIp, familyPath: agentCredentialFamilyPath,
  writeAudit: async (binding, type, data, at = store.now()) => {
    // A canonical receipt can target the other participant's inbox. Gateway custody
    // identifiers belong only in the installation owner's audit history.
    const localInstallation = await store.getJson(installationPath(binding.inboxId, binding.agentId, binding.installationId));
    const custody = localInstallation?.credentialFamilyId === binding.credentialFamilyId
      ? { agentId: binding.agentId, installationId: binding.installationId } : {};
    const record = await auditRecord(binding.inboxId, type, { ...custody, ...data }, at);
    await store.putJson(record.document.path, record.document.value); return { inboxId: binding.inboxId, event: record.event };
  },
  publishAudit: record => publish(record.inboxId, record.event),
  ownerCsrf: req => parseCookies(req.headers.cookie)[csrfCookieName()] || '',
  verifyOwnerCsrf: (req, csrf) => verifyCsrfRequest({ ...req, headers: { ...req.headers, 'x-envoi-csrf': csrf } }),
  pendingAllowed: async (message, binding) => {
    if (isHumanInstruction(message) || message.recipientInboxId !== binding.inboxId) return false;
    const workCase = await getCase(binding.inboxId, message.caseId);
    if (workCase?.state === 'paused' || workCase?.state === 'revoked') return false;
    const sender = await store.getJson(path.join('inboxes', message.senderInboxId, 'agents', `${message.senderAgentId}.json`));
    const sentContact = await store.getJson(path.join('inboxes', message.senderInboxId, 'contacts', `${binding.agentId}.json`));
    const receivedContact = await store.getJson(path.join('inboxes', binding.inboxId, 'contacts', `${message.senderAgentId}.json`));
    return Boolean(sender && canAct(sender, 'send_agent_messages') && !sentContact?.blocked && !receivedContact?.blocked);
  },
  rateLimit: () => true
});
async function route(req, res) {
  installSessionCookieResponse(req, res, auth);
  const responseNonce = crypto.randomBytes(18).toString('base64');
  applyHeaders(res, req.headers.origin || '', responseNonce);
  auth.bindResponse?.(req, res);
  if (String(req.url || '').split('?', 1)[0] === '/mcp' && !mcpOriginAllowed(req)) return fail(res, 403, 'MCP Origin is not allowed');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  try { assertSafeRequestTarget(req.url); }
  catch { return fail(res, 400, 'Invalid request path'); }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  req.setTimeout(requestTimeoutMs);
  // agent-remote-auth §9: with a route flag on, every 401 from /mcp carries the challenge; error="invalid_token" when the
  // request carried a bearer token that failed. With both flags off it stays today's Bearer realm.
  if (url.pathname === '/mcp' && remoteAuthEnabled(onboardingFlags)) {
    const writeHead = res.writeHead.bind(res);
    res.writeHead = (status, ...rest) => {
      if (status === 401 && !res.hasHeader('www-authenticate')) res.setHeader('www-authenticate', mcpChallenge(remoteAuth.origin, { invalidToken: Boolean(bearerToken(req)) }));
      return writeHead(status, ...rest);
    };
  }
  // case-session v1 §3 row 1 and §8: with the flag off, the mint and end routes do not exist.
  const caseSessionRoute = req.method === 'POST' ? url.pathname.match(/^\/api\/agent\/work\/([^/]+)\/session(\/end)?$/) : null;
  const wakeRoute = url.pathname === '/.well-known/envoi-wake-keys.json' || url.pathname.startsWith('/api/agent/wake-subscriptions') || /^\/api\/inboxes\/[^/]+\/agents\/[^/]+\/wake-subscriptions/.test(url.pathname);
  if (wakeRoute && !httpWakeEnabled) throw codedError(404, 'FEATURE_DISABLED', 'HTTPS wake is not available on this server.');
  if (caseSessionRoute && !caseSessions.enabled) throw caseSessionErrors.featureDisabled();
  // agent-remote-auth §1 and §11: an endpoint that no flag serves does not exist, so it answers FEATURE_DISABLED before any
  // session, CSRF or account check could answer differently: every endpoint with both flags off, and the provider-only
  // bootstrap-code endpoint while ENVOI_PROVIDER_CONNECTORS is off. A served endpoint runs those checks as any route does.
  if (remoteAuthPath(url.pathname) && !remoteAuthEndpointServed(url.pathname, onboardingFlags)) throw remoteAuthDisabled();
  // Apply a stable source-IP bound on every route before trusting bearer or
  // cookie headers. Rotating invalid credentials must not reset this limit.
  const ipKey = `request-ip:${hashSecret(clientIp(req)).slice(0, 32)}`;
  if (!consumeRateLimit(req, res, url.pathname, ipKey)) throw codedError(429, 'RATE_LIMITED', 'Too many requests. Retry after the indicated delay.', { retryAfterSeconds: Number(res.getHeader('retry-after')) || 1 });
  if (url.pathname !== '/mcp' && !consumeRateLimit(req, res, url.pathname)) throw codedError(429, 'RATE_LIMITED', 'Too many requests. Retry after the indicated delay.', { retryAfterSeconds: Number(res.getHeader('retry-after')) || 1 });
  if (await browserGatewayHttp(req, res, url)) return;
  const csrfExempt = url.pathname === '/api/email-webhooks/resend'
    || url.pathname === '/oauth/token'
    || url.pathname === '/oauth/revoke'
    || url.pathname.startsWith('/api/object-storage/local-upload/')
    || url.pathname === '/api/auth/phone/start'
    || url.pathname === '/api/auth/phone/verify';
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !csrfExempt && parseCookies(req.headers.cookie)[sessionCookieName()] && !verifyCsrfRequest(req)) return fail(res, 403, 'CSRF validation failed');
  // Tabs share one session cookie. If another tab signed in as someone else, a
  // stale tab would otherwise act as the new account while still showing the old
  // one. The browser app states which account it is displaying; a mismatch is
  // rejected before any handler runs. Auth routes are exempt so sign-out always works.
  const expectedHuman = String(req.headers['x-envoi-expected-human'] || '');
  if (expectedHuman && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !csrfExempt && !url.pathname.startsWith('/api/auth/') && parseCookies(req.headers.cookie)[sessionCookieName()]) {
    const current = await auth.getHuman(req);
    if (current && current.id !== expectedHuman) throw codedError(409, 'ACCOUNT_CHANGED', 'You are signed in as a different account in another tab. Reload to continue.');
  }
  // agent-remote-auth v1: discovery and the authorization request take no credential.
  if (remoteAuthPath(url.pathname)) return handleRemoteAuthRoute(req, res, url);
  // case-session v1 §6: a session token is checked by its own rules, before any other credential.
  if (url.pathname === '/mcp' && String(bearerToken(req) || '').startsWith(caseSessionTokenPrefix)) return handleCaseSessionMcp(req, res, url);
  await enforceAgentCredential(req, url, res);
  if (wakeRoute) return handleHttpWakeRoute(req, res, url);
  if (caseSessionRoute) return handleCaseSessionRoute(req, res, caseSessionRoute);
  const grokTargetRoute = url.pathname.match(/^\/api\/inboxes\/([^/]+)\/agents\/([^/]+)\/wake-targets\/grok$/);
  if (grokTargetRoute) {
    if (!onboardingFlags.grokTrigger) throw codedError(404, 'FEATURE_DISABLED', 'Provider wake is not available.');
    if (!['PUT', 'GET', 'DELETE'].includes(req.method)) return fail(res, 405, 'Method not allowed');
    if (bearerToken(req) || parseCookies(req.headers.cookie)['__Host-envoi_agent_gateway']) throw credentialError('AUTHENTICATION_REQUIRED');
    const human = await auth.getHuman(req);
    if (!human) throw credentialError('AUTHENTICATION_REQUIRED');
    const inboxId = assertSafeIdentifier(grokTargetRoute[1], 'inboxId'), agentId = assertSafeIdentifier(grokTargetRoute[2], 'agentId');
    const inbox = await store.getJson(path.join('inboxes', inboxId, 'inbox.json'));
    const agent = await store.getJson(path.join('inboxes', inboxId, 'agents', `${agentId}.json`));
    if (!inbox || !agent || !await canManageInbox(human, inbox, { maxAgeMs: 0 })) throw codedError(403, 'AUTHENTICATION_REQUIRED', 'Workspace access is required.');
    let family = null, installationId = null;
    if (req.method === 'PUT') for (const installation of await installations.list(inboxId, agent)) {
      if (installation.status !== 'active') continue;
      const candidate = await store.getJson(agentCredentialFamilyPath(inboxId, agentId, installation.familyId));
      if (candidate && !candidate.revokedAt && Date.parse(candidate.refreshExpiresAt) > Date.now()) { family = candidate; installationId = installation.id; break; }
    }
    if (req.method === 'PUT' && (!family || !canAct(agent, 'receive_agent_messages'))) throw codedError(403, 'AUTHENTICATION_REQUIRED', 'An active installation is required.');
    const identity = { inboxId, agent, family, installationId, ownerRequest: req, ownerHumanId: human.id };
    let result;
    try { result = req.method === 'PUT' ? await providerEventWake.putGrok(identity, await body(req, 8192))
      : req.method === 'DELETE' ? await providerEventWake.deleteGrok(identity) : await providerEventWake.getGrok(identity); }
    catch (error) {
      if (error.statusCode) {
        const retry = Math.min(86400, Math.max(0, Math.ceil(Number(error.retryAfter) || 0)));
        error.publicFields = { ...error.publicFields, ...(error.reason ? { reason: error.reason } : {}), ...(retry ? { retryAfterSeconds: retry } : {}) };
        if (retry) res.setHeader('retry-after', String(retry));
      }
      throw error;
    }
    res.setHeader('cache-control', 'no-store'); return json(res, 200, result);
  }
  if (url.pathname === '/mcp') {
    const identity = await getMcpIdentity(req);
    if (!identity) {
      if (!remoteAuthEnabled(onboardingFlags)) res.setHeader('www-authenticate', 'Bearer realm="Envoi agent MCP"');
      return fail(res, 401, 'Active v1 agent credential required');
    }
    if (!consumeRateLimit(req, res, url.pathname)) throw codedError(429, 'RATE_LIMITED', 'Too many requests. Retry after the indicated delay.', { retryAfterSeconds: Number(res.getHeader('retry-after')) || 1 });
    const dispatch = identity.oauth ? registerInternalDispatch(hashSecret(bearerToken(req))) : null;
    res.once('close', () => dispatch?.release());
    const callRest = async (method, pathname, input, idempotencyKey) => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Local API is unavailable');
      const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`, {
        method,
        headers: {
          authorization: req.headers.authorization,
          ...(dispatch ? { 'x-envoi-mcp-dispatch': dispatch.nonce } : {}),
          ...(input === undefined ? {} : { 'content-type': 'application/json' }),
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {})
        },
        body: input === undefined ? undefined : JSON.stringify(input),
        redirect: 'error',
        signal: AbortSignal.timeout(Math.min(requestTimeoutMs, 25_000))
      });
      const payload = await response.json();
      return { status: response.status, payload };
    };
    // agent-remote-auth §9: a tool call that needs a permission an OAuth family does not hold is 403 INSUFFICIENT_SCOPE, naming the
    // scope it needs. Other credentials keep today's answer.
    const denyUnavailable = identity.oauth ? tool => {
      const scope = remoteAuthScopes.find(entry => entry.permission === tool.permission)?.scope;
      if (!scope) return;
      res.setHeader('www-authenticate', insufficientScopeChallenge(remoteAuth.origin, scope));
      throw codedError(403, 'INSUFFICIENT_SCOPE', insufficientScopeMessages[tool.permission] || 'This connection may not use this tool.');
    } : null;
    const freshMcpIdentity = async () => {
      const fresh = await getMcpIdentity(req);
      if (!fresh || fresh.inboxId !== identity.inboxId || fresh.agent.id !== identity.agent.id || fresh.family?.id !== identity.family?.id
        || fresh.installationId !== identity.installationId) throw credentialError('CREDENTIAL_REVOKED');
      if (fresh.paused) throw agentPausedError();
      if (!fresh.agent.permissions?.includes('receive_agent_messages')) {
        if (fresh.oauth) res.setHeader('www-authenticate', insufficientScopeChallenge(remoteAuth.origin, 'envoi.agent'));
        throw codedError(403, 'INSUFFICIENT_SCOPE', 'This connection no longer holds receive permission.');
      }
      return fresh;
    };
    const events = { ...providerEventWake };
    for (const name of ['discover', 'list', 'unsubscribe']) events[name] = (_caller, ...args) => withInboxMutation(identity.inboxId, async () => providerEventWake[name](await freshMcpIdentity(), ...args));
    events.subscribe = async (_caller, ...args) => providerEventWake.subscribe(await freshMcpIdentity(), ...args);
    return handleAgentMcp(req, res, { identity, callRest, denyUnavailable, onPermissionDenied: () => { req[monadPermissionDenied] = true; },
      eventsEnabled: Boolean(onboardingFlags.mcpEvents), providerEvents: events,
      wakeTools: { ...mcpWakeTools, call: (name, args) => withInboxMutation(identity.inboxId, async () => mcpWakeTools.call(name, args, await freshMcpIdentity())) } });
  }
  // agent-remote-auth v1 §5: /authorize-agent is the owner consent page, also the web app.
  // agent-registration v1 §3 and §7: claim.url is ${ENVOI_PUBLIC_URL}/claim; /connect is the
  // agent-facing page. Both are the web app, which reads availability from the routes endpoint.
  if (['GET', 'HEAD'].includes(req.method) && url.pathname === '/' && (url.searchParams.has('enroll') || url.searchParams.has('workspace'))) {
    return redirect(res, `/app${url.search}`);
  }
  if (['GET', 'HEAD'].includes(req.method) && url.pathname === '/app/') return redirect(res, `/app${url.search}`);
  const marketing = marketingRoute(url.pathname);
  if (['GET', 'HEAD'].includes(req.method) && marketing?.redirect) {
    const location = marketing.redirect === '/#team' ? `/${url.search}#team` : `${marketing.redirect}${url.search}`;
    res.writeHead(301, { location, 'cache-control': 'public, max-age=3600' });
    return res.end();
  }
  const appShell = ['/app', '/claim', '/connect', '/authorize-agent'].includes(url.pathname);
  if (['GET', 'HEAD'].includes(req.method) && url.pathname.startsWith('/connect/')) return serveConnectContent(req, res, url);
  if (['GET', 'HEAD'].includes(req.method) && (marketing?.file || appShell || url.pathname.startsWith('/web/') || url.pathname === '/robots.txt' || url.pathname === '/sitemap.xml')) {
    const relative = marketing?.file || (appShell ? 'index.html' : url.pathname.startsWith('/web/') ? url.pathname.slice('/web/'.length) : url.pathname.slice(1));
    let filePath;
    try { filePath = resolvePathWithin(path.resolve(marketing?.file ? 'web/marketing' : 'web'), relative); }
    catch { return fail(res, 400, 'Invalid asset path'); }
    const contentTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.webp': 'image/webp', '.avif': 'image/avif' };
    try {
      const extension = path.extname(filePath);
      let content = await readFile(filePath);
      if (extension === '.html') content = Buffer.from(nonceStaticHtml(content.toString('utf8'), responseNonce));
      if (appShell || url.pathname === '/web/index.html') res.setHeader('x-robots-tag', 'noindex, nofollow');
      res.writeHead(200, { 'content-type': contentTypes[extension] || 'application/octet-stream', 'content-length': content.byteLength, 'cache-control': 'private, no-store' });
      return res.end(req.method === 'HEAD' ? undefined : content);
    }
    catch (error) { if (error.code === 'ENOENT') return fail(res, 404, 'Web asset not found'); throw error; }
  }
  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, service: serviceIdentity, time: store.now(), mode: productionConfig.mode, configurationValidated: productionConfig.validated, releaseSha });
  if (req.method === 'GET' && url.pathname === '/ready') {
    const readiness = await readinessReport();
    return json(res, readiness.ready ? 200 : 503, readiness);
  }
  if (req.method === 'GET' && url.pathname === '/api/email-transport/status') return json(res, 200, { ...emailTransport.status(), enabled: externalEmailEnabled, internalAgentDomain: agentDomain, internalIdentityOnly: agentDomain.endsWith('.mail') });
  if (req.method === 'POST' && url.pathname === '/api/waitlist') {
    res.setHeader('cache-control', 'no-store');
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return fail(res, 415, 'JSON is required');
    const result = await joinWaitlist(store, await body(req, 2048));
    if (result.error) return fail(res, 400, result.error);
    return json(res, 200, { accepted: true });
  }

  const instructionReplyRoute = url.pathname.match(/^\/api\/agent\/instructions\/([^/]+)\/reply$/);
  const workSettlementRoute = url.pathname.match(/^\/api\/agent\/work\/([^/]+)\/(renew|acknowledge|complete|fail)$/) || instructionReplyRoute;
  if ((req.method === 'POST' && url.pathname === '/api/agent/work/claim') || (req.method === 'POST' && workSettlementRoute)) {
    // a5-presence §2: a lease request is work-loop activity whatever its outcome, except AGENT_PAUSED.
    if (workSettlementRoute) notePresence(req, { workLoop: true });
    const identity = await getAgentWorkIdentity(req);
    if (!identity) return fail(res, 401, 'Active v1 agent credential required');
    if (identity.paused) {
      if (workSettlementRoute) throw agentPausedError();
      return json(res, 200, { work: null, state: 'paused' });
    }
    if (!canAct(identity.agent, 'receive_agent_messages')) return fail(res, 403, 'Agent is not approved to receive messages');
    const input = await body(req);
    const workId = workSettlementRoute ? assertSafeIdentifier(workSettlementRoute[1], 'workId') : null;
    const action = instructionReplyRoute ? 'reply' : workSettlementRoute?.[2] || 'claim';
    if (action === 'claim' && (!input || typeof input !== 'object' || Array.isArray(input))) return fail(res, 400, 'Claim body must be a JSON object');
    if (action === 'claim' && input.acceptHumanInstructions !== undefined && typeof input.acceptHumanInstructions !== 'boolean') return fail(res, 400, 'acceptHumanInstructions must be a boolean');
    const requestedMessage = workSettlementRoute ? await store.getJson(messagePath(identity.inboxId, workId)) : null;
    const claimCandidates = action === 'claim' ? (await store.listJson(path.join('inboxes', identity.inboxId, 'messages')))
      .filter(message => !isHumanInstruction(message) || input.acceptHumanInstructions === true) : [];
    const ownCandidates = claimCandidates.filter(message => message.recipientInboxId === identity.inboxId && message.recipientAgentId === identity.agent.id && ['delivered', 'acknowledged'].includes(message.status));
    const humanCaseIds = [...new Set([requestedMessage, ...ownCandidates].filter(m => isHumanInstruction(m) || isHumanDecision(m)).map(message => assertSafeIdentifier(message.caseId, 'caseId')))];
    const humanBindings = await Promise.all(humanCaseIds.map(caseId => store.getJson(caseBindingPath(caseId))));
    const relatedWorkInboxes = [...new Set([requestedMessage?.senderInboxId, ...ownCandidates.map(message => message.senderInboxId), ...humanBindings.flatMap(binding => binding?.inboxIds || [])].filter(Boolean))];
    const workLockKeys = [...new Set([...(requestedMessage?.caseId ? [caseMutationKey(requestedMessage.caseId)] : []), ...humanCaseIds.map(caseMutationKey)])];
    if (action !== 'claim' && (typeof input.leaseToken !== 'string' || !input.leaseToken)) return fail(res, 400, 'leaseToken is required');
    if (action === 'fail' && typeof input.retryable !== 'boolean') return fail(res, 400, 'retryable must be a boolean');
    let idempotencyKey = null;
    let idempotencyPath = null;
    let requestDigest = null;
    if (action === 'reply') {
      if (!input || Object.keys(input).some(key => !['text', 'leaseToken'].includes(key))) return fail(res, 400, 'Only text and leaseToken are accepted');
      input.text = validateHumanInstructionInput({ text: input.text }).text;
      if (!canAct(identity.agent, 'send_agent_messages')) return fail(res, 403, 'Agent is not approved to send replies');
    }
    if (action === 'acknowledge' || action === 'complete' || action === 'reply') {
      idempotencyKey = validateIdempotencyKey(req.headers['idempotency-key'], { required: true });
      idempotencyPath = scopedIdempotencyPath(`agent-work-${action}`, identity.inboxId, identity.agent.id, idempotencyKey);
      requestDigest = action === 'reply' ? semanticDigest({ workId, text: input.text }) : semanticDigest({ workId, leaseToken: input.leaseToken });
    }
    const result = await withInboxMutation(identity.inboxId, async writeAudit => {
      const currentIdentity = await getAgentWorkIdentity(req);
      if (!currentIdentity || currentIdentity.inboxId !== identity.inboxId || currentIdentity.agent.id !== identity.agent.id || currentIdentity.familyId !== identity.familyId) {
        throw (await resolveAgentCredential(req)).error || Object.assign(new Error('Agent credential is revoked or no longer active'), { statusCode: 401 });
      }
      if (currentIdentity.paused) {
        if (action !== 'claim') throw agentPausedError();
        return { status: 200, payload: { work: null, state: 'paused' } };
      }
      if (!canAct(currentIdentity.agent, 'receive_agent_messages')) throw Object.assign(new Error('Agent is not approved to receive messages'), { statusCode: 403 });
      for (const caseId of humanCaseIds) {
        const binding = await store.getJson(caseBindingPath(caseId));
        if (binding?.inboxIds?.some(id => id !== identity.inboxId && !relatedWorkInboxes.includes(id))) throw Object.assign(new Error('Case participants changed while acquiring the mutation lock; retry'), { statusCode: 409 });
      }
      if (action === 'claim') return claimCanonicalAgentWork(identity, currentIdentity, input, claimCandidates, writeAudit);

      const currentMessage = await store.getJson(messagePath(identity.inboxId, workId));
      if (!currentMessage || currentMessage.recipientInboxId !== identity.inboxId || currentMessage.recipientAgentId !== identity.agent.id) {
        throw settlementError(404, 'Work was not found for this agent', 'WORK_NOT_FOUND');
      }
      await assertCaseProgressAllowed(identity.inboxId, currentMessage.caseId);
      if (isHumanInstruction(currentMessage)) {
        await assertHumanInstructionAuthority(currentMessage, currentIdentity);
      } else if (isHumanDecision(currentMessage)) {
        if (action === 'reply') throw Object.assign(new Error('Human instruction required'), { statusCode: 404 });
        if (await workIneligibility(currentMessage, currentIdentity)) throw Object.assign(new Error('Work no longer eligible'), { statusCode: 403 });
      } else {
        if (action === 'reply') throw Object.assign(new Error('Human instruction required'), { statusCode: 404 });
        const senderAgent = await store.getJson(path.join('inboxes', currentMessage.senderInboxId, 'agents', `${currentMessage.senderAgentId}.json`));
        if (!senderAgent || !canAct(senderAgent, 'send_agent_messages')) throw Object.assign(new Error('Sender agent is paused or unavailable'), { statusCode: 403 });
        const senderContact = await store.getJson(path.join('inboxes', currentMessage.senderInboxId, 'contacts', `${identity.agent.id}.json`));
        const recipientContact = await store.getJson(path.join('inboxes', identity.inboxId, 'contacts', `${currentMessage.senderAgentId}.json`));
        if (senderContact?.blocked || recipientContact?.blocked) throw Object.assign(new Error('Message receive permission was lost'), { statusCode: 403 });
      }
      const claimPath = workClaimPath(identity.inboxId, workId);
      const claim = await store.getJson(claimPath);
      const leaseTokenHash = hashSecret(input.leaseToken);
      if (!claim || claim.credentialFamilyId !== identity.familyId || claim.leaseTokenHash !== leaseTokenHash) {
        throw settlementError(409, 'Work lease fence is stale', 'WORK_LEASE_STALE', leaseStaleReason(claim, identity.familyId, leaseTokenHash, store.now()));
      }
      const now = store.now();
      const live = ['claimed', 'acknowledged'].includes(claim.status) && new Date(claim.leaseExpiresAt) > new Date(now);
      const priorComplete = action === 'complete' ? await store.getJson(idempotencyPath) : null;
      if (action === 'complete' && priorComplete) {
        const replay = replayResponse(priorComplete, { principalId: identity.agent.id, requestDigest });
        if (claim.status === 'completed' && replay) return { status: 200, payload: replay };
      }
      if (action === 'reply') {
        if (!canAct(currentIdentity.agent, 'send_agent_messages')) throw Object.assign(new Error('Agent is not approved to send replies'), { statusCode: 403 });
        const replay = replayResponse(await store.getJson(idempotencyPath), { principalId: identity.agent.id, requestDigest });
        if (replay && (live || claim.status === 'completed')) {
          const durableReply = await store.getJson(messagePath(identity.inboxId, replay.id));
          if (!durableReply || semanticDigest(durableReply) !== semanticDigest(replay)
            || durableReply.kind !== 'humanInstructionReply' || durableReply.inReplyTo !== currentMessage.id
            || durableReply.senderAgentId !== identity.agent.id || durableReply.caseId !== currentMessage.caseId
            || durableReply.recipientHumanId !== currentMessage.senderHumanId) {
            throw Object.assign(new Error('Reply has no matching durable record'), { statusCode: 409 });
          }
          return { status: 200, payload: replay };
        }
      }
      if (!live) throw settlementError(409, 'Work lease has expired or was consumed', 'WORK_LEASE_STALE', leaseStaleReason(claim, identity.familyId, leaseTokenHash, now));

      if (action === 'reply') {
        const reply = {
          id: `msg_instruction_reply_${semanticDigest({ idempotencyPath }).slice(0, 40)}`,
          kind: 'humanInstructionReply', inboxId: identity.inboxId, caseId: currentMessage.caseId,
          senderType: 'agent', senderAgentId: identity.agent.id, senderInboxId: identity.inboxId,
          recipientInboxId: identity.inboxId, recipientHumanId: currentMessage.senderHumanId,
          from: { agentId: identity.agent.id, address: currentIdentity.agent.address },
          inReplyTo: currentMessage.id, type: 'message', text: input.text,
          status: 'delivered', createdAt: now, deliveredAt: now, updatedAt: now
        };
        if (await store.getJson(messagePath(identity.inboxId, reply.id))) throw Object.assign(new Error('Reply exists without its idempotency record'), { statusCode: 409 });
        const documents = await humanInstructionReplyDocuments(store, currentMessage, reply, now);
        documents.push(document(messagePath(identity.inboxId, reply.id), reply), document(idempotencyPath, {
          principalId: identity.agent.id, requestDigest, status: 'completed', response: reply, createdAt: now
        }));
        await store.putJsonBatch(documents);
        await writeAudit('agent.instruction_replied', { messageId: reply.id, caseId: reply.caseId, inReplyTo: currentMessage.id, senderAgentId: reply.senderAgentId, recipientHumanId: reply.recipientHumanId }, now);
        return { status: 201, payload: reply };
      }

      if (action === 'renew') {
        claim.leaseExpiresAt = new Date(Date.now() + agentWorkLeaseMs).toISOString();
        claim.updatedAt = now;
        await store.putJson(claimPath, claim);
        return { status: 200, payload: { workId, leaseToken: input.leaseToken, leaseExpiresAt: claim.leaseExpiresAt } };
      }
      if (action === 'fail') {
        const reasonCode = input.reasonCode == null ? null : String(input.reasonCode).slice(0, 120);
        const retryable = input.retryable && agentWorkAttempts(claim) < agentWorkMaxAttempts;
        if (retryable) {
          claim.status = 'retryable';
          claim.failure = { retryable: true, reasonCode, createdAt: now };
          claim.retryAt = new Date(Date.now() + agentWorkRetryDelay(agentWorkAttempts(claim))).toISOString();
          claim.leaseExpiresAt = null;
          claim.updatedAt = now;
          await store.putJson(claimPath, claim);
        } else await failAgentWorkPermanently(currentMessage, claim, reasonCode || 'MAX_ATTEMPTS_EXCEEDED', now, writeAudit);
        await caseSessions.endForWork(identity.inboxId, workId, 'work_settled', now, writeAudit);
        await writeAudit('agent.work_failed', { workId, agentId: identity.agent.id, retryable, reasonCode, attempts: agentWorkAttempts(claim), retryAt: retryable ? claim.retryAt : null }, now);
        return { status: 200, payload: { workId, status: claim.status } };
      }

      return settleCanonicalAgentWork({ identity, workId, currentMessage, claim, action, idempotencyPath, requestDigest, now }, writeAudit);
    }, relatedWorkInboxes, workLockKeys);
    // a5-presence §3: claimed or idle claims show the work loop; only a first completion (201) is processing.
    if (action === 'claim' && ['claimed', 'idle'].includes(result.payload?.state)) notePresence(req, { workLoop: true });
    if (action === 'complete' && result.status === 201) notePresence(req, { processed: true });
    return json(res, result.status, result.payload);
  }

  if (req.method === 'POST' && url.pathname === '/api/email-webhooks/resend') {
    if (!externalEmailEnabled) return fail(res, 404, 'External email transport is disabled');
    const raw = await rawBody(req);
    const emailEvent = emailTransport.verifyWebhook(raw, req.headers);
    const webhookId = String(req.headers['svix-id'] || '');
    if (!webhookId) return fail(res, 400, 'Webhook event ID is required');
    const createdAt = store.now();
    const queued = await store.enqueueOutbox([], {
      id: `email_webhook_${hashSecret(webhookId).slice(0, 40)}`,
      kind: 'emailWebhook',
      provider: 'resend',
      webhookId,
      emailEvent,
      senderInboxId: null,
      recipientInboxId: null,
      orderingKey: emailEvent.data?.email_id ? `provider-email:${emailEvent.data.email_id}` : `webhook:${webhookId}`,
      status: 'queued',
      attempts: 0,
      maxAttempts: deliveryMaxAttempts,
      availableAt: createdAt,
      createdAt,
      updatedAt: createdAt
    });
    deliveryWorker.kick();
    return json(res, queued.enqueueCreated ? 202 : 200, { accepted: true, replay: !queued.enqueueCreated, webhookId });
  }

  const localUploadRoute = url.pathname.match(/^\/api\/object-storage\/local-upload\/([^/]+)$/);
  if (req.method === 'PUT' && localUploadRoute && typeof objectStorageAdapter.putPresigned === 'function') {
    await objectStorageAdapter.putPresigned(localUploadRoute[1], await rawBuffer(req), { 'content-type': String(req.headers['content-type'] || ''), 'x-amz-checksum-sha256': String(req.headers['x-amz-checksum-sha256'] || '') });
    res.writeHead(204, { 'cache-control': 'no-store' });
    return res.end();
  }
  const localDownloadRoute = url.pathname.match(/^\/api\/object-storage\/local-download\/([^/]+)$/);
  if (req.method === 'GET' && localDownloadRoute && typeof objectStorageAdapter.getPresigned === 'function') {
    const content = await objectStorageAdapter.getPresigned(localDownloadRoute[1]);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(content.length), 'cache-control': 'private, max-age=60' });
    return res.end(content);
  }

  if (req.method === 'GET' && url.pathname === '/api/auth/config') return json(res, 200, auth.config());

  if (req.method === 'POST' && url.pathname === '/api/agent/mcp-read-token') {
    const identity = await getAgentWorkIdentity(req);
    if (!identity) return fail(res, 401, 'Active agent access credential required');
    const input = await body(req);
    if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).some(key => key !== 'caseId')) return fail(res, 400, 'Only an optional caseId is accepted');
    const caseId = input.caseId == null ? null : assertSafeIdentifier(input.caseId, 'caseId');
    return json(res, 201, await issueMcpReadToken(identity, caseId));
  }

  if (req.method === 'GET' && url.pathname === '/api/agent/status') {
    const identity = await getAgentWorkIdentity(req);
    if (!identity) return fail(res, 401, 'Active agent access credential required');
    const { agent } = identity;
    // a5-presence §4.1: the calling family's presence as stored; a failed read reports nulls.
    const record = await store.getJson(agentPresencePath(identity.inboxId, agent.id, identity.familyId)).catch(() => {
      console.error(JSON.stringify({ event: 'envoi.agent_presence_read_failed' }));
      return null;
    });
    const status = { state: agent.status === 'paused' ? 'paused' : 'active', agent: { id: agent.id, address: agent.address, status: agent.status }, inboxId: identity.inboxId, ...agentStatusPresence(record, store.now()) };
    // agent-registration v1 §6.4: additive, exactly when installations are on.
    if (onboardingFlags.installations) {
      const installation = await installations.forFamily(identity.inboxId, agent, identity.familyId).catch(() => {
        console.error(JSON.stringify({ event: 'envoi.agent_installation_read_failed' }));
        return null;
      });
      if (installation) status.installation = installationSummary(installation);
    }
    // case-session v1 §1: on every status response, whatever the flag.
    status.caseSessions = { available: caseSessions.enabled, version: 1 };
    // http-wake v1 §1: additive on every status response. With the flag off it is fixed, so the
    // most-polled route takes no inbox transaction and reads nothing for it.
    if (httpWakeEnabled) {
      const installation = await installations.forFamily(identity.inboxId, agent, identity.familyId);
      status.httpWake = await withInboxMutation(identity.inboxId, () => httpWake.status({ inboxId: identity.inboxId, agentId: agent.id, familyId: identity.familyId, installationId: installation?.id }));
    } else status.httpWake = { available: false, version: 1, subscription: null };
    return json(res, 200, status);
  }

  if (req.method === 'POST' && url.pathname === '/api/agent/connection-status') {
    const identity = await getAgentWorkIdentity(req);
    if (!identity) return fail(res, 401, 'Active agent access credential required');
    const report = validateConnectionReport(await body(req));
    const result = await withInboxMutation(identity.inboxId, async writeAudit => {
      const currentIdentity = await getAgentWorkIdentity(req);
      if (!currentIdentity || currentIdentity.agent.id !== identity.agent.id || currentIdentity.familyId !== identity.familyId) throw Object.assign(new Error('Active agent access credential required'), { statusCode: 401 });
      const familyPath = agentCredentialFamilyPath(identity.inboxId, identity.agent.id, identity.familyId);
      const family = await store.getJson(familyPath);
      if ((family.runtime || currentIdentity.agent.runtime) && report.runtime !== (family.runtime || currentIdentity.agent.runtime)) {
        throw Object.assign(new Error('Setup report runtime does not match this connection'), { statusCode: 400 });
      }
      const checkedAt = store.now();
      await store.putJson(familyPath, { ...family, connectionSetup: { ...report, checkedAt }, updatedAt: checkedAt });
      await writeAudit('agent.connection_setup_checked', { agentId: identity.agent.id, runtime: report.runtime, phase: report.phase, ...(report.errorCode ? { errorCode: report.errorCode } : {}) }, checkedAt);
      return { phase: report.phase, checkedAt, ...(report.errorCode ? { errorCode: report.errorCode } : {}) };
    });
    return json(res, 200, result);
  }

  if (req.method === 'POST' && url.pathname === '/api/agent-token') {
    const input = await body(req);
    if ((input.grantType || 'refresh_token') !== 'refresh_token') return fail(res, 400, 'Only refresh_token grant is supported');
    const successor = await rotateAgentCredentials(input.agentRefreshToken, input.rotationId, {
      onRotated: ref => res.once('finish', () => void presenceRecorder.record(ref, ['lastSeenAt', 'lastSuccessfulRefreshAt']))
    });
    return json(res, 200, successor);
  }

  if (req.method === 'GET' && ['/api/auth/workos/sign-in', '/api/auth/workos/sign-up'].includes(url.pathname)) {
    if (auth.provider !== 'workos') return fail(res, 404, 'Hosted authentication is not enabled');
    const authorization = await auth.startAuthorization({
      screenHint: url.pathname.endsWith('sign-up') ? 'sign-up' : 'sign-in',
      returnTo: url.searchParams.get('returnTo') || '/app',
      forceFresh: url.searchParams.get('fresh') === '1'
    });
    // envoi-browser-names v1 §1.3: sign-in start also clears the retired flow cookie.
    return redirect(res, authorization.url, { 'set-cookie': [authFlowCookieHeader(authorization.browserBinding), ...retiredCookieClears(['sinaloa_workos_flow'])] });
  }

  if (req.method === 'GET' && url.pathname === '/api/auth/workos/callback') {
    if (auth.provider !== 'workos') return fail(res, 404, 'Hosted authentication is not enabled');
    if (url.searchParams.get('error')) return redirect(res, `/?auth_error=${encodeURIComponent(url.searchParams.get('error_description') || url.searchParams.get('error'))}`, { 'set-cookie': authFlowCookieHeader('', { clear: true }) });
    let result;
    try {
      result = await auth.completeAuthorization({
        code: url.searchParams.get('code'),
        browserBinding: parseCookies(req.headers.cookie)[authFlowCookieName()],
        state: url.searchParams.get('state'),
        ipAddress: clientIp(req),
        userAgent: req.headers['user-agent'] || ''
      });
    } catch (error) {
      // envoi-browser-names v1 §4: a sign-in started before the cutover, or any missing, mismatched,
      // expired or used flow, restarts sign-in instead of showing a raw 401.
      if (error.code !== 'AUTH_FLOW_INVALID') throw error;
      return redirect(res, '/?auth_error=sign_in_failed', { 'set-cookie': [authFlowCookieHeader('', { clear: true }), ...retiredCookieClears()] });
    }
    if (result.reauthenticate) {
      if (result.forceFresh) return redirect(res, '/?auth_error=sign_in_failed', { 'set-cookie': authFlowCookieHeader('', { clear: true }) });
      const authorization = await auth.startAuthorization({ returnTo: result.returnTo, forceFresh: true });
      return redirect(res, authorization.url, { 'set-cookie': authFlowCookieHeader(authorization.browserBinding) });
    }
    const csrfToken = createCsrfToken();
    return redirect(res, result.returnTo, { 'set-cookie': [sessionCookieHeader(result.sealedSession), csrfCookieHeader(csrfToken), authFlowCookieHeader('', { clear: true }), ...retiredCookieClears()] });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/phone/start') {
    if (auth.provider !== 'local') return fail(res, 404, 'Phone authentication is unavailable for hosted sign-in');
    const input = await body(req);
    return json(res, 201, await auth.startPhoneVerification(input.phoneNumber, input.displayName));
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/phone/verify') {
    if (auth.provider !== 'local') return fail(res, 404, 'Phone authentication is unavailable for hosted sign-in');
    const input = await body(req);
    if (!input.challengeId || !input.code) return fail(res, 400, 'challengeId and code are required');
    const result = await auth.verifyPhone(input.challengeId, input.code);
    const csrfToken = createCsrfToken();
    res.setHeader('set-cookie', [sessionCookieHeader(result.sessionCookieValue), csrfCookieHeader(csrfToken), ...retiredCookieClears()]);
    const { sessionCookieValue: _sessionCookieValue, ...publicResult } = result;
    return json(res, 200, publicResult);
  }

  if (req.method === 'GET' && url.pathname === '/api/auth/me') {
    const human = await auth.getHuman(req, { requireMfa: false });
    if (!human) {
      // envoi-browser-names v1 §1.3: clear the retired names this browser still sends, by name only.
      const retired = retiredCookiesIn(req.headers.cookie);
      if (retired.length) res.appendHeader('set-cookie', retiredCookieClears(retired));
      return fail(res, 401, 'Authenticated human session required');
    }
    const session = await auth.getSession(req);
    const assurance = session?.assurance || 'provider';
    if (session && !parseCookies(req.headers.cookie)[csrfCookieName()]) res.appendHeader('set-cookie', csrfCookieHeader(createCsrfToken()));
    const pendingStepUp = assurance === 'phone';
    const mfaSetupRequired = pendingStepUp && typeof auth.getMfaSetupRequired === 'function'
      ? await auth.getMfaSetupRequired(req)
      : null;
    return json(res, 200, { ...human, auth: { provider: auth.provider, assurance }, ...(pendingStepUp ? { mfaSetupRequired } : {}) });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/totp/setup') {
    if (auth.provider !== 'local') return fail(res, 404, 'Hosted authentication is managed by WorkOS');
    return json(res, 201, await auth.startTotp(req));
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/totp/verify') {
    if (auth.provider !== 'local') return fail(res, 404, 'Hosted authentication is managed by WorkOS');
    const input = await body(req);
    if (!input.code) return fail(res, 400, 'Authenticator code is required');
    return json(res, 200, await auth.verifyTotp(req, input.code));
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    const result = await auth.logout(req, { onRevoked: disconnectHumanStreams });
    const revoked = typeof result === 'boolean' ? result : result.revoked;
    const rawSession = parseCookies(req.headers.cookie)[sessionCookieName()];
    const sessionKey = auth.provider === 'workos' ? result.sessionId : rawSession ? hashSecret(rawSession) : null;
    disconnectHumanStreams(sessionKey);
    res.setHeader('set-cookie', [sessionCookieHeader('', { clear: true }), csrfCookieHeader('', { clear: true }), ...retiredCookieClears()]);
    // Logout is idempotent, including missing, expired and already-cleared sessions.
    return json(res, 200, typeof result === 'boolean' ? { revoked } : { revoked, logoutUrl: result.logoutUrl });
  }

  if (url.pathname === '/api/organizations' && req.method === 'GET') {
    const human = await auth.getHuman(req);
    if (!human) return fail(res, 401, 'Authenticated human session required');
    const organizations = await listHumanOrganizations(human.id);
    const authorized = [];
    for (const organization of organizations) if (await getAuthorizedMembership(organization.id, human)) authorized.push(organization);
    return json(res, 200, authorized);
  }

  if (url.pathname === '/api/organizations' && req.method === 'POST') {
    const human = await auth.getHuman(req);
    if (!human) return fail(res, 401, 'Authenticated human session required');
    const input = await body(req);
    return json(res, 201, await createOrganization(human, input, req.headers['idempotency-key']));
  }

  const organizationWorkspaces = url.pathname.match(/^\/api\/organizations\/([^/]+)\/workspaces$/);
  if (req.method === 'GET' && organizationWorkspaces) {
    const human = await auth.getHuman(req);
    const organizationId = organizationWorkspaces[1];
    if (!human || !await getAuthorizedMembership(organizationId, human)) return fail(res, 403, 'Active organization membership required');
    const references = await store.listJson(path.join('organizations', organizationId, 'workspaces'));
    const workspaces = await Promise.all(references.map(reference => store.getJson(path.join('inboxes', reference.inboxId, 'inbox.json'))));
    return json(res, 200, workspaces.filter(workspace => workspace && !workspace.historyDeleted));
  }

  const calendarCallback = url.pathname.match(/^\/api\/calendar-oauth\/(google|outlook)\/callback$/);
  if (req.method === 'GET' && calendarCallback) {
    const providerId = calendarCallback[1];
    const provider = calendarProviders[providerId];
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    if (!state || !code || url.searchParams.get('error')) return fail(res, 400, 'Calendar authorization was not completed');
    const statePath = path.join('auth', 'calendar-oauth', `${hashSecret(state)}.json`);
    const pending = await store.getJson(statePath);
    if (!pending || pending.provider !== providerId || pending.usedAt || new Date(pending.expiresAt) <= new Date()) return fail(res, 400, 'Calendar authorization state is invalid or expired');
    if (!provider.clientId || !provider.clientSecret) return fail(res, 503, `${provider.label} is not configured`);
    const claimed = await store.claimJson(statePath, 'usedAt', store.now());
    if (!claimed) return fail(res, 400, 'Calendar authorization state was already used');
    if (!claimed.codeVerifier) return fail(res, 400, 'Calendar authorization state is invalid or expired');
    const tokenSet = await exchangeCalendarAuthorizationCode({
      provider,
      code,
      redirectUri: calendarRedirectUri(providerId, req),
      codeVerifier: claimed.codeVerifier,
      timeoutMs: calendarOAuthTimeoutMs
    });
    const connectedAt = store.now();
    const connector = {
      id: `calendar_${providerId}`,
      provider: providerId,
      label: provider.label,
      status: 'connected',
      accountLabel: tokenAccountLabel(tokenSet),
      scopes: String(tokenSet.scope || provider.scopes.join(' ')).split(/\s+/).filter(Boolean),
      expiresAt: tokenSet.expires_in ? new Date(Date.now() + Number(tokenSet.expires_in) * 1000).toISOString() : null,
      refreshTokenPresent: Boolean(tokenSet.refresh_token),
      connectedByHumanId: pending.humanId,
      connectedAt,
      updatedAt: connectedAt,
      tokenSetEncrypted: encryptConnectorTokens(tokenSet)
    };
    await store.putJson(calendarConnectorPath(pending.inboxId, providerId), connector);
    await audit(pending.inboxId, 'calendar.connected', { provider: providerId, humanId: pending.humanId });
    const returnUrl = new URL(pending.returnTo || '/app', process.env.ENVOI_PUBLIC_URL || `http://${req.headers.host || `${host}:${port}`}`);
    returnUrl.searchParams.set('calendarConnected', providerId);
    return redirect(res, returnUrl.toString());
  }

  // agent-registration v1 §1: what Envoi offers, for /connect, skill.json and the helper.
  if (req.method === 'GET' && url.pathname === '/api/onboarding/routes') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=60' });
    return res.end(JSON.stringify(routeAvailability(onboardingFlags, store.now())));
  }

  // agent-registration v1 §3–§5: registration, status polling and the human claim.
  const registrationRoute = url.pathname.match(/^\/api\/agent-registrations(?:\/([^/]+)(?:\/(approve|reject))?)?$/);
  const claimRoute = url.pathname.match(/^\/api\/agent-claims(?:\/(lookup)|\/([^/]+)\/(withdraw))?$/);
  if (req.method === 'POST' && url.pathname === '/api/agent-installations/activate') {
    const input = await readJsonBody(req);
    const activation = await activateRegistration(bearerToken(req), input.invalid ? null : input.value);
    return json(res, activation.status, activation.body);
  }
  if (registrationRoute || claimRoute) {
    try { return await handleAgentRegistration(req, res, registrationRoute, claimRoute); }
    catch (error) {
      if (error?.publicFields?.retryAfterSeconds && !res.headersSent) res.setHeader('retry-after', String(error.publicFields.retryAfterSeconds));
      throw error;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/agent-enroll') {
    const input = await body(req);
    if (!input.enrollmentToken) return fail(res, 400, 'enrollmentToken is required');
    const tokenHash = hashSecret(input.enrollmentToken);
    const tokenPath = path.join('auth', 'enrollment-tokens', `${tokenHash}.json`);
    const pendingRecord = await store.getJson(tokenPath);
    if (!pendingRecord || pendingRecord.usedAt || pendingRecord.revokedAt || new Date(pendingRecord.expiresAt) <= new Date()) return fail(res, 401, 'Enrollment token is invalid, expired, or already used');
    if (input.runtime !== undefined && validateConnectorRuntime(input.runtime) !== (pendingRecord.runtime || 'openclaw')) return fail(res, 400, 'Setup runtime does not match this enrollment');
    if (pendingRecord.kind === 'reconnect' || pendingRecord.kind === 'reenroll') {
      const reconnected = await withInboxMutation(pendingRecord.inboxId, async writeAudit => {
        const currentRecord = await store.getJson(tokenPath);
        if (!currentRecord || currentRecord.kind !== pendingRecord.kind || currentRecord.usedAt || currentRecord.revokedAt || new Date(currentRecord.expiresAt) <= new Date()) {
          throw Object.assign(new Error('Enrollment token is invalid, expired, or already used'), { statusCode: 401 });
        }
        const inbox = await store.getJson(path.join('inboxes', currentRecord.inboxId, 'inbox.json'));
        const agent = await store.getJson(path.join('inboxes', currentRecord.inboxId, 'agents', `${currentRecord.agentId}.json`));
        const reenroll = currentRecord.kind === 'reenroll';
        const state = agent ? await agentControlState(currentRecord.inboxId, agent) : null;
        if (!inbox || inbox.ownerAgentId !== currentRecord.agentId || !agent
          || (reenroll ? !state.credentialRevoked : !['active', 'paused'].includes(agent.status) || agent.onboardingStatus !== 'approved' || state.credentialRevoked)
          || (agent.accessGeneration || 0) !== (currentRecord.accessGeneration || 0)) {
          throw Object.assign(new Error('Agent is not available for this enrollment'), { statusCode: 409 });
        }
        const membership = await getMembership(inbox.organizationId, currentRecord.humanId);
        let issuerMembership = membership;
        if (auth.provider === 'workos') {
          const [organization, owner] = await Promise.all([
            store.getJson(path.join('organizations', inbox.organizationId, 'organization.json')),
            store.getJson(path.join('humans', `${currentRecord.humanId}.json`))
          ]);
          const providerMembership = organization?.workosOrganizationId && owner?.workosUserId
            ? await auth.getOrganizationMembership(owner.workosUserId, organization.workosOrganizationId)
            : null;
          issuerMembership = membership ? { ...membership, providerMembership } : null;
        }
        if (!membershipCanManage(issuerMembership, auth.provider)) {
          throw Object.assign(new Error('Reconnect owner is invalid'), { statusCode: 403 });
        }
        if (reenroll) await assertActiveAgentSlot(agent.principalHumanId || inbox.ownerHumanId);
        const claimed = await store.claimJson(tokenPath, 'usedAt', store.now());
        if (!claimed) throw Object.assign(new Error('Enrollment token is invalid, expired, or already used'), { statusCode: 401 });
        const credentialFamilyCount = await revokeAgentCredentialFamilies(inbox.id, agent.id, claimed.humanId, store.now(), reenroll ? 'revoked' : 'replaced', writeAudit);
        const connectedAt = store.now();
        const approvedAgent = reenroll ? { ...agent, status: 'active', onboardingStatus: 'approved', permissions: claimed.permissions, revokedAt: null, approvedAt: connectedAt, approvedByHumanId: claimed.humanId, updatedAt: connectedAt } : agent;
        // Leases held by the replaced installation would block the new one until they expire.
        const releasedAt = store.now();
        const heldLeases = (await store.listJson(path.join('inboxes', inbox.id, 'work-claims')))
          .filter(claim => claim.agentId === agent.id && ['claimed', 'acknowledged'].includes(claim.status) && new Date(claim.leaseExpiresAt) > new Date(releasedAt));
        await store.putJsonBatch(heldLeases.map(claim => document(workClaimPath(inbox.id, claim.workId), { ...claim, status: 'retryable', retryAt: releasedAt, leaseExpiresAt: null, reofferWithoutAttempt: true, releasedAt, updatedAt: releasedAt })));
        const credentials = await issueAgentCredentials(agent.id, inbox.id);
        const credentialIndex = await store.getJson(agentCredentialPath(hashSecret(credentials.agentApiToken)));
        const familyPath = agentCredentialFamilyPath(inbox.id, agent.id, credentialIndex.familyId);
        const family = await store.getJson(familyPath);
        const runtime = claimed.runtime || agent.runtime;
        const connectedAgent = runtime ? { ...approvedAgent, runtime } : approvedAgent;
        const documents = [
          document(familyPath, { ...family, ...(runtime ? { runtime } : {}) }),
          document(path.join('inboxes', inbox.id, 'agents', `${agent.id}.json`), connectedAgent),
          document(tokenPath, { ...claimed, agentInboxId: inbox.id, credentialFamilyId: credentialIndex.familyId })
        ];
        if (reenroll) {
          documents.push(
            document(path.join('directory', 'agents', `${agent.id}.json`), { agentId: agent.id, inboxId: inbox.id, address: agent.address, externalAddress: externalEmailEnabled ? publicEmailAddressForAgent(agent) : null, status: 'active', verified: true }),
            document(nativeAddressDirectoryPath(agent.address), { agentId: agent.id, inboxId: inbox.id, address: agent.address, status: 'active', verified: true })
          );
          if (externalEmailEnabled && publicEmailAddressForAgent(agent)) documents.push(document(externalAddressDirectoryPath(publicEmailAddressForAgent(agent)), { agentId: agent.id, inboxId: inbox.id, address: publicEmailAddressForAgent(agent), status: 'active' }));
        }
        await store.putJsonBatch(documents);
        await writeAudit(reenroll ? 'agent.reenrolled' : 'agent.credentials_reconnected', { agentId: agent.id, humanId: claimed.humanId, credentialFamilyCount, ...(reenroll ? { permissions: connectedAgent.permissions } : {}) });
        if (heldLeases.length) await writeAudit('work.available', { agentId: agent.id, reason: 'lease_released' }, releasedAt);
        return { agent: connectedAgent, inbox, credentials };
      }, [], [enrollmentMutationKey(tokenHash), ...(pendingRecord.kind === 'reenroll' ? [humanAgentLimitKey(pendingRecord.humanId)] : [])]);
      closeAgentStreams(reconnected.inbox.id, reconnected.agent.id, { code: 'CREDENTIAL_REVOKED', reason: 'replaced' });
      // A re-enrollment after a replay revocation makes the agent active again: nothing may stay held.
      if (reconnected.agent.status === 'active' && await withInboxMutation(reconnected.inbox.id, () => releaseHeldSends(reconnected.inbox.id))) deliveryWorker.kick();
      return json(res, 200, { agent: publicAgent(reconnected.agent), ...reconnected.credentials, inbox: reconnected.inbox, nativeMessaging: 'ready' });
    }
    const plannedInboxId = store.id('inbox');
    const enrolled = await withInboxMutation(pendingRecord.inboxId, async writeAudit => {
      const currentRecord = await store.getJson(tokenPath);
      if (!currentRecord || currentRecord.usedAt || currentRecord.revokedAt || new Date(currentRecord.expiresAt) <= new Date()) throw Object.assign(new Error('Enrollment token is invalid, expired, or already used'), { statusCode: 401 });
      const sourceInbox = await store.getJson(path.join('inboxes', currentRecord.inboxId, 'inbox.json'));
      const localMembership = sourceInbox ? await getMembership(sourceInbox.organizationId, currentRecord.humanId) : null;
      let issuerMembership = localMembership;
      if (sourceInbox && auth.provider === 'workos') {
        const [organization, owner] = await Promise.all([
          store.getJson(path.join('organizations', sourceInbox.organizationId, 'organization.json')),
          store.getJson(path.join('humans', `${currentRecord.humanId}.json`))
        ]);
        const providerMembership = organization?.workosOrganizationId && owner?.workosUserId
          ? await auth.getOrganizationMembership(owner.workosUserId, organization.workosOrganizationId)
          : null;
        issuerMembership = localMembership ? { ...localMembership, providerMembership } : null;
      }
      if (!sourceInbox || !membershipCanManage(issuerMembership, auth.provider)) throw Object.assign(new Error('Enrollment owner is invalid'), { statusCode: 403 });
      const agentName = String(input.name || currentRecord.agentProfile?.name || '').trim();
      if (!agentName) throw Object.assign(new Error('Agent name is required'), { statusCode: 400 });
      await assertActiveAgentSlot(currentRecord.humanId);
      const record = await store.claimJson(tokenPath, 'usedAt', store.now());
      if (!record) throw Object.assign(new Error('Enrollment token is invalid, expired, or already used'), { statusCode: 401 });
      const requestedLocalPart = record.agentProfile?.localPart;
      const baseSlug = requestedLocalPart ? normalizeAgentLocalPart(requestedLocalPart) : slugify(input.slug || record.agentProfile?.slug || agentName) || store.id('agent').replace('agent_', '');
      let slug = baseSlug;
      let address = agentAddressForLocalPart(slug);
      if (requestedLocalPart) {
        if (!await reserveIdentity(address, { status: 'reserved' })) throw Object.assign(new Error('That agent address is already taken'), { statusCode: 409 });
      } else {
        while (!(await reserveIdentity(address, { status: 'reserved' }))) { slug = `${baseSlug}-${store.id('slug').slice(-6)}`; address = agentAddressForLocalPart(slug); }
      }
      const createdAt = store.now();
      const agent = { id: store.id('agent'), organizationId: sourceInbox.organizationId, name: agentName, slug, address, identity: publicIdentity(slug), principalHumanId: record.humanId, capabilities: input.capabilities || record.agentProfile?.capabilities || [], permissions: record.permissions, ...(record.runtime ? { runtime: record.runtime } : {}), createdAt, status: 'active', onboardingStatus: 'approved', approvedAt: createdAt, approvedByHumanId: record.humanId };
      const inbox = await createDedicatedAgentInbox({ sourceInbox, organizationId: sourceInbox.organizationId, ownerHumanId: record.humanId, agent, status: 'active', inboxId: plannedInboxId });
      await store.putJsonBatch([
        document(path.join('directory', 'agents', `${agent.id}.json`), { agentId: agent.id, inboxId: inbox.id, address: agent.address, externalAddress: externalEmailEnabled ? publicEmailAddressForAgent(agent) : null, status: agent.status, verified: true }),
        document(nativeAddressDirectoryPath(agent.address), { agentId: agent.id, inboxId: inbox.id, address: agent.address, status: agent.status, verified: true })
      ]);
      if (externalEmailEnabled && publicEmailAddressForAgent(agent)) await store.putJson(externalAddressDirectoryPath(publicEmailAddressForAgent(agent)), { agentId: agent.id, inboxId: inbox.id, address: publicEmailAddressForAgent(agent), status: agent.status });
      const credentials = await issueAgentCredentials(agent.id, inbox.id);
      const credentialIndex = await store.getJson(agentCredentialPath(hashSecret(credentials.agentApiToken)));
      const familyPath = agentCredentialFamilyPath(inbox.id, agent.id, credentialIndex.familyId);
      const family = await store.getJson(familyPath);
      if (record.runtime) await store.putJson(familyPath, { ...family, runtime: record.runtime });
      await store.putJson(tokenPath, { ...record, agentId: agent.id, agentInboxId: inbox.id, credentialFamilyId: credentialIndex.familyId });
      await writeAudit('agent.enrolled', { agentId: agent.id, humanId: record.humanId, permissions: agent.permissions, sourceInboxId: sourceInbox.id }, createdAt, inbox.id);
      await writeAudit('agent.enrollment_redeemed', { enrollmentId: record.id, agentId: agent.id, agentInboxId: inbox.id, address: agent.address, humanId: record.humanId }, createdAt, sourceInbox.id);
      await writeAudit('agent.inbox_created', { agentId: agent.id, inboxId: inbox.id, humanId: record.humanId }, createdAt, sourceInbox.id);
      return { agent, credentials, inbox };
    }, [plannedInboxId], [enrollmentMutationKey(tokenHash), humanAgentLimitKey(pendingRecord.humanId)]);
    return json(res, 201, { agent: publicAgent(enrolled.agent), ...enrolled.credentials, inbox: enrolled.inbox, nativeMessaging: 'ready' });
  }

  if (req.method === 'POST' && url.pathname === '/api/onboarding/agent-account') {
    const input = await body(req);
    if (!input.name) return fail(res, 400, 'Agent name is required');
    const human = await auth.getHuman(req);
    if (!human) return fail(res, 401, 'Verified human session required');
    input.humanId = human.id;
    const organization = await ensureOrganization(human, input.organizationId);
    const idempotencyKey = validateIdempotencyKey(input.idempotencyKey || req.headers['idempotency-key']);
    const onboardingRequestDigest = semanticDigest({
      organizationId: organization.id,
      name: String(input.name).trim(),
      slug: slugify(input.slug || input.name),
      inboxName: input.inboxName || null,
      principalLabel: input.principalLabel || null,
      capabilities: Array.isArray(input.capabilities) ? input.capabilities : [],
      description: input.description || null
    });
    const onboardingIdempotencyPath = idempotencyKey ? scopedIdempotencyPath('agent-onboarding', organization.id, human.id, idempotencyKey) : null;
    let onboardingClaim = null;
    if (onboardingIdempotencyPath) {
      onboardingClaim = await claimIdempotency(store, onboardingIdempotencyPath, { principalId: human.id, requestDigest: onboardingRequestDigest, createdAt: store.now() });
      if (onboardingClaim.replay) return json(res, 200, onboardingClaim.replay);
    }
    try {
      const inboxId = store.id('inbox');
      const baseSlug = slugify(input.slug || input.name) || store.id('agent').replace('agent_', '');
      let slug = baseSlug;
      let address = `${slug}@${agentDomain}`;
      while (!(await reserveIdentity(address, { status: 'reserved' }))) {
        slug = `${baseSlug}-${store.id('slug').slice(-6)}`;
        address = `${slug}@${agentDomain}`;
      }
      await store.ensureInbox(inboxId);
      const createdAt = store.now();
      const agent = { id: store.id('agent'), name: input.name, slug, address, identity: publicIdentity(slug), principalLabel: input.principalLabel || null, principalHumanId: input.humanId, capabilities: input.capabilities || [], permissions: [], description: input.description || null, createdAt, status: 'pending_approval', onboardingStatus: 'pending_approval' };
      const inbox = { id: inboxId, organizationId: organization.id, name: input.inboxName || `${input.name} inbox`, ownerAgentId: agent.id, ownerHumanId: input.humanId, parentInboxId: null, kind: 'agent', status: 'pending_approval', createdAt };
      await store.putJson(path.join('inboxes', inboxId, 'inbox.json'), inbox);
      await store.putJson(path.join('organizations', organization.id, 'workspaces', `${inboxId}.json`), { inboxId, createdAt });
      await store.putJson(path.join('inboxes', inboxId, 'agents', `${agent.id}.json`), agent);
      await store.putJson(path.join('inboxes', inboxId, 'contacts', `${agent.id}.json`), { agentId: agent.id, approved: true, blocked: false, updatedAt: createdAt });
      const result = { account: { inbox, agent }, next: { nativeMessaging: 'pending_human_approval', humanApproval: { required: true, humanId: input.humanId }, externalEmail: 'requires_email_transport_configuration' } };
      if (onboardingIdempotencyPath) await completeIdempotency(store, onboardingIdempotencyPath, { principalId: human.id, requestDigest: onboardingRequestDigest, response: result, createdAt });
      await audit(inboxId, 'agent.account_created', { agentId: agent.id, address: agent.address, identityStatus: agent.identity.status });
      return json(res, 201, result);
    } catch (error) {
      if (onboardingIdempotencyPath && onboardingClaim?.claimed) await store.deleteJson(onboardingIdempotencyPath).catch(() => {});
      throw error;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/inboxes') {
    const input = await body(req);
    const human = await auth.getHuman(req);
    if (!human) return fail(res, 401, 'Verified human session required');
    const organization = await ensureOrganization(human, input.organizationId);
    const inboxId = store.id('inbox');
    await store.ensureInbox(inboxId);
    const inbox = { id: inboxId, organizationId: organization.id, name: input.name || 'Agent workspace', ownerAgentId: null, ownerHumanId: human.id, parentInboxId: null, kind: 'workspace', status: 'setup', createdAt: store.now() };
    await store.putJson(path.join('inboxes', inboxId, 'inbox.json'), inbox);
    await store.putJson(path.join('organizations', organization.id, 'workspaces', `${inboxId}.json`), { inboxId, createdAt: inbox.createdAt });
    await audit(inboxId, 'inbox.created', { inboxId });
    return json(res, 201, inbox);
  }

  const match = url.pathname.match(/^\/api\/inboxes\/([^/]+)(?:\/(.*))?$/);
  if (!match) return fail(res, 404, 'Not found');
  const [, inboxId, suffix = ''] = match;
  const inbox = await store.getJson(path.join('inboxes', inboxId, 'inbox.json'));
  if (!inbox) return fail(res, 404, 'Inbox not found');

  if (await inboxPreferencesHttp.handleRequest(req, res, url)) return;

  if (suffix === 'monad-settings' && (req.method === 'GET' || req.method === 'POST')) {
    const human = await auth.getHuman(req);
    if (!human) return fail(res, 401, 'Authentication required');
    if (!await canManageInbox(human, inbox, { maxAgeMs: 0 })) return fail(res, 403, 'Workspace administrator required');
    if (req.method === 'GET') return json(res, 200, await monadAccess.status(inbox));
    const input = await body(req, 4096);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || typeof input.enabled !== 'boolean') return fail(res, 400, 'Expected { enabled: boolean }');
    const settings = await withInboxMutation(inboxId, async () => {
      const current = await store.getJson(path.join('inboxes', inboxId, 'inbox.json'));
      if (!current || !await canManageInbox(await auth.getHuman(req), current, { maxAgeMs: 0 })) throw codedError(403, 'GATEWAY_SCOPE_DENIED', 'Workspace administrator required');
      return monadAccess.set(current, input.enabled);
    });
    return json(res, 200, settings);
  }

  const monadEvidenceRoute = suffix.match(/^agents\/([^/]+)\/monad-evidence$/);
  if (req.method === 'GET' && monadEvidenceRoute) {
    const human = await auth.getHuman(req);
    if (!human) return fail(res, 401, 'Authentication required');
    if (!await canManageInbox(human, inbox)) return fail(res, 403, 'Workspace administrator required');
    const agentId = assertSafeIdentifier(monadEvidenceRoute[1], 'agentId');
    const agent = await store.getJson(path.join('inboxes', inboxId, 'agents', `${agentId}.json`));
    if (!agent || inbox.ownerAgentId !== agentId) return fail(res, 404, 'Owned agent not found');
    return json(res, 200, await monadAccess.active(inboxId)
      ? await monadPermissions.permissionEvidence(inboxId, agent)
      : { enabled: false, chainId: 10143, permission: { status: 'off' }, violations: [] });
  }

  // agent-registration v1 §6.5: the owner's installation list and per-installation revoke.
  const installationRoute = suffix.match(/^agents\/([^/]+)\/installations(?:\/([^/]+)\/revoke)?$/);
  if (installationRoute && (req.method === 'GET' ? !installationRoute[2] : req.method === 'POST' && installationRoute[2])) {
    if (!onboardingFlags.installations) throw codedError(404, 'FEATURE_DISABLED', 'Installations are not available yet.');
    const human = await auth.getHuman(req);
    if (!human) throw codedError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
    const agentId = assertSafeIdentifier(installationRoute[1], 'agentId');
    const notFound = () => codedError(404, 'INSTALLATION_NOT_FOUND', 'That installation was not found.');
    if (req.method === 'GET') {
      if (!await canAccessInbox(human, inbox)) return fail(res, 403, 'Workspace membership required');
      const agent = await store.getJson(path.join('inboxes', inboxId, 'agents', `${agentId}.json`));
      if (!agent || inbox.ownerAgentId !== agentId) return fail(res, 404, 'Owned agent not found');
      return json(res, 200, ownerInstallationList(agentId, await installations.list(inboxId, agent)));
    }
    if (!await canManageInbox(human, inbox)) return fail(res, 403, 'Workspace administrator required');
    const installationId = assertSafeIdentifier(installationRoute[2], 'installationId');
    const revoked = await withInboxMutation(inboxId, async writeAudit => {
      if (!await canManageInbox(await auth.getHuman(req), inbox)) throw Object.assign(new Error('Workspace administrator required'), { statusCode: 403 });
      const agent = await store.getJson(path.join('inboxes', inboxId, 'agents', `${agentId}.json`));
      if (!agent || inbox.ownerAgentId !== agentId) throw notFound();
      const installation = (await installations.list(inboxId, agent)).find(item => item.id === installationId);
      if (!installation) throw notFound();
      // Already ended: nothing changes, and the response keeps how it ended.
      if (installation.status === 'ended') return { installation, familyId: null };
      const revokedAt = store.now();
      await revokeCredentialFamily(inboxId, agentId, installation.familyId, human.id, revokedAt, 'revoked', writeAudit);
      // Leases held by this installation would block the next one until they expire.
      const heldLeases = (await store.listJson(path.join('inboxes', inboxId, 'work-claims')))
        .filter(claim => claim.agentId === agentId && claim.credentialFamilyId === installation.familyId && ['claimed', 'acknowledged'].includes(claim.status) && new Date(claim.leaseExpiresAt) > new Date(revokedAt));
      await store.putJsonBatch(heldLeases.map(claim => document(workClaimPath(inboxId, claim.workId), { ...claim, status: 'retryable', retryAt: revokedAt, leaseExpiresAt: null, reofferWithoutAttempt: true, releasedAt: revokedAt, updatedAt: revokedAt })));
      await writeAudit('agent.installation_revoked', { agentId, installationId, credentialFamilyId: installation.familyId, humanId: human.id }, revokedAt);
      if (heldLeases.length) await writeAudit('work.available', { agentId, reason: 'lease_released' }, revokedAt);
      return { installation: await installations.forFamily(inboxId, agent, installation.familyId), familyId: installation.familyId };
    });
    if (revoked.familyId) closeAgentStreams(inboxId, agentId, { code: 'CREDENTIAL_REVOKED', reason: 'revoked' }, revoked.familyId);
    return json(res, 200, { installation: publicInstallation(revoked.installation) });
  }

  if (inbox.status === 'removed' && req.method !== 'GET' && !/^agents\/[^/]+\/remove$/.test(suffix)) return fail(res, 409, 'Removed agent history is read-only');

  if (req.method === 'GET' && suffix !== 'events') {
    const human = await auth.getHuman(req);
    const agent = await getAgentPrincipal(req, inboxId);
    if (!await canAccessInbox(human, inbox) && !agent) {
      await rejectAgentToken(req);
      return fail(res, 401, 'Authenticated inbox participant required');
    }
  }

  if (req.method === 'GET' && suffix === 'agent-address-availability') {
    const human = await auth.getHuman(req);
    if (!await canManageInbox(human, inbox)) return fail(res, 403, 'Workspace administrator required');
    const localPart = normalizeAgentLocalPart(url.searchParams.get('localPart'));
    const address = agentAddressForLocalPart(localPart);
    const available = !await registrations.addressTaken(address);
    return json(res, 200, { localPart, address, available });
  }

  const enrollmentStatusRoute = suffix.match(/^agent-enrollment-tokens\/([^/]+)\/status$/);
  if (req.method === 'GET' && enrollmentStatusRoute) {
    const human = await auth.getHuman(req);
    if (!await canManageInbox(human, inbox)) return fail(res, 403, 'Workspace administrator required');
    const enrollmentId = assertSafeIdentifier(enrollmentStatusRoute[1], 'enrollmentId');
    const index = await store.getJson(enrollmentIndexPath(inboxId, enrollmentId));
    const record = index?.tokenHash ? await store.getJson(path.join('auth', 'enrollment-tokens', `${index.tokenHash}.json`)) : null;
    if (!record || record.id !== enrollmentId || record.inboxId !== inboxId) return fail(res, 404, 'Enrollment not found');
    const agent = record.agentId && record.agentInboxId ? await store.getJson(path.join('inboxes', record.agentInboxId, 'agents', `${record.agentId}.json`)) : null;
    const family = record.credentialFamilyId && record.agentId && record.agentInboxId ? await store.getJson(agentCredentialFamilyPath(record.agentInboxId, record.agentId, record.credentialFamilyId)) : null;
    return json(res, 200, enrollmentConnectionStatus(record, agent, family));
  }

  if (req.method === 'POST' && suffix === 'agent-enrollment-tokens') {
    const human = await auth.getHuman(req);
    if (!await canManageInbox(human, inbox)) return fail(res, 403, 'Workspace administrator required');
    await assertActiveAgentSlot(human.id);
    const input = await body(req);
    const runtime = validateConnectorRuntime(input.runtime);
    const requested = Array.isArray(input.permissions) ? input.permissions : ['send_agent_messages', 'receive_agent_messages'];
    const permissions = requested.filter(permission => allowedPermissions.has(permission));
    if (!permissions.includes('receive_agent_messages')) permissions.push('receive_agent_messages');
    const profileName = String(input.agentProfile?.name || '').trim();
    const requestedLocalPart = input.agentProfile?.localPart;
    if (productionConfig.mode === 'production' && !requestedLocalPart) return fail(res, 400, 'Choose an agent address before creating an enrollment token');
    const localPart = requestedLocalPart ? normalizeAgentLocalPart(requestedLocalPart) : null;
    if (localPart && !profileName) return fail(res, 400, 'Agent name is required with a chosen address');
    if (localPart && await registrations.addressTaken(agentAddressForLocalPart(localPart))) return fail(res, 409, 'That agent address is already taken');
    const agentProfile = profileName ? { name: profileName, slug: localPart || slugify(input.agentProfile?.slug || profileName), ...(localPart ? { localPart } : {}), capabilities: Array.isArray(input.agentProfile?.capabilities) ? input.agentProfile.capabilities.slice(0, 20) : [] } : null;
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const record = { id: store.id('enrollment'), runtime, tokenHash: hashSecret(rawToken), inboxId, organizationId: inbox.organizationId, humanId: human.id, permissions, agentProfile, createdAt: store.now(), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), usedAt: null };
    await store.putJsonBatch([
      document(path.join('auth', 'enrollment-tokens', `${record.tokenHash}.json`), record),
      document(enrollmentIndexPath(inboxId, record.id), { enrollmentId: record.id, tokenHash: record.tokenHash })
    ]);
    await audit(inboxId, 'agent.enrollment_token_created', { enrollmentId: record.id, humanId: human.id, permissions });
    const publicUrl = new URL(publicBaseUrl(req)).origin;
    const quickConnect = { version: 1, runtime, apiUrl: publicUrl, enrollmentToken: rawToken, expiresAt: record.expiresAt, agentName: agentProfile?.name || '', address: localPart ? agentAddressForLocalPart(localPart) : null };
    return json(res, 201, { enrollmentId: record.id, quickConnect, enrollmentToken: rawToken, enrollmentUrl: `${publicUrl}/?enroll=${encodeURIComponent(rawToken)}`, expiresAt: record.expiresAt, permissions, agentProfile });
  }

  const reconnectTokenMatch = suffix.match(/^agents\/([^/]+)\/credentials\/reconnect-token$/);
  if (req.method === 'POST' && reconnectTokenMatch) {
    const human = await auth.getHuman(req);
    if (!await canManageInbox(human, inbox)) return fail(res, 403, 'Workspace administrator required');
    const agentId = assertSafeIdentifier(reconnectTokenMatch[1], 'agentId');
    const agent = await store.getJson(path.join('inboxes', inboxId, 'agents', `${agentId}.json`));
    const reenroll = agent ? (await agentControlState(inboxId, agent)).credentialRevoked : false;
    if (inbox.ownerAgentId !== agentId || !agent || !reenroll && (!['active', 'paused'].includes(agent.status) || agent.onboardingStatus !== 'approved')) {
      return fail(res, 404, 'Enrolled agent not found');
    }
    const input = await body(req);
    const runtime = validateConnectorRuntime(input.runtime, agent.runtime || 'openclaw');
    const permissions = reenroll ? (Array.isArray(input.permissions) ? input.permissions : ['send_agent_messages', 'receive_agent_messages']).filter(permission => allowedPermissions.has(permission)) : null;
    if (reenroll && !permissions.includes('receive_agent_messages')) permissions.push('receive_agent_messages');
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const record = { id: store.id('enrollment'), kind: reenroll ? 'reenroll' : 'reconnect', runtime, tokenHash: hashSecret(rawToken), inboxId, organizationId: inbox.organizationId, humanId: human.id, agentId, accessGeneration: agent.accessGeneration || 0, ...(reenroll ? { permissions } : {}), createdAt: store.now(), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), usedAt: null };
    await store.putJsonBatch([
      document(path.join('auth', 'enrollment-tokens', `${record.tokenHash}.json`), record),
      document(enrollmentIndexPath(inboxId, record.id), { enrollmentId: record.id, tokenHash: record.tokenHash })
    ]);
    await audit(inboxId, reenroll ? 'agent.reenroll_token_created' : 'agent.reconnect_token_created', { enrollmentId: record.id, agentId, humanId: human.id, ...(reenroll ? { permissions } : {}) });
    const publicUrl = new URL(publicBaseUrl(req)).origin;
    const quickConnect = { version: 1, runtime, operation: 'reconnect', apiUrl: publicUrl, enrollmentToken: rawToken, expiresAt: record.expiresAt, agentName: agent.name, address: agent.address };
    return json(res, 201, { enrollmentId: record.id, quickConnect, enrollmentToken: rawToken, enrollmentUrl: `${publicUrl}/?enroll=${encodeURIComponent(rawToken)}`, expiresAt: record.expiresAt, agentId, address: agent.address, ...(reenroll ? { permissions } : {}) });
  }

  if (req.method === 'GET' && suffix === 'calendar-connectors') {
    const human = await auth.getHuman(req);
    if (!await canAccessInbox(human, inbox)) return fail(res, 403, 'Workspace membership required');
    const connectors = await store.listJson(path.join('inboxes', inboxId, 'calendar-connectors'));
    return json(res, 200, { providers: calendarProviderStatus(), connectors: connectors.map(publicCalendarConnector) });
  }

  const calendarConnectorRoute = suffix.match(/^calendar-connectors\/(google|outlook)\/(connect|disconnect)$/);
  if (req.method === 'POST' && calendarConnectorRoute) {
    const human = await auth.getHuman(req);
    if (!await canManageInbox(human, inbox)) return fail(res, 403, 'Workspace administrator required');
    const [, providerId, action] = calendarConnectorRoute;
    const provider = calendarProviders[providerId];
    if (action === 'disconnect') {
      const existing = await store.getJson(calendarConnectorPath(inboxId, providerId));
      if (!existing) return fail(res, 404, 'Calendar connector not found');
      const disconnected = { ...existing, status: 'disconnected', tokenSetEncrypted: null, refreshTokenPresent: false, updatedAt: store.now(), disconnectedAt: store.now(), disconnectedByHumanId: human.id };
      await store.putJson(calendarConnectorPath(inboxId, providerId), disconnected);
      await audit(inboxId, 'calendar.disconnected', { provider: providerId, humanId: human.id });
      return json(res, 200, publicCalendarConnector(disconnected));
    }
    if (!provider.clientId || !provider.clientSecret) return fail(res, 503, `${provider.label} is not configured`);
    const state = crypto.randomBytes(32).toString('base64url');
    const pkce = createPkcePair();
    const publicUrl = (process.env.ENVOI_PUBLIC_URL || `http://${req.headers.host || `${host}:${port}`}`).replace(/\/$/, '');
    const stateRecord = { provider: providerId, inboxId, humanId: human.id, codeVerifier: pkce.verifier, returnTo: `${publicUrl}/app?workspace=${encodeURIComponent(inboxId)}`, createdAt: store.now(), expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), usedAt: null };
    await store.putJson(path.join('auth', 'calendar-oauth', `${hashSecret(state)}.json`), stateRecord);
    const authorizationUrl = new URL(provider.authorizeUrl);
    authorizationUrl.searchParams.set('client_id', provider.clientId);
    authorizationUrl.searchParams.set('redirect_uri', calendarRedirectUri(providerId, req));
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('scope', provider.scopes.join(' '));
    authorizationUrl.searchParams.set('state', state);
    authorizationUrl.searchParams.set('code_challenge', pkce.challenge);
    authorizationUrl.searchParams.set('code_challenge_method', pkce.method);
    if (providerId === 'google') {
      authorizationUrl.searchParams.set('access_type', 'offline');
      authorizationUrl.searchParams.set('include_granted_scopes', 'true');
      authorizationUrl.searchParams.set('prompt', 'consent');
    } else {
      authorizationUrl.searchParams.set('response_mode', 'query');
    }
    await audit(inboxId, 'calendar.connection_started', { provider: providerId, humanId: human.id });
    return json(res, 201, { provider: providerId, authorizationUrl: authorizationUrl.toString(), expiresAt: stateRecord.expiresAt });
  }

  if (req.method === 'GET' && suffix === 'email-transport') {
    const contacts = await store.listJson(path.join('inboxes', inboxId, 'external-contacts'));
    const agents = await store.listJson(path.join('inboxes', inboxId, 'agents'));
    return json(res, 200, publicEmailTransportProjection(agents, contacts));
  }

  if (req.method === 'GET' && suffix === 'external-contacts') {
    const contacts = await store.listJson(path.join('inboxes', inboxId, 'external-contacts'));
    return json(res, 200, contacts.sort((left, right) => String(left.email).localeCompare(String(right.email))));
  }

  if (req.method === 'POST' && suffix === 'external-contacts') {
    const human = await auth.getHuman(req);
    if (!await canManageInbox(human, inbox)) return fail(res, 403, 'Workspace administrator required');
    const input = await body(req);
    const email = normalizedEmail(input.email);
    if (!validEmail(email)) return fail(res, 400, 'A valid external email address is required');
    if (emailTransport.publicDomain && email.endsWith(`@${emailTransport.publicDomain}`)) return fail(res, 400, 'Envoi agents must communicate over the native transport');
    const direction = input.direction || 'both';
    if (!['inbound', 'outbound', 'both'].includes(direction)) return fail(res, 400, 'direction must be inbound, outbound, or both');
    const existing = await store.getJson(externalContactPath(inboxId, email));
    const now = store.now();
    const contact = { id: `external_contact_${externalContactKey(email)}`, type: 'externalHuman', email, displayName: String(input.displayName || existing?.displayName || email).trim().slice(0, 120), direction, approved: true, blocked: false, approvedByHumanId: human.id, approvedAt: existing?.approvedAt || now, createdAt: existing?.createdAt || now, updatedAt: now };
    await store.putJson(externalContactPath(inboxId, email), contact);
    await audit(inboxId, existing ? 'external_contact.updated' : 'external_contact.approved', { contactId: contact.id, email, direction, humanId: human.id });
    return json(res, existing ? 200 : 201, contact);
  }

  const externalContactControl = suffix.match(/^external-contacts\/(external_contact_[a-f0-9]{40})\/(block|unblock)$/);
  if (req.method === 'POST' && externalContactControl) {
    const human = await auth.getHuman(req);
    if (!await canManageInbox(human, inbox)) return fail(res, 403, 'Workspace administrator required');
    const contacts = await store.listJson(path.join('inboxes', inboxId, 'external-contacts'));
    const contact = contacts.find(item => item.id === externalContactControl[1]);
    if (!contact) return fail(res, 404, 'External contact not found');
    const blocked = externalContactControl[2] === 'block';
    const updated = { ...contact, blocked, blockedReason: blocked ? 'human_control' : null, updatedAt: store.now() };
    await store.putJson(externalContactPath(inboxId, contact.email), updated);
    await audit(inboxId, blocked ? 'external_contact.blocked' : 'external_contact.unblocked', { contactId: contact.id, email: contact.email, humanId: human.id });
    return json(res, 200, updated);
  }

  if (req.method === 'GET' && suffix === 'events/delta') {
    const human = await auth.getHuman(req);
    const agent = await getAgentPrincipal(req, inboxId);
    if (!await canAccessInbox(human, inbox) && !agent) {
      await rejectAgentToken(req);
      return fail(res, 401, 'Authenticated inbox participant required');
    }
    const rawLimit = url.searchParams.get('limit');
    const limit = rawLimit === null ? 100 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw codedError(400, 'EVENT_LIMIT_INVALID', 'The event page limit must be an integer from 1 to 200.');
    const { cursor } = await resumeEventCursor(inboxId, url.searchParams.get('cursor') || '');
    return json(res, 200, await eventPage(inboxId, { cursor, limit }));
  }

  if (req.method === 'GET' && suffix === 'events') {
    const human = await auth.getHuman(req);
    const agent = await getAgentPrincipal(req, inboxId);
    if (!await canAccessInbox(human, inbox) && !agent) {
      await rejectAgentToken(req);
      return fail(res, 401, 'Authenticated inbox participant required');
    }
    const humanSession = human ? await auth.getSession(req) : null;
    if (human && !humanSession) return fail(res, 401, 'Authenticated human session required');
    const sessionLease = human && auth.captureSessionLease ? await auth.captureSessionLease(req) : humanSession;
    const sessionCookieValue = parseCookies(req.headers.cookie)[sessionCookieName()];
    const sessionKey = human ? auth.provider === 'workos' ? sessionLease?.sessionId : hashSecret(sessionCookieValue) : null;
    // Last-Event-ID wins over ?cursor=; an empty value means no cursor. from=latest starts live.
    const resume = await resumeEventCursor(inboxId, String(req.headers['last-event-id'] || url.searchParams.get('cursor') || ''));
    const cursor = resume.cursor;
    const startCursor = !cursor && url.searchParams.get('from') === 'latest' ? resume.newest || '' : cursor;
    // The installation this stream belongs to, so ending one installation closes only its
    // streams. Read before the connection is counted: nothing may await between the count and
    // the close listener.
    const streamFamilyId = agent && !human ? (await store.getJson(agentCredentialPath(hashSecret(bearerToken(req)))))?.familyId || null : null;
    const connectionKey = rateIdentity(req);
    if (Number(sseCounts.get(connectionKey) || 0) >= maxSsePerPrincipal) {
      res.setHeader('retry-after', '30');
      throw codedError(429, 'RATE_LIMITED', 'Too many concurrent event streams. Retry after the indicated delay.', { retryAfterSeconds: 30 });
    }
    sseCounts.set(connectionKey, Number(sseCounts.get(connectionKey) || 0) + 1);
    req.setTimeout(0);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'private, no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    // a5-presence §3: only the connect counts; holding the stream open never refreshes presence.
    flushAgentPresence(req, res);
    const subscription = { res, cursor: startCursor, sentIds: new Set(), heartbeat: null, expiryTimer: null, sessionKey, agentId: agent?.id || null, humanId: human?.id || null, replaying: true, buffer: new Map(), overflow: false };
    if (agent && !human) {
      subscription.familyId = streamFamilyId;
      // Re-check the credential on every heartbeat: pause keeps the stream, revocation or expiry ends it.
      const credentialRequest = { headers: { authorization: req.headers.authorization }, method: 'GET' };
      subscription.credentialEnded = async () => {
        const resolved = await resolveAgentCredential(credentialRequest, { inboxId, tokenTypes: ['access'] });
        if (!['CREDENTIAL_REVOKED', 'CREDENTIAL_EXPIRED'].includes(resolved.error?.code)) return null;
        return { code: resolved.error.code, ...(resolved.error.publicFields?.reason ? { reason: resolved.error.publicFields.reason } : {}) };
      };
    }
    const set = streams.get(inboxId) || new Set(); set.add(subscription); streams.set(inboxId, set);
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(subscription.heartbeat);
      clearTimeout(subscription.expiryTimer);
      set.delete(subscription);
      if (!set.size) streams.delete(inboxId);
      const remaining = Math.max(0, Number(sseCounts.get(connectionKey) || 1) - 1);
      if (remaining) sseCounts.set(connectionKey, remaining); else sseCounts.delete(connectionKey);
    };
    res.on('close', cleanup);
    subscription.close = (event, data = {}) => {
      if (cleaned) return;
      if (event && !res.destroyed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      cleanup();
      res.end();
    };
    subscription.authFailureEvent = auth.provider === 'workos' ? 'session.recheck' : 'session.expired';
    if (human) {
      subscription.authorize = async () => {
        const valid = auth.validateSessionLease
          ? await auth.validateSessionLease(sessionLease)
          : Boolean(await auth.getSession({ headers: { cookie: `${sessionCookieName()}=${encodeURIComponent(sessionCookieValue)}` } }));
        // An open stream must not trust one WorkOS answer for its whole lifetime.
        return valid && await canAccessInbox(human, inbox, { maxAgeMs: streamMembershipRecheckMs });
      };
      const remaining = new Date(sessionLease?.expiresAt).getTime() - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 0) {
        subscription.close(subscription.authFailureEvent);
        return;
      }
      // A new HTTP connection can renew its cookie; an open stream cannot.
      subscription.expiryTimer = setTimeout(() => subscription.close(subscription.authFailureEvent), Math.min(remaining, 2_147_483_647));
      subscription.expiryTimer.unref?.();
    }
    const resumeReplay = () => {
      // No id field: reconnect from the last actual event, never beyond it.
      if (!res.destroyed) res.write(`event: replay_required\ndata: ${JSON.stringify({ cursor: subscription.cursor || null, hasMore: true })}\n\n`);
      cleanup(); res.end();
    };
    try {
      let hasMore = false;
      for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
        const page = await eventPage(inboxId, { cursor: subscription.cursor, limit: 100 });
        if (cleaned) return;
        for (const event of page.events) await sendStreamEvent(subscription, event);
        if (cleaned) return;
        hasMore = page.hasMore;
        if (!hasMore || subscription.overflow) break;
      }
      if (hasMore || subscription.overflow) { resumeReplay(); return; }
      const buffered = [...subscription.buffer.values()].map(normalizeStreamEvent).sort((a, b) => a.cursor.localeCompare(b.cursor));
      for (const event of buffered) {
        if (!startCursor || event.cursor > startCursor) await sendStreamEvent(subscription, event);
      }
      if (cleaned) return;
      subscription.buffer.clear();
      subscription.replaying = false;
      res.write(`event: ready\ndata: ${JSON.stringify({ inboxId, at: store.now(), cursor: subscription.cursor || startCursor || null })}\n\n`);
      subscription.heartbeat = setInterval(async () => {
        try {
          if (subscription.authorize && !await subscription.authorize()) return subscription.close(subscription.authFailureEvent);
          const ended = subscription.credentialEnded && await subscription.credentialEnded();
          if (ended) return subscription.close('credential.ended', ended);
          if (!cleaned && !res.destroyed && !res.writableEnded) res.write(`: keepalive ${store.now()}\n\n`);
        } catch { subscription.close('replay_error'); }
      }, 20_000);
      subscription.heartbeat.unref?.();
    } catch (error) {
      subscription.close('replay_error');
    }
    return;
  }

  if (req.method === 'GET' && suffix === '') return json(res, 200, inbox);

  if (req.method === 'GET' && suffix === 'human-view') {
    const human = await auth.getHuman(req);
    if (!await canAccessInbox(human, inbox)) return fail(res, 403, 'Workspace membership required');
    const [view, requesterCanManage] = await Promise.all([
      humanView(inboxId, inbox, parseHistoryCursors(url.searchParams.get('history'))),
      canManageInbox(human, inbox)
    ]);
    const session = await auth.getSession(req);
    if (!session) return fail(res, 401, 'Authenticated human session required');
    const requester = { id: human.id, auth: { provider: auth.provider, assurance: session.assurance || 'provider' } };
    const preferences = await getPrefsForCases(store, { scopeMode: 'personal', organizationId: inbox.organizationId, humanId: human.id, inboxId, cases: view.caseQueue });
    const personalizedView = attachInboxPreferencesToView(view, preferences);
    return json(res, 200, { ...personalizedView, canManageInbox: requesterCanManage, requester });
  }

  if (req.method === 'GET' && suffix === 'agent-view') {
    const human = await auth.getHuman(req);
    const agentPrincipal = await getAgentPrincipal(req, inboxId);
    if (!await canAccessInbox(human, inbox) && agentPrincipal?.id !== url.searchParams.get('agentId')) return fail(res, 403, 'Authenticated inbox participant required');
    const view = await agentView(inboxId, inbox, url.searchParams.get('agentId'));
    return view ? json(res, 200, view) : fail(res, 404, 'Agent not found');
  }

  if (req.method === 'POST' && suffix === 'agents') {
    const input = await body(req);
    const human = await auth.getHuman(req);
    if (!await canManageInbox(human, inbox)) return fail(res, 403, 'Workspace administrator required');
    input.humanId = human.id;
    if (!input.name) return fail(res, 400, 'Agent name is required');
    if (!input.humanId) return fail(res, 400, 'humanId is required so a human can approve the agent');
    const slug = slugify(input.slug || input.name) || store.id('agent').replace('agent_', '');
    const address = `${slug}@${agentDomain}`;
    if (!await reserveIdentity(address, { status: 'reserved' })) return fail(res, 409, 'Agent email address is already registered');
    const agent = { id: store.id('agent'), name: input.name, slug, address, identity: publicIdentity(slug), principalHumanId: input.humanId, capabilities: input.capabilities || [], permissions: [], createdAt: store.now(), status: 'pending_approval', onboardingStatus: 'pending_approval' };
    const agentInbox = await createDedicatedAgentInbox({ sourceInbox: inbox, organizationId: inbox.organizationId, ownerHumanId: input.humanId, agent });
    await audit(agentInbox.id, 'agent.created', { agentId: agent.id, sourceInboxId: inbox.id });
    await audit(inbox.id, 'agent.inbox_created', { agentId: agent.id, inboxId: agentInbox.id, humanId: input.humanId });
    return json(res, 201, { agent: publicAgent(agent), inbox: agentInbox });
  }

  if (req.method === 'POST' && suffix === 'agent-onboarding') {
    const input = await body(req);
    const human = await auth.getHuman(req);
    if (!await canManageInbox(human, inbox)) return fail(res, 403, 'Workspace administrator required');
    input.humanId = human.id;
    if (!input.name) return fail(res, 400, 'Agent name is required');
    const slug = slugify(input.slug || input.name);
    if (!slug) return fail(res, 400, 'A valid agent slug is required');
    const address = `${slug}@${agentDomain}`;
    if (!await reserveIdentity(address, { status: 'reserved' })) return fail(res, 409, 'Agent email address is already registered');
    if (!input.humanId) return fail(res, 400, 'humanId is required so a human can approve the agent');
    const agent = { id: store.id('agent'), name: input.name, slug, address, identity: publicIdentity(slug), principalLabel: input.principalLabel || null, principalHumanId: input.humanId, capabilities: input.capabilities || [], permissions: [], description: input.description || null, createdAt: store.now(), status: 'pending_approval', onboardingStatus: 'pending_approval' };
    const agentInbox = await createDedicatedAgentInbox({ sourceInbox: inbox, organizationId: inbox.organizationId, ownerHumanId: input.humanId, agent });
    await audit(agentInbox.id, 'agent.onboarded', { agentId: agent.id, address: agent.address, identityStatus: agent.identity.status, sourceInboxId: inbox.id });
    await audit(inbox.id, 'agent.inbox_created', { agentId: agent.id, inboxId: agentInbox.id, humanId: input.humanId });
    return json(res, 201, { agent: publicAgent(agent), inbox: agentInbox, next: { nativeMessaging: 'pending_human_approval', humanApproval: { required: true, humanId: input.humanId }, externalEmail: 'requires_email_transport_configuration' } });
  }

  if (req.method === 'GET' && suffix === 'agents') {
    // a5-presence §4.2: connection is for the owning workspace's humans; the agent's own token gets none.
    const ownerView = await canAccessInbox(await auth.getHuman(req), inbox);
    const agents = await store.listJson(path.join('inboxes', inboxId, 'agents'));
    return json(res, 200, await Promise.all(agents.map(agent => (ownerView ? ownerAgentState : agentControlState)(inboxId, agent))));
  }

  const agentControlMatch = suffix.match(/^agents\/([^/]+)\/(pause|resume)$/);
  if (req.method === 'POST' && agentControlMatch) {
    const human = await auth.getHuman(req);
    if (!await canManageInbox(human, inbox)) return fail(res, 403, 'Authenticated workspace administrator required');
    const agentId = assertSafeIdentifier(agentControlMatch[1], 'agentId');
    const action = agentControlMatch[2];
    const result = await withInboxMutation(inboxId, async writeAudit => {
      if (!await canManageInbox(await auth.getHuman(req), inbox)) throw Object.assign(new Error('Authenticated workspace administrator required'), { statusCode: 403 });
      const agentPath = path.join('inboxes', inboxId, 'agents', `${agentId}.json`);
      const agent = await store.getJson(agentPath);
      if (!agent || inbox.ownerAgentId !== agentId) throw Object.assign(new Error('Owned agent not found'), { statusCode: 404 });
      if (action === 'pause' && !['active', 'paused'].includes(agent.status) || action === 'resume' && agent.status !== 'paused') throw Object.assign(new Error('Agent control transition is unavailable'), { statusCode: 409 });
      if (action === 'resume') {
        const state = await agentControlState(inboxId, agent);
        if (state.credentialRevoked) throw Object.assign(new Error('Revoked credentials cannot be resumed'), { statusCode: 409 });
      }
      const status = action === 'pause' ? 'paused' : 'active';
      if (agent.status !== status) {
        agent.status = status;
        agent.updatedAt = store.now();
        // a5-presence §4.2: the resume grace keeps the paused-time basis until the connector claims.
        if (action === 'resume') agent.resumedAt = agent.updatedAt;
        await store.putJsonBatch([
          document(agentPath, agent),
          document(path.join('directory', 'agents', `${agentId}.json`), { agentId, inboxId, address: agent.address, externalAddress: externalEmailEnabled ? publicEmailAddressForAgent(agent) : null, status, verified: true }),
          document(nativeAddressDirectoryPath(agent.address), { agentId, inboxId, address: agent.address, status, verified: true })
        ]);
        await writeAudit(`agent.${action}d`, { agentId, humanId: human.id, status });
        const at = store.now();
        if (action === 'pause') {
          const held = await store.holdQueuedOutbox({ senderInboxId: inboxId, reason: 'sender_paused', heldAt: at });
          await store.putJsonBatch((await Promise.all(held.map(record => heldMessageDocuments(record, 'sender_paused', at)))).flat());
          // A lease claimed before the pause can no longer settle. The work is offered again on
          // resume as the same attempt, so the pause never costs one.
          const claims = await store.listJson(path.join('inboxes', inboxId, 'work-claims'));
          await store.putJsonBatch(claims
            .filter(claim => claim.agentId === agentId && ['claimed', 'acknowledged'].includes(claim.status) && new Date(claim.leaseExpiresAt) > new Date(at))
            .map(claim => document(workClaimPath(inboxId, claim.workId), { ...releasedClaim(claim, at), pausedAt: at })));
          await caseSessions.endForAgent(inboxId, agentId, 'agent_paused', at, writeAudit);
        } else {
          await releaseHeldSends(inboxId, at);
          if (await hasClaimableInbound(inboxId, agentId)) await writeAudit('work.available', { agentId, reason: 'agent_resumed' });
        }
      }
      return agentControlState(inboxId, agent);
    });
    if (action === 'resume') {
      deliveryWorker.kick();
      // Counterparties could not claim work this agent had sent while it could not act.
      const sent = await store.listJson(path.join('inboxes', inboxId, 'messages'));
      const recipients = new Map(sent.filter(message => message.senderAgentId === agentId && message.recipientInboxId && message.recipientInboxId !== inboxId && message.recipientAgentId)
        .map(message => [message.recipientInboxId, message.recipientAgentId]));
      for (const [recipientInboxId, recipientAgentId] of recipients) {
        if (await hasClaimableInbound(recipientInboxId, recipientAgentId, { senderAgentId: agentId })) {
          await audit(recipientInboxId, 'work.available', { agentId: recipientAgentId, reason: 'counterparty_resumed' }).catch(() => {});
        }
      }
    }
    return json(res, 200, await withOwnerConnection(inboxId, result));
  }

  const cancelMatch = suffix.match(/^messages\/([^/]+)\/cancel$/);
  if (req.method === 'POST' && cancelMatch) {
    const human = await auth.getHuman(req);
    if (!await canManageInbox(human, inbox)) return fail(res, 403, 'Authenticated workspace administrator required');
    const messageId = assertSafeIdentifier(cancelMatch[1], 'messageId');
    const cancelled = await withInboxMutation(inboxId, async writeAudit => {
      const message = await store.getJson(messagePath(inboxId, messageId));
      const outbox = await store.getOutbox(`delivery_${messageId}`);
      if (!message || !outbox || outbox.senderInboxId !== inboxId || outbox.status !== 'held') throw Object.assign(new Error('Held message not found'), { statusCode: 404 });
      const at = store.now();
      const { heldReason: _reason, heldAt: _heldAt, ...rest } = message;
      const updated = { ...rest, status: 'cancelled', cancelledAt: at, cancelledByHumanId: human.id, updatedAt: at };
      // Cancelling releases the case barrier without resuming the agent.
      if (!await store.cancelHeldOutbox(outbox.id, [document(messagePath(inboxId, messageId), updated)])) throw Object.assign(new Error('Held message not found'), { statusCode: 404 });
      await writeAudit('message.cancelled', { messageId, caseId: message.caseId, humanId: human.id }, at);
      return updated;
    });
    deliveryWorker.kick();
    return json(res, 200, cancelled);
  }

  if (req.method === 'GET' && suffix === 'held-work') {
    const human = await auth.getHuman(req);
    if (!await canManageInbox(human, inbox)) return fail(res, 403, 'Authenticated workspace administrator required');
    const held = await store.queryOutbox({ senderInboxId: inboxId, status: 'held', limit: 200 });
    let truncated = held.length === 200;
    const items = held.map(record => ({ messageId: record.messageId, caseId: record.orderingKey, status: 'held', heldReason: record.heldReason, heldAt: record.heldAt }));
    // D1: later items in a case with a held message wait behind it, in both directions.
    for (const caseId of new Set(held.map(record => record.orderingKey).filter(Boolean))) {
      const first = held.filter(record => record.orderingKey === caseId).sort((a, b) => Number(a.sequence) - Number(b.sequence))[0];
      const waiting = await store.queryOutbox({ orderingKey: caseId, limit: 200 });
      if (waiting.length === 200) truncated = true;
      for (const record of waiting) {
        if (!['queued', 'retrying'].includes(record.status) || Number(record.sequence) <= Number(first.sequence)) continue;
        items.push({ messageId: record.messageId, caseId, status: 'held', heldReason: 'case_ordering', heldAt: record.createdAt, heldBehindMessageId: first.messageId });
      }
    }
    const oldestHeldAt = items.map(item => item.heldAt).filter(Boolean).sort()[0] || null;
    return json(res, 200, { heldCount: items.length, oldestHeldAt, truncated, items });
  }

  const blockMatch = suffix.match(/^contacts\/([^/]+)\/(block|unblock)$/);
  if (req.method === 'POST' && blockMatch) {
    const human = await auth.getHuman(req);
    if (!await canManageInbox(human, inbox)) return fail(res, 403, 'Authenticated workspace administrator required');
    const [, agentId, action] = blockMatch;
    const directory = await store.getJson(path.join('directory', 'agents', `${agentId}.json`));
    const contact = await withInboxMutation(inboxId, async writeAudit => {
      if (!await canManageInbox(await auth.getHuman(req), inbox)) throw Object.assign(new Error('Authenticated workspace administrator required'), { statusCode: 403 });
      const existing = await store.getJson(path.join('inboxes', inboxId, 'contacts', `${agentId}.json`), { agentId, approved: true });
      const updated = { ...existing, agentId, blocked: action === 'block', updatedAt: store.now() };
      await store.putJson(path.join('inboxes', inboxId, 'contacts', `${agentId}.json`), updated);
      await writeAudit(`contact.${action}ed`, { agentId, actorType: 'human', actorHumanId: human.id });
      return updated;
    }, directory?.inboxId ? [directory.inboxId] : []);
    return json(res, 200, contact);
  }

  const approveMatch = suffix.match(/^contacts\/([^/]+)\/approve$/);
  if (req.method === 'POST' && approveMatch) {
    const human = await auth.getHuman(req);
    if (!await canManageInbox(human, inbox)) return fail(res, 403, 'Workspace administrator required');
    const [, agentId] = approveMatch;
    if (!await store.getJson(path.join('inboxes', inboxId, 'agents', `${agentId}.json`))) return fail(res, 404, 'Agent not found');
    const existing = await store.getJson(path.join('inboxes', inboxId, 'contacts', `${agentId}.json`));
    const contact = { ...existing, agentId, approved: true, blocked: existing?.blocked === true, updatedAt: store.now() };
    await store.putJson(path.join('inboxes', inboxId, 'contacts', `${agentId}.json`), contact);
    await audit(inboxId, 'contact.approved', { agentId });
    return json(res, 200, contact);
  }

  const onboardingDecision = suffix.match(/^agent-onboarding\/([^/]+)\/(approve|reject)$/);
  if (req.method === 'POST' && onboardingDecision) {
    const [, agentId, decision] = onboardingDecision;
    const input = await body(req);
    const human = await auth.getHuman(req);
    if (!human) return fail(res, 401, 'Verified human session required');
    const existingAgent = await store.getJson(path.join('inboxes', inboxId, 'agents', `${agentId}.json`));
    if (!existingAgent) return fail(res, 404, 'Agent not found');
    if (!await canAccessInbox(human, inbox)) return fail(res, 403, 'Active workspace membership required');
    if (human.id !== (existingAgent.principalHumanId || inbox.ownerHumanId) && !await canManageInbox(human, inbox)) return fail(res, 403, 'Only the linked human or a workspace administrator may approve this agent');
    const result = await withInboxMutation(inboxId, async writeAudit => {
      const agent = await store.getJson(path.join('inboxes', inboxId, 'agents', `${agentId}.json`));
      if (!agent) throw Object.assign(new Error('Agent not found'), { statusCode: 404 });
      if (decision === 'approve' && agent.status !== 'pending_approval') throw Object.assign(new Error('Agent onboarding is already decided'), { statusCode: 409 });
      let credentials = null;
      if (decision === 'reject') {
        agent.status = 'rejected';
        agent.onboardingStatus = 'rejected';
        agent.permissions = [];
        await revokeAgentCredentialFamilies(inboxId, agent.id, human.id, store.now(), 'revoked', writeAudit);
        await store.putJsonBatch([
          document(path.join('directory', 'agents', `${agent.id}.json`), { agentId: agent.id, inboxId, address: agent.address, externalAddress: externalEmailEnabled ? publicEmailAddressForAgent(agent) : null, status: agent.status, verified: true }),
          document(nativeAddressDirectoryPath(agent.address), { agentId: agent.id, inboxId, address: agent.address, status: agent.status, verified: true })
        ]);
        if (externalEmailEnabled && publicEmailAddressForAgent(agent)) await store.putJson(externalAddressDirectoryPath(publicEmailAddressForAgent(agent)), { agentId: agent.id, inboxId, address: publicEmailAddressForAgent(agent), status: agent.status });
      } else {
        await assertActiveAgentSlot(agent.principalHumanId || inbox.ownerHumanId);
        const permissions = legacyApprovalPermissions(input.permissions);
        agent.status = 'active';
        agent.onboardingStatus = 'approved';
        agent.permissions = permissions;
        credentials = await issueAgentCredentials(agent.id, inboxId);
        await store.putJsonBatch([
          document(path.join('directory', 'agents', `${agent.id}.json`), { agentId: agent.id, inboxId, address: agent.address, externalAddress: externalEmailEnabled ? publicEmailAddressForAgent(agent) : null, status: agent.status, verified: true }),
          document(nativeAddressDirectoryPath(agent.address), { agentId: agent.id, inboxId, address: agent.address, status: agent.status, verified: true })
        ]);
        if (externalEmailEnabled && publicEmailAddressForAgent(agent)) await store.putJson(externalAddressDirectoryPath(publicEmailAddressForAgent(agent)), { agentId: agent.id, inboxId, address: publicEmailAddressForAgent(agent), status: agent.status });
        await store.putJson(path.join('inboxes', inboxId, 'inbox.json'), { ...inbox, status: 'active' });
      }
      agent.approvedAt = store.now();
      agent.approvedByHumanId = human.id;
      await store.putJson(path.join('inboxes', inboxId, 'agents', `${agent.id}.json`), agent);
      await writeAudit(`agent.onboarding_${decision}ed`, { agentId: agent.id, humanId: human.id, permissions: agent.permissions });
      return { agent, credentials };
    }, [], [humanAgentLimitKey(existingAgent.principalHumanId || inbox.ownerHumanId)]);
    if (decision === 'reject') closeAgentStreams(inboxId, agentId);
    return json(res, 200, { agent: publicAgent(result.agent), ...(result.credentials || {}) });
  }

  const removeAgent = suffix.match(/^agents\/([^/]+)\/remove$/);
  if (req.method === 'POST' && removeAgent) {
    const human = await auth.getHuman(req);
    if (!membershipCanManage(await getAuthorizedMembership(inbox.organizationId, human), auth.provider)) return fail(res, 403, 'Workspace administrator required');
    const agentId = assertSafeIdentifier(removeAgent[1], 'agentId');
    const input = await body(req);
    if (typeof input.deleteHistory !== 'boolean') return fail(res, 400, 'Choose whether to delete history');
    if (inbox.kind !== 'agent' || (inbox.ownerAgentId !== agentId && inbox.removedAgent?.id !== agentId)) return fail(res, 404, 'Owned agent not found');
    const assets = input.deleteHistory ? await store.listJson(path.join('inboxes', inboxId, 'assets')) : [];
    const result = await withInboxMutation(inboxId, async writeAudit => {
      const currentInbox = await store.getJson(path.join('inboxes', inboxId, 'inbox.json'));
      const agent = await store.getJson(path.join('inboxes', inboxId, 'agents', `${agentId}.json`));
      if (currentInbox.status === 'removed' && (!input.deleteHistory || currentInbox.historyDeleted)) return { removed: true, agentId, deletedHistory: currentInbox.historyDeleted, removedAt: currentInbox.removedAt };
      if (!agent && currentInbox.removedAgent?.id !== agentId) throw Object.assign(new Error('Owned agent not found'), { statusCode: 404 });
      if (input.deleteHistory && input.confirmation !== (agent?.name || currentInbox.removedAgent?.name)) throw Object.assign(new Error('Enter the agent name to confirm permanent deletion'), { statusCode: 400 });
      const removedAt = store.now();
      await cancelHeldSends(inboxId, human.id, removedAt, writeAudit);
      await revokeAgentCredentialFamilies(inboxId, agentId, human.id, removedAt, 'revoked', writeAudit);
      // a5-presence §1: removal deletes every presence record of the agent.
      await store.deleteJsonTree(agentPresenceDir(inboxId, agentId));
      presenceRecorder.forget(inboxId, agentId);
      if (agent) {
        await freezeAgentRecord(inboxId, agent, human.id, removedAt);
        await store.deleteJson(path.join('inboxes', inboxId, 'agents', `${agentId}.json`));
      }
      if (input.deleteHistory) {
        for (const session of await store.listJson(path.join('inboxes', inboxId, 'case-sessions'))) {
          if (session?.tokenHash) await store.deleteJson(caseSessionTokenPath(session.tokenHash));
        }
        const currentAssets = await store.listJson(path.join('inboxes', inboxId, 'assets'));
        if (currentAssets.some(asset => !assets.some(locked => locked.id === asset.id))) throw Object.assign(new Error('Files changed during removal; retry'), { statusCode: 409 });
        for (const asset of currentAssets) {
          const object = await objectStorage.metadataStore.get(asset.id);
          if (object?.workspaceId === inboxId) await objectStorage.requestRemoval(asset.id);
        }
        await store.deleteJsonTree(path.join('inboxes', inboxId));
      }
      await store.putJson(path.join('inboxes', inboxId, 'inbox.json'), { ...currentInbox, name: input.deleteHistory ? 'Removed agent' : currentInbox.name, ownerAgentId: null, status: 'removed', removedAt, historyDeleted: input.deleteHistory, removedAgent: { id: agentId, ...(input.deleteHistory ? {} : { name: agent?.name || currentInbox.removedAgent?.name }) } });
      await writeAudit('agent.removed', { agentId, humanId: human.id, deletedHistory: input.deleteHistory });
      return { removed: true, agentId, deletedHistory: input.deleteHistory, removedAt };
    }, [], assets.map(asset => `object-upload:${asset.id}`), true);
    closeAgentStreams(inboxId, agentId);
    if (input.deleteHistory) await objectStorage.reapExpiredUploads({ limit: 1000 }).catch(() => {});
    return json(res, 200, result);
  }

  const revokeAgentCredentials = suffix.match(/^agents\/([^/]+)\/credentials\/revoke$/);
  if (req.method === 'POST' && revokeAgentCredentials) {
    const human = await auth.getHuman(req);
    if (!await canManageInbox(human, inbox)) return fail(res, 403, 'Workspace administrator required');
    const agentId = revokeAgentCredentials[1];
    const agent = await store.getJson(path.join('inboxes', inboxId, 'agents', `${agentId}.json`));
    if (!agent || inbox.ownerAgentId !== agentId) return fail(res, 404, 'Owned agent not found');
    const revoked = await withInboxMutation(inboxId, async writeAudit => {
      const revokedAt = store.now();
      const current = await store.getJson(path.join('inboxes', inboxId, 'agents', `${agentId}.json`));
      if (!current || current.status === 'revoked') throw Object.assign(new Error('Agent is already revoked'), { statusCode: 409 });
      const credentialFamilyCount = await revokeAgentCredentialFamilies(inboxId, agentId, human.id, revokedAt, 'revoked', writeAudit);
      await cancelHeldSends(inboxId, human.id, revokedAt, writeAudit);
      await freezeAgentRecord(inboxId, current, human.id, revokedAt);
      await writeAudit('agent.credentials_revoked', { agentId, humanId: human.id, credentialFamilyCount });
      return { revoked: true, agentId, credentialFamilyCount, revokedAt };
    });
    closeAgentStreams(inboxId, agentId);
    return json(res, 200, revoked);
  }

  if (req.method === 'POST' && suffix === 'cases') {
    const principal = await getAgentPrincipal(req, inboxId);
    if (!principal || !canAct(principal, 'execute_cases')) return fail(res, 403, 'Agent credential with execute_cases permission required');
    const input = await body(req);
    if (!String(input.objective || '').trim()) return fail(res, 400, 'A structured case objective is required');
    const value = await withInboxMutation(inboxId, async writeAudit => {
      const currentPrincipal = await getAgentPrincipal(req, inboxId);
      if (!currentPrincipal || !canAct(currentPrincipal, 'execute_cases')) throw Object.assign(new Error('Agent credential with execute_cases permission required'), { statusCode: 403 });
      const now = store.now();
      const created = createAgentCase({ id: store.id('case'), objective: input.objective, collaborationMode: input.collaborationMode || 'collaboration', principal: inbox.ownerHumanId, actingAgent: currentPrincipal.id, participants: input.participants || [], constraints: input.constraints || {}, deadline: input.deadline || null, createdAt: now });
      if (!await store.putJsonIfAbsent(caseRecordPath(inboxId, created.id), created)) throw Object.assign(new Error('Case ID already exists'), { statusCode: 409 });
      await writeAudit('case.created', { caseId: created.id, actingAgent: currentPrincipal.id, objective: created.objective });
      return created;
    });
    return json(res, 201, value);
  }

  const instructionRoute = suffix.match(/^cases\/([^/]+)\/instructions$/);
  if (req.method === 'POST' && instructionRoute) {
    const human = await auth.getHuman(req);
    if (!human) return fail(res, 401, 'Authenticated human session required');
    if (!await canManageInbox(human, inbox)) return fail(res, 403, 'Workspace administrator required');
    const input = await body(req);
    const sendInstruction = createHumanInstructions({ store, withCaseMutation, authorizeHuman: async currentInbox => {
      const currentHuman = await auth.getHuman(req);
      if (!currentHuman || currentHuman.id !== human.id) throw Object.assign(new Error('Authenticated human session required'), { statusCode: 401 });
      if (!await canManageInbox(currentHuman, currentInbox, { maxAgeMs: 0 })) throw Object.assign(new Error('Workspace administrator required'), { statusCode: 403 });
      return currentHuman;
    } });
    const result = await sendInstruction({ inboxId, caseId: instructionRoute[1], input, idempotencyKey: req.headers['idempotency-key'] });
    return json(res, result.status, result.payload);
  }

  const caseRoute = suffix.match(/^cases\/([^/]+)(?:\/(events|actions|policy-evaluations|proposals|receipt))?$/);
  if (req.method === 'GET' && caseRoute && !caseRoute[2]) {
    const value = await getCase(inboxId, caseRoute[1]);
    return value ? json(res, 200, value) : fail(res, 404, 'Case not found');
  }

  if (req.method === 'POST' && caseRoute?.[2] === 'events') {
    const principal = await getAgentPrincipal(req, inboxId);
    if (!principal || !canAct(principal, 'execute_cases')) return fail(res, 403, 'Agent credential with execute_cases permission required');
    const input = await body(req);
    if (!['message', 'error'].includes(input.type)) return fail(res, 400, 'Direct event writes support only message or error; use actions for stateful work');
    const event = await withCaseMutation(inboxId, caseRoute[1], async writeAudit => {
      const currentPrincipal = await getAgentPrincipal(req, inboxId);
      if (!currentPrincipal || !canAct(currentPrincipal, 'execute_cases')) throw Object.assign(new Error('Agent credential with execute_cases permission required'), { statusCode: 403 });
      const value = await getCase(inboxId, caseRoute[1]);
      if (!value?.schemaVersion) throw Object.assign(new Error('Structured case not found'), { statusCode: 404 });
      if (!isCaseParticipant(value, currentPrincipal.id)) throw Object.assign(new Error('Case participant credential required'), { statusCode: 403 });
      const now = store.now();
      appendEvent(value, { id: store.id('evt'), type: input.type, actor: currentPrincipal.id, createdAt: now, payload: input.payload || {}, linkedPolicyEvaluation: input.linkedPolicyEvaluation || null, precedingEventRef: input.precedingEventRef || value.events.at(-1)?.id || null });
      await saveCase(inboxId, value);
      const appended = value.events.at(-1);
      await writeAudit('case.event_appended', { caseId: value.id, eventId: appended.id, eventType: input.type, actor: currentPrincipal.id });
      return appended;
    });
    return json(res, 201, event);
  }

  if (req.method === 'POST' && caseRoute?.[2] === 'policy-evaluations') {
    const principal = await getAgentPrincipal(req, inboxId);
    if (!principal || !canAct(principal, 'execute_cases')) return fail(res, 403, 'Agent credential with execute_cases permission required');
    const input = await body(req);
    if (!input.requestedAction) return fail(res, 400, 'requestedAction is required');
    const evaluation = await withCaseMutation(inboxId, caseRoute[1], async writeAudit => {
      const currentPrincipal = await getAgentPrincipal(req, inboxId);
      if (!currentPrincipal || !canAct(currentPrincipal, 'execute_cases')) throw Object.assign(new Error('Agent credential with execute_cases permission required'), { statusCode: 403 });
      const value = await getCase(inboxId, caseRoute[1]);
      if (!value?.schemaVersion) throw Object.assign(new Error('Structured case not found'), { statusCode: 404 });
      if (!isCaseParticipant(value, currentPrincipal.id)) throw Object.assign(new Error('Case participant credential required'), { statusCode: 403 });
      const now = store.now();
      const evaluationId = store.id('policy_eval');
      const evaluated = await evaluateServerPolicy(inboxId, currentPrincipal, value, { ...input, id: evaluationId }, { id: evaluationId });
      const created = policyEvaluationFromInput({ id: evaluationId, requestedAction: input.requestedAction, decision: evaluated.decision, matchedPolicyId: evaluated.matchedPolicyId, grantType: 'oneTime', expiresAt: evaluated.expiresAt, reasonCode: evaluated.reasonCode }, currentPrincipal.id, now);
      const updated = addPolicyEvaluation(value, created, { at: now });
      await saveCase(inboxId, updated);
      await store.putJson(policyBindingPath(inboxId, created.id), evaluated.binding);
      await writeAudit('policy.evaluated', { caseId: value.id, policyEvaluationId: created.id, requestedAction: created.requestedAction, decision: created.decision, reasonCode: created.reasonCode });
      return created;
    });
    return json(res, 201, evaluation);
  }

  if (req.method === 'POST' && caseRoute?.[2] === 'proposals') {
    const principal = await getAgentPrincipal(req, inboxId);
    if (!principal || !canAct(principal, 'execute_cases')) return fail(res, 403, 'Agent credential with execute_cases permission required');
    const input = await body(req);
    const proposal = await withCaseMutation(inboxId, caseRoute[1], async writeAudit => {
      const currentPrincipal = await getAgentPrincipal(req, inboxId);
      if (!currentPrincipal || !canAct(currentPrincipal, 'execute_cases')) throw Object.assign(new Error('Agent credential with execute_cases permission required'), { statusCode: 403 });
      const value = await getCase(inboxId, caseRoute[1]);
      if (!value?.schemaVersion) throw Object.assign(new Error('Structured case not found'), { statusCode: 404 });
      if (!isCaseParticipant(value, currentPrincipal.id)) throw Object.assign(new Error('Case participant credential required'), { statusCode: 403 });
      const now = store.now();
      const created = proposalFromInput(input, now);
      const updated = addProposal(value, created);
      appendEvent(updated, { id: store.id('evt'), type: 'decision', actor: currentPrincipal.id, createdAt: now, payload: { proposalId: created.id, status: created.status }, linkedPolicyEvaluation: null, precedingEventRef: updated.events.at(-1)?.id || null });
      await saveCase(inboxId, updated);
      await writeAudit('proposal.created', { caseId: value.id, proposalId: created.id, kind: created.kind, actor: currentPrincipal.id });
      return created;
    });
    return json(res, 201, proposal);
  }

  if (req.method === 'POST' && caseRoute?.[2] === 'actions') {
    const input = await body(req);
    const idempotencyKey = validateIdempotencyKey(req.headers['idempotency-key'] || input.idempotencyKey, { required: true });
    const human = await auth.getHuman(req);
    const principal = await getAgentPrincipal(req, inboxId);
    const humanCanManage = human ? await canManageInbox(human, inbox) : false;
    if (!humanCanManage && (!principal || !canAct(principal, 'execute_cases'))) return fail(res, 403, 'Workspace administrator or agent credential with execute_cases permission required');
    const response = await withCaseMutation(inboxId, caseRoute[1], async writeAudit => {
      const currentHuman = humanCanManage ? await auth.getHuman(req) : null;
      if (humanCanManage && (!currentHuman || currentHuman.id !== human.id || !await canManageInbox(currentHuman, inbox))) throw Object.assign(new Error('Authenticated workspace administrator required'), { statusCode: 403 });
      const currentPrincipal = humanCanManage ? null : await getAgentPrincipal(req, inboxId);
      if (!humanCanManage && (!currentPrincipal || !canAct(currentPrincipal, 'execute_cases'))) throw Object.assign(new Error('Agent credential with execute_cases permission required'), { statusCode: 403 });
      const value = await getCase(inboxId, caseRoute[1]);
      if (!value?.schemaVersion) throw Object.assign(new Error('Structured case not found'), { statusCode: 404 });
      const replayingAction = value.events.some(event => event.payload?.action?.idempotencyKey === idempotencyKey);
      if ((value.state === 'paused' || value.state === 'revoked') && !(humanCanManage && ['resume', 'revoke'].includes(input.actionKey)) && !replayingAction) throw codedError(409, 'CASE_CONTROLLED', 'This case is paused or revoked by a human.', { caseId: caseRoute[1] });
      const now = store.now();
      let result;
      if (humanCanManage) {
        const requestDigest = actionRequestDigest({ ...input, actor: human.id, outcome: 'ok' });
        const replayEvent = value.events.find(event => event.payload?.action?.idempotencyKey === idempotencyKey);
        if (replayEvent) {
          const replayAction = replayEvent.payload.action;
          if (replayAction.actor !== human.id || replayAction.externalRefs?.requestDigest !== requestDigest) throw Object.assign(new Error('Idempotency key was already used for a different action'), { statusCode: 409 });
          return { status: 200, result: { case: value, action: replayAction, replay: true } };
        }
        const scopedRequest = onboardingFlags.caseSessions && ['approveOnce', 'decline'].includes(input.actionKey)
          ? (await store.listJson(humanRequestDir(inboxId))).find(r => r.caseId === value.id && r.policyEvaluationId === input.externalRefs?.policyEvaluationId && r.status === 'pending') : null;
        let scopedBinding = null;
        if (onboardingFlags.caseSessions && input.actionKey === 'decline' && input.externalRefs?.policyEvaluationId && !scopedRequest) throw Object.assign(new Error('A current local human decision request is required'), { statusCode: 409 });
        if (scopedRequest) {
          scopedBinding = await store.getJson(policyBindingPath(inboxId, scopedRequest.policyEvaluationId));
          if (!scopedBinding || !verifyDecisionRecord(scopedBinding, { keyring: policyKeyring, requireSigned: true }) || scopedBinding.agentId !== scopedRequest.agentId || scopedBinding.caseId !== value.id || scopedBinding.expiresAt <= now) throw Object.assign(new Error('A current open human decision request is required'), { statusCode: 409 });
        }
        if (input.actionKey === 'approveOnce') {
          if (input.externalRefs?.requestedAction === 'case.complete' && !scopedRequest) {
            if (input.externalRefs?.policyEvaluationId) throw Object.assign(new Error('A current local human decision request is required'), { statusCode: 409 });
            if (value.state !== 'waitingForHuman' || typeof input.externalRefs?.result !== 'string' || !input.externalRefs.result.trim()) throw Object.assign(new Error('A pending case decision and result are required'), { statusCode: 409 });
          } else {
            const evaluationId = input.externalRefs?.policyEvaluationId;
            const evaluation = value.policyEvaluations.find(item => item.id === evaluationId);
            const binding = evaluation ? await store.getJson(policyBindingPath(inboxId, evaluationId)) : null;
            await policyDecisionChain(inboxId);
            if (!evaluationId || !evaluation || !binding || binding.workspaceId !== inboxId || binding.agentId !== inbox.ownerAgentId
              || onboardingFlags.caseSessions && ['proposal.accept', 'case.complete'].includes(binding.requestedAction) && !scopedRequest
              || !verifyDecisionRecord(binding, { keyring: policyKeyring, requireSigned: true }) || evaluation.decision !== 'needsHuman' || new Date(binding.expiresAt) <= new Date()) throw Object.assign(new Error('A current needsHuman policy evaluation is required for one-time approval'), { statusCode: 409 });
          }
        }
        const { serverAuthenticatedHuman: _ignoredHumanClaim, ...suppliedRefs } = input.externalRefs || {};
        const boundRefs = scopedBinding?.requestedAction === 'case.complete' ? { requestedAction: 'case.complete', result: scopedBinding.actionPayload.result } : {};
        result = applyHumanAction(value, { id: store.id('action'), actionKey: input.actionKey, actor: human.id, idempotencyKey, externalRefs: { ...suppliedRefs, ...boundRefs, caseId: value.id, sourceInboxId: inboxId, serverAuthenticatedHuman: true, requestDigest }, reasonCode: input.reasonCode || null },
          { at: now, preserveState: Boolean(scopedRequest && (input.actionKey === 'decline' || scopedBinding.requestedAction === 'proposal.accept')) });
        if (scopedRequest) await resolveCaseHumanRequest(scopedRequest, input.actionKey === 'approveOnce' ? 'approved' : 'declined', human.id, result.case, writeAudit);
      } else {
        if (currentPrincipal.id !== value.actingAgent || !isCaseParticipant(value, currentPrincipal.id)) throw Object.assign(new Error('Case participant credential required'), { statusCode: 403 });
        if (value.state === 'waitingForHuman' && input.nextState && input.nextState !== 'waitingForHuman') throw Object.assign(new Error('Authenticated human case decision is required'), { statusCode: 409 });
        const requestDigest = actionRequestDigest({ ...input, actor: currentPrincipal.id });
        const replayEvent = value.events.find(event => event.payload?.action?.idempotencyKey === idempotencyKey);
        if (replayEvent) {
          const replayAction = replayEvent.payload.action;
          if (replayAction.actor !== currentPrincipal.id || replayAction.externalRefs?.requestDigest !== requestDigest) throw Object.assign(new Error('Idempotency key was already used for a different action'), { statusCode: 409 });
          return { status: 200, result: { case: value, action: replayAction, replay: true } };
        }
        const { serverAuthenticatedHuman: _ignoredAgentClaim, ...agentRefs } = input.externalRefs || {};
        let policyExternalRefs = { ...agentRefs, requestDigest };
        const actionId = store.id('action');
        if (requiresPolicyEvaluation(input.actionKey)) {
          if (!input.policyEvaluationId) throw Object.assign(new Error('policyEvaluationId is required for policy-controlled or unknown agent actions'), { statusCode: 400 });
          const authorization = await validatedPolicyBinding(inboxId, value, currentPrincipal, input.policyEvaluationId, { requestedAction: input.actionKey, actionPayload: input.actionPayload || {}, executionId: actionId, writeAudit });
          policyExternalRefs = { ...policyExternalRefs, policyEvaluationId: input.policyEvaluationId, policyExecutionId: authorization.refreshed.id };
        }
        result = applyAgentAction(value, { id: actionId, actionKey: input.actionKey, actor: currentPrincipal.id, idempotencyKey, outcome: input.outcome, externalRefs: policyExternalRefs, reasonCode: input.reasonCode || null }, { at: now, nextState: input.nextState || null });
      }
      await saveCase(inboxId, result.case);
      if (!result.replay) await writeAudit('case.action_recorded', { caseId: value.id, actionId: result.action.id, actionKey: result.action.actionKey, actor: result.action.actor, outcome: result.action.outcome });
      // Whoever moved it there: a human pause, take-over, revoke or decline, or an agent's nextState.
      if (!result.replay && !['paused', 'revoked'].includes(value.state) && ['paused', 'revoked'].includes(result.case.state)) await releaseCaseWork(inboxId, value.id, now, writeAudit);
      if (!result.replay && humanCanManage && input.actionKey === 'resume' && (value.state === 'paused' || value.state === 'revoked')) {
        // Every participant whose agent has work waiting in this case is woken; no human identity is shared.
        const binding = await store.getJson(caseBindingPath(value.id));
        for (const participantInboxId of binding?.inboxIds?.length ? binding.inboxIds : [inboxId]) {
          const participantInbox = await store.getJson(path.join('inboxes', participantInboxId, 'inbox.json'));
          const participantAgentId = participantInbox?.ownerAgentId;
          if (participantAgentId && await hasClaimableInbound(participantInboxId, participantAgentId, { caseId: value.id })) {
            await writeAudit('work.available', { agentId: participantAgentId, reason: 'case_resumed', caseId: value.id }, now, participantInboxId);
          }
        }
      }
      return { status: result.replay ? 200 : 201, result };
    }, { allowPaused: true });
    return json(res, response.status, response.result);
  }

  const proposalRoute = suffix.match(/^cases\/([^/]+)\/proposals\/([^/]+)\/(counter|accept)$/);
  if (req.method === 'POST' && proposalRoute) {
    const principal = await getAgentPrincipal(req, inboxId);
    if (!principal || !canAct(principal, 'execute_cases')) return fail(res, 403, 'Agent credential with execute_cases permission required');
    const input = await body(req);
    const response = await withCaseMutation(inboxId, proposalRoute[1], async writeAudit => {
      const currentPrincipal = await getAgentPrincipal(req, inboxId);
      if (!currentPrincipal || !canAct(currentPrincipal, 'execute_cases')) throw Object.assign(new Error('Agent credential with execute_cases permission required'), { statusCode: 403 });
      const value = await getCase(inboxId, proposalRoute[1]);
      if (!value?.schemaVersion) throw Object.assign(new Error('Structured case not found'), { statusCode: 404 });
      if (!isCaseParticipant(value, currentPrincipal.id)) throw Object.assign(new Error('Case participant credential required'), { statusCode: 403 });
      const now = store.now();
      if (proposalRoute[3] === 'counter') {
        const options = proposalFromInput({ kind: value.proposals.find(item => item.id === proposalRoute[2])?.kind, options: input.options }, now).options;
        const updated = counterProposal(value, proposalRoute[2], { options, at: now });
        appendEvent(updated, { id: store.id('evt'), type: 'decision', actor: currentPrincipal.id, createdAt: now, payload: { proposalId: proposalRoute[2], status: 'countered', messageType: 'counterproposal' }, linkedPolicyEvaluation: null, precedingEventRef: updated.events.at(-1)?.id || null });
        await saveCase(inboxId, updated);
        await writeAudit('proposal.countered', { caseId: value.id, proposalId: proposalRoute[2], actor: currentPrincipal.id });
        return { status: 201, result: updated.proposals.find(item => item.id === proposalRoute[2]) };
      }
      const idempotencyKey = validateIdempotencyKey(req.headers['idempotency-key'] || input.idempotencyKey, { required: true });
      if (!input.optionId || !input.policyEvaluationId) throw Object.assign(new Error('optionId and policyEvaluationId are required'), { statusCode: 400 });
      const requestDigest = actionRequestDigest({ actor: currentPrincipal.id, actionKey: 'acceptProposal', outcome: null, policyEvaluationId: input.policyEvaluationId, externalRefs: { proposalId: proposalRoute[2], optionId: input.optionId } });
      const replayEvent = value.events.find(event => event.payload?.action?.idempotencyKey === idempotencyKey);
      if (replayEvent) {
        const replayAction = replayEvent.payload.action;
        if (replayAction.actor !== currentPrincipal.id || replayAction.externalRefs?.requestDigest !== requestDigest) throw Object.assign(new Error('Idempotency key was already used for a different action'), { statusCode: 409 });
        return { status: 200, result: { case: value, action: replayAction, replay: true } };
      }
      const evaluation = value.policyEvaluations.find(item => item.id === input.policyEvaluationId);
      if (!evaluation || evaluation.actor !== currentPrincipal.id) throw Object.assign(new Error('A case policy evaluation for this agent is required'), { statusCode: 403 });
      const actionId = store.id('action');
      const authorization = await validatedPolicyBinding(inboxId, value, currentPrincipal, evaluation.id, { proposalId: proposalRoute[2], optionId: input.optionId, executionId: actionId, allowPendingHuman: true, writeAudit });
      const effectiveEvaluation = evaluation.decision === 'needsHuman' && authorization.humanApproved ? { ...evaluation, decision: 'allow', reasonCode: 'humanApproved' } : evaluation;
      const result = acceptProposal(value, proposalRoute[2], input.optionId, effectiveEvaluation, { actor: currentPrincipal.id, idempotencyKey, actionId, externalRefs: { requestDigest, policyEvaluationId: evaluation.id, policyExecutionId: authorization.refreshed.phase === 'execution' ? authorization.refreshed.id : null }, at: now });
      await saveCase(inboxId, result.case);
      if (!result.replay) await writeAudit('proposal.accept_attempted', { caseId: value.id, proposalId: proposalRoute[2], optionId: input.optionId, actor: currentPrincipal.id, outcome: result.action.outcome });
      return { status: result.action.outcome === 'needsApproval' ? 202 : 201, result };
    });
    return json(res, response.status, response.result);
  }

  if (req.method === 'POST' && caseRoute?.[2] === 'receipt') {
    const principal = await getAgentPrincipal(req, inboxId);
    if (!principal || principal.id === undefined || !canAct(principal, 'execute_cases')) return fail(res, 403, 'Agent credential with execute_cases permission required');
    const input = await body(req);
    if (!input.result || !input.authorityBasis) return fail(res, 400, 'Receipt result and authorityBasis are required');
    const receipt = await withCaseMutation(inboxId, caseRoute[1], async writeAudit => {
      const currentPrincipal = await getAgentPrincipal(req, inboxId);
      if (!currentPrincipal || !canAct(currentPrincipal, 'execute_cases')) throw Object.assign(new Error('Agent credential with execute_cases permission required'), { statusCode: 403 });
      const value = await getCase(inboxId, caseRoute[1]);
      if (!value?.schemaVersion) throw Object.assign(new Error('Structured case not found'), { statusCode: 404 });
      if (!isCaseParticipant(value, currentPrincipal.id)) throw Object.assign(new Error('Case participant credential required'), { statusCode: 403 });
      const now = store.now();
      const verifiedDecision = verifiedHumanCaseDecision(value, input.authorityBasis, input.result);
      const approvalRequired = value.events.some(event => event.type === 'decision' && event.payload?.messageType === 'decision' && event.payload?.data?.decision?.kind === 'accept');
      if ((approvalRequired || value.state === 'waitingForHuman' || input.humanApprovalStatus === 'approved') && !verifiedDecision) throw Object.assign(new Error('Authenticated human case decision is required'), { statusCode: 409 });
      const created = { id: store.id('receipt'), result: input.result, counterparties: input.counterparties || [], externalIds: input.externalIds || {}, authorityBasis: verifiedDecision?.id || input.authorityBasis, humanApprovalStatus: verifiedDecision ? 'approved' : 'notRequired', evidenceRefs: input.evidenceRefs || [], createdAt: now };
      const updated = completeCase(value, created, { actor: currentPrincipal.id, at: now });
      await saveCase(inboxId, updated);
      await writeAudit('case.completed', { caseId: value.id, receiptId: created.id, actor: currentPrincipal.id });
      return created;
    });
    return json(res, 201, receipt);
  }

  if (req.method === 'GET' && suffix === 'cases') return json(res, 200, await listCases(inboxId, { limit: url.searchParams.get('limit'), before: url.searchParams.get('before') }));
  if (req.method === 'GET' && suffix === 'messages') return json(res, 200, await listMessages(inboxId, url.searchParams.get('caseId'), { limit: url.searchParams.get('limit'), before: url.searchParams.get('before') }));
  if (req.method === 'GET' && suffix === 'delivery-receipts') {
    const receipts = await store.listJson(path.join('inboxes', inboxId, 'delivery-receipts'));
    return json(res, 200, receipts.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))));
  }
  if (req.method === 'GET' && suffix === 'deliveries') {
    const human = await auth.getHuman(req);
    const agent = await getAgentPrincipal(req, inboxId);
    let deliveries = await store.queryOutbox({ inboxId, status: url.searchParams.get('status'), limit: url.searchParams.get('limit') });
    if (!human && agent) {
      const visible = [];
      for (const delivery of deliveries) {
        const message = await store.getJson(messagePath(delivery.senderInboxId, delivery.messageId));
        if (message && [message.senderAgentId, message.recipientAgentId].includes(agent.id)) visible.push(delivery);
      }
      deliveries = visible;
    }
    return json(res, 200, deliveries);
  }

  const retryDeliveryRoute = suffix.match(/^deliveries\/([^/]+)\/retry$/);
  if (req.method === 'POST' && retryDeliveryRoute) {
    const human = await auth.getHuman(req);
    if (!await canManageInbox(human, inbox)) return fail(res, 403, 'Workspace administrator required');
    const existingDelivery = await store.getOutbox(retryDeliveryRoute[1]);
    if (!existingDelivery || ![existingDelivery.senderInboxId, existingDelivery.recipientInboxId].includes(inboxId)) return fail(res, 404, 'Delivery not found');
    if (existingDelivery.status !== 'deadLettered') return fail(res, 409, 'Only dead-lettered deliveries can be retried');
    const existingMessage = await store.getJson(messagePath(existingDelivery.senderInboxId, existingDelivery.messageId));
    const retried = await withInboxMutation(existingDelivery.senderInboxId, async writeAudit => {
      const currentDelivery = await store.getOutbox(existingDelivery.id);
      if (!currentDelivery || currentDelivery.status !== 'deadLettered') throw Object.assign(new Error('Only dead-lettered deliveries can be retried'), { statusCode: 409 });
      const message = await store.getJson(messagePath(currentDelivery.senderInboxId, currentDelivery.messageId));
      const at = store.now();
      const queued = message ? { ...message, status: 'queued', queuedAt: at, updatedAt: at, lastDeliveryError: null, deliveryAttempts: 0 } : null;
      const documents = queued ? [document(messagePath(currentDelivery.senderInboxId, queued.id), queued)] : [];
      if (queued && currentDelivery.kind === 'nativeAgentMessage') documents.push(...(await nativeCaseDocuments(queued, 'queued', at)).documents);
      else if (queued) {
        const senderInbox = await store.getJson(path.join('inboxes', currentDelivery.senderInboxId, 'inbox.json'));
        if (senderInbox) {
          const currentCase = await ensureStructuredCase(senderInbox, { ...queued, caseId: queued.caseId }, queued.senderAgentId, queued.createdAt);
          const updatedCase = setCaseMessageDeliveryState(structuredClone(currentCase), queued, 'queued', at);
          documents.push(document(caseRecordPath(currentDelivery.senderInboxId, updatedCase.id), updatedCase));
        }
      }
      const value = await store.retryOutbox(currentDelivery.id, documents);
      if (!value) throw Object.assign(new Error('Delivery could not be retried'), { statusCode: 409 });
      await writeAudit('message.dead_letter_requeued', { messageId: currentDelivery.messageId, deliveryId: currentDelivery.id, actor: human.id }, at);
      return value;
    }, [existingDelivery.recipientInboxId].filter(Boolean), existingDelivery.kind === 'nativeAgentMessage' && existingMessage?.caseId ? [caseMutationKey(existingMessage.caseId)] : []);
    deliveryWorker.kick();
    return json(res, 202, retried);
  }

  if (req.method === 'GET' && suffix === 'invitations') {
    const human = await auth.getHuman(req);
    const principal = await getAgentPrincipal(req, inboxId);
    if (!await canAccessInbox(human, inbox) && principal?.id !== inbox.ownerAgentId) return fail(res, 403, 'Authenticated inbox participant required');
    const invitations = await store.listJson(path.join('inboxes', inboxId, 'invitations'));
    return json(res, 200, invitations.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))));
  }

  const invitationDecision = suffix.match(/^invitations\/([^/]+)\/(accept|decline)$/);
  if (req.method === 'POST' && invitationDecision) {
    const human = await auth.getHuman(req);
    if (!await canManageInbox(human, inbox)) return fail(res, 403, 'Recipient workspace administrator required');
    const [, invitationId, decision] = invitationDecision;
    const invitation = await store.getJson(invitationPath(inboxId, invitationId));
    if (!invitation || invitation.recipientInboxId !== inboxId) return fail(res, 404, 'Invitation not found');
    if (!['pending', decision === 'accept' ? 'accepted' : 'declined'].includes(invitation.state)) return fail(res, 409, `Invitation is already ${invitation.state}`);
    const response = await withInboxMutation(inboxId, async writeAudit => {
      const currentInvitation = await store.getJson(invitationPath(inboxId, invitationId));
      if (!currentInvitation || currentInvitation.recipientInboxId !== inboxId) throw Object.assign(new Error('Invitation not found'), { statusCode: 404 });
      if (!['pending', decision === 'accept' ? 'accepted' : 'declined'].includes(currentInvitation.state)) throw Object.assign(new Error(`Invitation is already ${currentInvitation.state}`), { statusCode: 409 });
      const now = store.now();
      const senderInbox = await store.getJson(path.join('inboxes', currentInvitation.senderInboxId, 'inbox.json'));
      const pendingMessage = await store.getJson(messagePath(currentInvitation.senderInboxId, currentInvitation.messageId));
      if (!senderInbox || !pendingMessage) throw Object.assign(new Error('Invitation message is no longer available'), { statusCode: 409 });
      if (decision === 'decline') {
        const declined = { ...currentInvitation, state: 'declined', declinedAt: currentInvitation.declinedAt || now, decidedByHumanId: human.id, updatedAt: now };
        const message = { ...pendingMessage, status: 'declined', updatedAt: now };
        await store.putJsonBatch([
          document(invitationPath(inboxId, currentInvitation.id), declined),
          document(invitationPath(currentInvitation.senderInboxId, currentInvitation.id), declined),
          document(messagePath(currentInvitation.senderInboxId, message.id), message)
        ]);
        await writeAudit('invitation.declined', { invitationId: currentInvitation.id, senderAgentId: currentInvitation.senderAgentId, humanId: human.id });
        return { status: 200, result: declined, queued: false };
      }
      const conversationId = currentInvitation.conversationId || currentInvitation.pendingConversationId || store.id('conversation');
      const accepted = { ...currentInvitation, state: 'accepted', conversationId, acceptedAt: currentInvitation.acceptedAt || now, decidedByHumanId: human.id, updatedAt: now };
      const previousSenderContact = await store.getJson(path.join('inboxes', currentInvitation.senderInboxId, 'contacts', `${currentInvitation.recipientAgentId}.json`));
      const previousRecipientContact = await store.getJson(path.join('inboxes', inboxId, 'contacts', `${currentInvitation.senderAgentId}.json`));
      const senderContact = { ...previousSenderContact, agentId: currentInvitation.recipientAgentId, email: currentInvitation.toAddress, state: 'accepted', approved: true, blocked: previousSenderContact?.blocked === true, conversationId, updatedAt: now };
      const recipientContact = { ...previousRecipientContact, agentId: currentInvitation.senderAgentId, email: currentInvitation.fromAddress, state: 'accepted', approved: true, blocked: previousRecipientContact?.blocked === true, conversationId, updatedAt: now };
      await store.putJsonBatch([
        document(invitationPath(inboxId, currentInvitation.id), accepted),
        document(invitationPath(currentInvitation.senderInboxId, currentInvitation.id), accepted),
        document(path.join('inboxes', currentInvitation.senderInboxId, 'contacts', `${currentInvitation.recipientAgentId}.json`), senderContact),
        document(path.join('inboxes', inboxId, 'contacts', `${currentInvitation.senderAgentId}.json`), recipientContact)
      ]);
      let message = { ...pendingMessage, conversationId, caseId: conversationId, invitationId: currentInvitation.id, contactState: 'accepted' };
      if (['pendingContactApproval', 'queued'].includes(message.status)) message = await enqueueNativeMessage(message, senderInbox, inboxId, 'message.queued_after_invitation', (type, data, createdAt) => writeAudit(type, data, createdAt, currentInvitation.senderInboxId));
      await writeAudit('invitation.accepted', { invitationId: currentInvitation.id, conversationId, senderAgentId: currentInvitation.senderAgentId, recipientAgentId: currentInvitation.recipientAgentId, humanId: human.id });
      return { status: currentInvitation.state === 'accepted' ? 200 : 201, result: { invitation: accepted, message }, queued: true };
    }, [invitation.senderInboxId]);
    if (response.queued) deliveryWorker.kick();
    return json(res, response.status, response.result);
  }

  const acknowledgementRoute = suffix.match(/^messages\/([^/]+)\/acknowledgements$/);
  if (req.method === 'POST' && acknowledgementRoute) {
    const principal = await getAgentPrincipal(req, inboxId);
    if (!principal) return fail(res, 401, 'Recipient agent credential required');
    const input = await body(req);
    const idempotencyKey = validateIdempotencyKey(req.headers['idempotency-key'] || input.idempotencyKey, { required: true });
    const message = await store.getJson(messagePath(inboxId, acknowledgementRoute[1]));
    if (!message || message.recipientAgentId !== principal.id) return fail(res, 404, 'Delivered message not found for this agent');
    if (isHumanInstruction(message) || message.senderInboxId && message.senderAgentId) return fail(res, 410, 'Agent work messages require a fenced work claim and /api/agent/work/:workId settlement');
    const state = input.state || 'acknowledged';
    if (!['acknowledged', 'processed'].includes(state)) return fail(res, 400, 'Acknowledgement state must be acknowledged or processed');
    if (!['delivered', 'acknowledged', 'processed'].includes(message.status)) return fail(res, 409, 'Message has not been delivered');
    const acknowledgementDigest = semanticDigest({ messageId: message.id, state });
    const acknowledgementIdempotencyPath = scopedIdempotencyPath('acknowledgements', inboxId, principal.id, idempotencyKey);
    const response = await withInboxMutation(inboxId, async writeAudit => {
      const currentPrincipal = await getAgentPrincipal(req, inboxId);
      if (!currentPrincipal || currentPrincipal.id !== principal.id || !canAct(currentPrincipal, 'receive_agent_messages')) throw Object.assign(new Error('Recipient agent credential required'), { statusCode: 401 });
      const currentMessage = await store.getJson(messagePath(inboxId, acknowledgementRoute[1]));
      if (!currentMessage || currentMessage.recipientAgentId !== currentPrincipal.id) throw Object.assign(new Error('Delivered message not found for this agent'), { statusCode: 404 });
      if (isHumanInstruction(currentMessage) || currentMessage.senderInboxId && currentMessage.senderAgentId) throw Object.assign(new Error('Agent work messages require fenced settlement'), { statusCode: 410 });
      const replay = replayResponse(await store.getJson(acknowledgementIdempotencyPath), { principalId: principal.id, requestDigest: acknowledgementDigest });
      if (replay) return { status: 200, receipt: replay };
      const receiptId = `delivery_receipt_${currentMessage.id}_${state}`;
      const existingReceipt = await store.getJson(deliveryReceiptPath(inboxId, receiptId));
      if (existingReceipt) {
        await store.putJson(acknowledgementIdempotencyPath, { principalId: principal.id, requestDigest: acknowledgementDigest, response: existingReceipt, createdAt: existingReceipt.createdAt });
        return { status: 200, receipt: existingReceipt };
      }
      const currentRank = acknowledgementStateRank[currentMessage.status];
      if (currentRank === undefined) throw Object.assign(new Error('Message has not been delivered'), { statusCode: 409 });
      if (acknowledgementStateRank[state] < currentRank) throw Object.assign(new Error(`Message acknowledgement cannot regress from ${currentMessage.status} to ${state}`), { statusCode: 409 });
      const at = store.now();
      const updated = { ...currentMessage, status: state, [`${state}At`]: at, updatedAt: at };
      const receipt = { id: receiptId, type: 'delivery', messageId: currentMessage.id, senderAgentId: currentMessage.senderAgentId, recipientAgentId: currentMessage.recipientAgentId, state, idempotencyKeyHash: hashSecret(idempotencyKey), createdAt: at };
      const documents = [];
      for (const targetInboxId of new Set([currentMessage.senderInboxId, currentMessage.recipientInboxId])) {
        const targetInbox = await store.getJson(path.join('inboxes', targetInboxId, 'inbox.json'));
        if (!targetInbox) continue;
        const currentCase = await ensureStructuredCase(targetInbox, { ...updated, caseId: updated.caseId }, updated.senderAgentId, updated.createdAt);
        const updatedCase = setCaseMessageDeliveryState(structuredClone(currentCase), updated, state, at);
        documents.push(document(messagePath(targetInboxId, currentMessage.id), updated), document(caseRecordPath(targetInboxId, updatedCase.id), updatedCase), document(deliveryReceiptPath(targetInboxId, receipt.id), receipt));
        await writeAudit(`message.${state}`, { messageId: currentMessage.id, caseId: currentMessage.caseId, senderAgentId: currentMessage.senderAgentId, recipientAgentId: currentMessage.recipientAgentId }, at, targetInboxId);
      }
      await store.putJsonBatch(documents);
      await store.putJson(acknowledgementIdempotencyPath, { principalId: principal.id, requestDigest: acknowledgementDigest, response: receipt, createdAt: at });
      return { status: 201, receipt };
    }, [message.senderInboxId, message.recipientInboxId].filter(Boolean));
    return json(res, response.status, response.receipt);
  }

  if (req.method === 'POST' && suffix === 'external-emails') {
    if (!externalEmailEnabled) return fail(res, 503, 'External email is disabled for this deployment');
    const input = await body(req);
    const idempotencyKey = validateIdempotencyKey(req.headers['idempotency-key'] || input.idempotencyKey, { required: true });
    emailTransport.assertReady();
    const senderAgentId = assertSafeIdentifier(String(input.senderAgentId || ''), 'senderAgentId');
    const sender = await store.getJson(path.join('inboxes', inboxId, 'agents', `${senderAgentId}.json`));
    const principal = await getAgentPrincipal(req, inboxId);
    if (!sender || !principal || principal.id !== sender.id) return fail(res, 401, 'Valid sender agent credential required');
    if (!canAct(sender, 'send_agent_messages') || !canAct(sender, 'use_email_transport')) return fail(res, 403, 'Agent lacks send_agent_messages or use_email_transport permission');
    const recipientEmail = normalizedEmail(input.recipientEmail);
    if (!validEmail(recipientEmail)) return fail(res, 400, 'A valid recipientEmail is required');
    if (recipientEmail.endsWith(`@${emailTransport.publicDomain}`)) return fail(res, 400, 'Use the native agent transport for Envoi recipients');
    const subject = String(input.subject || '').trim();
    const text = String(input.text || '').trim();
    const html = input.html == null ? null : String(input.html);
    if (!subject || subject.length > 200) return fail(res, 400, 'subject is required and must be at most 200 characters');
    if (!text || text.length > 500_000 || (html && html.length > 500_000)) return fail(res, 400, 'text is required and email content must be at most 500000 characters');
    const contact = await store.getJson(externalContactPath(inboxId, recipientEmail));
    if (!contact?.approved || contact.blocked || !['outbound', 'both'].includes(contact.direction || 'both')) return fail(res, 403, 'Recipient is not an approved outbound contact');
    const messageId = `msg_email_${hashSecret(`${sender.id}:${idempotencyKey}`).slice(0, 32)}`;
    const requestHash = hashSecret(JSON.stringify({ senderAgentId, recipientEmail, caseId: input.caseId || null, subject, text, html }));
    const queued = await withInboxMutation(inboxId, async writeAudit => {
      const [currentPrincipal, currentSender] = await Promise.all([
        getAgentPrincipal(req, inboxId),
        store.getJson(path.join('inboxes', inboxId, 'agents', `${senderAgentId}.json`))
      ]);
      if (!currentSender || !currentPrincipal || currentPrincipal.id !== currentSender.id) throw Object.assign(new Error('Valid sender agent credential required'), { statusCode: 401 });
      if (!canAct(currentSender, 'send_agent_messages') || !canAct(currentSender, 'use_email_transport')) throw Object.assign(new Error('Agent lacks send_agent_messages or use_email_transport permission'), { statusCode: 403 });
      const existing = await store.getJson(messagePath(inboxId, messageId));
      if (existing) {
        if (existing.requestHash !== requestHash) throw Object.assign(new Error('Idempotency key was already used for a different email'), { statusCode: 409 });
        return { status: 200, message: existing };
      }
      if (!consumeExternalEmailLimit(currentSender.id, recipientEmail)) throw Object.assign(new Error('External email rate limit exceeded'), { statusCode: 429 });
      const createdAt = store.now();
      const caseId = input.caseId ? assertSafeIdentifier(input.caseId, 'caseId') : store.id('case');
      const replyAddress = `reply+${hashSecret(messageId).slice(0, 32)}@${emailTransport.publicDomain}`;
      const message = { id: messageId, caseId, senderInboxId: inboxId, transport: 'email', direction: 'outbound', senderType: 'agent', senderAgentId, senderEmail: publicEmailAddressForAgent(currentSender), recipientEmail, subject, type: 'email', text, html, payload: input.payload || null, replyAddress, requestHash, createdAt, queuedAt: createdAt, status: 'queued', externalDeliveryState: 'queued' };
      const currentCase = await ensureStructuredCase(inbox, { ...input, caseId, type: 'message', text, objective: subject }, currentSender.id, createdAt);
      const queuedCase = setCaseMessageDeliveryState(structuredClone(currentCase), message, 'queued', createdAt);
      const outbox = { id: `delivery_${message.id}`, kind: 'externalEmail', messageId, senderInboxId: inboxId, recipientInboxId: null, orderingKey: caseId, requestHash, status: 'queued', attempts: 0, maxAttempts: deliveryMaxAttempts, availableAt: createdAt, createdAt, updatedAt: createdAt };
      const queuedDelivery = await store.enqueueOutbox([
        document(messagePath(inboxId, message.id), message),
        document(caseRecordPath(inboxId, queuedCase.id), queuedCase),
        document(replyAddressDirectoryPath(replyAddress), { address: replyAddress, inboxId, agentId: currentSender.id, caseId, messageId })
      ], outbox);
      if (queuedDelivery.requestHash && queuedDelivery.requestHash !== requestHash) throw Object.assign(new Error('Idempotency key was already used for a different email'), { statusCode: 409 });
      await writeAudit('email.queued', { messageId, caseId, senderAgentId, senderEmail: message.senderEmail, recipientEmail }, createdAt);
      return { status: 202, message: queuedDelivery.enqueueCreated ? message : await store.getJson(messagePath(inboxId, message.id), message) };
    });
    deliveryWorker.kick();
    return json(res, queued.status, queued.message);
  }

  if (req.method === 'POST' && suffix === 'messages') {
    const input = await body(req);
    if (input.recipientAgentId != null) return fail(res, 400, 'Send by recipientEmail; raw recipient agent IDs are not accepted');
    if (!input.senderAgentId || !input.recipientEmail || !input.text) return fail(res, 400, 'senderAgentId, recipientEmail, and text are required');
    const idempotencyKey = validateIdempotencyKey(req.headers['idempotency-key'] || input.idempotencyKey, { required: true });
    const senderAgentId = assertSafeIdentifier(String(input.senderAgentId), 'senderAgentId');
    const sender = await store.getJson(path.join('inboxes', inboxId, 'agents', `${senderAgentId}.json`));
    if (!sender) return fail(res, 403, 'Only registered agents may send messages');
    const principal = await getAgentPrincipal(req, inboxId);
    if (!principal || principal.id !== sender.id) return fail(res, 401, 'Valid sender agent credential required');
    if (!canAct(sender, 'send_agent_messages')) return fail(res, 403, 'Agent is pending approval or lacks send_agent_messages permission');
    const recipientEmail = normalizedEmail(input.recipientEmail);
    if (!validEmail(recipientEmail) || !recipientEmail.endsWith(`@${agentDomain}`)) return fail(res, 404, 'Recipient is unavailable');
    const recipientDirectory = await store.getJson(nativeAddressDirectoryPath(recipientEmail));
    if (!recipientDirectory || !['active', 'paused'].includes(recipientDirectory.status) || recipientDirectory.verified !== true) return fail(res, 404, 'Recipient is unavailable');
    const recipient = await store.getJson(path.join('inboxes', recipientDirectory.inboxId, 'agents', `${recipientDirectory.agentId}.json`));
    if (!recipient || recipient.address !== recipientEmail || !canReceive(recipient)) return fail(res, 404, 'Recipient is unavailable');
    if (recipient.id === sender.id) return fail(res, 400, 'Sender and recipient must be different agents');
    const messageId = `msg_${hashSecret(`${sender.id}:${idempotencyKey}`).slice(0, 32)}`;
    const requestedCaseId = input.caseId ? assertSafeIdentifier(input.caseId, 'caseId') : null;
    const requestHash = hashSecret(JSON.stringify({ senderAgentId, recipientEmail, caseId: requestedCaseId, taskId: input.taskId || null, correlationId: input.correlationId || null, causationId: input.causationId || null, intent: input.intent || input.type || 'message', text: input.text, content: input.content || null, payload: input.payload || null, proposal: input.proposal || null, authority: input.authority || null, signature: input.signature || null, artifactRefs: input.artifactRefs || [] }));
    const priorMessage = await store.getJson(messagePath(inboxId, messageId));
    const candidateCaseId = requestedCaseId || priorMessage?.caseId || store.id('case');
    const response = await withInboxMutation(inboxId, async writeAudit => {
      const [currentSenderInbox, currentSender, currentPrincipal, currentRecipientDirectory] = await Promise.all([
        store.getJson(path.join('inboxes', inboxId, 'inbox.json')),
        store.getJson(path.join('inboxes', inboxId, 'agents', `${senderAgentId}.json`)),
        getAgentPrincipal(req, inboxId),
        store.getJson(nativeAddressDirectoryPath(recipientEmail))
      ]);
      if (!currentSenderInbox || !currentSender || !currentPrincipal || currentPrincipal.id !== currentSender.id) throw Object.assign(new Error('Valid sender agent credential required'), { statusCode: 401 });
      if (!canAct(currentSender, 'send_agent_messages')) throw Object.assign(new Error('Agent is pending approval or lacks send_agent_messages permission'), { statusCode: 403 });
      if (!currentRecipientDirectory || currentRecipientDirectory.inboxId !== recipientDirectory.inboxId || !['active', 'paused'].includes(currentRecipientDirectory.status) || currentRecipientDirectory.verified !== true) throw Object.assign(new Error('Recipient is unavailable'), { statusCode: 404 });
      const currentRecipient = await store.getJson(path.join('inboxes', currentRecipientDirectory.inboxId, 'agents', `${currentRecipientDirectory.agentId}.json`));
      if (!currentRecipient || currentRecipient.address !== recipientEmail || !canReceive(currentRecipient)) throw Object.assign(new Error('Recipient is unavailable'), { statusCode: 404 });
      if (currentRecipient.id === currentSender.id) throw Object.assign(new Error('Sender and recipient must be different agents'), { statusCode: 400 });
      const [senderContact, recipientContact] = await Promise.all([
        store.getJson(path.join('inboxes', inboxId, 'contacts', `${currentRecipient.id}.json`)),
        store.getJson(path.join('inboxes', currentRecipientDirectory.inboxId, 'contacts', `${currentSender.id}.json`))
      ]);
      if (senderContact?.blocked || recipientContact?.blocked) throw Object.assign(new Error('The recipient is unavailable'), { statusCode: 403 });
      const invitationId = `invitation_${hashSecret(`${currentSender.id}:${currentRecipient.id}`).slice(0, 40)}`;
      const existingInvitation = await store.getJson(invitationPath(currentRecipientDirectory.inboxId, invitationId));
      await assertCaseProgressAllowed(inboxId, candidateCaseId);
      const existing = await store.getJson(messagePath(inboxId, messageId));
      if (existing) {
        const sameRequest = existing.requestHash ? existing.requestHash === requestHash : existing.recipientEmail === recipientEmail && existing.text === input.text && JSON.stringify(existing.payload) === JSON.stringify(input.payload || null);
        if (!sameRequest) throw nativeIdempotencyConflict();
        if (existing.status === 'pendingContactApproval') {
          const queued = await enqueueNativeMessage({ ...existing, requestHash }, currentSenderInbox, currentRecipientDirectory.inboxId, 'message.queued', writeAudit, req);
          if (existingInvitation?.state === 'pending' && existingInvitation.messageId === existing.id) {
            const superseded = { ...existingInvitation, state: 'superseded', updatedAt: store.now() };
            await store.putJsonBatch([
              document(invitationPath(inboxId, invitationId), superseded),
              document(invitationPath(currentRecipientDirectory.inboxId, invitationId), superseded)
            ]);
          }
          return { status: 202, payload: queued, queued: true };
        }
        return { status: 200, payload: existing, queued: false };
      }
      const createdAt = store.now();
      const conversationId = candidateCaseId;
      const protocol = createProtocolMessage({
        messageId,
        conversationId,
        taskId: input.taskId || null,
        correlationId: input.correlationId || null,
        causationId: input.causationId || null,
        from: { agentId: currentSender.id, address: currentSender.address },
        to: [{ agentId: currentRecipient.id, address: currentRecipient.address }],
        intent: input.intent || input.type || 'message',
        text: input.text,
        content: input.content,
        proposal: input.proposal || input.payload?.proposal || null,
        authority: { scope: 'message.send', humanApproval: 'notRequired', policyEvaluationId: null },
        artifactRefs: input.artifactRefs || [],
        requiresAck: input.requiresAck !== false,
        traceparent: req.headers.traceparent || input.traceparent || null,
        signature: null,
        createdAt
      });
      const message = {
        id: messageId,
        ...protocol,
        caseId: conversationId,
        senderInboxId: inboxId,
        recipientInboxId: currentRecipientDirectory.inboxId,
        senderType: 'agent',
        senderAgentId,
        recipientAgentId: currentRecipient.id,
        recipientEmail,
        transport: 'native',
        type: input.type || 'message',
        unverifiedAuthorityClaim: input.authority || null,
        unverifiedSignatureClaim: input.signature || null,
        text: input.text,
        payload: input.payload || null,
        requestHash,
        createdAt,
        queuedAt: createdAt,
        status: 'queued'
      };
      const queued = await enqueueNativeMessage(message, currentSenderInbox, currentRecipientDirectory.inboxId, 'message.queued', writeAudit, req);
      return { status: 202, payload: queued, queued: true };
    }, [recipientDirectory.inboxId], [caseMutationKey(candidateCaseId)]);
    if (response.queued) deliveryWorker.kick();
    return json(res, response.status, response.payload);
  }

  if (req.method === 'POST' && suffix === 'human-messages') {
    if (!humanConversationMessagingEnabled()) return fail(res, 403, 'Human conversation messaging is disabled in production');
    const input = await body(req);
    const human = await auth.getHuman(req);
    if (!human) return fail(res, 401, 'Verified human session required');
    if (!await canAccessInbox(human, inbox)) return fail(res, 403, 'Workspace membership required');
    if (!input.recipientAgentId || !input.text) return fail(res, 400, 'recipientAgentId and text are required');
    const recipientAgentId = assertSafeIdentifier(input.recipientAgentId, 'recipientAgentId');
    const recipient = await store.getJson(path.join('inboxes', inboxId, 'agents', `${recipientAgentId}.json`));
    if (!recipient) return fail(res, 404, 'Recipient agent not found');
    if (!canReceive(recipient)) return fail(res, 403, 'Recipient agent is not approved to receive messages');
    const contact = await store.getJson(path.join('inboxes', inboxId, 'contacts', `${recipientAgentId}.json`), { approved: true, blocked: false });
    if (contact.blocked) return fail(res, 403, 'Recipient is blocked');
    if (contact.approved === false) return fail(res, 403, 'Recipient is not an approved human contact');
    const message = { id: store.id('msg'), inboxId, caseId: input.caseId ? assertSafeIdentifier(input.caseId, 'caseId') : store.id('case'), senderType: 'human', senderHumanId: human.id, recipientAgentId, type: input.type || 'message', text: input.text, payload: input.payload || null, createdAt: store.now(), status: 'received' };
    await store.putJson(path.join('inboxes', inboxId, 'messages', `${message.id}.json`), message);
    const caseRecord = await ensureStructuredCase(inbox, { ...input, caseId: message.caseId }, message.recipientAgentId, message.createdAt);
    appendEvent(caseRecord, { id: `evt_${message.id}`, type: 'message', actor: human.id, createdAt: message.createdAt, payload: { messageId: message.id, messageType: message.type, text: message.text, data: message.payload, senderHumanId: human.id, recipientAgentId: message.recipientAgentId, deliveryState: message.status }, linkedPolicyEvaluation: null, precedingEventRef: caseRecord.events.at(-1)?.id || null });
    await saveCase(inboxId, caseRecord);
    await audit(inboxId, 'message.created', { messageId: message.id, caseId: message.caseId, senderType: 'human', senderHumanId: message.senderHumanId, recipientAgentId: message.recipientAgentId });
    return json(res, 201, message);
  }

  if (req.method === 'POST' && suffix === 'asset-uploads') {
    const input = await body(req);
    const principal = await getAgentPrincipal(req, inboxId);
    if (!principal || !canAct(principal, 'create_assets')) return fail(res, 403, 'Agent credential with create_assets permission required');
    if (input.createdByAgentId && input.createdByAgentId !== principal.id) return fail(res, 403, 'createdByAgentId must match the authenticated agent');
    const caseId = input.caseId ? assertSafeIdentifier(input.caseId, 'caseId') : null;
    if (caseId) {
      const [shared, directory] = await Promise.all([sharedCaseForAsset(caseId), store.getJson(path.join('directory', 'agents', `${principal.id}.json`))]);
      if (!shared || !shared.binding.agentIds.includes(principal.id) || !shared.binding.inboxIds.includes(inboxId)
        || directory?.inboxId !== inboxId || inbox.ownerAgentId !== principal.id) return fail(res, 403, 'CASE_PARTICIPANT_MISMATCH');
      await assertCaseProgressAllowed(inboxId, caseId);
    }
    const idempotencyKey = validateIdempotencyKey(req.headers['idempotency-key'] || input.idempotencyKey);
    const idempotencyPath = idempotencyKey ? scopedIdempotencyPath('asset-upload', inboxId, principal.id, idempotencyKey) : null;
    const requestDigest = idempotencyPath ? semanticDigest({ filename: input.filename, mimeType: input.mimeType, size: input.size, checksumSha256: input.checksumSha256, caseId }) : null;
    const claimed = idempotencyPath ? await claimIdempotency(store, idempotencyPath, { principalId: principal.id, requestDigest, createdAt: store.now() }) : null;
    if (claimed?.replay) return json(res, 200, claimed.replay);
    let persisted = false;
    let started;
    try {
      started = await objectStorage.beginUpload({ workspaceId: inboxId, filename: input.filename, mimeType: input.mimeType, size: input.size, checksumSha256: input.checksumSha256, caseId, createdByAgentId: principal.id }, { lockKeys: [inboxMutationKey(inboxId)], authorize: async () => {
        if (!await getAgentPrincipal(req, inboxId)) throw Object.assign(new Error('Agent access ended'), { statusCode: 403 });
      } });
      const response = { object: started.object, upload: browserObjectUrl(started.upload, req) };
      if (idempotencyPath) await completeIdempotency(store, idempotencyPath, { principalId: principal.id, requestDigest, response, createdAt: store.now() });
      persisted = true;
      await audit(inboxId, 'asset.upload_started', { assetId: started.object.id, caseId: started.object.caseId, createdByAgentId: principal.id, size: started.object.size, state: started.object.state });
      return json(res, 201, response);
    } catch (error) {
      if (!persisted && started) await objectStorage.abortUpload(started.object.id).catch(() => {});
      if (claimed?.claimed && !persisted) await store.deleteJson(idempotencyPath).catch(() => {});
      throw error;
    }
  }

  const completeAssetUpload = suffix.match(/^assets\/([^/]+)\/complete$/);
  if (req.method === 'POST' && completeAssetUpload) {
    const human = await auth.getHuman(req);
    const principal = await getAgentPrincipal(req, inboxId);
    const asset = await objectStorage.getObject(completeAssetUpload[1]);
    if (asset.workspaceId !== inboxId) return fail(res, 404, 'Asset not found');
    if (!await canManageInbox(human, inbox) && principal?.id !== asset.createdByAgentId) return fail(res, 403, 'Asset creator or workspace administrator required');
    const scanned = await objectStorage.scanObject(asset.id);
    await audit(inboxId, `asset.scan_${scanned.state}`, { assetId: scanned.id, caseId: scanned.caseId, createdByAgentId: scanned.createdByAgentId, scan: scanned.scan });
    return json(res, 200, scanned);
  }

  const grantAsset = suffix.match(/^assets\/([^/]+)\/grants$/);
  if (req.method === 'POST' && grantAsset) {
    const input = await body(req);
    const principal = await getAgentPrincipal(req, inboxId);
    if (!principal || !canAct(principal, 'create_assets')) return fail(res, 403, 'Asset creator credential with create_assets permission required');
    const caseId = assertSafeIdentifier(input.caseId, 'caseId');
    const recipientAgentId = assertSafeIdentifier(input.recipientAgentId, 'recipientAgentId');
    const idempotencyKey = validateIdempotencyKey(req.headers['idempotency-key'] || input.idempotencyKey, { required: true });
    const requestDigest = semanticDigest({ assetId: grantAsset[1], caseId, recipientAgentId });
    const keyPath = scopedIdempotencyPath('asset-grant', inboxId, principal.id, idempotencyKey);
    const priorRequest = await store.getJson(keyPath);
    if (priorRequest && (priorRequest.principalId !== principal.id || priorRequest.requestDigest !== requestDigest)) throw nativeIdempotencyConflict();
    const asset = await store.getJson(objectMetadataPath(grantAsset[1]));
    if (!asset || asset.workspaceId !== inboxId) return fail(res, 404, 'ASSET_NOT_FOUND');
    if (asset.createdByAgentId !== principal.id || asset.caseId !== caseId) return fail(res, 403, 'Asset creator and case membership required');
    const recipientDirectory = await store.getJson(path.join('directory', 'agents', `${recipientAgentId}.json`));
    if (!recipientDirectory?.inboxId || !await assetPair(asset, recipientAgentId, recipientDirectory.inboxId)) return fail(res, 403, 'CASE_PARTICIPANT_MISMATCH');
    const recipientInboxId = recipientDirectory.inboxId;
    const grantPath = assetGrantPath(recipientInboxId, asset.id);
    const result = await withInboxMutation(inboxId, async writeAudit => {
      await assertCaseProgressAllowed(inboxId, caseId);
      const [currentPrincipal, currentAsset, currentRecipient, currentRecipientDirectory] = await Promise.all([
        getAgentPrincipal(req, inboxId), store.getJson(objectMetadataPath(asset.id)),
        store.getJson(path.join('inboxes', recipientInboxId, 'agents', `${recipientAgentId}.json`)),
        store.getJson(path.join('directory', 'agents', `${recipientAgentId}.json`))
      ]);
      if (currentPrincipal?.id !== principal.id || !canAct(currentPrincipal, 'create_assets')) throw Object.assign(new Error('Asset creator credential required'), { statusCode: 403 });
      if (!currentAsset || currentAsset.workspaceId !== inboxId || currentAsset.createdByAgentId !== principal.id || currentAsset.caseId !== caseId) throw Object.assign(new Error('Asset creator and case membership required'), { statusCode: 403 });
      if (currentRecipientDirectory?.inboxId !== recipientInboxId || !currentRecipient || !canReceive(currentRecipient)
        || !await assetPair(currentAsset, recipientAgentId, recipientInboxId)) throw caseParticipantMismatch();
      if (await assetRelationshipBlocked(currentAsset, recipientAgentId, recipientInboxId)) throw Object.assign(new Error('The agent relationship is blocked'), { statusCode: 403, code: 'AGENT_BLOCKED' });
      const priorKey = await store.getJson(keyPath);
      if (priorKey && (priorKey.principalId !== principal.id || priorKey.requestDigest !== requestDigest)) throw nativeIdempotencyConflict();
      let grant = await store.getJson(grantPath);
      if (priorKey && (!grant || grant.id !== priorKey.grantId)) throw Object.assign(new Error('Grant retry has no matching durable record'), { statusCode: 409 });
      if (grant && (grant.assetId !== asset.id || grant.caseId !== caseId || grant.ownerInboxId !== inboxId
        || grant.ownerAgentId !== principal.id || grant.recipientInboxId !== recipientInboxId || grant.recipientAgentId !== recipientAgentId)) throw nativeIdempotencyConflict();
      const created = !grant;
      if (!grant) {
        grant = { id: `grant_${hashSecret(`${asset.id}:${caseId}:${recipientAgentId}`).slice(0, 40)}`, schemaVersion: '1.0', assetId: asset.id, caseId, ownerInboxId: inboxId, ownerAgentId: principal.id, recipientInboxId, recipientAgentId, grantedByAgentId: principal.id, createdAt: store.now() };
        if (!await store.putJsonIfAbsent(grantPath, grant)) throw Object.assign(new Error('Asset grant was created concurrently; retry'), { statusCode: 409 });
      }
      if (!priorKey) await store.putJson(keyPath, { principalId: principal.id, requestDigest, grantId: grant.id, createdAt: store.now() });
      if (created) await writeAudit('asset.granted', { assetId: asset.id, caseId, grantId: grant.id, recipientAgentId, recipientInboxId, actorAgentId: principal.id });
      return { status: created ? 201 : 200, grant: { ...grant, active: currentAsset.state === 'clean' } };
    }, [recipientInboxId], [`asset-grant:${asset.id}`]);
    return json(res, result.status, result.grant);
  }

  const downloadAsset = suffix.match(/^assets\/([^/]+)\/download$/);
  if (req.method === 'GET' && downloadAsset) {
    const asset = await store.getJson(objectMetadataPath(downloadAsset[1]));
    const access = await assetReadAccess(asset, inbox, await assetReader(req, inbox));
    if (access.blocked) return fail(res, 403, 'AGENT_BLOCKED');
    if (!access.allowed) return fail(res, 404, 'ASSET_NOT_FOUND');
    if (asset.state !== 'clean') return fail(res, 423, 'ASSET_NOT_CLEAN');
    if (!access.owner) return json(res, 200, { object: asset, download: {
      url: `${publicBaseUrl(req)}/api/inboxes/${encodeURIComponent(inboxId)}/assets/${encodeURIComponent(asset.id)}/content`,
      method: 'GET', headers: {}
    } });
    return json(res, 200, { object: asset, download: browserObjectUrl(await objectStorage.createDownload(asset.id), req) });
  }

  if (req.method === 'GET' && suffix === 'assets/quota') return json(res, 200, await objectStorage.quotaLedger.usage(inboxId));

  if (req.method === 'POST' && suffix === 'assets') {
    if (objectStorageProvider === 's3') return fail(res, 410, 'Direct asset uploads are disabled; use asset-uploads and signed URLs');
    const input = await body(req);
    if (input.caseId) return fail(res, 410, 'Case assets require scanner-gated asset-uploads');
    if (!input.name || !input.contentBase64 || !input.createdByAgentId) return fail(res, 400, 'name, contentBase64, and createdByAgentId are required');
    const createdByAgentId = assertSafeIdentifier(input.createdByAgentId, 'createdByAgentId');
    const assetAgent = await store.getJson(path.join('inboxes', inboxId, 'agents', `${createdByAgentId}.json`));
    if (!assetAgent || !canAct(assetAgent, 'create_assets')) return fail(res, 403, 'Agent is pending approval or lacks create_assets permission');
    const principal = await getAgentPrincipal(req, inboxId);
    if (!principal || principal.id !== assetAgent.id) return fail(res, 401, 'Valid creator agent credential required');
    const asset = { id: store.id('asset'), inboxId, caseId: input.caseId ? assertSafeIdentifier(input.caseId, 'caseId') : null, name: input.name, mimeType: input.mimeType || 'application/octet-stream', size: Buffer.byteLength(input.contentBase64, 'base64'), createdByAgentId, createdAt: store.now() };
    await store.putJson(path.join('inboxes', inboxId, 'assets', `${asset.id}.json`), asset);
    await mkdir(resolvePathWithin(dataDir, 'inboxes', inboxId, 'assets', asset.id), { recursive: true });
    await writeFile(resolvePathWithin(dataDir, 'inboxes', inboxId, 'assets', asset.id, 'content.bin'), Buffer.from(input.contentBase64, 'base64'));
    await audit(inboxId, 'asset.created', { assetId: asset.id, caseId: asset.caseId, createdByAgentId: asset.createdByAgentId });
    return json(res, 201, asset);
  }

  if (req.method === 'GET' && suffix === 'assets') {
    const reader = await assetReader(req, inbox);
    const caseId = url.searchParams.get('caseId');
    if (caseId) assertSafeIdentifier(caseId, 'caseId');
    const own = await store.listJson(path.join('inboxes', inboxId, 'assets'));
    const grants = await store.listJson(path.join('inboxes', inboxId, 'asset-grants'));
    const shared = await Promise.all(grants.map(grant => store.getJson(objectMetadataPath(grant.assetId))));
    const visible = [];
    for (const asset of [...own, ...shared.filter(Boolean)]) {
      if (caseId && asset.caseId !== caseId || visible.some(item => item.id === asset.id)) continue;
      const access = await assetReadAccess(asset, inbox, reader);
      if (access.allowed && (access.owner || asset.state === 'clean')) visible.push(asset);
    }
    return json(res, 200, visible);
  }
  const assetMatch = suffix.match(/^assets\/([^/]+)\/content$/);
  if (req.method === 'GET' && assetMatch) {
    const sharedAsset = await store.getJson(objectMetadataPath(assetMatch[1]));
    if (sharedAsset?.key) {
      const access = await assetReadAccess(sharedAsset, inbox, await assetReader(req, inbox));
      if (access.blocked) return fail(res, 403, 'AGENT_BLOCKED');
      if (!access.allowed) return fail(res, 404, 'ASSET_NOT_FOUND');
      const { bytes } = await objectStorage.readCleanObject(sharedAsset.id);
      res.writeHead(200, { 'content-type': sharedAsset.mimeType, 'content-length': String(bytes.length),
        'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
        'content-disposition': `attachment; filename="${String(sharedAsset.filename || 'download').replace(/[\r\n"\\]/g, '_').slice(0, 180)}"` });
      return res.end(bytes);
    }
    const asset = await store.getJson(path.join('inboxes', inboxId, 'assets', `${assetMatch[1]}.json`));
    if (!asset) return fail(res, 404, 'Asset not found');
    const access = await assetReadAccess(asset, inbox, await assetReader(req, inbox));
    if (!access.allowed || !access.owner) return fail(res, 404, 'ASSET_NOT_FOUND');
    if (asset.key || process.env.ENVOI_AUTH_MODE === 'production') return fail(res, 410, 'Use the scanner-gated signed download endpoint');
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${asset.name.replace(/"/g, '')}"`, 'x-content-type-options': 'nosniff' });
    return res.end(await readFile(resolvePathWithin(dataDir, 'inboxes', inboxId, 'assets', asset.id, 'content.bin')));
  }
  return fail(res, 404, 'Not found');
}

// Refuse a database that belongs to another deployment before migrating or touching anything,
// then stamp a new database (src/deployment-identity.js). A refusal exits non-zero.
await verifyDeploymentIdentityBeforeInit(store, deploymentIdentity);
await store.init();
if (caseSessions.enabled) {
  await store.withTransaction(['config:case-reference-key'], async () => {
    let stored = await store.getJson(path.join('config', 'case-reference-key'));
    if (!stored) { stored = encryptConnectorTokens(crypto.randomBytes(32).toString('base64')); await store.putJson(path.join('config', 'case-reference-key'), stored); }
    const decipher = crypto.createDecipheriv('aes-256-gcm', connectorEncryptionKey(), Buffer.from(stored.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(stored.tag, 'base64'));
    const key = JSON.parse(Buffer.concat([decipher.update(Buffer.from(stored.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
    caseReferenceCodec = createCaseReferenceCodec(Buffer.from(key, 'base64'));
  });
}
await ensureDeploymentIdentity(store, { ...deploymentIdentity, releaseSha, now: () => store.now() });
await objectStorage.init();
await objectStorage.reapExpiredUploads({ limit: 25 });
await reconcileLegacyAgentRevocations();
// case-session v1 §1: the sessions epoch, and the heartbeat that keeps it from moving while on.
await caseSessions.startEpoch();
await httpWake.startup();
await browserGatewayHttp.reconcileFlags();
let wakeDrainRun = null;
let wakeMaintenanceRun = null;
async function wakeMaintenance() {
  if (!httpWakeEnabled) return;
  // Heartbeat and cleanup throttle themselves; the work-due scan visits only active subscriptions
  // that a work_due trigger could still wake.
  await httpWake.heartbeat();
  await httpWake.cleanup();
  for (const sub of await httpWake.workDueTargets()) {
    await withInboxMutation(sub.inboxId, async () => {
      const agent = await store.getJson(path.join('inboxes', sub.inboxId, 'agents', `${sub.agentId}.json`));
      if (!agent || agent.status !== 'active') return;
      const at = store.now();
      for (const claim of await store.listJson(path.join('inboxes', sub.inboxId, 'work-claims'))) {
        const due = claim.status === 'retryable' && claim.retryAt <= at || ['claimed', 'acknowledged'].includes(claim.status) && claim.leaseExpiresAt <= at;
        if (!due || agentWorkAttempts(claim) >= agentWorkMaxAttempts && !claim.reofferWithoutAttempt) continue;
        const message = await store.getJson(messagePath(sub.inboxId, claim.workId));
        if (!message || !['delivered', 'acknowledged'].includes(message.status)) continue;
        const value = await getCase(sub.inboxId, message.caseId);
        if (['paused', 'revoked'].includes(value?.state) || await workIneligibility(message, { agent, inboxId: sub.inboxId })) continue;
        await httpWake.trigger({ inboxId: sub.inboxId, agentId: sub.agentId, reason: 'work_due', cursor: await newestEventCursor(sub.inboxId) });
        break;
      }
    });
  }
}
const wakeDispatch = httpWakeEnabled ? setInterval(() => {
  wakeDrainRun ||= (async () => { for (let i = 0; i < 50 && await httpWake.runOnce(); i++); })()
    .catch(() => console.error(JSON.stringify({ event: 'envoi.http_wake_dispatch_failed' }))).finally(() => { wakeDrainRun = null; });
}, 250) : null;
const wakeMaintenanceTimer = httpWakeEnabled ? setInterval(() => {
  wakeMaintenanceRun ||= wakeMaintenance().catch(() => console.error(JSON.stringify({ event: 'envoi.http_wake_maintenance_failed' }))).finally(() => { wakeMaintenanceRun = null; });
}, 1000) : null;
wakeDispatch?.unref(); wakeMaintenanceTimer?.unref();
const caseSessionsHeartbeat = caseSessions.enabled ? setInterval(() => { void caseSessions.heartbeat().catch(() => console.error(JSON.stringify({ event: 'envoi.case_sessions_heartbeat_failed' }))); }, caseSessionsHeartbeatMs) : null;
let humanRequestCleanupRun = null;
// Pending human-decision requests expire on their own clock, separate from session cleanup.
const humanRequestCleanupMs = Math.max(100, Number(process.env.ENVOI_HUMAN_DECISION_CLEANUP_INTERVAL_MS || 5000));
const humanRequestCleanup = setInterval(() => {
  humanRequestCleanupRun ||= cleanupCaseHumanRequests().catch(() => console.error(JSON.stringify({ event: 'envoi.human_decision_cleanup_failed' }))).finally(() => { humanRequestCleanupRun = null; });
}, humanRequestCleanupMs);
humanRequestCleanup.unref();
caseSessionsHeartbeat?.unref?.();
await synchronizePublicEmailDirectory();
deliveryWorker.start();
let waitlistSheetSync = null;
if (process.env.ENVOI_WAITLIST_SHEET_ID && process.env.ENVOI_WAITLIST_GOOGLE_SERVICE_ACCOUNT_JSON) {
  try {
    waitlistSheetSync = createWaitlistSheetSync({
      store,
      sheetId: process.env.ENVOI_WAITLIST_SHEET_ID,
      serviceAccountJson: process.env.ENVOI_WAITLIST_GOOGLE_SERVICE_ACCOUNT_JSON
    });
  } catch (error) {
    console.error('Waitlist Sheet sync configuration failed', { message: error.message });
  }
}
const runWaitlistSheetSync = () => waitlistSheetSync?.run()
  .then(appended => { if (appended) console.log('Waitlist Sheet sync completed', { appended }); })
  .catch(error => console.error('Waitlist Sheet sync failed', { message: error.message }));
const waitlistSheetInterval = waitlistSheetSync ? setInterval(runWaitlistSheetSync, 60_000) : null;
waitlistSheetInterval?.unref?.();
if (waitlistSheetSync) void runWaitlistSheetSync();
const logOperationalBacklog = () => operationalBacklogSnapshot({ store, scanJobStore })
  .then(snapshot => console.log(JSON.stringify(snapshot)))
  .catch(() => console.error(JSON.stringify({ event: 'envoi.operational_backlog_error' })));
const operationalBacklogLogger = setInterval(() => { void logOperationalBacklog(); }, operationalBacklogLogIntervalMs);
operationalBacklogLogger.unref?.();
void logOperationalBacklog();
const objectQuotaReaper = setInterval(() => objectStorage.reapExpiredUploads({ limit: 25 }).catch(error => console.error('Object upload cleanup failed', { name: error?.name || 'Error', code: error?.code || 'UPLOAD_CLEANUP_FAILED' })), Number(process.env.ENVOI_OBJECT_QUOTA_REAPER_INTERVAL_MS || 300_000));
objectQuotaReaper.unref?.();
const agentRotationReaper = setInterval(() => { void reapAgentRotationRecovery(store).catch(() => console.error('Agent rotation recovery cleanup failed')); }, agentRotationRecoveryMs);
// agent-registration v1 §2: registration records go by 25 h, recovery envelopes after 300 s.
const registrationCleanupMs = Number(process.env.ENVOI_REGISTRATION_CLEANUP_INTERVAL_MS || 5 * 60_000);
const runRegistrationCleanup = () => Promise.all([registrations.cleanup(), browserGatewayHttp.cleanup()]).catch(() => console.error(JSON.stringify({ event: 'envoi.agent_registration_cleanup_failed' })));
const registrationCleanup = setInterval(() => { void runRegistrationCleanup(); }, registrationCleanupMs);
registrationCleanup.unref?.();
void runRegistrationCleanup();
// case-session v1 §13: sessions nothing else ended are recorded expired; records go 24 h after expiry.
const caseSessionCleanupMs = Number(process.env.ENVOI_CASE_SESSION_CLEANUP_INTERVAL_MS || 5 * 60_000);
let caseSessionCleanupRun = null;
const runCaseSessionCleanup = () => {
  caseSessionCleanupRun ||= caseSessions.cleanup(withCaseSessionLock)
    .then(result => { if (result.failed) console.error(JSON.stringify({ event: 'envoi.case_session_cleanup_partial', failed: result.failed })); })
    .catch(() => console.error(JSON.stringify({ event: 'envoi.case_session_cleanup_failed' })))
    .finally(() => { caseSessionCleanupRun = null; });
  return caseSessionCleanupRun;
};
const caseSessionCleanup = setInterval(() => { void runCaseSessionCleanup(); }, caseSessionCleanupMs);
caseSessionCleanup.unref?.();
agentRotationReaper.unref?.();
const objectScanWorker = scanJobStore ? setInterval(() => { void runObjectScans(); }, objectScanWorkerIntervalMs) : null;
const objectScanRetentionWorker = scanJobStore ? setInterval(() => { void runObjectScanRetention(); }, objectScanRetentionIntervalMs) : null;
objectScanWorker?.unref?.();
objectScanRetentionWorker?.unref?.();
if (scanJobStore) {
  void runObjectScans();
  void runObjectScanRetention();
}
const server = http.createServer(async (req, res) => {
  let reasonCode = null;
  try { await route(req, res); }
  catch (error) {
    const requestId = requestIdFrom(req.headers['x-request-id']);
    const response = publicHttpError(error, requestId);
    reasonCode = response.body?.code || null;
    notePresence(req, { errorCode: reasonCode });
    if (response.status >= 500) console.error('Unhandled request error', { requestId, name: error instanceof Error ? error.name : 'Error' });
    json(res, response.status, response.body);
  }
  const deniedByControl = reasonCode === 'AGENT_PAUSED' || reasonCode === 'CASE_CONTROLLED';
  if ((res.statusCode === 403 || deniedByControl || req[monadPermissionDenied]) && req[monadRequest]) {
    try {
      await monadPermissions.recordViolation({
        ...req[monadRequest], status: res.statusCode, reasonCode: reasonCode || 'PERMISSION_DENIED'
      });
    } catch (error) {
      console.error('Monad violation recording pending', {
        requestId: req[monadRequest].requestId, name: error instanceof Error ? error.name : 'Error'
      });
    }
  }
});
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.listen(port, host, () => console.log(`Envoi backend listening on http://${host}:${server.address().port}`));

let shutdownStarted = false;
const shutdown = () => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  scanLifecycleStopping = true;
  clearInterval(objectQuotaReaper);
  if (monadViolationRetry) clearInterval(monadViolationRetry);
  clearInterval(agentRotationReaper);
  clearInterval(registrationCleanup);
  clearInterval(caseSessionCleanup);
  clearInterval(humanRequestCleanup);
  if (wakeDispatch) clearInterval(wakeDispatch);
  if (wakeMaintenanceTimer) clearInterval(wakeMaintenanceTimer);
  if (caseSessionsHeartbeat) clearInterval(caseSessionsHeartbeat);
  clearInterval(operationalBacklogLogger);
  if (waitlistSheetInterval) clearInterval(waitlistSheetInterval);
  if (objectScanWorker) clearInterval(objectScanWorker);
  if (objectScanRetentionWorker) clearInterval(objectScanRetentionWorker);
  for (const set of streams.values()) for (const subscription of set) {
    clearInterval(subscription.heartbeat);
    subscription.res.end();
  }
  server.close(async () => {
    await Promise.allSettled([objectScanRun, objectScanRetentionRun, wakeDrainRun, wakeMaintenanceRun, humanRequestCleanupRun].filter(Boolean));
    await deliveryWorker.stop();
    if (store.close) await store.close();
    process.exit(0);
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
