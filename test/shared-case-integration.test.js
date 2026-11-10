import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateSync } from 'otplib';
import { BrowserSession } from './browser-session.js';

async function launch(dataDir, flags = {}) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: '', ENVOI_PORT: '0', ENVOI_AUTH_MODE: 'development', ENVOI_DATA_DIR: dataDir, ...flags },
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
  const started = await api(baseUrl, '/api/auth/phone/start', { session, body: { phoneNumber: `+14165551${suffix}`, displayName: `Owner ${suffix}` } });
  assert.equal(started.status, 201);
  const verified = await api(baseUrl, '/api/auth/phone/verify', { session, body: { challengeId: started.payload.challengeId, code: started.payload.developmentCode } });
  assert.equal(verified.status, 200);
  const setup = await api(baseUrl, '/api/auth/totp/setup', { session, body: {} });
  assert.equal(setup.status, 201);
  assert.equal((await api(baseUrl, '/api/auth/totp/verify', { session, body: { code: generateSync({ secret: setup.payload.secret }) } })).status, 200);
  const workspace = await api(baseUrl, '/api/inboxes', { session, body: { name: `Workspace ${suffix}` } });
  assert.equal(workspace.status, 201);
  const enrollment = await api(baseUrl, `/api/inboxes/${workspace.payload.id}/agent-enrollment-tokens`, { session, body: { permissions: ['send_agent_messages', 'receive_agent_messages', 'execute_cases'] } });
  assert.equal(enrollment.status, 201, JSON.stringify(enrollment.payload));
  const enrolled = await api(baseUrl, '/api/agent-enroll', { body: { enrollmentToken: enrollment.payload.enrollmentToken, name: `Agent ${suffix}`, slug: `case-${suffix}` } });
  assert.equal(enrolled.status, 201);
  return { session, human: verified.payload.human, ...enrolled.payload };
}

async function eventually(check) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Expected case delivery did not become visible');
}

