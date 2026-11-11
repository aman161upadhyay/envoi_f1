import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ConversationEntry } from '../src/App';
import type { CaseEvent, HumanView, WorkCase } from '../src/types';

const workCase = { id: 'case_rows', principal: 'human_owner', actingAgent: 'agent_mine' } as WorkCase;
const view = {
  inbox: { ownerAgentId: 'agent_mine' },
  messages: [],
  agents: [{ id: 'agent_mine', displayName: 'Milo' }],
  requester: { id: 'human_owner', auth: { provider: 'local', assurance: 'totp' } },
  participantDirectory: {
    agent_mine: { id: 'agent_mine', type: 'localAgent', displayName: 'Milo', accessState: 'active' },
    agent_other: { id: 'agent_other', type: 'externalAgent', displayName: 'Ledger Co billing agent', accessState: 'active' }
  }
} as unknown as HumanView;

function message(id: string, sender: string, createdAt: string, extra: Record<string, unknown> = {}) {
  return { id, type: 'message', actor: sender, createdAt, payload: { senderAgentId: sender, messageType: 'counteroffer', text: 'Hello there', deliveryState: 'delivered', ...extra }, linkedPolicyEvaluation: null, precedingEventRef: null } as unknown as CaseEvent;
}
const render = (event: CaseEvent, previous?: CaseEvent) => renderToStaticMarkup(createElement(ConversationEntry, { event, previous, workCase, view }));

it('groups consecutive messages from one sender within ten minutes', () => {
  const first = message('e1', 'agent_other', '2026-10-06T12:00:00Z');
  expect(render(message('e2', 'agent_other', '2026-10-06T12:02:00Z'), first)).toContain('conversation-message theirs continued');
  expect(render(message('e3', 'agent_other', '2026-10-06T12:20:00Z'), first)).not.toContain('continued');
});

it('labels the own agent and omits the role chip for owner instructions', () => {
  const own = render(message('e4', 'agent_mine', '2026-10-06T12:00:00Z'));
  expect(own).toContain('meta-role');
  expect(own).toContain('>Your agent<');
  const instruction = render({ ...message('e5', 'human_owner', '2026-10-06T12:00:00Z'), payload: { senderHumanId: 'human_owner', messageType: 'instruction', text: 'Pay it', deliveryState: 'delivered' } } as unknown as CaseEvent);
  expect(instruction).not.toContain('meta-role');
  expect(instruction).toContain('>Owner instruction<');
});
