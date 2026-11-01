import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHelper } from '../helper/state.mjs';
import { ProtocolError } from '../helper/transport.mjs';
import { nativeConfirmation } from '../helper/confirmation.mjs';
const fixture = async name => JSON.parse(await readFile(new URL(`../../../test/contract-fixtures/agent-registration/${name}.json`, import.meta.url), 'utf8'));
// Test inputs come directly from the canonical publication, never local copies.
const contract = await fixture('schemas');
const origin = 'https://www.envoi-agents.com';
const runtime = { type: 'hermes', version: '0.9.0' };
const clone = value => structuredClone(value);
function memory() {
  const records = new Map();
  return { directory: 'private-test-directory', records,
    read: async name => clone(records.get(name) ?? null), write: async (name, value) => { records.set(name, clone(value)); }, lock: fn => fn() };
}
async function harness(sequence = [], extra = {}) {
  let time = Date.parse('2026-10-12T12:00:00.000Z');
  const calls = [], adopted = [], store = extra.store ?? memory();
  const options = { origin, runtime, contract, store, now: () => time, sleep: async ms => { time += ms; }, confirm: async () => true,
    random: () => 1, randomId: () => 'activation_7f3c9a1e', adopt: async (activation, context) => { adopted.push({ activation, context }); },
    request: async (method, path, supplied = {}) => {
      calls.push({ method, path, ...clone(supplied) });
      const next = sequence.shift();
      assert.ok(next, `unexpected private request ${method} ${path}`);
      if (next instanceof Error) throw next;
      const entry = typeof next === 'string' ? await fixture(next) : next;
      assert.equal(method, entry.request.method); assert.equal(path, entry.request.path);
      assert.equal(supplied.token, entry.request.headers?.authorization?.slice('Bearer '.length));
      if (entry.request.body) assert.deepEqual(supplied.body, entry.request.body);
      if (entry.response.status >= 400) throw new ProtocolError(entry.response.body.code, entry.response.status, entry.response.body, entry.response.headers?.['retry-after']);
      return clone(entry.response.body);
    }, ...extra };
  return { helper: await createHelper(options), options, store, calls, adopted, tick: ms => { time += ms; }, sequence };
}


// registration-created has a requestedLocalPart; helper supports selecting only a
// safe name/permissions. Compare creation against its authoritative response and
// explicitly test its client-owned request fields separately.
function createResponseFixture(entry) {
  if (typeof entry !== 'string') return entry;
  return fixture(entry);
}
async function started(extra = {}, suffix = []) {
  const created = await createResponseFixture('registration-created');
  delete created.request.body.requestedLocalPart;
  created.request.body.requestedName = 'Envoi agent';
  const h = await harness(['routes-available', created, ...suffix], extra);
  const result = await h.helper.connect();
  assert.equal(result.state, 'pending_approval');
  h.tick(5000);
  return { ...h, initial: result };
}

test('actual helper creates only an offered route and saves bootstrap before safe claim output', async () => {
  const h = await started();
  assert.equal(h.initial.claimUrl, `${origin}/claim`); assert.equal(h.initial.verificationCode, 'F7KQ-PM4D');
  const state = await h.store.read('helper-state.json');
  assert.equal(state.phase, 'pending'); assert.equal(state.bootstrapToken, 'envoi_reg_PLACEHOLDER_example');
  assert.equal(h.calls[1].body.connectionRoute, 'local_helper');
  assert.deepEqual(h.calls[1].body.deliveryCapabilities, { persistentProcess: true, outboundHttps: true, sse: true, webhook: false, scheduledPolling: false, a2a: false });
  assert.doesNotMatch(JSON.stringify(h.initial), /envoi_reg_|registration_example|private-test-directory/);
});

const fullPermissions = ['send_agent_messages', 'receive_agent_messages', 'execute_cases', 'create_assets'];
async function startedWithPermissions(permissions, extra = {}, suffix = []) {
  const created = await fixture('registration-created');
  delete created.request.body.requestedLocalPart;
  created.request.body.requestedName = 'Envoi agent';
  created.request.body.requestedPermissions = clone(permissions);
  const h = await harness(['routes-available', created, ...suffix], { ...extra, requestedPermissions: permissions });
  assert.equal((await h.helper.connect()).state, 'pending_approval'); h.tick(5000); return h;
}

