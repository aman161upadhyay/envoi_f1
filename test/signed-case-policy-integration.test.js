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
import { paymentApprover } from '../frontend/guard-demo/packages/core/payment-approval.mjs';
import { base58Encode } from '../frontend/guard-demo/adapters/near/sign.mjs';

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
  const paymentSigningKey = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  const approver = paymentApprover(paymentSigningKey);
  const publicKey = Buffer.from(keys.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex');
  const registryKey = { public_key: publicKey, key_type: 'demo_device', registered_at_ms: Date.now() - 60_000, revoked_at_ms: null };
  const spendingPolicyHash = 'a'.repeat(64);
  const txRef = '3'.repeat(44);
  const otherTxRef = '4'.repeat(44);
  const paidTxRef = '5'.repeat(44);
  const failedTxRef = '6'.repeat(44);
  const lateRefusalTxRef = '7'.repeat(44);
  const cancelledTxRef = '8'.repeat(44);
  const unrelatedFailureTxRef = '9'.repeat(44);
  const wrongExecutorTxRef = 'A'.repeat(44);
  const wrongApprovalTxRef = 'B'.repeat(44);
  const cancelledFirstTxRef = 'C'.repeat(44);
  const relayKeys = crypto.generateKeyPairSync('ed25519');
  const relayPublicBytes = Buffer.from(relayKeys.publicKey.export({ format: 'jwk' }).x, 'base64url');
  const relayPublicKey = 'ed25519:' + base58Encode(relayPublicBytes);
  const relaySeed = Buffer.from(relayKeys.privateKey.export({ format: 'jwk' }).d, 'base64url');
  let authorizedCall;
  let chainOwner = 'dana.testnet';
  let fullAccess = false;
  let relayAvailable = true;
  let relayAllowance = '250000000000000000000000';
  let relayBalance = '2000000000000000000000000';
  let cancellationSupported = true;
  let finalizedBlockTime;
  const cancellations = [];
  const rpc = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    let result;
    if (input.method === 'status') result = { chain_id: 'testnet' };
    else if (input.method === 'block') result = { header: { timestamp_nanosec: String(BigInt(finalizedBlockTime ?? Date.now()) * 1_000_000n) } };
    else if (input.method === 'gas_price') result = { gas_price: '100000000' };
    else if (input.method === 'EXPERIMENTAL_protocol_config') {
      const fee = { execution: 1, send_not_sir: 1 };
      result = { runtime_config: { storage_amount_per_byte: '10000000000000000000', transaction_costs: {
        action_receipt_creation_config: fee, action_creation_config: { function_call_cost: fee, function_call_cost_per_byte: fee }
      } } };
    }
    else if (input.method === 'send_tx') {
      const transaction = Buffer.from(input.params.signed_tx_base64, 'base64');
      const digest = crypto.createHash('sha256').update(transaction.subarray(0, -65)).digest();
      const argsStart = transaction.indexOf(Buffer.from('cancel_payments')) + 'cancel_payments'.length;
      const args = JSON.parse(transaction.subarray(argsStart + 4, argsStart + 4 + transaction.readUInt32LE(argsStart)));
      assert.equal(args.signature, approver.cancel({ contract: 'spend.testnet', owner: chainOwner, agent: args.agent, references: args.case_refs }));
      cancellations.push(args);
      result = { final_execution_status: 'FINAL', transaction: { hash: base58Encode(digest) }, status: { SuccessValue: '' } };
    }
    else if (input.method === 'tx') {
      const requestedHash = input.params.tx_hash;
      let args = authorizedCall;
      if (requestedHash === otherTxRef) args = { ...args, case_ref: 'other-payment' };
      if (requestedHash === wrongApprovalTxRef) args = { ...args, approval: { ...args.approval, signature: 'a'.repeat(128) } };
      const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64');
      const status = input.params.tx_hash === paidTxRef ? 'paid' : input.params.tx_hash === failedTxRef ? 'failed' : 'refused';
      result = { final_execution_status: 'FINAL', transaction: { hash: input.params.tx_hash,
        signer_id: 'milo.testnet', receiver_id: 'spend.testnet', actions: [{ FunctionCall: { method_name: 'pay', args: encoded(args) } }] },
      status: { SuccessValue: encoded({ status, agent: 'milo.testnet', to: args.to,
        amount: args.amount, case_ref: args.case_ref, policy_hash: spendingPolicyHash,
        ...(status === 'refused' ? { reason: 'over_daily_cap' } : {}) }) } };
      if ([cancelledTxRef, cancelledFirstTxRef, unrelatedFailureTxRef, wrongExecutorTxRef, wrongApprovalTxRef].includes(requestedHash)) {
        const rejection = requestedHash === unrelatedFailureTxRef ? 'payment approval expired' : 'payment approval cancelled';
        const outcome = { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: ' + rejection } } } } };
        result.status = outcome;
        result.transaction_outcome = { outcome: { status: { SuccessReceiptId: 'initial-payment-receipt' } } };
        result.receipts_outcome = [{ id: 'initial-payment-receipt', outcome: {
          executor_id: requestedHash === wrongExecutorTxRef ? 'other.testnet' : 'spend.testnet', status: outcome
        } }];
      }
    } else if (input.params.request_type === 'view_access_key') {
      result = { nonce: cancellations.length, block_hash: '1'.repeat(32), permission: relayAvailable
        ? { FunctionCall: { receiver_id: 'spend.testnet', method_names: ['cancel_payments'], allowance: relayAllowance } }
        : 'FullAccess' };
    } else if (input.params.request_type === 'view_account') {
      result = { amount: relayBalance, storage_usage: 100 };
    } else if (input.params.request_type === 'view_access_key_list') {
      result = { keys: [{ public_key: 'ed25519:fixture', access_key: { permission: {
        FunctionCall: { receiver_id: 'spend.testnet', method_names: ['pay'], allowance: '250000000000000000000000' }
      } } }, ...(fullAccess ? [{ public_key: 'ed25519:full', access_key: { permission: 'FullAccess' } }] : [])] };
    } else {
      const { owner, agent } = JSON.parse(Buffer.from(input.params.args_base64, 'base64').toString());
      const data = input.params.method_name === 'get_policy' && agent === 'milo.testnet'
        ? { owner: chainOwner, policy_hash: spendingPolicyHash, paused: false, version: 2,
          daily_cap: '2000000000000000000000000', payees: [{ account: 'ledger.testnet', max_per_payment: '1000000000000000000000000' }] }
        : input.params.method_name === 'get_payment_approval_key' ? approver.publicKey
          : input.params.method_name === 'payment_cancellation_supported' ? cancellationSupported
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
    ENVOI_NEAR_PAYMENT_APPROVAL_SIGNING_KEY: paymentSigningKey,
    ENVOI_NEAR_PAYMENT_CANCELLATION_RELAY_ACCOUNT: 'relay.testnet',
    ENVOI_NEAR_PAYMENT_CANCELLATION_RELAY_PUBLIC_KEY: relayPublicKey,
    ENVOI_NEAR_PAYMENT_CANCELLATION_RELAY_PRIVATE_KEY: 'ed25519:' + base58Encode(Buffer.concat([relaySeed, relayPublicBytes])),
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
  cancellationSupported = false;
  const unavailable = await call(payments, { token, body: reserve, status: 503 });
  assert.equal(unavailable.code, 'NEAR_PAYMENT_CANCELLATION_UNAVAILABLE');
  cancellationSupported = true;
  for (const allowance of ['0', '50000000000000000000000']) {
    relayAllowance = allowance;
    const exhausted = await call(payments, { token, body: reserve, status: 503 });
    assert.equal(exhausted.code, 'NEAR_PAYMENT_CANCELLATION_UNAVAILABLE');
    assert.equal(exhausted.instruction, undefined);
  }
  relayAllowance = null;
  relayBalance = '1000000000000000000000'; // Fully reserved for storage.
  const unfunded = await call(payments, { token, body: reserve, status: 503 });
  assert.equal(unfunded.code, 'NEAR_PAYMENT_CANCELLATION_UNAVAILABLE');
  relayBalance = '2000000000000000000000000';
  const issued = await call(payments, { token, body: reserve, status: 201 });
  relayAllowance = '250000000000000000000000';
  authorizedCall = issued.instruction.args;
  assert.deepEqual(authorizedCall, { to: paymentTarget.payee, amount: paymentTarget.amount.units,
    case_ref: issued.id, expected_policy_hash: spendingPolicyHash, approval: approver.approve({
      contract: 'spend.testnet', owner: 'dana.testnet', agent: 'milo.testnet', to: paymentTarget.payee,
      amount: paymentTarget.amount.units, caseRef: issued.id, policyHash: spendingPolicyHash,
      policyVersion: 2, expiresAtMs: Date.parse(issued.instruction.expiresAt)
    }) });
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
  const refunded = await call(confirm, { token, body: { txRef: failedTxRef }, status: 200 });
  assert.equal(refunded.outcome.status, 'failed');
  const settled = await call(confirm, { token, body: { txRef: paidTxRef }, status: 200 });
  assert.equal(settled.outcome.status, 'paid');
  assert.deepEqual(settled.attempts.map(attempt => attempt.status), ['refused', 'failed', 'paid']);
  const lateRefusal = await call(confirm, { token, body: { txRef: lateRefusalTxRef }, status: 200 });
  assert.equal(lateRefusal.outcome.txRef, paidTxRef);
  assert.equal(lateRefusal.attempts.length, 4);
  assert.deepEqual(await call(confirm, { token, body: { txRef }, status: 200 }), lateRefusal);
  async function issueAnotherPayment(key) {
    const pending = await call(`${route}/policy-evaluations`, { token, status: 201,
      body: { requestedAction: 'payment.near', actionPayload: paymentTarget } });
    const { document } = await call(`${route}/signed-approval/${pending.id}`, { status: 200 });
    await call(`${route}/actions`, { key, status: 201, body: {
      actionKey: 'approveOnce', externalRefs: { policyEvaluationId: pending.id }, signedApproval: signed(document)
    } });
    return call(payments, { token, body: { policyEvaluationId: pending.id }, status: 201 });
  }
  const expiredIssued = await issueAnotherPayment('expired-before-pause');
  finalizedBlockTime = Date.parse(expiredIssued.instruction.expiresAt);
  relayAvailable = false;
  await call(`${route}/actions`, { key: 'pause-after-expiry', body: { actionKey: 'pause' }, status: 201 });
  assert.deepEqual(cancellations, []);
  await call(`${route}/actions`, { key: 'resume-after-expiry', body: { actionKey: 'resume' }, status: 201 });
  relayAvailable = true;
  finalizedBlockTime = undefined;
  const nextIssued = await issueAnotherPayment('payment-before-pause');
  authorizedCall = nextIssued.instruction.args;
  const pause = { key: 'pause-with-payment', body: { actionKey: 'pause' } };
  relayAvailable = false;
  assert.equal((await call(`${route}/actions`, { ...pause, status: 503 })).code, 'NEAR_PAYMENT_CANCELLATION_UNAVAILABLE');
  assert.notEqual((await call(route, { status: 200 })).state, 'paused');
  relayAvailable = true;
  assert.equal((await call(`${route}/actions`, { ...pause, status: 201 })).case.state, 'paused');
  assert.deepEqual(cancellations.map(({ case_refs }) => case_refs), [[nextIssued.id]]);
  const paid = await call(`${payments}/${nextIssued.id}/confirm`, { body: { txRef: paidTxRef }, status: 200 });
  assert.equal(paid.outcome.status, 'paid');
  assert.ok(paid.cancelledAt);
  const rejectedConfirm = `${payments}/${nextIssued.id}/confirm`;
  for (const invalid of [unrelatedFailureTxRef, wrongExecutorTxRef, wrongApprovalTxRef]) {
    assert.equal((await call(rejectedConfirm, { body: { txRef: invalid }, status: 409 })).code, 'NEAR_PAYMENT_MISMATCH');
  }
  const cancelled = await call(rejectedConfirm, { body: { txRef: cancelledTxRef }, status: 200 });
  assert.equal(cancelled.outcome.status, 'paid', 'a later rejected attempt does not overwrite an earlier settlement');
  assert.deepEqual(cancelled.attempts.map(({ status, reason }) => [status, reason]), [['paid', undefined], ['refused', 'approval_cancelled']]);
  await call(rejectedConfirm, { body: { txRef: cancelledTxRef }, status: 200 });
  const afterCancellation = await call(`/api/inboxes/${inbox.id}/human-view`, { status: 200 });
  const rejectedEvents = afterCancellation.caseQueue.find(item => item.id === value.id).timeline
    .filter(event => event.type === 'receipt' && event.payload.txRef === cancelledTxRef);
  assert.equal(rejectedEvents.length, 1);
  assert.equal(rejectedEvents[0].payload.outcome, 'refused');
  assert.equal(rejectedEvents[0].payload.reasonCode, 'approval_cancelled');
  const cancellationTrace = (await call(`${route}/signed-trace`, { status: 200 })).steps
    .filter(step => step.record.details.txRef === cancelledTxRef);
  assert.equal(cancellationTrace.length, 1);
  assert.equal(cancellationTrace[0].record.details.receiptId, rejectedEvents[0].id);
  await call(`${route}/actions`, { key: 'resume-after-payment', body: { actionKey: 'resume' }, status: 201 });
  const policyIssued = await issueAnotherPayment('payment-before-policy-update');
  const edit = await call(`${route}/signed-policy/preview`, { body: {
    ...draft, version: 3, previousHash: valueDigest(replacement.document), issuedAtMs: Date.now(), expiresAtMs: Date.now() + 60_000
  }, status: 200 });
  await call(`${route}/signed-policy`, { body: signed(edit.document), status: 200 });
  assert.deepEqual(cancellations.at(-1).case_refs, [policyIssued.id]);
  authorizedCall = policyIssued.instruction.args;
  const cancelledFirst = await call(`${payments}/${policyIssued.id}/confirm`, { body: { txRef: cancelledFirstTxRef }, status: 200 });
  assert.equal(cancelledFirst.outcome.status, 'refused');
  assert.equal(cancelledFirst.outcome.reason, 'approval_cancelled');
  const revokeIssued = await issueAnotherPayment('payment-before-agent-revocation');
  registryKey.revoked_at_ms = Date.now();
  const revoked = await call(`${route}/policy-evaluations`, { token, body: {
    requestedAction: 'case.note', actionPayload: draft.grants[0].target
  }, status: 403 });
  assert.equal(revoked.code, 'OWNER_KEY_UNAVAILABLE');
  await call(`/api/inboxes/${inbox.id}/agents/${agent.id}/credentials/revoke`, { body: {}, status: 200 });
  assert.deepEqual(cancellations.map(({ case_refs }) => case_refs), [[nextIssued.id], [policyIssued.id], [revokeIssued.id]]);
});
