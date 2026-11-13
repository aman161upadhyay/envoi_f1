import { describe, expect, it } from 'vitest';
import { describeAction, formatNear, ruleFor, setPayeeLabels, slideList, sourceLabel } from '../src/decision-rules';
import type { Asset, ParticipantIdentity } from '../src/types';

const assets = [
  { id: 'asset_deck', filename: 'Acme_Q4_review.pptx' },
  { id: 'asset_may_model', filename: 'May model.xlsx' }
] as Asset[];
const directory: Record<string, ParticipantIdentity> = {
  human_dana: { id: 'human_dana', type: 'human', displayName: 'Dana' },
  agent_ledgerco: { id: 'agent_ledgerco', type: 'externalAgent', displayName: 'Ledger Co', address: 'ledger-payee.northwind.near' },
  agent_acme: { id: 'agent_acme', type: 'externalAgent', displayName: 'Acme' }
};

describe('formatNear', () => {
  it('converts yoctoNEAR without dropping digits', () => {
    expect(formatNear('500000000000000000000000')).toBe('0.5 NEAR');
    expect(formatNear('20000000000000000000000000')).toBe('20 NEAR');
    expect(formatNear('1234567000000000000000000')).toBe('1.234567 NEAR');
    expect(formatNear('1')).toBe('0.000000000000000000000001 NEAR');
    expect(formatNear('0')).toBe('0 NEAR');
    expect(formatNear('nope')).toBeNull();
  });
});

describe('slideList', () => {
  it('compresses consecutive slides', () => {
    expect(slideList([4, 5, 6])).toBe('slides 4–6');
    expect(slideList([9])).toBe('slide 9');
    expect(slideList([6, 4, 5, 9])).toBe('slides 4–6, 9');
    expect(slideList([])).toBeNull();
  });
});

describe('describeAction', () => {
  it('describes each action in plain words', () => {
    const amount = { units: '500000000000000000000000', unit: 'yoctoNEAR', network: 'offline-replay' };
    expect(describeAction('payment.near', { payee: 'ledger-payee.northwind.near', amount }, assets, directory)).toBe('Pay 0.5 NEAR to ledger-payee.northwind.near');
    expect(describeAction('payment.near', { payee: 'ledger.testnet', amount: amount.units })).toBe('Pay 0.5 NEAR to ledger.testnet');
    expect(describeAction('payment.near', { payee: 'ledger-payee.northwind.near', amount }, assets, directory, { payees: [{ label: 'Ledger Co', account: 'ledger-payee.northwind.near' }] })).toBe('Pay 0.5 NEAR to Ledger Co');
    setPayeeLabels({ 'ledger-payee.northwind.near': 'Ledger Co' });
    expect(describeAction('payment.near', { payee: 'ledger-payee.northwind.near', amount }, assets, directory)).toBe('Pay 0.5 NEAR to Ledger Co');
    setPayeeLabels({});
    expect(describeAction('payment.near', { payee: 'attacker.northwind.near', amount }, assets, directory)).toBe('Pay 0.5 NEAR to attacker.northwind.near');
    expect(describeAction('payment.near', { payee: 'x.near', amount }, assets, undefined, { payees: [{ label: 'Shop', account: 'x.near' }] })).toBe('Pay 0.5 NEAR to Shop');
    expect(describeAction('asset.share', { assetId: 'asset_may_model', recipientAgentId: 'attacker.northwind.near' }, assets, directory)).toBe('Share May model.xlsx with attacker.northwind.near');
    expect(describeAction('asset.edit', { assetId: 'asset_deck', parts: [4, 5, 6] }, assets, directory)).toBe('Edit slides 4–6 of Acme_Q4_review.pptx');
    expect(describeAction('asset.edit', { assetId: 'asset_deck', parts: [9] }, assets, directory)).toBe('Edit slide 9 of Acme_Q4_review.pptx');
    expect(describeAction('asset.read', { assetId: 'asset_may_model' }, assets, directory)).toBe('Open May model.xlsx');
    expect(describeAction('message.send', { assetId: 'asset_deck', recipientAgentId: 'agent_acme' }, assets, directory)).toBe('Send Acme_Q4_review.pptx to Acme');
    expect(describeAction('calendar.hold_slot', {})).toBe('Calendar hold slot');
  });
});

describe('ruleFor', () => {
  const context = { ownerName: 'Dana', assets, directory };
  it('names the signed grant that allowed an action', () => {
    expect(ruleFor('ownerSignedGrant', 'allow', { action: 'asset.edit', target: { assetId: 'asset_deck', parts: [4, 5, 6] } }, context))
      .toEqual({ outcome: 'Allowed', rule: "Allowed by Dana's signed grant: Edit slides 4–6 of Acme_Q4_review.pptx." });
  });
  it('explains approval, off and missing grants', () => {
    expect(ruleFor('ownerSignedApprovalRequired', 'needsHuman', null, context)).toEqual({ outcome: 'Needs Dana', rule: "Dana's signed policy says to ask her first." });
    expect(ruleFor('ownerSignedGrantDenied', 'deny', null, context)).toEqual({ outcome: 'Denied', rule: "Dana's signed policy turns this off." });
    expect(ruleFor('ownerSignedGrantMissing', 'deny', null, context)).toEqual({ outcome: 'Denied', rule: "No signed grant covers this. Everything Dana didn't list is off." });
  });
  it('falls back to the owner when no name is known', () => {
    expect(ruleFor('ownerSignedGrantMissing', 'deny').rule).toBe("No signed grant covers this. Everything the owner didn't list is off.");
  });
  it('handles spending contract refusals generically', () => {
    expect(ruleFor('payee_not_allowed', 'deny', null, context)).toEqual({ outcome: 'Refused by contract', rule: "The spending contract only pays payees on Dana's signed list." });
    expect(ruleFor('over_per_payment_limit', 'deny', null, context).rule).toBe('Over the per-payment limit.');
    expect(ruleFor('over_max', 'deny', null, context).rule).toBe('Over the per-payment limit.');
    expect(ruleFor('dailyCapExceeded', 'deny', null, context).rule).toBe('Over the daily limit.');
    expect(ruleFor('somethingNew', 'deny', null, context).rule).toBe('Something New.');
  });
});

describe('sourceLabel', () => {
  it('labels where data came from', () => {
    expect(sourceLabel('offline-replay')).toBe('Offline replay');
    expect(sourceLabel('near-testnet')).toBe('NEAR testnet');
    expect(sourceLabel('near-mainnet', 'Signed by Envoi')).toBe('Signed by Envoi');
  });
});
