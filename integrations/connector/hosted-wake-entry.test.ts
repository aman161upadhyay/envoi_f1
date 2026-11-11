import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnvoiConnector, type ConnectorSession } from '../../sdk/typescript/src/connector';
import { FileBridgeStore } from '../agent-bridges/file-store';
import { startConnection } from './core';
import { startQuickConnect } from '../openclaw/quick-connect';
import { FileWakeStore } from './http-wake-store';
import { acquireConnectorLock } from './store';
import type { ConnectorAdapter } from './adapter';
import { clearHostedWake, configureHostedWake, prepareHostedWakeService, readHostedWakeConfig } from './hosted-wake-config';
import { connectorService } from './service';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const secureDirectory = async (directory: string) => { await mkdir(directory, { recursive: true }); return path.resolve(directory); };
const installationId = 'installation_offline';
const callbackUrl = 'https://hooks.example/envoi/wake';

async function freePort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback port');
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}

async function fixture(kind: 'unified' | 'quick') {
  const root = await mkdtemp(path.join(tmpdir(), `envoi-wake-${kind}-`)); directories.push(root);
  const stateDir = path.join(root, 'state');
  await secureDirectory(stateDir);
  const store = new FileBridgeStore(stateDir); await store.init();
  const session: ConnectorSession = { agentId: 'agent_offline', inboxId: 'inbox_offline', address: 'offline@envoi.example', cursor: null,
    agentApiToken: 'test-access-private', agentRefreshToken: 'test-refresh-private',
    agentTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), agentRefreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString() };
  await store.save(session);
  const openclaw = { gatewayUrl: 'http://127.0.0.1:18789', gatewayToken: 'test-gateway-private', agentId: 'offline',
    configPath: path.join(root, 'missing-openclaw.json'), responsesEnabled: true, scopedTools: true };
  await writeFile(path.join(stateDir, 'connection.json'), JSON.stringify(kind === 'quick'
    ? { version: 1, runtime: 'openclaw', apiUrl: 'https://envoi.example', address: session.address, agentName: 'Offline', openclaw }
    : { version: 1, runtime: 'openclaw', apiUrl: 'https://envoi.example', address: session.address, agentName: 'Offline', configuration: {} }));
  if (kind === 'quick') await writeFile(path.join(stateDir, 'openclaw-mode.json'), JSON.stringify({ version: 1, scopedTools: true }));
  const port = await freePort();
  const env = { ENVOI_SCOPED_TOOLS: 'true', ENVOI_WAKE_URL: callbackUrl, ENVOI_WAKE_PORT: String(port),
    ENVOI_WAKE_INSTALLATION_ID: installationId };
  const calls: string[] = [];
  const listenerAtCreate: number[] = [];
  let wrongInstallation = false;
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); const route = new URL(url).pathname; calls.push(`${init?.method ?? 'GET'} ${route}`);
    if (route === '/health') return Response.json({ service: 'envoi' });
    if (route === '/v1/responses') return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Ready' }] }] });
    if (route === '/api/agent/status') return Response.json({ state: 'active', agent: { id: session.agentId }, inboxId: session.inboxId,
      installation: { id: wrongInstallation ? 'installation_other' : installationId }, caseSessions: { available: true, version: 1 },
      httpWake: { available: true, version: 1, subscription: null } });
    if (route === '/api/agent/connection-status') return Response.json({ checkedAt: new Date().toISOString() });
    if (route === '/api/agent/wake-subscriptions' && init?.method === 'POST') {
      const probe = await fetch(`http://127.0.0.1:${port}/envoi/wake`);
      listenerAtCreate.push(probe.status);
      return Response.json({ subscription: { id: 'wake_sub_offline', installationId, agentId: session.agentId, url: callbackUrl,
        status: 'pending', endedReason: null, expiresAt: null, replacesSubscriptionId: null } });
    }
    if (route === '/api/agent/wake-subscriptions') return Response.json({ installationId, subscriptions: [] });
    if (route === '/api/agent/events') return new Response(`event: ready\ndata: ${JSON.stringify({ inboxId: session.inboxId, cursor: null })}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } });
    if (route === '/api/agent/work/claim') {
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ acceptHumanInstructions: true });
      return Response.json({ work: null, state: 'idle', nextAvailableInMs: 30_000 });
    }
    throw new Error(`Unexpected simulated request: ${route}`);
  }) as typeof fetch;
  return { stateDir, store, session, port, env, fetcher, calls, listenerAtCreate, failIdentity: () => { wrongInstallation = true; } };
}

const scopedAdapter: ConnectorAdapter<object> = {
  runtime: 'openclaw', discover: async () => ({}), preflight: async () => {}, describe: () => ({ runtime: 'openclaw' }),
  async createBridge(_config, context) {
    return { connector: new EnvoiConnector(context.apiUrl, new FileBridgeStore(context.stateDir), {
      fetch: context.fetch, caseSessionHandler: { admit: async () => {}, process: async () => {} }
    }), close: async () => {}, verify: async () => {} };
  }
};

// This combined candidate includes #174's Windows file-identity verification.
describe('normal hosted wake entrypoints (offline simulated services)', () => {
  for (const kind of ['unified', 'quick'] as const) {
    it(`${kind} loads private wake settings after a simulated Windows service restart without inherited environment`, async () => {
      const test = await fixture(kind);
      await prepareHostedWakeService(test.stateDir, test.env, secureDirectory);
      const saved = await readFile(path.join(test.stateDir, 'hosted-wake.json'), 'utf8');
      expect(JSON.parse(saved)).toEqual({ version: 1, registeredUrl: callbackUrl, port: test.port, installationId });
      const manifest = connectorService(test.stateDir, { platform: 'win32', user: 'S-1-5-21-100',
        node: 'C:\\node.exe', env: { SystemRoot: 'C:\\Windows' } }).contents;
      expect(manifest).not.toContain(callbackUrl);
      expect(manifest).not.toContain(installationId);
      const stop = new AbortController();
      const ready = vi.fn();
      const restartedEnv = { ENVOI_SCOPED_TOOLS: 'true' };
      const run = kind === 'unified'
        ? startConnection(test.stateDir, stop.signal, () => scopedAdapter,
          { env: restartedEnv, fetch: test.fetcher, secureDirectory, control: false, onReady: ready })
        : startQuickConnect(test.stateDir, stop.signal,
          { env: restartedEnv, fetch: test.fetcher, secureDirectory, onReady: ready });
      try {
        await vi.waitFor(() => expect(test.listenerAtCreate).toEqual([400]), { timeout: 5_000 });
        expect(ready).toHaveBeenCalledTimes(1);
      } finally { stop.abort(); await run; }
      const release = await acquireConnectorLock(test.stateDir); await release();
      const wake = await FileWakeStore.open(path.join(test.stateDir, 'wake')); await wake.close();
    });

    it(`${kind} rejects partial or mismatched restart environment before network work`, async () => {
      const test = await fixture(kind);
      await prepareHostedWakeService(test.stateDir, test.env, secureDirectory);
      const start = (env: NodeJS.ProcessEnv) => kind === 'unified'
        ? startConnection(test.stateDir, new AbortController().signal, () => scopedAdapter,
          { env, fetch: test.fetcher, secureDirectory, control: false })
        : startQuickConnect(test.stateDir, new AbortController().signal,
          { env, fetch: test.fetcher, secureDirectory });
      await expect(start({ ENVOI_SCOPED_TOOLS: 'true', ENVOI_WAKE_URL: callbackUrl })).rejects.toThrow(/together/);
      await expect(start({ ...test.env, ENVOI_WAKE_INSTALLATION_ID: 'installation_other' })).rejects.toThrow(/differs/);
      expect(test.calls).toEqual([]);
      const release = await acquireConnectorLock(test.stateDir); await release();
    });

    it(`${kind} starts one scoped connector and listener before subscription, then releases both locks on abort`, async () => {
      const test = await fixture(kind);
      const stop = new AbortController();
      const ready = vi.fn();
      const run = kind === 'unified'
        ? startConnection(test.stateDir, stop.signal, () => scopedAdapter, { env: test.env, fetch: test.fetcher,
          secureDirectory, control: false, onReady: ready })
        : startQuickConnect(test.stateDir, stop.signal, { env: test.env, fetch: test.fetcher, secureDirectory, onReady: ready });
      try {
        await vi.waitFor(() => expect(test.listenerAtCreate).toEqual([400]), { timeout: 5_000 });
        expect(ready).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => expect(test.calls).toContain('POST /api/agent/work/claim'));
        const second = kind === 'unified'
          ? startConnection(test.stateDir, new AbortController().signal, () => scopedAdapter,
            { env: test.env, fetch: test.fetcher, secureDirectory, control: false })
          : startQuickConnect(test.stateDir, new AbortController().signal, { env: test.env, fetch: test.fetcher, secureDirectory });
        await expect(second).rejects.toThrow(/already running|already.*connector/i);
        expect(test.listenerAtCreate).toHaveLength(1);
      } finally { stop.abort(); await run; }
      await expect(fetch(`http://127.0.0.1:${test.port}/envoi/wake`)).rejects.toThrow();
      const releaseMain = await acquireConnectorLock(test.stateDir); await releaseMain();
      const wake = await FileWakeStore.open(path.join(test.stateDir, 'wake')); await wake.close();
    });

    it(`${kind} closes listener and releases both locks after an installation identity failure`, async () => {
      const test = await fixture(kind); test.failIdentity();
      const run = kind === 'unified'
        ? startConnection(test.stateDir, new AbortController().signal, () => scopedAdapter,
          { env: test.env, fetch: test.fetcher, secureDirectory, control: false })
        : startQuickConnect(test.stateDir, new AbortController().signal, { env: test.env, fetch: test.fetcher, secureDirectory });
      await expect(run).rejects.toThrow();
      expect(test.calls).not.toContain('POST /api/agent/wake-subscriptions');
      await expect(fetch(`http://127.0.0.1:${test.port}/envoi/wake`)).rejects.toThrow();
      const releaseMain = await acquireConnectorLock(test.stateDir); await releaseMain();
      const wake = await FileWakeStore.open(path.join(test.stateDir, 'wake')); await wake.close();
    });

    it(`${kind} still claims through the direct connector when the callback port is occupied`, async () => {
      const test = await fixture(kind);
      const occupied = createServer((_request, response) => { response.writeHead(204); response.end(); });
      await new Promise<void>((resolve, reject) => {
        occupied.once('error', reject);
        occupied.listen(test.port, '127.0.0.1', resolve);
      });
      const stop = new AbortController();
      const ready = vi.fn();
      const run = kind === 'unified'
        ? startConnection(test.stateDir, stop.signal, () => scopedAdapter, { env: test.env, fetch: test.fetcher,
          secureDirectory, control: false, onReady: ready })
        : startQuickConnect(test.stateDir, stop.signal, { env: test.env, fetch: test.fetcher, secureDirectory, onReady: ready });
      try {
        await Promise.race([run, vi.waitFor(() => expect(test.calls).toContain('POST /api/agent/work/claim'), { timeout: 5_000 })]);
        expect(test.calls).toContain('POST /api/agent/work/claim');
        expect(test.calls).toContain('GET /api/agent/status');
        expect(test.calls).not.toContain('POST /api/agent/wake-subscriptions');
        expect(ready).not.toHaveBeenCalled();
        expect((await fetch(`http://127.0.0.1:${test.port}/`)).status).toBe(204);
      } finally {
        stop.abort();
        occupied.closeAllConnections();
        await new Promise<void>(resolve => occupied.close(() => resolve()));
        await run;
      }
    });
  }

  it('requires explicit rotation and supports removal without falling back from corrupt saved state', async () => {
    const test = await fixture('unified');
    await prepareHostedWakeService(test.stateDir, test.env, secureDirectory);
    await expect(prepareHostedWakeService(test.stateDir, { ...test.env, ENVOI_WAKE_INSTALLATION_ID: 'installation_other' }, secureDirectory))
      .rejects.toThrow(/configure-wake/);
    await configureHostedWake(test.stateDir, { ...test.env, ENVOI_WAKE_INSTALLATION_ID: 'installation_other' }, secureDirectory);
    expect((await readHostedWakeConfig(test.stateDir))?.installationId).toBe('installation_other');
    await writeFile(path.join(test.stateDir, 'hosted-wake.json'), '{');
    await expect(startConnection(test.stateDir, new AbortController().signal, () => scopedAdapter,
      { env: {}, fetch: test.fetcher, secureDirectory, control: false })).rejects.toThrow(/invalid/);
    expect(test.calls).toEqual([]);
    await clearHostedWake(test.stateDir, secureDirectory);
    expect(await readHostedWakeConfig(test.stateDir)).toBeNull();
  });
});