test('two independent owners share ordered typed cases without cross-case or authority leakage', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'sinaloa-shared-case-'));
  let server = await launch(dataDir);
  t.after(async () => { await server.stop(); await rm(dataDir, { recursive: true, force: true }); });
  const { baseUrl } = server;
  const [alice, bob, outsider] = await Promise.all([owner(baseUrl, '2101'), owner(baseUrl, '2102'), owner(baseUrl, '2103')]);
  assert.notEqual(alice.human.id, bob.human.id);
  assert.notEqual(alice.agent.id, bob.agent.id);
  assert.notEqual(alice.inbox.id, bob.inbox.id);
  const send = (who, recipient, caseId, type, intent, text, payload, key, authority) => api(baseUrl, `/api/inboxes/${who.inbox.id}/messages`, {
    token: who.agentApiToken, key,
    body: { senderAgentId: who.agent.id, recipientEmail: recipient.agent.address, caseId, type, intent, text, payload, ...(authority ? { authority } : {}) }
  });
  const read = (who, caseId) => api(baseUrl, `/api/inboxes/${who.inbox.id}/cases/${caseId}`, { token: who.agentApiToken });
  const [a1, b1] = await Promise.all([
    send(alice, bob, 'case_beta_A', 'request', 'request', 'Review answer A', { request: { question: 'Which answer?' } }, 'a-request-1'),
    send(alice, bob, 'case_beta_B', 'request', 'request', 'Review answer B', { request: { question: 'Which evidence?' } }, 'b-request-1')
  ]);
  assert.equal(a1.status, 202, JSON.stringify(a1.payload));
  assert.equal(b1.status, 202, JSON.stringify(b1.payload));
  assert.notEqual(a1.payload.caseId, b1.payload.caseId);
  await eventually(async () => (await read(bob, 'case_beta_A')).status === 200 && (await read(bob, 'case_beta_B')).status === 200);
  const injection = await send(outsider, bob, 'case_beta_A', 'request', 'request', 'Inject', {}, 'x-inject');
  assert.equal(injection.status, 403);
  assert.equal(injection.payload.error, 'CASE_PARTICIPANT_MISMATCH');
  const spoof = await api(baseUrl, `/api/inboxes/${alice.inbox.id}/messages`, { token: alice.agentApiToken, key: 'spoof', body: { senderAgentId: bob.agent.id, recipientEmail: bob.agent.address, caseId: 'case_beta_A', text: 'Spoof' } });
  assert.ok([401, 403].includes(spoof.status));
  const [b2, a2] = await Promise.all([
    send(bob, alice, 'case_beta_B', 'status', 'status', 'Collecting evidence', { progress: 'collecting' }, 'b-status-2'),
    send(alice, bob, 'case_beta_A', 'proposal', 'offer', 'Propose 42', { proposal: { answer: '42' } }, 'a-proposal-2')
  ]);
  assert.equal(b2.status, 202, JSON.stringify(b2.payload));
  assert.equal(a2.status, 202, JSON.stringify(a2.payload));
  const replay = await send(alice, bob, 'case_beta_A', 'proposal', 'offer', 'Propose 42', { proposal: { answer: '42' } }, 'a-proposal-2');
  assert.equal(replay.status, 200);
  assert.equal(replay.payload.id, a2.payload.id);
  const conflict = await send(alice, bob, 'case_beta_A', 'proposal', 'offer', 'Changed', { proposal: { answer: '42' } }, 'a-proposal-2');
  assert.equal(conflict.status, 409);
  assert.equal(conflict.payload.error, 'IDEMPOTENCY_CONFLICT');
  const a3 = await send(bob, alice, 'case_beta_A', 'counterproposal', 'counteroffer', 'Use 43', { counterproposal: { proposalMessageId: a2.payload.id, answer: '43' } }, 'a-counter-3');
  assert.equal(a3.status, 202, JSON.stringify(a3.payload));
  const a4 = await send(alice, bob, 'case_beta_A', 'decision', 'accept', 'Accept for review', { decision: { kind: 'accept', proposalMessageId: a3.payload.id } }, 'a-decision-4', { claimedByAgent: true, humanApproval: 'approved' });
  assert.equal(a4.status, 202, JSON.stringify(a4.payload));
  const pending = (await read(alice, 'case_beta_A')).payload;
  assert.equal(pending.state, 'waitingForHuman');
  assert.equal(pending.receipt, null);
  assert.equal(pending.events.find(event => event.id === `evt_${a4.payload.id}`).payload.verifiedHumanApproval, false);
  assert.equal(a4.payload.authority.humanApproval, 'notRequired');
  const forgedCompletion = await send(bob, alice, 'case_beta_A', 'completion', 'receipt', 'Forged', { completion: { result: '43', authorityBasis: 'action_forged' } }, 'forged-completion', { humanApproval: 'approved' });
  assert.equal(forgedCompletion.status, 409);
  const forgedAction = await api(baseUrl, `/api/inboxes/${alice.inbox.id}/cases/case_beta_A/actions`, { token: alice.agentApiToken, key: 'agent-forged-approval', body: { actionKey: 'approveOnce', outcome: 'ok', nextState: 'authorized', externalRefs: { requestedAction: 'case.complete', result: '43', serverAuthenticatedHuman: true } } });
  assert.ok([403, 409].includes(forgedAction.status));
  const forgedReceipt = await api(baseUrl, `/api/inboxes/${alice.inbox.id}/cases/case_beta_A/receipt`, { token: alice.agentApiToken, body: { result: '43', authorityBasis: 'action_forged', humanApprovalStatus: 'approved' } });
  assert.equal(forgedReceipt.status, 409);
  const approval = await api(baseUrl, `/api/inboxes/${bob.inbox.id}/cases/case_beta_A/actions`, { session: bob.session, key: 'human-approve-a-1', body: { actionKey: 'approveOnce', externalRefs: { requestedAction: 'case.complete', result: '43' }, reasonCode: 'reviewed' } });
  assert.equal(approval.status, 201, JSON.stringify(approval.payload));
  assert.equal(approval.payload.action.actor, bob.human.id);
  assert.equal(approval.payload.case.state, 'authorized');
  const completion = await send(bob, alice, 'case_beta_A', 'completion', 'receipt', 'Joint answer 43 complete', { completion: { result: '43', authorityBasis: approval.payload.action.id } }, 'a-complete-5');
  assert.equal(completion.status, 202, JSON.stringify(completion.payload));
  assert.equal((await send(bob, alice, 'case_beta_A', 'completion', 'receipt', 'Joint answer 43 complete', { completion: { result: '43', authorityBasis: approval.payload.action.id } }, 'a-complete-5')).payload.id, completion.payload.id);
  await eventually(async () => (await api(baseUrl, `/api/inboxes/${alice.inbox.id}/delivery-receipts`, { token: alice.agentApiToken })).payload.some(item => item.messageId === completion.payload.id && item.state === 'delivered'));
  await eventually(async () => (await api(baseUrl, `/api/inboxes/${bob.inbox.id}/delivery-receipts`, { token: bob.agentApiToken })).payload.some(item => item.messageId === a1.payload.id && item.state === 'delivered'));
  let claimed;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    claimed = await api(baseUrl, '/api/agent/work/claim', { token: bob.agentApiToken, body: {} });
    assert.equal(claimed.status, 200);
    if (claimed.payload.work.workId === a1.payload.id) break;
    assert.equal((await api(baseUrl, `/api/agent/work/${claimed.payload.work.workId}/complete`, { token: bob.agentApiToken, key: `process-before-a1-${attempt}`, body: { leaseToken: claimed.payload.work.leaseToken } })).status, 201);
  }
  assert.equal(claimed.payload.work.workId, a1.payload.id);
  const processed = await api(baseUrl, `/api/agent/work/${a1.payload.id}/complete`, { token: bob.agentApiToken, key: 'process-a1', body: { leaseToken: claimed.payload.work.leaseToken } });
  assert.equal(processed.status, 201, JSON.stringify(processed.payload));
  assert.equal((await api(baseUrl, `/api/agent/work/${a1.payload.id}/complete`, { token: bob.agentApiToken, key: 'process-a1', body: { leaseToken: claimed.payload.work.leaseToken } })).status, 200);
  const a = (await read(alice, 'case_beta_A')).payload;
  const aOther = (await read(bob, 'case_beta_A')).payload;
  const b = (await read(alice, 'case_beta_B')).payload;
  assert.deepEqual(aOther, a);
  assert.equal(a.state, 'completed');
  assert.equal(a.receipt.result, '43');
  assert.equal(a.receipt.humanApprovalStatus, 'approved');
  assert.equal(a.receipt.authorityBasis, approval.payload.action.id);
  assert.equal(a.proposals.length, 1);
  assert.equal(a.proposals[0].status, 'accepted');
  assert.equal(a.proposals[0].options.length, 2);
  assert.equal(a.proposals[0].options[0].expired, true);
  assert.equal(a.proposals[0].options[1].value.answer, '43');
  assert.equal(b.state, 'inProgress');
  assert.equal(b.receipt, null);
  assert.deepEqual((await read(bob, 'case_beta_B')).payload, b);
  assert.deepEqual(a.events.filter(event => event.payload.messageId).map(event => event.payload.messageId), [a1.payload.id, a2.payload.id, a3.payload.id, a4.payload.id, completion.payload.id]);
  assert.deepEqual(b.events.filter(event => event.payload.messageId).map(event => event.payload.messageId), [b1.payload.id, b2.payload.id]);
  for (let index = 1; index < a.events.length; index += 1) assert.equal(a.events[index].precedingEventRef, a.events[index - 1].id);
  assert.equal(a.events.filter(event => event.id === `evt_${a2.payload.id}`).length, 1);
  for (const who of [alice, bob]) {
    const view = await api(baseUrl, `/api/inboxes/${who.inbox.id}/human-view`, { session: who.session });
    assert.equal(view.status, 200);
    assert.deepEqual(view.payload.cases.find(item => item.id === 'case_beta_A'), a);
    assert.deepEqual(view.payload.cases.find(item => item.id === 'case_beta_B'), b);
    const projected = view.payload.caseQueue.find(item => item.id === 'case_beta_A');
    assert.equal(projected.state, 'completed');
    assert.equal(projected.proposals[0].options[0].value.answer, '42');
    assert.equal(projected.proposals[0].options[1].value.answer, '43');
    assert.equal(projected.proposals[0].status, 'accepted');
    assert.equal(projected.events.find(item => item.type === 'decision').payload.data.decision.kind, 'accept');
    assert.equal(projected.receipt.result, '43');
    const receipts = await api(baseUrl, `/api/inboxes/${who.inbox.id}/delivery-receipts`, { token: who.agentApiToken });
    assert.equal(receipts.payload.filter(item => item.messageId === a1.payload.id && item.state === 'processed').length, 1);
  }
  await server.stop();
  server = await launch(dataDir);
  assert.deepEqual((await api(server.baseUrl, `/api/inboxes/${alice.inbox.id}/cases/case_beta_A`, { token: alice.agentApiToken })).payload, (await api(server.baseUrl, `/api/inboxes/${bob.inbox.id}/cases/case_beta_A`, { token: bob.agentApiToken })).payload);
  assert.equal((await api(server.baseUrl, `/api/inboxes/${alice.inbox.id}/cases/case_beta_A`, { token: alice.agentApiToken })).payload.receipt.id, a.receipt.id);
});

