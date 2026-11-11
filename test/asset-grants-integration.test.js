import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateSync } from 'otplib';
import { BrowserSession } from './browser-session.js';
import { loadMigrations } from '../src/migrations.js';
import { valueDigest } from '../src/policy-engine.js';

async function scanner() {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const value = Buffer.concat(chunks).toString();
    if (value.includes('scanner error')) { res.writeHead(503); return res.end(); }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: value.includes('infected') ? 'infected' : 'clean', engine: 'grant-fixture-scanner' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}/scan`, stop: () => new Promise(resolve => server.close(resolve)) };
}

async function launch(dataDir, scannerUrl, extraEnv = {}) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: '', ENVOI_PORT: '0', ENVOI_AUTH_MODE: 'development', ENVOI_DATA_DIR: dataDir, ENVOI_MALWARE_SCANNER_URL: scannerUrl, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const baseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server start timed out: ${stderr}`)), 10_000);
    child.once('exit', code => reject(new Error(`Server exited ${code}: ${stderr}`)));
    child.stdout.on('data', chunk => {
      const match = chunk.toString().match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
  });
  return { baseUrl, stop: () => new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); }) };
}

async function api(baseUrl, route, { token, session, body, key } = {}) {
  const method = body ? 'POST' : 'GET';
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(session ? session.headers(baseUrl, method) : {}), ...(key ? { 'idempotency-key': key } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  session?.capture(response);
  return { status: response.status, payload: await response.json() };
}

async function owner(baseUrl, suffix) {
  const session = new BrowserSession();
  const started = await api(baseUrl, '/api/auth/phone/start', { session, body: { phoneNumber: `+14165553${suffix}`, displayName: `Asset owner ${suffix}` } });
  assert.equal(started.status, 201);
  const verified = await api(baseUrl, '/api/auth/phone/verify', { session, body: { challengeId: started.payload.challengeId, code: started.payload.developmentCode } });
  assert.equal(verified.status, 200);
  const setup = await api(baseUrl, '/api/auth/totp/setup', { session, body: {} });
  assert.equal(setup.status, 201);
  assert.equal((await api(baseUrl, '/api/auth/totp/verify', { session, body: { code: generateSync({ secret: setup.payload.secret }) } })).status, 200);
  const workspace = await api(baseUrl, '/api/inboxes', { session, body: { name: `Asset workspace ${suffix}` } });
  assert.equal(workspace.status, 201);
  const enrollment = await api(baseUrl, `/api/inboxes/${workspace.payload.id}/agent-enrollment-tokens`, { session, body: { permissions: ['send_agent_messages', 'receive_agent_messages', 'create_assets', 'execute_cases'] } });
  assert.equal(enrollment.status, 201);
  const enrolled = await api(baseUrl, '/api/agent-enroll', { body: { enrollmentToken: enrollment.payload.enrollmentToken, name: `Asset agent ${suffix}`, slug: `asset-${suffix}` } });
  assert.equal(enrolled.status, 201);
  return { session, human: verified.payload.human, ...enrolled.payload };
}

async function eventually(check) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Expected recipient case did not become visible');
}

