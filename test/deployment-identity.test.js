// A server refuses a database stamped by another deployment, and its delivery worker never
// claims outbox rows from one (2026-10-15: beta and staging shared a database, and beta's
// worker dead-lettered a staging delivery). FileStore always; PostgreSQL when DATABASE_URL is
// set (CI test:postgres).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/storage.js';
import { DeliveryWorker } from '../src/delivery-worker.js';
import { evaluateReadiness } from '../src/readiness.js';
import { dependencyReadinessChecks } from '../src/dependency-readiness.js';
import {
  DEPLOYMENT_IDENTITY_MISMATCH, DEPLOYMENT_IDENTITY_PATH, assertDeploymentIdentity, configuredDeploymentIdentity,
  ensureDeploymentIdentity, stagingUncappedAgentHumanIds, verifyDeploymentIdentityBeforeInit
} from '../src/deployment-identity.js';
import { launch } from './a3-harness.js';

const quiet = { info() {}, warn() {} };
const humanId = seed => `human_${seed.repeat(8)}-${seed.repeat(4)}-${seed.repeat(4)}-${seed.repeat(4)}-${seed.repeat(12)}`;

test('staging uncapped agent IDs require one or two distinct exact existing-ID shapes', () => {
  const first = humanId('a');
  const second = humanId('b');
  assert.deepEqual([...stagingUncappedAgentHumanIds(`${first}, ${second}`, 'staging')], [first, second]);
  assert.equal(stagingUncappedAgentHumanIds(undefined, 'staging').size, 0);
  for (const value of [first, 'not-a-human', `${first},${first}`, `${first},${second},${humanId('c')}`, '*', '']) {
    if (value === '') continue;
    assert.throws(() => stagingUncappedAgentHumanIds(value, 'beta'), /only valid in staging/);
  }
  for (const value of ['not-a-human', `${first},${first}`, `${first},${second},${humanId('c')}`, '*', ' ']) {
    assert.throws(() => stagingUncappedAgentHumanIds(value, 'staging'), /one or two distinct exact human IDs/);
  }
});
const temporaryStore = async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'envoi-identity-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const store = new FileStore(root);
  await store.init();
  return store;
};
const queue = (store, id = `delivery_${crypto.randomUUID()}`) => {
  const at = new Date(Date.now() - 1000).toISOString();
  return store.enqueueOutbox([], { id, kind: 'test', senderInboxId: 'sender', recipientInboxId: 'recipient', orderingKey: `case_${id}`, status: 'queued', attempts: 0, maxAttempts: 5, availableAt: at, createdAt: at, updatedAt: at });
};
const isMismatch = (owner, configured) => error => {
  assert.equal(error.code, DEPLOYMENT_IDENTITY_MISMATCH);
  assert.match(error.message, new RegExp(`belongs to the "${owner}" deployment, but this server is configured as "${configured}"`));
  assert.match(error.message, /ENVOI_DEPLOYMENT_IDENTITY_REASSIGN_FROM/);
  return true;
};

test('the configured deployment defaults to development and rejects malformed names', () => {
  assert.deepEqual(configuredDeploymentIdentity({}), { environment: 'development', reassignFrom: null });
  assert.deepEqual(configuredDeploymentIdentity({ ENVOI_DEPLOYMENT_ENVIRONMENT: 'beta', ENVOI_DEPLOYMENT_IDENTITY_REASSIGN_FROM: 'staging' }), { environment: 'beta', reassignFrom: 'staging' });
  assert.throws(() => configuredDeploymentIdentity({ ENVOI_DEPLOYMENT_ENVIRONMENT: 'Beta' }), /lowercase deployment name/);
  assert.throws(() => configuredDeploymentIdentity({ ENVOI_DEPLOYMENT_ENVIRONMENT: 'beta', ENVOI_DEPLOYMENT_IDENTITY_REASSIGN_FROM: 'beta' }), /different deployment/);
});

