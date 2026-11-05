// Local real-service regression. Synthetic owners and FileStore only; no Dot, host or live account.
import assert from 'node:assert/strict';
import test from 'node:test';
import { api, connect, documents, exchange, freshOwner, remoteServer, stored } from '../../../test/agent-remote-auth-token-harness.js';

const rpc = (server, token, method, params = {}) => api(server.baseUrl, '/mcp', {
  token, body: { jsonrpc: '2.0', id: 1, method, params }, headers: { accept: 'application/json, text/event-stream' }
});
const call = (server, token, name, args = {}) => rpc(server, token, 'tools/call', { name, arguments: args });
const content = response => { assert.equal(response.status, 200); assert.ok(!response.payload.result.isError); return JSON.parse(response.payload.result.content[0].text); };
async function eventually(read) {
  for (let attempt = 0; attempt < 100; attempt++) { const result = await read(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 30)); }
  assert.fail('Synthetic delivery did not become available');
}

test('receive-only OAuth identity reconnects with send access and exchanges canonical work in both directions', { timeout: 30000 }, async t => {
  const server = await remoteServer(t, { name: 'FileStore', env: {} });
  const docs = documents(t, server);
  const [ownerA, ownerB] = await Promise.all([freshOwner(server), freshOwner(server)]);
  const narrow = await connect(server, ownerA, { scope: 'envoi.agent', grantedPermissions: ['receive_agent_messages'] });
  const narrowTokens = (await exchange(server, narrow)).payload;
  assert.deepEqual(content(await call(server, narrowTokens.access_token, 'envoi_agent_info')).permissions, ['receive_agent_messages']);
  const absent = (await rpc(server, narrowTokens.access_token, 'tools/list')).payload.result.tools.map(item => item.name);
  assert.ok(!absent.includes('envoi_send_message'));
  assert.equal((await call(server, narrowTokens.access_token, 'envoi_send_message')).status, 403);

  const original = (await stored(docs, narrow.registrationId)).registration;
  const replacement = await connect(server, ownerA, { target: { kind: 'existing_agent', agentId: original.agentId, replacesInstallationId: original.installationId } });
  const tokensA = (await exchange(server, replacement)).payload;
  const grantB = await connect(server, ownerB);
  const tokensB = (await exchange(server, grantB)).payload;
  const infoA = content(await call(server, tokensA.access_token, 'envoi_agent_info'));
  const infoB = content(await call(server, tokensB.access_token, 'envoi_agent_info'));
  assert.equal(infoA.agentId, original.agentId);
  assert.equal(infoA.address, original.target.address);
  assert.deepEqual([...infoA.permissions].sort(), ['receive_agent_messages', 'send_agent_messages']);
  assert.equal((await rpc(server, narrowTokens.access_token, 'tools/list')).status, 401);

  for (const [sender, receiver, senderInfo, receiverInfo, direction] of [
    [tokensA, tokensB, infoA, infoB, 'forward'], [tokensB, tokensA, infoB, infoA, 'reverse']
  ]) {
    const args = { recipientAddress: receiverInfo.address, text: `Synthetic ${direction} request`, idempotencyKey: `dots-${direction}-start` };
    const sent = content(await call(server, sender.access_token, 'envoi_start_case', args));
    assert.equal(sent.status, 202);
    const replay = content(await call(server, sender.access_token, 'envoi_start_case', args));
    assert.equal(replay.payload.id, sent.payload.id);
    const work = await eventually(async () => content(await call(server, receiver.access_token, 'envoi_claim_work')).payload.work);
    assert.equal(work.workId, sent.payload.id);
    assert.equal(content(await call(server, receiver.access_token, 'envoi_renew_work', { workId: work.workId, leaseToken: work.leaseToken })).status, 200);
    assert.equal(content(await call(server, receiver.access_token, 'envoi_acknowledge_work', { workId: work.workId, leaseToken: work.leaseToken, idempotencyKey: `dots-${direction}-ack` })).status, 201);
    const replyArgs = { recipientAddress: senderInfo.address, caseId: sent.payload.caseId, text: `Synthetic ${direction} reply`, idempotencyKey: `dots-${direction}-reply` };
    const reply = content(await call(server, receiver.access_token, 'envoi_send_message', replyArgs));
    assert.equal(reply.status, 202);
    assert.equal(content(await call(server, receiver.access_token, 'envoi_send_message', replyArgs)).payload.id, reply.payload.id);
    const settle = { workId: work.workId, leaseToken: work.leaseToken, idempotencyKey: `dots-${direction}-done` };
    const done = content(await call(server, receiver.access_token, 'envoi_complete_work', settle));
    assert.equal(done.status, 201); assert.equal(done.payload.status, 'processed');
    assert.deepEqual(content(await call(server, receiver.access_token, 'envoi_complete_work', settle)).payload, done.payload);
    // Consume the reply without auto-replying, so the opposite direction starts with no pending work.
    const replyWork = await eventually(async () => content(await call(server, sender.access_token, 'envoi_claim_work')).payload.work);
    assert.equal(replyWork.workId, reply.payload.id);
    await call(server, sender.access_token, 'envoi_acknowledge_work', { workId: replyWork.workId, leaseToken: replyWork.leaseToken, idempotencyKey: `dots-${direction}-reply-ack` });
    assert.equal(content(await call(server, sender.access_token, 'envoi_complete_work', { workId: replyWork.workId, leaseToken: replyWork.leaseToken, idempotencyKey: `dots-${direction}-reply-done` })).payload.status, 'processed');
    for (const token of [sender.access_token, receiver.access_token]) {
      const messages = content(await call(server, token, 'envoi_list_messages', { caseId: sent.payload.caseId })).payload;
      assert.equal(messages.filter(item => item.id === sent.payload.id).length, 1);
      assert.equal(messages.filter(item => item.id === reply.payload.id).length, 1);
    }
  }
});