test('explicit permissions reach canonical registration while the owner may narrow the effective grant', async () => {
  let prompted = false;
  const h = await startedWithPermissions(fullPermissions, { confirm: async details => {
    prompted = true;
    assert.deepEqual(details.permissionSummary, ['send agent messages', 'receive agent messages']); return true;
  } }, ['registration-approved', 'activation-created', 'agent-status-installation']);
  assert.deepEqual(h.calls[1].body.requestedPermissions, fullPermissions);
  assert.equal((await h.helper.resume()).state, 'connected'); assert.equal(prompted, true);
  assert.deepEqual((await h.store.read('helper-state.json')).requestedPermissions, fullPermissions);
  assert.deepEqual((await h.store.read('session.json'))._onboarding.effectivePermissions, ['send_agent_messages', 'receive_agent_messages']);
  assert.deepEqual(h.calls.filter(call => call.path.includes('/activate')).map(call => call.body), [(await fixture('activation-created')).request.body]);
});

test('all four approved permissions require native confirmation and survive activation and restart', async () => {
  const approved = await fixture('registration-approved');
  const activated = await fixture('activation-created');
  approved.response.body.effectivePermissions = clone(fullPermissions);
  activated.response.body.effectivePermissions = clone(fullPermissions);
  let confirmed = false;
  const h = await startedWithPermissions(fullPermissions, { confirm: async details => {
    assert.deepEqual(details.permissionSummary, fullPermissions.map(permission => contract['x-permission-labels'][permission]));
    assert.equal(h.calls.some(call => call.path.endsWith('/activate')), false);
    confirmed = true; return true;
  } }, [approved, activated, 'agent-status-installation']);
  assert.equal((await h.helper.resume()).state, 'connected');
  assert.equal(confirmed, true);
  assert.deepEqual(h.adopted[0].activation.effectivePermissions, fullPermissions);
  assert.deepEqual((await h.store.read('session.json'))._onboarding.effectivePermissions, fullPermissions);
  const restart = await harness(['agent-status-installation'], { store: h.store, now: h.options.now });
  assert.equal((await restart.helper.resume()).state, 'connected');
  assert.equal(restart.calls.length, 1); assert.equal(restart.calls[0].method, 'GET');
  assert.deepEqual((await h.store.read('helper-state.json')).requestedPermissions, fullPermissions);
});

test('an expired request may change permissions only with the explicit fresh-registration operation', async () => {
  const h = await started({}, ['registration-expired']);
  assert.equal((await h.helper.resume()).state, 'registration_ended');
  const created = await fixture('registration-created');
  delete created.request.body.requestedLocalPart;
  created.request.body.requestedName = 'Envoi agent';
  created.request.body.requestedPermissions = clone(fullPermissions);
  const retry = await harness(['routes-available', created], { store: h.store, now: h.options.now, requestedPermissions: fullPermissions });
  assert.equal((await retry.helper.connect({ fresh: true })).state, 'pending_approval');
  assert.deepEqual(retry.calls[1].body.requestedPermissions, fullPermissions);
  assert.deepEqual((await h.store.read('helper-state.json')).requestedPermissions, fullPermissions);
});

test('changed permissions cannot replace a pending request or contact the server', async () => {
  const h = await started(); const before = await h.store.read('helper-state.json');
  const retry = await harness([], { store: h.store, now: h.options.now, requestedPermissions: fullPermissions });
  assert.equal((await retry.helper.connect({ fresh: true })).state, 'needs_help');
  assert.deepEqual(await h.store.read('helper-state.json'), before);
  assert.equal(retry.calls.length, 0); assert.equal(retry.adopted.length, 0);
});

test('a reordered identical request resumes the same registration without another POST', async () => {
  const h = await startedWithPermissions(fullPermissions);
  const before = await h.store.read('helper-state.json');
  const retry = await harness(['registration-pending'], { store: h.store, now: h.options.now, requestedPermissions: [...fullPermissions].reverse() });
  assert.equal((await retry.helper.connect()).state, 'pending_approval');
  assert.equal(retry.calls.length, 1); assert.equal(retry.calls[0].method, 'GET');
  assert.equal((await h.store.read('helper-state.json')).registrationId, before.registrationId);
  assert.deepEqual((await h.store.read('helper-state.json')).requestedPermissions, fullPermissions);
});

