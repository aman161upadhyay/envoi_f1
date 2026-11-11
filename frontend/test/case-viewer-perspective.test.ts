import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CaseRow, CaseWorkspace, ConversationEntry, ExchangeLedgerEvent, previewView } from '../src/App';
import { caseSourceView, exchangeParties, localAgentId, resolveParticipant } from '../src/model';
import type { Agent, CaseEvent, HumanView, WorkCase } from '../src/types';

const createdAt = '2026-10-15T12:00:00Z';
const agents: Agent[] = [
  { id: 'agent_je', name: 'Je', address: 'je@example.test', principalHumanId: 'human_sender', status: 'active', onboardingStatus: 'approved', permissions: ['send_agent_messages', 'receive_agent_messages'] },
  { id: 'agent_rachel', name: 'Rachel probe', address: 'probe@example.test', principalHumanId: 'human_recipient', status: 'active', onboardingStatus: 'approved', permissions: ['receive_agent_messages'] }
];
const events: CaseEvent[] = [
  { id: 'send1', type: 'message', actor: 'agent_je', createdAt, payload: { senderAgentId: 'agent_je', recipientAgentId: 'agent_rachel', text: 'Send1', deliveryState: 'delivered' }, linkedPolicyEvaluation: null, precedingEventRef: null },
  { id: 'reply1', type: 'message', actor: 'agent_rachel', createdAt, payload: { senderAgentId: 'agent_rachel', recipientAgentId: 'agent_je', text: 'Reply1', deliveryState: 'processed' }, linkedPolicyEvaluation: null, precedingEventRef: null }
];
const workCase: WorkCase = {
  id: 'case_shared', schemaVersion: '1.0', objective: 'Shared case', state: 'inProgress', principal: 'human_sender',
  actingAgent: 'agent_je', participants: ['agent_je', 'agent_rachel'], events, proposals: [], policyEvaluations: [], evidence: [], createdAt
};

function source(ownerAgentId: string | null): HumanView {
  const sender = ownerAgentId === 'agent_je';
  return {
    inbox: { id: sender ? 'inbox_sender' : 'inbox_recipient', organizationId: sender ? 'org_sender' : 'org_recipient', name: 'Agent inbox', ownerAgentId, ownerHumanId: sender ? 'human_sender' : 'human_recipient', status: 'active', createdAt },
    requester: { id: sender ? 'human_sender' : 'human_recipient', auth: { provider: 'local', assurance: 'totp' } },
    mode: 'human-observer', canManageInbox: true, capabilities: [], summary: { agents: 1, cases: 1, messages: 2, assets: 0, needsMe: 0 }, navigation: { needsMe: 0, activeWork: 1, waiting: 0, completed: 0 },
    agents: agents.filter(agent => agent.id === ownerAgentId),
    participantDirectory: Object.fromEntries(agents.map(agent => [agent.id, { id: agent.id, type: agent.id === ownerAgentId ? 'internalAgent' : 'externalAgent', displayName: agent.name, address: agent.address, orgRef: agent.id === 'agent_je' ? 'Sender organization' : 'Recipient organization', accessState: 'active' }])),
    caseQueue: [workCase], cases: [workCase], messages: [], assets: [], invitations: [], deliveryReceipts: [], recentEvents: [], calendarConnectors: [], calendarProviders: { google: { id: 'google', label: 'Google', configured: false }, outlook: { id: 'outlook', label: 'Outlook', configured: false } }
  } as HumanView;
}

function thread(view: HumanView, item = workCase) {
  return renderToStaticMarkup(createElement(CaseWorkspace, { workCase: item, view, canManageInbox: true, railOpen: true, onRailToggle: vi.fn(), onBack: vi.fn(), onRefresh: vi.fn(), onPreferencesChanged: vi.fn(), notify: vi.fn() }));
}

function row(view: HumanView, item = workCase) {
  return renderToStaticMarkup(createElement(CaseRow, { workCase: item, view, showOwner: true, selected: false, onSelect: vi.fn() }));
}

