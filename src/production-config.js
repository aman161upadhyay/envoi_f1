import { scannerHealthUrl } from './dependency-readiness.js';
import { createPostgresOptions } from './postgres-options.js';
import { applyLegacyEnvironmentFallbacks, retiredEnvironmentNames } from './envoi-environment.js';
import { isDeploymentName, STAGING_UNCAPPED_AGENT_HUMAN_IDS, stagingUncappedAgentHumanIds } from './deployment-identity.js';
import { onboardingFlagErrors } from './onboarding-flags.js';

const required = (env, name, errors, minimumLength = 1) => {
  const value = String(env[name] || '').trim();
  if (value.length < minimumLength) errors.push(`${name} is required${minimumLength > 1 ? ` and must be at least ${minimumLength} characters` : ''}`);
  return value;
};

const httpsUrl = (value, name, errors) => {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') errors.push(`${name} must use HTTPS`);
    if (parsed.username || parsed.password) errors.push(`${name} must not contain embedded credentials`);
    return parsed;
  } catch {
    errors.push(`${name} must be a valid HTTPS URL`);
    return null;
  }
};

export function validateProductionConfiguration(env = process.env) {
  // N2-config-2: a retired name is refused before the mode is read, so SINALOA_AUTH_MODE alone
  // can never select development mode for a production deployment.
  const retired = retiredEnvironmentNames(env);
  if (retired.length) throw new Error(`Retired SINALOA_* settings are no longer read; rename them to ENVOI_*: ${retired.join(', ')}`);
  env = applyLegacyEnvironmentFallbacks({ ...env });
  if (env.ENVOI_AUTH_MODE !== 'production') return { mode: env.ENVOI_AUTH_MODE || 'development', validated: false };
  const errors = [];
  if (env.ENVOI_RELEASE_SHA !== undefined && !/^[a-f0-9]{40}$/.test(env.ENVOI_RELEASE_SHA)) errors.push('ENVOI_RELEASE_SHA must be a full lowercase 40-character Git commit SHA');
  // The name this deployment stamps on its database (src/deployment-identity.js). wrangler.jsonc
  // sets it per environment; without it two deployments could share one database unnoticed.
  const deploymentEnvironment = required(env, 'ENVOI_DEPLOYMENT_ENVIRONMENT', errors);
  if (deploymentEnvironment && !isDeploymentName(deploymentEnvironment)) errors.push('ENVOI_DEPLOYMENT_ENVIRONMENT must be a lowercase deployment name such as staging or beta');
  const reassignFrom = env.ENVOI_DEPLOYMENT_IDENTITY_REASSIGN_FROM;
  if (reassignFrom !== undefined && (!isDeploymentName(reassignFrom) || reassignFrom === deploymentEnvironment)) errors.push('ENVOI_DEPLOYMENT_IDENTITY_REASSIGN_FROM must name a different deployment');
  const publicUrl = httpsUrl(required(env, 'ENVOI_PUBLIC_URL', errors), 'ENVOI_PUBLIC_URL', errors);
  const databaseUrl = required(env, 'DATABASE_URL', errors);
  if (databaseUrl) {
    try {
      // Use the same parser and TLS rules as startup, before a container is built.
      const options = createPostgresOptions(databaseUrl, env);
      if (!new URL(options.connectionString).hostname) errors.push('DATABASE_URL must include a PostgreSQL hostname');
    } catch (error) {
      errors.push(error.code === 'ERR_INVALID_URL' ? 'DATABASE_URL must be a valid PostgreSQL connection URL' : error.message);
    }
  }
  if ((env.ENVOI_DB_SSL_MODE || (env.ENVOI_DB_SSL === 'true' ? 'verify-full' : 'disable')) !== 'verify-full') errors.push('ENVOI_DB_SSL_MODE must be verify-full in production');
  if ((env.ENVOI_HUMAN_AUTH_PROVIDER || 'workos') !== 'workos') errors.push('ENVOI_HUMAN_AUTH_PROVIDER must be workos in production');
  required(env, 'WORKOS_CLIENT_ID', errors);
  required(env, 'WORKOS_API_KEY', errors);
  required(env, 'WORKOS_COOKIE_PASSWORD', errors, 32);
  const invitedEmails = required(env, 'ENVOI_BETA_INVITED_EMAILS', errors).split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  if (invitedEmails.some(email => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) errors.push('ENVOI_BETA_INVITED_EMAILS must contain exact email addresses');
  // The launch allowlist includes 31 waitlist recipients and one existing internal owner
  // whose Production WorkOS email is not on that list. The extra address is not an invite.
  if (new Set(invitedEmails).size > 32) errors.push('ENVOI_BETA_INVITED_EMAILS must contain at most 32 distinct addresses for the first beta');
  try { stagingUncappedAgentHumanIds(env[STAGING_UNCAPPED_AGENT_HUMAN_IDS], deploymentEnvironment); }
  catch (error) { errors.push(error.message); }
  const signupMode = env.ENVOI_HUMAN_SIGNUP_MODE || 'invite-only';
  if (!['invite-only', 'public'].includes(signupMode)) errors.push('ENVOI_HUMAN_SIGNUP_MODE must be invite-only or public');
  const publicSignupLimit = Number(env.ENVOI_PUBLIC_SIGNUP_LIMIT);
  if (signupMode === 'public' && (!Number.isSafeInteger(publicSignupLimit) || publicSignupLimit < 1 || publicSignupLimit > 100)) {
    errors.push('ENVOI_PUBLIC_SIGNUP_LIMIT must be an integer from 1 to 100 in public signup mode');
  }
  if (env.ENVOI_PUBLIC_SIGNUP_LIMIT !== undefined && (!Number.isSafeInteger(publicSignupLimit) || publicSignupLimit < 1 || publicSignupLimit > 100)) {
    errors.push('ENVOI_PUBLIC_SIGNUP_LIMIT must be an integer from 1 to 100');
  }
  const redirectUri = httpsUrl(required(env, 'WORKOS_REDIRECT_URI', errors), 'WORKOS_REDIRECT_URI', errors);
  if (publicUrl && redirectUri && publicUrl.origin !== redirectUri.origin) errors.push('WORKOS_REDIRECT_URI must use the ENVOI_PUBLIC_URL origin');
  const encryptionKey = required(env, 'ENVOI_DATA_ENCRYPTION_KEY', errors, 32);
  if (/development|changeme|example|sinaloa-development-only/i.test(encryptionKey)) errors.push('ENVOI_DATA_ENCRYPTION_KEY must not use a development or example value');
  const policyActiveKeyId = required(env, 'ENVOI_POLICY_ACTIVE_KEY_ID', errors);
  let policySigningKeys = {};
  if (env.ENVOI_POLICY_SIGNING_KEYS) {
    try {
      policySigningKeys = JSON.parse(env.ENVOI_POLICY_SIGNING_KEYS);
    } catch {
      errors.push('ENVOI_POLICY_SIGNING_KEYS must be a JSON object');
    }
  } else if (env.ENVOI_POLICY_SIGNING_KEY) {
    policySigningKeys = { [policyActiveKeyId]: env.ENVOI_POLICY_SIGNING_KEY };
  }
  if (!policySigningKeys || typeof policySigningKeys !== 'object' || Array.isArray(policySigningKeys)) errors.push('ENVOI_POLICY_SIGNING_KEYS must be a JSON object');
  if (typeof policySigningKeys?.[policyActiveKeyId] !== 'string' || policySigningKeys[policyActiveKeyId].length < 32) errors.push('The active policy signing key must be at least 32 characters');
  for (const [keyId, value] of Object.entries(policySigningKeys || {})) {
    if (!/^[A-Za-z0-9._:-]{1,64}$/.test(keyId) || typeof value !== 'string' || value.length < 32) errors.push('Every policy signing key ID and value must be valid');
    if (typeof value === 'string' && /development|changeme|example/i.test(value)) errors.push('Policy signing keys must not use development or example values');
  }
  const policyTtl = Number(env.ENVOI_POLICY_DECISION_TTL_SECONDS || 600);
  if (!Number.isSafeInteger(policyTtl) || policyTtl < 30 || policyTtl > 3600) errors.push('ENVOI_POLICY_DECISION_TTL_SECONDS must be an integer from 30 to 3600');
  const policyTolerance = Number(env.ENVOI_POLICY_EXECUTE_AT_TOLERANCE_SECONDS || 60);
  if (!Number.isSafeInteger(policyTolerance) || policyTolerance < 0 || policyTolerance > 3600) errors.push('ENVOI_POLICY_EXECUTE_AT_TOLERANCE_SECONDS must be an integer from 0 to 3600');
  const automaticPaymentLimit = Number(env.ENVOI_POLICY_MAX_AUTOMATIC_PAYMENT_MINOR || 0);
  if (!Number.isSafeInteger(automaticPaymentLimit) || automaticPaymentLimit < 0) errors.push('ENVOI_POLICY_MAX_AUTOMATIC_PAYMENT_MINOR must be a non-negative safe integer');
  if (env.ENVOI_COOKIE_SECURE !== 'true') errors.push('ENVOI_COOKIE_SECURE must be true in production');
  if (!['Lax', 'Strict'].includes(env.ENVOI_COOKIE_SAMESITE || 'Lax')) errors.push('ENVOI_COOKIE_SAMESITE must be Lax or Strict in production');

  const origins = String(env.ENVOI_CORS_ORIGIN || '').split(',').map(value => value.trim()).filter(Boolean);
  if (!origins.length || origins.includes('*')) errors.push('ENVOI_CORS_ORIGIN must contain explicit HTTPS origins');
  for (const origin of origins) {
    const parsed = httpsUrl(origin, 'ENVOI_CORS_ORIGIN', errors);
    if (parsed && (parsed.pathname !== '/' || parsed.search || parsed.hash)) errors.push('ENVOI_CORS_ORIGIN entries must be origins without paths, queries, or fragments');
  }
  if (publicUrl && origins.length && !origins.includes(publicUrl.origin)) errors.push('ENVOI_CORS_ORIGIN must include the ENVOI_PUBLIC_URL origin');

  if (env.ENVOI_OBJECT_STORAGE_PROVIDER !== 's3') errors.push('ENVOI_OBJECT_STORAGE_PROVIDER must be s3 in production');
  httpsUrl(required(env, 'ENVOI_S3_ENDPOINT', errors), 'ENVOI_S3_ENDPOINT', errors);
  required(env, 'ENVOI_S3_BUCKET', errors);
  required(env, 'ENVOI_S3_REGION', errors);
  required(env, 'ENVOI_S3_ACCESS_KEY_ID', errors);
  required(env, 'ENVOI_S3_SECRET_ACCESS_KEY', errors);
  httpsUrl(required(env, 'ENVOI_MALWARE_SCANNER_URL', errors), 'ENVOI_MALWARE_SCANNER_URL', errors);
  required(env, 'ENVOI_MALWARE_SCANNER_TOKEN', errors);
  if (env.ENVOI_MALWARE_SCANNER_HEALTH_URL) {
    httpsUrl(env.ENVOI_MALWARE_SCANNER_HEALTH_URL, 'ENVOI_MALWARE_SCANNER_HEALTH_URL', errors);
    try { scannerHealthUrl(env); } catch { errors.push('ENVOI_MALWARE_SCANNER_HEALTH_URL must use the scanner origin without embedded credentials'); }
  }

  const validDomain = value => /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value) && !value.endsWith('.mail');
  const platformDomain = required(env, 'ENVOI_AGENT_DOMAIN', errors).toLowerCase();
  if (!validDomain(platformDomain)) errors.push('ENVOI_AGENT_DOMAIN must be a registrable public DNS name and cannot use .mail in production');
  const externalEmailEnabled = env.ENVOI_ENABLE_EXTERNAL_EMAIL === 'true';
  let emailDomain = null;
  if (externalEmailEnabled) {
    if (env.ENVOI_EMAIL_PROVIDER !== 'resend') errors.push('ENVOI_EMAIL_PROVIDER must be resend when external email is enabled');
    emailDomain = required(env, 'ENVOI_PUBLIC_EMAIL_DOMAIN', errors).toLowerCase();
    if (!validDomain(emailDomain)) errors.push('ENVOI_PUBLIC_EMAIL_DOMAIN must be a registrable public DNS name and cannot use .mail');
    if (env.ENVOI_EMAIL_DOMAIN_VERIFIED !== 'true') errors.push('ENVOI_EMAIL_DOMAIN_VERIFIED must be true after provider DNS verification');
    required(env, 'RESEND_API_KEY', errors);
    required(env, 'RESEND_WEBHOOK_SECRET', errors);
  }

  if (env.ENVOI_ENABLE_CALENDAR_WRITES === 'true') {
    const providers = [
      ['GOOGLE_CALENDAR_CLIENT_ID', 'GOOGLE_CALENDAR_CLIENT_SECRET', 'GOOGLE_CALENDAR_REDIRECT_URI'],
      ['MICROSOFT_CALENDAR_CLIENT_ID', 'MICROSOFT_CALENDAR_CLIENT_SECRET', 'MICROSOFT_CALENDAR_REDIRECT_URI']
    ];
    const configured = providers.filter(names => names.every(name => String(env[name] || '').trim()));
    if (!configured.length) errors.push('At least one complete calendar OAuth provider is required when calendar writes are enabled');
    for (const names of providers) {
      const present = names.filter(name => String(env[name] || '').trim());
      if (present.length && present.length !== names.length) errors.push(`${names[0].replace('_CLIENT_ID', '')} OAuth configuration must include client ID, client secret, and redirect URI`);
      if (present.length === names.length) {
        const providerRedirect = httpsUrl(env[names[2]], names[2], errors);
        if (providerRedirect && publicUrl && providerRedirect.origin !== publicUrl.origin) errors.push(`${names[2]} must use the ENVOI_PUBLIC_URL origin`);
      }
    }
  }

  errors.push(...onboardingFlagErrors(env));

  const positiveIntegerVariables = [
    'ENVOI_PORT', 'ENVOI_MAX_BODY_BYTES', 'ENVOI_DB_POOL_SIZE', 'ENVOI_DB_CONNECT_TIMEOUT_MS',
    'ENVOI_DB_STATEMENT_TIMEOUT_MS', 'ENVOI_DB_QUERY_TIMEOUT_MS', 'ENVOI_REQUEST_TIMEOUT_MS',
    'ENVOI_READINESS_TIMEOUT_MS', 'ENVOI_MAX_SSE_PER_PRINCIPAL', 'ENVOI_AGENT_ACCESS_TOKEN_TTL_SECONDS',
    'ENVOI_AGENT_REFRESH_TOKEN_TTL_DAYS', 'ENVOI_DELIVERY_MAX_ATTEMPTS', 'ENVOI_DELIVERY_POLL_MS',
    'ENVOI_DELIVERY_LEASE_MS', 'ENVOI_DELIVERY_RETRY_BASE_MS', 'ENVOI_DELIVERY_RETRY_MAX_MS',
    'ENVOI_OBJECT_MAX_BYTES', 'ENVOI_WORKSPACE_OBJECT_QUOTA_BYTES', 'ENVOI_OBJECT_QUOTA_REAPER_INTERVAL_MS',
    'ENVOI_S3_REQUEST_TIMEOUT_MS', 'ENVOI_SCAN_WORKER_INTERVAL_MS', 'ENVOI_SCAN_RETENTION_INTERVAL_MS',
    'ENVOI_SCAN_MAX_ATTEMPTS', 'ENVOI_SCAN_LEASE_MS', 'ENVOI_SCAN_RETRY_BASE_MS', 'ENVOI_SCAN_RETRY_MAX_MS',
    'ENVOI_SCAN_INFECTED_RETENTION_MS', 'ENVOI_SCAN_DEAD_LETTER_RETENTION_MS', 'ENVOI_SCAN_COMPLETED_JOB_RETENTION_MS', 'ENVOI_SCAN_RETENTION_RETRY_MS',
    'ENVOI_EXTERNAL_EMAIL_AGENT_HOURLY_LIMIT', 'ENVOI_EXTERNAL_EMAIL_RECIPIENT_HOURLY_LIMIT',
    'ENVOI_CALENDAR_OAUTH_TIMEOUT_MS', 'ENVOI_OTP_EXPIRY_MINUTES', 'ENVOI_SESSION_HOURS', 'ENVOI_AUTH_FLOW_MINUTES'
  ];
  for (const name of positiveIntegerVariables) {
    if (env[name] !== undefined && (!Number.isSafeInteger(Number(env[name])) || Number(env[name]) < 1)) errors.push(`${name} must be a positive integer`);
  }
  const maximums = {
    ENVOI_PORT: 65_535,
    ENVOI_MAX_BODY_BYTES: 104_857_600,
    ENVOI_DB_POOL_SIZE: 200,
    ENVOI_DB_CONNECT_TIMEOUT_MS: 120_000,
    ENVOI_DB_STATEMENT_TIMEOUT_MS: 120_000,
    ENVOI_DB_QUERY_TIMEOUT_MS: 120_000,
    ENVOI_REQUEST_TIMEOUT_MS: 120_000,
    ENVOI_READINESS_TIMEOUT_MS: 120_000,
    ENVOI_MAX_SSE_PER_PRINCIPAL: 1_000,
    ENVOI_AGENT_ACCESS_TOKEN_TTL_SECONDS: 86_400,
    ENVOI_AGENT_REFRESH_TOKEN_TTL_DAYS: 365,
    ENVOI_DELIVERY_MAX_ATTEMPTS: 100,
    ENVOI_S3_REQUEST_TIMEOUT_MS: 120_000,
    ENVOI_CALENDAR_OAUTH_TIMEOUT_MS: 120_000,
    ENVOI_DELIVERY_POLL_MS: 2_147_483_647,
    ENVOI_DELIVERY_LEASE_MS: 2_147_483_647,
    ENVOI_DELIVERY_RETRY_BASE_MS: 2_147_483_647,
    ENVOI_DELIVERY_RETRY_MAX_MS: 2_147_483_647,
    ENVOI_OBJECT_QUOTA_REAPER_INTERVAL_MS: 2_147_483_647,
    ENVOI_OBJECT_MAX_BYTES: 5_368_709_120,
    ENVOI_WORKSPACE_OBJECT_QUOTA_BYTES: 1_099_511_627_776,
    ENVOI_SCAN_WORKER_INTERVAL_MS: 2_147_483_647,
    ENVOI_SCAN_RETENTION_INTERVAL_MS: 2_147_483_647,
    ENVOI_SCAN_MAX_ATTEMPTS: 100,
    ENVOI_SCAN_LEASE_MS: 2_147_483_647,
    ENVOI_SCAN_RETRY_BASE_MS: 2_147_483_647,
    ENVOI_SCAN_RETRY_MAX_MS: 2_147_483_647,
    ENVOI_SCAN_INFECTED_RETENTION_MS: 31_536_000_000,
    ENVOI_SCAN_DEAD_LETTER_RETENTION_MS: 31_536_000_000,
    ENVOI_SCAN_COMPLETED_JOB_RETENTION_MS: 31_536_000_000,
    ENVOI_SCAN_RETENTION_RETRY_MS: 2_147_483_647,
    ENVOI_OTP_EXPIRY_MINUTES: 60,
    ENVOI_SESSION_HOURS: 720,
    ENVOI_AUTH_FLOW_MINUTES: 60,
    ENVOI_EXTERNAL_EMAIL_AGENT_HOURLY_LIMIT: 100_000,
    ENVOI_EXTERNAL_EMAIL_RECIPIENT_HOURLY_LIMIT: 100_000
  };
  for (const [name, maximum] of Object.entries(maximums)) {
    if (env[name] !== undefined && Number(env[name]) > maximum) errors.push(`${name} must not exceed ${maximum}`);
  }
  if (env.ENVOI_DELIVERY_RETRY_BASE_MS !== undefined && env.ENVOI_DELIVERY_RETRY_MAX_MS !== undefined && Number(env.ENVOI_DELIVERY_RETRY_BASE_MS) > Number(env.ENVOI_DELIVERY_RETRY_MAX_MS)) errors.push('ENVOI_DELIVERY_RETRY_BASE_MS must not exceed ENVOI_DELIVERY_RETRY_MAX_MS');
  if (env.ENVOI_SCAN_RETRY_BASE_MS !== undefined && env.ENVOI_SCAN_RETRY_MAX_MS !== undefined && Number(env.ENVOI_SCAN_RETRY_BASE_MS) > Number(env.ENVOI_SCAN_RETRY_MAX_MS)) errors.push('ENVOI_SCAN_RETRY_BASE_MS must not exceed ENVOI_SCAN_RETRY_MAX_MS');

  if (errors.length) throw new Error(`Invalid production configuration:\n- ${[...new Set(errors)].join('\n- ')}`);
  return { mode: 'production', validated: true, deploymentEnvironment, publicOrigin: publicUrl.origin, corsOrigins: origins, platformDomain, externalEmailEnabled, emailDomain, objectStorageProvider: 's3', humanAuthProvider: 'workos', humanSignupMode: signupMode, publicSignupLimit: signupMode === 'public' ? publicSignupLimit : 0, databaseTlsMode: 'verify-full', policyActiveKeyId };
}
