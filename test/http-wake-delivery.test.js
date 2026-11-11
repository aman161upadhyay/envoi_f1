// http-wake v1: a delivered native message wakes the recipient's active subscription, and the wake
// is queued only after the delivery committed. FileStore only: the subscription is seeded on disk,
// because a real challenge needs a public HTTPS receiver.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { FileStore } from '../src/storage.js';
import { PostgresStore } from '../src/postgres-storage.js';
import { wakeQueueDir, wakeSubscriptionIndexPath, wakeSubscriptionPath } from '../src/http-wake-paths.js';
import { claim, dataFile, eventually, launch, owner, pauseAgent, readData, resumeAgent, send, sleep, waitForMessageStatus, writeData } from './a3-harness.js';

const key = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
const enabled = { ENVOI_INSTALLATIONS_V2: 'true', ENVOI_HTTP_WAKE_V1: 'true', ENVOI_WAKE_SIGNING_KEYS: JSON.stringify([{ kid: 'delivery-tests', privateKey: key, activeFrom: '2026-01-01T00:00:00.000Z' }]) };

async function queuedWakes(server, subscriptionId) {
  let names = [];
  try { names = await readdir(dataFile(server, 'http-wake', 'queue')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const records = await Promise.all(names.filter(name => name.endsWith('.json')).map(name => readData(server, 'http-wake', 'queue', name).catch(() => null)));
  return records.filter(record => record?.subscriptionId === subscriptionId);
}

test('[FileStore] a delivered native message queues the recipient wake after the delivery commits', { timeout: 60000 }, async t => {
  const server = await launch(enabled); t.after(() => server.stop());
  const alice = await owner(server.baseUrl, '9600'), bob = await owner(server.baseUrl, '9601');
  const [familyFile] = await readdir(dataFile(server, 'auth', 'agent-credential-families', bob.inbox.id, bob.agent.id));
  const at = new Date().toISOString();
  const subscription = { id: 'wake_sub_delivery_test', inboxId: bob.inbox.id, agentId: bob.agent.id, familyId: familyFile.replace(/\.json$/, ''),
    installationId: 'installation_delivery_test', url: 'https://wake.invalid/hook', status: 'active', endedReason: null, endedAt: null,
    createdAt: at, activatedAt: at, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), challengeExpiresAt: null, replacesSubscriptionId: null,
    delivery: { state: 'healthy', lastAttemptAt: null, lastSuccessAt: at, consecutiveFailures: 0, lastFailureClass: null }, challengeHash: null, sequence: 0, dirty: {} };
  // The layout from src/http-wake-paths.js: the record under its agent, plus its status index entry.
  await writeData(server, ['http-wake', 'agents', bob.agent.id, 'wake-subscriptions', `${subscription.id}.json`], subscription);
  await writeData(server, ['http-wake', 'subscription-index', `${subscription.id}.json`],
    { id: subscription.id, inboxId: subscription.inboxId, agentId: subscription.agentId, status: subscription.status, endedAt: null });
  assert.deepEqual(await queuedWakes(server, subscription.id), []);

  const sent = await send(server.baseUrl, alice, bob, { text: 'Wake after commit' });
  assert.equal(sent.status, 202, sent.text);
  const messageId = sent.payload.id || sent.payload.messageId;
  await waitForMessageStatus(server.baseUrl, alice, messageId, 'delivered');
  const wakes = await eventually(async () => {
    const records = (await queuedWakes(server, subscription.id)).filter(record => record.reason === 'message_delivered');
    return records.length ? records : null;
  }, { timeoutMs: 15000, message: 'the delivery queues a message_delivered wake' });
  const delivered = await readData(server, 'inboxes', bob.inbox.id, 'messages', `${messageId}.json`);
  assert.equal(delivered?.status, 'delivered');
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].type, 'wake.work_available');
  assert.ok(wakes[0].createdAt >= delivered.deliveredAt, 'the wake is queued after the delivery committed');
});


