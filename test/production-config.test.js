import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProductionConfiguration } from '../src/production-config.js';
import { deploymentPreflight } from '../src/deployment-preflight.js';

const validProduction = (overrides = {}) => ({
  ENVOI_AUTH_MODE: 'production',
  ENVOI_DEPLOYMENT_ENVIRONMENT: 'beta',
  ENVOI_PUBLIC_URL: 'https://app.sinaloa.example',
  DATABASE_URL: 'postgresql://user:secret@db.example/sinaloa',
  ENVOI_DB_SSL_MODE: 'verify-full',
  ENVOI_HUMAN_AUTH_PROVIDER: 'workos',
  WORKOS_CLIENT_ID: 'client_123',
  WORKOS_API_KEY: 'sk_live_123',
  WORKOS_COOKIE_PASSWORD: 'a'.repeat(32),
  WORKOS_REDIRECT_URI: 'https://app.sinaloa.example/api/auth/workos/callback',
  ENVOI_BETA_INVITED_EMAILS: 'alice@example.com,bob@example.com',
  ENVOI_DATA_ENCRYPTION_KEY: 'b'.repeat(32),
  ENVOI_POLICY_ACTIVE_KEY_ID: 'primary',
  ENVOI_POLICY_SIGNING_KEY: 'c'.repeat(32),
  ENVOI_COOKIE_SECURE: 'true',
  ENVOI_COOKIE_SAMESITE: 'Lax',
  ENVOI_CORS_ORIGIN: 'https://app.sinaloa.example',
  ENVOI_AGENT_DOMAIN: 'agents.sinaloa.example',
  ENVOI_OBJECT_STORAGE_PROVIDER: 's3',
  ENVOI_S3_ENDPOINT: 'https://s3.ca-central-1.amazonaws.com',
  ENVOI_S3_BUCKET: 'sinaloa-private',
  ENVOI_S3_REGION: 'ca-central-1',
  ENVOI_S3_ACCESS_KEY_ID: 'access',
  ENVOI_S3_SECRET_ACCESS_KEY: 'secret',
  ENVOI_MALWARE_SCANNER_URL: 'https://scanner.sinaloa.example/scan',
  ENVOI_MALWARE_SCANNER_TOKEN: 'private-scanner-test-token',
  ENVOI_ENABLE_EXTERNAL_EMAIL: 'false',
  ...overrides
});

// N2-config-2: retired SINALOA_* names are refused in every mode, naming the settings only.
test('retired SINALOA-prefixed settings are refused, never silently ignored', () => {
  const legacy = Object.fromEntries(Object.entries(validProduction()).map(([key, value]) => [
    key.startsWith('ENVOI_') && key !== 'ENVOI_DATA_ENCRYPTION_KEY' ? `SINALOA_${key.slice('ENVOI_'.length)}` : key,
    value
  ]));
  assert.throws(() => validateProductionConfiguration(legacy), error => {
    assert.match(error.message, /Retired SINALOA_\* settings are no longer read; rename them to ENVOI_\*: .*SINALOA_AUTH_MODE, /);
    assert.equal(error.message.includes('private-scanner-test-token'), false);
    return true;
  });
  // SINALOA_AUTH_MODE alone must not select development mode.
  assert.throws(() => validateProductionConfiguration({ SINALOA_AUTH_MODE: 'production' }), /SINALOA_AUTH_MODE/);
});

test('production names the deployment its database belongs to', () => {
  assert.equal(validateProductionConfiguration(validProduction()).deploymentEnvironment, 'beta');
  assert.throws(() => validateProductionConfiguration(validProduction({ ENVOI_DEPLOYMENT_ENVIRONMENT: '' })), /ENVOI_DEPLOYMENT_ENVIRONMENT is required/);
  for (const name of ['Beta', 'beta staging', '-beta', 'b'.repeat(33)]) {
    assert.throws(() => validateProductionConfiguration(validProduction({ ENVOI_DEPLOYMENT_ENVIRONMENT: name })), /ENVOI_DEPLOYMENT_ENVIRONMENT must be a lowercase deployment name/);
  }
  assert.equal(validateProductionConfiguration(validProduction({ ENVOI_DEPLOYMENT_IDENTITY_REASSIGN_FROM: 'staging' })).validated, true);
  for (const name of ['beta', 'Staging', '']) {
    assert.throws(() => validateProductionConfiguration(validProduction({ ENVOI_DEPLOYMENT_IDENTITY_REASSIGN_FROM: name })), /ENVOI_DEPLOYMENT_IDENTITY_REASSIGN_FROM must name a different deployment/);
  }
});

