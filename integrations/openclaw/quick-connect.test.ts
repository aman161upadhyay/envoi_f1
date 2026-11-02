import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectorStartCommand, defaultConnectionDirectory, savedConnectionStatus, setupQuickConnect, startQuickConnect } from './quick-connect';
import { acquireConnectorLock } from './quick-connect-store';
import { connectorService } from './quick-connect-service';
import { validateQuickConnectHandoff } from '../../sdk/typescript/src/quick-connect';

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const handoff = () => ({ version: 1, runtime: 'openclaw', apiUrl: 'https://envoi.example', enrollmentToken: 'enrollment-token-private-123456789',
  expiresAt: new Date(Date.now() + 900_000).toISOString(), agentName: 'Potato', address: 'potato@agents.envoi.example' });
const secureDirectory = async (directory: string) => { await mkdir(directory, { recursive: true }); return path.resolve(directory); };
async function fixture(enabled = true) {
  const directory = await mkdtemp(path.join(tmpdir(), 'envoi-quick-connect-')); directories.push(directory);
  const source = path.join(directory, 'source.mjs'); await writeFile(source, 'console.log("installed connector");');
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const config = { gateway: { port: 18789, auth: { token: 'local-gateway-private' }, http: { endpoints: { chatCompletions: { enabled }, responses: { enabled } } } }, agents: { list: [{ id: 'main' }] } };
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/v1/responses')) return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Connected' }] }] });
    if (String(url).startsWith('http://127.0.0.1:18789/')) return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Connection checked' } }] });
    if (String(url).endsWith('/api/agent-enroll')) return Response.json({ agent: { id: 'agent_potato', address: 'potato@agents.envoi.example' }, inbox: { id: 'inbox_potato' },
      agentApiToken: 'envoi-access-private', agentRefreshToken: 'envoi-refresh-private', agentTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(), agentRefreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    if (String(url).includes('/delta')) return Response.json({ events: [], nextCursor: null, hasMore: false });
    if (String(url).endsWith('/api/agent/status')) return Response.json({ state: 'active', agent: { id: 'agent_potato' }, inboxId: 'inbox_potato' });
    if (String(url).endsWith('/api/agent/connection-status')) return Response.json({ checkedAt: new Date().toISOString() });
    throw new Error('unexpected fixture URL');
  }) as unknown as typeof fetch;
  return { directory, calls, options: { stateDir: path.join(directory, 'state'), secureDirectory, fetch: fetcher, executableFile: source,
    homeDir: directory, env: {}, readFile: async () => JSON.stringify(config) } };
}

