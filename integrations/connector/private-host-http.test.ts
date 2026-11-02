import { describe, expect, it, vi } from 'vitest';
import { PrivateHostTransport } from './private-host-http';

function transport(body: unknown, status = 429, retryAfter?: string) {
  return new PrivateHostTransport({ origin: 'https://envoi.example', headers: async () => ({}), fetch: vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json', ...(retryAfter === undefined ? {} : { 'retry-after': retryAfter }) }
  })) as typeof fetch });
}
describe('bounded private host Retry-After handling', () => {
  it('retains the larger safe header/body delay without exposing the raw message', async () => {
    const client = transport({ code: 'RATE_LIMITED', retryAfterSeconds: 120, message: 'private response data' }, 429, '60');
    const error = await client.post('/mcp', {}).catch(error => error);
    expect(error).toMatchObject({ code: 'RATE_LIMITED', status: 429, retryAfterSeconds: 120 });
    expect(JSON.stringify(error)).not.toContain('private response data');
  });
  it('also preserves an active-check delay on HTTP409', async () => {
    await expect(transport({ code: 'GATEWAY_CHECK_ACTIVE', retryAfterSeconds: 75 }, 409).post('/api/agent-gateway/work/claim', { runId: 'saved' })).rejects.toMatchObject({ code: 'GATEWAY_CHECK_ACTIVE', retryAfterSeconds: 75 });
  });
  it.each([0, -1, 0.5, '120', null, 9007199254740992])('ignores invalid body delay %s', async value => {
    const error = await transport({ code: 'RATE_LIMITED', retryAfterSeconds: value }, 429, 'not-a-date-or-delay').post('/mcp', {}).catch(error => error);
    expect(error.retryAfterSeconds).toBeUndefined();
  });
  it('bounds a valid very large delay to one day', async () => {
    await expect(transport({ code: 'RATE_LIMITED', retryAfterSeconds: 99999999 }, 429, '99999999').post('/mcp', {})).rejects.toMatchObject({ retryAfterSeconds: 86400 });
  });
  it('supports an HTTP date delay without retaining the header value', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-24T12:00:00Z'));
      await expect(transport({ code: 'RATE_LIMITED' }, 429, 'Sat, 24 Oct 2026 12:02:00 GMT').post('/mcp', {})).rejects.toMatchObject({ retryAfterSeconds: 120 });
    } finally { vi.useRealTimers(); }
  });
});

describe('private host lifecycle recovery', () => {
  it.each(['CREDENTIAL_REVOKED', 'GATEWAY_SESSION_REVOKED'])('stops after %s instead of retrying an ended authority', async code => {
    const client = transport({ code }, 401);
    await expect(client.post('/mcp', {})).rejects.toMatchObject({ code });
    expect(client.lifecycle).toBe('REVOKED');
    await expect(client.post('/mcp', {})).rejects.toMatchObject({ code: 'CREDENTIAL_REVOKED' });
  });
  it.each(['CREDENTIAL_EXPIRED', 'AUTHENTICATION_REQUIRED', 'GATEWAY_SESSION_EXPIRED',
    'GATEWAY_SCOPE_CHANGED', 'GATEWAY_SCOPE_REQUIRED', 'GATEWAY_SCOPE_DENIED',
    'GATEWAY_SESSION_REQUIRED', 'GATEWAY_GENERATION_STALE', 'GATEWAY_RECOVERY_REQUIRED'])
  ('requires owner recovery after %s instead of retrying stale authority', async code => {
    const client = transport({ code }, code === 'GATEWAY_RECOVERY_REQUIRED' ? 503 : 401);
    await expect(client.post('/mcp', {})).rejects.toMatchObject({ code });
    expect(client.lifecycle).toBe('NEEDS_RECONNECT');
    await expect(client.post('/mcp', {})).rejects.toMatchObject({ code: 'OWNER_RECONNECT_REQUIRED' });
  });
  it('holds paused work until an external owner-resume observation', async () => {
    const client = transport({ code: 'AGENT_PAUSED' }, 409);
    await expect(client.post('/mcp', {})).rejects.toMatchObject({ code: 'AGENT_PAUSED' });
    expect(client.lifecycle).toBe('PAUSED');
    await expect(client.post('/mcp', {})).rejects.toMatchObject({ code: 'AGENT_PAUSED' });
    client.ownerResumed();
    expect(client.lifecycle).toBe('RUNNING');
  });
  it('does not trust an unknown remote code as a terminal lifecycle signal', async () => {
    const client = transport({ code: 'PRIVATE_PROVIDER_TEXT', message: 'private response data' }, 401);
    await expect(client.post('/mcp', {})).rejects.toMatchObject({ code: 'HTTP_ERROR' });
    expect(client.lifecycle).toBe('RUNNING');
  });
});
