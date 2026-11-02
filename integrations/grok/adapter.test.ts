import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FileBridgeStore } from '../agent-bridges/file-store';
import { checkGrokProvider, discoverGrok, grokAdapter, preflightGrok } from './adapter';
import { createGrokBridge } from './runtime';

const completed = (text = 'OK') => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });

describe('Grok unified adapter', () => {
  it('checks the saved provider on restart with no inference request or prompt', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.x.ai/v1/models');
      expect(init?.method).toBe('GET');
      expect(init?.body).toBeUndefined();
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer private-key');
      return Response.json({ data: [] });
    });
    await checkGrokProvider({ apiKey: 'private-key', model: 'grok-test' }, { fetch: fetcher as typeof fetch });
    expect(fetcher).toHaveBeenCalledTimes(1);
    for (const [status, code] of [[401, 'PROVIDER_AUTH_FAILED'], [503, 'PROVIDER_UNREACHABLE']] as const) {
      const error = await checkGrokProvider({ apiKey: 'private-key', model: 'grok-test' },
        { fetch: vi.fn(async () => new Response('private-key and provider diagnostic', { status })) as typeof fetch }).catch(error => error);
      expect(error.code).toBe(code);
      expect(error.message).not.toContain('private-key');
    }
  });
  it('rejects an alternate MCP origin before issuing a case-scoped token', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'envoi-grok-mcp-origin-'));
    try {
      const store = new FileBridgeStore(dir); await store.init();
      await store.save({ agentId: 'agent_one', inboxId: 'inbox_one', address: 'one@envoi.mail', cursor: null,
        agentApiToken: 'envoi-access', agentRefreshToken: 'envoi-refresh',
        agentTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        agentRefreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString() });
      const fetcher = vi.fn<typeof fetch>();
      await expect(createGrokBridge({ apiUrl: 'https://envoi.example', stateDir: dir,
        apiKey: 'xai-key', model: 'grok-test', mcpUrl: 'https://other.example/mcp' },
      { fetch: fetcher })).rejects.toThrow('configured Envoi origin /mcp');
      expect(fetcher).not.toHaveBeenCalled();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('rejects a foreign MCP origin during preflight before the one-use enrollment', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(preflightGrok({ apiKey: 'private-key', model: 'grok-test',
      mcpUrl: 'https://other.example/mcp' },
    { apiUrl: 'https://envoi.example', fetch: fetcher }))
      .rejects.toMatchObject({ code: 'RUNTIME_CONFIGURATION_INVALID' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('requires provider credentials before enrollment and resumes private saved settings with local rotation', async () => {
    await expect(discoverGrok({ env: {} })).rejects.toMatchObject({ code: 'MODEL_CREDENTIAL_MISSING' });
    const prior = { apiKey: 'private-provider-key', model: 'account-custom-model' };
    expect(await discoverGrok({ env: {} }, prior)).toEqual(prior);
    expect(await discoverGrok({ env: { XAI_API_KEY: 'rotated-key', XAI_MODEL: 'another-model' } }, prior))
      .toEqual({ apiKey: 'rotated-key', model: 'another-model' });
    expect(grokAdapter.describe(prior)).toEqual({ provider: 'xAI', model: 'account-custom-model' });
    await expect(discoverGrok({ env: { XAI_API_KEY: 'bad\nsecret' } })).rejects.toMatchObject({ code: 'MODEL_CREDENTIAL_INVALID' });
  });

  it('makes a bounded, tool-free test against the official provider without accepting a credential destination override', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.x.ai/v1/responses');
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer provider-secret');
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model: 'custom-model', store: false, max_output_tokens: 32 });
      expect(body.tools).toBeUndefined();
      expect(String(init?.body)).not.toContain('provider-secret');
      return new Response(JSON.stringify(completed()));
    });
    const config = await discoverGrok({ env: { XAI_API_KEY: 'provider-secret', XAI_MODEL: 'custom-model', XAI_API_URL: 'https://attacker.example' } });
    await preflightGrok(config, { fetch: fetcher as typeof fetch });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('persists optional settings for a service with no shell environment, and accepts explicit updates or removal', async () => {
    const config = await discoverGrok({ env: { XAI_API_KEY: 'private-key', ENVOI_MCP_URL: 'https://envoi.example/mcp',
      ENVOI_ASSET_MANIFEST_PATH: './approved-assets.json' } });
    expect(path.isAbsolute(config.assetManifestPath!)).toBe(true);
    expect(await discoverGrok({ env: {} }, config)).toEqual(config);
    expect(await discoverGrok({ env: { ENVOI_MCP_URL: 'https://new.example/mcp', ENVOI_ASSET_MANIFEST_PATH: '' } }, config))
      .toEqual({ apiKey: config.apiKey, model: config.model, mcpUrl: 'https://new.example/mcp' });
    expect(await discoverGrok({ env: { ENVOI_MCP_URL: '', ENVOI_ASSET_MANIFEST_PATH: '' } }, config))
      .toEqual({ apiKey: config.apiKey, model: config.model });
    expect(JSON.stringify(grokAdapter.describe(config))).not.toMatch(/private-key|mcp|approved-assets/);
  });

  it.each(['http://remote.example/mcp', 'https://user:secret@example.com/mcp', 'https://example.com/other', 'https://example.com/mcp?secret=1'])
    ('rejects invalid MCP destination %s', async mcpUrl => {
      await expect(discoverGrok({ env: { XAI_API_KEY: 'private-key', ENVOI_MCP_URL: mcpUrl } }))
        .rejects.toMatchObject({ code: 'RUNTIME_CONFIGURATION_INVALID' });
    });

  it.each([null, [], 'invalid', { apiKey: 'private-key', model: 'model', endpoint: 'https://attacker.example' }])
    ('rejects malformed saved configuration', async previous => {
      await expect(discoverGrok({ env: {} }, previous as never)).rejects.toMatchObject({ code: 'STATE_INVALID' });
    });

  it.each([401, 429, 500])('sanitizes HTTP %s provider errors', async status => {
    const fetcher = vi.fn(async () => new Response('provider-secret sensitive provider diagnostic', { status }));
    const error = await preflightGrok({ apiKey: 'provider-secret', model: 'custom-model' }, { fetch: fetcher as typeof fetch })
      .catch(error => error as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(status === 401 ? 'authentication failed' : `HTTP ${status}`);
    expect(error.message).not.toMatch(/provider-secret|sensitive provider diagnostic/);
    expect(error.code).toBe(status === 401 ? 'PROVIDER_AUTH_FAILED' : 'PROVIDER_UNREACHABLE');
  });

  it('rejects incomplete responses and canceled tests', async () => {
    await expect(preflightGrok({ apiKey: 'private-key', model: 'custom-model' }, {
      fetch: vi.fn(async () => new Response(JSON.stringify({ status: 'incomplete', output: [] }))) as typeof fetch
    })).rejects.toMatchObject({ code: 'MODEL_TEST_FAILED' });
    const stop = new AbortController(); stop.abort();
    const fetcher = vi.fn();
    await expect(preflightGrok({ apiKey: 'private-key', model: 'custom-model' }, { fetch: fetcher, signal: stop.signal }))
      .rejects.toMatchObject({ code: 'MODEL_TEST_FAILED' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('cancels a stalled provider response and releases its body', async () => {
    const stop = new AbortController();
    const release = vi.fn();
    const fetcher = vi.fn(async () => {
      setTimeout(() => stop.abort(), 10);
      return new Response(new ReadableStream({ cancel: release }));
    });
    await expect(preflightGrok({ apiKey: 'private-key', model: 'custom-model' }, { fetch: fetcher as typeof fetch, signal: stop.signal }))
      .rejects.toMatchObject({ code: 'MODEL_TEST_FAILED' });
    expect(release).toHaveBeenCalledOnce();
  });

  it('reuses a durable reply after connector restart without another provider turn or leaked credentials', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'envoi-grok-adapter-'));
    try {
      const store = new FileBridgeStore(dir); await store.init();
      await store.save({ agentId: 'agent_one', inboxId: 'inbox_one', address: 'one@envoi.mail', cursor: null,
        agentApiToken: 'envoi-access', agentRefreshToken: 'envoi-refresh',
        agentTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        agentRefreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString() });
      let providerCalls = 0; let replyCalls = 0;
      const manifestPath = path.join(dir, 'approved-assets.json');
      await writeFile(manifestPath, JSON.stringify({ files: [] }));
      const message = { id: 'msg_one', senderAgentId: 'agent_two', recipientAgentId: 'agent_one',
        from: { agentId: 'agent_two', address: 'two@envoi.mail' }, text: 'hello', intent: 'message' };
      const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const requestUrl = String(url);
        if (requestUrl.startsWith('https://api.x.ai/')) {
          providerCalls++;
          expect(new Headers(init?.headers).get('authorization')).toBe('Bearer provider-secret');
          expect(String(init?.body)).not.toMatch(/envoi-access|envoi-refresh|provider-secret/);
          const body = JSON.parse(String(init?.body));
          expect(body.tools[0]).toMatchObject({ server_url: 'https://envoi.example/mcp', authorization: 'Bearer case-scoped-read',
            allowed_tools: ['envoi_agent_info'] });
          const data = completed('{"text":"Hello back","intent":"message"}');
          return new Response(JSON.stringify({ ...data, output: [...data.output, { type: 'mcp_call', name: 'envoi_agent_info', status: 'completed' }] }));
        }
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer envoi-access');
        expect(String(init?.body)).not.toContain('provider-secret');
        const route = new URL(requestUrl).pathname;
        if (route.endsWith('/mcp-read-token')) return new Response(JSON.stringify({ mcpAccessToken: 'case-scoped-read', tokenType: 'Bearer',
          scope: 'case_read', caseId: null, expiresAt: new Date(Date.now() + 300_000).toISOString() }));
        if (route.endsWith('/work/claim')) return new Response(JSON.stringify({ work: {
          workId: 'work_one', message, leaseToken: 'lease_one', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
        } }));
        if (route.endsWith('/acknowledge')) return new Response(JSON.stringify({ workId: 'work_one', status: 'acknowledged', receipt: { messageId: 'msg_one', state: 'acknowledged' } }));
        if (route.endsWith('/complete')) return new Response(JSON.stringify({ workId: 'work_one', status: 'processed', receipt: { messageId: 'msg_one', state: 'processed' } }));
        if (route.endsWith('/fail')) return new Response('{}');
        replyCalls++;
        if (replyCalls === 1) return new Response('{}', { status: 500 });
        return new Response(JSON.stringify({ id: 'reply_one' }));
      });
      const config = await discoverGrok({ env: { XAI_API_KEY: 'provider-secret', XAI_MODEL: 'custom-model',
        ENVOI_MCP_URL: 'https://envoi.example/mcp', ENVOI_ASSET_MANIFEST_PATH: manifestPath } });
      const context = { apiUrl: 'https://envoi.example', stateDir: dir, env: {}, fetch: fetcher as typeof fetch };
      const first = await grokAdapter.createBridge(config, context);
      await expect(first.connector.processWorkOnce()).rejects.toThrow();
      await first.close();
      const resumed = await grokAdapter.createBridge(config, context);
      expect(await resumed.connector.processWorkOnce()).toBe(true);
      await resumed.close();
      expect(providerCalls).toBe(1);
      expect(replyCalls).toBe(2);
      expect(await store.replyFor('msg_one')).toEqual({ text: 'Hello back', intent: 'message' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
