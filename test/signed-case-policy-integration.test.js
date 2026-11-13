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
  const spendingPolicyHash = 'a'.repeat(64);
  const txRef = '3'.repeat(44);
  const otherTxRef = '4'.repeat(44);
  const paidTxRef = '5'.repeat(44);
  let authorizedCall;
  let chainOwner = 'dana.testnet';
  let fullAccess = false;
  const rpc = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    let result;
    if (input.method === 'status') result = { chain_id: 'testnet' };
    else if (input.method === 'tx') {
      const args = input.params.tx_hash === otherTxRef ? { ...authorizedCall, case_ref: 'other-payment' } : authorizedCall;
      const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64');
      const paid = input.params.tx_hash === paidTxRef;
      result = { final_execution_status: 'FINAL', transaction: { hash: input.params.tx_hash,
        signer_id: 'milo.testnet', receiver_id: 'spend.testnet', actions: [{ FunctionCall: { method_name: 'pay', args: encoded(args) } }] },
      status: { SuccessValue: encoded({ status: paid ? 'paid' : 'refused', agent: 'milo.testnet', to: args.to,
        amount: args.amount, case_ref: args.case_ref, policy_hash: spendingPolicyHash,
        ...(paid ? {} : { reason: 'over_daily_cap' }) }) } };
    } else if (input.params.request_type === 'view_access_key_list') {
      result = { keys: [{ public_key: 'ed25519:fixture', access_key: { permission: {
        FunctionCall: { receiver_id: 'spend.testnet', method_names: ['pay'], allowance: '250000000000000000000000' }
      } } }, ...(fullAccess ? [{ public_key: 'ed25519:full', access_key: { permission: 'FullAccess' } }] : [])] };
    } else {
      const { owner, agent } = JSON.parse(Buffer.from(input.params.args_base64, 'base64').toString());
      const data = input.params.method_name === 'get_policy' && agent === 'milo.testnet'
        ? { owner: chainOwner, policy_hash: spendingPolicyHash, paused: false,
          daily_cap: '2000000000000000000000000', payees: [{ account: 'ledger.testnet', max_per_payment: '1000000000000000000000000' }] }
        : input.params.method_name === 'owner_keys' && owner === 'dana.testnet' ? [registryKey] : [];
      result = { result: [...Buffer.from(JSON.stringify(data))] };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: input.id, jsonrpc: '2.0', result }));
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
    ENVOI_SIGNED_POLICY_OWNER_ACCOUNTS: JSON.stringify({ [human.id]: 'dana.testnet' }),
    ENVOI_NEAR_PAYMENT_RPC_URL: `http://127.0.0.1:${rpc.address().port}`,
    ENVOI_NEAR_PAYMENT_CONTRACT: 'spend.testnet',
    ENVOI_NEAR_PAYMENT_AGENT_ACCOUNTS: JSON.stringify({ [agent.id]: 'milo.testnet' }),
    ENVOI_CASE_TRACE_SIGNING_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    ENVOI_ENABLE_CONSEQUENTIAL_ACTIONS: 'true'
  });
  const cases = `/api/inboxes/${inbox.id}/cases`;
  const value = await call(cases, { token, body: { objective: 'Acme Q4 review' }, status: 201 });
  const route = `${cases}/${value.id}`;
  const scopePath = `${route}/spend-scope`;
  await call(scopePath, { anonymous: true, status: 401 });
  await call(scopePath, { token, status: 403 });
  assert.deepEqual(await call(scopePath, { status: 200 }), {
    source: 'near-testnet', unit: 'yoctoNEAR', dailyCap: '2000000000000000000000000', paused: false,
    payees: [{ label: 'ledger.testnet', account: 'ledger.testnet', maxPerPayment: '1000000000000000000000000' }],
    agentKey: { account: 'milo.testnet', receiver: 'spend.testnet', methods: ['pay'], allowance: '250000000000000000000000' }
  });
  fullAccess = true;
  assert.equal((await call(scopePath, { status: 200 })).agentKey, undefined);
  chainOwner = 'other.testnet';
  await call(scopePath, { status: 404 });
  chainOwner = 'dana.testnet';
  const actionPayload = { note: 'Discuss the owner-approved deck' };
  const paymentTarget = { payee: 'ledger.testnet', amount: { units: '500000000000000000000000', unit: 'yoctoNEAR', network: 'near-testnet' } };
  const action = { actionKey: 'case.note', actionPayload, outcome: 'ok' };
  await call(`${route}/actions`, { token, body: action, key: 'legacy-note', status: 201 });
  const context = await call(`${route}/signed-policy`, { status: 200 });
  assert.equal(context.agentId, agent.id);
  const draft = {
    schema: 'envoi.case-policy/v1', workspaceId: context.workspaceId, caseId: context.caseId,
    ownerId: context.ownerId, agentId: context.agentId, version: context.version, previousHash: context.previousHash,
    issuedAtMs: Date.now(), expiresAtMs: Date.now() + 60_000,
    grants: [{ id: 'review-note', action: 'case.note', decision: 'needsHuman',
      target: { ...actionPayload, nextState: null, outcome: 'ok', externalRefs: {} } },
    { id: 'pay-ledger', action: 'payment.near', decision: 'needsHuman', target: paymentTarget }]
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
  const payPending = await call(`${route}/policy-evaluations`, { token, status: 201,
    body: { requestedAction: 'payment.near', actionPayload: paymentTarget } });
  assert.equal(payPending.decision, 'needsHuman');
  const decision = async () => (await call(`/api/inboxes/${inbox.id}/human-view`, { status: 200 }))
    .caseQueue.find(item => item.id === value.id).decision;
  assert.equal((await decision()).policyEvaluationId, payPending.id);
  assert.equal((await decision()).signedApprovalRequired, true);
  const payments = `${route}/near-payments`;
  const reserve = { policyEvaluationId: payPending.id };
  await call(payments, { token, body: reserve, status: 409 });
  const { document: paymentApproval } = await call(`${route}/signed-approval/${payPending.id}`, { status: 200 });
  await call(`${route}/actions`, { key: 'payment-approval', status: 201, body: {
    actionKey: 'approveOnce', externalRefs: { policyEvaluationId: payPending.id }, signedApproval: signed(paymentApproval)
  } });
  assert.notEqual((await decision())?.policyEvaluationId, payPending.id);
  const issued = await call(payments, { token, body: reserve, status: 201 });
  authorizedCall = issued.instruction.args;
  assert.deepEqual(authorizedCall, { to: paymentTarget.payee, amount: paymentTarget.amount.units,
    case_ref: issued.id, expected_policy_hash: spendingPolicyHash });
  await call(payments, { token, body: reserve, status: 409 });
  const confirm = `${payments}/${issued.id}/confirm`;
  await call(confirm, { token, body: { txRef: otherTxRef }, status: 409 });
  const payment = await call(confirm, { token, body: { txRef }, status: 200 });
  assert.equal(payment.outcome.status, 'refused');
  assert.deepEqual(await call(confirm, { token, body: { txRef }, status: 200 }), payment);
  const trace = await call(`${route}/signed-trace`, { status: 200 });
  const confirmation = trace.steps.find(step => step.record.type === 'payment.confirmed');
  assert.equal(confirmation.record.details.reasonCode, 'over_daily_cap');
  assert.equal(confirmation.record.details.amount, paymentTarget.amount.units);
  assert.equal(confirmation.record.details.network, 'near-testnet');
  const { timeline } = (await call(`/api/inboxes/${inbox.id}/human-view`, { status: 200 })).caseQueue.find(item => item.id === value.id);
  assert.ok(timeline.some(event => event.type === 'policyEvaluation' && event.policyEvaluationId === payPending.id
    && event.payload.payee === paymentTarget.payee && event.payload.amount === paymentTarget.amount.units));
  assert.equal(timeline.filter(event => event.type === 'receipt' && event.payload.txRef === txRef && event.payload.reasonCode === 'over_daily_cap').length, 1);
  const nextPayment = await call(`${route}/policy-evaluations`, { token, status: 201,
    body: { requestedAction: 'payment.near', actionPayload: paymentTarget } });
  const nextApproval = await call(`${route}/signed-approval/${nextPayment.id}`, { status: 200 });
  await call(`${route}/actions`, { key: 'next-payment-approval', status: 201, body: {
    actionKey: 'approveOnce', externalRefs: { policyEvaluationId: nextPayment.id }, signedApproval: signed(nextApproval.document)
  } });
  const nextIssued = await call(payments, { token, body: { policyEvaluationId: nextPayment.id }, status: 201 });
  authorizedCall = nextIssued.instruction.args;
  const paid = await call(`${payments}/${nextIssued.id}/confirm`, { token, body: { txRef: paidTxRef }, status: 200 });
  assert.equal(paid.outcome.status, 'paid');
  registryKey.revoked_at_ms = Date.now();
  const revoked = await call(`${route}/policy-evaluations`, { token, body: {
    requestedAction: 'case.note', actionPayload: draft.grants[0].target
  }, status: 403 });
  assert.equal(revoked.code, 'OWNER_KEY_UNAVAILABLE');
});
