import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateSync } from 'otplib';
import { BrowserSession } from './browser-session.js';

async function launch(existingDataDir = null, extraEnv = {}) {
  const dataDir = existingDataDir || await mkdtemp(path.join(tmpdir(), 'sinaloa-controls-'));
  const child = spawn(process.execPath, ['src/server.js'], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: '', ENVOI_PORT: '0', ENVOI_AUTH_MODE: 'development', ENVOI_DATA_DIR: dataDir, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const baseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server start timed out: ${stderr}`)), 10000);
    child.once('exit', code => reject(new Error(`Server exited ${code}: ${stderr}`)));
    child.stdout.on('data', chunk => { const match = chunk.toString().match(/http:\/\/127\.0\.0\.1:(\d+)/); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
  });
  return { baseUrl, dataDir, get stderr() { return stderr; }, stop: async (preserveData = false) => { await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); }); if (!preserveData) await rm(dataDir, { recursive: true, force: true }); } };
}

async function api(baseUrl, route, { token, session, body, key } = {}) {
  const method = body ? 'POST' : 'GET';
  const response = await fetch(`${baseUrl}${route}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(session ? session.headers(baseUrl, method) : {}), ...(key ? { 'idempotency-key': key } : {}) }, body: body ? JSON.stringify(body) : undefined });
  session?.capture(response);
  return { status: response.status, payload: await response.json() };
}

async function owner(baseUrl, suffix) {
  const session = new BrowserSession();
  const phone = await api(baseUrl, '/api/auth/phone/start', { session, body: { phoneNumber: `+14165554${suffix}`, displayName: `Control owner ${suffix}` } });
  const verified = await api(baseUrl, '/api/auth/phone/verify', { session, body: { challengeId: phone.payload.challengeId, code: phone.payload.developmentCode } });
  const setup = await api(baseUrl, '/api/auth/totp/setup', { session, body: {} });
  assert.equal((await api(baseUrl, '/api/auth/totp/verify', { session, body: { code: generateSync({ secret: setup.payload.secret }) } })).status, 200);
  const workspace = await api(baseUrl, '/api/inboxes', { session, body: { name: `Controls ${suffix}` } });
  const enrollment = await api(baseUrl, `/api/inboxes/${workspace.payload.id}/agent-enrollment-tokens`, { session, body: { permissions: ['send_agent_messages', 'receive_agent_messages', 'create_assets', 'execute_cases'] } });
  const enrolled = await api(baseUrl, '/api/agent-enroll', { body: { enrollmentToken: enrollment.payload.enrollmentToken, name: `Control agent ${suffix}`, slug: `control-${suffix}` } });
  assert.equal(enrolled.status, 201, JSON.stringify(enrolled.payload));
  return { session, human: verified.payload.human, ...enrolled.payload };
}

