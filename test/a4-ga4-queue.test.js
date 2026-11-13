// Gate GA4, server side (claude-codex-build-plan §6, a4-wake §6): with no event stream at
// all, a connector that only claims on its safety timer and the claim hint still processes
// retry-delayed work and work that arrived while it was offline exactly once. Runs on
// FileStore, and on PostgreSQL when DATABASE_URL is set (CI test:postgres). The client
// half (real connector, SSE cut at a proxy) is integrations/gates/ga4-local.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { api, claim, launch, owner, ownerMessages, send, sleep, waitForMessageStatus } from './a3-harness.js';

const backends = [{ name: 'FileStore', env: {}, suffix: '46' }, ...(process.env.DATABASE_URL ? [{ name: 'PostgreSQL', env: { DATABASE_URL: process.env.DATABASE_URL }, suffix: '47' }] : [])];
// Keep the retry pending while the test delivers and completes the offline work.
// Match the GA4 connector harness so slow test hosts can still observe the idle hint.
const RETRY_BASE_MS = 20_000;

for (const backend of backends) {
  test(`[${backend.name}] retry-delayed and offline work each settle exactly once without any event`, { timeout: 60000 }, async t => {
    const server = await launch({ ...backend.env, ENVOI_AGENT_WORK_RETRY_BASE_MS: String(RETRY_BASE_MS) });
    t.after(() => server.stop());
    const { baseUrl } = server;
    const [alice, bob] = await Promise.all([owner(baseUrl, `${backend.suffix}01`), owner(baseUrl, `${backend.suffix}02`)]);
    const complete = (work, key) => api(baseUrl, `/api/agent/work/${work.workId}/complete`, { token: bob.agentApiToken, key, body: { leaseToken: work.leaseToken } });

    // Retry-delayed: the first attempt fails before any effect and is scheduled for later.
    const delayed = await send(baseUrl, alice, bob, { caseId: `case_ga4_delayed_${backend.suffix}` });
    assert.equal(delayed.status, 202, delayed.text);
    await waitForMessageStatus(baseUrl, bob, delayed.payload.id, 'delivered');
    const first = await claim(baseUrl, bob.agentApiToken);
    assert.equal(first.payload.work?.workId, delayed.payload.id, first.text);
    const failed = await api(baseUrl, `/api/agent/work/${delayed.payload.id}/fail`, { token: bob.agentApiToken, body: { leaseToken: first.payload.work.leaseToken, retryable: true } });
    assert.equal(failed.status, 200, failed.text);

    // Offline arrival: delivered while the connector is not listening. No stream is ever opened.
    const offline = await send(baseUrl, alice, bob, { caseId: `case_ga4_offline_${backend.suffix}` });
    assert.equal(offline.status, 202, offline.text);
    await waitForMessageStatus(baseUrl, bob, offline.payload.id, 'delivered');

    // The connector restarts and only claims: single flight, until idle, then by the hint.
    const processed = [];
    let hinted = false;
    const deadline = Date.now() + 30000;
    while (processed.length < 2 && Date.now() < deadline) {
      const response = await claim(baseUrl, bob.agentApiToken);
      assert.equal(response.status, 200, response.text);
      if (response.payload.state === 'claimed') {
        const done = await complete(response.payload.work, `ga4-${backend.suffix}-${response.payload.work.workId}`);
        assert.equal(done.status, 201, done.text);
        processed.push(response.payload.work.workId);
        continue;
      }
      assert.equal(response.payload.state, 'idle');
      assert.ok(Number.isInteger(response.payload.nextAvailableInMs), `idle claim with delayed work carries the hint: ${response.text}`);
      hinted = true;
      await sleep(Math.max(1000, response.payload.nextAvailableInMs));
    }
    assert.deepEqual([...processed].sort(), [delayed.payload.id, offline.payload.id].sort(), 'each item processed once');
    assert.ok(hinted, 'the retry was found through the claim hint, not an event');
    assert.equal(processed[0], offline.payload.id, 'offline work was claimable at once; delayed work waited for its retry');

    // Later safety claims and a restart produce nothing more.
    for (let index = 0; index < 3; index += 1) {
      const later = await claim(baseUrl, bob.agentApiToken);
      assert.deepEqual([later.payload.state, later.payload.work], ['idle', null]);
      assert.equal('nextAvailableInMs' in later.payload, false, 'nothing is scheduled any more');
    }
    const messages = await ownerMessages(baseUrl, bob);
    for (const id of [delayed.payload.id, offline.payload.id]) {
      assert.equal(messages.find(message => message.id === id)?.status, 'processed', `${id} settled`);
    }
  });
}
