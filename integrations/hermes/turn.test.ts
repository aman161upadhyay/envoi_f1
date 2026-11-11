import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { WorkMessage } from '../../sdk/typescript/src/connector';
import { bridgeHandler } from '../agent-bridges/bridge';
import { FileBridgeStore } from '../agent-bridges/file-store';
import { HermesRunStore } from './run-store';
import { hermesTurn } from './turn';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json' }
});
const message = (id: string, caseId: string): WorkMessage => ({
  id, caseId, intent: 'request', text: `Please handle ${id}`,
  senderAgentId: 'sender', recipientAgentId: 'hermes_agent',
  from: { agentId: 'sender', address: 'sender@envoi.mail' }
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'envoi-hermes-test-'));
  const replies = new FileBridgeStore(directory);
  await replies.init();
  const runs = new HermesRunStore(directory);
  return { directory, replies, runs, cleanup: async () => rm(directory, { recursive: true, force: true }) };
}

describe('Hermes automatic run bridge', () => {
  it('recovers a lost creation response with exactly the same request and idempotency key, then persists a typed reply', async () => {
    const state = await fixture();
    try {
      const created = new Map<string, { body: string; id: string }>();
      let loseFirstResponse = true;
      const fetcher = vi.fn<typeof fetch>(async (url, init) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname === '/v1/runs') {
          const key = new Headers(init?.headers).get('idempotency-key')!;
          const body = String(init?.body);
          const existing = created.get(key);
          if (existing && existing.body !== body) return json({ code: 'idempotency_key_conflict' }, 409);
          if (!existing) created.set(key, { body, id: 'run_one' });
          if (loseFirstResponse) { loseFirstResponse = false; throw new Error('response lost'); }
          return json({ run_id: 'run_one', status: 'started' }, 202);
        }
        return json({ run_id: 'run_one', status: 'completed', output: '{"text":"Accepted","intent":"offer","proposal":{"answer":42}}' });
      });
      const makeTurn = () => hermesTurn({ apiUrl: 'http://127.0.0.1:8642', apiKey: 'private-api-key',
        agentId: 'hermes_agent', runs: state.runs, replies: state.replies, fetch: fetcher, pollIntervalMs: 1 });
      await expect(makeTurn()(message('msg_1', 'case_1'), new AbortController().signal)).rejects.toThrow('response lost');
      const admitted = await state.runs.load('msg_1');
      expect(admitted?.runId).toBeUndefined();
      expect(admitted?.request.input).toContain('msg_1');
      expect(admitted?.request.input).not.toContain('private-api-key');
      const reply = await makeTurn()(message('msg_1', 'case_1'), new AbortController().signal);
      expect(reply).toEqual({ text: 'Accepted', intent: 'offer', proposal: { answer: 42 } });
      expect(created.size).toBe(1);
      expect((await state.runs.load('msg_1'))?.runId).toBe('run_one');
      expect(await state.replies.replyFor('msg_1')).toEqual(reply);
      expect(fetcher.mock.calls.filter(call => new URL(String(call[0])).pathname === '/v1/runs')).toHaveLength(2);
    } finally { await state.cleanup(); }
  });

  it('recovers an existing run ID without creating another run, and isolates successive work in the same case', async () => {
    const state = await fixture();
    try {
      const bodies: Array<Record<string, string>> = [];
      let failPoll = true;
      const fetcher = vi.fn<typeof fetch>(async (url, init) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname === '/v1/runs') {
          const body = JSON.parse(String(init?.body)) as Record<string, string>;
          bodies.push(body);
          return json({ run_id: `run_${bodies.length}`, status: 'started' }, 202);
        }
        if (failPoll) { failPoll = false; throw new Error('poll lost'); }
        return json({ run_id: pathname.split('/').at(-1), status: 'completed', output: '{"stop":true}' });
      });
      const make = () => hermesTurn({ apiUrl: 'http://127.0.0.1:8642', apiKey: 'key', agentId: 'hermes_agent',
        runs: state.runs, replies: state.replies, fetch: fetcher, pollIntervalMs: 1 });
      await expect(make()(message('msg_1', 'case_1'), new AbortController().signal)).rejects.toThrow('poll lost');
      expect((await state.runs.load('msg_1'))?.runId).toBe('run_1');
      await expect(make()(message('msg_1', 'case_1'), new AbortController().signal)).resolves.toEqual({ stop: true });
      await expect(make()(message('msg_2', 'case_1'), new AbortController().signal)).resolves.toEqual({ stop: true });
      expect(bodies).toHaveLength(2);
      expect(bodies[0].session_id).not.toBe(bodies[1].session_id);
    } finally { await state.cleanup(); }
  });

  it('keeps polling the same admitted run through temporary status errors', async () => {
    const state = await fixture();
    try {
      const responses = [
        json({ run_id: 'run_retry', status: 'started' }, 202),
        json({}, 503),
        json({ run_id: 'run_retry', status: 'completed', output: '{"stop":true}' })
      ];
      const fetcher = vi.fn<typeof fetch>(async () => responses.shift()!);
      const turn = hermesTurn({ apiUrl: 'http://127.0.0.1:8642', apiKey: 'key', agentId: 'hermes_agent',
        runs: state.runs, replies: state.replies, fetch: fetcher, pollIntervalMs: 1 });
      await expect(turn(message('msg_1', 'case_1'), new AbortController().signal)).resolves.toEqual({ stop: true });
      expect(fetcher.mock.calls.map(([url, init]) => [new URL(String(url)).pathname, init?.method])).toEqual([
        ['/v1/runs', 'POST'], ['/v1/runs/run_retry', 'GET'], ['/v1/runs/run_retry', 'GET']
      ]);
      expect(await state.replies.replyFor('msg_1')).toEqual({ stop: true });
    } finally { await state.cleanup(); }
  });

  it('does not resubmit after Hermes idempotency retention can no longer be relied on', async () => {
    const state = await fixture();
    try {
      await state.runs.create('msg_1', { input: 'original', session_id: 'case_one' });
      const filename = path.join(state.directory, 'work', 'msg_1.hermes.json');
      const record = JSON.parse(await readFile(filename, 'utf8')) as Record<string, unknown>;
      await writeFile(filename, JSON.stringify({ ...record, attemptedAt: new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString() }));
      const fetcher = vi.fn<typeof fetch>();
      const turn = hermesTurn({ apiUrl: 'http://127.0.0.1:8642', apiKey: 'key', agentId: 'hermes_agent',
        runs: state.runs, replies: state.replies, fetch: fetcher });
      await expect(turn(message('msg_1', 'case_1'), new AbortController().signal)).rejects.toThrow('operator recovery');
      expect(fetcher).not.toHaveBeenCalled();
    } finally { await state.cleanup(); }
  });

  it.each(['failed', 'cancelled'] as const)('never restarts a %s run, rejects malformed output, and requests stop on lease loss', async initialStatus => {
    const state = await fixture();
    try {
      let status: 'failed' | 'cancelled' | 'completed' | 'running' = initialStatus;
      const calls: string[] = [];
      const fetcher = vi.fn<typeof fetch>(async (url) => {
        const pathname = new URL(String(url)).pathname;
        calls.push(pathname);
        if (pathname === '/v1/runs') return json({ run_id: 'run_one', status: 'started' }, 202);
        if (pathname.endsWith('/stop')) return json({ status: 'stopping' });
        return json({ run_id: 'run_one', status, output: status === 'completed' ? '{"text":12}' : undefined });
      });
      const make = () => hermesTurn({ apiUrl: 'http://127.0.0.1:8642', apiKey: 'key', agentId: 'hermes_agent',
        runs: state.runs, replies: state.replies, fetch: fetcher, pollIntervalMs: 1 });
      await expect(make()(message('msg_1', 'case_1'), new AbortController().signal)).rejects.toThrow(`ended ${initialStatus}`);
      await expect(make()(message('msg_1', 'case_1'), new AbortController().signal)).rejects.toThrow(`ended ${initialStatus}`);
      expect(calls.filter(pathname => pathname === '/v1/runs')).toHaveLength(1);
      status = 'completed';
      await expect(make()(message('msg_1', 'case_1'), new AbortController().signal)).rejects.toThrow('invalid reply');
      status = 'running';
      const controller = new AbortController();
      const pending = make()(message('msg_1', 'case_1'), controller.signal);
      await new Promise(resolve => setTimeout(resolve, 10));
      controller.abort();
      await expect(pending).rejects.toThrow('interrupted');
      expect(calls).toContain('/v1/runs/run_one/stop');
      expect(await state.replies.replyFor('msg_1')).toBeNull();
    } finally { await state.cleanup(); }
  });

  it('uses the saved reply after a settlement retry without another Hermes run', async () => {
    const state = await fixture();
    try {
      let providerCalls = 0;
      const fetcher = vi.fn<typeof fetch>(async (url) => {
        if (new URL(String(url)).pathname === '/v1/runs') { providerCalls++; return json({ run_id: 'run_one', status: 'started' }, 202); }
        return json({ run_id: 'run_one', status: 'completed', output: 'One canonical reply' });
      });
      const turn = hermesTurn({ apiUrl: 'http://127.0.0.1:8642', apiKey: 'key', agentId: 'hermes_agent',
        runs: state.runs, replies: state.replies, fetch: fetcher });
      const handler = bridgeHandler(state.replies, turn);
      const work = message('msg_1', 'case_1');
      const sent: string[] = [];
      const context = { signal: new AbortController().signal, reply: async (_text: string, key: string) => { sent.push(key); } };
      await handler.admit(work);
      await handler.process(work, context);
      await handler.process(work, context);
      expect(providerCalls).toBe(1);
      expect(sent).toEqual(['bridge:msg_1:reply:1', 'bridge:msg_1:reply:1']);
    } finally { await state.cleanup(); }
  });

  it('persists a stop before settlement when a Hermes MCP reply was already sent', async () => {
    const state = await fixture();
    try {
      const fetcher = vi.fn<typeof fetch>(async (url) => new URL(String(url)).pathname === '/v1/runs'
        ? json({ run_id: 'run_one', status: 'started' }, 202)
        : json({ run_id: 'run_one', status: 'completed', output: '{"text":"Duplicate","intent":"message"}' }));
      const turn = hermesTurn({ apiUrl: 'http://127.0.0.1:8642', apiKey: 'key', agentId: 'hermes_agent',
        runs: state.runs, replies: state.replies, fetch: fetcher,
        mcpReplySent: async () => true, allowEnvoiMcpWrites: true });
      const handler = bridgeHandler(state.replies, turn);
      const send = vi.fn(async () => {});
      const work = message('msg_1', 'case_1');
      await handler.admit(work);
      await handler.process(work, { signal: new AbortController().signal, reply: send });
      expect(await state.replies.replyFor('msg_1')).toEqual({ stop: true });
      await handler.process(work, { signal: new AbortController().signal, reply: send });
      expect(send).not.toHaveBeenCalled();
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { await state.cleanup(); }
  });

  it('settles a recorded MCP reply without waiting for a running provider tail', async () => {
    const state = await fixture();
    try {
      let recorded = false;
      const fetcher = vi.fn<typeof fetch>(async (url) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname === '/v1/runs') return json({ run_id: 'run_one', status: 'started' }, 202);
        if (pathname.endsWith('/stop')) return json({});
        recorded = true;
        return json({ run_id: 'run_one', status: 'running' });
      });
      const turn = hermesTurn({ apiUrl: 'http://127.0.0.1:8642', apiKey: 'key', agentId: 'hermes_agent',
        runs: state.runs, replies: state.replies, fetch: fetcher, pollIntervalMs: 1, maxRunMs: 1000,
        mcpReplySent: async () => recorded, allowEnvoiMcpWrites: true });
      await expect(turn(message('msg_1', 'case_1'), new AbortController().signal)).resolves.toEqual({ stop: true });
      expect(await state.replies.replyFor('msg_1')).toEqual({ stop: true });
      expect(fetcher.mock.calls.filter(call => String(call[0]).endsWith('/stop'))).toHaveLength(1);
      expect(fetcher.mock.calls.filter(call => String(call[0]).endsWith('/run_one'))).toHaveLength(1);
    } finally { await state.cleanup(); }
  });

  it.each(['marker', 'stop'])('does not settle when the lease is aborted during %s', async stage => {
    const state = await fixture();
    try {
      const controller = new AbortController();
      const fetcher = vi.fn<typeof fetch>(async url => {
        if (String(url).endsWith('/v1/runs')) return json({ run_id: 'run_one', status: 'started' }, 202);
        if (stage === 'stop') controller.abort();
        return json({});
      });
      const turn = hermesTurn({ apiUrl: 'http://127.0.0.1:8642', apiKey: 'key', agentId: 'hermes_agent',
        runs: state.runs, replies: state.replies, fetch: fetcher,
        mcpReplySent: async () => { if (stage === 'marker') controller.abort(); return true; }, allowEnvoiMcpWrites: true });
      await expect(turn(message('msg_1', 'case_1'), controller.signal)).rejects.toThrow('interrupted');
      expect(await state.replies.replyFor('msg_1')).toBeNull();
    } finally { await state.cleanup(); }
  });

  it('does not shortcut a human instruction with a native MCP reply marker', async () => {
    const state = await fixture();
    try {
      let polls = 0;
      const marker = vi.fn(async () => true);
      const fetcher = vi.fn<typeof fetch>(async url => {
        if (String(url).endsWith('/v1/runs')) return json({ run_id: 'run_one', status: 'started' }, 202);
        polls++;
        return json({ run_id: 'run_one', status: polls === 1 ? 'running' : 'completed', output: 'Human reply' });
      });
      const turn = hermesTurn({ apiUrl: 'http://127.0.0.1:8642', apiKey: 'key', agentId: 'hermes_agent',
        runs: state.runs, replies: state.replies, fetch: fetcher, pollIntervalMs: 1,
        mcpReplySent: marker, allowEnvoiMcpWrites: true });
      await expect(turn({ id: 'instruction_one', kind: 'humanInstruction', senderType: 'human', senderHumanId: 'human_one',
        recipientAgentId: 'hermes_agent', recipientInboxId: 'inbox_one', from: { humanId: 'human_one' },
        caseId: 'case_one', type: 'instruction', text: 'Help me' }, new AbortController().signal))
        .resolves.toEqual({ text: 'Human reply', intent: 'message' });
      expect(marker).not.toHaveBeenCalled();
      expect(polls).toBe(2);
    } finally { await state.cleanup(); }
  });

  it('rejects insecure remote Hermes API URLs', async () => {
    const state = await fixture();
    try {
      expect(() => hermesTurn({ apiUrl: 'http://remote.example.test', apiKey: 'key', agentId: 'hermes_agent',
        runs: state.runs, replies: state.replies })).toThrow('HTTPS or loopback');
    } finally { await state.cleanup(); }
  });
});
