import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, createConnection } from 'node:net';
import * as hermesConfig from './config';
import { discoverHermes, envValue, mergeMcpConfiguration, yamlScalar, type HermesConfiguration } from './config';
import { boundedHermesRun, checkHermesCapabilities, preflightHermes } from './api';
import { configureHermes, hermesAdapter } from './adapter';
import { saveHermesScopedMode } from './scoped-runtime';

const directories: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'envoi-hermes-adapter-'));
  directories.push(root);
  const home = path.join(root, '.hermes');
  await mkdir(home);
  await writeFile(path.join(home, '.env'), 'OPENAI_API_KEY=provider-existing-secret\nAPI_SERVER_ENABLED=true\nAPI_SERVER_KEY=local-key\n');
  await writeFile(path.join(home, 'config.yaml'), 'model:\n  default: existing-model\nterminal:\n  backend: local\n');
  const options = { homeDir: root, env: {}, platform: 'linux' };
  return { root, home, options, config: await discoverHermes(options) };
}
const payload = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const config: HermesConfiguration = { home: '/fixture', profile: 'default', configPath: '/fixture/config.yaml', apiUrl: 'http://127.0.0.1:8642', apiKey: 'local-key' };
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

describe('Hermes profile discovery and preparation', () => {
  it('finds the sticky active profile and honors a profile-specific port without rewriting provider settings', async () => {
    const f = await fixture();
    const coder = path.join(f.home, 'profiles', 'coder');
    await mkdir(coder, { recursive: true });
    await writeFile(path.join(f.home, 'active_profile'), 'coder\n');
    await writeFile(path.join(coder, '.env'), 'API_SERVER_ENABLED=true\nAPI_SERVER_KEY=coder-key\nAPI_SERVER_PORT=9999\n');
    await writeFile(path.join(coder, 'config.yaml'), 'platforms:\n  api_server:\n    port: 8653\n');
    const found = await discoverHermes(f.options);
    expect(found).toMatchObject({ profile: 'coder', home: coder, apiKey: 'coder-key', apiUrl: 'http://127.0.0.1:8653' });
    expect(yamlScalar('model:\n  default: same\n', 'model.default')).toBe('same');
  });
  it('honors HERMES_HOME, custom roots, explicit sibling profiles and Windows installations', async () => {
    const f = await fixture();
    const custom = path.join(f.root, 'custom');
    const bot = path.join(custom, 'profiles', 'bot');
    await mkdir(bot, { recursive: true });
    await writeFile(path.join(custom, '.env'), 'API_SERVER_ENABLED=true\nAPI_SERVER_KEY=root-key\n');
    await writeFile(path.join(bot, '.env'), 'API_SERVER_ENABLED=true\nAPI_SERVER_KEY=bot-key\n');
    expect((await discoverHermes({ ...f.options, env: { HERMES_HOME: bot } })).home).toBe(bot);
    expect((await discoverHermes({ ...f.options, env: { HERMES_HOME: '~/.hermes' } })).home).toBe(f.home);
    expect((await discoverHermes({ ...f.options, env: { HERMES_HOME: custom }, profile: 'bot' })).home).toBe(bot);
    const windowsHome = path.join(f.root, 'local', 'hermes');
    await mkdir(windowsHome, { recursive: true });
    await writeFile(path.join(windowsHome, '.env'), 'API_SERVER_ENABLED=true\nAPI_SERVER_KEY=windows-key\n');
    await expect(discoverHermes({ ...f.options, platform: 'win32', env: { LOCALAPPDATA: path.join(f.root, 'local') } })).rejects.toMatchObject({ code: 'CONFIG_AMBIGUOUS' });
    expect((await discoverHermes({ ...f.options, platform: 'win32', configPath: path.join(windowsHome, 'config.yaml') })).apiKey).toBe('windows-key');
  });
  it('generates only the local Gateway key when requested, preserving existing provider and backup', async () => {
    const f = await fixture();
    const envPath = path.join(f.home, '.env');
    await writeFile(envPath, '# existing provider\nOPENAI_API_KEY=provider-existing-secret\n');
    await expect(discoverHermes(f.options)).rejects.toMatchObject({ code: 'GATEWAY_NOT_ENABLED' });
    const found = await discoverHermes({ ...f.options, prepareRuntime: true });
    expect(found.apiKey).toMatch(/^[a-f0-9]{64}$/);
    const saved = await readFile(envPath, 'utf8');
    expect(saved).toContain('OPENAI_API_KEY=provider-existing-secret');
    expect(saved).toContain('API_SERVER_ENABLED=true');
    expect((await readdir(f.home)).some(name => name.startsWith('.env.envoi-backup-'))).toBe(true);
    expect((await discoverHermes(f.options)).apiKey).toBe(found.apiKey);
  });
  it('rejects duplicate keys, selected missing profile and unsafe origins without executing env content', async () => {
    const f = await fixture();
    expect(envValue('API_SERVER_KEY="literal$(do-not-run)" # comment\n', 'API_SERVER_KEY')).toBe('literal$(do-not-run)');
    expect(() => envValue('API_SERVER_KEY=a\nexport API_SERVER_KEY=b\n', 'API_SERVER_KEY')).toThrow('duplicate');
    await expect(discoverHermes({ ...f.options, profile: '../escape' })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(discoverHermes({ ...f.options, profile: 'missing' })).rejects.toMatchObject({ code: 'RUNTIME_NOT_FOUND' });
    await expect(discoverHermes({ ...f.options, gatewayUrl: 'http://remote.test' })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });
  it('does not forward discovered local credentials to remote hosts or new remote origins', async () => {
    const f = await fixture();
    await expect(discoverHermes({ ...f.options, gatewayUrl: 'https://other.test' })).rejects.toMatchObject({ code: 'GATEWAY_KEY_MISSING' });
    const remote = await discoverHermes({ ...f.options, gatewayUrl: 'https://other.test', env: { HERMES_API_KEY: 'explicit-remote-key' } });
    expect(remote.apiKey).toBe('explicit-remote-key');
    expect((await discoverHermes(f.options, remote)).apiKey).toBe('explicit-remote-key');
    await expect(discoverHermes({ ...f.options, gatewayUrl: 'https://new.test' }, remote)).rejects.toMatchObject({ code: 'GATEWAY_KEY_MISSING' });
  });
  it('pins saved profile and custom config path despite unrelated service environment', async () => {
    const f = await fixture();
    const customPath = path.join(f.home, 'selected-config.yaml');
    await writeFile(customPath, 'model:\n  default: selected-provider\n');
    const original = await discoverHermes({ ...f.options, configPath: customPath });
    const other = path.join(f.root, 'other'); await mkdir(other);
    await writeFile(path.join(other, '.env'), 'API_SERVER_ENABLED=true\nAPI_SERVER_KEY=other-key\n');
    await writeFile(path.join(other, 'config.yaml'), 'model:\n  default: other-provider\n');
    const resumed = await discoverHermes({ ...f.options, env: { HERMES_HOME: other } }, original);
    expect(resumed).toMatchObject({ home: f.home, profile: 'default', configPath: customPath, apiKey: 'local-key' });
    const explicitlyChanged = await discoverHermes({ ...f.options, configPath: path.join(other, 'config.yaml') }, original);
    expect(explicitlyChanged).toMatchObject({ home: other, profile: 'default', apiKey: 'other-key' });
  });
  it('restores approved asset settings under a service environment and permits explicit removal', async () => {
    const f = await fixture();
    const original = await discoverHermes({ ...f.options, env: { ENVOI_ASSET_MANIFEST_PATH: 'approved-assets.json' } });
    expect(original.assetManifestPath).toBe(path.resolve('approved-assets.json'));
    expect((await discoverHermes({ ...f.options, env: {} }, original)).assetManifestPath).toBe(original.assetManifestPath);
    expect((await discoverHermes({ ...f.options, env: { ENVOI_ASSET_MANIFEST_PATH: '' } }, original)).assetManifestPath).toBeUndefined();
  });
  it('rejects malformed saved profile and relay records with stable diagnostics', async () => {
    const f = await fixture();
    for (const previous of [null, [], { ...f.config, home: 'relative' }, { ...f.config, secretOverride: 'unexpected' }]) {
      await expect(discoverHermes(f.options, previous as never)).rejects.toMatchObject({ code: 'STATE_INVALID' });
    }
    const stateDir = path.join(f.root, 'malformed-relay'); await mkdir(stateDir);
    await writeFile(path.join(stateDir, 'hermes-relay.json'), 'null');
    await expect(discoverHermes({ ...f.options, stateDir } as never, f.config)).rejects.toMatchObject({ code: 'STATE_INVALID' });
    await expect(configureHermes(f.config, { stateDir, apiUrl: 'https://envoi.test' })).rejects.toMatchObject({ code: 'STATE_INVALID' });
  });
  it('rejects deterministic MCP conflicts before runtime preparation and resumes only its own entry', async () => {
    const f = await fixture();
    const originalEnv = await readFile(path.join(f.home, '.env'), 'utf8');
    for (const yaml of ['mcp_servers: {other: {}}\n', 'mcp_servers:\n  envoi:\n    url: "http://localhost:8789/mcp"\n']) {
      await writeFile(f.config.configPath, yaml);
      await expect(discoverHermes({ ...f.options, prepareRuntime: true })).rejects.toBeTruthy();
      expect(await readFile(path.join(f.home, '.env'), 'utf8')).toBe(originalEnv);
    }
    await writeFile(f.config.configPath, 'model:\n  default: existing\n');
    const stateDir = path.join(f.root, 'own-state'); await mkdir(stateDir);
    const context = { ...f.options, stateDir, apiUrl: 'https://envoi.test' };
    await configureHermes(f.config, context);
    const saved = await discoverHermes(context, f.config);
    expect(saved.home).toBe(f.home);
    const differentState = path.join(f.root, 'other-state'); await mkdir(differentState);
    await expect(discoverHermes({ ...context, stateDir: differentState })).rejects.toMatchObject({ code: 'PROFILE_ALREADY_CONNECTED' });
  });
  it('requires deliberate host selection for nonlocal Hermes terminal backends', async () => {
    const f = await fixture();
    await writeFile(f.config.configPath, 'terminal:\n  backend: docker\n');
    const options = { ...f.options, env: { HERMES_HOME: f.home } };
    await expect(discoverHermes(options)).rejects.toMatchObject({ code: 'RUNTIME_HOST_MISMATCH' });
    expect((await discoverHermes({ ...options, configPath: f.config.configPath })).home).toBe(f.home);
  });
});

describe('Hermes authenticated preflight', () => {
  it('checks legacy Gateway capabilities on restart without creating a model run', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:8642/v1/capabilities');
      expect(init?.method).toBeUndefined();
      expect(init?.body).toBeUndefined();
      return payload({ features: { run_submission: true, run_status: true, run_stop: true } });
    });
    await checkHermesCapabilities(config, { fetch: fetcher as typeof fetch });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([429, 503])('classifies HTTP %s as a temporary Gateway outage without exposing its body', async status => {
    const f = await fixture();
    const error = await preflightHermes(f.config, { fetch: vi.fn(async () => new Response('sensitive-local-key', { status })) as typeof fetch }).catch(error => error);
    expect(error.code).toBe('GATEWAY_UNREACHABLE');
    expect(error.message).not.toContain('sensitive-local-key');
  });
  it('checks required capabilities and completes a real run with the configured provider', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/capabilities')) return payload({ features: { run_submission: true, run_status: true, run_stop: true } });
      if (init?.method === 'POST') return payload({ run_id: 'preflight_1' }, 202);
      return payload({ run_id: 'preflight_1', status: 'completed', output: 'OK' });
    });
    await preflightHermes(config, { fetch: fetcher });
    expect(calls).toHaveLength(3);
    const request = JSON.parse(String(calls[1].init?.body));
    expect(request).not.toHaveProperty('provider');
    expect(request).not.toHaveProperty('api_key');
    expect(calls[1].init?.headers).toMatchObject({ authorization: 'Bearer local-key' });
  });
  it('rejects incompatible APIs and separates local-key errors from provider failures without leaking bodies', async () => {
    await expect(preflightHermes(config, { fetch: vi.fn(async () => payload({ features: { run_submission: true } })) })).rejects.toMatchObject({ code: 'GATEWAY_INCOMPATIBLE' });
    await expect(preflightHermes(config, { fetch: vi.fn(async () => payload({ error: 'raw-secret-key' }, 401)) })).rejects.toMatchObject({ code: 'GATEWAY_AUTH_FAILED' });
    await expect(boundedHermesRun(config, 'test', { fetch: vi.fn(async () => payload({ error: 'raw-provider-secret' }, 400)) })).rejects.toMatchObject({ code: 'MODEL_NOT_READY' });
    await expect(boundedHermesRun(config, 'test', { fetch: vi.fn(async () => payload({ error: 'raw-provider-secret' }, 500)) })).rejects.toMatchObject({ code: 'GATEWAY_UNREACHABLE' });
  });
  it('stops the accepted test run on timeout and uses an independent cancellation deadline', async () => {
    const calls: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      calls.push(String(url));
      if (String(url).endsWith('/stop')) { expect(init?.signal?.aborted).toBe(false); return payload({}); }
      if (init?.method === 'POST') return payload({ run_id: 'pending_1' }, 202);
      return payload({ run_id: 'pending_1', status: 'running' });
    });
    await expect(boundedHermesRun(config, 'test', { fetch: fetcher }, { timeoutMs: 25, pollMs: 2 })).rejects.toMatchObject({ code: 'GATEWAY_TEST_FAILED' });
    expect(calls.at(-1)).toContain('/pending_1/stop');
  });
});

