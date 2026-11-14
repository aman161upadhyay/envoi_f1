// Shared harness for the agent-registration v1 integration tests (A-4.2, A-4.3). Not a test file:
// `npm test` runs only test/*.test.js. Builds on a3-harness (server, owners, HTTP) and checks
// responses against the agent-registration schemas and x-codes.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { api, launch, readData, writeData, deleteData } from './a3-harness.js';
import { PostgresStore } from '../src/postgres-storage.js';
import { semanticDigest } from '../src/idempotency.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const fixtureDir = path.join(here, 'contract-fixtures', 'agent-registration');
export const schemas = JSON.parse(await readFile(path.join(fixtureDir, 'schemas.json'), 'utf8'));
export const fixture = async id => JSON.parse(await readFile(path.join(fixtureDir, `${id}.json`), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(schemas);

// The schemas pin secrets to fixture placeholders (§11), so a live response is checked with each
// secret replaced by a placeholder of the same kind.
const secretPrefixes = ['envoi_reg_', 'envoi_agent_access_', 'envoi_agent_refresh_'];
function placeholders(value) {
  if (typeof value === 'string') {
    const prefix = secretPrefixes.find(item => value.startsWith(item));
    return prefix ? `${prefix}PLACEHOLDER_live` : value;
  }
  if (Array.isArray(value)) return value.map(placeholders);
  return value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, placeholders(item)])) : value;
}
export function assertContract(name, raw) {
  const value = placeholders(raw);
  const validate = ajv.getSchema(`${schemas.$id}#/definitions/${name}`);
  assert.ok(validate, `schema ${name}`);
  assert.ok(validate(value),`${name}: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(value)}`);
}

// The x-codes row gives the status; the envelope follows errorEnvelope.
export function assertCode(res, code, extra = {}) {
  assert.equal(res.payload?.code, code, `expected ${code}: HTTP ${res.status} ${res.text?.slice(0, 400)}`);
  assert.equal(res.status, schemas['x-codes'][code].status, res.text);
  assert.equal(res.payload.error, code);
  assertContract('errorEnvelope', res.payload);
  for (const [field, value] of Object.entries(extra)) assert.deepEqual(res.payload[field], value, `${code}.${field}`);
  if (res.payload.retryAfterSeconds !== undefined) assert.equal(res.headers.get('retry-after'), String(res.payload.retryAfterSeconds), 'retry-after matches retryAfterSeconds');
  return res.payload;
}

export const flagsOn = { ENVOI_INSTALLATIONS_V2: 'true', ENVOI_AGENT_REGISTRATION_V2: 'true' };
export const backends = [{ name: 'FileStore', env: {} }, ...(process.env.DATABASE_URL ? [{ name: 'PostgreSQL', env: { DATABASE_URL: process.env.DATABASE_URL } }] : [])];
export const launchRegistration = (backend, env = {}, dataDir = null) => launch({ ...backend.env, ...flagsOn, ENVOI_TRUSTED_PROXY: 'cloudflare', ...env }, dataDir);

// A fresh source address per call, so the durable creation limits never couple tests.
// Each call gets its own IPv6 /32, so no two calls share a source, network or wide network.
export const freshIp = () => `2001:${crypto.randomBytes(2).toString('hex')}:${crypto.randomBytes(2).toString('hex')}:${crypto.randomBytes(2).toString('hex')}::1`;
// Another source (/64) in the same network (/48) as ip.
export const sameNetwork = ip => ip.split(':').slice(0, 3).concat(crypto.randomBytes(2).toString('hex'), '', '1').join(':');

export function registrationBody(overrides = {}) {
  return {
    requestedName: 'Example agent',
    requestedPermissions: ['send_agent_messages', 'receive_agent_messages'],
    connectionRoute: 'local_helper',
    runtime: { type: 'hermes', version: '0.9.0' },
    deliveryCapabilities: { persistentProcess: true, outboundHttps: true, sse: true, webhook: false, scheduledPolling: false, a2a: false },
    helper: { name: 'envoi-link', version: '1.0.0' },
    ...overrides
  };
}