test('legacy saved requests remain resumable and cannot be silently assigned new permissions', async () => {
  const h = await started(); const legacy = await h.store.read('helper-state.json');
  delete legacy.requestedPermissions; await h.store.write('helper-state.json', legacy);
  const retry = await harness(['registration-pending'], { store: h.store, now: h.options.now });
  assert.equal((await retry.helper.resume()).state, 'pending_approval');
  const before = await h.store.read('helper-state.json');
  const changed = await harness([], { store: h.store, now: h.options.now, requestedPermissions: fullPermissions });
  assert.equal((await changed.helper.connect()).state, 'needs_help');
  assert.deepEqual(await h.store.read('helper-state.json'), before); assert.equal(changed.calls.length, 0);
});

test('completed grants and unresolved activation requests cannot be expanded by connect flags', async () => {
  for (const fault of [undefined, async stage => { if (stage === 'activation_saved') throw new Error('simulated interruption'); }]) {
    const h = await started({ ...(fault ? { fault } : {}) }, ['registration-approved', ...(!fault ? ['activation-created', 'agent-status-installation'] : [])]);
    await h.helper.resume(); const before = await h.store.read('helper-state.json');
    const changed = await harness([], { store: h.store, now: h.options.now, requestedPermissions: fullPermissions });
    assert.equal((await changed.helper.connect({ fresh: true })).state, 'needs_help');
    assert.deepEqual(await h.store.read('helper-state.json'), before); assert.equal(changed.calls.length, 0);
  }
});

test('malformed permission lists fail before network work', async () => {
  for (const permissions of [[], ['send_agent_messages'], ['receive_agent_messages', 'receive_agent_messages'], ['receive_agent_messages', '__proto__']]) {
    await assert.rejects(harness([], { requestedPermissions: permissions }), /PERMISSIONS_REQUIRED/);
  }
});

test('approval prompts with canonical approver, workspace and permissions before activation, then verifies status', async () => {
  let prompted = false;
  const h = await started({ confirm: async details => {
    prompted = true; assert.equal(details.approverEmailHint, 'o***@example.com'); assert.equal(details.workspaceName, 'Example workspace');
    assert.deepEqual(details.permissionSummary, ['send agent messages', 'receive agent messages']); return true;
  } }, ['registration-approved', 'activation-created', 'agent-status-installation']);
  const result = await h.helper.resume();
  assert.equal(prompted, true); assert.equal(result.state, 'connected'); assert.equal(result.reachability, 'not_verified_closed_app');
  assert.equal(h.adopted.length, 1); assert.equal(h.adopted[0].context.completionId, 'activation_7f3c9a1e');
  const session = await h.store.read('session.json'); assert.equal(session._onboarding.origin, origin);
  assert.equal(session._onboarding.runtime.type, 'hermes');
  const finished = await h.store.read('helper-state.json'); assert.equal(finished.phase, 'completed');
  assert.equal(finished.bootstrapToken, undefined); assert.equal(finished.activationId, undefined);
  assert.doesNotMatch(JSON.stringify(result), /envoi_agent_|installation_example|activation_7f3c9a1e|agent_example|inbox_example/);
});

test('pending status and ordinary resume do not repeat the code; explicit show-code does', async () => {
  const h = await started({}, ['registration-pending']);
  assert.equal((await h.helper.resume()).verificationCode, undefined);
  assert.equal((await h.helper.status({ showCode: true })).verificationCode, 'F7KQ-PM4D');
  assert.equal(h.calls.length, 3);
});

test('disabled route never creates registration or adopts a runtime', async () => {
  const h = await harness(['routes-disabled']); const output = await h.helper.connect();
  assert.equal(output.guidance, 'route_unavailable'); assert.equal(h.calls.length, 1); assert.equal(h.adopted.length, 0);
});

test('unavailable runtime fails before registration or route request', async () => {
  const h = await harness([], { adopt: undefined }); assert.equal((await h.helper.connect()).state, 'needs_help'); assert.equal(h.calls.length, 0);
});