test('case sensitivity is an owner-only, idempotent case update', async t => {
  const server = await launch(null, { ENVOI_ENABLE_SENSITIVE_CASES: 'true' });
  t.after(server.stop);
  const [alice, bob] = await Promise.all([owner(server.baseUrl, '4411'), owner(server.baseUrl, '4412')]);
  const inbox = `/api/inboxes/${alice.inbox.id}`;
  const created = await api(server.baseUrl, `${inbox}/cases`, {
    token: alice.agentApiToken, body: { objective: 'Sensitive procurement review' }
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  const caseId = created.payload.id;
  const marker = `${inbox}/cases/${caseId}/sensitive`;
  const readView = () => api(server.baseUrl, `${inbox}/human-view`, { session: alice.session });
  assert.equal((await readView()).payload.caseQueue.find(item => item.id === caseId).canMarkSensitive, true);
  assert.ok([401, 403].includes((await api(server.baseUrl, marker, { token: alice.agentApiToken, body: {} })).status));
  assert.equal((await api(server.baseUrl, marker, { session: bob.session, body: {} })).status, 403);
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.deepEqual(await api(server.baseUrl, marker, { session: alice.session, body: {} }),
      { status: 200, payload: { caseId, sensitive: true } });
  }
  const view = (await readView()).payload;
  assert.equal(view.caseQueue.find(item => item.id === caseId).sensitive, true);
  assert.equal(view.caseQueue.find(item => item.id === caseId).canMarkSensitive, undefined);
  assert.equal(view.recentEvents.filter(event => event.type === 'case.marked_sensitive' && event.caseId === caseId).length, 1);
});

test('workspace owner can revise approved agent permissions and changes gate existing credentials', async t => {
  const server = await launch();
  t.after(server.stop);
  const [alice, bob] = await Promise.all([owner(server.baseUrl, '4301'), owner(server.baseUrl, '4302')]);
  const route = `/api/inboxes/${alice.inbox.id}/agents/${alice.agent.id}/permissions`;
  const original = alice.agent.permissions;
  const narrowed = original.filter(permission => permission !== 'send_agent_messages');
  const change = { permissions: narrowed, expectedPermissions: original };
  assert.equal((await api(server.baseUrl, route, { body: change })).status, 401);
  assert.equal((await api(server.baseUrl, route, { session: bob.session, body: change })).status, 403);
  assert.equal((await api(server.baseUrl, route, { session: alice.session, body: { permissions: ['unknown', 'receive_agent_messages'], expectedPermissions: original } })).status, 400);
  assert.equal((await api(server.baseUrl, route, { session: alice.session, body: { permissions: ['send_agent_messages'], expectedPermissions: original } })).status, 400);
  const updated = await api(server.baseUrl, route, { session: alice.session, body: change });
  assert.equal(updated.status, 200, JSON.stringify(updated.payload));
  assert.deepEqual(updated.payload.agent.permissions, narrowed);
  const send = () => api(server.baseUrl, `/api/inboxes/${alice.inbox.id}/messages`, { token: alice.agentApiToken, key: crypto.randomUUID(), body: { senderAgentId: alice.agent.id, recipientEmail: bob.agent.address, caseId: 'permission_update_case', text: 'Check current permission' } });
  assert.equal((await send()).status, 403, 'the existing credential cannot send after permission is removed');
  const stale = await api(server.baseUrl, route, { session: alice.session, body: { permissions: original, expectedPermissions: original } });
  assert.deepEqual([stale.status, stale.payload.code], [409, 'PERMISSIONS_CHANGED']);
  const oauthFamilyPath = path.join(server.dataDir, 'auth', 'agent-credential-families', alice.inbox.id, alice.agent.id, 'family_oauth_guard.json');
  await writeFile(oauthFamilyPath, JSON.stringify({ id: 'family_oauth_guard', audience: 'https://www.envoi-agents.com/mcp', revokedAt: null, refreshExpiresAt: new Date(Date.now() + 60_000).toISOString() }));
  const oauthWidening = await api(server.baseUrl, route, { session: alice.session, body: { permissions: original, expectedPermissions: narrowed } });
  assert.deepEqual([oauthWidening.status, oauthWidening.payload.code], [409, 'OAUTH_RECONSENT_REQUIRED']);
  await rm(oauthFamilyPath);
  const restored = await api(server.baseUrl, route, { session: alice.session, body: { permissions: original, expectedPermissions: narrowed } });
  assert.equal(restored.status, 200, JSON.stringify(restored.payload));
  assert.equal((await send()).status, 202, 'the same credential can send after its owner restores permission');
  const view = await api(server.baseUrl, `/api/inboxes/${alice.inbox.id}/human-view`, { session: alice.session });
  assert.ok(view.payload.recentEvents.some(event => event.type === 'agent.permissions_updated'));
  assert.equal((await api(server.baseUrl, `/api/inboxes/${alice.inbox.id}/agents/${alice.agent.id}/credentials/revoke`, { session: alice.session, body: {} })).status, 200);
  assert.equal((await api(server.baseUrl, route, { session: alice.session, body: { permissions: original, expectedPermissions: original } })).status, 409);
});

test('removal retains a read-only archive or deletes only the owned inbox and survives restart', async t => {
  let server = await launch();
  t.after(() => server.stop());
  const [alice, bob] = await Promise.all([owner(server.baseUrl, '4201'), owner(server.baseUrl, '4202')]);
  const route = `/api/inboxes/${alice.inbox.id}/agents/${alice.agent.id}/remove`;
  const caseId = 'case_removal_history';
  const bytes = Buffer.from('owned file');
  const upload = await api(server.baseUrl, `/api/inboxes/${alice.inbox.id}/asset-uploads`, { token: alice.agentApiToken, body: { filename: 'owned.txt', mimeType: 'text/plain', size: bytes.length, checksumSha256: crypto.createHash('sha256').update(bytes).digest('base64') } });
  assert.equal(upload.status, 201, JSON.stringify(upload.payload));
  assert.equal((await fetch(upload.payload.upload.url, { method: 'PUT', headers: upload.payload.upload.headers, body: bytes })).status, 204);
  const sent = await api(server.baseUrl, `/api/inboxes/${alice.inbox.id}/messages`, { token: alice.agentApiToken, key: 'removal-message', body: { senderAgentId: alice.agent.id, recipientEmail: bob.agent.address, caseId, text: 'Keep the counterpart copy' } });
  assert.equal(sent.status, 202);
  await eventually(async () => (await api(server.baseUrl, `/api/inboxes/${bob.inbox.id}/messages`, { token: bob.agentApiToken })).payload.some(message => message.id === sent.payload.id && message.status === 'delivered'));
  const stale = await api(server.baseUrl, `/api/inboxes/${alice.inbox.id}/agents/${alice.agent.id}/credentials/reconnect-token`, { session: alice.session, body: {} });
  assert.equal((await api(server.baseUrl, route, { session: bob.session, body: { deleteHistory: false } })).status, 403);
  assert.equal((await api(server.baseUrl, route, { session: alice.session, body: {} })).status, 400);
  assert.equal((await api(server.baseUrl, route, { session: alice.session, body: { deleteHistory: true, confirmation: 'wrong' } })).status, 400);
  assert.equal((await api(server.baseUrl, route, { session: alice.session, body: { deleteHistory: false } })).status, 200);
  const archive = (await api(server.baseUrl, `/api/inboxes/${alice.inbox.id}/human-view`, { session: alice.session })).payload;
  assert.deepEqual(archive.agents, []);
  assert.equal(archive.canManageInbox, false);
  assert.ok(archive.messages.some(message => message.id === sent.payload.id));
  assert.equal((await api(server.baseUrl, '/api/agent-token', { body: { agentRefreshToken: alice.agentRefreshToken, rotationId: 'rotation-removed-1' } })).status, 401);
  assert.equal((await api(server.baseUrl, '/mcp', { token: alice.agentApiToken, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).status, 401);
  assert.equal((await api(server.baseUrl, '/api/agent-enroll', { body: { enrollmentToken: stale.payload.enrollmentToken } })).status, 409);
  assert.equal((await api(server.baseUrl, `/api/inboxes/${alice.inbox.id}/agents/${alice.agent.id}/resume`, { session: alice.session, body: {} })).status, 409);
  assert.equal((await api(server.baseUrl, route, { session: alice.session, body: { deleteHistory: true, confirmation: alice.agent.name } })).status, 200);
  const purged = (await api(server.baseUrl, `/api/inboxes/${alice.inbox.id}/human-view`, { session: alice.session })).payload;
  assert.deepEqual(purged.messages, []);
  assert.deepEqual(purged.caseQueue, []);
  assert.deepEqual(purged.assets, []);
  await assert.rejects(() => readFile(path.join(server.dataDir, 'object-storage', 'metadata', `${upload.payload.object.id}.json`)), error => error.code === 'ENOENT');
  assert.ok((await api(server.baseUrl, `/api/inboxes/${bob.inbox.id}/messages`, { token: bob.agentApiToken })).payload.some(message => message.id === sent.payload.id));
  const directory = await api(server.baseUrl, `/api/organizations/${alice.inbox.organizationId}/workspaces`, { session: alice.session });
  assert.ok(!directory.payload.some(inbox => inbox.id === alice.inbox.id));
  const dataDir = server.dataDir;
  await server.stop(true);
  server = await launch(dataDir);
  assert.equal((await api(server.baseUrl, '/mcp', { token: alice.agentApiToken, body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } })).status, 401);
  assert.equal((await api(server.baseUrl, route, { session: alice.session, body: { deleteHistory: true, confirmation: alice.agent.name } })).status, 200);
});

async function eventually(check) {
  for (let i = 0; i < 100; i += 1) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Expected delivery did not complete');
}

test('human pause, case pause, block and revoke gate REST, MCP, work and assets', async t => {
  const server = await launch();
  t.after(server.stop);
  const { baseUrl } = server;
  const [alice, bob, outsider] = await Promise.all([owner(baseUrl, '4101'), owner(baseUrl, '4102'), owner(baseUrl, '4103')]);
  const caseId = 'case_control_A_B';
  const send = (who, other, key, text) => api(baseUrl, `/api/inboxes/${who.inbox.id}/messages`, { token: who.agentApiToken, key, body: { senderAgentId: who.agent.id, recipientEmail: other.agent.address, caseId, type: 'request', text } });
  const first = await send(alice, bob, 'control-first', 'First control message');
  assert.equal(first.status, 202);
  await eventually(async () => (await api(baseUrl, `/api/inboxes/${bob.inbox.id}/messages?caseId=${caseId}`, { token: bob.agentApiToken })).payload.some(item => item.id === first.payload.id && item.status === 'delivered'));
  const claim = await api(baseUrl, '/api/agent/work/claim', { token: bob.agentApiToken, body: {} });
  assert.equal(claim.status, 200);
  assert.equal(claim.payload.work.workId, first.payload.id);
  const pause = await api(baseUrl, `/api/inboxes/${bob.inbox.id}/agents/${bob.agent.id}/pause`, { session: bob.session, body: {} });
  assert.equal(pause.status, 200, `${JSON.stringify(pause.payload)} ${server.stderr}`);
  assert.equal(pause.payload.paused, true);
  assert.equal(pause.payload.credentialRevoked, false);
  // a3-pause-auth v1: a paused agent stays authenticated and addressable but cannot act.
  const pausedClaim = await api(baseUrl, '/api/agent/work/claim', { token: bob.agentApiToken, body: {} });
  assert.deepEqual([pausedClaim.status, pausedClaim.payload], [200, { work: null, state: 'paused' }]);
  const pausedRenew = await api(baseUrl, `/api/agent/work/${first.payload.id}/renew`, { token: bob.agentApiToken, body: { leaseToken: claim.payload.work.leaseToken } });
  assert.deepEqual([pausedRenew.status, pausedRenew.payload.code], [409, 'AGENT_PAUSED']);
  const pausedComplete = await api(baseUrl, `/api/agent/work/${first.payload.id}/complete`, { token: bob.agentApiToken, key: 'paused-complete', body: { leaseToken: claim.payload.work.leaseToken } });
  assert.deepEqual([pausedComplete.status, pausedComplete.payload.code], [409, 'AGENT_PAUSED']);
  const pausedMcp = await api(baseUrl, '/mcp', { token: bob.agentApiToken, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  assert.deepEqual([pausedMcp.status, pausedMcp.payload.code], [409, 'AGENT_PAUSED']);
  const toPaused = await send(alice, bob, 'paused-recipient', 'Accepted while paused');
  assert.deepEqual([toPaused.status, toPaused.payload.status], [202, 'queued'], JSON.stringify(toPaused.payload));
  const bobView = await api(baseUrl, `/api/inboxes/${bob.inbox.id}/human-view`, { session: bob.session });
  assert.equal(bobView.payload.agents.find(agent => agent.id === bob.agent.id).paused, true);
  assert.equal((await api(baseUrl, `/api/inboxes/${bob.inbox.id}/agents/${bob.agent.id}/resume`, { session: outsider.session, body: {} })).status, 403);
  const resume = await api(baseUrl, `/api/inboxes/${bob.inbox.id}/agents/${bob.agent.id}/resume`, { session: bob.session, body: {} });
  assert.equal(resume.status, 200);
  assert.equal(resume.payload.paused, false);
  // The pause invalidated the pre-pause lease without using an attempt; the same work is offered again.
  assert.equal((await api(baseUrl, `/api/agent/work/${first.payload.id}/renew`, { token: bob.agentApiToken, body: { leaseToken: claim.payload.work.leaseToken } })).status, 409);
  const reclaimed = await api(baseUrl, '/api/agent/work/claim', { token: bob.agentApiToken, body: {} });
  assert.deepEqual([reclaimed.status, reclaimed.payload.state, reclaimed.payload.work?.workId], [200, 'claimed', first.payload.id]);
  const lease = reclaimed.payload.work.leaseToken;
  assert.equal((await api(baseUrl, `/api/agent/work/${first.payload.id}/renew`, { token: bob.agentApiToken, body: { leaseToken: lease } })).status, 200);

  const unauthorizedDecision = await api(baseUrl, `/api/inboxes/${alice.inbox.id}/cases/${caseId}/actions`, { session: outsider.session, key: 'outsider-decision', body: { actionKey: 'approveOnce', externalRefs: { requestedAction: 'case.complete', result: 'forged' } } });
  assert.equal(unauthorizedDecision.status, 403);
  const casePause = await api(baseUrl, `/api/inboxes/${alice.inbox.id}/cases/${caseId}/actions`, { session: alice.session, key: 'case-pause', body: { actionKey: 'pause' } });
  assert.equal(casePause.status, 201, JSON.stringify(casePause.payload));
  assert.equal(casePause.payload.case.state, 'paused');
  const pauseReplay = await api(baseUrl, `/api/inboxes/${alice.inbox.id}/cases/${caseId}/actions`, { session: alice.session, key: 'case-pause', body: { actionKey: 'pause' } });
  assert.equal(pauseReplay.status, 200);
  assert.equal(pauseReplay.payload.action.id, casePause.payload.action.id);
  assert.equal((await send(alice, bob, 'paused-case-send', 'Must wait')).status, 409);
  assert.equal((await api(baseUrl, `/api/agent/work/${first.payload.id}/complete`, { token: bob.agentApiToken, key: 'case-paused-complete', body: { leaseToken: lease } })).status, 409);
  const caseResume = await api(baseUrl, `/api/inboxes/${alice.inbox.id}/cases/${caseId}/actions`, { session: alice.session, key: 'case-resume', body: { actionKey: 'resume' } });
  assert.equal(caseResume.status, 201, JSON.stringify(caseResume.payload));
  assert.equal(caseResume.payload.case.state, 'inProgress');

  const bytes = Buffer.from('control asset');
  const upload = await api(baseUrl, `/api/inboxes/${alice.inbox.id}/asset-uploads`, { token: alice.agentApiToken, key: 'control-upload', body: { filename: 'control.txt', mimeType: 'text/plain', size: bytes.length, checksumSha256: crypto.createHash('sha256').update(bytes).digest('base64'), caseId } });
  assert.equal(upload.status, 201);
  const grantRoute = `/api/inboxes/${alice.inbox.id}/assets/${upload.payload.object.id}/grants`;
  assert.equal((await api(baseUrl, grantRoute, { token: alice.agentApiToken, key: 'control-grant', body: { caseId, recipientAgentId: bob.agent.id } })).status, 201);
  const blocked = await api(baseUrl, `/api/inboxes/${alice.inbox.id}/contacts/${bob.agent.id}/block`, { session: alice.session, body: {} });
  assert.equal(blocked.status, 200);
  assert.equal((await send(bob, alice, 'blocked-send', 'Must be blocked')).status, 403);
  assert.equal((await api(baseUrl, `/api/agent/work/${first.payload.id}/renew`, { token: bob.agentApiToken, body: { leaseToken: lease } })).status, 403);
  assert.equal((await api(baseUrl, `/api/inboxes/${bob.inbox.id}/assets/${upload.payload.object.id}/download`, { token: bob.agentApiToken })).status, 403);
  assert.equal((await api(baseUrl, `/api/inboxes/${alice.inbox.id}/contacts/${bob.agent.id}/approve`, { session: alice.session, body: {} })).status, 404);
  assert.equal((await api(baseUrl, `/api/inboxes/${alice.inbox.id}/contacts/${bob.agent.id}/unblock`, { session: alice.session, body: {} })).status, 200);
  assert.equal((await send(bob, alice, 'unblocked-send', 'Allowed again')).status, 202);
  const staleReconnect = await api(baseUrl, `/api/inboxes/${bob.inbox.id}/agents/${bob.agent.id}/credentials/reconnect-token`, { session: bob.session, body: {} });
  assert.equal(staleReconnect.status, 201);
  const revoked = await api(baseUrl, `/api/inboxes/${bob.inbox.id}/agents/${bob.agent.id}/credentials/revoke`, { session: bob.session, body: {} });
  assert.equal(revoked.status, 200);
  const frozen = (await api(baseUrl, `/api/inboxes/${bob.inbox.id}/human-view`, { session: bob.session })).payload.agents.find(agent => agent.id === bob.agent.id);
  assert.equal(frozen.status, 'revoked');
  assert.equal(frozen.onboardingStatus, 'revoked');
  assert.deepEqual(frozen.permissions, []);
  assert.equal(frozen.credentialRevoked, true);
  assert.equal((await api(baseUrl, `/api/inboxes/${bob.inbox.id}/agents`, { session: bob.session })).payload.find(agent => agent.id === bob.agent.id).status, 'revoked');
  assert.equal((await api(baseUrl, `/api/inboxes/${bob.inbox.id}/agents/${bob.agent.id}/resume`, { session: bob.session, body: {} })).status, 409);
  assert.equal((await api(baseUrl, '/api/agent-token', { body: { agentRefreshToken: bob.agentRefreshToken, rotationId: 'rotation-paused-1' } })).status, 401);
  assert.equal((await api(baseUrl, '/mcp', { token: bob.agentApiToken, body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } })).status, 401);
  assert.equal((await api(baseUrl, '/api/agent/work/claim', { token: bob.agentApiToken, body: {} })).status, 401);
  assert.equal((await send(alice, bob, 'revoked-recipient', 'Must not be delivered')).status, 404);
  assert.equal((await api(baseUrl, '/api/agent-enroll', { body: { enrollmentToken: staleReconnect.payload.enrollmentToken } })).status, 409);

  const reenrollPath = `/api/inboxes/${bob.inbox.id}/agents/${bob.agent.id}/credentials/reconnect-token`;
  const reenroll = await api(baseUrl, reenrollPath, { session: bob.session, body: { runtime: 'openclaw', permissions: ['receive_agent_messages'] } });
  assert.equal(reenroll.status, 201);
  assert.deepEqual(reenroll.payload.permissions, ['receive_agent_messages']);
  const restored = await api(baseUrl, '/api/agent-enroll', { body: { enrollmentToken: reenroll.payload.enrollmentToken, runtime: 'openclaw' } });
  assert.equal(restored.status, 200, JSON.stringify(restored.payload));
  assert.equal(restored.payload.agent.id, bob.agent.id);
  assert.equal(restored.payload.agent.address, bob.agent.address);
  assert.deepEqual(restored.payload.agent.permissions, ['receive_agent_messages']);
  assert.equal((await api(baseUrl, `/api/inboxes/${bob.inbox.id}/human-view`, { session: bob.session })).payload.agents.find(agent => agent.id === bob.agent.id).status, 'active');
  assert.equal((await api(baseUrl, '/mcp', { token: bob.agentApiToken, body: { jsonrpc: '2.0', id: 3, method: 'tools/list' } })).status, 401);
  assert.equal((await api(baseUrl, '/api/agent-token', { body: { agentRefreshToken: bob.agentRefreshToken, rotationId: 'rotation-revoked-2' } })).status, 401);
  assert.equal((await api(baseUrl, '/api/agent/connection-status', { token: restored.payload.agentApiToken, body: { version: 1, runtime: 'openclaw', phase: 'ready', runtimeTest: 'passed' } })).status, 200);
  assert.equal((await api(baseUrl, `/api/inboxes/${bob.inbox.id}/messages`, { token: restored.payload.agentApiToken, key: 'reenrolled-limited', body: { senderAgentId: bob.agent.id, recipientEmail: alice.agent.address, caseId, type: 'request', text: 'Send permission not restored' } })).status, 403);
});

// Pre-freeze data (before ce07de5): families revoked with no revokedReason and an agent left
// active. The reconciliation runs once more for such data, then retires behind its marker.
test('startup freezes previously revoked credential families without restoring old permissions', async t => {
  const first = await launch();
  let current = first;
  t.after(async () => current.stop());
  const account = await owner(first.baseUrl, '4104');
  const route = `/api/inboxes/${account.inbox.id}/agents/${account.agent.id}/credentials/revoke`;
  assert.equal((await api(first.baseUrl, route, { session: account.session, body: {} })).status, 200);
  const agentPath = path.join(first.dataDir, 'inboxes', account.inbox.id, 'agents', `${account.agent.id}.json`);
  const directoryPath = path.join(first.dataDir, 'directory', 'agents', `${account.agent.id}.json`);
  const agent = JSON.parse(await readFile(agentPath, 'utf8'));
  const directory = JSON.parse(await readFile(directoryPath, 'utf8'));
  await writeFile(agentPath, JSON.stringify({ ...agent, status: 'active', onboardingStatus: 'approved', permissions: ['send_agent_messages', 'receive_agent_messages'], accessGeneration: 0 }));
  await writeFile(directoryPath, JSON.stringify({ ...directory, status: 'active' }));
  const familyDir = path.join(first.dataDir, 'auth', 'agent-credential-families', account.inbox.id, account.agent.id);
  for (const name of await readdir(familyDir)) {
    const { revokedReason: _reason, ...family } = JSON.parse(await readFile(path.join(familyDir, name), 'utf8'));
    await writeFile(path.join(familyDir, name), JSON.stringify(family));
  }
  await rm(path.join(first.dataDir, 'system', 'agent-revocations-reconciled-v1.json'), { force: true });
  await first.stop(true);
  current = await launch(first.dataDir);
  const frozen = (await api(current.baseUrl, `/api/inboxes/${account.inbox.id}/human-view`, { session: account.session })).payload.agents.find(item => item.id === account.agent.id);
  assert.equal(frozen.status, 'revoked');
  assert.deepEqual(frozen.permissions, []);
  assert.equal((await api(current.baseUrl, '/api/agent-token', { body: { agentRefreshToken: account.agentRefreshToken, rotationId: 'rotation-restart-1' } })).status, 401);
  assert.equal((await api(current.baseUrl, '/mcp', { token: account.agentApiToken, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).status, 401);
  assert.equal(JSON.parse(await readFile(agentPath, 'utf8')).status, 'revoked');
  assert.equal(JSON.parse(await readFile(directoryPath, 'utf8')).status, 'revoked');
});
