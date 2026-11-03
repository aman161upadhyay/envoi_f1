import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { PostgresStore } from '../src/postgres-storage.js';

// Exercise the production transaction boundary without a database or wall-clock sleeps.
function fixture(t, delays) {
  let now = 0;
  let releases = 0;
  const statements = [];
  t.mock.method(Date, 'now', () => now);
  const client = {
    async query(sql) {
      const stage = sql === 'BEGIN' ? 'begin' : sql.startsWith('SELECT set_config') ? 'config'
        : sql.startsWith('SELECT pg_advisory') ? 'lock' : sql;
      statements.push(stage);
      now += delays[stage] ?? 0;
      return { rows: [] };
    },
    release() { releases++; }
  };
  const store = Object.create(PostgresStore.prototype);
  store.transactionContext = new AsyncLocalStorage();
  store.pool = { async connect() { now += delays.connect ?? 0; return client; } };
  return { store, statements, get releases() { return releases; }, advance(ms) { now += ms; } };
}

for (const scenario of [
  { name: 'pool reply after the deadline', delays: { connect: 6000 }, forbidden: 'begin' },
  { name: 'BEGIN reply after the deadline', delays: { begin: 6000 }, forbidden: 'config' },
  { name: 'configuration reply after the deadline', delays: { begin: 1000, config: 5000 }, forbidden: 'lock' },
  { name: 'final advisory reply after the deadline', delays: { begin: 1000, config: 1000, lock: 4000 } },
  { name: 'final advisory reply exactly at the deadline', delays: { begin: 1000, config: 1000, lock: 3000 } }
]) {
  test(`PostgreSQL acquisition refuses ${scenario.name} without invoking the operation`, async t => {
    const f = fixture(t, scenario.delays);
    let invoked = false;
    let failure;
    try { await f.store.withTransaction(['offline:budget'], async () => { invoked = true; }, { lockWaitMs: 5000 }); }
    catch (error) { failure = error; }
    assert.equal(invoked, false, 'the transaction callback must not enter after its acquisition budget');
    assert.equal(failure?.code, 'LOCK_TIMEOUT');
    assert.equal(f.statements.includes('COMMIT'), false);
    if (scenario.forbidden) assert.equal(f.statements.includes(scenario.forbidden), false);
    if (f.statements.includes('begin')) assert.equal(f.statements.includes('ROLLBACK'), true);
    assert.equal(f.releases, 1);
  });
}

test('PostgreSQL acquisition permits a timely operation without imposing a new operation deadline', async t => {
  const f = fixture(t, { begin: 1000, config: 1000, lock: 2999 });
  const result = await f.store.withTransaction(['offline:budget'], async () => {
    assert.equal(f.store.transactionContext.getStore().active, true);
    f.advance(10000);
    return 'committed';
  }, { lockWaitMs: 5000 });
  assert.equal(result, 'committed');
  assert.equal(f.statements.includes('COMMIT'), true);
  assert.equal(f.statements.includes('ROLLBACK'), false);
  assert.equal(f.releases, 1);
});

test('PostgreSQL empty-lock transaction cannot enter its operation after BEGIN exhausts the budget', async t => {
  const f = fixture(t, { begin: 6000 });
  let invoked = false;
  await assert.rejects(f.store.withTransaction([], async () => { invoked = true; }, { lockWaitMs: 5000 }), { code: 'LOCK_TIMEOUT' });
  assert.equal(invoked, false);
  assert.equal(f.statements.includes('ROLLBACK'), true);
  assert.equal(f.statements.includes('COMMIT'), false);
  assert.equal(f.releases, 1);
});

test('PostgreSQL unbounded acquisition retains its existing behavior', async t => {
  const f = fixture(t, { begin: 6000, lock: 6000 });
  assert.equal(await f.store.withTransaction(['offline:budget'], async () => 'ok'), 'ok');
  assert.equal(f.statements.includes('config'), false);
  assert.equal(f.statements.includes('COMMIT'), true);
  assert.equal(f.releases, 1);
});
