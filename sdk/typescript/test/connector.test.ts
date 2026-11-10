import { describe, expect, it, vi } from 'vitest';
import { ConnectorContractError, ConnectorCredentialsError, ConnectorEnrollmentError, ConnectorPersistenceError, enrollConnector, EnvoiConnector, type ConnectorSession, type ConnectorStore, type WorkHandler } from '@envoi/protocol/connector';
import { EnvoiError } from '@envoi/protocol';

const session = (): ConnectorSession => ({
  agentId: 'agent_one', inboxId: 'inbox_one', address: 'one@envoi.mail',
  agentApiToken: 'access-one', agentRefreshToken: 'refresh-one',
  agentTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  agentRefreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(), cursor: null
});

function memoryStore(initial: ConnectorSession | null = null) {
  let value = initial;
  const store: ConnectorStore = {
    load: async () => value,
    save: async next => { value = structuredClone(next); }
  };
  return { store, current: () => value };
}

describe('Envoi outbound connector', () => {
  it('persists rotation before transmission and recovers the same successor after a lost response and restart', async () => {
    const memory = memoryStore({ ...session(), agentTokenExpiresAt: new Date(Date.now() - 1_000).toISOString() });
    let firstRotationId: string | undefined;
    let requests = 0;
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.example/api/agent-token');
      const request = JSON.parse(String(init?.body));
      expect(request.agentRefreshToken).toBe('refresh-one');
      expect(request.rotationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(memory.current()?.pendingRotation?.rotationId).toBe(request.rotationId);
      firstRotationId ??= request.rotationId;
      expect(request.rotationId).toBe(firstRotationId);
      requests += 1;
      if (requests === 1) throw new Error('Response lost after server committed');
      return Response.json({ agentApiToken: 'access-two', agentRefreshToken: 'refresh-two',
        agentTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
        agentRefreshTokenExpiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() });
    });
    const first = new EnvoiConnector('https://api.example', memory.store, { fetch: fetcher as typeof fetch });
    await expect(first.currentAccessToken()).rejects.toBeInstanceOf(EnvoiError);
    expect(memory.current()?.pendingRotation?.rotationId).toBe(firstRotationId);
    expect(memory.current()?.agentRefreshToken).toBe('refresh-one');
    const restarted = new EnvoiConnector('https://api.example', memory.store, { fetch: fetcher as typeof fetch });
    expect(await restarted.currentAccessToken()).toBe('access-two');
    expect(memory.current()?.agentRefreshToken).toBe('refresh-two');
    expect(memory.current()?.pendingRotation).toBeUndefined();
    expect(requests).toBe(2);
  });

  it('does not transmit a refresh when pending rotation cannot be saved', async () => {
    const original = { ...session(), agentTokenExpiresAt: new Date(Date.now() - 1_000).toISOString() };
    const fetcher = vi.fn();
    const store: ConnectorStore = { load: async () => original, save: async () => { throw new Error('private-file-path'); } };
    const connector = new EnvoiConnector('https://api.example', store, { fetch: fetcher as typeof fetch });
    await expect(connector.currentAccessToken()).rejects.toBeInstanceOf(ConnectorPersistenceError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refreshes case operations and stops after credential revocation', async () => {
    const memory = memoryStore(session());
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/api/agent-token')) return new Response(JSON.stringify({
        agentApiToken: 'access-two', agentRefreshToken: 'refresh-two',
        agentTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        agentRefreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString()
      }), { status: 200 });
      const auth = new Headers(init?.headers).get('authorization');
      if (auth === 'Bearer access-one') return new Response(JSON.stringify({ code: 'ACCESS_TOKEN_EXPIRED', error: 'ACCESS_TOKEN_EXPIRED', message: 'Expired' }), { status: 401 });
      if (String(url).includes('/asset-uploads')) {
        expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('asset-a-1');
        return new Response(JSON.stringify({ error: 'Revoked' }), { status: 403 });
      }
      const body = JSON.parse(String(init?.body));
      expect(body.senderAgentId).toBe('agent_one');
      expect(body.caseId).toBe('case_new');
      return new Response(JSON.stringify({ caseId: 'case_new', status: 'queued' }), { status: 202 });
    });
    const connector = new EnvoiConnector('https://api.example', memory.store, { fetch: fetcher as typeof fetch });
    await connector.startCase('stable-case-key', { caseId: 'case_new', recipientEmail: 'peer@envoi.mail', text: 'Hello' });
    expect(memory.current()?.agentRefreshToken).toBe('refresh-two');
    await expect(connector.beginAssetUpload('asset-a-1', { filename: 'a.txt', mimeType: 'text/plain', size: 1, checksumSha256: 'abc' })).rejects.toMatchObject({ status: 403 });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('rotates a rejected access token before retrying MCP and keeps the refresh token local', async () => {
    const memory = memoryStore(session());
    const request = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/api/agent-token')) {
        expect(JSON.parse(String(init?.body)).agentRefreshToken).toBe('refresh-one');
        return new Response(JSON.stringify({
          agentApiToken: 'access-two', agentRefreshToken: 'refresh-two',
          agentTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          agentRefreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString()
        }));
      }
      expect(String(url)).toBe('https://api.example/mcp');
      expect(String(init?.body)).toBe(request);
      expect(new Headers(init?.headers).get('accept')).toContain('text/event-stream');
      expect(JSON.stringify(init?.headers)).not.toContain('refresh-one');
      const auth = new Headers(init?.headers).get('authorization');
      if (auth === 'Bearer access-one') return Response.json({ code: 'ACCESS_TOKEN_EXPIRED', message: 'Expired' }, { status: 401 });
      expect(auth).toBe('Bearer access-two');
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }));
    });
    const connector = new EnvoiConnector('https://api.example', memory.store, { fetch: fetcher as typeof fetch });
    const response = await connector.forwardMcpRequest(request);
    expect(response.ok).toBe(true);
    expect(memory.current()?.agentRefreshToken).toBe('refresh-two');
    expect(await connector.currentAccessToken()).toBe('access-two');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('refreshes before handing xAI a token that could expire late in its turn', async () => {
    const memory = memoryStore({ ...session(), agentTokenExpiresAt: new Date(Date.now() + 90_000).toISOString() });
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.example/api/agent-token');
      expect(JSON.parse(String(init?.body)).agentRefreshToken).toBe('refresh-one');
      return new Response(JSON.stringify({
        agentApiToken: 'access-two', agentRefreshToken: 'refresh-two',
        agentTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
        agentRefreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString()
      }));
    });
    const connector = new EnvoiConnector('https://api.example', memory.store, { fetch: fetcher as typeof fetch });
    expect(await connector.currentAccessToken(180_000)).toBe('access-two');
    expect(memory.current()?.agentRefreshToken).toBe('refresh-two');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('mints a case-scoped provider MCP credential after refreshing agent access', async () => {
    const memory = memoryStore(session());
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/api/agent-token')) return new Response(JSON.stringify({
        agentApiToken: 'access-two', agentRefreshToken: 'refresh-two',
        agentTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
        agentRefreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString()
      }));
      expect(String(url)).toBe('https://api.example/api/agent/mcp-read-token');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ caseId: 'case_one' });
      const authorization = new Headers(init?.headers).get('authorization');
      expect(JSON.stringify(init?.body)).not.toContain('refresh-one');
      if (authorization === 'Bearer access-one') return Response.json({ code: 'ACCESS_TOKEN_EXPIRED', message: 'Expired' }, { status: 401 });
      expect(authorization).toBe('Bearer access-two');
      return new Response(JSON.stringify({ mcpAccessToken: 'mcp-read-one', tokenType: 'Bearer',
        scope: 'case_read', caseId: 'case_one', expiresAt: new Date(Date.now() + 300_000).toISOString() }), { status: 201 });
    });
    const connector = new EnvoiConnector('https://api.example', memory.store, { fetch: fetcher as typeof fetch });
    expect((await connector.mintMcpReadToken('case_one')).mcpAccessToken).toBe('mcp-read-one');
    expect(memory.current()?.agentRefreshToken).toBe('refresh-two');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('rejects a provider MCP credential with the wrong case or insufficient lifetime', async () => {
    const memory = memoryStore(session());
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ mcpAccessToken: 'mcp-read-one',
      tokenType: 'Bearer', scope: 'case_read', caseId: 'other_case',
      expiresAt: new Date(Date.now() + 30_000).toISOString() }), { status: 201 }));
    const connector = new EnvoiConnector('https://api.example', memory.store, { fetch: fetcher as typeof fetch });
    await expect(connector.mintMcpReadToken('case_one')).rejects.toThrow('invalid or short-lived');
  });

  it('preserves a refresh token rotated inside an event callback when saving the cursor', async () => {
    const memory = memoryStore(session());
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/api/agent-token')) return new Response(JSON.stringify({
        agentApiToken: 'access-two', agentRefreshToken: 'refresh-two',
        agentTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        agentRefreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString()
      }), { status: 200 });
      if (String(url).includes('/events/delta')) return new Response(JSON.stringify({ events: [{ id: 'evt_one', type: 'message.delivered', cursor: '0001' }], nextCursor: '0001', hasMore: false }), { status: 200 });
      return new Response(JSON.stringify({ status: 'queued' }), { status: 202 });
    });
    let connector: EnvoiConnector;
    connector = new EnvoiConnector('https://api.example', memory.store, { fetch: fetcher as typeof fetch, onEvent: async () => {
      const current = memory.current();
      if (!current) throw new Error('Session missing');
      await memory.store.save({ ...current, agentTokenExpiresAt: new Date(Date.now() - 1_000).toISOString() });
      await connector.sendCaseEvent('callback-key', { caseId: 'case_one', recipientEmail: 'peer@envoi.mail', text: 'Reply' });
    } });
    await connector.pollOnce();
    expect(memory.current()).toMatchObject({ agentRefreshToken: 'refresh-two', cursor: '0001' });
  });

  it('redeems the existing one-use code and persists credentials before returning', async () => {
    const memory = memoryStore();
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ enrollmentToken: 'one-time-code', name: 'Worker' });
      return new Response(JSON.stringify({ agent: { id: 'agent_one', address: 'one@envoi.mail' }, inbox: { id: 'inbox_one' }, ...session() }), { status: 201 });
    });
    const enrolled = await enrollConnector('https://api.example/', 'one-time-code', memory.store, { name: 'Worker', fetch: fetcher as typeof fetch });
    expect(enrolled.cursor).toBeNull();
    expect(memory.current()).toEqual(enrolled);
    expect(String(fetcher.mock.calls[0][0])).toBe('https://api.example/api/agent-enroll');
  });

  it('retains safe HTTP diagnostics and sends its own request ID without exposing a rejection body', async () => {
    const memory = memoryStore();
    let requestId: string | null = null;
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestId = new Headers(init?.headers).get('x-request-id');
      return Response.json({ error: 'private-enrollment-secret and private-server-body', requestId: 'private-provider-secret' }, { status: 503 });
    });
    const error = await enrollConnector('https://api.example', 'private-enrollment-secret', memory.store, { fetch: fetcher as typeof fetch }).catch(error => error);
    expect(error).toBeInstanceOf(ConnectorEnrollmentError);
    expect(error).toMatchObject({ status: 503, code: 'ENROLLMENT_HTTP_ERROR', requestId });
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(error) + error.message).not.toMatch(/private-/);
    expect(memory.current()).toBeNull(); expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('distinguishes transport failure, malformed credentials and failure to save successful enrollment', async () => {
    const memory = memoryStore();
    await expect(enrollConnector('https://api.example', 'secret', memory.store, { fetch: (async () => { throw new Error('private transport body'); }) as typeof fetch }))
      .rejects.toMatchObject({ code: 'ENROLLMENT_TRANSPORT_FAILED' });
    await expect(enrollConnector('https://api.example', 'secret', memory.store, { fetch: (async () => Response.json({ agentApiToken: 'secret' }, { status: 201 })) as typeof fetch }))
      .rejects.toMatchObject({ code: 'ENROLLMENT_RESPONSE_INVALID', status: 201 });
    const brokenStore = { ...memory.store, save: async () => { throw new Error('private storage details'); } };
    await expect(enrollConnector('https://api.example', 'secret', brokenStore, { fetch: (async () => Response.json({ agent: { id: 'agent_one', address: 'one@envoi.mail' }, inbox: { id: 'inbox_one' }, ...session() }, { status: 201 })) as typeof fetch }))
      .rejects.toMatchObject({ name: 'ConnectorPersistenceError', status: 201, requestId: expect.any(String) });
    expect(memory.current()).toBeNull();
  });

  it('bounds enrollment response-body reading after headers arrive', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Response(new ReadableStream({
      start(controller) { init!.signal!.addEventListener('abort', () => controller.error(new Error('private timeout body')), { once: true }); }
    }), { status: 201 }));
    await expect(enrollConnector('https://api.example', 'secret', memoryStore().store, { fetch: fetcher as typeof fetch, timeoutMs: 20 }))
      .rejects.toMatchObject({ code: 'ENROLLMENT_TIMEOUT', status: 201 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('replays an offline delivered event and commits the cursor only after the callback', async () => {
    const memory = memoryStore(session());
    const seen: string[] = [];
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      events: [{ id: 'evt_one', type: 'message.delivered', cursor: '0001', messageId: 'msg_one' }],
      nextCursor: '0001', hasMore: false
    }), { status: 200 }));
    const connector = new EnvoiConnector('https://api.example', memory.store, {
      fetch: fetcher as typeof fetch,
      onEvent: event => { expect(memory.current()?.cursor).toBeNull(); seen.push(event.id); }
    });
    expect(await connector.pollOnce()).toEqual({ count: 1, hasMore: false });
    expect(seen).toEqual(['evt_one']);
    expect(memory.current()?.cursor).toBe('0001');
    expect(String(fetcher.mock.calls[0][0])).toContain('/events/delta?limit=100');
  });

  it('leaves the cursor in place when the callback fails so restart can replay', async () => {
    const memory = memoryStore(session());
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ events: [{ id: 'evt_one', type: 'message.delivered', cursor: '0001' }], nextCursor: '0001', hasMore: false }), { status: 200 }));
    const connector = new EnvoiConnector('https://api.example', memory.store, { fetch: fetcher as typeof fetch, onEvent: () => { throw new Error('handler unavailable'); } });
    await expect(connector.pollOnce()).rejects.toThrow('handler unavailable');
    expect(memory.current()?.cursor).toBeNull();
  });

  it('rotates expiring credentials, stores the new refresh token, then resumes from the saved cursor', async () => {
    const old = { ...session(), agentTokenExpiresAt: new Date(Date.now() + 5_000).toISOString(), cursor: '0001' };
    const memory = memoryStore(old);
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/api/agent-token')) {
        expect(JSON.parse(String(init?.body)).agentRefreshToken).toBe('refresh-one');
        return new Response(JSON.stringify({ agentApiToken: 'access-two', agentRefreshToken: 'refresh-two', agentTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), agentRefreshTokenExpiresAt: old.agentRefreshTokenExpiresAt }), { status: 200 });
      }
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer access-two');
      expect(String(url)).toContain('cursor=0001');
      return new Response(JSON.stringify({ events: [], nextCursor: '0001', hasMore: false }), { status: 200 });
    });
    const connector = new EnvoiConnector('https://api.example', memory.store, { fetch: fetcher as typeof fetch });
    expect(await connector.pollOnce()).toEqual({ count: 0, hasMore: false });
    expect(memory.current()?.agentRefreshToken).toBe('refresh-two');
  });

  it('rotates once after ACCESS_TOKEN_EXPIRED on delta and retries with the new access token', async () => {
    const memory = memoryStore(session());
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/api/agent-token')) return new Response(JSON.stringify({
        agentApiToken: 'access-two', agentRefreshToken: 'refresh-two',
        agentTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        agentRefreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString()
      }), { status: 200 });
      if (new Headers(init?.headers).get('authorization') === 'Bearer access-one') return new Response(JSON.stringify({ code: 'ACCESS_TOKEN_EXPIRED', error: 'ACCESS_TOKEN_EXPIRED', message: 'Expired' }), { status: 401 });
      return new Response(JSON.stringify({ events: [], nextCursor: null, hasMore: false }), { status: 200 });
    });
    const connector = new EnvoiConnector('https://api.example', memory.store, { fetch: fetcher as typeof fetch });
    expect(await connector.pollOnce()).toEqual({ count: 0, hasMore: false });
    expect(memory.current()?.agentRefreshToken).toBe('refresh-two');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('stops after a rotated token cannot be persisted', async () => {
    const old = { ...session(), agentTokenExpiresAt: new Date(Date.now() - 1_000).toISOString() };
    let persisted: ConnectorSession = old;
    let saves = 0;
    const store: ConnectorStore = { load: async () => persisted, save: async next => {
      saves += 1;
      if (saves === 2) throw new Error('disk full');
      persisted = next;
    } };
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ agentApiToken: 'next', agentRefreshToken: 'next-refresh', agentTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), agentRefreshTokenExpiresAt: old.agentRefreshTokenExpiresAt }), { status: 200 }));
    const connector = new EnvoiConnector('https://api.example', store, { fetch: fetcher as typeof fetch });
    await expect(connector.pollOnce()).rejects.toBeInstanceOf(ConnectorPersistenceError);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(persisted.pendingRotation?.rotationId).toBeTruthy();
  });

  it('fails promptly when the rotating refresh credential has expired', async () => {
    const memory = memoryStore({ ...session(), agentTokenExpiresAt: new Date(Date.now() - 1_000).toISOString(), agentRefreshTokenExpiresAt: new Date(Date.now() - 1_000).toISOString() });
    const fetcher = vi.fn();
    const connector = new EnvoiConnector('https://api.example', memory.store, { fetch: fetcher as typeof fetch });
    await expect(connector.run(new AbortController().signal)).rejects.toBeInstanceOf(ConnectorCredentialsError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not retry a revoked credential while sending a case event', async () => {
    const memory = memoryStore(session());
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: 'Revoked' }), { status: 403 }));
    const connector = new EnvoiConnector('https://api.example', memory.store, { fetch: fetcher as typeof fetch });
    await expect(connector.sendCaseEvent('stable-key', { caseId: 'case_one', recipientEmail: 'peer@envoi.mail', text: 'Hello' })).rejects.toMatchObject({ status: 403 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects non-TLS remote endpoints before sending an enrollment secret', async () => {
    const fetcher = vi.fn();
    await expect(enrollConnector('http://api.example', 'secret', memoryStore().store, { fetch: fetcher as typeof fetch })).rejects.toThrow(/HTTPS/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('claims, durably admits, acknowledges, invokes the handler, replies, and completes under one fence', async () => {
    const memory = memoryStore(session());
    const order: string[] = [];
    const message = { id: 'msg_one', senderAgentId: 'agent_two', recipientAgentId: 'agent_one', from: { agentId: 'agent_two', address: 'two@envoi.mail' }, caseId: 'case_one', text: 'Can we meet?', status: 'delivered' };
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      const body = JSON.parse(String(init?.body));
      if (path.endsWith('/work/claim')) { order.push('claim'); return new Response(JSON.stringify({ work: { workId: 'work_one', message, leaseToken: 'fence_one', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() } })); }
      if (path.endsWith('/work/work_one/acknowledge')) {
        order.push('ack'); expect(body).toEqual({ leaseToken: 'fence_one' });
        expect(new Headers(init?.headers).get('Idempotency-Key')).toMatch(/^connector:msg_one:[a-f0-9-]+:ack$/);
        return new Response(JSON.stringify({ workId: 'work_one', status: 'acknowledged', receipt: { id: 'receipt_ack', messageId: 'msg_one', state: 'acknowledged' } }));
      }
      if (path.endsWith('/messages')) {
        order.push('reply'); expect(body).toMatchObject({ senderAgentId: 'agent_one', recipientEmail: 'two@envoi.mail', caseId: 'case_one', text: 'Yes' });
        expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('reply-msg-one-1');
        return new Response(JSON.stringify({ id: 'msg_reply' }));
      }
      if (path.endsWith('/work/work_one/complete')) {
        order.push('complete'); expect(body).toEqual({ leaseToken: 'fence_one' });
        expect(new Headers(init?.headers).get('Idempotency-Key')).toMatch(/^connector:msg_one:[a-f0-9-]+:complete$/);
        return new Response(JSON.stringify({ workId: 'work_one', status: 'processed', receipt: { id: 'receipt_processed', messageId: 'msg_one', state: 'processed' } }));
      }
      throw new Error(`Unexpected route ${path}`);
    });
    const connector = new EnvoiConnector('https://api.example', memory.store, {
      fetch: fetcher as typeof fetch,
      handler: {
        admit: async () => { order.push('admit'); },
        process: async (_message, context) => { order.push('process'); await context.reply('Yes', 'reply-msg-one-1'); }
      }
    });
    expect(await connector.processWorkOnce()).toBe(true);
    expect(order).toEqual(['claim', 'admit', 'ack', 'process', 'reply', 'complete']);
  });

  it('posts a group assignment reply under the existing case and references the canonical message', async () => {
    const memory = memoryStore(session());
    const message = {
      id: 'msg_assignment', caseId: 'case_group', senderAgentId: 'agent_two', recipientAgentId: 'agent_one',
      from: { agentId: 'agent_two', address: 'two@envoi.mail' }, text: 'Investigate this',
      groupCase: { messageId: 'msg_canonical', memberAgentIds: ['agent_one', 'agent_two', 'agent_three'] }
    };
    const fetcher: typeof fetch = async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/claim')) return Response.json({ work: {
        workId: message.id, message, leaseToken: 'fence_one', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
      } });
      if (path === '/api/agent/group-cases/case_group/messages') {
        expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('reply-group-1');
        expect(JSON.parse(String(init?.body))).toEqual({ text: 'Here is the result', inReplyTo: 'msg_canonical' });
        return Response.json({ id: 'msg_group_reply', caseId: 'case_group' });
      }
      if (path.endsWith('/acknowledge') || path.endsWith('/complete')) {
        const state = path.endsWith('/acknowledge') ? 'acknowledged' : 'processed';
        return Response.json({ workId: message.id, status: state, receipt: { messageId: message.id, state } });
      }
      throw new Error(`Unexpected route ${path}`);
    };
    const process = vi.fn(async (_message: unknown, context: Parameters<WorkHandler['process']>[1]) => {
      expect(await context.reply('Here is the result', 'reply-group-1')).toMatchObject({ caseId: 'case_group' });
    });
    const connector = new EnvoiConnector('https://api.example', memory.store, { fetch: fetcher, handler: { admit: async () => {}, process } });
    expect(await connector.processWorkOnce()).toBe(true);
    expect(process).toHaveBeenCalledOnce();
  });

  it('reports handler failure through a retryable fenced fail without sending raw error text', async () => {
    const memory = memoryStore(session());
    const paths: string[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      paths.push(path);
      if (path.endsWith('/work/claim')) return new Response(JSON.stringify({ work: { workId: 'work_one', message: { id: 'msg_one', recipientAgentId: 'agent_one', from: { address: 'two@envoi.mail' }, text: 'hello', status: 'delivered' }, leaseToken: 'fence_one', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() } }));
      if (path.endsWith('/work/work_one/acknowledge')) return new Response(JSON.stringify({ workId: 'work_one', status: 'acknowledged', receipt: { messageId: 'msg_one', state: 'acknowledged' } }));
      if (path.endsWith('/work/work_one/fail')) {
        expect(JSON.parse(String(init?.body))).toEqual({ leaseToken: 'fence_one', retryable: true, reasonCode: 'HANDLER_FAILED' });
        return new Response(JSON.stringify({ workId: 'work_one', status: 'retryable' }));
      }
      throw new Error(`Unexpected route ${path}`);
    });
    const connector = new EnvoiConnector('https://api.example', memory.store, { fetch: fetcher as typeof fetch, handler: {
      admit: async () => {}, process: async () => { throw new Error('private-agent-secret'); }
    } });
    await expect(connector.processWorkOnce()).rejects.toThrow('private-agent-secret');
    expect(paths.some(path => path.endsWith('/work/work_one/fail'))).toBe(true);
    expect(paths.some(path => path.endsWith('/work/work_one/complete'))).toBe(false);
  });

  it('does not invoke the runtime when no canonical work is claimable', async () => {
    const memory = memoryStore(session());
    const admit = vi.fn();
    const process = vi.fn();
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ work: null })));
    const connector = new EnvoiConnector('https://api.example', memory.store, { fetch: fetcher as typeof fetch, handler: { admit, process } });
    expect(await connector.processWorkOnce()).toBe(false);
    expect(admit).not.toHaveBeenCalled();
    expect(process).not.toHaveBeenCalled();
  });

  it('stops instead of treating a missing claim endpoint as an empty inbox', async () => {
    const memory = memoryStore(session());
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }));
    const connector = new EnvoiConnector('https://api.example', memory.store, { fetch: fetcher as typeof fetch, handler: { admit: async () => {}, process: async () => {} } });
    await expect(connector.processWorkOnce()).rejects.toBeInstanceOf(ConnectorContractError);
  });

  it('keeps the service alive through empty claims until a delayed handler retry completes once', async () => {
    vi.useFakeTimers();
    const stop = new AbortController();
    let running: Promise<void> | undefined;
    try {
      const memory = memoryStore(session());
      let attempts = 0;
      let retryAt = 0;
      let emptyClaims = 0;
      let failures = 0;
      let replies = 0;
      let completions = 0;
      const message = { id: 'msg_one', recipientAgentId: 'agent_one',
        from: { address: 'two@envoi.mail' }, text: 'hello', status: 'delivered' };
      const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const route = String(url);
        if (route.endsWith('/work/claim')) {
          if (Date.now() < retryAt) {
            emptyClaims += 1;
            return Response.json({ work: null, state: 'idle', nextAvailableInMs: retryAt - Date.now() });
          }
          attempts += 1;
          return new Response(JSON.stringify({ work: { workId: 'work_one', message,
            leaseToken: `fence_${attempts}`, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() } }));
        }
        if (route.endsWith('/work/work_one/acknowledge')) return new Response(JSON.stringify({
          workId: 'work_one', status: 'acknowledged', receipt: { messageId: 'msg_one', state: 'acknowledged' }
        }));
        if (route.endsWith('/work/work_one/fail')) {
          expect(JSON.parse(String(init?.body))).toEqual({ leaseToken: 'fence_1', retryable: true, reasonCode: 'HANDLER_FAILED' });
          failures += 1;
          retryAt = Date.now() + 3_000;
          return new Response(JSON.stringify({ workId: 'work_one', status: 'retryable' }));
        }
        if (route.includes('/events')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
        if (route.endsWith('/messages')) {
          expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('reply-msg-one-1');
          replies += 1;
          return new Response(JSON.stringify({ id: 'msg_reply' }));
        }
        if (route.endsWith('/work/work_one/complete')) {
          expect(JSON.parse(String(init?.body)).leaseToken).toBe('fence_2');
          completions += 1;
          stop.abort();
          return new Response(JSON.stringify({ workId: 'work_one', status: 'processed',
            receipt: { messageId: 'msg_one', state: 'processed' } }));
        }
        throw new Error(`Unexpected route ${route}`);
      });
      const process = vi.fn<WorkHandler['process']>(async (_message, context) => {
        if (attempts === 1) throw new Error('Temporary runtime connection loss');
        await context.reply('Recovered reply', 'reply-msg-one-1');
      });
      const connector = new EnvoiConnector('https://api.example', memory.store, {
        fetch: fetcher as typeof fetch, pollIntervalMs: 100, handler: { admit: async () => {}, process }
      });
      running = connector.run(stop.signal);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(emptyClaims).toBeGreaterThan(0);
      expect(attempts).toBe(2);
      expect(process).toHaveBeenCalledTimes(2);
      expect(failures).toBe(1);
      expect(replies).toBe(1);
      expect(completions).toBe(1);
      await running;
    } finally {
      stop.abort();
      try { await running; }
      finally { vi.useRealTimers(); }
    }
  });

  it('does not let repeated SSE reconnect failures postpone safety polling', async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const stop = new AbortController();
    let running: Promise<void> | undefined;
    try {
      const memory = memoryStore(session());
      let available = false;
      let completed = false;
      let sseFailures = 0;
      let workClaims = 0;
      const process = vi.fn(async () => {});
      const fetcher = vi.fn<typeof fetch>(async url => {
        const route = String(url);
        if (/\/events(?:\?|$)/.test(route)) { sseFailures++; throw new Error('SSE unavailable'); }
        if (route.endsWith('/work/claim')) {
          if (!available || completed) return Response.json({ work: null, state: 'idle' });
          workClaims++;
          return Response.json({ work: { workId: 'work_one', message: { id: 'msg_one', senderAgentId: 'agent_two',
            recipientAgentId: 'agent_one', from: { agentId: 'agent_two', address: 'two@envoi.mail' }, text: 'hello' },
            leaseToken: 'fence_one', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() } });
        }
        if (route.endsWith('/acknowledge')) return Response.json({ workId: 'work_one', status: 'acknowledged', receipt: { messageId: 'msg_one', state: 'acknowledged' } });
        if (route.endsWith('/complete')) {
          completed = true;
          return Response.json({ workId: 'work_one', status: 'processed', receipt: { messageId: 'msg_one', state: 'processed' } });
        }
        throw new Error('Unexpected request');
      });
      const connector = new EnvoiConnector('https://api.example', memory.store, { fetch: fetcher, handler: { admit: async () => {}, process } });
      running = connector.run(stop.signal);
      await vi.advanceTimersByTimeAsync(100);
      available = true;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(sseFailures).toBeGreaterThan(5);
      expect(workClaims).toBe(1);
      expect(process).toHaveBeenCalledTimes(1);
      expect(completed).toBe(true);
    } finally {
      stop.abort();
      try { await running; } finally { random.mockRestore(); vi.useRealTimers(); }
    }
  });

  it.each(['CREDENTIAL_REVOKED', 'CREDENTIAL_EXPIRED'])('still stops on terminal SSE authentication error %s', async code => {
    const memory = memoryStore(session());
    const stop = new AbortController();
    const process = vi.fn(async () => {});
    const fetcher = vi.fn<typeof fetch>(async url => {
      if (/\/events(?:\?|$)/.test(String(url))) return Response.json({ error: code, code }, { status: 401 });
      if (String(url).endsWith('/work/claim')) return Response.json({ work: null, state: 'idle' });
      throw new Error('Unexpected request');
    });
    const connector = new EnvoiConnector('https://api.example', memory.store, { fetch: fetcher, handler: { admit: async () => {}, process } });
    try {
      await expect(connector.run(stop.signal)).rejects.toMatchObject({ code });
      expect(memory.current()?.lifecycle?.state).toBe(code === 'CREDENTIAL_REVOKED' ? 'REVOKED' : 'NEEDS_RECONNECT');
      expect(process).not.toHaveBeenCalled();
    } finally { stop.abort(); }
  });

  it.each(['network', '503'])('survives one transient %s renewal failure without cancelling or rerunning work', async failure => {
    vi.useFakeTimers();
    try {
      const memory = memoryStore(session());
      let renewals = 0;
      const process = vi.fn(async (_message, context) => {
        await new Promise(resolve => setTimeout(resolve, 650));
        expect(context.signal.aborted).toBe(false);
      });
      const fetcher = vi.fn<typeof fetch>(async (url, init) => {
        const route = String(url);
        if (route.endsWith('/claim')) return Response.json({ work: {
          workId: 'work_one', message: { id: 'msg_one', recipientAgentId: 'agent_one', from: { address: 'two@envoi.mail' }, text: 'hello', status: 'delivered' },
          leaseToken: 'fence_one', leaseExpiresAt: new Date(Date.now() + 900).toISOString()
        } });
        if (route.endsWith('/renew')) {
          expect(JSON.parse(String(init?.body))).toEqual({ leaseToken: 'fence_one' });
          if (++renewals === 1) {
            if (failure === 'network') throw new TypeError('fetch failed');
            return Response.json({ message: 'temporarily unavailable' }, { status: 503 });
          }
          return Response.json({ workId: 'work_one', leaseToken: 'fence_one', leaseExpiresAt: new Date(Date.now() + 900).toISOString() });
        }
        if (route.endsWith('/acknowledge')) return Response.json({ workId: 'work_one', status: 'acknowledged', receipt: { messageId: 'msg_one', state: 'acknowledged' } });
        if (route.endsWith('/complete')) return Response.json({ workId: 'work_one', status: 'processed', receipt: { messageId: 'msg_one', state: 'processed' } });
        throw new Error(`Unexpected route ${route}`);
      });
      const connector = new EnvoiConnector('https://api.example', memory.store, { fetch: fetcher, handler: { admit: async () => {}, process } });
      const pending = connector.processWorkOnce();
      const result = expect(pending).resolves.toBe(true);
      await vi.advanceTimersByTimeAsync(700);
      await result;
      expect(renewals).toBe(2);
      expect(process).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/claim'))).toHaveLength(1);
      expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/complete'))).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it.each(['hang', 'revoked', 'paused', 'invalid', 'expired', 'repeated-network'])('stops work safely on %s renewal instead of extending an unconfirmed lease', async failure => {
    vi.useFakeTimers();
    try {
      const memory = memoryStore(session());
      let abortedAt = 0;
      let startedAt = 0;
      const paths: string[] = [];
      const fetcher = vi.fn<typeof fetch>(async (url, init) => {
        const route = String(url);
        paths.push(route);
        if (route.endsWith('/claim')) {
          startedAt = Date.now();
          return Response.json({ work: { workId: 'work_one', message: { id: 'msg_one', recipientAgentId: 'agent_one', from: { address: 'two@envoi.mail' }, text: 'hello', status: 'delivered' },
            leaseToken: 'fence_one', leaseExpiresAt: new Date(Date.now() + 900).toISOString() } });
        }
        if (route.endsWith('/acknowledge')) return Response.json({ workId: 'work_one', status: 'acknowledged', receipt: { messageId: 'msg_one', state: 'acknowledged' } });
        if (route.endsWith('/renew')) {
          if (failure === 'repeated-network') throw new TypeError('network unavailable');
          if (failure === 'revoked') return Response.json({ code: 'CREDENTIAL_REVOKED', message: 'Revoked' }, { status: 401 });
          if (failure === 'paused') return Response.json({ code: 'AGENT_PAUSED', message: 'Paused' }, { status: 409 });
          if (failure === 'expired') return Response.json({ workId: 'work_one', leaseToken: 'fence_one', leaseExpiresAt: new Date(Date.now() - 1).toISOString() });
          if (failure === 'invalid') return Response.json({ workId: 'work_one', leaseToken: 'other_fence', leaseExpiresAt: new Date(Date.now() + 900).toISOString() });
          return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('request cancelled')), { once: true }));
        }
        throw new Error(`Unexpected route ${route}`);
      });
      const connector = new EnvoiConnector('https://api.example', memory.store, { fetch: fetcher, handler: {
        admit: async () => {}, process: async (_message, context) => {
          await new Promise<void>((_resolve, reject) => context.signal.addEventListener('abort', () => {
            abortedAt = Date.now(); reject(new Error('handler interrupted'));
          }, { once: true }));
        }
      } });
      const pending = connector.processWorkOnce();
      const result = expect(pending).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(1000);
      await result;
      expect(abortedAt - startedAt).toBe(failure === 'hang' ? 900 : failure === 'repeated-network' ? 633 : 300);
      expect(paths.filter(route => route.endsWith('/renew'))).toHaveLength(failure === 'repeated-network' ? 3 : 1);
      expect(paths.some(route => route.endsWith('/complete') || route.endsWith('/fail') || route.endsWith('/messages'))).toBe(false);
      if (failure === 'revoked') expect(memory.current()?.lifecycle?.state).toBe('REVOKED');
    } finally { vi.useRealTimers(); }
  });

  it('renews the same fence while a long handler is running', async () => {
    const memory = memoryStore(session());
    let renewals = 0;
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith('/work/claim')) return new Response(JSON.stringify({ work: {
        workId: 'work_one', message: { id: 'msg_one', recipientAgentId: 'agent_one', from: { address: 'two@envoi.mail' }, text: 'hello', status: 'delivered' },
        leaseToken: 'fence_one', leaseExpiresAt: new Date(Date.now() + 250).toISOString()
      } }));
      if (path.endsWith('/work/work_one/renew')) {
        renewals += 1;
        return new Response(JSON.stringify({ workId: 'work_one', leaseToken: 'fence_one', leaseExpiresAt: new Date(Date.now() + 250).toISOString() }));
      }
      if (path.endsWith('/work/work_one/acknowledge')) return new Response(JSON.stringify({ workId: 'work_one', status: 'acknowledged', receipt: { messageId: 'msg_one', state: 'acknowledged' } }));
      if (path.endsWith('/work/work_one/complete')) return new Response(JSON.stringify({ workId: 'work_one', status: 'processed', receipt: { messageId: 'msg_one', state: 'processed' } }));
      throw new Error(`Unexpected route ${path}`);
    });
    const connector = new EnvoiConnector('https://api.example', memory.store, { fetch: fetcher as typeof fetch, handler: {
      admit: async () => {},
      process: async () => { await new Promise(resolve => setTimeout(resolve, 500)); }
    } });
    expect(await connector.processWorkOnce()).toBe(true);
    expect(renewals).toBeGreaterThan(0);
  });

  it('refuses a reply after shutdown invalidates the work lease', async () => {
    const memory = memoryStore(session());
    const stop = new AbortController();
    const paths: string[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const route = String(url);
      paths.push(route);
      if (route.endsWith('/work/claim')) return new Response(JSON.stringify({ work: {
        workId: 'work_one', message: { id: 'msg_one', recipientAgentId: 'agent_one', from: { address: 'two@envoi.mail' }, caseId: 'case_one', text: 'hello', status: 'delivered' },
        leaseToken: 'fence_one', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
      } }));
      if (route.endsWith('/work/work_one/acknowledge')) return new Response(JSON.stringify({ workId: 'work_one', status: 'acknowledged', receipt: { messageId: 'msg_one', state: 'acknowledged' } }));
      throw new Error(`Unexpected route ${route}`);
    });
    const connector = new EnvoiConnector('https://api.example', memory.store, { fetch: fetcher as typeof fetch, handler: {
      admit: async () => {},
      process: async (_message, context) => { stop.abort(); await expect(context.reply('Too late', 'stable-reply-key')).rejects.toThrow('lease'); }
    } });
    await expect(connector.processWorkOnce(stop.signal)).rejects.toThrow('expired before completion');
    expect(paths.some(path => path.endsWith('/messages'))).toBe(false);
  });

  it('does not admit work when shutdown arrives during the claim request', async () => {
    const memory = memoryStore(session());
    const stop = new AbortController();
    const admit = vi.fn();
    const fetcher = vi.fn(async () => {
      stop.abort();
      return new Response(JSON.stringify({ work: {
        workId: 'work_one', message: { id: 'msg_one', recipientAgentId: 'agent_one', from: { address: 'two@envoi.mail' }, text: 'hello', status: 'delivered' },
        leaseToken: 'fence_one', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
      } }));
    });
    const connector = new EnvoiConnector('https://api.example', memory.store, { fetch: fetcher as typeof fetch, handler: { admit, process: async () => {} } });
    await expect(connector.processWorkOnce(stop.signal)).rejects.toThrow('interrupted before admission');
    expect(admit).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('runs the claim and processing loop until graceful shutdown', async () => {
    const memory = memoryStore(session());
    const stop = new AbortController();
    let claims = 0;
    const calls: string[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const route = String(url);
      if (route.endsWith('/work/claim')) {
        claims += 1;
        if (claims === 2) setTimeout(() => stop.abort(), 0);
        return new Response(JSON.stringify({ work: claims === 1 ? {
          workId: 'work_one', message: { id: 'msg_one', recipientAgentId: 'agent_one', from: { address: 'two@envoi.mail' }, text: 'hello', status: 'delivered' },
          leaseToken: 'fence_one', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
        } : null }));
      }
      if (route.endsWith('/work/work_one/acknowledge')) return new Response(JSON.stringify({ workId: 'work_one', status: 'acknowledged', receipt: { messageId: 'msg_one', state: 'acknowledged' } }));
      if (route.endsWith('/work/work_one/complete')) {
        return new Response(JSON.stringify({ workId: 'work_one', status: 'processed', receipt: { messageId: 'msg_one', state: 'processed' } }));
      }
      if (route.includes('/events/delta')) return new Response(JSON.stringify({ events: [], nextCursor: null, hasMore: false }));
      throw new Error(`Unexpected route ${route}`);
    });
    const connector = new EnvoiConnector('https://api.example', memory.store, { fetch: fetcher as typeof fetch, pollIntervalMs: 100, handler: {
      admit: async () => { calls.push('admit'); }, process: async () => { calls.push('process'); }
    } });
    await connector.run(stop.signal);
    expect(calls).toEqual(['admit', 'process']);
    expect(claims).toBeGreaterThan(1);
  });
});