test('uncapped agent exception is valid only for at most two exact staging humans', () => {
  const first = 'human_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const second = 'human_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  assert.equal(validateProductionConfiguration(validProduction({ ENVOI_DEPLOYMENT_ENVIRONMENT: 'staging', ENVOI_STAGING_UNCAPPED_AGENT_HUMAN_IDS: `${first},${second}` })).validated, true);
  assert.throws(() => validateProductionConfiguration(validProduction({ ENVOI_STAGING_UNCAPPED_AGENT_HUMAN_IDS: first })), /only valid in staging/);
  assert.throws(() => validateProductionConfiguration(validProduction({ ENVOI_DEPLOYMENT_ENVIRONMENT: 'staging', ENVOI_STAGING_UNCAPPED_AGENT_HUMAN_IDS: '*' })), /one or two distinct exact human IDs/);
});

test('the data encryption key may still come from its one honoured legacy name', () => {
  const { ENVOI_DATA_ENCRYPTION_KEY: key, ...rest } = validProduction();
  assert.equal(validateProductionConfiguration({ ...rest, SINALOA_DATA_ENCRYPTION_KEY: key }).validated, true);
  assert.equal(validateProductionConfiguration({ ...rest, ENVOI_DATA_ENCRYPTION_KEY: key, SINALOA_DATA_ENCRYPTION_KEY: key }).validated, true);
  assert.throws(() => validateProductionConfiguration({ ...rest, ENVOI_DATA_ENCRYPTION_KEY: key, SINALOA_DATA_ENCRYPTION_KEY: `${key}-other` }),
    error => /Conflicting Envoi environment settings: ENVOI_DATA_ENCRYPTION_KEY and SINALOA_DATA_ENCRYPTION_KEY/.test(error.message) && !error.message.includes(key));
});

test('production requires an exact invite list without SMS credentials', () => {
  assert.throws(() => validateProductionConfiguration(validProduction({ ENVOI_BETA_INVITED_EMAILS: '' })), /ENVOI_BETA_INVITED_EMAILS is required/);
  assert.throws(() => validateProductionConfiguration(validProduction({ ENVOI_BETA_INVITED_EMAILS: 'example.com' })), /exact email addresses/);
  assert.equal(validateProductionConfiguration(validProduction({ ENVOI_BETA_INVITED_EMAILS: Array.from({ length: 31 }, (_, index) => `person${index}@example.com`).join(',') })).validated, true);
  const cohortAndOwner = [...Array.from({ length: 31 }, (_, index) => `person${index}@example.com`), 'existing-owner@example.com'];
  assert.equal(validateProductionConfiguration(validProduction({ ENVOI_BETA_INVITED_EMAILS: cohortAndOwner.join(',') })).validated, true);
  assert.throws(() => validateProductionConfiguration(validProduction({ ENVOI_BETA_INVITED_EMAILS: [...cohortAndOwner, 'extra@example.com'].join(',') })), /at most 32 distinct addresses/);
  assert.equal(validateProductionConfiguration(validProduction()).validated, true);
});

test('public signup requires an explicit mode, exact invite list and a bounded account limit', () => {
  const closed = validateProductionConfiguration(validProduction());
  assert.equal(closed.humanSignupMode, 'invite-only');
  assert.equal(closed.publicSignupLimit, 0);
  const publicMode = validateProductionConfiguration(validProduction({ ENVOI_HUMAN_SIGNUP_MODE: 'public', ENVOI_PUBLIC_SIGNUP_LIMIT: '100' }));
  assert.equal(publicMode.humanSignupMode, 'public');
  assert.equal(publicMode.publicSignupLimit, 100);
  for (const limit of [undefined, '0', '101', '1.5', 'NaN']) {
    assert.throws(() => validateProductionConfiguration(validProduction({ ENVOI_HUMAN_SIGNUP_MODE: 'public', ENVOI_PUBLIC_SIGNUP_LIMIT: limit })), /ENVOI_PUBLIC_SIGNUP_LIMIT/);
  }
  assert.throws(() => validateProductionConfiguration(validProduction({ ENVOI_HUMAN_SIGNUP_MODE: 'open' })), /ENVOI_HUMAN_SIGNUP_MODE/);
  assert.throws(() => validateProductionConfiguration(validProduction({ ENVOI_HUMAN_SIGNUP_MODE: 'public', ENVOI_PUBLIC_SIGNUP_LIMIT: '100', ENVOI_BETA_INVITED_EMAILS: '' })), /ENVOI_BETA_INVITED_EMAILS is required/);
  const cohortAndOwner = [...Array.from({ length: 31 }, (_, index) => `person${index}@example.com`), 'existing-owner@example.com'];
  assert.equal(validateProductionConfiguration(validProduction({ ENVOI_HUMAN_SIGNUP_MODE: 'public', ENVOI_PUBLIC_SIGNUP_LIMIT: '100', ENVOI_BETA_INVITED_EMAILS: cohortAndOwner.join(',') })).validated, true);
  assert.throws(() => validateProductionConfiguration(validProduction({ ENVOI_HUMAN_SIGNUP_MODE: 'public', ENVOI_PUBLIC_SIGNUP_LIMIT: '100', ENVOI_BETA_INVITED_EMAILS: [...cohortAndOwner, 'extra@example.com'].join(',') })), /at most 32 distinct addresses/);
});

