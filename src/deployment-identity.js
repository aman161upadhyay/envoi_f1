// A database belongs to exactly one deployment (staging, beta, ...). Two deployments on one
// database share one outbox, so either delivery worker can claim the other's work and settle
// it under its own rules: on 2026-10-15 beta's older worker dead-lettered a staging delivery to
// a paused agent. The first server to start stamps the database with its deployment name;
// every later start, readiness probe and outbox claim checks the stamp. Names only: the
// identity holds nothing secret, so errors and /ready may show it.
export const DEPLOYMENT_IDENTITY_PATH = 'deployment/identity.json';
export const DEPLOYMENT_IDENTITY_MISMATCH = 'DEPLOYMENT_IDENTITY_MISMATCH';
const DEPLOYMENT_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const DEVELOPMENT_ENVIRONMENT = 'development';

export const isDeploymentName = value => typeof value === 'string' && DEPLOYMENT_NAME.test(value);

export const STAGING_UNCAPPED_AGENT_HUMAN_IDS = 'ENVOI_STAGING_UNCAPPED_AGENT_HUMAN_IDS';
const HUMAN_ID = /^human_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// An exact, staging-only exception for at most two existing humans.
export function stagingUncappedAgentHumanIds(value, environment) {
  if (value === undefined || value === null || value === '') return new Set();
  if (environment !== 'staging' || typeof value !== 'string') {
    throw new Error(`${STAGING_UNCAPPED_AGENT_HUMAN_IDS} is only valid in staging`);
  }
  const ids = value.split(',').map(id => id.trim());
  if (ids.length < 1 || ids.length > 2 || ids.some(id => !HUMAN_ID.test(id)) || new Set(ids).size !== ids.length) {
    throw new Error(`${STAGING_UNCAPPED_AGENT_HUMAN_IDS} must contain one or two distinct exact human IDs`);
  }
  return new Set(ids);
}

// Production must name its deployment (production-config.js). Anything else defaults to
// `development`, so a local server pointed at a hosted database refuses to start as well.
export function configuredDeploymentIdentity(env = process.env) {
  const environment = env.ENVOI_DEPLOYMENT_ENVIRONMENT || DEVELOPMENT_ENVIRONMENT;
  const reassignFrom = env.ENVOI_DEPLOYMENT_IDENTITY_REASSIGN_FROM || null;
  if (!isDeploymentName(environment)) throw new Error('ENVOI_DEPLOYMENT_ENVIRONMENT must be a lowercase deployment name such as staging or beta');
  if (reassignFrom !== null && (!isDeploymentName(reassignFrom) || reassignFrom === environment)) {
    throw new Error('ENVOI_DEPLOYMENT_IDENTITY_REASSIGN_FROM must name a different deployment');
  }
  return { environment, reassignFrom };
}

function mismatch(stored, environment) {
  const owner = isDeploymentName(stored?.environment) ? `the "${stored.environment}" deployment` : 'another deployment';
  return Object.assign(new Error(`This database belongs to ${owner}, but this server is configured as "${environment}" (ENVOI_DEPLOYMENT_ENVIRONMENT). `
    + 'Each deployment needs its own database. To move this database to this deployment on purpose, set '
    + 'ENVOI_DEPLOYMENT_IDENTITY_REASSIGN_FROM to its current deployment name for one start, then remove it.'), { code: DEPLOYMENT_IDENTITY_MISMATCH });
}

// 'absent' (never stamped), 'match', or 'reassign' (the operator named the current owner).
export function deploymentIdentityDecision(stored, { environment, reassignFrom = null }) {
  if (!stored) return 'absent';
  if (stored.environment === environment) return 'match';
  if (reassignFrom && stored.environment === reassignFrom) return 'reassign';
  throw mismatch(stored, environment);
}

// Before migrations, the documents table may not exist yet (a new database): nothing is stamped.
export async function readDeploymentIdentity(store) {
  try { return await store.getJson(DEPLOYMENT_IDENTITY_PATH); }
  catch (error) { if (error?.code === '42P01') return null; throw error; }
}

// Read-only, so a server configured for another deployment migrates nothing.
export async function verifyDeploymentIdentityBeforeInit(store, identity) {
  deploymentIdentityDecision(await readDeploymentIdentity(store), identity);
}

export async function ensureDeploymentIdentity(store, { environment, reassignFrom = null, releaseSha = null, now = () => new Date().toISOString(), logger = console }) {
  const stamped = { environment, stampedAt: now(), stampedByReleaseSha: releaseSha };
  if (await store.putJsonIfAbsent(DEPLOYMENT_IDENTITY_PATH, stamped)) {
    logger.info?.(`Stamped this database for the "${environment}" deployment`);
    return stamped;
  }
  // Decided under the document lock, so two starts cannot both reassign or both pass.
  let reassignedFrom = null;
  const stored = await store.updateJson(DEPLOYMENT_IDENTITY_PATH, current => {
    if (deploymentIdentityDecision(current, { environment, reassignFrom }) !== 'reassign') return null;
    reassignedFrom = current.environment;
    return { environment, stampedAt: now(), stampedByReleaseSha: releaseSha, reassignedFrom, previousStampedAt: current.stampedAt ?? null };
  });
  if (reassignedFrom) logger.warn?.(`Reassigned this database from the "${reassignedFrom}" deployment to "${environment}"; remove ENVOI_DEPLOYMENT_IDENTITY_REASSIGN_FROM`);
  return stored;
}

// Readiness: the stamp written at start must still name this deployment.
export async function assertDeploymentIdentity(store, environment) {
  const stored = await readDeploymentIdentity(store);
  if (stored?.environment !== environment) throw mismatch(stored, environment);
}