test('owner-signed case grants narrow messages, file access, and recipient sharing', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'envoi-signed-case-assets-'));
  const scan = await scanner();
  let server = await launch(dataDir, scan.url);
  t.after(async () => { await server?.stop(); await scan.stop(); await rm(dataDir, { recursive: true, force: true }); });
  const [alice, bob] = await Promise.all([owner(server.baseUrl, '3104'), owner(server.baseUrl, '3105')]);
  const { privateKey, publicKey: signingKey } = crypto.generateKeyPairSync('ed25519');
  const publicKey = Buffer.from(signingKey.export({ format: 'jwk' }).x, 'base64url').toString('hex');
  const keyRecord = { public_key: publicKey, key_type: 'demo_device', registered_at_ms: Date.now() - 60_000, revoked_at_ms: null };
  const registry = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const query = JSON.parse(Buffer.concat(chunks).toString());
    const { owner: account } = JSON.parse(Buffer.from(query.params.args_base64, 'base64').toString());
    if (query.params.method_name !== 'owner_keys' || account !== 'alice.testnet') { res.writeHead(400); return res.end(); }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: query.id, result: { result: [...Buffer.from(JSON.stringify([keyRecord]))] } }));
  });
  registry.listen(0, '127.0.0.1');
  await once(registry, 'listening');
  t.after(() => new Promise(resolve => registry.close(resolve)));
  await server.stop();
  server = null;
  server = await launch(dataDir, scan.url, {
    ENVOI_SIGNED_POLICY_NETWORK: 'near-testnet',
    ENVOI_SIGNED_POLICY_RECORD_CONTRACT: 'record.testnet',
    ENVOI_SIGNED_POLICY_RPC_URL: `http://127.0.0.1:${registry.address().port}`,
    ENVOI_SIGNED_POLICY_OWNER_ACCOUNTS: JSON.stringify({ [alice.human.id]: 'alice.testnet' })
  });
  const { baseUrl } = server;
  const caseId = 'case_signed_asset_grants';
  const aliceInbox = `/api/inboxes/${alice.inbox.id}`;
  const bobInbox = `/api/inboxes/${bob.inbox.id}`;
  const agent = { token: alice.agentApiToken };
  const admin = { session: alice.session };
  const startedCase = await api(baseUrl, `${aliceInbox}/messages`, {
    ...agent, key: 'signed-asset-case',
    body: { senderAgentId: alice.agent.id, recipientEmail: bob.agent.address, caseId, type: 'request', text: 'Share case evidence' }
  });
  assert.equal(startedCase.status, 202, JSON.stringify(startedCase.payload));
  await eventually(async () => (await api(baseUrl, `${bobInbox}/cases/${caseId}`, { token: bob.agentApiToken })).status === 200);

  const checksum = bytes => crypto.createHash('sha256').update(bytes).digest('base64');
  const uploadTarget = (filename, bytes) => ({ filename, mimeType: 'text/plain', size: bytes.length, checksumSha256: checksum(bytes) });
  const begin = target => api(baseUrl, `${aliceInbox}/asset-uploads`, { ...agent, body: { ...target, caseId } });
  const complete = assetId => api(baseUrl, `${aliceInbox}/assets/${assetId}/complete`, { ...agent, body: {} });
  async function upload(target, bytes, finish) {
    const result = await begin(target);
    assert.equal(result.status, 201, JSON.stringify(result.payload));
    const { object, upload: link } = result.payload;
    assert.equal((await fetch(link.url, { method: 'PUT', headers: link.headers, body: bytes })).status, 204);
    if (finish) assert.equal((await complete(object.id)).payload.state, 'clean');
    return object;
  }
  const bytes = Buffer.from('signed case file');
  const visible = await upload(uploadTarget('visible.txt', bytes), bytes, true);
  const hidden = await upload(uploadTarget('hidden.txt', bytes), bytes, true);
  const approvedUpload = uploadTarget('approved.txt', bytes);
  const pending = await upload(uploadTarget('pending.txt', bytes), bytes, false);
  const signedPolicy = `${aliceInbox}/cases/${caseId}/signed-policy`;
  const target = { assetId: visible.id, assetVersion: visible.checksumSha256 };
  const grantAsset = assetId => api(baseUrl, `${aliceInbox}/assets/${assetId}/grants`, {
    ...agent, key: `grant-${assetId}`, body: { caseId, recipientAgentId: bob.agent.id }
  });
  async function setPolicy(grants) {
    const response = await api(baseUrl, signedPolicy, admin);
    assert.equal(response.status, 200, JSON.stringify(response.payload));
    const { version, previousHash } = response.payload;
    const now = Date.now();
    const preview = await api(baseUrl, `${signedPolicy}/preview`, { ...admin, body: {
      schema: 'envoi.case-policy/v1', workspaceId: alice.inbox.id, caseId, ownerId: alice.human.id, agentId: alice.agent.id,
      version, previousHash, issuedAtMs: now, expiresAtMs: now + 60_000, grants
    } });
    assert.equal(preview.status, 200, JSON.stringify(preview.payload));
    const { document } = preview.payload;
    const signature = crypto.sign(null, Buffer.from(valueDigest(document), 'hex'), privateKey).toString('hex');
    const saved = await api(baseUrl, signedPolicy, { ...admin, body: { document, signature, publicKey, keyType: 'demo_device' } });
    assert.equal(saved.status, 200, JSON.stringify(saved.payload));
  }
  const messageText = 'The requested evidence is ready.';
  const send = (text, key) => api(baseUrl, `${aliceInbox}/messages`, {
    ...agent, key, body: { senderAgentId: alice.agent.id, recipientEmail: bob.agent.address, caseId, text }
  });
  await setPolicy([
    { id: 'read-one-version', action: 'asset.read', decision: 'allow', target },
    { id: 'share-one-recipient', action: 'asset.share', decision: 'allow', target: { ...target, recipientAgentId: bob.agent.id } },
    { id: 'upload-one-checksum', action: 'asset.upload', decision: 'allow', target: approvedUpload },
    { id: 'send-evidence-reply', action: 'message.send', decision: 'allow', target: {
      recipientAgentId: bob.agent.id, recipientHumanId: null, type: 'message', intent: 'message',
      text: messageText, content: [{ type: 'text', text: messageText }], payload: null, proposal: null,
      artifactRefs: [], inReplyTo: null, taskId: null, correlationId: null, requiresAck: true
    } }
  ]);
  assert.equal((await send('The changed message is outside the grant.', 'signed-message-denied')).status, 403);
  const allowed = await send(messageText, 'signed-message-allowed');
  assert.equal(allowed.status, 202, JSON.stringify(allowed.payload));
  await eventually(async () => (await api(baseUrl, `${bobInbox}/messages`, { token: bob.agentApiToken }))
    .payload.some(message => message.id === allowed.payload.id && message.text === messageText));
  const listPath = `${aliceInbox}/assets?caseId=${caseId}`;
  assert.deepEqual((await api(baseUrl, listPath, agent)).payload.map(asset => asset.id), [visible.id]);
  assert.ok((await api(baseUrl, listPath, admin)).payload.some(asset => asset.id === hidden.id));
  assert.equal((await api(baseUrl, `${aliceInbox}/assets/${hidden.id}/download`, agent)).status, 404);
  assert.equal((await complete(pending.id)).status, 403);
  assert.equal((await begin({ ...approvedUpload, checksumSha256: checksum(Buffer.from('different')) })).status, 403);
  await upload(approvedUpload, bytes, true);
  assert.equal((await grantAsset(hidden.id)).status, 403);
  assert.equal((await grantAsset(visible.id)).status, 201);
  const bobDownload = await api(baseUrl, `${bobInbox}/assets/${visible.id}/download`, { token: bob.agentApiToken });
  assert.equal(bobDownload.status, 200, JSON.stringify(bobDownload.payload));
  const download = await api(baseUrl, `${aliceInbox}/assets/${visible.id}/download`, agent);
  assert.equal(download.status, 200, JSON.stringify(download.payload));
  assert.match(download.payload.download.url, /\/api\/inboxes\/[^/]+\/assets\/[^/]+\/content$/);
  const fetchVisible = () => fetch(download.payload.download.url, { headers: { authorization: `Bearer ${alice.agentApiToken}` } });
  assert.deepEqual(Buffer.from(await (await fetchVisible()).arrayBuffer()), bytes);
  assert.equal((await api(baseUrl, `${aliceInbox}/assets`, { token: `envoi_case_session_${'A'.repeat(43)}` })).status, 401);
  await setPolicy([]);
  assert.equal((await send(messageText, 'signed-message-revoked')).status, 403);
  assert.equal((await fetchVisible()).status, 404);
  assert.equal((await grantAsset(visible.id)).status, 403);
  assert.deepEqual((await api(baseUrl, listPath, agent)).payload, []);
});