export async function register(baseUrl, overrides = {}, { ip = freshIp() } = {}) {
  return api(baseUrl, '/api/agent-registrations', { body: registrationBody(overrides), headers: { 'x-forwarded-for': ip } });
}
export async function registered(baseUrl, overrides = {}) {
  const res = await register(baseUrl, overrides);
  assert.equal(res.status, 201, res.text);
  assertContract('registrationCreated', res.payload);
  return res.payload;
}
export const poll = (baseUrl, created, token = created.bootstrapToken) => api(baseUrl, `/api/agent-registrations/${created.registrationId}`, { token });
export const lookup = (baseUrl, who, verificationCode) => api(baseUrl, '/api/agent-claims/lookup', { session: who.session, body: { verificationCode } });
export const approveRequest = (baseUrl, who, registrationId, body) => api(baseUrl, `/api/agent-registrations/${registrationId}/approve`, { session: who.session, body });
export const rejectRequest = (baseUrl, who, registrationId, verificationCode) => api(baseUrl, `/api/agent-registrations/${registrationId}/reject`, { session: who.session, body: { verificationCode } });
export const claims = (baseUrl, who) => api(baseUrl, '/api/agent-claims', { session: who.session });
export const withdrawRequest = (baseUrl, who, registrationId) => api(baseUrl, `/api/agent-claims/${registrationId}/withdraw`, { session: who.session, body: {} });

export const newAgentTarget = (who, localPart, name = 'Example agent') => ({ kind: 'new_agent', workspaceInboxId: who.inbox.parentInboxId, name, localPart });
export const approveBody = (verificationCode, target, grantedPermissions = ['send_agent_messages', 'receive_agent_messages']) => ({ verificationCode, target, grantedPermissions, policyProfile: 'default' });

// Stored documents, read and edited the same way on both stores.
export function documents(t, backend, server) {
  if (backend.name === 'FileStore') {
    return {
      get: parts => readData(server, ...parts),
      put: (parts, value) => writeData(server, parts, value),
      edit: async (parts, edit) => writeData(server, parts, edit(await readData(server, ...parts))),
      remove: parts => deleteData(server, ...parts)
    };
  }
  const store = new PostgresStore(backend.env.DATABASE_URL);
  t.after(() => store.close());
  const key = parts => path.join(...parts);
  return {
    get: parts => store.getJson(key(parts)),
    put: (parts, value) => store.putJson(key(parts), value),
    edit: async (parts, edit) => store.putJson(key(parts), edit(await store.getJson(key(parts)))),
    remove: parts => store.deleteJson(key(parts))
  };
}
export const registrationParts = registrationId => ['auth', 'agent-registrations', `${registrationId}.json`];
export const PAST = '2000-01-01T00:00:00.000Z';

export async function nearReplayCancellationFixture(t) {
  let available = false;
  const rpc = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (!available) { res.writeHead(503).end(); return; }
      // Once NEAR recovers, a finalized block shows the old approval has expired.
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ result: {
        chain_id: 'testnet',
        header: { timestamp_nanosec: (BigInt(Date.now() + 180_000) * 1_000_000n).toString() }
      } }));
    });
  });
  await new Promise(resolve => rpc.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => rpc.close(resolve)));
  return {
    env: {
      ENVOI_NEAR_PAYMENT_RPC_URL: `http://127.0.0.1:${rpc.address().port}`,
      ENVOI_NEAR_PAYMENT_CONTRACT: 'spend.testnet',
      ENVOI_NEAR_PAYMENT_AGENT_ACCOUNTS: '{}',
      ENVOI_NEAR_PAYMENT_APPROVAL_SIGNING_KEY: crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
    },
    async seed(docs, { agentInboxId: inboxId, agentId, credentialFamilyId: familyId }) {
      const id = semanticDigest([inboxId, agentId, familyId]);
      const pending = ['system', 'near-payment-cancellations', `${id}.json`];
      const payment = ['inboxes', inboxId, 'near-case-payments', 'replay-payment.json'];
      await docs.put(payment, { id: 'replay-payment', agentId, credentialFamilyId: familyId,
        instruction: { expiresAt: new Date(Date.now() + 120_000).toISOString(), contract: 'spend.testnet',
          agentAccount: 'milo.testnet', args: { case_ref: 'replay-payment' } } });
      return { pending, payment, record: { id, inboxId, agentId, familyId } };
    },
    recover() { available = true; },
    async assertDrained(docs, { pending, payment }) {
      const deadline = Date.now() + 12_000;
      while (await docs.get(pending) && Date.now() < deadline) await delay(100);
      assert.equal(await docs.get(pending), null);
      assert.ok((await docs.get(payment)).expiryVerifiedAt, 'the worker reconciled the approval');
    }
  };
}