for (const [name, answer] of [['declined', false], ['advisory answer unavailable', null]]) {
  test(`${name} cannot activate`, async () => {
    const h = await started({ confirm: async () => answer }, ['registration-approved']);
    const result = await h.helper.resume(); assert.equal(result.state, answer === null ? 'confirm_approval' : 'registration_ended');
    assert.equal(h.calls.filter(call => call.path.includes('/activate')).length, 0);
    assert.equal((await h.store.read('helper-state.json')).bootstrapToken === undefined, answer === false);
  });
}

test('native confirmation without a private terminal never manufactures an answer', async () => {
  assert.equal(await nativeConfirmation({ activationExpiresAt: '2099-01-01T00:00:00Z' }, { input: { isTTY: false }, output: { isTTY: false } }), null);
});

test('confirmation deadline passing while human considers it prevents activation', async () => {
  let h;
  h = await started({ confirm: async () => { h.tick(20 * 60_000); return true; } }, ['registration-approved']);
  assert.equal((await h.helper.resume()).state, 'registration_ended');
  assert.equal((await h.store.read('helper-state.json')).bootstrapToken, undefined);
  assert.equal(h.calls.filter(call => call.path.includes('/activate')).length, 0);
});

test('lost response repeats the exact persisted activation request and recovers one credential set', async () => {
  const h = await started({}, ['registration-approved', new ProtocolError('NETWORK_ERROR'), 'activation-recovered', 'agent-status-installation']);
  assert.equal((await h.helper.resume()).state, 'connected');
  const attempts = h.calls.filter(call => call.path.includes('/activate')); assert.equal(attempts.length, 2); assert.deepEqual(attempts[0], attempts[1]);
  assert.equal(h.calls.filter(call => call.path === '/api/agent-registrations' && call.method === 'POST').length, 1);
});

test('crash after activation journal commit resumes same activation ID without prompting twice', async () => {
  const h = await started({ fault: async stage => { if (stage === 'activation_saved') throw new Error('simulated process exit'); } }, ['registration-approved']);
  assert.equal((await h.helper.resume()).state, 'needs_help');
  assert.equal(h.calls.filter(call => call.path.includes('/activate')).length, 0);
  // Reuse harness's fixture transport with the saved clock and journal.
  const retry = await harness(['activation-created', 'agent-status-installation'], { store: h.store, now: h.options.now,
    confirm: async () => { throw new Error('must not ask twice'); } });
  assert.equal((await retry.helper.resume()).state, 'connected');
  assert.equal(retry.calls[0].body.activationId, 'activation_7f3c9a1e');
});

test('crash after credentials commit adopts matching session without another activation', async () => {
  const h = await started({ fault: async stage => { if (stage === 'credentials_committed') throw new Error('simulated process exit'); } }, ['registration-approved', 'activation-created']);
  assert.equal((await h.helper.resume()).state, 'needs_help');
  assert.ok((await h.store.read('helper-state.json')).bootstrapToken);
  const retry = await harness(['agent-status-installation'], { store: h.store, now: h.options.now });
  assert.equal((await retry.helper.resume()).state, 'connected'); assert.equal(retry.calls.length, 1); assert.equal(retry.adopted.length, 1);
  assert.equal((await h.store.read('helper-state.json')).bootstrapToken, undefined);
});

test('failed credential save leaves activation recovery identifiers intact', async () => {
  const store = memory(); const original = store.write;
  store.write = async (name, value) => { if (name === 'session.json') throw new Error('disk full secret-never-print'); return original(name, value); };
  const h = await started({ store }, ['registration-approved', 'activation-created']);
  const output = await h.helper.resume(); assert.equal(output.state, 'needs_help'); assert.doesNotMatch(JSON.stringify(output), /disk full|secret-never-print/);
  assert.equal((await store.read('helper-state.json')).activationId, 'activation_7f3c9a1e'); assert.equal(await store.read('session.json'), null);
  store.write = original;
  const retry = await harness(['activation-recovered', 'agent-status-installation'], { store, now: h.options.now });
  assert.equal((await retry.helper.resume()).state, 'connected');
});

test('expired recovery guides owner reconnect without creating another registration', async () => {
  const h = await started({}, ['registration-approved', 'activation-recovery-expired']);
  const output = await h.helper.resume(); assert.equal(output.state, 'needs_reconnect'); assert.equal(output.guidance, 'owner_reconnect');
  assert.equal((await h.store.read('helper-state.json')).bootstrapToken, undefined);
});

