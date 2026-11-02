import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AgentCard, AgentPermissionPicker, CaseWorkspace, DecisionCard, EnrollmentDialog, ParticipantCard } from '../src/App';
import { DEFAULT_AGENT_PERMISSIONS, selectedAgentPermissions } from '../src/agent-permissions';
import type { Agent, HumanView, Inbox, WorkCase } from '../src/types';

describe('agent permission review', () => {
  it('defaults to messaging without file sharing or task execution', () => {
    expect(selectedAgentPermissions(DEFAULT_AGENT_PERMISSIONS)).toEqual(['receive_agent_messages', 'send_agent_messages']);
    const markup = renderToStaticMarkup(createElement(AgentPermissionPicker, { selected: DEFAULT_AGENT_PERMISSIONS, onChange: vi.fn() }));
    expect(markup).toContain('Execute tasks');
    expect(markup).toContain('Share files');
    expect(markup.match(/checked=""/g)).toHaveLength(2);
    expect(markup.match(/disabled=""/g)).toHaveLength(5);
    expect(markup).toContain('Unavailable until supported by the server');
  });

  it('includes elevated access only when explicitly selected', () => {
    expect(selectedAgentPermissions(['execute_cases'])).toEqual(['receive_agent_messages', 'execute_cases']);
    expect(selectedAgentPermissions(['create_assets', 'send_agent_messages'])).toEqual(['receive_agent_messages', 'send_agent_messages', 'create_assets']);
  });
});

describe('external runtime enrollment handoff', () => {
  it('offers all runtime choices and verified preparation before issuing the short-lived token', () => {
    const markup = renderToStaticMarkup(createElement(EnrollmentDialog, {
      workspace: { id: 'inbox_1' } as Inbox,
      result: null,
      setResult: vi.fn(),
      onClose: vi.fn()
    }));

    expect(markup).toContain('Check the runtime before enrolling');
    expect(markup).toContain('Node.js 22');
    expect(markup).toContain('normal model request');
    expect(markup).toContain('envoi-connector.mjs prepare --runtime openclaw');
    expect(markup).toContain('Hermes');
    expect(markup).toContain('Grok');
    expect(markup).toContain('Continue');
    expect(markup).not.toContain('Create one-time token');
    expect(markup).not.toContain('connect-windows.ps1');
    expect(markup).not.toContain('Raw enrollment token');
  });

  it('hands the unredeemed token to supported bridges without consuming it in the UI', () => {
    const markup = renderToStaticMarkup(createElement(EnrollmentDialog, {
      workspace: { id: 'inbox_1' } as Inbox,
      result: { enrollmentToken: 'enroll_once_secret', enrollmentUrl: '/?enroll=enroll_once_secret', expiresAt: '2026-09-28T12:00:00.000Z', agentProfile: { localPart: 'milo' } },
      setResult: vi.fn(),
      onClose: vi.fn()
    }));

    expect(markup).toContain('Raw enrollment token');
    expect(markup).toContain('milo@envoi-agents.com');
    expect(markup).toContain('Copy agent email address');
    expect(markup).toContain('enroll_once_secret');
    expect(markup).toContain('ENVOI_ENROLLMENT_TOKEN');
    expect(markup).toContain('OPENCLAW_GATEWAY_TOKEN');
    expect(markup).toContain('XAI_API_KEY');
    expect(markup).toContain('ENVOI_MCP_URL');
    expect(markup).toContain('Hermes');
    expect(markup).toContain('model provider already configured locally');
    expect(markup).toContain('incoming Envoi message');
    expect(markup).not.toContain('connect-windows.ps1');
    expect(markup).toContain('Provider secrets stay on the external host');
    expect(markup).not.toContain('/api/agent-enroll');
    expect(markup).not.toContain('agentApiToken');
    expect(markup).not.toContain('One-time enrollment URL');
    expect(markup).not.toContain('/?enroll=');
  });
});

