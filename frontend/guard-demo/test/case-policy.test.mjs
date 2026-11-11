import assert from 'node:assert/strict';
import test from 'node:test';
import { displayCasePolicy } from '../packages/core/case-grants.mjs';
import { evaluateCaseAction } from '../packages/core/case-policy.mjs';

test('signed scope limits edits and requires owner review for external sends', () => {
  const fileId = 'Acme_Q4_review.pptx';
  const policy = { agent: 'milo', version: 4, casePolicy: {
    caseRef: 'acme', expiresAtMs: 1000,
    grants: [
      { action: 'file_edit', fileId, counterparty: 'ledger', parts: [4, 5, 6], level: 'allowed' },
      { action: 'external_send', fileId, counterparty: 'acme-client', level: 'ask_first' }
    ]
  } };
  const decide = (input, now = 900) => evaluateCaseAction(policy,
    { agent: 'milo', caseRef: 'acme', fileId, action: 'file_edit', counterparty: 'ledger', ...input }, { now });
  assert.match(displayCasePolicy(policy.casePolicy)[1], /parts 4, 5, 6/);
  assert.equal(decide({ changedParts: [4, 6] }).decision, 'allow');
  assert.equal(decide({ changedParts: [4, 9] }).rule, 'edit_scope');
  assert.equal(decide({}).rule, 'edit_scope');
  assert.equal(decide({ action: 'file_open' }).decision, 'deny');
  assert.equal(decide({ changedParts: [4], fileId: 'other.pptx' }).decision, 'deny');
  assert.equal(decide({ changedParts: [4], caseRef: 'other' }).rule, 'case_scope');
  assert.equal(decide({ changedParts: [4] }, 1000).rule, 'case_scope');
  const approval = decide({ action: 'external_send', counterparty: 'acme-client' });
  assert.equal(approval.decision, 'ask_owner');
  assert.equal(approval.policyVersion, 4);
});

test('case payment authorization applies the owner caps and requires a current spend total', () => {
  const unit = 10n ** 24n;
  const policy = { agent: 'milo', version: 4,
    casePolicy: { caseRef: 'acme', expiresAtMs: 1000,
      grants: [{ action: 'payment', counterparty: 'ledger', level: 'allowed' }] },
    rules: { spend_money: {
      payees: [{ account: 'ledger', label: 'Ledger Co', maxPerPayment: String(unit) }],
      dailyCap: String(2n * unit)
    } }
  };
  const decide = (amount, spent) => evaluateCaseAction(policy,
    { agent: 'milo', caseRef: 'acme', action: 'payment', counterparty: 'ledger', amount: String(amount) },
    { now: 900, spent });
  assert.equal(decide(unit, 0n).decision, 'allow');
  assert.equal(decide(unit + 1n, 0n).rule, 'payment_limit');
  assert.equal(decide(unit, unit + 1n).rule, 'daily_limit');
  assert.equal(decide(unit).rule, 'payment_input');
});
