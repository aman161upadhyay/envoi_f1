import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CaseRow, CaseWorkspace } from '../src/App';
import type { CaseEvent, HumanView, WorkCase } from '../src/types';

const members = ['alice', 'bob', 'charlie'].map(agentId => ({ agentId, address: `${agentId}@agents.envoi-agents.com` }));
const view = { inbox: { id: 'inbox_alice', ownerAgentId: 'alice' }, agents: [], messages: [], assets: [] } as unknown as HumanView;

function message(id: string, author: string, text: string, fields: CaseEvent['payload'] = {}): CaseEvent {
  return {
    id: `event_${id}`, type: 'message', actor: author, createdAt: '2026-11-06T12:00:00Z',
    payload: { messageId: id, senderAgentId: author, text, ...fields },
    linkedPolicyEvaluation: null, precedingEventRef: null
  };
}

const events = [
  message('first', 'alice', 'Please check the release', { assigneeAgentIds: ['bob', 'charlie'] }),
  message('second', 'bob', 'The release looks good', { inReplyTo: 'first' })
];
const workCase: WorkCase = {
  id: 'case_group', caseMode: 'group', schemaVersion: '1.0', state: 'inProgress',
  objective: 'Review the release', createdAt: '2026-11-06T12:00:00Z',
  actingAgent: 'alice', participants: members.map(member => member.agentId), members,
  assignments: [
    { messageId: 'first', agentId: 'bob', status: 'completed' },
    { messageId: 'first', agentId: 'charlie', status: 'queued' }
  ],
  timeline: events.map(event => ({
    id: event.id, type: event.type, actorId: event.actor, createdAt: event.createdAt,
    summary: event.payload.text, policyEvaluationId: null, payload: event.payload
  }))
};

describe('group case view', () => {
  it('labels the conversation as a group in the case list', () => {
    const markup = renderToStaticMarkup(createElement(CaseRow, { workCase, view, showOwner: false, selected: true, onSelect() {} }));
    expect(markup).toContain('Group · 3 agents');
  });

  it('shows one roster, links a reply to its source, and shows each assignment separately', () => {
    const markup = renderToStaticMarkup(createElement(CaseWorkspace, {
      workCase, view, canManageInbox: true, railOpen: false,
      onRailToggle() {}, onBack() {}, async onRefresh() {}, async onPreferencesChanged() {}, notify() {}
    }));
    expect(markup).toContain('aria-label="Group members"');
    for (const member of members) expect(markup).toContain(member.address);
    expect(markup).toContain('id="message-first"');
    expect(markup).toContain('<strong>bob@agents.envoi-agents.com</strong>');
    expect(markup).toContain('href="#message-first">Reply to alice@agents.envoi-agents.com');
    expect(markup).toContain('Assigned to bob@agents.envoi-agents.com · Completed');
    expect(markup).toContain('Assigned to charlie@agents.envoi-agents.com · Queued');
  });
});
