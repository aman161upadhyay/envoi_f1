import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CaseSessionChannel } from '../../sdk/typescript/src/case-session';
import { contractRegistry, loadContractFixture } from '../contract-fixtures/setup';
import { scopedTurnHandler, type ScopedModelTurn } from './scoped-turn';

const sessionContract = contractRegistry.contracts.find(entry => entry.id === 'case-session')!;
const toolContract = contractRegistry.contracts.find(entry => entry.id === 'case-tools')!;
const fixture = (name: string) => loadContractFixture(toolContract, `${name}.json`) as Record<string, any>;
const channels: CaseSessionChannel[] = [];

function harness(run: (turn: ScopedModelTurn) => Promise<void>, objective = 'Current objective', options: {
  session?: string;
  snapshot?: string;
  results?: Record<string, string>;
  groupMemberAgentIds?: string[];
  beforeEndTurn?: (host: Readonly<{ workId?: string }>) => Promise<void>;
} = {}) {
  const source = loadContractFixture(sessionContract, options.session ?? 'session-created.json') as Record<string, any>;
  const session = source.response.body.session;
  if (options.groupMemberAgentIds) session.allowedTools = ['envoi_case_snapshot', 'envoi_case_reply'];
  const requests: any[] = [];
  const fetcher = vi.fn(async (_url, requestOptions) => {
    const request = JSON.parse(requestOptions.body); requests.push(request);
    const name = request.params.name;
    const target = fixture(options.results?.[name] ?? (name === 'envoi_case_snapshot' ? options.snapshot ?? 'snapshot-agent-work' : name === 'envoi_request_human' ? 'request-human' : 'reply-agent-work'));
    const body = target.response.body;
    body.id = request.id;
    if (name === 'envoi_case_snapshot' || options.groupMemberAgentIds && name === 'envoi_case_reply') {
      const payload = JSON.parse(body.result.content[0].text);
      if (name === 'envoi_case_snapshot') {
        payload.result.case.objective = objective;
        if (options.groupMemberAgentIds) {
          payload.result.allowedActions = ['envoi_case_reply'];
          payload.result.groupMembers = options.groupMemberAgentIds.map(agentId => ({ agentId, address: `${agentId}@envoi.example` }));
          payload.result.requestedResponse.actorAgentId = options.groupMemberAgentIds[0];
        }
      } else {
        payload.result.recipient = { kind: 'group' };
        payload.result.status = 'delivered';
      }
      body.result.content[0].text = JSON.stringify(payload);
    }
    return Response.json(body);
  });
  const channel = new CaseSessionChannel(source.response.body, {
    agentId: session.agentId, workId: session.workId, caseId: session.caseId, workKind: session.workKind,
    counterpartyAddress: session.counterparty.address, agentAddress: source.client.modelVisible.agentAddress,
    groupMemberAgentIds: options.groupMemberAgentIds
  }, { origin: 'https://envoi.example', fetch: fetcher as typeof fetch });
  channels.push(channel);
  const admit = vi.fn(async () => {});
  const handler = scopedTurnHandler({ admit, run, beforeEndTurn: options.beforeEndTurn });
  return { channel, handler, requests, fetcher, admit, process: () => handler.process(channel, { signal: channel.signal }) };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-17T12:00:06Z')); });
afterEach(() => { channels.splice(0).forEach(channel => channel.invalidate()); vi.useRealTimers(); });

describe('trusted scoped adapter turn boundary', () => {
  it('takes a canonical snapshot before giving a runtime only scoped tools and safe context', async () => {
    const test = harness(async turn => {
      expect(test.requests).toHaveLength(1);
      expect(turn.snapshot.case.objective).toBe('Current objective');
      expect(turn.tools.map(tool => tool.name)).toEqual(turn.context.allowedTools);
      expect(JSON.stringify(turn)).not.toMatch(/envoi_case_session_|lease_|case_example|msg_example|installation_/);
      expect(turn.instruction).toContain('untrusted data');
      expect(turn.instruction).not.toContain('case_example');
      await turn.callTool('envoi_case_reply', fixture('reply-agent-work').request.body.params.arguments);
    });
    await test.process();
    expect(test.requests.map(request => request.params.name)).toEqual(['envoi_case_snapshot', 'envoi_case_reply']);
  });

  it('never translates provider text into a privileged REST reply', async () => {
    const test = harness(async () => 'Untrusted provider text' as never);
    await test.process();
    expect(test.requests.map(request => request.params.name)).toEqual(['envoi_case_snapshot']);
  });

  it('presents group work and forwards a follow-up assignment through the scoped reply tool', async () => {
    const groupMemberAgentIds = ['agent_first', 'agent_second', 'agent_third'];
    const args = { text: 'Please check the result', idempotencyKey: 'follow-up', assigneeAgentIds: ['agent_third'] };
    const test = harness(async turn => {
      expect(turn.context.groupMemberAgentIds).toEqual(groupMemberAgentIds);
      expect(turn.snapshot.groupMembers?.map(member => member.agentId)).toEqual(groupMemberAgentIds);
      expect(turn.snapshot.requestedResponse?.actorAgentId).toBe(groupMemberAgentIds[0]);
      expect(turn.instruction).toContain('shared conversation for all members');
      expect(turn.tools.map(tool => tool.name)).toEqual(['envoi_case_snapshot', 'envoi_case_reply']);
      expect(await turn.callTool('envoi_case_reply', args)).toMatchObject({ recipient: { kind: 'group' }, status: 'delivered' });
    }, undefined, { groupMemberAgentIds });
    await test.process();
    expect(test.requests[1].params.arguments).toEqual(args);
  });

  it('passes durable work identity only to the trusted host callback, never to model context', async () => {
    const run = vi.fn(async (turn: ScopedModelTurn, host: Readonly<{ workId?: string }>) => {
      expect(host.workId).toBe('msg_private_host');
      expect(Object.isFrozen(host)).toBe(true);
      expect(JSON.stringify(turn)).not.toContain('msg_private_host');
    });
    const test = harness(run);
    await test.handler.process(test.channel, { signal: test.channel.signal, workId: 'msg_private_host' });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('ends a noncooperating model turn after requesting human input', async () => {
    let turn!: ScopedModelTurn;
    const test = harness(async value => {
      turn = value;
      await value.callTool('envoi_request_human', fixture('request-human').request.body.params.arguments);
      await new Promise<void>(() => {});
    });
    await test.process();
    expect(turn.signal.aborted).toBe(true);
    expect(test.channel.signal.aborted).toBe(false);
    await expect(turn.callTool('envoi_case_reply', fixture('reply-agent-work').request.body.params.arguments)).rejects.toMatchObject({ code: 'TURN_END_REQUIRED' });
    expect(test.requests).toHaveLength(2);
  });

  it('waits for the host human-wait journal before ending a noncooperating model turn', async () => {
    let persisted = false;
    let release!: () => void;
    const saved = new Promise<void>(resolve => { release = resolve; });
    let ready!: () => void;
    const saving = new Promise<void>(resolve => { ready = resolve; });
    const test = harness(async turn => {
      await turn.callTool('envoi_request_human', fixture('request-human').request.body.params.arguments);
      await new Promise<void>(() => {});
    }, 'Human request', { beforeEndTurn: async () => { ready(); await saved; persisted = true; } });
    let finished = false;
    const processing = test.process().then(() => { finished = true; });
    await saving;
    expect(finished).toBe(false);
    release();
    await processing;
    expect(persisted).toBe(true);
  });

  it('propagates a human-wait journal failure instead of settling the work successfully', async () => {
    const test = harness(async turn => {
      await turn.callTool('envoi_request_human', fixture('request-human').request.body.params.arguments);
    }, 'Human request', { beforeEndTurn: async () => { throw new Error('Journal unavailable'); } });
    await expect(test.process()).rejects.toThrow('Journal unavailable');
    expect(test.requests.map(request => request.params.name)).toEqual(['envoi_case_snapshot', 'envoi_request_human']);
  });

  it('cancels a noncooperating provider and refuses its late output after authority loss', async () => {
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    let turn!: ScopedModelTurn;
    const test = harness(async value => { turn = value; ready(); await new Promise<void>(() => {}); });
    const processing = test.process();
    const rejected = expect(processing).rejects.toMatchObject({ code: 'CASE_SESSION_ENDED' });
    await started;
    test.channel.invalidate();
    await rejected;
    await expect(turn.callTool('envoi_case_reply', fixture('reply-agent-work').request.body.params.arguments)).rejects.toBeDefined();
    expect(test.requests).toHaveLength(1);
  });

  it('isolates simultaneous runtime contexts and stops tools after each run returns', async () => {
    const turns: ScopedModelTurn[] = [];
    const first = harness(async turn => { turns.push(turn); }, 'FIRST');
    const second = harness(async turn => { turns.push(turn); }, 'SECOND');
    await Promise.all([first.process(), second.process()]);
    expect(turns.map(turn => turn.snapshot.case.objective)).toEqual(['FIRST', 'SECOND']);
    expect(turns[0].snapshot).not.toBe(turns[1].snapshot);
    await expect(turns[0].callTool('envoi_case_snapshot', {})).rejects.toBeDefined();
    expect(first.requests).toHaveLength(1);
    expect(second.requests).toHaveLength(1);
  });

  it('propagates runtime failure without a privileged fallback or host settlement', async () => {
    const test = harness(async () => { throw new Error('Runtime failed'); });
    await expect(test.process()).rejects.toThrow('Runtime failed');
    expect(test.requests).toHaveLength(1);
  });

  it('does not report success when the runtime returns with an unsettled tool call', async () => {
    let release!: (response: Response) => void;
    const response = new Promise<Response>(resolve => { release = resolve; });
    let late!: Promise<unknown>;
    const test = harness(async turn => {
      late = turn.callTool('envoi_case_reply', fixture('reply-agent-work').request.body.params.arguments).catch(error => error);
    });
    const original = test.fetcher.getMockImplementation()!;
    test.fetcher.mockImplementation(async (...args) => JSON.parse(args[1].body).params.name === 'envoi_case_reply' ? response : original(...args));
    await expect(test.process()).rejects.toMatchObject({ code: 'SCOPED_TURN_INCOMPLETE' });
    test.channel.invalidate();
    release(Response.json({}));
    expect(await late).toBeInstanceOf(Error);
  });

  it('never dispatches a second queued tool after the runtime returns with unsettled calls', async () => {
    let release!: (response: Response) => void;
    const response = new Promise<Response>(resolve => { release = resolve; });
    const calls: Array<Promise<unknown>> = [];
    const test = harness(async turn => {
      calls.push(turn.callTool('envoi_case_reply', fixture('reply-agent-work').request.body.params.arguments).catch(error => error));
      calls.push(turn.callTool('envoi_case_reply', { ...fixture('reply-agent-work').request.body.params.arguments, idempotencyKey: 'second-call' }).catch(error => error));
    });
    const original = test.fetcher.getMockImplementation()!;
    test.fetcher.mockImplementation(async (...args) => JSON.parse(args[1].body).params.name === 'envoi_case_reply' ? response : original(...args));
    await expect(test.process()).rejects.toMatchObject({ code: 'SCOPED_TURN_INCOMPLETE' });
    release(Response.json({}));
    const results = await Promise.all(calls);
    expect(results.every(result => result instanceof Error)).toBe(true);
    expect(test.requests.map(request => request.params.name)).toEqual(['envoi_case_snapshot']);
    expect(test.fetcher.mock.calls.filter(([, options]) => JSON.parse(options.body).params.name === 'envoi_case_reply')).toHaveLength(1);
  });

  it('resumes an approved human decision from a fresh canonical snapshot without projecting host identifiers', async () => {
    const test = harness(async turn => {
      expect(turn.snapshot.authority.pendingHumanDecision).toBe(false);
      expect(turn.snapshot.authority.lastPolicyDecision?.humanApproval).toBe('approved');
      expect(JSON.stringify(turn)).not.toMatch(/policyEvaluationId|humanDecisionId|human_approver|leaseToken|refreshToken|installationId/);
      await turn.callTool('envoi_case_decide', fixture('decide-after-human-approval').request.body.params.arguments);
    }, 'Approved decision', {
      session: 'session-created-human-decision.json', snapshot: 'snapshot-human-decision',
      results: { envoi_case_decide: 'decide-after-human-approval' }
    });
    await test.process();
    expect(test.requests.map(request => request.params.name)).toEqual(['envoi_case_snapshot', 'envoi_case_decide']);
  });

  it('keeps a declined human decision declined and does not generate an automatic acceptance', async () => {
    const test = harness(async turn => {
      expect(turn.snapshot.authority.lastPolicyDecision?.humanApproval).not.toBe('approved');
      expect(turn.snapshot.authority.pendingHumanDecision).toBe(false);
    }, 'Declined decision', { session: 'session-created-human-decision.json', snapshot: 'snapshot-human-decision-declined' });
    await test.process();
    expect(test.requests.map(request => request.params.name)).toEqual(['envoi_case_snapshot']);
  });

  it.each([
    ['propose-new', 'envoi_case_propose'],
    ['decide-counter', 'envoi_case_decide'],
    ['decide-reject', 'envoi_case_decide']
  ] as const)('executes the canonical %s action only through the scoped tool', async (name, tool) => {
    const test = harness(async turn => {
      await turn.callTool(tool, fixture(name).request.body.params.arguments);
    }, 'Negotiation', { results: { [tool]: name } });
    await test.process();
    expect(test.requests.map(request => request.params.name)).toEqual(['envoi_case_snapshot', tool]);
  });

  it('checks authority before accepting and keeps work completion separate from case completion', async () => {
    const test = harness(async turn => {
      const authority = await turn.callTool('envoi_authority_check', fixture('authority-check-allow').request.body.params.arguments);
      expect(authority.decision).toBe('allow');
      const accepted = await turn.callTool('envoi_case_decide', fixture('decide-accept').request.body.params.arguments);
      expect(accepted.decision).toBe('accept');
    }, 'Agreement', { results: { envoi_authority_check: 'authority-check-allow', envoi_case_decide: 'decide-accept' } });
    await test.process();
    expect(test.requests.map(request => request.params.name)).toEqual(['envoi_case_snapshot', 'envoi_authority_check', 'envoi_case_decide']);
    expect(test.requests.some(request => request.params.name === 'envoi_case_complete')).toBe(false);
  });

  it('shares a clean canonical asset and completes only through an explicit outcome receipt', async () => {
    const test = harness(async turn => {
      const asset = await turn.callTool('envoi_case_list_assets', fixture('list-asset-content').request.body.params.arguments);
      expect('asset' in asset && asset.asset.scan).toBe('clean');
      const shared = await turn.callTool('envoi_case_share_asset', fixture('share-asset').request.body.params.arguments);
      expect(shared.recipient.kind).toBe('agent');
      const completed = await turn.callTool('envoi_case_complete', fixture('complete-case-with-evidence').request.body.params.arguments);
      expect(completed.caseStatus).toBe('completed');
      expect(completed.receiptRef).toBeTruthy();
    }, 'File outcome', { results: {
      envoi_case_list_assets: 'list-asset-content', envoi_case_share_asset: 'share-asset', envoi_case_complete: 'complete-case-with-evidence'
    } });
    await test.process();
    expect(test.requests.map(request => request.params.name)).toEqual(['envoi_case_snapshot', 'envoi_case_list_assets', 'envoi_case_share_asset', 'envoi_case_complete']);
  });

  it('propagates a quarantined asset denial without sharing it or creating a completion receipt', async () => {
    const test = harness(async turn => {
      await turn.callTool('envoi_case_list_assets', fixture('list-asset-content-not-clean').request.body.params.arguments);
    }, 'Quarantine', { results: { envoi_case_list_assets: 'list-asset-content-not-clean' } });
    await expect(test.process()).rejects.toMatchObject({ code: 'ASSET_NOT_CLEAN' });
    expect(test.requests.map(request => request.params.name)).toEqual(['envoi_case_snapshot', 'envoi_case_list_assets']);
  });
});