test('token cleanup while activation unresolved requires checking owner agents, not automatic registration', async () => {
  const h = await started({}, ['registration-approved', 'activation-token-invalid-unresolved']);
  const output = await h.helper.resume(); assert.equal(output.guidance, 'check_owner_agents');
  assert.equal((await h.helper.connect()).guidance, 'check_owner_agents'); assert.equal(h.calls.filter(call => call.method === 'POST' && call.path === '/api/agent-registrations').length, 1);
});

test('bounded activation failures reconcile once using bootstrap status and never register', async () => {
  const h = await started({}, ['registration-approved', ...Array.from({ length: 5 }, () => new ProtocolError('NETWORK_ERROR')), 'registration-activated']);
  assert.equal((await h.helper.resume()).state, 'needs_reconnect');
  assert.equal(h.calls.filter(call => call.path.includes('/activate')).length, 5);
  assert.equal(h.calls.filter(call => call.method === 'GET' && call.path.includes('/api/agent-registrations/')).length, 2);
});

test('paused activation stays paused after authenticated status and never resumes server', async () => {
  const paused = await fixture('agent-status-installation'); paused.response.body.state = 'paused'; paused.response.body.agent.status = 'paused';
  const h = await started({}, ['registration-approved', 'activation-paused-agent', paused]);
  const output = await h.helper.resume(); assert.equal(output.state, 'paused'); assert.equal(output.agentStatus, 'paused');
  assert.equal(h.calls.some(call => call.path.includes('resume')), false);
});

test('invalid activation keeps approval live but resolves and clears invalid activation identifier', async () => {
  const invalid = await fixture('activation-invalid');
  // This fixture's intentionally invalid request is not what a correct helper
  // sends; its approved error response still drives helper handling.
  invalid.request.body = (await fixture('activation-created')).request.body;
  const h = await started({}, ['registration-approved', invalid]);
  const output = await h.helper.resume(); assert.equal(output.guidance, 'update_helper');
  const saved = await h.store.read('helper-state.json'); assert.equal(saved.activationId, undefined); assert.ok(saved.bootstrapToken);
});

test('malicious approved display values fail closed before prompt and never echo private text', async () => {
  const malicious = await fixture('registration-approved'); malicious.response.body.workspaceName = 'envoi_reg_PRIVATE_secret';
  const h = await started({ confirm: async () => { throw new Error('must not prompt'); } }, [malicious]);
  const result = await h.helper.resume(); assert.equal(result.state, 'needs_help'); assert.doesNotMatch(JSON.stringify(result), /PRIVATE|secret/);
});



test('explicit same-identity replacement carries the old completion binding into the new atomic session', async () => {
  const h = await started({}, ['registration-approved', 'activation-created', 'agent-status-installation']);
  await h.helper.resume();
  const previous = await h.store.read('session.json');
  h.sequence.push(new ProtocolError('CREDENTIAL_REVOKED', 401, { reason: 'revoked' }));
  assert.equal((await h.helper.status()).state, 'revoked');
  const created = await fixture('registration-created');
  delete created.request.body.requestedLocalPart;
  created.request.body.requestedName = 'Envoi agent';
  created.response.body.registrationId = 'registration_second';
  created.response.body.bootstrapToken = 'envoi_reg_PLACEHOLDER_second';
  const approved = await fixture('registration-approved');
  approved.request.path = '/api/agent-registrations/registration_second';
  approved.request.headers.authorization = 'Bearer envoi_reg_PLACEHOLDER_second';
  approved.response.body.registrationId = 'registration_second';
  approved.response.body.target = 'existing_agent'; approved.response.body.agent.id = 'agent_example';
  const activated = await fixture('activation-created');
  activated.request.body.registrationId = 'registration_second'; activated.request.body.activationId = 'activation_successor';
  activated.request.headers.authorization = 'Bearer envoi_reg_PLACEHOLDER_second';
  activated.response.body.installation.id = 'installation_successor';
  const status = await fixture('agent-status-installation'); status.response.body.installation.id = 'installation_successor';
  h.options.randomId = () => 'activation_successor';
  h.sequence.push('routes-available', created, approved, activated, status);
  assert.equal((await h.helper.connect({ fresh: true })).state, 'pending_approval');
  h.tick(5000);
  assert.equal((await h.helper.resume()).state, 'connected');
  const current = await h.store.read('session.json');
  assert.equal(current._onboarding.previousCompletionId, previous._onboarding.completionId);
  assert.equal(current._onboarding.previousInstallationId, previous._onboarding.installation.id);
  assert.equal(current._onboarding.previousAgentId, previous.agentId);
  assert.equal(current._onboarding.previousInboxId, previous.inboxId);
  assert.equal(current._onboarding.previousAddress, previous.address);
  assert.equal(current._onboarding.completionId, 'activation_successor');
});


