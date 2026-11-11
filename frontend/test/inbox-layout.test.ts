import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { AppShell, ConversationEntry } from '../src/App';
import type { CaseEvent, HumanView, Inbox, WorkCase } from '../src/types';

it('starts in a full-width inbox without selecting a conversation and uses actual read state', () => {
  const workspace = { id: 'inbox_layout', organizationId: 'org_layout', name: 'My inbox', ownerHumanId: 'human_layout', ownerAgentId: null, status: 'active', createdAt: '2026-10-06T12:00:00Z' } as Inbox;
  const preference = { folderId: null, archived: false, read: false, readThrough: null, revision: 'a'.repeat(64) };
  const unread = { id: 'case_unread', objective: 'Unread subject', state: 'inProgress', createdAt: workspace.createdAt, inboxPreference: preference } as WorkCase;
  const read = { ...unread, id: 'case_read', objective: 'Read subject', needsAttention: true, inboxPreference: { ...preference, read: true } } as WorkCase;
  const archived = { ...unread, id: 'case_archived', objective: 'Archived subject', inboxPreference: { ...preference, archived: true } };
  const view = { inbox: workspace, canManageInbox: true, mode: 'human-observer', agents: [], caseQueue: [unread, read, archived], cases: [], messages: [], assets: [], folders: [], participantDirectory: {}, invitations: [], recentEvents: [], deliveryReceipts: [], calendarConnectors: [], calendarProviders: {}, summary: { agents: 0, cases: 3, messages: 0, assets: 0, needsMe: 1 }, navigation: { needsMe: 1, activeWork: 2, waiting: 0, completed: 0 }, capabilities: [] } as HumanView;
  const markup = renderToStaticMarkup(createElement(AppShell, {
    config: { provider: 'local', hosted: false }, human: { id: 'human_layout', displayName: 'Human' }, organizations: [], workspaces: [workspace], workspace, view,
    onSelectWorkspace: vi.fn(), onRefresh: vi.fn(), onLogout: vi.fn(), syncNotice: ''
  }));
  expect(markup).toContain('inbox-list-view');
  expect(markup).not.toContain('envoi-thread');
  expect(markup).not.toContain('aria-selected="true"');
  expect(markup).toContain('Unread subject');
  expect(markup).toContain('Read subject');
  expect(markup).not.toContain('Archived subject');
  expect(markup.match(/inbox-message-row[^"<]*is-unread/g)).toHaveLength(1);
  expect(markup).toContain('case-preview');
  expect(markup).toContain('case-row-meta');
  expect(markup).toContain('Create folder');
  expect(markup).toContain('Sign out');
});

it('keeps both agent inboxes in navigation before their views load', () => {
  const root = { id: 'root_inbox', organizationId: 'org_layout', name: 'My inbox', ownerHumanId: 'human_layout', ownerAgentId: null, status: 'active', createdAt: '2026-10-06T12:00:00Z' } as Inbox;
  const first = { ...root, id: 'first_inbox', name: 'Atlas inbox', kind: 'agent', parentInboxId: root.id, ownerAgentId: 'agent_atlas', ownerHumanId: null } as Inbox;
  const second = { ...root, id: 'second_inbox', name: 'Beacon inbox', kind: 'agent', parentInboxId: root.id, ownerAgentId: 'agent_beacon', ownerHumanId: null } as Inbox;
  const view = { inbox: root, canManageInbox: true, mode: 'human-observer', agents: [], caseQueue: [], cases: [], messages: [], assets: [], folders: [], participantDirectory: {}, invitations: [], recentEvents: [], deliveryReceipts: [], calendarConnectors: [], calendarProviders: {}, summary: { agents: 0, cases: 0, messages: 0, assets: 0, needsMe: 0 }, navigation: { needsMe: 0, activeWork: 0, waiting: 0, completed: 0 }, capabilities: [] } as HumanView;
  const markup = renderToStaticMarkup(createElement(AppShell, {
    config: { provider: 'local', hosted: false }, human: { id: 'human_layout', displayName: 'Human' }, organizations: [], workspaces: [root, first, second], workspace: root, view,
    onSelectWorkspace: vi.fn(), onRefresh: vi.fn(), onLogout: vi.fn(), syncNotice: ''
  }));
  expect(markup).toContain('Atlas');
  expect(markup).toContain('Beacon');
  expect(markup).toContain('Expand Atlas');
  expect(markup).toContain('Expand Beacon');
  expect(markup.match(/Expand Atlas/g)).toHaveLength(1);
  expect(markup.match(/Expand Beacon/g)).toHaveLength(1);
});

it('shows previously loaded agent conversations when Done remounts after a workspace switch', () => {
  const createdAt = '2026-11-05T12:00:00Z';
  const root = { id: 'root_cached', organizationId: 'org_layout', name: 'My inbox', ownerHumanId: 'human_layout', ownerAgentId: null, status: 'active', createdAt } as Inbox;
  const agentInbox = { ...root, id: 'agent_cached', name: 'Delta inbox', kind: 'agent', parentInboxId: root.id, ownerAgentId: 'agent_delta', ownerHumanId: null } as Inbox;
  const archived = { id: 'case_cached_done', objective: 'Archived agent conversation', state: 'inProgress', createdAt, inboxPreference: { folderId: null, archived: true, read: true, readThrough: null, revision: 'a'.repeat(64) } } as WorkCase;
  const rootView = { inbox: root, canManageInbox: true, mode: 'human-observer', agents: [], caseQueue: [], cases: [], messages: [], assets: [], folders: [], participantDirectory: {}, invitations: [], recentEvents: [], deliveryReceipts: [], calendarConnectors: [], calendarProviders: {}, summary: { agents: 0, cases: 0, messages: 0, assets: 0, needsMe: 0 }, navigation: { needsMe: 0, activeWork: 0, waiting: 0, completed: 0 }, capabilities: [] } as HumanView;
  const agentView = { ...rootView, inbox: agentInbox, caseQueue: [archived], cases: [archived] } as HumanView;
  const pending = renderToStaticMarkup(createElement(AppShell, {
    config: { provider: 'local', hosted: false }, human: { id: 'human_layout', displayName: 'Human' }, organizations: [], workspaces: [root, agentInbox], workspace: root, view: rootView,
    initialSection: 'completed', onSelectWorkspace: vi.fn(), onRefresh: vi.fn(), onLogout: vi.fn(), syncNotice: ''
  }));
  expect(pending).toContain('Loading agent conversations');
  expect(pending).not.toContain('No conversations yet');
  const markup = renderToStaticMarkup(createElement(AppShell, {
    config: { provider: 'local', hosted: false }, human: { id: 'human_layout', displayName: 'Human' }, organizations: [], workspaces: [root, agentInbox], workspace: root, view: rootView,
    initialSection: 'completed', initialChildViews: { [agentInbox.id]: agentView }, onSelectWorkspace: vi.fn(), onRefresh: vi.fn(), onLogout: vi.fn(), syncNotice: ''
  }));
  expect(markup).toContain('Archived agent conversation');
  expect(markup).not.toContain('No conversations yet');
});

it('does not label another human’s instruction as You', () => {
  const event = { id: 'evt_instruction', type: 'message', actor: 'human_sender', createdAt: '2026-10-06T12:00:00Z', payload: { senderHumanId: 'human_sender', messageType: 'instruction', text: 'Check the latest draft', deliveryState: 'delivered' }, linkedPolicyEvaluation: null, precedingEventRef: null } as CaseEvent;
  const workCase = { id: 'case_instruction', principal: 'human_sender', actingAgent: 'agent_owned' } as WorkCase;
  const view = { agents: [], requester: { id: 'human_observer', auth: { provider: 'local', assurance: 'totp' } }, participantDirectory: { human_sender: { id: 'human_sender', type: 'human', displayName: 'Alice', accessState: 'active' } } } as HumanView;
  expect(renderToStaticMarkup(createElement(ConversationEntry, { event, workCase, view }))).toContain('Alice');
  expect(renderToStaticMarkup(createElement(ConversationEntry, { event, workCase, view }))).not.toContain('>You<');
  const ownerMarkup = renderToStaticMarkup(createElement(ConversationEntry, { event: { ...event, summary: 'Human instruction' }, workCase, view: { ...view, requester: { ...view.requester!, id: 'human_sender' } } }));
  expect(ownerMarkup).toContain('>You<');
  expect(ownerMarkup).toContain('conversation-message mine owner-instruction');
  expect(ownerMarkup).toContain('>Owner instruction<');
  expect(ownerMarkup).toContain('Check the latest draft');
  expect(ownerMarkup).not.toContain('class="message-bubble">Human instruction');
});

it('honors initial Done on a fresh shell mount without selecting a case or relying on task completion', () => {
  const createdAt = new Date().toISOString();
  const workspace: Inbox = { id: 'inbox_done_layout', organizationId: 'org_layout', name: 'My inbox', ownerHumanId: 'human_layout', ownerAgentId: null, status: 'active', createdAt };
  const preference = { folderId: null, archived: false, read: false, readThrough: null, revision: 'a'.repeat(64) };
  const completed: WorkCase = { id: 'case_completed_main', objective: 'Completed but still in main', state: 'completed', createdAt, inboxPreference: preference };
  const archived: WorkCase = { id: 'case_archived_working', objective: 'Archived ongoing conversation', state: 'inProgress', createdAt, inboxPreference: { ...preference, archived: true } };
  const view = {
    inbox: workspace, canManageInbox: true, mode: 'human-observer', agents: [],
    caseQueue: [completed, archived], cases: [completed, archived], messages: [], assets: [], folders: [],
    participantDirectory: {}, invitations: [], recentEvents: [], deliveryReceipts: [], calendarConnectors: [],
    calendarProviders: {}, summary: { agents: 0, cases: 2, messages: 0, assets: 0, needsMe: 0 },
    navigation: { needsMe: 0, activeWork: 1, waiting: 0, completed: 1 }, capabilities: []
  } as HumanView;
  const onSelectWorkspace = vi.fn();
  const onRefresh = vi.fn();
  const props = {
    config: { provider: 'local' as const, hosted: false },
    human: { id: 'human_layout', displayName: 'Human' }, organizations: [], workspaces: [workspace], workspace, view,
    onSelectWorkspace, onRefresh, onLogout: vi.fn(), syncNotice: ''
  };
  const initialMain = renderToStaticMarkup(createElement(AppShell, props));
  expect(initialMain).toContain('Completed but still in main');
  expect(initialMain).not.toContain('Archived ongoing conversation');
  const remountedDone = renderToStaticMarkup(createElement(AppShell, { ...props, initialSection: 'completed' }));
  expect(remountedDone).toContain('aria-label="Done cases"');
  expect(remountedDone).toContain('Archived ongoing conversation');
  expect(remountedDone).not.toContain('Completed but still in main');
  expect(remountedDone).toContain('inbox-list-view');
  expect(remountedDone).not.toContain('envoi-thread');
  expect(remountedDone).not.toContain('aria-selected="true"');
  expect(onSelectWorkspace).not.toHaveBeenCalled();
  expect(onRefresh).not.toHaveBeenCalled();
  expect(archived.state).toBe('inProgress');
  expect(completed.state).toBe('completed');
});

it('does not use the wide layout without a window', async () => {
  const { useWideLayout } = await import('../src/App');
  const Probe = () => createElement('i', null, String(useWideLayout()));
  expect(renderToStaticMarkup(createElement(Probe))).toBe('<i>false</i>');
});
