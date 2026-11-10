// envoi-names v1 (N1): MCP tool names, credential formats and health identity,
// checked against a real server and the published contract schemas. Pre-cutover
// credentials are simulated by writing a credential index record for a
// sinaloa_-prefixed raw token into the FileStore data dir (credentials are stored
// hashed, so the record alone would resolve; the server must refuse the prefix).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import {
  accessCredentialParts, api, launch, newRotationId, owner, readData, refresh, refreshCredentialParts,
  send, waitForMessageStatus, writeData
} from './a3-harness.js';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'contract-fixtures', 'envoi-names');
const schemas = JSON.parse(await readFile(path.join(fixtureDir, 'schemas.json'), 'utf8'));
const fixture = async id => JSON.parse(await readFile(path.join(fixtureDir, `${id}.json`), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(schemas);
const toolNames = schemas['x-tool-names'];
const readToolNames = ['envoi_agent_info', 'envoi_read_case', 'envoi_list_messages'];

function assertSchema(name, value) {
  const validate = ajv.getSchema(`${schemas.$id}#/definitions/${name}`);
  assert.ok(validate, `envoi-names schema ${name} exists`);
  assert.ok(validate(value), `${name}: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(value)}`);
}

// Asserts a refusal matches the fixture's status, code and message, and the errorEnvelope schema.
async function assertRefused(res, fixtureId) {
  const expected = (await fixture(fixtureId)).response;
  assert.equal(res.status, expected.status, `${fixtureId}: HTTP ${res.status} ${res.text}`);
  assertSchema(expected.schema, res.payload);
  for (const field of ['code', 'error', 'message']) assert.equal(res.payload[field], expected.body[field], `${fixtureId}.${field}`);
  return res.payload;
}

const mcp = (baseUrl, token, method, params, id = 1) => api(baseUrl, '/mcp', {
  token,
  headers: { accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
  body: { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }
});

const randomSuffix = bytes => crypto.randomBytes(bytes).toString('base64url');

async function setup(t) {
  const server = await launch();
  t.after(() => server.stop());
  const { baseUrl } = server;
  const [alice, bob] = await Promise.all([owner(baseUrl, '7101'), owner(baseUrl, '7102')]);
  const caseId = 'case_envoi_names';
  const sent = await send(baseUrl, alice, bob, { caseId });
  assert.equal(sent.status, 202, sent.text);
  await waitForMessageStatus(baseUrl, alice, sent.payload.id, 'delivered');
  return { server, baseUrl, alice, bob, caseId };
}

test('envoi-names: MCP lists only Envoi tool names and refuses the retired sinaloa_* names', async t => {
  const { baseUrl, alice, caseId } = await setup(t);

  const listed = await mcp(baseUrl, alice.agentApiToken, 'tools/list');
  assert.equal(listed.status, 200, listed.text);
  assertSchema('mcpToolsList', listed.payload);
  assert.deepEqual(listed.payload.result.tools.map(tool => tool.name), schemas.definitions.toolEntry.properties.name.enum);
  assert.doesNotMatch(JSON.stringify(listed.payload), /sinaloa/i);

  const issued = await api(baseUrl, '/api/agent/mcp-read-token', { token: alice.agentApiToken, body: { caseId } });
  assert.equal(issued.status, 201, issued.text);
  assert.match(issued.payload.mcpAccessToken, /^envoi_mcp_read_[A-Za-z0-9_-]{43}$/);
  const readListed = await mcp(baseUrl, issued.payload.mcpAccessToken, 'tools/list');
  assert.equal(readListed.status, 200, readListed.text);
  assertSchema('mcpToolsListCaseRead', readListed.payload);
  assert.deepEqual(readListed.payload.result.tools.map(tool => tool.name), readToolNames);

  const expected = (await fixture('mcp-call-old-name')).response.body;
  const oldCall = await mcp(baseUrl, alice.agentApiToken, 'tools/call', { name: 'sinaloa_claim_work', arguments: {} });
  assert.equal(oldCall.status, 200, oldCall.text);
  assertSchema('mcpToolUnavailable', oldCall.payload);
  assert.deepEqual(oldCall.payload, expected);
  // No retired name is an alias, whatever its arguments.
  for (const [index, oldName] of Object.keys(toolNames).entries()) {
    const call = await mcp(baseUrl, alice.agentApiToken, 'tools/call', { name: oldName, arguments: {} }, index + 2);
    assert.deepEqual(call.payload.error, expected.error, oldName);
  }
  const current = await mcp(baseUrl, alice.agentApiToken, 'tools/call', { name: 'envoi_agent_info', arguments: {} });
  assert.equal(current.payload.result?.isError, false, current.text);
});

test('envoi-names: every issued credential uses the Envoi formats', async t => {
  const { baseUrl, alice } = await setup(t);
  assertSchema('tokenPair', alice);
  const refreshed = await refresh(baseUrl, alice.agentRefreshToken, newRotationId());
  assert.equal(refreshed.status, 200, refreshed.text);
  assertSchema('tokenPair', refreshed.payload);

  const reconnect = await api(baseUrl, `/api/inboxes/${alice.inbox.id}/agents/${alice.agent.id}/credentials/reconnect-token`, { session: alice.session, body: {} });
  assert.equal(reconnect.status, 201, reconnect.text);
  const reconnected = await api(baseUrl, '/api/agent-enroll', { body: { enrollmentToken: reconnect.payload.enrollmentToken } });
  assert.equal(reconnected.status, 200, reconnected.text);
  assertSchema('tokenPair', reconnected.payload);
});

test('envoi-names: pre-cutover sinaloa_* credentials are refused with the a3 codes', async t => {
  const { server, baseUrl, alice, caseId } = await setup(t);
  const caseRoute = `/api/inboxes/${alice.inbox.id}/cases/${caseId}`;

  // Access: the same typed record works under an envoi_ token and is refused under a sinaloa_ one.
  const accessRecord = await readData(server, ...accessCredentialParts(alice.agentApiToken));
  assert.equal(accessRecord.tokenType, 'access');
  const envoiAccess = `envoi_agent_access_${randomSuffix(32)}`;
  const oldAccess = `sinaloa_agent_access_${randomSuffix(32)}`;
  await writeData(server, accessCredentialParts(envoiAccess), accessRecord);
  await writeData(server, accessCredentialParts(oldAccess), accessRecord);
  assert.equal((await api(baseUrl, '/api/agent/work/claim', { token: envoiAccess, body: {} })).status, 200, 'control: the record itself is valid');
  assert.equal((await api(baseUrl, caseRoute, { token: envoiAccess })).status, 200, 'control: inbox route');
  await assertRefused(await api(baseUrl, '/api/agent/work/claim', { token: oldAccess, body: {} }), 'access-old-prefix');
  await assertRefused(await api(baseUrl, '/api/agent/status', { token: oldAccess }), 'access-old-prefix');
  await assertRefused(await mcp(baseUrl, oldAccess, 'tools/list'), 'access-old-prefix');
  await assertRefused(await api(baseUrl, caseRoute, { token: oldAccess }), 'access-old-prefix');
  await assertRefused(await api(baseUrl, `/api/inboxes/${alice.inbox.id}/messages`, { token: oldAccess }), 'access-old-prefix');
  await assertRefused(await api(baseUrl, '/api/agent/mcp-read-token', { token: oldAccess, body: { caseId } }), 'access-old-prefix');

  // Case read token.
  const issued = await api(baseUrl, '/api/agent/mcp-read-token', { token: alice.agentApiToken, body: { caseId } });
  assert.equal(issued.status, 201, issued.text);
  const readRecord = await readData(server, ...accessCredentialParts(issued.payload.mcpAccessToken));
  assert.equal(readRecord.tokenType, 'mcp_read');
  const oldRead = `sinaloa_mcp_read_${randomSuffix(32)}`;
  await writeData(server, accessCredentialParts(oldRead), readRecord);
  assert.equal((await api(baseUrl, caseRoute, { token: issued.payload.mcpAccessToken })).status, 200, 'control: envoi_mcp_read_ works');
  await assertRefused(await api(baseUrl, caseRoute, { token: oldRead }), 'mcp-read-old-prefix');
  await assertRefused(await mcp(baseUrl, oldRead, 'tools/list'), 'mcp-read-old-prefix');

  // Refresh: refused without consuming the record, and the identity is untouched.
  const refreshRecord = await readData(server, ...refreshCredentialParts(alice.agentRefreshToken));
  assert.equal(refreshRecord.tokenType, 'refresh');
  const oldRefresh = `sinaloa_agent_refresh_${randomSuffix(48)}`;
  await writeData(server, refreshCredentialParts(oldRefresh), refreshRecord);
  await assertRefused(await refresh(baseUrl, oldRefresh, newRotationId()), 'refresh-old-prefix');
  const after = await readData(server, ...refreshCredentialParts(oldRefresh));
  assert.equal(after.usedAt, null, 'the refused refresh is not consumed');
  const stillValid = await refresh(baseUrl, alice.agentRefreshToken, newRotationId());
  assert.equal(stillValid.status, 200, 'the owner identity and its envoi_ credentials are kept');
});

test('envoi-names: /health reports the envoi service identity', async t => {
  const server = await launch();
  t.after(() => server.stop());
  const health = await api(server.baseUrl, '/health');
  assert.equal(health.status, 200, health.text);
  assertSchema('health', health.payload);
  assert.equal(health.payload.service, (await fixture('health-identity')).response.body.service);
});
