import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnvoiConnector, type ConnectorSession } from '../src/connector';
import { contractRegistry, loadContractFixture } from '../../../integrations/contract-fixtures/setup';

const contract = contractRegistry.contracts.find(item => item.id === 'a4-wake')!;
const fixture = (id: string): any => loadContractFixture(contract, `${id}.json`);
const frame = (value: any) => `${value.id ? `id: ${value.id}\n` : ''}event: ${value.event}\ndata: ${JSON.stringify(value.data)}\n\n`;
const stops: Array<() => Promise<void>> = [];
afterEach(async () => { for (const stop of stops.splice(0)) await stop(); vi.useRealTimers(); vi.restoreAllMocks(); });
async function harness(extra: { session?: Partial<ConnectorSession>; claim?: () => Promise<Response>; connect?: (attempt: number) => Response } = {}) {
  vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0.5);
  let saved: ConnectorSession = { agentId: 'agent_example', inboxId: 'inbox_example', address: 'example@envoi.mail',
    agentApiToken: 'access', agentRefreshToken: 'refresh', agentTokenExpiresAt: new Date(Date.now()+3600000).toISOString(),
    agentRefreshTokenExpiresAt: new Date(Date.now()+86400000).toISOString(), cursor: null, ...extra.session };
  let writer: ReadableStreamDefaultController<Uint8Array>;
  let connections = 0;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const claims = vi.fn(extra.claim ?? (async () => Response.json(fixture('claim-idle-no-hint').response.body)));
  let active = false;
  const fetcher = vi.fn(async (input: any, init?: RequestInit) => {
    const url = String(input); requests.push({ url, init });
    if (url.endsWith('/claim')) return claims();
    if (url.endsWith('/api/agent/status')) return Response.json({ state: active ? 'active' : 'paused', agent: { id: saved.agentId }, inboxId: saved.inboxId });
    if (url.includes('/events/delta')) return Response.json(fixture('delta-last-page').response.body);
    connections++;
    const custom = extra.connect?.(connections); if (custom) return custom;
    return new Response(new ReadableStream({ start(controller) { writer = controller; } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const events = vi.fn(); const controller = new AbortController();
  const connector = new EnvoiConnector('https://api.example', { load: async () => saved, save: async value => { saved = structuredClone(value); } },
    { fetch: fetcher, handler: { admit: async () => {}, process: async () => {} }, onEvent: events });
  const running = connector.run(controller.signal);
  // Attach a rejection handler immediately; assertions can still inspect the original run.
  void running.catch(() => {});
  const tick = async (ms = 0) => vi.advanceTimersByTimeAsync(ms);
  stops.push(async () => { controller.abort(); await tick(); await running; });
  await tick();
  return { connector, claims, requests, events, tick, session: () => saved, setSession: (value: Partial<ConnectorSession>) => { saved = { ...saved, ...value }; },
    send: (id: string) => { const value = fixture(id); if (value.frames) for (const item of value.frames) writer.enqueue(new TextEncoder().encode(frame(item))); else writer.enqueue(new TextEncoder().encode(frame(value.event))); },
    raw: (value: any) => writer.enqueue(new TextEncoder().encode(frame(value))), close: () => writer.close(), resume: () => { active = true; } };
}

describe('approved a4 wake consumption', () => {
  it('reports live idle stream, claim, and disconnect state without exposing the cursor or token', async () => {
    const h = await harness();
    expect(h.connector.wakeDiagnostics()).toMatchObject({ transport: 'connecting', lastWorkClaimAt: expect.any(String) });
    h.send('stream-from-latest'); await h.tick();
    expect(h.connector.wakeDiagnostics()).toMatchObject({ transport: 'connected', lastReadyAt: expect.any(String) });
    h.close(); await h.tick();
    const safe = JSON.stringify(h.connector.wakeDiagnostics());
    expect(safe).toContain('disconnected');
    expect(safe).not.toMatch(/access|refresh|00000000000000000044/);
  });
  it('baselines from latest, ignores own sends, and persists unknown events without claiming', async () => {
    const h = await harness(); expect(h.claims).toHaveBeenCalledTimes(1);
    expect(h.requests.find(r => r.url.includes('/events'))?.url).toContain('?from=latest');
    h.send('stream-from-latest'); await h.tick(); expect(h.session().cursors).toEqual({ inbox_example: '00000000000000000044' });
    const before = h.claims.mock.calls.length;
    h.send('event-message-delivered-own-send'); await h.tick(); expect(h.claims).toHaveBeenCalledTimes(before);
    h.raw({ id: '00000000000000000060', event: 'future.event', data: { id: 'evt_60', cursor: '00000000000000000060', type: 'future.event' } });
    await h.tick(); expect(h.session().cursor).toBe('00000000000000000060'); expect(h.claims).toHaveBeenCalledTimes(before);
    h.send('event-message-delivered-to-agent'); await h.tick(); expect(h.events).toHaveBeenCalledTimes(2); // duplicate/regression dropped
    expect(h.requests.some(r => r.url.includes('/delta'))).toBe(false);
  });
  it.each(['event-message-delivered-to-agent', 'event-work-available-case-resumed', 'event-work-available-counterparty-resumed', 'event-work-available-lease-released'])('claims on %s', async id => {
    const h = await harness(); h.send(id); await h.tick(); expect(h.claims).toHaveBeenCalledTimes(2);
  });
  it('collapses a burst to one follow-up with no overlapping claims', async () => {
    let release!: (response: Response) => void;
    const h = await harness({ claim: () => new Promise(resolve => { release = resolve; }) });
    h.send('stream-from-latest');
    h.send('event-message-delivered-to-agent'); h.send('event-work-available-case-resumed');
    await h.tick(); expect(h.claims).toHaveBeenCalledTimes(1);
    release(Response.json(fixture('claim-idle-no-hint').response.body)); await h.tick(); expect(h.claims).toHaveBeenCalledTimes(2);
    release(Response.json(fixture('claim-idle-no-hint').response.body)); await h.tick(); expect(h.claims).toHaveBeenCalledTimes(2);
  });
  it('schedules relative hints and retains healthy safety claims without delta polling', async () => {
    const h = await harness({ claim: async () => Response.json({ ...fixture('claim-idle-next-available').response.body, nextAvailableInMs: 2000 }) });
    h.send('stream-from-latest'); await h.tick(); const before = h.claims.mock.calls.length;
    await h.tick(1999); expect(h.claims).toHaveBeenCalledTimes(before);
    await h.tick(1); expect(h.claims).toHaveBeenCalledTimes(before+1);
    expect(h.requests.some(r => r.url.includes('/delta'))).toBe(false);
  });
  it('runs healthy safety at 45 seconds and disconnected safety at 15 seconds', async () => {
    const h = await harness(); h.send('stream-from-latest'); await h.tick(); const before = h.claims.mock.calls.length;
    await h.tick(44999); expect(h.claims).toHaveBeenCalledTimes(before); await h.tick(1); expect(h.claims).toHaveBeenCalledTimes(before+1);
    h.close(); await h.tick(); await h.tick(15000); expect(h.claims.mock.calls.length).toBeGreaterThan(before+1);
  });
  it('recovers delta only after replay_required from its processed cursor, not control cursor', async () => {
    const h = await harness({ session: { cursor: '00000000000000000044' } });
    h.raw({ event: 'replay_required', data: { cursor: '00000000000000999999', hasMore: true } }); await h.tick();
    expect(h.requests.find(r => r.url.includes('/delta'))?.url).toContain('cursor=00000000000000000044');
    expect(h.requests.filter(r => r.url.includes('/events') && !r.url.includes('/delta')).length).toBe(2);
    expect(h.session().cursor).not.toBe('00000000000000999999');
  });
  it('resets only its inbox on EVENT_CURSOR_INVALID and reconnects from latest', async () => {
    const h = await harness({ session: { cursor: '00000000000000000099', cursors: { inbox_example: '00000000000000000099', inbox_other: '00000000000000000002' } },
      connect: attempt => attempt === 1 ? Response.json(fixture('stream-cursor-invalid').response.body, { status: 400 }) : undefined! });
    await h.tick(500);
    expect(h.session().cursors).toEqual({ inbox_example: null, inbox_other: '00000000000000000002' });
    expect(h.requests.at(-1)?.url).toContain('?from=latest');
  });
  it('recovers a missed resume via status while claims remain stopped during pause', async () => {
    const h = await harness({ session: { lifecycle: { state: 'PAUSED', paused: true, changedAt: new Date().toISOString(), failures: 0 } } });
    h.send('stream-from-latest'); await h.tick(); expect(h.claims).not.toHaveBeenCalled();
    h.resume(); await h.tick(45000); expect(h.claims).toHaveBeenCalledTimes(1); expect((await h.connector.lifecycle()).paused).toBe(false);
  });
  it('does not carry a scalar cursor into another inbox when an inbox map exists', async () => {
    const h = await harness({ session: { cursor: '00000000000000000088', cursors: { inbox_other: '00000000000000000088' } } });
    expect(h.requests.find(r => r.url.includes('/events'))?.url).toContain('?from=latest');
  });
  it('does not commit the ready control cursor when resuming stored history', async () => {
    const h = await harness({ session: { cursor: '00000000000000000040' } });
    h.send('stream-from-latest'); await h.tick(); expect(h.session().cursor).toBe('00000000000000000040');
    expect(new Headers(h.requests.find(r => r.url.includes('/events'))?.init?.headers).get('Last-Event-ID')).toBe('00000000000000000040');
    expect(h.requests.find(r => r.url.includes('/events'))?.init?.credentials).toBe('omit');
  });
  it('applies full jitter reconnect backoff and resets only after 60 seconds of stream uptime', async () => {
    const h = await harness(); h.close(); await h.tick(499); expect(h.requests.filter(r => r.url.includes('/events'))).toHaveLength(1);
    await h.tick(1); h.close(); await h.tick(999); expect(h.requests.filter(r => r.url.includes('/events'))).toHaveLength(2);
    await h.tick(1); h.send('stream-from-latest'); await h.tick(59000);
    h.raw({ event: 'keepalive', data: {} }); await h.tick(1000); h.close(); await h.tick(499);
    expect(h.requests.filter(r => r.url.includes('/events'))).toHaveLength(3);
    await h.tick(1); expect(h.requests.filter(r => r.url.includes('/events'))).toHaveLength(4);
  });
  it('reconnects after 60 seconds with no bytes and honors retry-after on connect', async () => {
    const h = await harness({ connect: attempt => attempt === 1 ? Response.json({ code: 'RATE_LIMITED', message: 'Busy' }, { status: 429, headers: { 'retry-after': '5' } }) : undefined! });
    await h.tick(4999); expect(h.requests.filter(r => r.url.includes('/events'))).toHaveLength(1);
    await h.tick(1); expect(h.requests.filter(r => r.url.includes('/events'))).toHaveLength(2);
    await h.tick(60000); await h.tick(1000); expect(h.requests.filter(r => r.url.includes('/events')).length).toBeGreaterThan(2);
  });
  it('retries an unstructured upstream 429 without ending the local connector', async () => {
    const h = await harness({ connect: attempt => attempt === 1
      ? new Response('<html>temporary proxy throttle</html>', { status: 429, headers: { 'retry-after': '5' } }) : undefined! });
    expect((await h.connector.lifecycle()).state).toBe('RUNNING');
    await h.tick(4999);
    expect(h.requests.filter(r => r.url.includes('/events'))).toHaveLength(1);
    await h.tick(1);
    expect(h.requests.filter(r => r.url.includes('/events'))).toHaveLength(2);
    expect((await h.connector.lifecycle()).state).toBe('RUNNING');
  });
  it('wakes for human instructions and own agent resume, accepting future work reasons', async () => {
    const h = await harness();
    const event = (type: string, sequence: number, extra: object) => h.raw({ id: String(sequence).padStart(20, '0'), event: type,
      data: { id: `evt_${sequence}`, type, cursor: String(sequence).padStart(20, '0'), ...extra } });
    event('human.instruction_created', 1, { recipientAgentId: 'agent_example' }); await h.tick();
    event('work.available', 2, { agentId: 'agent_example', reason: 'future_reason' }); await h.tick();
    event('agent.paused', 3, { agentId: 'agent_example' }); await h.tick();
    event('agent.resumed', 4, { agentId: 'agent_example' }); await h.tick();
    expect(h.claims).toHaveBeenCalledTimes(4);
  });
});
