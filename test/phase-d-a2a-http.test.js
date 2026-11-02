import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { api, launch, owner, readData } from './a3-harness.js';

const env = { ENVOI_INSTALLATIONS_V2: 'true', ENVOI_RELATIONSHIPS_V2: 'true', ENVOI_A2A_GATEWAY: 'true' };
const route = address => `/api/agent/a2a/agents/${encodeURIComponent(address)}`;
async function localPort() {
  const socket = net.createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
async function cleanScanner() {
  const scanner = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume the submitted bytes */ }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'clean', engine: 'phase-d-test' }));
  }).listen(0, '127.0.0.1');
  await once(scanner, 'listening');
  return { url: `http://127.0.0.1:${scanner.address().port}/scan`, stop: () => new Promise(resolve => scanner.close(resolve)) };
}
async function a2a(baseUrl, pathname, token, { method = 'GET', payload } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/a2a+json' } : {}) },
    body: payload ? JSON.stringify(payload) : undefined
  });
  return { status: response.status, contentType: response.headers.get('content-type'), payload: await response.json() };
}

test('[FileStore] A2A text send and task polling use a committed Envoi Case', { timeout: 30000 }, async t => {
  const port = await localPort();
  const scan = await cleanScanner();
  const server = await launch({ ...env, ENVOI_PORT: String(port), ENVOI_PUBLIC_URL: `http://127.0.0.1:${port}`, ENVOI_MALWARE_SCANNER_URL: scan.url });
  t.after(() => server.stop());
  t.after(() => scan.stop());
  const [alice, bob] = await Promise.all([owner(server.baseUrl, '7501'), owner(server.baseUrl, '7502')]);
  const base = route(bob.agent.address);
  const discovered = await api(server.baseUrl, `/api/agent/discovery?address=${encodeURIComponent(bob.agent.address)}`, { token: alice.agentApiToken });
  assert.equal(discovered.status, 200);
  assert.equal(discovered.payload.a2aCardUrl, `${server.baseUrl}${base}/card`);
  const card = await a2a(server.baseUrl, `${base}/card`, alice.agentApiToken);
  assert.equal(card.status, 200);
  assert.equal(card.payload.supportedInterfaces[0].url, `${server.baseUrl}${base}`);
  assert.equal(card.payload.capabilities.streaming, false);
  assert.equal(card.payload.securitySchemes.envoiBearer.httpAuthSecurityScheme.scheme, 'Bearer');
  assert.equal((await a2a(server.baseUrl, `${base}/card`, '')).status, 401);
  assert.equal((await a2a(server.baseUrl, `${route('missing@agents.envoi-agents.com')}/card`, '')).status, 401, 'unauthenticated card lookup cannot enumerate addresses');
  const message = { message: { messageId: 'a2a-message-1', role: 'ROLE_USER', parts: [{ text: 'A2A Case work' }] }, configuration: { returnImmediately: true } };
  const sent = await a2a(server.baseUrl, `${base}/message:send`, alice.agentApiToken, { method: 'POST', payload: message });
  assert.equal(sent.status, 200, JSON.stringify(sent.payload));
  assert.equal((await a2a(server.baseUrl, `${base}/message:send`, alice.agentApiToken, { method: 'POST', payload: { ...message, configuration: {} } })).status, 400);
  assert.match(sent.contentType, /^application\/a2a\+json/);
  const caseId = sent.payload.task.id;
  const persisted = await readData(server, 'inboxes', alice.inbox.id, 'cases', `${caseId}.json`);
  assert.equal(persisted.id, caseId, 'native Case is durable before the A2A response');
  assert.equal(persisted.events.some(event => event.payload?.data?.a2a?.messageId === 'a2a-message-1'), true);
  const polled = await a2a(server.baseUrl, `${base}/tasks/${caseId}`, alice.agentApiToken);
  assert.equal(polled.status, 200, JSON.stringify(polled.payload));
  assert.equal(polled.payload.id, caseId);
  const bytes = Buffer.from('A2A evidence');
  const begun = await api(server.baseUrl, `/api/inboxes/${alice.inbox.id}/asset-uploads`, { token: alice.agentApiToken, key: 'a2a-asset', body: { filename: 'evidence.txt', mimeType: 'text/plain', size: bytes.length, checksumSha256: crypto.createHash('sha256').update(bytes).digest('base64'), caseId } });
  assert.equal(begun.status, 201, begun.text);
  assert.equal((await fetch(begun.payload.upload.url, { method: 'PUT', headers: begun.payload.upload.headers, body: bytes })).status, 204);
  const completed = await api(server.baseUrl, `/api/inboxes/${alice.inbox.id}/assets/${begun.payload.object.id}/complete`, { token: alice.agentApiToken, body: {} });
  assert.equal(completed.status, 200, completed.text);
  const withArtifact = await a2a(server.baseUrl, `${base}/tasks/${caseId}`, alice.agentApiToken);
  assert.equal(withArtifact.status, 200, JSON.stringify(withArtifact.payload));
  assert.equal(withArtifact.payload.artifacts[0].artifactId, begun.payload.object.id);
  const artifactUrl = withArtifact.payload.artifacts[0].parts[0].url;
  const artifact = await fetch(artifactUrl, { headers: { authorization: `Bearer ${alice.agentApiToken}` } });
  assert.equal(artifact.status, 200);
  assert.deepEqual(Buffer.from(await artifact.arrayBuffer()), bytes);
  const replay = await a2a(server.baseUrl, `${base}/message:send`, alice.agentApiToken, { method: 'POST', payload: message });
  assert.equal(replay.status, 200, JSON.stringify(replay.payload));
  assert.equal(replay.payload.task.id, caseId);
  const conflict = await a2a(server.baseUrl, `${base}/message:send`, alice.agentApiToken, { method: 'POST', payload: { ...message, message: { ...message.message, parts: [{ text: 'Changed work' }] } } });
  assert.equal(conflict.status, 409, JSON.stringify(conflict.payload));
  assert.equal((await a2a(server.baseUrl, `${route(alice.agent.address)}/tasks/${caseId}`, alice.agentApiToken)).status, 404);
  assert.equal((await a2a(server.baseUrl, `${base}/tasks/${caseId}`, bob.agentApiToken)).status, 404);
  assert.equal((await a2a(server.baseUrl, `${base}/message:stream`, alice.agentApiToken, { method: 'POST', payload: message })).status, 501);
  assert.equal((await api(server.baseUrl, `/api/inboxes/${bob.inbox.id}/contacts/${alice.agent.id}/block`, { session: bob.session, body: {} })).status, 200);
  assert.equal((await a2a(server.baseUrl, `${base}/card`, alice.agentApiToken)).status, 404, 'a reciprocal block hides the card');
  assert.equal((await a2a(server.baseUrl, `${base}/tasks/${caseId}`, alice.agentApiToken)).status, 404, 'a reciprocal block hides the Task');
});

test('[FileStore] A2A edge is absent while its flag is off', { timeout: 30000 }, async t => {
  const server = await launch({ ENVOI_INSTALLATIONS_V2: 'true', ENVOI_RELATIONSHIPS_V2: 'true' });
  t.after(() => server.stop());
  const who = await owner(server.baseUrl, '7503');
  const disabled = await a2a(server.baseUrl, `${route(who.agent.address)}/card`, who.agentApiToken);
  assert.equal(disabled.status, 404);
  assert.equal(disabled.payload.code, 'FEATURE_DISABLED');
});