test('development configuration remains local while production fails unsafe dependencies closed', () => {
  assert.deepEqual(validateProductionConfiguration({ ENVOI_AUTH_MODE: 'development' }), { mode: 'development', validated: false });
  assert.throws(() => validateProductionConfiguration(validProduction({ DATABASE_URL: '', ENVOI_OBJECT_STORAGE_PROVIDER: 'local', ENVOI_AGENT_DOMAIN: 'envoi.mail' })), /DATABASE_URL is required[\s\S]*must be s3[\s\S]*cannot use \.mail/);
});

test('production scanner health stays on the authenticated scanner origin', () => {
  assert.throws(() => validateProductionConfiguration(validProduction({ ENVOI_MALWARE_SCANNER_HEALTH_URL: 'https://unrelated.example/health' })), /must use the scanner origin/);
  assert.throws(() => validateProductionConfiguration(validProduction({ ENVOI_MALWARE_SCANNER_URL: 'https://user:password@scanner.example/scan' })), /must not contain embedded credentials/);
  assert.equal(validateProductionConfiguration(validProduction({ ENVOI_MALWARE_SCANNER_HEALTH_URL: 'https://scanner.sinaloa.example/status' })).validated, true);
});

test('production supports native platform routing without SMTP and conditionally validates public email', () => {
  const nativeOnly = validateProductionConfiguration(validProduction());
  assert.equal(nativeOnly.validated, true);
  assert.equal(nativeOnly.externalEmailEnabled, false);
  assert.equal(nativeOnly.emailDomain, null);

  assert.throws(() => validateProductionConfiguration(validProduction({ ENVOI_ENABLE_EXTERNAL_EMAIL: 'true' })), /ENVOI_EMAIL_PROVIDER must be resend[\s\S]*RESEND_API_KEY is required/);

  const dualTransport = validateProductionConfiguration(validProduction({
    ENVOI_ENABLE_EXTERNAL_EMAIL: 'true',
    ENVOI_EMAIL_PROVIDER: 'resend',
    ENVOI_PUBLIC_EMAIL_DOMAIN: 'mail.sinaloa.example',
    ENVOI_EMAIL_DOMAIN_VERIFIED: 'true',
    RESEND_API_KEY: 're_live_123',
    RESEND_WEBHOOK_SECRET: 'whsec_123'
  }));
  assert.equal(dualTransport.externalEmailEnabled, true);
  assert.equal(dualTransport.emailDomain, 'mail.sinaloa.example');
});

test('production rejects insecure database TLS and invalid numeric limits', () => {
  assert.throws(() => validateProductionConfiguration(validProduction({ ENVOI_DB_SSL_MODE: 'disable' })), /verify-full/);
  assert.throws(() => validateProductionConfiguration(validProduction({ ENVOI_DB_POOL_SIZE: 'NaN', ENVOI_REQUEST_TIMEOUT_MS: '0' })), /ENVOI_DB_POOL_SIZE must be a positive integer[\s\S]*ENVOI_REQUEST_TIMEOUT_MS must be a positive integer/);
  assert.throws(() => validateProductionConfiguration(validProduction({ ENVOI_MAX_BODY_BYTES: '104857601', ENVOI_DB_POOL_SIZE: '201', ENVOI_OBJECT_MAX_BYTES: '5368709121', ENVOI_AGENT_REFRESH_TOKEN_TTL_DAYS: '366', ENVOI_SCAN_MAX_ATTEMPTS: '101' })), /ENVOI_MAX_BODY_BYTES must not exceed[\s\S]*ENVOI_DB_POOL_SIZE must not exceed[\s\S]*ENVOI_AGENT_REFRESH_TOKEN_TTL_DAYS must not exceed[\s\S]*ENVOI_OBJECT_MAX_BYTES must not exceed[\s\S]*ENVOI_SCAN_MAX_ATTEMPTS must not exceed/);
  assert.throws(() => validateProductionConfiguration(validProduction({ ENVOI_SCAN_RETRY_BASE_MS: '1000', ENVOI_SCAN_RETRY_MAX_MS: '999' })), /SCAN_RETRY_BASE_MS must not exceed/);
});