describe('case inbox perspective', () => {
  it('shows the synthesized subject in both the inbox and open conversation', () => {
    const item: WorkCase = { ...workCase, objective: 'Hi', events: [
      { ...events[0], payload: { ...events[0].payload, text: 'Hi Je. Could you please review the client deck before Thursday?' } },
      events[1]
    ] };
    const view = source('agent_je');
    expect(row(view, item)).toContain('<strong>Review the client deck before Thursday</strong>');
    expect(thread(view, item)).toContain('<h1 class="thread-subject">Review the client deck before Thursday</h1>');
  });

  it.each([
    ['agent_je', 'Je', 'Rachel probe', 'Recipient organization', 'mine', 'theirs', 'outbound'],
    ['agent_rachel', 'Rachel probe', 'Je', 'Sender organization', 'theirs', 'mine', 'inbound']
  ])('renders the same case for %s', (ownerId, localName, otherName, otherOrg, firstSide, replySide, direction) => {
    const view = source(ownerId);
    const markup = thread(view);
    expect(markup).toContain(`<small>Your agent</small><strong>${localName}</strong>`);
    expect(markup).toContain(`<small>Agent for ${otherOrg}</small><strong>${otherName}</strong>`);
    expect(markup).toContain(`aria-label="Instructions for ${localName}"`);
    expect(markup).toContain(`<h2>${localName} can</h2>`);
    expect(markup).not.toContain(`<h2>${otherName} can</h2>`);
    expect(markup).not.toMatch(/Pause agent|Reconnect runtime|Revoke agent access|Remove agent/);
    expect(markup.match(/<textarea[^>]*aria-label="Instructions[^>]+>/)?.[0]).not.toContain('disabled');
    expect(row(view)).toContain(`<span class="thread-sender">${otherName}</span>`);
    expect(row(view)).toContain(`title="${localName}"`);
    for (const [event, side] of [[events[0], firstSide], [events[1], replySide]] as const) {
      const message = renderToStaticMarkup(createElement(ConversationEntry, { event, view, workCase }));
      expect(message).toContain(`conversation-message ${side}`);
      expect(message.includes('message-delivery')).toBe(side === 'mine');
    }
    const ledger = renderToStaticMarkup(createElement(ExchangeLedgerEvent, { event: events[0], view, workCase }));
    expect(ledger).toContain(`direction-${direction}`);
    expect(resolveParticipant(workCase, ownerId, view.agents, view.participantDirectory, localAgentId(workCase, view))).toMatchObject({ relationship: 'localAgent', type: 'internalAgent' });
    expect(workCase.actingAgent).toBe('agent_je');
    expect(workCase.principal).toBe('human_sender');
  });

  it('uses each aggregate row source, even when both copies have the same case id', () => {
    const sender = source('agent_je');
    const recipientCase = { ...workCase };
    const recipient = { ...source('agent_rachel'), caseQueue: [recipientCase] };
    const aggregate = { ...sender, inbox: { ...sender.inbox, ownerAgentId: null }, agents, sourceViews: [sender, recipient], caseQueue: [workCase, recipientCase] };
    expect(caseSourceView(workCase, aggregate)).toBe(sender);
    expect(caseSourceView(recipientCase, aggregate)).toBe(recipient);
    expect(row(aggregate, workCase)).toContain('<span class="thread-sender">Rachel probe</span>');
    expect(row(aggregate, recipientCase)).toContain('<span class="thread-sender">Je</span>');
    expect(thread(aggregate, recipientCase)).toContain('aria-label="Instructions for Rachel probe"');
    expect(localAgentId({ ...workCase }, aggregate)).toBeUndefined();
    expect(localAgentId({ ...workCase, id: 'case_not_in_sources' }, aggregate)).toBeUndefined();
    expect(caseSourceView({ ...workCase }, { ...aggregate, sourceViews: [recipient] })).toBe(recipient);
  });

  it.each(['missing', 'ambiguous', 'unrelated'] as const)('fails safely with %s local identity', kind => {
    let view = { ...source(null), agents };
    if (kind === 'ambiguous') view = { ...view, sourceViews: [source('agent_je'), source('agent_rachel')] };
    if (kind === 'unrelated') view = { ...view, inbox: { ...view.inbox, ownerAgentId: 'agent_unrelated' } };
    expect(localAgentId(workCase, view)).toBeUndefined();
    const markup = thread(view);
    expect(markup).toContain('Local identity unavailable');
    expect(markup).not.toContain('<small>Your agent</small>');
    expect(markup).not.toContain('participant-card mine');
    expect(markup).not.toContain('Block agent');
    expect(markup).toContain('Local permissions unavailable');
    expect(markup.match(/<textarea[^>]*aria-label="Instructions unavailable[^>]+>/)?.[0]).toContain('disabled');
    const message = renderToStaticMarkup(createElement(ConversationEntry, { event: events[0], view, workCase }));
    expect(message).toContain('conversation-message theirs');
    expect(message).not.toContain('message-delivery');
    expect(exchangeParties(workCase, events[0], agents, view.participantDirectory).direction).toBe('betweenParties');
    expect(resolveParticipant(workCase, 'agent_je', agents).relationship).toBe('counterpartyAgent');
  });

  it('keeps unavailable counterparty identity explicit without adopting it as local', () => {
    const view = { ...source('agent_rachel'), participantDirectory: {} };
    const markup = thread(view);
    expect(markup).toContain('<small>Your agent</small><strong>Rachel probe</strong>');
    expect(markup).toContain('Agent je');
    expect(markup).toContain('Address unavailable');
    expect(resolveParticipant(workCase, 'agent_je', view.agents, {}, localAgentId(workCase, view))).toMatchObject({ relationship: 'unknown', accessState: 'unavailable' });
  });

  it('does not substitute the initiator when local agent metadata is unavailable', () => {
    const view = { ...source('agent_rachel'), agents: [agents[0]], participantDirectory: {} };
    const markup = thread(view);
    expect(markup).not.toContain('<small>Your agent</small><strong>Je</strong>');
    expect(markup).toContain('Local permissions unavailable');
    expect(markup).not.toContain('<h2>Je can</h2>');
    expect(markup.match(/<textarea[^>]*aria-label="Instructions[^>]+>/)?.[0]).toContain('disabled');
  });

  it('preserves canonical recipient inference while changing viewer-relative direction', () => {
    const event = { ...events[0], payload: { text: 'Actor-only legacy message' } };
    const sender = source('agent_je');
    const recipient = source('agent_rachel');
    for (const [view, direction] of [[sender, 'outbound'], [recipient, 'inbound']] as const) {
      const exchange = exchangeParties(workCase, event, view.agents, view.participantDirectory, localAgentId(workCase, view));
      expect(exchange).toMatchObject({ sender: { id: 'agent_je' }, recipient: { id: 'agent_rachel' }, direction });
      const markup = renderToStaticMarkup(createElement(ConversationEntry, { event, view, workCase }));
      expect(markup).toContain(`conversation-message ${direction === 'outbound' ? 'mine' : 'theirs'}`);
    }
  });

  it('preserves requester-relative human instructions for both viewers', () => {
    const event = { ...events[0], actor: 'human_sender', payload: { senderHumanId: 'human_sender', messageType: 'instruction', text: 'Please check' } };
    const sender = renderToStaticMarkup(createElement(ConversationEntry, { event, workCase, view: source('agent_je') }));
    const recipient = renderToStaticMarkup(createElement(ConversationEntry, { event, workCase, view: source('agent_rachel') }));
    expect(sender).toContain('conversation-message mine');
    expect(sender).toContain('>You<');
    expect(recipient).toContain('conversation-message theirs');
    expect(recipient).not.toContain('>You<');
  });

  it('preserves the existing Milo preview perspective', () => {
    const item = previewView.caseQueue[0];
    const markup = thread(previewView, item);
    expect(markup).toContain('<small>Your agent</small><strong>Milo</strong>');
    expect(markup).toContain('Luma Events agent');
    expect(markup).toContain('aria-label="Instructions for Milo"');
    expect(markup).toContain('<h2>Milo can</h2>');
    expect(markup).toContain('conversation-message mine');
    expect(markup).toContain('conversation-message theirs');
  });
});