test('the first start stamps the database and later starts must match it', async t => {
  const store = await temporaryStore(t);
  await verifyDeploymentIdentityBeforeInit(store, { environment: 'staging' });
  const stamped = await ensureDeploymentIdentity(store, { environment: 'staging', releaseSha: 'a'.repeat(40), logger: quiet });
  assert.equal(stamped.environment, 'staging');
  assert.equal(stamped.stampedByReleaseSha, 'a'.repeat(40));
  assert.deepEqual(await store.getJson(DEPLOYMENT_IDENTITY_PATH), stamped);
  // A restart of the same deployment leaves the stamp alone.
  assert.deepEqual(await ensureDeploymentIdentity(store, { environment: 'staging', releaseSha: 'b'.repeat(40), logger: quiet }), stamped);
  await assertDeploymentIdentity(store, 'staging');
  // Another deployment is refused before migrations and again at the stamp, which is unchanged.
  await assert.rejects(verifyDeploymentIdentityBeforeInit(store, { environment: 'beta' }), isMismatch('staging', 'beta'));
  await assert.rejects(ensureDeploymentIdentity(store, { environment: 'beta', logger: quiet }), isMismatch('staging', 'beta'));
  await assert.rejects(assertDeploymentIdentity(store, 'beta'), isMismatch('staging', 'beta'));
  assert.deepEqual(await store.getJson(DEPLOYMENT_IDENTITY_PATH), stamped);
});

test('a database moves to another deployment only when its current owner is named', async t => {
  const store = await temporaryStore(t);
  await ensureDeploymentIdentity(store, { environment: 'staging', logger: quiet });
  await assert.rejects(ensureDeploymentIdentity(store, { environment: 'beta', reassignFrom: 'release', logger: quiet }), isMismatch('staging', 'beta'));
  const warnings = [];
  await verifyDeploymentIdentityBeforeInit(store, { environment: 'beta', reassignFrom: 'staging' });
  const moved = await ensureDeploymentIdentity(store, { environment: 'beta', reassignFrom: 'staging', logger: { info() {}, warn: line => warnings.push(line) } });
  assert.equal(moved.environment, 'beta');
  assert.equal(moved.reassignedFrom, 'staging');
  assert.equal(warnings.length, 1);
  // Left set, the setting does nothing more, and the old owner is now refused.
  assert.equal((await ensureDeploymentIdentity(store, { environment: 'beta', reassignFrom: 'staging', logger: quiet })).reassignedFrom, 'staging');
  await assert.rejects(ensureDeploymentIdentity(store, { environment: 'staging', logger: quiet }), isMismatch('beta', 'staging'));
});

test('before migrations a missing documents table counts as never stamped', async () => {
  const missingTable = { getJson: async () => { throw Object.assign(new Error('relation "sinaloa_documents" does not exist'), { code: '42P01' }); } };
  await verifyDeploymentIdentityBeforeInit(missingTable, { environment: 'beta' });
  const broken = { getJson: async () => { throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }); } };
  await assert.rejects(verifyDeploymentIdentityBeforeInit(broken, { environment: 'beta' }), /connection refused/);
});

test('FileStore claims nothing unless the store is stamped for the claiming deployment', async t => {
  const store = await temporaryStore(t);
  const queued = await queue(store);
  assert.equal(await store.claimOutbox('worker', 30_000, { deploymentEnvironment: 'staging' }), null, 'never stamped');
  await ensureDeploymentIdentity(store, { environment: 'beta', logger: quiet });
  assert.equal(await store.claimOutbox('worker', 30_000, { deploymentEnvironment: 'staging' }), null, 'stamped by another deployment');
  assert.equal((await store.getOutbox(queued.id)).status, 'queued');
  assert.equal((await store.claimOutbox('worker', 30_000, { deploymentEnvironment: 'beta' })).id, queued.id);
});

test('a delivery worker leaves another deployment\'s outbox untouched', async t => {
  const store = await temporaryStore(t);
  await ensureDeploymentIdentity(store, { environment: 'staging', logger: quiet });
  const queued = await queue(store);
  const delivered = [];
  const worker = new DeliveryWorker({ store, deploymentEnvironment: 'beta', deliver: async record => { delivered.push(record.id); return {}; } });
  worker.running = true;
  await worker.drain();
  await worker.stop();
  assert.deepEqual(delivered, []);
  const untouched = await store.getOutbox(queued.id);
  assert.deepEqual([untouched.status, untouched.attempts, untouched.lockedBy], ['queued', 0, undefined]);
  const own = new DeliveryWorker({ store, deploymentEnvironment: 'staging', deliver: async record => { delivered.push(record.id); return {}; } });
  own.running = true;
  await own.drain();
  await own.stop();
  assert.deepEqual(delivered, [queued.id]);
  assert.equal((await store.getOutbox(queued.id)).status, 'delivered');
});

