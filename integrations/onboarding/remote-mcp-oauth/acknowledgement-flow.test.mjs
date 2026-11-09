// Temporary synthetic owners/FileStore only. No live Dot or production message.
import assert from 'node:assert/strict';
import test from 'node:test';
import { api, connect, exchange, freshOwner, remoteServer } from '../../../test/agent-remote-auth-token-harness.js';

const rpc = (server, token, name, args = {}) => api(server.baseUrl, '/mcp', {
  token, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  headers: { accept: 'application/json, text/event-stream' }
});
const content = response => {
  assert.equal(response.status, 200);
  assert.ok(!response.payload.result.isError, JSON.stringify(response.payload.result.content));
  return JSON.parse(response.payload.result.content[0].text);
};
async function eventually(read) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await read();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.fail('Local canonical delivery did not become available');
}

test('settling an authorized acknowledgement without a reply unblocks the next request and preserves unrelated work', { timeout: 30000 }, async t => {
  const server = await remoteServer(t, { name: 'FileStore', env: {} });
  async function owner() {
    const account = await freshOwner(server);
    const grant = await connect(server, account);
    const token = (await exchange(server, grant)).payload.access_token;
    return { token, info: content(await rpc(server, token, 'envoi_agent_info')) };
  }
  const sender = await owner(), receiver = await owner(), unrelated = await owner();
  const call = (who, name, args) => rpc(server, who.token, name, args).then(content);
  const first = await call(sender, 'envoi_start_case', {
    recipientAddress: receiver.info.address, text: 'im ready', intent: 'message', idempotencyKey: 'ack-flow-start'
  });
  assert.equal(first.status, 202);
  const caseId = first.payload.caseId;
  const firstWork = await eventually(async () => (await call(receiver, 'envoi_claim_work')).payload.work);
  assert.equal(firstWork.workId, first.payload.id);
  assert.equal(firstWork.message.from.address, sender.info.address);
  assert.equal(firstWork.message.caseId, caseId);
  // This plain-message acknowledgement is explicitly in the owner's receipt-only scope.
  // It is not classified by a universal text/intent heuristic.
  const request = await call(sender, 'envoi_send_message', {
    caseId, recipientAddress: receiver.info.address, text: 'Please confirm readiness. Reply once.',
    intent: 'request', idempotencyKey: 'ack-flow-request'
  });
  assert.equal(request.status, 202);
  await eventually(async () => (await call(receiver, 'envoi_list_messages', { caseId })).payload.some(message => message.id === request.payload.id));
  // The host stopped its run on this receipt-only item. The server does not impose
  // a global queue barrier; the corrected worker completes it and keeps claiming.
  assert.equal((await call(receiver, 'envoi_list_messages', { caseId })).payload.find(message => message.id === firstWork.workId).status, 'delivered');
  async function admit(work) {
    assert.equal((await call(receiver, 'envoi_renew_work', { workId: work.workId, leaseToken: work.leaseToken })).status, 200);
    assert.equal((await call(receiver, 'envoi_acknowledge_work', {
      workId: work.workId, leaseToken: work.leaseToken, idempotencyKey: 'admit:' + work.workId
    })).status, 201);
  }
  async function complete(work) {
    const args = { workId: work.workId, leaseToken: work.leaseToken, idempotencyKey: 'complete:' + work.workId };
    const done = await call(receiver, 'envoi_complete_work', args);
    assert.equal(done.status, 201);
    assert.equal(done.payload.status, 'processed');
    assert.deepEqual((await call(receiver, 'envoi_complete_work', args)).payload, done.payload);
  }
  await admit(firstWork);
  await complete(firstWork);
  const requestWork = await eventually(async () => (await call(receiver, 'envoi_claim_work')).payload.work);
  assert.equal(requestWork.workId, request.payload.id);
  assert.equal(requestWork.message.from.address, sender.info.address);
  assert.equal(requestWork.message.caseId, caseId);
  await admit(requestWork);
  const replyArgs = {
    caseId, recipientAddress: sender.info.address, text: 'Ready to exchange messages.',
    intent: 'status', idempotencyKey: 'reply:' + requestWork.workId
  };
  const reply = await call(receiver, 'envoi_send_message', replyArgs);
  assert.equal(reply.status, 202);
  assert.equal((await call(receiver, 'envoi_send_message', replyArgs)).payload.id, reply.payload.id);
  await complete(requestWork);
  const messages = (await call(receiver, 'envoi_list_messages', { caseId })).payload;
  assert.equal(messages.filter(message => message.from.address === receiver.info.address).length, 1);
  assert.equal(messages.find(message => message.id === reply.payload.id).intent, 'status');
  assert.equal((await call(receiver, 'envoi_claim_work')).payload.work, null);

  const outside = await call(unrelated, 'envoi_start_case', {
    recipientAddress: receiver.info.address, text: 'Unapproved work', intent: 'request', idempotencyKey: 'ack-flow-unrelated'
  });
  const outsideWork = await eventually(async () => (await call(receiver, 'envoi_claim_work')).payload.work);
  assert.equal(outsideWork.workId, outside.payload.id);
  assert.equal(outsideWork.message.from.address, unrelated.info.address);
  // The scope boundary stops here: no admission, send or settlement for unrelated work.
  const preserved = (await call(receiver, 'envoi_list_messages', { caseId: outside.payload.caseId })).payload;
  assert.equal(preserved.find(message => message.id === outside.payload.id).status, 'delivered');
  assert.equal(preserved.filter(message => message.from.address === receiver.info.address).length, 0);
});