test('deployment preflight rejects database URLs that cannot start the container', () => {
  const environment = validProduction({ ENVOI_EDGE_ALLOWED_HOSTS: 'app.sinaloa.example' });
  assert.equal(deploymentPreflight(environment).ready, true);
  for (const parameter of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) {
    const report = deploymentPreflight({ ...environment, DATABASE_URL: `${environment.DATABASE_URL}?${parameter}=require` });
    assert.equal(report.ready, false);
    assert.ok(report.errors.some(message => /not DATABASE_URL query parameters/.test(message)));
    assert.doesNotMatch(JSON.stringify(report), /user:secret/);
  }
  for (const databaseUrl of ['postgresql://user:secret@[broken/db', 'postgresql:///sinaloa', 'https://db.example/sinaloa']) {
    const report = deploymentPreflight({ ...environment, DATABASE_URL: databaseUrl });
    assert.equal(report.ready, false);
    assert.ok(report.errors.some(message => message.includes('DATABASE_URL')));
    assert.doesNotMatch(JSON.stringify(report), /user:secret/);
  }
});

test('production requires complete same-origin calendar OAuth when writes are enabled', () => {
  assert.throws(() => validateProductionConfiguration(validProduction({ ENVOI_ENABLE_CALENDAR_WRITES: 'true' })), /complete calendar OAuth provider/);
  assert.throws(() => validateProductionConfiguration(validProduction({ ENVOI_ENABLE_CALENDAR_WRITES: 'true', GOOGLE_CALENDAR_CLIENT_ID: 'client' })), /GOOGLE_CALENDAR OAuth configuration/);
  const configured = validateProductionConfiguration(validProduction({
    ENVOI_ENABLE_CALENDAR_WRITES: 'true',
    GOOGLE_CALENDAR_CLIENT_ID: 'client',
    GOOGLE_CALENDAR_CLIENT_SECRET: 'secret',
    GOOGLE_CALENDAR_REDIRECT_URI: 'https://app.sinaloa.example/api/calendar-oauth/google/callback',
    ENVOI_CALENDAR_OAUTH_TIMEOUT_MS: '15000'
  }));
  assert.equal(configured.validated, true);
});

test('production validates policy key rotation and strict policy bounds', () => {
  assert.throws(() => validateProductionConfiguration(validProduction({ ENVOI_POLICY_SIGNING_KEY: '', ENVOI_POLICY_ACTIVE_KEY_ID: 'missing' })), /active policy signing key/);
  assert.throws(() => validateProductionConfiguration(validProduction({ ENVOI_POLICY_SIGNING_KEY: 'example-signing-key'.padEnd(32, 'x') })), /Policy signing keys must not use development or example values/);
  assert.throws(() => validateProductionConfiguration(validProduction({ ENVOI_POLICY_SIGNING_KEY: '', ENVOI_POLICY_SIGNING_KEYS: JSON.stringify({ primary: 'changeme'.padEnd(32, 'x') }) })), /Policy signing keys must not use development or example values/);
  assert.throws(() => validateProductionConfiguration(validProduction({ ENVOI_POLICY_DECISION_TTL_SECONDS: '1', ENVOI_POLICY_EXECUTE_AT_TOLERANCE_SECONDS: 'NaN' })), /ENVOI_POLICY_DECISION_TTL_SECONDS[\s\S]*ENVOI_POLICY_EXECUTE_AT_TOLERANCE_SECONDS/);
  const rotated = validateProductionConfiguration(validProduction({
    ENVOI_POLICY_SIGNING_KEY: '',
    ENVOI_POLICY_ACTIVE_KEY_ID: 'new',
    ENVOI_POLICY_SIGNING_KEYS: JSON.stringify({ old: 'o'.repeat(32), new: 'n'.repeat(32) })
  }));
  assert.equal(rotated.policyActiveKeyId, 'new');
});