test('readiness fails with a fixed reason when the database is not this deployment\'s', async t => {
  const store = await temporaryStore(t);
  const identityCheck = env => dependencyReadinessChecks({ store, env, externalEmailEnabled: false }).find(check => check.name === 'deploymentIdentity');
  await ensureDeploymentIdentity(store, { environment: 'staging', logger: quiet });
  const matching = await evaluateReadiness([identityCheck({ ENVOI_DEPLOYMENT_ENVIRONMENT: 'staging' })]);
  assert.deepEqual(matching.checks.deploymentIdentity, { ready: true, critical: true });
  const other = await evaluateReadiness([identityCheck({ ENVOI_DEPLOYMENT_ENVIRONMENT: 'beta' })]);
  assert.equal(other.ready, false);
  assert.deepEqual(other.checks.deploymentIdentity, { ready: false, critical: true, reason: 'Database is not stamped for this deployment' });
});

test('a server refuses to start on a data directory stamped by another deployment', { timeout: 60_000 }, async t => {
  // The running server's stop() removes this directory.
  const dataDir = await mkdtemp(path.join(tmpdir(), 'envoi-identity-server-'));
  const identityFile = path.join(dataDir, ...DEPLOYMENT_IDENTITY_PATH.split('/'));
  await mkdir(path.dirname(identityFile), { recursive: true });
  const foreign = { environment: 'beta', stampedAt: '2026-10-15T00:00:00.000Z', stampedByReleaseSha: null };
  await writeFile(identityFile, JSON.stringify(foreign));
  await assert.rejects(launch({ ENVOI_DEPLOYMENT_ENVIRONMENT: 'staging' }, dataDir), /belongs to the "beta" deployment, but this server is configured as "staging"/);
  assert.deepEqual(JSON.parse(await readFile(identityFile, 'utf8')), foreign, 'a refused start writes nothing');

  await writeFile(identityFile, JSON.stringify({ ...foreign, environment: 'staging' }));
  const server = await launch({ ENVOI_DEPLOYMENT_ENVIRONMENT: 'staging' }, dataDir);
  t.after(() => server.stop());
  const ready = await (await fetch(`${server.baseUrl}/ready`)).json();
  assert.equal(ready.deploymentEnvironment, 'staging');
  assert.equal(ready.checks.deploymentIdentity.ready, true);
  // Another deployment taking the database over while this one runs fails readiness.
  await writeFile(identityFile, JSON.stringify({ ...foreign, environment: 'beta' }));
  const taken = await fetch(`${server.baseUrl}/ready`);
  assert.equal(taken.status, 503);
  assert.equal((await taken.json()).checks.deploymentIdentity.reason, 'Database is not stamped for this deployment');
});

test('[PostgreSQL] claims and starts are refused on a database stamped by another deployment', { skip: !process.env.DATABASE_URL, timeout: 60_000 }, async t => {
  const { PostgresStore } = await import('../src/postgres-storage.js');
  const store = new PostgresStore(process.env.DATABASE_URL);
  await store.init();
  // CI shares one database across test files; put back whatever stamp the other tests left.
  const original = await store.getJson(DEPLOYMENT_IDENTITY_PATH);
  t.after(async () => {
    if (original) await store.putJson(DEPLOYMENT_IDENTITY_PATH, original);
    else await store.deleteJson(DEPLOYMENT_IDENTITY_PATH);
    await store.close();
  });
  const mine = `test-${crypto.randomUUID().slice(0, 8)}`;
  await store.putJson(DEPLOYMENT_IDENTITY_PATH, { environment: 'test-other', stampedAt: new Date().toISOString(), stampedByReleaseSha: null });
  // Earliest availableAt, so it is the claim candidate even if other tests left work behind.
  const id = `delivery_${crypto.randomUUID()}`;
  await store.enqueueOutbox([], { id, kind: 'test', senderInboxId: 'sender', recipientInboxId: 'recipient', orderingKey: `case_${id}`, status: 'queued', attempts: 0, maxAttempts: 5, availableAt: '2000-01-01T00:00:00.000Z', createdAt: new Date().toISOString() });
  assert.equal(await store.claimOutbox('identity-worker', 30_000, { deploymentEnvironment: mine }), null);
  assert.equal((await store.getOutbox(id)).status, 'queued');
  await assert.rejects(launch({ DATABASE_URL: process.env.DATABASE_URL, ENVOI_DEPLOYMENT_ENVIRONMENT: mine }), /belongs to the "test-other" deployment/);
  assert.equal((await store.getJson(DEPLOYMENT_IDENTITY_PATH)).environment, 'test-other', 'a refused start writes nothing');

  await store.putJson(DEPLOYMENT_IDENTITY_PATH, { environment: mine, stampedAt: new Date().toISOString(), stampedByReleaseSha: null });
  const claimed = await store.claimOutbox('identity-worker', 30_000, { deploymentEnvironment: mine });
  assert.equal(claimed.id, id);
  await store.completeOutbox(id, [], {}, claimed);
});