test('three agents chat and settle independent assignments in one native case', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'envoi-group-case-'));
  const flags = { ENVOI_INSTALLATIONS_V2: 'true', ENVOI_CASE_SESSIONS_V1: 'true' };
  let server = await launch(dataDir, flags);
  t.after(async () => { await server.stop(); await rm(dataDir, { recursive: true, force: true }); });
  const [alice, bob, carol, outsider] = await Promise.all(
    ['2251', '2252', '2253', '2254'].map(suffix => owner(server.baseUrl, suffix))
  );
  const call = (who, route, body, key) => api(server.baseUrl, route, { token: who.agentApiToken, body, key });
  const createInput = { memberAddresses: [bob.agent.address, carol.agent.address], idempotencyKey: 'group-create' };
  assert.equal((await call(alice, '/api/agent/group-cases', createInput)).status, 403);
  // Seed mutual consent through the storage format used by accepted contact invitations.
  const members = [alice, bob, carol];
  for (const member of members) {
    const directory = path.join(dataDir, 'inboxes', member.inbox.id, 'contacts');
    await mkdir(directory, { recursive: true });
    for (const other of members.filter(agent => agent !== member)) {
      await writeFile(path.join(directory, `${other.agent.id}.json`), JSON.stringify({
        agentId: other.agent.id, approved: true, blocked: false
      }));
    }
  }
  const tool = async (token, name, args) => {
    const response = await fetch(`${server.baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-11-25'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
    });
    const envelope = await response.json();
    assert.equal(response.status, 200, JSON.stringify(envelope));
    assert.equal(envelope.error, undefined, JSON.stringify(envelope));
    assert.ok(!envelope.result.isError, JSON.stringify(envelope.result));
    return JSON.parse(envelope.result.content[0].text);
  };
  const create = await call(alice, '/api/agent/group-cases', createInput);
  assert.equal(create.status, 201, JSON.stringify(create.payload));
  const { caseId } = create.payload;
  assert.ok(caseId);
  const replayedCreate = await tool(alice.agentApiToken, 'envoi_start_group_case', createInput);
  assert.equal(replayedCreate.status, 200);
  assert.equal(replayedCreate.payload.caseId, caseId);
  assert.deepEqual(new Set(create.payload.members.map(member => member.agentId)),
    new Set([alice.agent.id, bob.agent.id, carol.agent.id]));
  const route = `/api/agent/group-cases/${caseId}`;
  const post = (who, body) => call(who, `${route}/messages`, body);
  const first = {
    text: 'Bob, review the first draft.',
    assigneeAgentIds: [bob.agent.id],
    idempotencyKey: 'group-first'
  };
  const [created, retry] = await Promise.all([post(alice, first), post(alice, first)]);
  assert.ok([200, 201, 202].includes(created.status), JSON.stringify(created.payload));
  assert.equal(retry.payload.id, created.payload.id);
  assert.equal(created.payload.caseId, caseId);
  assert.equal((await post(alice, { ...first, text: 'Changed after submission' })).status, 409);
  assert.equal((await post(alice, { ...first, idempotencyKey: 'nonmember-assignment',
    assigneeAgentIds: [outsider.agent.id] })).status, 400);
  assert.equal((await post(alice, { ...first, idempotencyKey: 'unknown-reply',
    inReplyTo: 'msg_00000000000000000000000000000000' })).status, 404);
  assert.ok([403, 404].includes((await call(outsider, route)).status));
  assert.ok([403, 404].includes((await post(outsider, { text: 'Unauthorized', idempotencyKey: 'outsider' })).status));

  const claim = who => call(who, '/api/agent/work/claim', {});
  const settle = (who, work) => call(who, `/api/agent/work/${work.workId}/complete`, {
    leaseToken: work.leaseToken
  }, `settle-${work.workId}`);
  const claimAssignment = who => eventually(async () => {
    const response = await claim(who);
    assert.equal(response.status, 200, JSON.stringify(response.payload));
    return response.payload.work;
  });
  const mint = async (who, work) => {
    const minted = await call(who, `/api/agent/work/${work.workId}/session`, { leaseToken: work.leaseToken });
    assert.equal(minted.status, 201, JSON.stringify(minted.payload));
    const { session } = minted.payload;
    assert.equal(session.caseId, caseId);
    assert.deepEqual(new Set(session.allowedTools), new Set(['envoi_case_snapshot', 'envoi_case_reply']));
    return session;
  };
  assert.equal((await claim(carol)).payload.work, null);
  const bobWork = await claimAssignment(bob);
  assert.notEqual(bobWork.workId, created.payload.id);
  const bobSession = await mint(bob, bobWork);
  const snapshot = await tool(bobSession.token, 'envoi_case_snapshot', {});
  assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
  const delegated = await tool(bobSession.token, 'envoi_case_reply', {
    text: 'Draft reviewed. Carol, check the figures.',
    assigneeAgentIds: [carol.agent.id],
    idempotencyKey: 'group-bob-reply'
  });
  assert.equal(delegated.ok, true, JSON.stringify(delegated));
  const bobReply = (await call(bob, route)).payload.messages.at(-1);
  assert.equal(bobReply.caseId, caseId);
  assert.ok([200, 201].includes((await settle(bob, bobWork)).status));
  const carolWork = await claimAssignment(carol);
  const carolSend = await tool(carol.agentApiToken, 'envoi_send_group_message', {
    caseId,
    text: 'I checked the figures.',
    inReplyTo: bobReply.id,
    idempotencyKey: 'group-carol-reply'
  });
  assert.equal(carolSend.status, 201);
  const carolReply = carolSend.payload;
  assert.equal(carolReply.caseId, caseId);
  assert.ok([200, 201].includes((await settle(carol, carolWork)).status));
  assert.equal((await claim(alice)).payload.work, null);

  const parallel = await post(alice, {
    text: 'Please both check the final draft.',
    inReplyTo: carolReply.id,
    assigneeAgentIds: [bob.agent.id, carol.agent.id],
    idempotencyKey: 'group-parallel-work'
  });
  assert.ok([200, 201, 202].includes(parallel.status), JSON.stringify(parallel.payload));
  await server.stop();
  server = await launch(dataDir, flags);
  const [bobFinal, carolFinal] = await Promise.all([claimAssignment(bob), claimAssignment(carol)]);
  assert.notEqual(bobFinal.workId, carolFinal.workId);
  assert.ok([403, 404, 409].includes((await settle(bob, carolFinal)).status));
  const session = await mint(bob, bobFinal);
  const finalSnapshot = await tool(session.token, 'envoi_case_snapshot', {});
  assert.equal(finalSnapshot.ok, true, JSON.stringify(finalSnapshot));
  assert.deepEqual(new Set(finalSnapshot.result.groupMembers.map(member => member.agentId)),
    new Set([alice.agent.id, bob.agent.id, carol.agent.id]));
  assert.equal(finalSnapshot.result.recentEvents.find(event => event.text === carolReply.text)?.actorAgentId,
    carol.agent.id);
  const scopedReply = await tool(session.token, 'envoi_case_reply', {
    text: 'I finished the final review.', idempotencyKey: 'group-scoped-reply'
  });
  assert.equal(scopedReply.ok, true, JSON.stringify(scopedReply));
  for (const result of await Promise.all([settle(bob, bobFinal), settle(carol, carolFinal)])) {
    assert.ok([200, 201].includes(result.status), JSON.stringify(result.payload));
  }
  for (const agent of [alice, bob, carol]) {
    const timeline = await call(agent, route);
    assert.equal(timeline.status, 200, JSON.stringify(timeline.payload));
    assert.deepEqual(timeline.payload.messages.slice(0, 4).map(message => message.id),
      [created.payload.id, bobReply.id, carolReply.id, parallel.payload.id]);
    assert.deepEqual(timeline.payload.messages.map(message => message.senderAgentId),
      [alice.agent.id, bob.agent.id, carol.agent.id, alice.agent.id, bob.agent.id]);
    assert.deepEqual(timeline.payload.messages.map(message => message.inReplyTo ?? null),
      [null, created.payload.id, bobReply.id, carolReply.id, parallel.payload.id]);
    assert.ok(timeline.payload.messages.every(message => message.caseId === caseId));
    assert.equal((await claim(agent)).payload.work, null);
    const humanView = await api(server.baseUrl, `/api/inboxes/${agent.inbox.id}/human-view`, { session: agent.session });
    assert.equal(humanView.status, 200, JSON.stringify(humanView.payload));
    const projected = humanView.payload.caseQueue.find(item => item.id === caseId);
    assert.equal(projected?.caseMode, 'group');
    assert.equal(projected.members.length, 3);
    assert.equal(projected.assignments.length, 4);
    assert.ok(projected.assignments.every(assignment => assignment.status === 'completed'));
  }
  const mcpTimeline = await tool(carol.agentApiToken, 'envoi_read_group_case', { caseId });
  assert.equal(mcpTimeline.payload.messages.length, 5);
});