describe('human action visibility', () => {
  const workCase = {
    id: 'case_1', objective: 'Approve the deposit', state: 'waitingForHuman',
    decision: { question: 'Approve the deposit?', availableActions: ['approveOnce', 'pause', 'takeOver'] }
  } as WorkCase;
  const view = { agents: [], participantDirectory: {}, messages: [] } as unknown as HumanView;

  function renderDecision(canManageInbox: boolean) {
    return renderToStaticMarkup(createElement(DecisionCard, {
      workCase, view, events: [], canManageInbox, busy: null, onAction: vi.fn(), onPolicy: vi.fn()
    }));
  }

  it('shows decisions for observation without exposing mutation controls', () => {
    const markup = renderDecision(false);
    expect(markup).toContain('Workspace administrator review');
    expect(markup).toContain('Approve the deposit?');
    expect(markup).not.toContain('class="decision-actions"');
  });

  it('shows decision actions to authorized workspace managers', () => {
    const markup = renderDecision(true);
    expect(markup).toContain('class="decision-actions"');
    expect(markup).toContain('Approve Once');
    expect(markup).not.toContain('Pause conversation');
    expect(markup).not.toContain('Take Over');
  });

  it('lets a linked human review their pending agent without exposing other agents', () => {
    const agent = { id: 'agent_1', name: 'Milo', address: 'milo@envoi.mail', principalHumanId: 'human_1', status: 'pending_approval', onboardingStatus: 'pending_approval', permissions: [] } as Agent;
    const workspace = { id: 'inbox_1', ownerHumanId: 'human_1' } as Inbox;
    const props = { agent, workspace, emailTransport: null, canManageInbox: false, onRefresh: vi.fn(), notify: vi.fn() };
    const linked = renderToStaticMarkup(createElement(AgentCard, { ...props, humanId: 'human_1' }));
    const unrelated = renderToStaticMarkup(createElement(AgentCard, { ...props, humanId: 'human_2' }));
    expect(linked).toContain('Review agent access');
    expect(unrelated).not.toContain('Review agent access');
  });

  it('offers credential revocation only to workspace managers, without claiming the agent is online', () => {
    const agent = { id: 'agent_1', name: 'Milo', address: 'milo@envoi.mail', principalHumanId: 'human_1', status: 'active', onboardingStatus: 'approved', permissions: ['send_agent_messages'] } as Agent;
    const workspace = { id: 'inbox_1', ownerHumanId: 'human_1' } as Inbox;
    const props = { agent, workspace, emailTransport: null, humanId: 'human_1', onRefresh: vi.fn(), notify: vi.fn() };
    const manager = renderToStaticMarkup(createElement(AgentCard, { ...props, canManageInbox: true }));
    const observer = renderToStaticMarkup(createElement(AgentCard, { ...props, canManageInbox: false }));
    expect(manager).toContain('Revoke agent access');
    expect(observer).not.toContain('Revoke agent access');
    expect(manager).toContain('Pause agent');
    expect(observer).not.toContain('Pause agent');
    expect(manager).toContain('Active · Status unknown');
    expect(manager).not.toContain('Enrolled');
    expect(manager).not.toContain('Verified and active');
    const paused = renderToStaticMarkup(createElement(AgentCard, { ...props, agent: { ...agent, status: 'paused', paused: true }, canManageInbox: true }));
    expect(paused).toContain('Resume agent');
    expect(paused).not.toContain('Pause agent');
    expect(paused).toContain('Paused');
    const frozen = renderToStaticMarkup(createElement(AgentCard, { ...props, agent: { ...agent, status: 'revoked', onboardingStatus: 'revoked', credentialRevoked: true, permissions: [] }, canManageInbox: true }));
    expect(frozen).toContain('Re-onboard agent');
    expect(frozen).toContain('No permissions active');
    expect(frozen).not.toContain('Reconnect runtime');
    expect(frozen).not.toContain('Revoke agent access');
  });

  it('shows Phase D trust controls only to the administrator of the agent inbox', () => {
    const agent = { id: 'agent_1', name: 'Milo', address: 'milo@agents.envoi-agents.com', principalHumanId: 'human_1', status: 'active', onboardingStatus: 'approved', permissions: ['send_agent_messages'] } as Agent;
    const workspace = { id: 'inbox_1', kind: 'agent', ownerAgentId: 'agent_1', ownerHumanId: 'human_1' } as Inbox;
    const props = { agent, workspace, emailTransport: null, humanId: 'human_1', onRefresh: vi.fn(), notify: vi.fn() };
    const manager = renderToStaticMarkup(createElement(AgentCard, { ...props, canManageInbox: true }));
    const observer = renderToStaticMarkup(createElement(AgentCard, { ...props, canManageInbox: false }));
    expect(manager).toContain('Agent trust and discovery');
    expect(manager).toContain('Invitation ID to revoke');
    expect(observer).not.toContain('Agent trust and discovery');
  });

  it('shows native counterparty block state and manager-only controls', () => {
    const participant = { id: 'agent_peer', type: 'externalAgent' as const, displayName: 'Peer',
      address: 'peer@agents.envoi-agents.com', accessState: 'blocked' as const,
      relationship: 'counterpartyAgent' as const };
    const observer = renderToStaticMarkup(createElement(ParticipantCard, { participant, label: 'Counterparty' }));
    const manager = renderToStaticMarkup(createElement(ParticipantCard, { participant, label: 'Counterparty',
      nativeControl: { inboxId: 'inbox_one', onRefresh: vi.fn(), notify: vi.fn() } }));
    expect(observer).toContain('Blocked');
    expect(observer).not.toContain('Unblock agent');
    expect(manager).toContain('Unblock agent');
  });

  it('renders case pause, resume, and revoke controls only from authoritative state for managers', () => {
    const baseCase = {
      id: 'case_controls', schemaVersion: '1.0', objective: 'Coordinate launch details', state: 'inProgress',
      principal: 'human_1', actingAgent: 'agent_1', participants: ['agent_1', 'agent_2'], constraints: {}, authorityRefs: [],
      events: [], evidence: [], proposals: [], policyEvaluations: [], receipt: null,
      createdAt: '2026-09-29T10:00:00Z', updatedAt: '2026-09-29T11:00:00Z'
    } as WorkCase;
    const controlView = {
      inbox: { id: 'inbox_1' }, messages: [], assets: [], deliveryReceipts: [], agents: [],
      participantDirectory: {
        agent_1: { id: 'agent_1', type: 'internalAgent', displayName: 'My agent', accessState: 'active' },
        agent_2: { id: 'agent_2', type: 'externalAgent', displayName: 'Peer agent', accessState: 'active' }
      }
    } as unknown as HumanView;
    const props = { view: controlView, railOpen: false, onRailToggle: vi.fn(), onBack: vi.fn(), onRefresh: vi.fn(), notify: vi.fn() };
    const observer = renderToStaticMarkup(createElement(CaseWorkspace, { ...props, workCase: baseCase, canManageInbox: false }));
    const manager = renderToStaticMarkup(createElement(CaseWorkspace, { ...props, workCase: baseCase, canManageInbox: true }));
    const paused = renderToStaticMarkup(createElement(CaseWorkspace, { ...props, workCase: { ...baseCase, state: 'paused' }, canManageInbox: true }));
    const completed = renderToStaticMarkup(createElement(CaseWorkspace, { ...props, workCase: { ...baseCase, state: 'completed' }, canManageInbox: true }));

    expect(observer).not.toContain('Pause conversation');
    expect(observer).not.toContain('Revoke case authority');
    expect(manager).toContain('Pause conversation');
    expect(manager).toContain('More case actions');
    expect(paused).toContain('Resume conversation');
    expect(paused).not.toContain('Pause conversation');
    expect(completed).not.toContain('Pause conversation');
    expect(completed).not.toContain('Revoke case authority');
  });
});