describe('Quick Connect setup and restart contract', () => {
  it('persists scoped mode and restarts with an empty service environment using host-only setup reporting', async () => {
    const test = await fixture();
    const result = await setupQuickConnect(handoff(), { ...test.options, env: { ENVOI_SCOPED_TOOLS: 'true' } });
    expect(test.calls[0].url).toBe('http://127.0.0.1:18789/v1/responses');
    const saved = JSON.parse(await readFile(path.join(result.stateDir, 'connection.json'), 'utf8'));
    expect(saved.openclaw.scopedTools).toBe(true);
    expect(JSON.parse(await readFile(path.join(result.stateDir, 'openclaw-mode.json'), 'utf8'))).toEqual({ version: 1, scopedTools: true });
    test.calls.splice(0);
    const stop = new AbortController();
    const ready = vi.fn(() => stop.abort());
    await startQuickConnect(result.stateDir, stop.signal, { env: {}, fetch: test.options.fetch, secureDirectory, onReady: ready });
    expect(ready).toHaveBeenCalledTimes(1);
    expect(test.calls[0].url).toBe('http://127.0.0.1:18789/v1/responses');
    expect(test.calls.some(call => call.url.includes('chat/completions') || call.url.endsWith('/api/agent-enroll'))).toBe(false);
    const report = test.calls.find(call => call.url.endsWith('/api/agent/connection-status'))!;
    expect(JSON.parse(String(report.init?.body))).toMatchObject({ phase: 'ready' });
    expect(new Headers(report.init?.headers).get('authorization')).toBe('Bearer envoi-access-private');
    expect(test.calls.filter(call => call.url.endsWith('/v1/responses')).every(call => !JSON.stringify(call).match(/envoi-access-private|envoi-refresh-private/))).toBe(true);
    expect(JSON.parse(await readFile(path.join(result.stateDir, 'connection.json'), 'utf8')).openclaw.scopedTools).toBe(true);
  });

  it('refuses an explicit scoped downgrade before invoking a legacy endpoint or redeeming again', async () => {
    const test = await fixture();
    const result = await setupQuickConnect(handoff(), { ...test.options, env: { ENVOI_SCOPED_TOOLS: 'true' } });
    test.calls.splice(0);
    await expect(startQuickConnect(result.stateDir, new AbortController().signal, {
      env: { ENVOI_SCOPED_TOOLS: 'false' }, fetch: test.options.fetch, secureDirectory
    })).rejects.toMatchObject({ code: 'SCOPED_MODE_DOWNGRADE_UNAVAILABLE' });
    await expect(setupQuickConnect(handoff(), { ...test.options, env: { ENVOI_SCOPED_TOOLS: 'false' } }))
      .rejects.toMatchObject({ code: 'SCOPED_MODE_DOWNGRADE_UNAVAILABLE' });
    expect(test.calls).toEqual([]);
  });

  it('tests the Gateway before redemption, persists credentials without the enrollment token and installs one executable', async () => {
    const f = await fixture(); const input = handoff();
    const result = await setupQuickConnect(input, f.options);
    expect(result.checks).toBe('passed');
    expect(f.calls[0].url).toBe('http://127.0.0.1:18789/v1/chat/completions');
    expect(f.calls[1].url).toBe('https://envoi.example/api/agent-enroll');
    for (const call of f.calls) expect(call.init?.redirect).toBe('error');
    const saved = await readFile(path.join(result.stateDir, 'connection.json'), 'utf8');
    const session = await readFile(path.join(result.stateDir, 'session.json'), 'utf8');
    expect(saved + session).not.toContain(input.enrollmentToken);
    expect(saved).toContain('local-gateway-private');
    expect(session).toContain('envoi-refresh-private');
    expect(await readFile(path.join(result.stateDir, 'connector.mjs'), 'utf8')).toContain('installed connector');
    expect(JSON.stringify(await savedConnectionStatus(result.stateDir))).not.toMatch(/local-gateway-private|envoi-access-private|envoi-refresh-private/);
    for (const call of f.calls.filter(call => call.url.startsWith(input.apiUrl))) expect(JSON.stringify(call)).not.toContain('local-gateway-private');
  });
  it('leaves enrollment untouched if Gateway endpoint is disabled', async () => {
    const f = await fixture(false);
    await expect(setupQuickConnect(handoff(), f.options)).rejects.toThrow('Enable gateway.http.endpoints');
    expect(f.calls).toHaveLength(0);
    await expect(readFile(path.join(f.options.stateDir, 'session.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('resumes saved enrollment even after handoff expiry and supports rotated Gateway credentials', async () => {
    const f = await fixture(); const input = handoff();
    await setupQuickConnect(input, f.options);
    f.calls.splice(0);
    await setupQuickConnect({ ...input, expiresAt: '2000-01-01T00:00:00Z' }, { ...f.options, env: { OPENCLAW_GATEWAY_TOKEN: 'rotated-local-token' } });
    expect(f.calls.some(call => call.url.endsWith('/api/agent-enroll'))).toBe(false);
    expect(new Headers(f.calls[0].init?.headers).get('authorization')).toBe('Bearer rotated-local-token');
  });
  it('reads rotated credentials from current local config and uses saved credentials only if config is absent', async () => {
    const f = await fixture(); const input = handoff();
    await setupQuickConnect(input, f.options);
    f.calls.splice(0);
    const config = JSON.parse(await f.options.readFile());
    config.gateway.auth.token = 'rotated-config-token';
    await setupQuickConnect(input, { ...f.options, readFile: async () => JSON.stringify(config) });
    expect(new Headers(f.calls[0].init?.headers).get('authorization')).toBe('Bearer rotated-config-token');
    f.calls.splice(0);
    await setupQuickConnect(input, { ...f.options, readFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } });
    expect(new Headers(f.calls[0].init?.headers).get('authorization')).toBe('Bearer rotated-config-token');
    expect(f.calls.some(call => call.url.endsWith('/api/agent-enroll'))).toBe(false);
  });
  it('resumes under a service without inheriting the shell environment that resolved its local Gateway secret', async () => {
    const f = await fixture(); const input = handoff();
    const config = JSON.parse(await f.options.readFile()); config.gateway.auth.token = '${GATEWAY_PRIVATE}';
    const options = { ...f.options, readFile: async () => JSON.stringify(config) };
    await setupQuickConnect(input, { ...options, env: { GATEWAY_PRIVATE: 'service-local-secret' } });
    f.calls.splice(0);
    await setupQuickConnect(input, { ...options, env: {} });
    expect(new Headers(f.calls[0].init?.headers).get('authorization')).toBe('Bearer service-local-secret');
    f.calls.splice(0); config.gateway.port = 18790;
    await expect(setupQuickConnect(input, { ...options, env: {} })).rejects.toThrow('unavailable environment');
    expect(f.calls).toHaveLength(0);
  });
  it('rejects expired new enrollment and rejects reuse of another connection directory', async () => {
    const f = await fixture();
    await expect(setupQuickConnect({ ...handoff(), expiresAt: '2000-01-01T00:00:00Z' }, f.options)).rejects.toThrow('expired');
    expect(f.calls).toHaveLength(0);
    await setupQuickConnect(handoff(), f.options);
    await expect(setupQuickConnect({ ...handoff(), apiUrl: 'https://another.example' }, f.options)).rejects.toThrow('another connection');
  });
  it('blocks concurrent connectors and recovers a lock left by a dead process', async () => {
    const f = await fixture(); const directory = await secureDirectory(f.options.stateDir);
    const release = await acquireConnectorLock(directory);
    await expect(acquireConnectorLock(directory)).rejects.toThrow('already running');
    await release();
    await writeFile(path.join(directory, 'connector.lock'), JSON.stringify({ pid: 999999, nonce: 'old-lock' }));
    vi.spyOn(process, 'kill').mockImplementation(pid => { if (pid === 999999) throw Object.assign(new Error('gone'), { code: 'ESRCH' }); return true; });
    const nextRelease = await acquireConnectorLock(directory);
    await nextRelease();
    await expect(readFile(path.join(directory, 'connector.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('handoff and startup configuration', () => {
  it('rejects unsupported versions and credential-bearing/non-HTTPS origins', () => {
    expect(() => validateQuickConnectHandoff({ ...handoff(), version: 2 })).toThrow('Unsupported');
    for (const apiUrl of ['http://public.example', 'https://user:password@example.com', 'https://example.com?token=secret', 'https://example.com/path']) {
      expect(() => validateQuickConnectHandoff({ ...handoff(), apiUrl })).toThrow();
    }
    expect(validateQuickConnectHandoff({ ...handoff(), gatewayToken: 'ignored-secret' })).not.toHaveProperty('gatewayToken');
  });
  it('isolates state by deployment and address and never uses a relative XDG directory', () => {
    const options = { platform: 'linux', home: '/home/person', env: { XDG_STATE_HOME: '../shared' } };
    const first = defaultConnectionDirectory('https://envoi.example', 'one@example.com', options);
    expect(first).toContain(path.join('/home/person', '.local', 'state'));
    expect(first).not.toEqual(defaultConnectionDirectory('https://other.example', 'one@example.com', options));
    expect(first).not.toEqual(defaultConnectionDirectory('https://envoi.example', 'two@example.com', options));
  });
  it('produces credential-free platform services with separate argument escaping and restart behavior', () => {
    const options = { home: '/home/person', node: '/node path/node' };
    const directory = '/private/path with spaces/%n/$HOME';
    const linux = connectorService(directory, { ...options, platform: 'linux' });
    expect(linux.contents).toContain('%%n/$$HOME'); expect(linux.contents).toContain('Restart=on-failure');
    expect(linux.contents).toContain('StartLimitIntervalSec=0'); expect(linux.contents).toContain('RestartSec=60');
    const mac = connectorService(directory, { ...options, platform: 'darwin' });
    expect(mac.contents).toContain('<key>ProgramArguments</key>'); expect(mac.commands[0].executable).toBe('launchctl');
    const win = connectorService(directory, { ...options, platform: 'win32', user: 'S-1-5-123', env: { SystemRoot: 'C:\\Windows' } });
    expect(win.commands.map(command => command.executable)).toEqual(['C:\\Windows\\System32\\schtasks.exe', 'C:\\Windows\\System32\\schtasks.exe']);
    expect(win.contents).toContain('LeastPrivilege'); expect(win.contents).toContain('InteractiveToken');
    for (const service of [linux, mac, win]) expect(service.contents).not.toMatch(/enrollmentToken|gatewayToken|agentApiToken/);
    expect(() => connectorService('/private/\nExecStart=evil', options)).toThrow('control');
  });
  it('prints literal shell arguments even for substitution characters in paths', () => {
    const directory = "/home/`unsafe`/$(unsafe)/a'b";
    const windows = connectorStartCommand(directory, 'win32', 'C:\\Program Files\\node.exe');
    expect(windows.startsWith("& 'C:\\Program Files\\node.exe'")).toBe(true);
    expect(windows).toContain("a''b");
    expect(connectorStartCommand(directory, 'linux', '/node')).toContain("a'\"'\"'b");
  });
});
