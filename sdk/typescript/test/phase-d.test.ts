import { describe, expect, it, vi } from 'vitest';
import { EnvoiClient } from '../src/index';
import a2aFixture from '../../../test/contract-fixtures/phase-d/a2a-immediate-text.json';
import discoveryFixture from '../../../test/contract-fixtures/phase-d/discovery-exact.json';
import schemas from '../../../test/contract-fixtures/phase-d/schemas.json';

describe('phase-d v1 client contract', () => {
  it('consumes exact discovery without turning trust into send authority', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      agentId: discoveryFixture.given.target.agentId,
      address: discoveryFixture.given.address,
      trust: discoveryFixture.expect.trust,
      grants: []
    }), { status: 200 }));
    const client = new EnvoiClient('https://api.example', 'agent-token', { fetch: fetcher as typeof fetch });
    const found = await client.discoverAgent(discoveryFixture.given.address);
    expect(found.trust).toBe(schemas['x-trust-precedence'][0]);
    expect(found.grants).toEqual([]);
    expect(fetcher.mock.calls[0][0]).toContain(`address=${encodeURIComponent(discoveryFixture.given.address)}`);
    expect(() => client.discoverOrganization(51)).toThrow(RangeError);
  });

  it('sends the approved immediate text subset and reuses the caller-persisted ID', async () => {
    const calls: Array<{ url: string; headers: Headers; body: unknown }> = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ task: a2aFixture.expect.task }), { status: 200 });
    });
    const client = new EnvoiClient('https://api.example', 'agent-token', { fetch: fetcher as typeof fetch });
    const { address, message } = a2aFixture.given;
    const first = await client.sendA2AText(address, message.messageId, message.parts[0].text);
    const replay = await client.sendA2AText(address, message.messageId, message.parts[0].text);
    expect(first.task).toEqual(a2aFixture.expect.task);
    expect(replay.task.id).toBe(first.task.id);
    expect(calls.map(call => call.body)).toEqual([calls[0].body, calls[0].body]);
    expect(calls[0].headers.get('authorization')).toBe('Bearer agent-token');
    expect(calls[0].headers.get('content-type')).toBe(a2aFixture.given.contentType);
    expect(calls[0].url).toContain(encodeURIComponent(address));
    expect(() => client.sendA2AText(address, '', 'Hello')).toThrow('persisted messageId');
  });

  it('surfaces structured A2A denials without exposing credentials', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'AGENT_NOT_FOUND', message: 'Agent not found' } }), { status: 404 }));
    const client = new EnvoiClient('https://api.example', 'secret-agent-token', { fetch: fetcher as typeof fetch });
    await expect(client.getA2ACard('blocked@agents.example.test')).rejects.toMatchObject({ status: 404, code: 'AGENT_NOT_FOUND', message: 'Agent not found' });
    await expect(client.getA2ACard('blocked@agents.example.test')).rejects.not.toThrow('secret-agent-token');
  });

  it('reads the direct Task body required by the A2A HTTP binding', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(a2aFixture.expect.task), { status: 200 }));
    const client = new EnvoiClient('https://api.example', 'agent-token', { fetch: fetcher as typeof fetch });
    const task = await client.getA2ATask(a2aFixture.given.address, a2aFixture.expect.task.id);
    expect(task).toEqual(a2aFixture.expect.task);
  });
});
