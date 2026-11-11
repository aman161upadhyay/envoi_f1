import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalAdapters } from '../adapters/local/store.mjs';
import { ZERO_ROOT } from '../packages/core/tree.mjs';

test('pause, empty vault, day rollover and unregistered agent preserve refusal ordering', async () => {
  let now = 86400000 - 1;
  const { db, spendGuard: spend } = createLocalAdapters(':memory:', () => now);
  const owner = 'owner.testnet';
  const agent = 'milo.testnet';
  const payee = 'ledger.testnet';
  const pay = (amount, account = agent, to = payee) => spend.pay(account, to, amount, 'case-1042');
  const policy = { payees: [{ account: payee, maxPerPayment: '2' }], dailyCap: '3', paused: true };
  try {
    assert.equal((await pay('1')).reason, 'not_registered');
    await spend.registerAgent(owner, agent, 'ab'.repeat(32));
    await spend.setPolicy(owner, agent, policy, ZERO_ROOT);
    assert.equal((await pay('3', agent, 'attacker.testnet')).reason, 'paused');
    await spend.setPolicy(owner, agent, { ...policy, paused: false }, ZERO_ROOT);
    assert.equal((await pay('1')).reason, 'vault_low');
    await spend.deposit(owner, '10');
    assert.equal((await pay('2')).status, 'paid');
    assert.equal((await pay('2')).reason, 'over_daily_cap');
    assert.equal(await spend.vaultOf(owner), '8');
    now += 1;
    assert.equal((await pay('2')).status, 'paid');
    assert.equal(await spend.vaultOf(owner), '6');
  } finally { db.close(); }
});