for (const backend of ['FileStore', 'PostgreSQL']) {
  const databaseUrl = backend === 'PostgreSQL' ? process.env.DATABASE_URL : null;
  const skip = backend === 'PostgreSQL' && !databaseUrl;

  test(`[${backend}] wake recovery finds never-claimed work beyond a full page after pause`, { timeout: 60000, skip }, async t => {
    const server = await launch({ ...enabled, ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}) });
    t.after(() => server.stop());
    const store = databaseUrl ? new PostgresStore(databaseUrl) : new FileStore(server.dataDir);
    if (databaseUrl) t.after(() => store.close());
    const [alice, bob] = await Promise.all([owner(server.baseUrl, '9610'), owner(server.baseUrl, '9611')]);
    const sent = await send(server.baseUrl, alice, bob, { text: 'Recover an unread delivery' });
    assert.equal(sent.status, 202, sent.text);
    const messageId = sent.payload.id;
    await waitForMessageStatus(server.baseUrl, alice, messageId, 'delivered');
    const inboxDir = path.join('inboxes', bob.inbox.id);
    const messagesDir = path.join(inboxDir, 'messages');
    const message = await store.getJson(path.join(messagesDir, `${messageId}.json`));
    const claimPath = path.join(inboxDir, 'work-claims', `${messageId}.json`);
    assert.equal(await store.getJson(claimPath), null);
    // A compound cursor must reach the real row even when all timestamps tie.
    for (let index = 0; index < 50; index += 1) {
      const id = `earlier_${index}`;
      await store.putJson(path.join(messagesDir, `${id}.json`), {
        id, createdAt: message.createdAt, status: 'delivered', recipientAgentId: bob.agent.id,
        recipientInboxId: bob.inbox.id
      });
    }
    await pauseAgent(server.baseUrl, bob);
    const wakes = await seedRecoverySubscription(store, bob);
    await sleep(1300);
    assert.deepEqual(await wakes(), [], 'no catch-up wake while paused');
    await resumeAgent(server.baseUrl, bob);
    await eventually(async () => (await wakes()).some(record => record.reason === 'work_due'),
      { timeoutMs: 15000, message: 'a catch-up wake for the unread delivery' });
    assert.equal(await store.getJson(claimPath), null, 'a wake does not claim work on behalf of the host');
    assert.equal((await claim(server.baseUrl, bob.agentApiToken)).payload.work?.workId, messageId);
  });

  test(`[${backend}] wake recovery honors a live lease and reoffers it after expiry`, { timeout: 60000, skip }, async t => {
    const server = await launch({ ...enabled, ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}) });
    t.after(() => server.stop());
    const store = databaseUrl ? new PostgresStore(databaseUrl) : new FileStore(server.dataDir);
    if (databaseUrl) t.after(() => store.close());
    const [alice, bob] = await Promise.all([owner(server.baseUrl, '9612'), owner(server.baseUrl, '9613')]);
    const sent = await send(server.baseUrl, alice, bob, { text: 'Recover an expired lease' });
    assert.equal(sent.status, 202, sent.text);
    const messageId = sent.payload.id;
    await waitForMessageStatus(server.baseUrl, alice, messageId, 'delivered');
    const claimed = (await claim(server.baseUrl, bob.agentApiToken)).payload.work;
    assert.equal(claimed?.workId, messageId);
    const wakes = await seedRecoverySubscription(store, bob);
    await sleep(1300);
    assert.deepEqual(await wakes(), [], 'a live lease is not due');
    const claimPath = path.join('inboxes', bob.inbox.id, 'work-claims', `${messageId}.json`);
    const record = await store.getJson(claimPath);
    await store.putJson(claimPath, { ...record, leaseExpiresAt: new Date(Date.now() - 1000).toISOString() });
    await eventually(async () => (await wakes()).some(wake => wake.reason === 'work_due'),
      { timeoutMs: 15000, message: 'a catch-up wake for the expired lease' });
    const recovered = (await claim(server.baseUrl, bob.agentApiToken)).payload.work;
    assert.equal(recovered?.workId, messageId);
    assert.notEqual(recovered.leaseToken, claimed.leaseToken);
  });
}

// Seed an active callback after delivery, without an activation wake or an external receiver.
async function seedRecoverySubscription(store, recipient) {
  const [family] = await store.listJson(path.join('auth', 'agent-credential-families', recipient.inbox.id, recipient.agent.id));
  const at = new Date().toISOString();
  const subscription = {
    id: `wake_sub_recovery_${crypto.randomUUID()}`, inboxId: recipient.inbox.id, agentId: recipient.agent.id,
    familyId: family.id, installationId: 'installation_delivery_test', url: 'https://wake.invalid/hook',
    status: 'active', createdAt: at, activatedAt: at, expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    delivery: { state: 'healthy', lastAttemptAt: null, lastSuccessAt: null, consecutiveFailures: 0, lastFailureClass: null },
    sequence: 0, dirty: {}
  };
  await store.putJson(wakeSubscriptionPath(subscription.agentId, subscription.id), subscription);
  const { id, inboxId, agentId, status } = subscription;
  await store.putJson(wakeSubscriptionIndexPath(id), { id, inboxId, agentId, status, endedAt: null });
  return async () => (await store.listJson(wakeQueueDir)).filter(record => record.subscriptionId === id);
}
