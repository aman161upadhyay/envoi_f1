import test from 'node:test';
import assert from 'node:assert/strict';
import { nearAiScreen } from '../adapters/nearai/screen.mjs';

test('an unfunded workspace stops the private check with an actionable, redacted error', async () => {
  const key = 'private-test-token';
  const screen = nearAiScreen({
    apiKey: key, model: 'canonical-model',
    fetcher: async () => new Response(JSON.stringify({
      error: { message: 'No spending limit configured. Please contact support to set up credits. ' + key }
    }), { status: 402 }),
    verifier: async () => { throw new Error('Verifier must not run'); }
  });
  await assert.rejects(screen.check({ text: 'Invoice 1042' }), error => {
    assert.equal(error.code, 'NEAR_AI_CREDITS_UNAVAILABLE');
    assert.equal(error.status, 402);
    assert.match(error.message, /spending limit/);
    assert.equal(error.message.includes(key), false);
    return true;
  });
});
