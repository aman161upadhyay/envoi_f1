import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contractRegistry, loadContractFixture } from '../../integrations/contract-fixtures/setup';
import { AgentCard, CaseWorkspace } from '../src/App';
import { connectionLabel, presenceAge } from '../src/agent-presence';
import { api, request } from '../src/api';
import type { Agent, HumanView, Inbox, WorkCase } from '../src/types';

interface OwnerFixture {
  id: string;
  request: { method: string; path: string };
  response: { status: number; body: Agent | Agent[] };
  client: { surface: string; agentLabel: string; connectionLabel: string };
}

const contract = contractRegistry.contracts.find(item => item.id === 'a5-presence')!;
const fixtures = contract.fixtures.map(filename => loadContractFixture(contract, filename) as OwnerFixture)
  .filter(fixture => fixture.client.surface === 'owner_ui');
const fixtureAgent = (id: string) => {
  const body = fixtures.find(fixture => fixture.id === id)!.response.body;
  return Array.isArray(body) ? body[0] : body;
};
const workspace: Inbox = {
  id: 'inbox_example', organizationId: 'org_example', name: 'Example inbox',
  ownerAgentId: 'agent_example', ownerHumanId: 'human_example', status: 'active', createdAt: '2026-10-01T09:00:00.000Z'
};
function renderCard(agent: Agent, canManageInbox = true) {
  return renderToStaticMarkup(createElement(AgentCard, {
    agent, workspace, humanId: workspace.ownerHumanId, canManageInbox,
    emailTransport: null, onRefresh: vi.fn(), notify: vi.fn()
  }));
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('a5-presence v1 owner UI consumption', () => {
  it('loads all fourteen owner fixtures from the approved shared registry', () => {
    expect(contract).toMatchObject({ version: 1, status: 'approved', dir: 'a5-presence' });
    expect(fixtures).toHaveLength(14);
    expect(new Set(fixtures.map(fixture => fixtureAgent(fixture.id).connection?.state)).size).toBe(8);
  });

  it.each(fixtures)('$id survives the actual owner API and renders both contracted labels', async fixture => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture.response.body), { status: fixture.response.status }));
    vi.stubGlobal('fetch', fetchMock);
    let result: Agent | Agent[];
    if (fixture.request.method === 'POST') {
      result = await api.setAgentPaused(workspace.id, workspace.ownerAgentId!, fixture.id === 'owner-pause-response');
    } else {
      result = await request<Agent[]>(fixture.request.path);
    }
    expect(fetchMock.mock.calls[0][0]).toBe(fixture.request.path);
    expect(fetchMock.mock.calls[0][1].method || 'GET').toBe(fixture.request.method);
    expect(result).toEqual(fixture.response.body);
    const agent = Array.isArray(result) ? result[0] : result;
    const expected = fixture.client.connectionLabel.replace('{relative}', '2 hours ago');
    const markup = renderCard(agent);
    expect(markup).toContain(`<span class="agent-presence">${fixture.client.agentLabel} · ${expected}</span>`);
    expect(markup).not.toMatch(/\b(online|running|Enrolled)\b/);
    expect(markup).not.toMatch(/(?<!Not )\bconnected\b/);
    if (agent.paused && !agent.credentialRevoked) {
      expect(markup).toContain('Resume agent');
      expect(markup).not.toContain('Pause agent');
    }
  });

  it.each(['owner-never-seen', 'owner-resume-grace-expired'])('%s uses server state despite recent setup/status traffic', id => {
    const agent = fixtureAgent(id);
    expect(agent.connection?.presence.lastSeenAt).not.toBeNull();
    expect(renderCard(agent)).toContain(id === 'owner-never-seen' ? 'Active · Not checked in yet' : 'Active · Last checked in 2 hours ago');
  });

  it.each(['owner-seen-recently', 'owner-paused-seen-recently', 'owner-pending-approval', 'owner-revoked'])('%s with omitted connection shows Status unknown', id => {
    const agent: Agent = { ...fixtureAgent(id), connection: undefined };
    const expected = fixtures.find(fixture => fixture.id === id)!.client.agentLabel;
    expect(renderCard(agent)).toContain(`${expected} · Status unknown`);
  });

  it.each(['future_state', 'online', 'running', 'connected', ''])('unknown state %j shows Status unknown and accepts future fields', state => {
    const agent = fixtureAgent('owner-seen-recently');
    const connection = { ...agent.connection!, state, futureDiagnostic: { value: 1 } };
    expect(renderCard({ ...agent, connection })).toContain('Active · Status unknown');
    expect(renderCard({ ...agent, connection })).not.toContain('Enrolled');
  });

  it('keeps connection wording independent of approval and shows revoked precedence over pause/rejection', () => {
    const agent = fixtureAgent('owner-seen-recently');
    expect(renderCard({ ...agent, onboardingStatus: 'future_pending', paused: true })).toContain('Pending · Seen recently');
    expect(renderCard({ ...agent, onboardingStatus: 'rejected', paused: true })).toContain('Rejected · Seen recently');
    expect(renderCard({ ...agent, onboardingStatus: 'rejected', paused: true, credentialRevoked: true })).toContain('Revoked · Seen recently');
  });

  it('updates displayed snapshots through pause and resume without a local presence inference', () => {
    expect(renderCard(fixtureAgent('owner-pause-response'))).toContain('Paused · Seen recently');
    expect(renderCard(fixtureAgent('owner-resume-response'))).toContain('Active · Seen recently');
    expect(renderCard(fixtureAgent('owner-resume-grace-expired'))).toContain('Active · Last checked in 2 hours ago');
    expect(renderCard(fixtureAgent('owner-paused-seen-recently'), false)).not.toContain('Resume agent');
  });
});