describe('Hermes profile MCP configuration', () => {
  it('classifies an absent selected scoped daemon as a retryable startup outage without changing its selection', async () => {
    const scenario = await fixture();
    const env = { ENVOI_SCOPED_TOOLS: 'true', HERMES_HOME: scenario.home, HERMES_DAEMON_URL: 'http://127.0.0.1:18973' };
    const selected = await hermesAdapter.discover({ ...scenario.options, env });
    const before = await readFile(scenario.config.configPath, 'utf8');
    await expect(hermesAdapter.preflight(selected, { ...scenario.options, env })).rejects.toMatchObject({ code: 'GATEWAY_UNREACHABLE' });
    expect(await readFile(scenario.config.configPath, 'utf8')).toBe(before);
    expect(selected).toMatchObject({ daemonOrigin: env.HERMES_DAEMON_URL, home: scenario.home });
  });
  it('selects scoped mode before profile preparation and refuses a legacy Envoi integration', async () => {
    const scenario = await fixture();
    const original = await readFile(path.join(scenario.home, '.env'), 'utf8');
    const options = { ...scenario.options, prepareRuntime: true, env: { ENVOI_SCOPED_TOOLS: 'true', HERMES_HOME: scenario.home, HERMES_DAEMON_URL: 'http://127.0.0.1:18973' } };
    const scoped = await hermesAdapter.discover(options);
    expect(scoped).toMatchObject({ scopedTools: true, apiKey: '', daemonOrigin: 'http://127.0.0.1:18973' });
    expect(await readFile(path.join(scenario.home, '.env'), 'utf8')).toBe(original);
    await writeFile(scenario.config.configPath, 'mcp_servers:\n  envoi:\n    url: http://127.0.0.1:8789/mcp\n');
    await expect(hermesAdapter.discover(options)).rejects.toMatchObject({ code: 'SCOPED_CONFIG_INVALID' });
    expect(await readFile(path.join(scenario.home, '.env'), 'utf8')).toBe(original);
  });
  it('restores the scoped installer selection in an empty service environment without legacy preflight', async () => {
    const scenario = await fixture(); const stateDir = path.join(scenario.root, 'scoped-state'); await mkdir(stateDir);
    const scoped = await hermesAdapter.discover({ ...scenario.options, env: { ENVOI_SCOPED_TOOLS: 'true', HERMES_HOME: scenario.home, HERMES_DAEMON_URL: 'http://127.0.0.1:18973' } });
    await saveHermesScopedMode(stateDir, scoped);
    expect(await hermesAdapter.discover({ ...scenario.options, stateDir } as never, scoped)).toEqual(scoped);
    await expect(hermesAdapter.discover({ ...scenario.options, stateDir, env: { ENVOI_SCOPED_TOOLS: 'false' } } as never, scoped)).rejects.toMatchObject({ code: 'SCOPED_CONFIG_INVALID' });
    await writeFile(path.join(stateDir, 'hermes-scoped.json'), '{broken');
    await expect(hermesAdapter.discover({ ...scenario.options, stateDir } as never, scoped)).rejects.toThrow();
  });
  it('preserves other servers and refuses unsupported edits or a second identity on the same profile', () => {
    const text = 'model:\n  default: existing\nmcp_servers:\n  other:\n    url: "http://localhost:1"\nterminal:\n  backend: local\n';
    const result = mergeMcpConfiguration(text, 'envoi_a', ['  envoi_a:', '    url: "http://localhost:2"']);
    expect(result).toContain('  other:\n    url: "http://localhost:1"');
    expect(result).toContain('terminal:\n  backend: local');
    expect(() => mergeMcpConfiguration('mcp_servers: {old: {}}\n', 'envoi_a', [])).toThrow('unsupported');
    expect(() => yamlScalar('platforms: {api_server: {port: 1234}}\n', 'platforms.api_server.port')).toThrow('nonstandard');
    expect(() => mergeMcpConfiguration(result, 'envoi_b', [])).toThrow('separate Hermes profile');
    expect(() => mergeMcpConfiguration('mcp_servers:\n  envoi:\n    url: old\n', 'envoi_a', [])).toThrow('migrate');
  });
  it('allocates separate persistent credentials and ports for different profiles and keeps keys out of YAML', async () => {
    const f = await fixture();
    const botHome = path.join(f.home, 'profiles', 'bot');
    await mkdir(botHome, { recursive: true });
    await writeFile(path.join(botHome, '.env'), 'API_SERVER_ENABLED=true\nAPI_SERVER_KEY=bot-key\n');
    const bot = await discoverHermes({ ...f.options, profile: 'bot' });
    const stateA = path.join(f.root, 'state-a'); const stateB = path.join(f.root, 'state-b');
    await mkdir(stateA); await mkdir(stateB);
    const contextA = { stateDir: stateA, apiUrl: 'https://envoi.test', env: {} };
    await configureHermes(f.config, contextA);
    await configureHermes(bot, { ...contextA, stateDir: stateB });
    const a = JSON.parse(await readFile(path.join(stateA, 'hermes-relay.json'), 'utf8'));
    const b = JSON.parse(await readFile(path.join(stateB, 'hermes-relay.json'), 'utf8'));
    expect(a.token).not.toBe(b.token); expect(a.serverName).not.toBe(b.serverName);
    const yaml = await readFile(f.config.configPath, 'utf8');
    expect(yaml).toContain('model:\n  default: existing-model');
    expect(yaml).toContain(`http://127.0.0.1:${a.port}/mcp`);
    expect(yaml).not.toContain(a.token);
    const saved = await readFile(path.join(stateA, 'hermes-relay.json'), 'utf8');
    await configureHermes(f.config, contextA);
    expect(await readFile(path.join(stateA, 'hermes-relay.json'), 'utf8')).toBe(saved);
  });
  it('defers MCP publication until the relay listens and releases its saved port if publication fails', async () => {
    const f = await fixture(); const stateDir = path.join(f.root, 'state'); await mkdir(stateDir);
    await writeFile(path.join(stateDir, 'session.json'), JSON.stringify({ agentId: 'hermes_agent', inboxId: 'inbox_hermes', address: 'hermes@envoi.mail', cursor: null,
      agentApiToken: 'access', agentRefreshToken: 'refresh', agentTokenExpiresAt: new Date(Date.now() + 900000).toISOString(), agentRefreshTokenExpiresAt: new Date(Date.now() + 86400000).toISOString() }));
    const context = { apiUrl: 'https://envoi.test', stateDir, env: {} };
    await hermesAdapter.configure!(f.config, context);
    expect(await readFile(f.config.configPath, 'utf8')).not.toContain('mcp_servers:');
    const relay = JSON.parse(await readFile(path.join(stateDir, 'hermes-relay.json'), 'utf8'));
    const missingPath = path.join(f.home, 'missing', 'config.yaml');
    const replace = hermesConfig.replaceConfiguration;
    let listeningAtPublication = false;
    const publication = vi.spyOn(hermesConfig, 'replaceConfiguration').mockImplementation(async (filename, original, updated) => {
      if (filename === missingPath) {
        // Check TCP at the publication boundary, without forwarding any Envoi request.
        await new Promise<void>((resolve, reject) => {
          const socket = createConnection({ host: '127.0.0.1', port: relay.port });
          socket.once('error', reject);
          socket.once('connect', () => { listeningAtPublication = true; socket.destroy(); resolve(); });
        });
      }
      return replace(filename, original, updated);
    });
    // The missing parent makes publication fail AFTER the real listener was created.
    try {
      await expect(hermesAdapter.createBridge({ ...f.config, configPath: missingPath }, context)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(listeningAtPublication).toBe(true);
    } finally { publication.mockRestore(); }
    const probe = createServer();
    try {
      await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(relay.port, '127.0.0.1', resolve); });
    } finally { await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve())); }
    const recovered = await hermesAdapter.createBridge(f.config, context);
    try {
      expect(await readFile(f.config.configPath, 'utf8')).toContain(`http://127.0.0.1:${relay.port}/mcp`);
      expect(JSON.parse(await readFile(path.join(stateDir, 'hermes-relay.json'), 'utf8'))).toEqual(relay);
    } finally { await recovered.close(); }
  });
  it('requires an observed successful Hermes-originated tool call rather than a model claim', async () => {
    const f = await fixture(); const stateDir = path.join(f.root, 'state'); await mkdir(stateDir);
    await writeFile(path.join(stateDir, 'session.json'), JSON.stringify({ agentId: 'hermes_agent', inboxId: 'inbox_hermes', address: 'hermes@envoi.mail', cursor: null,
      agentApiToken: 'access', agentRefreshToken: 'refresh', agentTokenExpiresAt: new Date(Date.now() + 900000).toISOString(), agentRefreshTokenExpiresAt: new Date(Date.now() + 86400000).toISOString() }));
    const context = { apiUrl: 'https://envoi.test', stateDir, env: {} };
    await configureHermes(f.config, context);
    const relay = JSON.parse(await readFile(path.join(stateDir, 'hermes-relay.json'), 'utf8'));
    let invoke = false;
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).startsWith(context.apiUrl)) return payload({ result: { content: [{ type: 'text', text: '{"agentId":"hermes_agent"}' }] } });
      if (init?.method === 'POST') {
        if (invoke) await fetch(`http://127.0.0.1:${relay.port}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${relay.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'test', method: 'tools/call', params: { name: 'envoi_agent_info', arguments: {} } }) });
        return payload({ run_id: 'verify_1' }, 202);
      }
      return payload({ run_id: 'verify_1', status: 'completed', output: 'I called the tool' });
    });
    const bridge = await hermesAdapter.createBridge(f.config, { ...context, fetch: fetcher });
    try {
      await expect(bridge.verify!()).rejects.toMatchObject({ code: 'TOOLS_NOT_READY' });
      invoke = true;
      await expect(bridge.verify!()).resolves.toBeUndefined();
    } finally { await bridge.close(); }
  });
});
