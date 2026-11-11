import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { canonicalDecisionPolicy, canSubmitCaseDecision, caseActionPayload } from '../src/case-decisions';
import { DecisionCard, previewView } from '../src/App';
import type { WorkCase } from '../src/types';

const now = Date.parse('2026-10-17T12:00:00Z');
const workCase = (): WorkCase => ({
  id: 'case_current', schemaVersion: '1.0', state: 'inProgress', createdAt: '2026-10-17T11:00:00Z',
  decision: { question: 'Approve this agreement?', policyEvaluationId: 'policy_current', requestedAction: 'proposal.accept', grantType: 'oneTime', expiresAt: '2026-10-18T12:00:00Z', availableActions: ['approveOnce', 'decline'] }
});

describe('canonical owner case decisions', () => {
  it.each(['approveOnce', 'decline'] as const)('submits only the bound evaluation for %s without changing shared case state', action => {
    const current = workCase();
    expect(canSubmitCaseDecision(current, action, now)).toBe(true);
    expect(caseActionPayload(current, action, now)).toEqual({ policyEvaluationId: 'policy_current' });
    expect(current.state).toBe('inProgress');
  });

  it.each(['pause', 'resume', 'revoke', 'takeOver', 'editProposal'] as const)('does not attach an unrelated approval to %s', action => {
    expect(caseActionPayload(workCase(), action, now)).toEqual({});
  });

  it.each(['expired', 'malformed-expiry', 'missing-evaluation', 'not-offered', 'no-decision', 'no-schema', 'closed'])('refuses %s before any owner action can be submitted', fault => {
    const current = workCase();
    if (fault === 'expired') current.decision!.expiresAt = new Date(now).toISOString();
    if (fault === 'malformed-expiry') current.decision!.expiresAt = 'not-a-date';
    if (fault === 'missing-evaluation') current.decision!.policyEvaluationId = null;
    if (fault === 'not-offered') current.decision!.availableActions = [];
    if (fault === 'no-decision') current.decision = null;
    if (fault === 'no-schema') delete current.schemaVersion;
    if (fault === 'closed') current.state = 'completed';
    expect(canSubmitCaseDecision(current, 'approveOnce', now)).toBe(false);
    expect(() => caseActionPayload(current, 'approveOnce', now)).toThrow('no longer available');
  });

  it('does not select another policy when the canonical evaluation is missing from the loaded page', () => {
    const current = workCase();
    const stale = { id: 'policy_old', decision: 'needsHuman' } as NonNullable<WorkCase['policyEvaluations']>[number];
    current.policyEvaluations = [stale];
    expect(canonicalDecisionPolicy(current)).toBeUndefined();
    expect(caseActionPayload(current, 'approveOnce', now)).toEqual({ policyEvaluationId: 'policy_current' });
    current.policyEvaluations.push({ ...stale, id: 'policy_current' });
    expect(canonicalDecisionPolicy(current)?.id).toBe('policy_current');
  });

  it('leaves external execution and bound result text out of approval requests', () => {
    const current = workCase();
    current.decision!.requestedAction = 'case.complete';
    expect(Object.keys(caseActionPayload(current, 'approveOnce', now))).toEqual(['policyEvaluationId']);
  });

  it.each([true, false])('renders approval controls from the canonical pending decision: %s', pending => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const current = workCase();
      if (!pending) current.decision!.policyEvaluationId = null;
      const html = renderToStaticMarkup(createElement(DecisionCard, { workCase: current, view: previewView, events: [], canManageInbox: true, busy: null, onAction: () => {}, onPolicy: () => {} }));
      expect(html).toContain('Approve this agreement?');
      expect(/<button[^>]*disabled=""[^>]*>Approve Once<\/button>/.test(html)).toBe(!pending);
      expect(/<button[^>]*disabled=""[^>]*>Decline<\/button>/.test(html)).toBe(!pending);
    } finally { clock.mockRestore(); }
  });

  it('requires signed review when the pending evaluation is outside the loaded history', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const current = workCase();
      current.decision!.signedApprovalRequired = true;
      const html = renderToStaticMarkup(createElement(DecisionCard, { workCase: current, view: previewView, events: [], canManageInbox: true, busy: null, onAction: () => {}, onPolicy: () => {} }));
      expect(html).toContain('>Review and sign</button>');
      expect(html).not.toContain('>Approve Once</button>');
    } finally { clock.mockRestore(); }
  });
});