for (const [label, extraEnv] of [['legacy gates', {}], ['Phase D authorization', { ENVOI_INSTALLATIONS_V2: 'true', ENVOI_RELATIONSHIPS_V2: 'true' }]]) test(`case asset grants remain private until explicit, clean, current counterparty authorization (${label})`, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'sinaloa-case-grants-'));
  const scan = await scanner();
  let server = await launch(dataDir, scan.url, extraEnv);
  t.after(async () => { await server.stop(); await scan.stop(); await rm(dataDir, { recursive: true, force: true }); });
  const migrations = await loadMigrations();
  assert.deepEqual(migrations.map(item => item.name), ['001_documents.sql', '002_object_storage.sql', '003_delivery.sql', '004_history_indexes.sql']);
  let { baseUrl } = server;
  const [alice, bob, outsider] = await Promise.all([owner(baseUrl, '3101'), owner(baseUrl, '3102'), owner(baseUrl, '3103')]);
  const caseId = 'case_asset_grant_A_B';
  const caseStart = await api(baseUrl, `/api/inboxes/${alice.inbox.id}/messages`, { token: alice.agentApiToken, key: 'grant-case-start', body: { senderAgentId: alice.agent.id, recipientEmail: bob.agent.address, caseId, type: 'request', intent: 'request', text: 'Share evidence for this case' } });
  assert.equal(caseStart.status, 202, JSON.stringify(caseStart.payload));
  await eventually(async () => (await api(baseUrl, `/api/inboxes/${bob.inbox.id}/cases/${caseId}`, { token: bob.agentApiToken })).status === 200);
  const assetRoute = who => `/api/inboxes/${who.inbox.id}/assets`;
  const list = (who, identity = 'agent', selectedCase = caseId) => api(baseUrl, `${assetRoute(who)}?caseId=${selectedCase}`, identity === 'human' ? { session: who.session } : { token: who.agentApiToken });
  const download = (who, assetId, identity = 'agent') => api(baseUrl, `${assetRoute(who)}/${assetId}/download`, identity === 'human' ? { session: who.session } : { token: who.agentApiToken });
  const begin = async (who, bytes, key, selectedCase = caseId) => api(baseUrl, `/api/inboxes/${who.inbox.id}/asset-uploads`, { token: who.agentApiToken, key, body: { filename: `${key}.txt`, mimeType: 'text/plain', size: bytes.length, checksumSha256: crypto.createHash('sha256').update(bytes).digest('base64'), caseId: selectedCase } });
  const upload = async (started, bytes) => fetch(started.payload.upload.url, { method: 'PUT', headers: started.payload.upload.headers, body: bytes });
  const complete = (who, assetId) => api(baseUrl, `${assetRoute(who)}/${assetId}/complete`, { token: who.agentApiToken, body: {} });
  const grant = (who, assetId, recipientAgentId, key, selectedCase = caseId) => api(baseUrl, `${assetRoute(who)}/${assetId}/grants`, { token: who.agentApiToken, key, body: { caseId: selectedCase, recipientAgentId } });

  const thirdPartyUpload = await begin(outsider, Buffer.from('forged case'), 'third-party-case');
  assert.equal(thirdPartyUpload.status, 403);
  const legacyCaseBypass = await api(baseUrl, assetRoute(outsider), { token: outsider.agentApiToken, body: { name: 'bypass.txt', contentBase64: Buffer.from('bypass').toString('base64'), createdByAgentId: outsider.agent.id, caseId } });
  assert.equal(legacyCaseBypass.status, 410);
  const bytes = Buffer.from('beta contract');
  const started = await begin(alice, bytes, 'clean-asset');
  assert.equal(started.status, 201, JSON.stringify(started.payload));
  const assetId = started.payload.object.id;
  assert.equal(started.payload.object.workspaceId, alice.inbox.id);
  assert.equal(started.payload.object.createdByAgentId, alice.agent.id);
  assert.equal(started.payload.object.caseId, caseId);
  assert.equal((await list(alice)).payload.some(item => item.id === assetId && item.state === 'quarantine'), true);
  assert.equal((await list(bob)).payload.some(item => item.id === assetId), false);
  assert.equal((await download(alice, assetId)).status, 423);
  assert.equal((await download(bob, assetId)).status, 404);
  const grantResponses = await Promise.all([
    grant(alice, assetId, bob.agent.id, 'grant-clean'),
    grant(alice, assetId, bob.agent.id, 'grant-clean')
  ]);
  assert.deepEqual(grantResponses.map(item => item.status).sort(), [200, 201]);
  const granted = grantResponses.find(item => item.status === 201);
  const parallelGrant = grantResponses.find(item => item.status === 200);
  assert.equal(parallelGrant.payload.id, granted.payload.id);
  assert.equal(granted.payload.active, false);
  assert.equal(granted.payload.ownerInboxId, alice.inbox.id);
  assert.equal(granted.payload.recipientInboxId, bob.inbox.id);
  const repeatedGrant = await grant(alice, assetId, bob.agent.id, 'grant-clean');
  assert.equal(repeatedGrant.status, 200);
  assert.equal(repeatedGrant.payload.id, granted.payload.id);
  const conflictingGrant = await grant(alice, assetId, outsider.agent.id, 'grant-clean');
  assert.equal(conflictingGrant.status, 409);
  assert.equal(conflictingGrant.payload.error, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await download(bob, assetId)).status, 423);
  assert.equal((await list(bob)).payload.some(item => item.id === assetId), false);
  assert.equal((await grant(outsider, assetId, bob.agent.id, 'third-party-grant')).status, 404);
  assert.equal((await grant(alice, assetId, outsider.agent.id, 'third-agent-grant')).status, 403);
  assert.equal((await upload(started, bytes)).status, 204);
  const clean = await complete(alice, assetId);
  assert.equal(clean.status, 200, JSON.stringify(clean.payload));
  assert.equal(clean.payload.state, 'clean');
  for (const who of [alice, bob]) for (const identity of ['agent', 'human']) {
    const found = await list(who, identity);
    assert.equal(found.status, 200);
    assert.equal(found.payload.filter(item => item.id === assetId).length, 1);
    const signed = await download(who, assetId, identity);
    assert.equal(signed.status, 200, JSON.stringify(signed.payload));
    const file = await fetch(signed.payload.download.url, signed.payload.download.url.includes('/api/inboxes/')
      ? { headers: identity === 'agent' ? { authorization: `Bearer ${who.agentApiToken}` } : who.session.headers(baseUrl, 'GET') }
      : undefined);
    assert.equal(file.status, 200);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
  }
  assert.equal((await list(bob, 'agent', 'case_unrelated')).payload.some(item => item.id === assetId), false);
  assert.equal((await list(outsider)).payload.some(item => item.id === assetId), false);
  assert.equal((await list(outsider, 'human')).payload.some(item => item.id === assetId), false);
  assert.equal((await download(outsider, assetId)).status, 404);
  assert.equal((await download(outsider, assetId, 'human')).status, 404);
  assert.equal((await api(baseUrl, `${assetRoute(alice)}/${assetId}/download`)).status, 401);
  const block = await api(baseUrl, `/api/inboxes/${alice.inbox.id}/contacts/${bob.agent.id}/block`, { session: alice.session, body: {} });
  assert.equal(block.status, 200);
  assert.equal((await list(bob)).payload.some(item => item.id === assetId), false);
  assert.equal((await list(bob, 'human')).payload.some(item => item.id === assetId), false);
  assert.equal((await download(bob, assetId)).payload.error, 'AGENT_BLOCKED');
  assert.equal((await download(bob, assetId, 'human')).status, 403);
  assert.equal((await api(baseUrl, `/api/inboxes/${alice.inbox.id}/contacts/${bob.agent.id}/unblock`, { session: alice.session, body: {} })).status, 200);
  assert.equal((await download(bob, assetId)).status, 200);

  for (const [key, content, state] of [['infected-asset', 'infected sample', 'infected'], ['error-asset', 'scanner error sample', 'error']]) {
    const result = await begin(alice, Buffer.from(content), key);
    assert.equal(result.status, 201);
    assert.equal((await grant(alice, result.payload.object.id, bob.agent.id, `grant-${key}`)).status, 201);
    assert.equal((await upload(result, Buffer.from(content))).status, 204);
    const scanned = await complete(alice, result.payload.object.id);
    if (state === 'error') assert.equal(scanned.status, 503); else assert.equal(scanned.payload.state, state);
    assert.equal((await list(bob)).payload.some(item => item.id === result.payload.object.id), false);
    assert.equal((await download(alice, result.payload.object.id)).status, 423);
    assert.equal((await download(bob, result.payload.object.id)).status, 423);
  }

  const oldStyle = await begin(alice, Buffer.from('private old record'), 'legacy-private');
  assert.equal(oldStyle.status, 201);
  assert.equal((await upload(oldStyle, Buffer.from('private old record'))).status, 204);
  assert.equal((await complete(alice, oldStyle.payload.object.id)).payload.state, 'clean');
  assert.equal((await download(bob, oldStyle.payload.object.id)).status, 404);
  await server.stop();
  server = await launch(dataDir, scan.url, extraEnv);
  baseUrl = server.baseUrl;
  assert.equal((await download(bob, assetId)).status, 200);
  assert.equal((await list(bob)).payload.filter(item => item.id === assetId).length, 1);
  assert.equal((await download(bob, oldStyle.payload.object.id)).status, 404);
  const retried = await grant(alice, assetId, bob.agent.id, 'grant-clean');
  assert.equal(retried.status, 200);
  assert.equal(retried.payload.id, granted.payload.id);
  assert.equal(retried.payload.active, true);
});
