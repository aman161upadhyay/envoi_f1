import { describe, expect, it, vi } from 'vitest';
import { EnvoiConnector, type ConnectorSession } from '../src/connector';
import { EnvoiError } from '../src/index';

function setup(fetcher: typeof fetch) {
  let saved: ConnectorSession = { agentId: 'agent_example', inboxId: 'inbox_example', address: 'example@envoi.mail', agentApiToken: 'host-access', agentRefreshToken: 'private-refresh',
    agentTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), agentRefreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(), cursor: null };
  const store = { load: async () => structuredClone(saved), save: async (value: ConnectorSession) => { saved = structuredClone(value); } };
  return new EnvoiConnector('https://envoi.example', store, { fetch: fetcher });
}

describe('trusted host-only wake transport', () => {
  it('uses only the fixed origin and short access token, not refresh or model credentials', async () => {
    const fetcher = vi.fn(async () => Response.json({ subscriptions: [] }));
    const connector = setup(fetcher as typeof fetch);
    await connector.wakeRequest('/api/agent/wake-subscriptions');
    expect(connector.wakeOrigin).toBe('https://envoi.example');
    expect(fetcher.mock.calls[0]).toMatchObject(['https://envoi.example/api/agent/wake-subscriptions', { method: 'GET', redirect: 'error', credentials: 'omit', headers: { authorization: 'Bearer host-access' } }]);
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain('private-refresh');
  });
  it.each(['https://evil.example/api/agent/status', '/api/agent/work/claim', '/mcp', '/api/agent/wake-subscriptions/../status'])('refuses unrelated route %s before any access', async route => {
    const fetcher = vi.fn(); const connector = setup(fetcher);
    await expect(connector.wakeRequest(route)).rejects.toThrow('Invalid trusted wake operation'); expect(fetcher).not.toHaveBeenCalled();
  });
  it('refuses unknown body fields before any request', async () => {
    const fetcher = vi.fn(); const connector = setup(fetcher);
    await expect(connector.wakeRequest('/api/agent/wake-subscriptions', { url: 'https://hooks.example/wake', token: 'bad' })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('connectivity remains available while the agent is paused', async () => {
    const fetcher = vi.fn(async () => Response.json({ subscriptions: [] })); const connector = setup(fetcher as typeof fetch);
    await connector.observeError(new EnvoiError('paused', 409, 'AGENT_PAUSED'));
    await connector.wakeRequest('/api/agent/wake-subscriptions'); expect(fetcher).toHaveBeenCalledOnce();
    expect((await connector.lifecycle()).paused).toBe(true);
  });
  it('uses the existing durable rotation engine for one access-expiry replay', async () => {
    const requests: { url: string; body?: string }[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
      const url = String(input); requests.push({ url, body: options?.body as string | undefined });
      if (url.endsWith('/api/agent-token')) return Response.json({ agentApiToken: 'rotated-access', agentRefreshToken: 'rotated-refresh', agentTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(), agentRefreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString() });
      return requests.length === 1 ? Response.json({ code: 'ACCESS_TOKEN_EXPIRED', error: 'ACCESS_TOKEN_EXPIRED', requestId: 'req_expiry', message: 'expired' }, { status: 401 }) : Response.json({ subscriptions: [] });
    });
    const connector = setup(fetcher as typeof fetch); await connector.wakeRequest('/api/agent/wake-subscriptions');
    expect(requests.map(request => request.url)).toEqual(['https://envoi.example/api/agent/wake-subscriptions', 'https://envoi.example/api/agent-token', 'https://envoi.example/api/agent/wake-subscriptions']);
    expect(JSON.parse(requests[1].body!).rotationId).toMatch(/^[a-f0-9-]{36}$/);
  });
  it('revocation is terminal and cannot be used to re-enroll or issue another wake write', async () => {
    const fetcher = vi.fn(async () => Response.json({ code: 'CREDENTIAL_REVOKED', error: 'CREDENTIAL_REVOKED', requestId: 'req_revoke', message: 'revoked' }, { status: 401 }));
    const connector = setup(fetcher as typeof fetch);
    await expect(connector.wakeRequest('/api/agent/wake-subscriptions')).rejects.toMatchObject({ code: 'CREDENTIAL_REVOKED' });
    await expect(connector.wakeRequest('/api/agent/wake-subscriptions')).rejects.toThrow(); expect(fetcher).toHaveBeenCalledOnce();
  });
  it('retries an HTML gateway outage or rate limit without treating it as a corrupt permanent response', async () => {
    for (const [status, code] of [[503, 'NETWORK_ERROR'], [429, 'RATE_LIMITED']] as const) {
      const fetcher = vi.fn(async () => new Response('private upstream diagnostic', { status, headers: { 'retry-after': '3' } }));
      const connector = setup(fetcher as typeof fetch);
      const error = await connector.wakeRequest('/api/agent/status').catch(error => error);
      expect(error).toMatchObject({ status, code, retryAfterSeconds: 3 });
      expect(error.message).not.toContain('private upstream diagnostic');
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });
  it('caps untrusted response bodies', async () => {
    const connector = setup(vi.fn(async () => new Response('a'.repeat(16 * 1024 * 1024 + 1))) as typeof fetch);
    await expect(connector.wakeRequest('/api/agent/status')).rejects.toThrow('Invalid wake response');
  });
});