test('production calendar writes require one complete same-origin HTTPS provider', () => {
  assert.throws(() => validateProductionConfiguration(validProduction({ ENVOI_ENABLE_CALENDAR_WRITES: 'true' })), /complete calendar OAuth provider/);
  assert.throws(() => validateProductionConfiguration(validProduction({
    ENVOI_ENABLE_CALENDAR_WRITES: 'true',
    GOOGLE_CALENDAR_CLIENT_ID: 'google-client',
    GOOGLE_CALENDAR_CLIENT_SECRET: 'google-secret'
  })), /must include client ID, client secret, and redirect URI/);
  assert.throws(() => validateProductionConfiguration(validProduction({
    ENVOI_ENABLE_CALENDAR_WRITES: 'true',
    GOOGLE_CALENDAR_CLIENT_ID: 'google-client',
    GOOGLE_CALENDAR_CLIENT_SECRET: 'google-secret',
    GOOGLE_CALENDAR_REDIRECT_URI: 'https://other.example/api/calendar-oauth/google/callback'
  })), /must use the ENVOI_PUBLIC_URL origin/);
  const configured = validateProductionConfiguration(validProduction({
    ENVOI_ENABLE_CALENDAR_WRITES: 'true',
    GOOGLE_CALENDAR_CLIENT_ID: 'google-client',
    GOOGLE_CALENDAR_CLIENT_SECRET: 'google-secret',
    GOOGLE_CALENDAR_REDIRECT_URI: 'https://app.sinaloa.example/api/calendar-oauth/google/callback'
  }));
  assert.equal(configured.validated, true);
});


test('production requires scanner authentication before deployment with redacted diagnostics', () => {
  for (const token of [undefined, '', '   ']) {
    const env = validProduction({ ENVOI_MALWARE_SCANNER_TOKEN: token, ENVOI_EDGE_ALLOWED_HOSTS: 'app.sinaloa.example' });
    assert.throws(() => validateProductionConfiguration(env), /ENVOI_MALWARE_SCANNER_TOKEN is required/);
    const report = deploymentPreflight(env);
    assert.equal(report.ready, false);
    assert.ok(report.errors.some(message => message.includes('ENVOI_MALWARE_SCANNER_TOKEN')));
    assert.doesNotMatch(JSON.stringify(report), /private-scanner-test-token|user:secret|sk_live_123/);
  }
  assert.equal(validateProductionConfiguration(validProduction()).validated, true);
  assert.equal(validateProductionConfiguration({ ENVOI_AUTH_MODE: 'development' }).validated, false);
});

// agent-registration v1 §12: the Phase B flags default off and refuse values that are not exactly true or false.
test('production validates the onboarding flags', () => {
  assert.equal(validateProductionConfiguration(validProduction()).validated, true);
  assert.equal(validateProductionConfiguration(validProduction({ ENVOI_INSTALLATIONS_V2: 'false', ENVOI_AGENT_REGISTRATION_V2: 'false', ENVOI_AUTHENTICATED_REST_ROUTE: 'false' })).validated, true);
  assert.equal(validateProductionConfiguration(validProduction({ ENVOI_INSTALLATIONS_V2: 'true', ENVOI_AGENT_REGISTRATION_V2: 'true', ENVOI_AUTHENTICATED_REST_ROUTE: 'true' })).validated, true);
  for (const name of ['ENVOI_INSTALLATIONS_V2', 'ENVOI_AGENT_REGISTRATION_V2', 'ENVOI_AUTHENTICATED_REST_ROUTE']) {
    assert.throws(() => validateProductionConfiguration(validProduction({ ENVOI_INSTALLATIONS_V2: 'true', [name]: 'TRUE' })), new RegExp(`${name} must be true or false`));
  }
  assert.throws(() => validateProductionConfiguration(validProduction({ ENVOI_AGENT_REGISTRATION_V2: 'true', ENVOI_INSTALLATIONS_V2: 'false' })), /ENVOI_AGENT_REGISTRATION_V2 requires ENVOI_INSTALLATIONS_V2/);
});

test('production permits legacy deployments without a release SHA but validates supplied provenance', () => {
  assert.equal(validateProductionConfiguration(validProduction()).validated, true);
  assert.equal(validateProductionConfiguration(validProduction({ ENVOI_RELEASE_SHA: 'a'.repeat(40) })).validated, true);
  for (const sha of ['', 'main', 'a'.repeat(7), 'g'.repeat(40), 'A'.repeat(40)]) {
    assert.throws(() => validateProductionConfiguration(validProduction({ ENVOI_RELEASE_SHA: sha })), /ENVOI_RELEASE_SHA must be a full lowercase/);
  }
});
