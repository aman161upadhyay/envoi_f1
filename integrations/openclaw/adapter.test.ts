import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openclawAdapter } from './adapter';
import { createOpenClawBridge } from './runtime';

vi.mock('./runtime', () => ({ createOpenClawBridge: vi.fn(async () => ({ connector: {}, close: async () => {} })) }));

describe('OpenClaw unified adapter', () => {
  const configured = { configPath: '/local/openclaw.json', gatewayUrl: 'http://127.0.0.1:18789',
    gatewayToken: 'private-gateway-key', agentId: 'main', chatCompletionsEnabled: true };

  it('uses read-only Gateway readiness on restart without an agent turn', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:18789/readyz');
      expect(init?.method).toBe('GET');
      expect(init?.body).toBeUndefined();
      return Response.json({ ready: true });
    });
    await openclawAdapter.startupCheck!(configured, { fetch: fetcher as typeof fetch });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await openclawAdapter.startupCheck!(configured, { fetch: vi.fn(async () =>
      Response.json({ ready: false, coreReady: true, failing: ['telegram'] }, { status: 503 })) as typeof fetch });
    await expect(openclawAdapter.startupCheck!(configured, { fetch: vi.fn(async () => new Response('', { status: 503 })) as typeof fetch }))
      .rejects.toMatchObject({ code: 'GATEWAY_UNREACHABLE' });
  });

  it('classifies Gateway network outages for startup retry without exposing native errors', async () => {
    const error = await openclawAdapter.preflight(configured, { fetch: vi.fn(async () => {
      throw new Error('sensitive private-gateway-key upstream error');
    }) as typeof fetch }).catch(error => error);
    expect(error.code).toBe('GATEWAY_UNREACHABLE');
    expect(error.message).not.toMatch(/sensitive|private-gateway-key|upstream error/);
  });

  it.each([401, 403])('classifies HTTP %s authentication failures without retrying as network outages', async status => {
    await expect(openclawAdapter.preflight(configured, { fetch: vi.fn(async () => new Response('private-gateway-key', { status })) as typeof fetch }))
      .rejects.toMatchObject({ code: 'GATEWAY_AUTH_FAILED' });
  });
  it.each([429, 503])('classifies HTTP %s as a temporary startup outage', async status => {
    await expect(openclawAdapter.preflight(configured, { fetch: vi.fn(async () => new Response('private-gateway-key', { status })) as typeof fetch }))
      .rejects.toMatchObject({ code: 'GATEWAY_UNREACHABLE' });
  });

  it('keeps invalid configuration and incomplete model responses distinct from outages', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: 'incomplete' } }] })));
    await expect(openclawAdapter.preflight({ ...configured, chatCompletionsEnabled: false }, { fetch: fetcher as typeof fetch }))
      .rejects.toMatchObject({ code: 'GATEWAY_TEST_FAILED' });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(openclawAdapter.preflight(configured, { fetch: fetcher as typeof fetch }))
      .rejects.toMatchObject({ code: 'GATEWAY_TEST_FAILED' });
  });

  it('does not classify caller cancellation as a network outage', async () => {
    const stop = new AbortController(); stop.abort();
    await expect(openclawAdapter.preflight(configured, { signal: stop.signal }))
      .rejects.toMatchObject({ code: 'GATEWAY_TEST_FAILED' });
  });

  it('resumes the saved private connection when configuration is absent without forwarding its key to a new origin', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'envoi-openclaw-adapter-'));
    try {
      const previous = { configPath: path.join(dir, 'absent.json'), gatewayUrl: 'http://127.0.0.1:18789',
        gatewayToken: 'saved-private-key', agentId: 'main', chatCompletionsEnabled: undefined };
      expect(await openclawAdapter.discover({ env: {} }, previous)).toEqual(previous);
      expect(openclawAdapter.describe(previous)).toEqual({ gatewayUrl: previous.gatewayUrl, agentId: 'main' });
      await expect(openclawAdapter.discover({ env: { OPENCLAW_GATEWAY_URL: 'https://different.example' } }, previous))
        .rejects.toMatchObject({ code: 'RUNTIME_CONFIGURATION_INVALID' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('uses newly resolved local credentials when they rotate', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'envoi-openclaw-adapter-'));
    try {
      await mkdir(path.join(home, '.openclaw'));
      const configPath = path.join(home, '.openclaw', 'openclaw.json');
      await writeFile(configPath, JSON.stringify({ gateway: { auth: { token: '${GATEWAY_KEY}' }, http: { endpoints: { chatCompletions: { enabled: true } } } } }));
      const previous = { configPath, gatewayUrl: 'http://127.0.0.1:18789', gatewayToken: 'saved-private-key', agentId: 'main', chatCompletionsEnabled: true };
      const fresh = await openclawAdapter.discover({ homeDir: home, env: { GATEWAY_KEY: 'rotated-private-key' } }, previous);
      expect(fresh.gatewayToken).toBe('rotated-private-key');
      const fallback = await openclawAdapter.discover({ homeDir: home, env: {} }, previous);
      expect(fallback.gatewayToken).toBe('saved-private-key');
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('restores optional private settings for supervised startup and preserves explicit local overrides', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'envoi-openclaw-adapter-'));
    try {
      const base = { configPath: path.join(dir, 'absent.json'), gatewayUrl: 'http://127.0.0.1:18789',
        gatewayToken: 'gateway-private-key', agentId: 'main', chatCompletionsEnabled: undefined };
      const settings = await openclawAdapter.discover({ env: { OPENCLAW_MCP_RELAY_TOKEN: 'relay-private-key',
        OPENCLAW_MCP_RELAY_PORT: '9001', OPENCLAW_MCP_WRITE_ENABLED: 'true', ENVOI_ASSET_MANIFEST_PATH: './assets.json' } }, base);
      const resumed = await openclawAdapter.discover({ env: {} }, settings);
      expect(resumed).toEqual(settings);
      await openclawAdapter.createBridge(resumed, { apiUrl: 'https://envoi.example', stateDir: dir, env: {} });
      expect(createOpenClawBridge).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ env: expect.objectContaining({
        OPENCLAW_MCP_RELAY_TOKEN: 'relay-private-key', OPENCLAW_MCP_RELAY_PORT: '9001', OPENCLAW_MCP_WRITE_ENABLED: 'true',
        ENVOI_ASSET_MANIFEST_PATH: path.resolve('./assets.json')
      }) }));
      await openclawAdapter.createBridge(resumed, { apiUrl: 'https://envoi.example', stateDir: dir,
        env: { OPENCLAW_MCP_RELAY_TOKEN: 'rotated-relay-key', OPENCLAW_MCP_WRITE_ENABLED: 'false', ENVOI_ASSET_MANIFEST_PATH: '' } });
      expect(createOpenClawBridge).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ env: expect.objectContaining({
        OPENCLAW_MCP_RELAY_TOKEN: 'rotated-relay-key', OPENCLAW_MCP_RELAY_PORT: '9001', OPENCLAW_MCP_WRITE_ENABLED: undefined,
        ENVOI_ASSET_MANIFEST_PATH: undefined
      }) }));
      expect(JSON.stringify(openclawAdapter.describe(resumed))).not.toMatch(/private-key|assets.json/);
      await expect(openclawAdapter.discover({ env: { OPENCLAW_MCP_RELAY_PORT: '99999' } }, settings))
        .rejects.toMatchObject({ code: 'RUNTIME_CONFIGURATION_INVALID' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it.each([null, [], 'invalid', { configuration: 'unexpected' }])('rejects malformed saved configuration', async previous => {
    await expect(openclawAdapter.discover({ env: {} }, previous as never)).rejects.toMatchObject({ code: 'STATE_INVALID' });
  });

  it('accepts validated Responses metadata for the scoped adapter without changing legacy preflight', async () => {
    const fetcher = vi.fn(async () => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Ready' }] }] }));
    await openclawAdapter.preflight({ ...configured, responsesEnabled: true }, { env: { ENVOI_SCOPED_TOOLS: 'true' }, fetch: fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe('http://127.0.0.1:18789/v1/responses');
    await expect(openclawAdapter.preflight({ ...configured, responsesEnabled: 'true' } as never, { env: {}, fetch: fetcher }))
      .rejects.toMatchObject({ code: 'STATE_INVALID' });
  });

  it.each([{ relayToken: 'private-saved-relay' }, { relayPort: '9001' }, { mcpWriteEnabled: false }, { assetManifestPath: '/private/assets.json' }])(
    'rejects persisted legacy settings before scoped discovery, preflight or bridge creation %j', async legacy => {
      const previous = { ...configured, ...legacy };
      const fetcher = vi.fn();
      const readFile = vi.fn();
      const env = { ENVOI_SCOPED_TOOLS: 'true' };
      const bridgeCalls = vi.mocked(createOpenClawBridge).mock.calls.length;
      await expect(openclawAdapter.discover({ env, readFile }, previous)).rejects.toMatchObject({ code: 'SCOPED_LEGACY_CONFIGURATION_UNAVAILABLE' });
      await expect(openclawAdapter.preflight(previous, { env, fetch: fetcher })).rejects.toMatchObject({ code: 'SCOPED_LEGACY_CONFIGURATION_UNAVAILABLE' });
      expect(() => openclawAdapter.createBridge(previous, { apiUrl: 'https://envoi.example', stateDir: '/not/created', env }))
        .toThrow('Scoped mode cannot use privileged legacy');
      expect(fetcher).not.toHaveBeenCalled(); expect(readFile).not.toHaveBeenCalled();
      expect(vi.mocked(createOpenClawBridge).mock.calls.length).toBe(bridgeCalls);
    });
});