describe('server snapshot ages', () => {
  it('ignores the browser clock, including while the snapshot gets older', () => {
    const agent = fixtureAgent('owner-not-seen-recently');
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2000-01-01T00:00:00Z'));
    expect(renderCard(agent)).toContain('Last checked in 2 hours ago');
    vi.mocked(Date.now).mockReturnValue(Date.parse('2099-01-01T00:00:00Z'));
    expect(renderCard(agent)).toContain('Last checked in 2 hours ago');
  });

  it.each([
    ['2026-10-12T12:00:43.000Z', '0 seconds ago'],
    ['2026-10-12T12:00:41.000Z', '1 second ago'],
    ['2026-10-12T12:00:00.000Z', '42 seconds ago'],
    ['2026-10-12T11:59:42.000Z', '1 minute ago'],
    ['2026-10-12T11:00:42.000Z', '1 hour ago'],
    ['2026-10-11T12:00:42.000Z', '1 day ago'],
    ['2026-10-10T12:00:42.000Z', '2 days ago']
  ])('formats %s relative to asOf, clamping future timestamps', (timestamp, expected) => {
    const connection = { ...fixtureAgent('owner-not-seen-recently').connection!, seenAt: timestamp };
    expect(connectionLabel(connection)).toBe(`Last checked in ${expected}`);
  });

  it.each([null, 'invalid'])('has no age for invalid/absent timestamp %j', timestamp => {
    expect(presenceAge('2026-10-12T12:00:42.000Z', timestamp)).toBeNull();
    expect(connectionLabel({ ...fixtureAgent('owner-not-seen-recently').connection!, seenAt: timestamp })).toBe('Status unknown');
  });
});

describe('instruction controls use agent control state independently of presence', () => {
  const workCase = {
    id: 'case_example', schemaVersion: '1.0', objective: 'Example work', state: 'inProgress',
    actingAgent: workspace.ownerAgentId, participants: [], events: [], evidence: [],
    proposals: [], policyEvaluations: [], createdAt: '2026-10-12T10:00:00Z'
  } as WorkCase;
  it.each([
    [false, 'seen_recently', false],
    [false, 'never_seen', false],
    [false, 'future_state', false],
    [true, 'seen_recently', true],
    [true, 'needs_reconnect', true]
  ])('paused=%s connection=%s gives disabled=%s', (paused, state, disabled) => {
    const source = fixtureAgent('owner-seen-recently');
    // Also cover a boolean pause even if status has not changed in an old projection.
    const agent = { ...source, paused, connection: { ...source.connection!, state } };
    const view = { inbox: workspace, agents: [agent], messages: [], assets: [], deliveryReceipts: [], participantDirectory: {} } as unknown as HumanView;
    const markup = renderToStaticMarkup(createElement(CaseWorkspace, {
      workCase, view, railOpen: false, onRailToggle: vi.fn(), onBack: vi.fn(), onRefresh: vi.fn(), notify: vi.fn(), canManageInbox: true
    }));
    const input = markup.match(/<textarea[^>]*aria-label="Instructions for [^>]+>/)![0];
    expect(input.includes('disabled=""')).toBe(disabled);
  });
});
