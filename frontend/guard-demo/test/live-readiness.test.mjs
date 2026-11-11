import assert from 'node:assert/strict';
import test from 'node:test';
import { checkIds } from '../adapters/nearai/screen.mjs';
import { checkLiveReadiness } from '../scripts/check-live-readiness.mjs';

const checks = checkIds.map(id => ({ id, status: 'passed' }));
const inspectRecord = async () => ({ codeHashMatches: true, locked: false });

test('live readiness requires a verified flagged sample and reports an unlocked record separately', async () => {
  const result = await checkLiveReadiness({ inspectRecord,
    screen: { check: async () => ({ held: false, flagged: true, checks, evidence: { private: 'hidden' } }) } });
  assert.equal(result.attestation.verified, true);
  assert.equal(result.record.locked, false);
  assert.doesNotMatch(JSON.stringify(result), /hidden/);
  const partial = await checkLiveReadiness({ inspectRecord,
    screen: { check: async () => ({ held: false, flagged: true, checks: checks.slice(1) }) } });
  assert.equal(partial.attestation.verified, false);
});

test('billing failures and provider details remain separate from the contract check', async () => {
  const result = await checkLiveReadiness({ inspectRecord,
    screen: { check: async () => { throw Object.assign(new Error('private provider data'), { status: 402 }); } } });
  assert.deepEqual(result.record, { codeHashMatches: true, locked: false });
  assert.equal(result.attestation.error, 'NEAR AI credits or spending limit unavailable');
  assert.doesNotMatch(JSON.stringify(result), /private provider data/);
});
