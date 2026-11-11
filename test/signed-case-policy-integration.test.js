import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateSync } from 'otplib';
import { valueDigest } from '../src/policy-engine.js';
import { BrowserSession } from './browser-session.js';

async function launch(dataDir, config = {}) {
  const child = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, DATABASE_URL: '', ENVOI_PORT: '0', ENVOI_AUTH_MODE: 'development',
      ENVOI_HUMAN_AUTH_PROVIDER: 'local', ENVOI_DATA_DIR: dataDir, ...config },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const stop = () => child.exitCode !== null ? Promise.resolve() : new Promise(resolve => {
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });
  try {
    const origin = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server start timed out: ${stderr}`)), 10_000);
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${stderr}`)); });
      child.stdout.on('data', chunk => {
        const match = chunk.toString().match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
      });
    });
    return { origin, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

test('signed policy and one-time owner approval narrow the existing case action flow', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'envoi-signed-authority-'));
  const session = new BrowserSession();
  let server;
  const keys = crypto.generateKeyPairSync('ed25519');
  const publicKey = Buffer.from(keys.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex');
  const registryKey = { public_key: publicKey, key_type: 'demo_device', registered_at_ms: Date.now() - 60_000, revoked_at_ms: null };
  const rpc = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    const { owner } = JSON.parse(Buffer.from(input.params.args_base64, 'base64').toString());
    const result = input.params.method_name === 'owner_keys' && owner === 'dana.testnet' ? [registryKey] : [];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: input.id, jsonrpc: '2.0', result: { result: [...Buffer.from(JSON.stringify(result))] } }));
  });
  t.after(async () => {
    await server?.stop();
    if (rpc.listening) await new Promise(resolve => rpc.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  await new Promise(resolve => rpc.listen(0, '127.0.0.1', resolve));
  server = await launch(dataDir);
  const call = async (route, { body, token, anonymous = false, key, status } = {}) => {
    const method = body ? 'POST' : 'GET';
    const asHuman = !token && !anonymous;
    const response = await fetch(server.origin + route, {
      method, headers: { ...(body ? { 'content-type': 'application/json' } : {}),
        ...(asHuman ? session.headers(server.origin, method) : {}), ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(key ? { 'idempotency-key': key } : {}) }, body: body ? JSON.stringify(body) : undefined
    });
    if (asHuman) session.capture(response);
    const result = await response.json();
    if (status !== undefined) assert.equal(response.status, status, JSON.stringify(result));
    return result;
  };
  const phone = await call('/api/auth/phone/start', { body: { phoneNumber: '+14165554311', displayName: 'Dana' } });
  const { human } = await call('/api/auth/phone/verify', { body: { challengeId: phone.challengeId, code: phone.developmentCode }, status: 200 });
  const setup = await call('/api/auth/totp/setup', { body: {} });
  await call('/api/auth/totp/verify', { body: { code: generateSync({ secret: setup.secret }) }, status: 200 });
  const workspace = await call('/api/inboxes', { body: { name: 'Signed policy' }, status: 201 });
  const enrollment = await call(`/api/inboxes/${workspace.id}/agent-enrollment-tokens`, {
    body: { permissions: ['send_agent_messages', 'receive_agent_messages', 'execute_cases'] }
  });
  const { inbox, agent, agentApiToken: token } = await call('/api/agent-enroll', {
    anonymous: true, body: { enrollmentToken: enrollment.enrollmentToken, name: 'Milo', slug: 'signed-milo' }, status: 201
  });
  await server.stop();
  server = await launch(dataDir, {
    ENVOI_SIGNED_POLICY_RPC_URL: `http://127.0.0.1:${rpc.address().port}`,
    ENVOI_SIGNED_POLICY_RECORD_CONTRACT: 'record.testnet', ENVOI_SIGNED_POLICY_NETWORK: 'near-testnet',
    ENVOI_SIGNED_POLICY_OWNER_ACCOUNTS: JSON.stringify({ [human.id]: 'dana.testnet' })
  });
  const cases = `/api/inboxes/${inbox.id}/cases`;
  const value = await call(cases, { token, body: { objective: 'Signed Acme review' }, status: 201 });
  const route = `${cases}/${value.id}`;
  const actionPayload = { note: 'Discuss the owner-approved deck' };
  const action = { actionKey: 'case.note', actionPayload, outcome: 'ok' };
  await call(`${route}/actions`, { token, body: action, key: 'legacy-note', status: 201 });
  const context = await call(`${route}/signed-policy`, { status: 200 });
  assert.equal(context.agentId, agent.id);
  const draft = {
    schema: 'envoi.case-policy/v1', workspaceId: context.workspaceId, caseId: context.caseId,
    ownerId: context.ownerId, agentId: context.agentId, version: context.version, previousHash: context.previousHash,
    issuedAtMs: Date.now(), expiresAtMs: Date.now() + 60_000,
    grants: [{ id: 'review-note', action: 'case.note', decision: 'needsHuman',
      target: { ...actionPayload, nextState: null, outcome: 'ok', externalRefs: {} } }]
  };
  const signed = document => ({ document, publicKey, keyType: 'demo_device',
    signature: crypto.sign(null, Buffer.from(valueDigest(document), 'hex'), keys.privateKey).toString('hex') });
  const { document } = await call(`${route}/signed-policy/preview`, { body: draft, status: 200 });
  await call(`${route}/signed-policy`, { token, body: signed(document), status: 403 });
  await call(`${route}/signed-policy`, { body: signed({ ...document, display: [] }), status: 400 });
  await call(`${route}/signed-policy`, { body: signed(document), status: 200 });
  await call(`${route}/actions`, { token, body: action, key: 'unsigned-note', status: 400 });
  const evaluate = target => call(`${route}/policy-evaluations`, { token, body: { requestedAction: 'case.note', actionPayload: target }, status: 201 });
  const denied = await evaluate({ ...draft.grants[0].target, note: 'Changed payload' });
  assert.equal(denied.decision, 'deny');
  const pending = await evaluate(draft.grants[0].target);
  assert.equal(pending.decision, 'needsHuman');
  assert.equal(pending.signedPolicy.digest, valueDigest(document));
  const execution = { ...action, policyEvaluationId: pending.id };
  await call(`${route}/actions`, { token, body: execution, key: 'pending-execution', status: 409 });
  const approve = { actionKey: 'approveOnce', externalRefs: { policyEvaluationId: pending.id } };
  await call(`${route}/actions`, { body: approve, key: 'missing-signature', status: 403 });
  const { document: approval } = await call(`${route}/signed-approval/${pending.id}`, { status: 200 });
  await call(`${route}/actions`, { body: { ...approve, signedApproval: signed(approval) }, key: 'approval', status: 201 });
  await call(`${route}/actions`, { token, body: { ...execution, actionPayload: { note: 'Changed payload' } }, key: 'changed-execution', status: 409 });
  await call(`${route}/actions`, { token, body: execution, key: 'exact-execution', status: 201 });
  await call(`${route}/actions`, { token, body: execution, key: 'second-execution', status: 409 });
  const secondPending = await evaluate(draft.grants[0].target);
  const { document: staleApproval } = await call(`${route}/signed-approval/${secondPending.id}`, { status: 200 });
  const replacement = await call(`${route}/signed-policy/preview`, { body: {
    ...draft, version: 2, previousHash: valueDigest(document), issuedAtMs: Date.now()
  }, status: 200 });
  await call(`${route}/signed-policy`, { body: signed(replacement.document), status: 200 });
  const stale = await call(`${route}/actions`, { key: 'stale-approval', status: 409, body: {
    actionKey: 'approveOnce', externalRefs: { policyEvaluationId: secondPending.id }, signedApproval: signed(staleApproval)
  } });
  assert.equal(stale.code, 'SIGNED_APPROVAL_STALE');
  registryKey.revoked_at_ms = Date.now();
  const revoked = await call(`${route}/policy-evaluations`, { token, body: {
    requestedAction: 'case.note', actionPayload: draft.grants[0].target
  }, status: 403 });
  assert.equal(revoked.code, 'OWNER_KEY_UNAVAILABLE');
});
