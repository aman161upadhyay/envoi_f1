import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CaseSessionChannel } from '../src/case-session';
import { CaseToolsClient, type CaseToolName, type CaseSnapshotAsset, type CaseToolResults } from '../src/case-tools';
import { contractRegistry, loadContractFixture } from '../../../integrations/contract-fixtures/setup';

const sessionContract = contractRegistry.contracts.find(entry => entry.id === 'case-session')!;
const toolContract = contractRegistry.contracts.find(entry => entry.id === 'case-tools')!;
const sessionFixture = (name: string) => loadContractFixture(sessionContract, `${name}.json`) as Record<string, any>;
const toolFixture = (name: string) => loadContractFixture(toolContract, `${name}.json`) as Record<string, any>;
const fixtures = toolContract.fixtures.map(name => loadContractFixture(toolContract, name) as Record<string, any>);
const channels: CaseSessionChannel[] = [];

function harness(target: Record<string, any>, mutate?: (body: any, request: any) => void, scope?: { caseId: string; workId: string; agentId: string; address: string; objective: string }) {
  const human = target.context?.workKind === 'human_instruction';
  const decision = target.context?.workKind === 'human_decision';
  const source = sessionFixture(human ? 'session-created-human-instruction' : decision ? 'session-created-human-decision' : 'session-created');
  if (scope) {
    Object.assign(source.response.body.session, { caseId: scope.caseId, workId: scope.workId, agentId: scope.agentId });
    source.response.body.session.token += `_${scope.workId}`;
    source.response.body.lease.workId = scope.workId;
    source.client.modelVisible.agentAddress = scope.address;
  }
  const baseline = toolFixture(human ? 'snapshot-human-instruction' : 'snapshot-agent-work').response.body;
  const requests: any[] = [];
  const fetcher = vi.fn(async (_url: any, options: any) => {
    const request = JSON.parse(options.body); requests.push(request);
    const firstSnapshot = requests.length === 1 && request.params.name === 'envoi_case_snapshot'
      && (target.request.body.params.name !== 'envoi_case_snapshot' || target.request.body.params.arguments.eventsBefore && !request.params.arguments.eventsBefore);
    let body = structuredClone(firstSnapshot ? baseline : target.response.body);
    body.id = request.id;
    if (scope && request.params.name === 'envoi_case_snapshot') {
      const payload = JSON.parse(body.result.content[0].text);
      payload.result.you.address = scope.address;
      payload.result.case.objective = scope.objective;
      body.result.content[0].text = JSON.stringify(payload);
    }
    mutate?.(body, request);
    return Response.json(body, { status: firstSnapshot ? 200 : target.response.status });
  });
  const session = source.response.body.session;
  const channel = new CaseSessionChannel(source.response.body, {
    agentId: session.agentId, workId: session.workId, caseId: session.caseId, workKind: session.workKind,
    counterpartyAddress: session.counterparty.address, agentAddress: source.client.modelVisible.agentAddress
  }, { origin: 'https://envoi.example', fetch: fetcher as typeof fetch });
  channels.push(channel);
  return { client: new CaseToolsClient(channel), channel, fetcher, requests };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-17T12:00:06.000Z')); });
afterEach(() => { for (const channel of channels.splice(0)) channel.invalidate(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('typed case tools under private session custody', () => {
  const successes = fixtures.filter(fixture => fixture.response?.toolResult && fixture.response.body.result.isError === false
    && fixture.request.body.params.name !== 'envoi_case_snapshot');
  it.each(successes)('$id validates the canonical result after taking a snapshot first', async fixture => {
    const test = harness(fixture);
    const expected = JSON.parse(fixture.response.body.result.content[0].text).result;
    const request = fixture.request.body.params;
    await expect(test.client.call(request.name, request.arguments)).resolves.toEqual(expected);
    expect(test.requests.map(request => request.params.name)).toEqual(['envoi_case_snapshot', request.name]);
    expect(test.requests[1].params.arguments).toEqual(request.arguments);
    expect(JSON.stringify(test.client)).not.toMatch(/envoi_case_session_|agent_example|case_example|msg_example|lease_/);
  });

  const refusals = fixtures.filter(fixture => fixture.response?.toolResult && fixture.response.body.result.isError === true
    && fixture.request.body.params.name !== 'envoi_case_snapshot');
  it.each(refusals)('$id preserves the typed refusal without privileged fallback', async fixture => {
    const test = harness(fixture);
    const expected = JSON.parse(fixture.response.body.result.content[0].text);
    const request = fixture.request.body.params;
    const rejected = expect(test.client.call(request.name, request.arguments)).rejects.toMatchObject({ code: expected.code, retryable: expected.retryable });
    if (expected.code === 'TOOL_BUSY') await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(test.requests.map(request => request.params.name)).toEqual(['envoi_case_snapshot', ...Array(expected.code === 'TOOL_BUSY' ? 4 : 1).fill(request.name)]);
    if (expected.code === 'TOOL_BUSY') expect(new Set(test.requests.slice(1).map(request => JSON.stringify(request))).size).toBe(1);
  });

  it('retries an initially busy snapshot with backoff and an identical request before returning canonical context', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    let attempts = 0;
    const test = harness(toolFixture('snapshot-agent-work'), (body, request) => {
      if (++attempts > 2) return;
      body.result = structuredClone(toolFixture('reply-tool-busy').response.body.result);
      const envelope = JSON.parse(body.result.content[0].text); envelope.tool = request.params.name;
      body.result.content[0].text = JSON.stringify(envelope);
    });
    const pending = test.client.snapshot();
    await vi.advanceTimersByTimeAsync(0); expect(test.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(499); expect(test.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); expect(test.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(999); expect(test.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual(JSON.parse(toolFixture('snapshot-agent-work').response.body.result.content[0].text).result);
    expect(test.requests).toHaveLength(3);
    expect(new Set(test.requests.map(request => JSON.stringify(request))).size).toBe(1);
  });

  it('cancels a busy-tool backoff immediately when its scoped channel ends', async () => {
    const test = harness(toolFixture('reply-tool-busy'));
    const rejected = expect(test.client.reply(toolFixture('reply-tool-busy').request.body.params.arguments)).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(0); expect(test.requests).toHaveLength(2);
    test.channel.invalidate(); await rejected;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(test.requests).toHaveLength(2); expect(vi.getTimerCount()).toBe(0);
  });

  it('freezes snapshots so a caller cannot rewrite allowed actions or cached authority', async () => {
    const test = harness(toolFixture('snapshot-agent-work'));
    const snapshot = await test.client.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.allowedActions)).toBe(true);
    expect(() => snapshot.allowedActions.push('envoi_case_propose')).toThrow();
  });

  it.each([
    { caseId: 'case_other', text: 'Wrong scope', idempotencyKey: 'key' },
    { recipientAddress: 'other@envoi.mail', text: 'Wrong recipient', idempotencyKey: 'key' },
    { text: 'No key' }, { text: '', idempotencyKey: 'key' }
  ])('rejects invalid reply arguments before any network call: %j', async input => {
    const test = harness(toolFixture('reply-agent-work'));
    await expect(test.client.reply(input as never)).rejects.toMatchObject({ code: 'TOOL_ARGUMENTS_INVALID' });
    expect(test.fetcher).not.toHaveBeenCalled();
  });

  it('rejects oversized serialized terms even when the object has few properties', async () => {
    const test = harness(toolFixture('propose-new'));
    await expect(test.client.propose({ text: 'Terms', terms: { content: '界'.repeat(400) }, idempotencyKey: 'offer-one' })).rejects.toMatchObject({ code: 'TOOL_ARGUMENTS_INVALID' });
    expect(test.fetcher).not.toHaveBeenCalled();
  });

  it('stops accepting tools after requesting human input instead of waiting inside the turn', async () => {
    const test = harness(toolFixture('request-human'));
    const request = toolFixture('request-human').request.body.params.arguments;
    await test.client.requestHuman(request);
    expect(test.client.endTurnRequired).toBe(true);
    await expect(test.client.snapshot()).rejects.toMatchObject({ code: 'TURN_END_REQUIRED' });
    expect(test.fetcher).toHaveBeenCalledTimes(2);
  });

  it('preserves a staged-server tool refusal without echoing protocol diagnostics', async () => {
    const fixture = toolFixture('revision-3-tool-not-in-session');
    const test = harness(fixture);
    await expect(test.client.call(fixture.request.body.params.name, fixture.request.body.params.arguments)).rejects.toMatchObject({ code: 'TOOL_NOT_IN_SESSION', message: 'Case tool request was refused' });
    expect(test.requests).toHaveLength(2);
    expect(test.channel.signal.aborted).toBe(false);
  });

  it('does not treat a returned completion receipt as host lease settlement', async () => {
    const test = harness(toolFixture('complete-case'));
    const result = await test.client.complete(toolFixture('complete-case').request.body.params.arguments);
    expect(result.receiptRef).toMatch(/^r_/);
    expect(test.requests.every(request => request.method === 'tools/call')).toBe(true);
    expect(test.channel.signal.aborted).toBe(false);
  });

  it.each(['wrong-id', 'wrong-tool', 'extra-content', 'private-field', 'wrong-recipient', 'wrong-owner'])('rejects malformed or mismatched %s without echoing response details', async fault => {
    const test = harness(toolFixture('reply-agent-work'), (body, request) => {
      if (fault === 'wrong-id') body.id = 999;
      else if (fault === 'extra-content') body.result.content.push({ type: 'text', text: 'PRIVATE_SENTINEL' });
      else {
        const payload = JSON.parse(body.result.content[0].text);
        if (fault === 'wrong-tool') payload.tool = 'envoi_case_complete';
        if (fault === 'private-field') payload.result.accessToken = 'PRIVATE_SENTINEL';
        if (fault === 'wrong-owner' && request.params.name === 'envoi_case_snapshot') payload.result.you.address = 'someone@envoi.mail';
        if (fault === 'wrong-recipient' && request.params.name === 'envoi_case_reply') payload.result.recipient.address = 'someone@envoi.mail';
        body.result.content[0].text = JSON.stringify(payload);
      }
    });
    const error = await test.client.reply(toolFixture('reply-agent-work').request.body.params.arguments).catch(error => error);
    expect(error.code).toBe('CASE_TOOL_RESPONSE_INVALID');
    expect(String(error)).not.toContain('PRIVATE_SENTINEL');
  });

  it('does not return inline asset content with a mismatched checksum', async () => {
    const test = harness(toolFixture('list-asset-content'), (body, request) => {
      if (request.params.name !== 'envoi_case_list_assets') return;
      const payload = JSON.parse(body.result.content[0].text);
      payload.result.content.text = 'Tampered text';
      body.result.content[0].text = JSON.stringify(payload);
    });
    await expect(test.client.listAssets(toolFixture('list-asset-content').request.body.params.arguments)).rejects.toMatchObject({ code: 'CASE_TOOL_RESPONSE_INVALID' });
  });

  it.each(['requested', 'event', 'objective', 'option', 'filename', 'mimeType'])('enforces serialized UTF-8 snapshot limits for %s', async field => {
    const test = harness(toolFixture('snapshot-agent-work'), body => {
      const payload = JSON.parse(body.result.content[0].text);
      const snapshot = payload.result;
      if (field === 'requested') snapshot.requestedResponse.text = '\n'.repeat(7000);
      if (field === 'event') snapshot.recentEvents[0].text = '\n'.repeat(2500);
      if (field === 'objective') snapshot.case.objective = '\u0001'.repeat(400);
      if (field === 'option') snapshot.proposal.options[0].value = { text: '界'.repeat(400) };
      if (field === 'filename') snapshot.assets[0].filename = '界'.repeat(100);
      if (field === 'mimeType') snapshot.assets[0].mimeType = '界'.repeat(50);
      body.result.content[0].text = JSON.stringify(payload);
    });
    await expect(test.client.snapshot()).rejects.toMatchObject({ code: 'CASE_TOOL_RESPONSE_INVALID' });
  });

  it('accepts text exactly at the serialized byte limit', async () => {
    const test = harness(toolFixture('snapshot-agent-work'), body => {
      const payload = JSON.parse(body.result.content[0].text);
      payload.result.requestedResponse.text = '界'.repeat(4095) + 'a';
      payload.result.recentEvents[0].text = '\n'.repeat(2047);
      body.result.content[0].text = JSON.stringify(payload);
    });
    const snapshot = await test.client.snapshot();
    expect(new TextEncoder().encode(JSON.stringify(snapshot.requestedResponse!.text)).byteLength).toBe(12288);
    expect(new TextEncoder().encode(JSON.stringify(snapshot.recentEvents[0].text)).byteLength).toBe(4096);
  });

  it.each(['action', 'proposalRef', 'optionRef'])('rejects authority for a different %s', async field => {
    const fixture = toolFixture('authority-check-allow');
    const test = harness(fixture, (body, request) => {
      if (request.params.name !== 'envoi_authority_check') return;
      const payload = JSON.parse(body.result.content[0].text);
      payload.result[field] = field === 'action' ? 'complete_case' : `${field === 'proposalRef' ? 'p' : 'o'}_aaaaaaaaaaaaaaaa`;
      body.result.content[0].text = JSON.stringify(payload);
    });
    await expect(test.client.checkAuthority(fixture.request.body.params.arguments)).rejects.toMatchObject({ code: 'CASE_TOOL_RESPONSE_INVALID' });
  });

  it.each(['missing-work', 'work-on-older-page'])('rejects invalid snapshot projection %s', async fault => {
    const source = toolFixture(fault === 'missing-work' ? 'snapshot-agent-work' : 'snapshot-older-page');
    const fixture = source.steps ? { context: source.context, ...source.steps[1] } : source;
    const test = harness(fixture, (body, request) => {
      const payload = JSON.parse(body.result.content[0].text);
      if (fault === 'missing-work') delete payload.result.requestedResponse;
      else if (request.params.arguments.eventsBefore) payload.result.requestedResponse = JSON.parse(toolFixture('snapshot-agent-work').response.body.result.content[0].text).result.requestedResponse;
      body.result.content[0].text = JSON.stringify(payload);
    });
    await expect(test.client.snapshot(fixture.request.body.params.arguments)).rejects.toMatchObject({ code: 'CASE_TOOL_RESPONSE_INVALID' });
  });

  it('takes the current work snapshot before paging older events', async () => {
    const sequence = toolFixture('snapshot-older-page');
    const fixture = { context: sequence.context, ...sequence.steps[1] };
    const test = harness(fixture);
    const snapshot = await test.client.snapshot(fixture.request.body.params.arguments);
    expect(snapshot).not.toHaveProperty('requestedResponse');
    expect(test.requests.map(request => request.params.arguments)).toEqual([{}, fixture.request.body.params.arguments]);
  });

  it.each(['different-ref', 'list-for-single', 'single-for-list'])('rejects substituted asset response %s', async fault => {
    const fixture = toolFixture(fault === 'single-for-list' ? 'list-assets' : 'list-asset-content');
    const test = harness(fixture, (body, request) => {
      if (request.params.name !== 'envoi_case_list_assets') return;
      const payload = JSON.parse(body.result.content[0].text);
      if (fault === 'different-ref') payload.result.asset.ref = 'a_aaaaaaaaaaaaaaaa';
      else payload.result = JSON.parse(toolFixture(fault === 'single-for-list' ? 'list-asset-content' : 'list-assets').response.body.result.content[0].text).result;
      body.result.content[0].text = JSON.stringify(payload);
    });
    await expect(test.client.listAssets(fixture.request.body.params.arguments)).rejects.toMatchObject({ code: 'CASE_TOOL_RESPONSE_INVALID' });
  });

  it.each(['list-filename', 'single-filename', 'list-mimeType', 'single-mimeType'])('enforces serialized asset metadata limits for %s', async fault => {
    const fixture = toolFixture(fault.startsWith('list-') ? 'list-assets' : 'list-asset-content');
    const test = harness(fixture, (body, request) => {
      if (request.params.name !== 'envoi_case_list_assets') return;
      const payload = JSON.parse(body.result.content[0].text);
      const asset = payload.result.asset ?? payload.result.assets[0];
      const field = fault.endsWith('filename') ? 'filename' : 'mimeType';
      asset[field] = '界'.repeat(field === 'filename' ? 100 : 50);
      body.result.content[0].text = JSON.stringify(payload);
    });
    await expect(test.client.listAssets(fixture.request.body.params.arguments)).rejects.toMatchObject({ code: 'CASE_TOOL_RESPONSE_INVALID' });
  });

  it('matches the distinct snapshot asset and human reply types', () => {
    const asset: CaseSnapshotAsset = { ref: 'a_aaaaaaaaaaaaaaaa', filename: 'notes.txt', size: 1, shared: false, mimeType: 'text/plain', scan: 'pending', origin: 'you' };
    const status: CaseToolResults['envoi_case_reply']['status'] = 'delivered';
    expect(asset).not.toHaveProperty('checksumSha256');
    expect(status).toBe('delivered');
  });

  it('keeps two cases with the same counterparty and a third owner independently scoped', async () => {
    const first = harness(toolFixture('reply-agent-work'), undefined, { caseId: 'case_first', workId: 'msg_first', agentId: 'agent_example', address: 'example@envoi.mail', objective: 'FIRST' });
    const second = harness(toolFixture('reply-agent-work'), undefined, { caseId: 'case_second', workId: 'msg_second', agentId: 'agent_example', address: 'example@envoi.mail', objective: 'SECOND' });
    const third = harness(toolFixture('reply-agent-work'), undefined, { caseId: 'case_third', workId: 'msg_third', agentId: 'agent_other', address: 'other@envoi.mail', objective: 'THIRD' });
    const snapshots = await Promise.all([first.client.snapshot(), second.client.snapshot(), third.client.snapshot()]);
    expect(snapshots.map(snapshot => snapshot.case.objective)).toEqual(['FIRST', 'SECOND', 'THIRD']);
    expect(snapshots.map(snapshot => snapshot.you.address)).toEqual(['example@envoi.mail', 'example@envoi.mail', 'other@envoi.mail']);
    const args = toolFixture('reply-agent-work').request.body.params.arguments;
    const [one, two] = await Promise.all([first.client.reply(args), second.client.reply(args), third.client.reply(args)]);
    expect(one).toEqual(two);
    expect(one).not.toBe(two);
    expect(first.requests.map(request => request.id)).toEqual([1, 2]);
    expect(second.requests.map(request => request.id)).toEqual([1, 2]);
    expect(third.requests.map(request => request.id)).toEqual([1, 2]);
    first.channel.invalidate();
    await expect(first.client.snapshot()).rejects.toBeDefined();
    expect(second.channel.signal.aborted).toBe(false);
    expect(third.channel.signal.aborted).toBe(false);
  });

  it('copies arguments before asynchronous work so keys and text cannot change during admission', async () => {
    const test = harness(toolFixture('reply-agent-work'));
    const args = structuredClone(toolFixture('reply-agent-work').request.body.params.arguments);
    const original = structuredClone(args);
    const pending = test.client.reply(args);
    args.text = 'Changed after queuing'; args.idempotencyKey = 'different-key';
    await pending;
    expect(test.requests[1].params.arguments).toEqual(original);
  });

  it('cancels on session authority loss without retrying through host access', async () => {
    const test = harness(toolFixture('reply-session-ended-in-write'));
    await expect(test.client.reply(toolFixture('reply-session-ended-in-write').request.body.params.arguments)).rejects.toMatchObject({ code: 'CASE_SESSION_ENDED' });
    expect(test.channel.signal.aborted).toBe(true);
    expect(test.requests.map(request => request.params.name)).toEqual(['envoi_case_snapshot', 'envoi_case_reply']);
    await expect(test.client.snapshot()).rejects.toBeDefined();
    expect(test.fetcher).toHaveBeenCalledTimes(2);
  });
});