test('Hermes tool recovery timeout gives static resume guidance and keeps the same activation', async () => {
  const error = Object.assign(new Error('PRIVATE provider body envoi_agent_access_NEVER_PROJECT'), { code: 'TOOLS_NOT_READY' });
  const h = await started({ adopt: async () => { throw error; } }, ['registration-approved', 'activation-created']);
  const output = await h.helper.resume();
  assert.equal(output.state, 'needs_help');
  assert.match(output.nextAction, /identity tool before the recovery deadline/);
  assert.match(output.nextAction, /resume this saved connection/);
  assert.match(output.nextAction, /Do not register again/);
  assert.equal(output.guidance, undefined);
  assert.doesNotMatch(JSON.stringify(output), /PRIVATE|NEVER_PROJECT|envoi_agent_access_|activation_/);
  const session = await h.store.read('session.json');
  const retry = await harness(['agent-status-installation'], { store: h.store, now: h.options.now });
  assert.equal((await retry.helper.resume()).state, 'connected');
  assert.equal(retry.adopted.length, 1);
  assert.equal(retry.adopted[0].context.completionId, session._onboarding.completionId);
  assert.deepEqual(retry.calls.map(call => call.path), ['/api/agent/status']);
});

test('installation revoke projects owner reconnect and remains terminal across status and resume', async () => {
  let revoked = false;
  const h = await started({ operationalStatus: async () => {
    if (revoked) throw Object.assign(new Error('PRIVATE diagnostic envoi_agent_access_DO_NOT_PRINT'), { code: 'CREDENTIAL_REVOKED', status: 401, reason: 'revoked' });
    return (await fixture('agent-status-installation')).response.body;
  } }, ['registration-approved', 'activation-created']);
  assert.equal((await h.helper.resume()).state, 'connected');
  const credentials = await h.store.read('session.json');
  const requestCount = h.calls.length;
  revoked = true;
  for (const command of ['status', 'resume', 'status']) {
    const result = await h.helper[command]();
    assert.equal(result.state, 'revoked'); assert.equal(result.guidance, 'owner_reconnect');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|DO_NOT_PRINT|envoi_agent_|installation_example/);
  }
  assert.equal(h.calls.length, requestCount);
  assert.deepEqual(await h.store.read('session.json'), credentials);
  assert.equal((await h.store.read('helper-state.json')).phase, 'ended');
});

for (const code of ['NETWORK_ERROR', 'TIMEOUT']) {
  for (const command of ['status', 'resume']) {
    test(`${command} preserves completed setup through a coded ${code} and recovers the same session`, async () => {
      let offline = false;
      const h = await started({ operationalStatus: async () => {
        if (offline) throw Object.assign(new Error('PRIVATE TLS cause envoi_agent_access_DO_NOT_PRINT'), { code });
        return (await fixture('agent-status-installation')).response.body;
      } }, ['registration-approved', 'activation-created']);
      await h.helper.resume();
      const credentials = await h.store.read('session.json');
      const journal = await h.store.read('helper-state.json');
      const requestCount = h.calls.length;
      offline = true;
      const result = await h.helper[command]();
      assert.equal(result.state, 'degraded'); assert.equal(result.guidance, 'service_unavailable');
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE|TLS|DO_NOT_PRINT|envoi_agent_|installation_example/);
      assert.deepEqual(await h.store.read('session.json'), credentials);
      assert.deepEqual(await h.store.read('helper-state.json'), journal);
      offline = false;
      assert.equal((await h.helper[command]()).state, 'connected');
      assert.equal(h.calls.length, requestCount); assert.equal(h.adopted.length, 1);
    });
  }
}
