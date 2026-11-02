import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnvoiError } from '../../sdk/typescript/src/index';
import { EnvoiConnector } from '../../sdk/typescript/src/connector';
import { FileBridgeStore } from '../agent-bridges/file-store';
import { validateQuickConnectHandoff, type ConnectorRuntime } from '../../sdk/typescript/src/quick-connect';
import { ConnectorSetupError, type ConnectorAdapter } from './adapter';
import { checkEnvoi, connectionDirectory, connectionStatus, doctorConnection, prepareConnection, readConnection, refreshInstalledExecutable, setupConnection, startConnection } from './core';
import { startControl, queryControl, queryOwnedControl } from './control';
import { connectorService } from './service';
import * as serviceModule from './service';
import { connectorMain } from './cli';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const secureDirectory = async (value: string) => { await mkdir(value, { recursive: true }); return path.resolve(value); };
async function fixture(runtime: ConnectorRuntime = 'hermes') {
  const directory = await mkdtemp(path.join(tmpdir(), 'envoi-unified-')); directories.push(directory);
  const handoff = { version: 1, runtime, apiUrl: 'https://envoi.example', address: `${runtime}@agents.envoi.example`, agentName: runtime,
    enrollmentToken: 'private-enrollment-token-12345678', expiresAt: new Date(Date.now() + 900_000).toISOString() };
  let enrollmentCount = 0, checks = 0, failHealth = false, failPreflight = false, failVerify = false, closes = 0;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith('/health')) return Response.json({ service: failHealth ? 'other' : 'envoi' });
    if (String(url).endsWith('/api/agent-enroll')) {
      enrollmentCount++;
      return Response.json({ agent: { id: `agent_${runtime}`, address: handoff.address }, inbox: { id: `inbox_${runtime}` },
        agentApiToken: `access-secret-${enrollmentCount}`, agentRefreshToken: `refresh-secret-${enrollmentCount}`,
        agentTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(), agentRefreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    }
    if (String(url).includes('/events/delta')) return Response.json({ events: [], nextCursor: null, hasMore: false });
    if (String(url).endsWith('/api/agent/status')) {
      const session = await new FileBridgeStore(path.join(directory, 'state')).load();
      return Response.json({ state: session?.lifecycle?.paused ? 'paused' : 'active', agent: { id: session?.agentId }, inboxId: session?.inboxId });
    }
    if (String(url).includes('/events')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    if (String(url).endsWith('/api/agent/connection-status')) return Response.json({ checkedAt: new Date().toISOString() });
    throw new Error('Unexpected fixture request');
  }) as typeof fetch;
  const adapter: ConnectorAdapter<{ providerKey: string }> = {
    runtime, async discover(_options, previous) { return previous ?? { providerKey: 'local-model-provider-secret' }; },
    async preflight() { checks++; if (failPreflight) throw new ConnectorSetupError('MODEL_NOT_READY', 'Configure your local model'); },
    async createBridge(_config, context) { return {
      connector: new EnvoiConnector(context.apiUrl, new FileBridgeStore(context.stateDir), { fetch: context.fetch }),
      async verify() { if (failVerify) throw new ConnectorSetupError('TOOLS_NOT_READY', 'Start a fresh runtime session'); },
      async close() { closes++; }
    }; },
    describe: () => ({ runtime })
  };
  const resolver = (selected: ConnectorRuntime) => { expect(selected).toBe(runtime); return adapter; };
  return { directory, handoff, resolver, requests, adapter,
    options: { fetch: fetcher, stateDir: path.join(directory, 'state'), secureDirectory },
    counts: () => ({ enrollmentCount, checks, closes }),
    healthFails: (value = true) => { failHealth = value; }, preflightFails: () => { failPreflight = true; }, toolFails: (value: boolean) => { failVerify = value; } };
}

describe('shared connector lifecycle', () => {
  it('accepts the Envoi service health response used by the local server', async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: true, service: 'envoi',
      time: '2026-10-09T18:16:14.005Z', mode: 'development', configurationValidated: false,
      releaseSha: '478c2d758f0360704fb96d5940a287b85453f44a' }));
    await expect(checkEnvoi('https://envoi.example', fetcher as typeof fetch)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledWith('https://envoi.example/health', { signal: expect.any(AbortSignal) });
  });

  it('rejects the legacy service identity even when HTTP health is successful', async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: true, service: 'sinaloa' }));
    await expect(checkEnvoi('https://envoi.example', fetcher as typeof fetch))
      .rejects.toMatchObject({ code: 'ENVOI_UNREACHABLE' });
  });

  it('replaces the saved executable atomically and preserves it when copying fails', async () => {
    const f = await fixture();
    const source = path.join(f.directory, 'downloaded.mjs');
    await writeFile(source, '// original connector');
    await setupConnection(f.handoff, f.resolver, { ...f.options, executableFile: source });
    const target = path.join(f.options.stateDir, 'connector.mjs');
    await writeFile(source, '// upgraded connector');
    await setupConnection(f.handoff, f.resolver, { ...f.options, executableFile: source });
    expect(await readFile(target, 'utf8')).toBe('// upgraded connector');
    await expect(setupConnection(f.handoff, f.resolver, { ...f.options, executableFile: path.join(f.directory, 'missing.mjs') })).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(target, 'utf8')).toBe('// upgraded connector');
    expect((await readdir(f.options.stateDir)).filter(name => name.startsWith('.connector-'))).toEqual([]);
    await setupConnection(f.handoff, f.resolver, { ...f.options, executableFile: target });
    expect(await readFile(target, 'utf8')).toBe('// upgraded connector');
    expect(f.counts().enrollmentCount).toBe(1);
  });
  it('updates a stopped saved connector without changing enrollment or its queued work', async () => {
    const f = await fixture();
    const source = path.join(f.directory, 'candidate.mjs');
    await writeFile(source, '// old connector');
    await setupConnection(f.handoff, f.resolver, { ...f.options, executableFile: source });
    const sessionPath = path.join(f.options.stateDir, 'session.json');
    const originalSession = await readFile(sessionPath, 'utf8');
    const workPath = path.join(f.options.stateDir, 'work', 'queued.json');
    await writeFile(workPath, '{"queued":true}');
    await writeFile(source, '// new connector');
    const result = await refreshInstalledExecutable(f.options.stateDir, source);
    expect(result.changed).toBe(true);
    expect(await readFile(path.join(f.options.stateDir, 'connector.mjs'), 'utf8')).toBe('// new connector');
    expect(await readFile(path.join(f.options.stateDir, 'connector.previous.mjs'), 'utf8')).toBe('// old connector');
    expect(await readFile(sessionPath, 'utf8')).toBe(originalSession);
    expect(await readFile(workPath, 'utf8')).toBe('{"queued":true}');
    expect(f.counts().enrollmentCount).toBe(1);
    expect((await refreshInstalledExecutable(f.options.stateDir, source)).changed).toBe(false);
  });
  for (const runtime of ['hermes', 'openclaw', 'grok'] as const) {
    it(`enrolls ${runtime} once, stores local secrets privately, and resumes after handoff expiry`, async () => {
      const f = await fixture(runtime);
      const result = await setupConnection(f.handoff, f.resolver, f.options);
      expect(result.runtime).toBe(runtime); expect(result.checks).toBe('passed');
      expect(f.requests[0].url).toBe('https://envoi.example/health');
      expect(JSON.parse(String(f.requests.find(request => request.url.endsWith('/api/agent-enroll'))?.init?.body)).runtime).toBe(runtime);
      await setupConnection({ ...f.handoff, expiresAt: '2000-01-01T00:00:00Z' }, f.resolver, f.options);
      expect(f.counts().enrollmentCount).toBe(1); expect(f.counts().closes).toBe(2);
      const saved = await readFile(path.join(result.stateDir, 'connection.json'), 'utf8');
      expect(saved).toContain('local-model-provider-secret'); expect(saved).not.toContain(f.handoff.enrollmentToken);
      expect(JSON.stringify(f.requests)).not.toContain('local-model-provider-secret');
      expect(JSON.stringify(await connectionStatus(result.stateDir))).not.toMatch(/local-model-provider-secret|refresh-secret|access-secret/);
      expect(await connectionStatus(result.stateDir)).toMatchObject({ status: 'stopped', runtime,
        startupService: { registration: 'not_installed' } });
      const reports = f.requests.filter(request => request.url.endsWith('/connection-status'));
      expect(JSON.parse(String(reports[0].init?.body))).toMatchObject({ runtime, runtimeTest: 'passed' });
    });
  }
  it('does not consume enrollment on Envoi reachability or runtime model failure', async () => {
    const health = await fixture(); health.healthFails();
    await expect(setupConnection(health.handoff, health.resolver, health.options)).rejects.toMatchObject({ code: 'ENVOI_UNREACHABLE' });
    expect(health.counts().enrollmentCount).toBe(0); expect(health.counts().checks).toBe(0);
    const model = await fixture(); model.preflightFails();
    await expect(setupConnection(model.handoff, model.resolver, model.options)).rejects.toMatchObject({ code: 'MODEL_NOT_READY' });
    expect(model.counts().enrollmentCount).toBe(0);
  });

  for (const [status, payload, code] of [
    [400, { error: 'Setup runtime does not match this enrollment' }, 'ENROLLMENT_RUNTIME_MISMATCH'],
    [401, { error: 'Enrollment token is invalid, expired, or already used' }, 'ENROLLMENT_TOKEN_REJECTED'],
    [403, { error: 'REQUEST_FAILED', message: 'Enrollment owner is invalid' }, 'ENROLLMENT_OWNER_INVALID'],
    [409, { error: 'REQUEST_FAILED', message: 'That agent address is already taken' }, 'ENROLLMENT_ADDRESS_TAKEN'],
    [409, { error: 'ACTIVE_AGENT_LIMIT', message: 'private remote body' }, 'ENROLLMENT_AGENT_LIMIT'],
    [503, { error: 'AUTH_UNAVAILABLE', message: 'private remote body' }, 'ENROLLMENT_AUTH_UNAVAILABLE'],
    [503, { error: 'private remote body', agentApiToken: 'private credential' }, 'ENROLLMENT_HTTP_ERROR']
  ] as const) {
    it(`preserves safe enrollment diagnostics for HTTP ${status} ${code} without redeeming again`, async () => {
      const f = await fixture(); const original = f.options.fetch;
      f.options.fetch = (async (url, init) => {
        const response = await original(url, init);
        return String(url).endsWith('/api/agent-enroll') ? Response.json(payload, { status }) : response;
      }) as typeof fetch;
      const error = await setupConnection(f.handoff, f.resolver, f.options).catch(error => error);
      expect(error).toMatchObject({ code }); expect(error.message).toContain(`HTTP ${status}`);
      expect(error.message).toContain(f.options.stateDir); expect(error.message).not.toMatch(/private remote|private credential|private-enrollment/);
      expect(f.counts().enrollmentCount).toBe(1);
      const diagnostic = JSON.parse(await readFile(path.join(f.options.stateDir, 'enrollment-error.json'), 'utf8'));
      expect(diagnostic).toMatchObject({ code, httpStatus: status, requestId: expect.any(String) });
      expect(JSON.stringify(diagnostic)).not.toMatch(/private/);
      expect(await connectionStatus(f.options.stateDir)).toMatchObject({ credentialState: 'missing', enrollmentError: diagnostic });
      await expect(readFile(path.join(f.options.stateDir, 'session.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      f.options.fetch = original;
      await setupConnection(f.handoff, f.resolver, f.options);
      expect(await connectionStatus(f.options.stateDir)).toMatchObject({ credentialState: 'saved' });
      await expect(readFile(path.join(f.options.stateDir, 'enrollment-error.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  }

  it('never exposes unrecognized transport errors or extra diagnostic-file fields through status', async () => {
    const f = await fixture(); const original = f.options.fetch;
    f.options.fetch = (async (url, init) => {
      if (String(url).endsWith('/api/agent-enroll')) throw new Error('private-enrollment-token and provider credentials');
      return original(url, init);
    }) as typeof fetch;
    const error = await setupConnection(f.handoff, f.resolver, f.options).catch(error => error);
    expect(error).toMatchObject({ code: 'ENROLLMENT_TRANSPORT_FAILED' }); expect(error.message).not.toMatch(/private-enrollment|provider credentials/);
    await writeFile(path.join(f.options.stateDir, 'enrollment-error.json'), JSON.stringify({ code: 'ENROLLMENT_HTTP_ERROR', checkedAt: new Date().toISOString(), httpStatus: 503, requestId: 'private-secret', agentApiToken: 'private-token', message: 'private-body' }));
    const status = await connectionStatus(f.options.stateDir);
    expect(status).toMatchObject({ enrollmentError: { code: 'ENROLLMENT_HTTP_ERROR', httpStatus: 503 } });
    expect(JSON.stringify(status)).not.toMatch(/private-secret|private-token|private-body/);
  });

  it('identifies a failed credential save after successful redemption without retrying or losing the recovery path', async () => {
    const f = await fixture();
    const save = vi.spyOn(FileBridgeStore.prototype, 'save').mockRejectedValueOnce(new Error('private database credentials'));
    try {
      const error = await setupConnection(f.handoff, f.resolver, f.options).catch(error => error);
      expect(error).toMatchObject({ code: 'ENROLLMENT_PERSISTENCE_FAILED' });
      expect(error.message).toContain('saving them locally failed'); expect(error.message).toContain(f.options.stateDir);
      expect(error.message).not.toContain('private database'); expect(f.counts().enrollmentCount).toBe(1);
      expect(await connectionStatus(f.options.stateDir)).toMatchObject({ credentialState: 'missing', enrollmentError: { code: 'ENROLLMENT_PERSISTENCE_FAILED', httpStatus: 200 } });
    } finally { save.mockRestore(); }
  });
  it('preserves enrollment after tool verification fails and retries without another token', async () => {
    const f = await fixture(); f.toolFails(true);
    await expect(setupConnection(f.handoff, f.resolver, f.options)).rejects.toMatchObject({ code: 'TOOLS_NOT_READY' });
    expect(f.counts().enrollmentCount).toBe(1); expect(f.counts().closes).toBe(1);
    f.toolFails(false);
    await setupConnection({ ...f.handoff, expiresAt: '2000-01-01T00:00:00Z' }, f.resolver, f.options);
    expect(f.counts().enrollmentCount).toBe(1);
  });
  it('reconnects an existing identity once and distinguishes a new reconnect token', async () => {
    const f = await fixture(); await setupConnection(f.handoff, f.resolver, f.options);
    const reconnect = { ...f.handoff, operation: 'reconnect', enrollmentToken: 'private-reconnect-token-12345678' };
    await setupConnection(reconnect, f.resolver, f.options);
    await setupConnection({ ...reconnect, expiresAt: '2000-01-01T00:00:00Z' }, f.resolver, f.options);
    expect(f.counts().enrollmentCount).toBe(2);
    const next = { ...reconnect, enrollmentToken: 'different-reconnect-token-12345678' };
    await setupConnection(next, f.resolver, f.options);
    expect(f.counts().enrollmentCount).toBe(3);
    const status = await connectionStatus(f.options.stateDir);
    expect(status.address).toBe(f.handoff.address); expect(status.agentId).toBe('agent_hermes');
  });
  it('rejects mismatched identity/runtime and rejects an expired fresh handoff', async () => {
    const f = await fixture();
    await expect(setupConnection({ ...f.handoff, expiresAt: '2000-01-01T00:00:00Z' }, f.resolver, f.options)).rejects.toThrow('expired');
    await setupConnection(f.handoff, f.resolver, f.options);
    await expect(setupConnection({ ...f.handoff, runtime: 'grok' }, f.resolver, f.options)).rejects.toMatchObject({ code: 'STATE_MISMATCH' });
    await expect(setupConnection({ ...f.handoff, address: 'different@agents.envoi.example' }, f.resolver, f.options)).rejects.toMatchObject({ code: 'STATE_MISMATCH' });
    expect(f.counts().enrollmentCount).toBe(1);
  });
  it('recovers reconnect credentials even if connection.json was not updated before a crash', async () => {
    const f = await fixture(); await setupConnection(f.handoff, f.resolver, f.options);
    const reconnect = { ...f.handoff, operation: 'reconnect', enrollmentToken: 'private-reconnect-token-12345678' };
    await setupConnection(reconnect, f.resolver, f.options);
    const filename = path.join(f.options.stateDir, 'connection.json');
    const saved = JSON.parse(await readFile(filename, 'utf8')); delete saved.lastReconnectId;
    await writeFile(filename, JSON.stringify(saved));
    await setupConnection({ ...reconnect, expiresAt: '2000-01-01T00:00:00Z' }, f.resolver, f.options);
    expect(f.counts().enrollmentCount).toBe(2);
  });
  it('reports configuration failure after enrollment without requiring a bridge', async () => {
    const f = await fixture();
    f.adapter.configure = async () => { throw new ConnectorSetupError('CONFIG_INVALID', 'Fix local configuration'); };
    await expect(setupConnection(f.handoff, f.resolver, f.options)).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    expect(f.counts().enrollmentCount).toBe(1);
    const reports = f.requests.filter(request => request.url.endsWith('/connection-status'));
    expect(JSON.parse(String(reports[0].init?.body))).toMatchObject({ phase: 'error', errorCode: 'CONFIG_INVALID' });
  });
  it('rejects malformed saved state and management records with stable diagnostics', async () => {
    const f = await fixture(); await setupConnection(f.handoff, f.resolver, f.options);
    await writeFile(path.join(f.options.stateDir, 'connection.json'), 'null');
    await expect(readConnection(f.options.stateDir)).rejects.toMatchObject({ code: 'STATE_INVALID' });
    await writeFile(path.join(f.options.stateDir, 'control.json'), 'null');
    await expect(queryControl(f.options.stateDir, 'status')).rejects.toMatchObject({ code: 'CONTROL_INVALID' });
    await writeFile(path.join(f.options.stateDir, 'session.json'), 'null');
    await expect(setupConnection(f.handoff, f.resolver, f.options)).rejects.toMatchObject({ code: 'STATE_INVALID' });
    expect(f.counts().enrollmentCount).toBe(1);
  });
  it('prepares without enrollment and preserves runtime selection in the validated handoff', async () => {
    const f = await fixture('grok');
    expect(await prepareConnection('grok', f.handoff.apiUrl, f.resolver, f.options)).toMatchObject({ runtime: 'grok', checks: 'passed' });
    expect(f.counts().enrollmentCount).toBe(0);
    expect(validateQuickConnectHandoff({ ...f.handoff, operation: 'reconnect', providerKey: 'ignored' })).toMatchObject({ runtime: 'grok', operation: 'reconnect' });
    expect(validateQuickConnectHandoff(f.handoff)).not.toHaveProperty('providerKey');
  });
  it('upgrades an existing OpenClaw v1 state without reenrollment', async () => {
    const f = await fixture('openclaw'); await setupConnection(f.handoff, f.resolver, f.options);
    const filename = path.join(f.options.stateDir, 'connection.json');
    const saved = JSON.parse(await readFile(filename, 'utf8')); saved.openclaw = saved.configuration; delete saved.configuration;
    await writeFile(filename, JSON.stringify(saved));
    await setupConnection(f.handoff, f.resolver, f.options);
    expect(f.counts().enrollmentCount).toBe(1);
  });
  it('isolates agent state and service names across runtimes and identities', () => {
    const first = connectionDirectory('https://envoi.example', 'first@agents.envoi.example', 'hermes', { homeDir: '/home/test', env: {}, platform: 'linux' });
    const second = connectionDirectory('https://envoi.example', 'second@agents.envoi.example', 'hermes', { homeDir: '/home/test', env: {}, platform: 'linux' });
    expect(first).not.toBe(second);
    expect(first).not.toBe(connectionDirectory('https://envoi.example', 'first@agents.envoi.example', 'grok', { homeDir: '/home/test', env: {}, platform: 'linux' }));
    const a = connectorService(first, { platform: 'linux', runtime: 'hermes' });
    const b = connectorService(second, { platform: 'linux', runtime: 'hermes' });
    expect(a.name).not.toBe(b.name); expect(a.contents).not.toMatch(/Token|API_KEY/);
  });
});

describe('authenticated local management', () => {
  it('uses a read-only adapter startup probe after one-time setup model proof', async () => {
    const f = await fixture(); await setupConnection(f.handoff, f.resolver, f.options);
    expect(f.counts().checks).toBeGreaterThan(0);
    let probes = 0;
    f.adapter.startupCheck = async () => { probes++; };
    f.adapter.preflight = async () => { throw new Error('model preflight must not run on restart'); };
    const original = f.adapter.createBridge;
    f.adapter.createBridge = async (config, context) => {
      const bridge = await original(config, context);
      bridge.connector.run = async () => {};
      return bridge;
    };
    const stop = new AbortController();
    await startConnection(f.options.stateDir, stop.signal, f.resolver, { ...f.options, onReady: () => stop.abort() });
    expect(probes).toBe(1);
    expect(await doctorConnection(f.options.stateDir, f.resolver, f.options)).toMatchObject({ runtimeChecks: 'preflight_only' });
    expect(probes).toBe(2);
    expect(f.counts().enrollmentCount).toBe(1);
  });
  it('reports the actual controlled process and stops it without signaling an arbitrary PID', async () => {
    const f = await fixture(); let stopRequested = false;
    const directory = await secureDirectory(f.options.stateDir);
    const control = await startControl(directory, { runtime: 'hermes', address: f.handoff.address, apiUrl: f.handoff.apiUrl }, () => { stopRequested = true; });
    try {
      expect(await queryControl(directory, 'status')).toMatchObject({ pid: process.pid, runtime: 'hermes', status: 'running' });
      const record = JSON.parse(await readFile(path.join(directory, 'control.json'), 'utf8'));
      expect((await fetch(`http://127.0.0.1:${record.port}/stop`, { method: 'POST' })).status).toBe(403);
      expect(stopRequested).toBe(false);
      await queryOwnedControl(directory, 'stop', { runtime: 'hermes', address: f.handoff.address, apiUrl: f.handoff.apiUrl });
      expect(stopRequested).toBe(true);
    } finally { await control.close(); }
    await expect(readFile(path.join(directory, 'control.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('does not present another agent control listener as this saved connection', async () => {
    const f = await fixture(); await setupConnection(f.handoff, f.resolver, f.options);
    let stoppedOther = false;
    const control = await startControl(f.options.stateDir,
      { runtime: 'hermes', address: 'other@agents.envoi.example', apiUrl: f.handoff.apiUrl }, () => { stoppedOther = true; });
    try {
      const status = await connectionStatus(f.options.stateDir);
      expect(status).toMatchObject({ status: 'unverified', controlChannel: 'identity_mismatch',
        nextAction: expect.stringContaining('control record') });
      expect(JSON.stringify(status)).not.toContain('other@agents.envoi.example');
      expect(await doctorConnection(f.options.stateDir, f.resolver, f.options))
        .toMatchObject({ status: 'unverified', runtimeChecks: 'unverified' });
      await expect(queryOwnedControl(f.options.stateDir, 'stop', await readConnection(f.options.stateDir)))
        .rejects.toMatchObject({ code: 'CONTROL_INVALID' });
      await expect(connectorMain(['stop', '--state-dir', f.options.stateDir])).rejects.toMatchObject({ code: 'CONTROL_INVALID' });
      await expect(connectorMain(['uninstall', '--state-dir', f.options.stateDir])).rejects.toMatchObject({ code: 'CONTROL_INVALID' });
      expect(stoppedOther).toBe(false);
    } finally { await control.close(); }
    await writeFile(path.join(f.options.stateDir, 'control.json'), 'invalid private record');
    expect(await connectionStatus(f.options.stateDir)).toMatchObject({ status: 'unverified', controlChannel: 'invalid' });
    expect(await doctorConnection(f.options.stateDir, f.resolver, f.options))
      .toMatchObject({ status: 'unverified', runtimeChecks: 'unverified' });
  });
  it('does not advise starting a second owner when the service manager reports a live process', async () => {
    const f = await fixture(); await setupConnection(f.handoff, f.resolver, f.options);
    const inspect = vi.spyOn(serviceModule, 'inspectConnectorService').mockResolvedValue({
      name: 'envoi-existing', registration: 'registered', managerState: 'running'
    });
    try {
      expect(await connectionStatus(f.options.stateDir)).toMatchObject({ status: 'unverified', controlChannel: 'absent',
        startupService: { managerState: 'running' }, nextAction: expect.stringContaining('inspect that process') });
    } finally { inspect.mockRestore(); }
  });
  it('identifies an installed Windows startup task without durable repetition', async () => {
    const f = await fixture(); await setupConnection(f.handoff, f.resolver, f.options);
    const inspect = vi.spyOn(serviceModule, 'inspectConnectorService').mockResolvedValue({
      name: 'envoi-existing', registration: 'registered', enabled: true, managerState: 'stopped', recoveryPolicy: 'outdated'
    });
    try {
      expect(await connectionStatus(f.options.stateDir)).toMatchObject({ status: 'stopped',
        startupService: { recoveryPolicy: 'outdated' }, nextAction: expect.stringContaining('reinstall the existing connector startup service') });
    } finally { inspect.mockRestore(); }
  });
  it('holds the per-connection lock through supervised startup and releases it after shutdown', async () => {
    const f = await fixture(); await setupConnection(f.handoff, f.resolver, f.options);
    const original = f.adapter.createBridge;
    let running: (() => void) | undefined;
    const ready = new Promise<void>(resolve => { running = resolve; });
    f.adapter.createBridge = async (config, context) => {
      const bridge = await original(config, context);
      bridge.connector.run = async signal => { await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); };
      return bridge;
    };
    const stop = new AbortController();
    const started = startConnection(f.options.stateDir, stop.signal, f.resolver, { ...f.options, onReady: running });
    try {
      await ready;
      expect(await connectionStatus(f.options.stateDir)).toMatchObject({ status: 'running',
        runtimeDiagnostic: { phase: 'ready', runtimeChecks: 'passed', wake: { transport: 'not_started' } } });
      const checksBeforeDoctor = f.counts().checks;
      expect(await doctorConnection(f.options.stateDir, f.resolver, f.options)).toMatchObject({ status: 'running', runtimeChecks: 'passed' });
      expect(f.counts().checks).toBe(checksBeforeDoctor);
      await expect(setupConnection(f.handoff, f.resolver, f.options)).rejects.toThrow('already running');
    } finally { stop.abort(); await started; }
    expect(await connectionStatus(f.options.stateDir)).toMatchObject({ status: 'stopped',
      runtimeDiagnostic: { phase: 'stopped' } });
    await expect(readFile(path.join(f.options.stateDir, 'connector.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('waits through startup outages, remains manageable, and recovers without reenrollment', async () => {
    const f = await fixture(); await setupConnection(f.handoff, f.resolver, f.options);
    f.healthFails();
    const stop = new AbortController();
    let waiting!: () => void; const waited = new Promise<void>(resolve => { waiting = resolve; });
    let ready!: () => void; const startedReady = new Promise<void>(resolve => { ready = resolve; });
    const original = f.adapter.createBridge;
    f.adapter.createBridge = async (config, context) => {
      const bridge = await original(config, context);
      bridge.connector.run = async signal => { if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); };
      return bridge;
    };
    const started = startConnection(f.options.stateDir, stop.signal, f.resolver, { ...f.options, retryDelayMs: 10, onWaiting: waiting, onReady: ready });
    // Surface a startup failure instead of hanging on a callback that will never fire.
    const prematureExit = started.then(() => { throw new Error('Connector exited before startup recovery'); });
    try {
      await Promise.race([waited, prematureExit]);
      expect(await connectionStatus(f.options.stateDir)).toMatchObject({ status: 'waiting' });
      expect(await connectionStatus(f.options.stateDir)).toMatchObject({ runtimeDiagnostic: { errorCode: 'ENVOI_UNREACHABLE' } });
      expect(await doctorConnection(f.options.stateDir, f.resolver)).toMatchObject({ runtimeChecks: 'pending', errorCode: 'ENVOI_UNREACHABLE' });
      f.healthFails(false); await Promise.race([startedReady, prematureExit]);
      expect(await connectionStatus(f.options.stateDir)).toMatchObject({ status: 'running' });
      expect(f.counts().enrollmentCount).toBe(1);
    } finally { stop.abort(); await started; }
  // Real filesystem and authenticated loopback requests need margin under full-suite load.
  }, 60_000);
  it('keeps the saved connector alive while a selected gateway is briefly unavailable at startup', async () => {
    const f = await fixture(); await setupConnection(f.handoff, f.resolver, f.options);
    let gatewayUp = false;
    f.adapter.preflight = async () => { if (!gatewayUp) throw new ConnectorSetupError('GATEWAY_UNREACHABLE', 'selected daemon absent'); };
    const original = f.adapter.createBridge;
    f.adapter.createBridge = async (config, context) => {
      const bridge = await original(config, context);
      bridge.connector.run = async signal => { if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); };
      return bridge;
    };
    const stop = new AbortController();
    let waiting!: () => void; const waited = new Promise<void>(resolve => { waiting = resolve; });
    let ready!: () => void; const startedReady = new Promise<void>(resolve => { ready = resolve; });
    const started = startConnection(f.options.stateDir, stop.signal, f.resolver,
      { ...f.options, retryDelayMs: 50, onWaiting: waiting, onReady: ready });
    try {
      await waited;
      expect(await connectionStatus(f.options.stateDir)).toMatchObject({ status: 'waiting',
        runtimeDiagnostic: { errorCode: 'GATEWAY_UNREACHABLE' } });
      gatewayUp = true;
      await startedReady;
      expect(await connectionStatus(f.options.stateDir)).toMatchObject({ status: 'running',
        runtimeDiagnostic: { phase: 'ready', runtimeChecks: 'passed' } });
      expect(f.counts().enrollmentCount).toBe(1);
    } finally { stop.abort(); await started; }
  });
  it('keeps the same runtime bridge alive while parked Hermes tools recover before claiming work', async () => {
    const f = await fixture(); await setupConnection(f.handoff, f.resolver, f.options);
    const original = f.adapter.createBridge;
    const stop = new AbortController();
    let bridges = 0;
    let verifications = 0;
    let recovering = false;
    f.adapter.createBridge = async (config, context) => {
      bridges++;
      const bridge = await original(config, context);
      bridge.verify = async () => {
        verifications++;
        if (!recovering) throw new ConnectorSetupError('TOOLS_NOT_READY', 'Tools parked');
      };
      bridge.connector.run = async () => { stop.abort(); };
      return bridge;
    };
    await startConnection(f.options.stateDir, stop.signal, f.resolver, {
      ...f.options, toolRecoveryRetryMs: 1,
      onWaiting(code) {
        expect(code).toBe('TOOLS_NOT_READY');
        expect(f.counts().closes).toBe(1);
        expect(f.requests.some(request => request.url.endsWith('/work/claim'))).toBe(false);
        recovering = true;
      }
    });
    expect(bridges).toBe(1);
    expect(verifications).toBe(2);
    expect(f.counts().enrollmentCount).toBe(1);
    expect(f.counts().closes).toBe(2);
  });
  it('stops gracefully during startup retry and fails promptly on invalid configuration', async () => {
    const f = await fixture(); await setupConnection(f.handoff, f.resolver, f.options);
    f.healthFails(); const stop = new AbortController();
    await startConnection(f.options.stateDir, stop.signal, f.resolver, { ...f.options, onWaiting: () => stop.abort() });
    expect(await connectionStatus(f.options.stateDir)).toMatchObject({ status: 'stopped', nextAction: expect.stringContaining('existing connector') });
    f.healthFails(false); f.preflightFails();
    await expect(startConnection(f.options.stateDir, new AbortController().signal, f.resolver, f.options)).rejects.toMatchObject({ code: 'MODEL_NOT_READY' });
    const stopped = await connectionStatus(f.options.stateDir);
    expect(stopped).toMatchObject({ status: 'stopped', runtimeDiagnostic: { phase: 'failed', errorCode: 'MODEL_NOT_READY' },
      nextAction: expect.stringContaining('repair the selected runtime') });
    expect(JSON.stringify(stopped)).not.toMatch(/local-model-provider-secret|refresh-secret|access-secret|Configure your local model/);
  });
  it('preserves a safe failure code after a ready connector exits during a runtime turn', async () => {
    const f = await fixture(); await setupConnection(f.handoff, f.resolver, f.options);
    const original = f.adapter.createBridge;
    f.adapter.createBridge = async (config, context) => {
      const bridge = await original(config, context);
      bridge.connector.run = async () => { throw new EnvoiError('private runtime prompt and key', undefined, 'HERMES_EXECUTION_UNCERTAIN'); };
      return bridge;
    };
    await expect(startConnection(f.options.stateDir, new AbortController().signal, f.resolver, f.options))
      .rejects.toMatchObject({ code: 'HERMES_EXECUTION_UNCERTAIN' });
    const status = await connectionStatus(f.options.stateDir);
    expect(status).toMatchObject({ status: 'stopped', runtimeDiagnostic: { phase: 'failed', errorCode: 'HERMES_EXECUTION_UNCERTAIN' },
      nextAction: expect.stringContaining('turn journal') });
    expect(JSON.stringify(status)).not.toContain('private runtime prompt and key');
    await writeFile(path.join(f.options.stateDir, 'runtime-diagnostic.json'), JSON.stringify({ version: 1, phase: 'failed',
      startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), runtimeChecks: 'pending', secret: 'private-key' }));
    expect((await connectionStatus(f.options.stateDir)).runtimeDiagnostic).toBeNull();
  });
  it('points a scoped origin mismatch to owner review without disclosing a new Gateway origin', async () => {
    const f = await fixture(); await setupConnection(f.handoff, f.resolver, f.options);
    await writeFile(path.join(f.options.stateDir, 'runtime-diagnostic.json'), JSON.stringify({ version: 1, phase: 'failed',
      startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), runtimeChecks: 'pending', errorCode: 'SCOPED_CONFIG_INVALID' }));
    const status = await connectionStatus(f.options.stateDir);
    expect(status).toMatchObject({ status: 'stopped', nextAction: expect.stringContaining('owner'),
      runtimeDiagnostic: { errorCode: 'SCOPED_CONFIG_INVALID' } });
    expect(JSON.stringify(status)).not.toMatch(/daemonOrigin|agentApiToken|agentRefreshToken/);
  });
});

describe('durable lifecycle in the installed runtimes', () => {
  for (const runtime of ['hermes', 'openclaw', 'grok'] as const) {
    it(runtime + ' refuses a revoked installation before any service or provider request', async () => {
      const f = await fixture(runtime); await setupConnection(f.handoff, f.resolver, f.options);
      const c = new EnvoiConnector(f.handoff.apiUrl, new FileBridgeStore(f.options.stateDir));
      await c.observeError(new EnvoiError('Revoked', 418, 'CREDENTIAL_REVOKED', { reason: 'replaced' }));
      const calls = f.requests.length;
      await expect(startConnection(f.options.stateDir, new AbortController().signal, f.resolver, f.options)).rejects.toMatchObject({ code: 'CREDENTIAL_REVOKED' });
      expect(f.requests).toHaveLength(calls); expect(f.counts().enrollmentCount).toBe(1);
      expect(await connectionStatus(f.options.stateDir)).toMatchObject({ lifecycle: { state: 'REVOKED' }, guidance: expect.stringContaining('replaced') });
    });
  }
  it('starts paused with deferred MCP verification, exposes pause, and preserves it after stop', async () => {
    const f = await fixture(); await setupConnection(f.handoff, f.resolver, f.options);
    const c = new EnvoiConnector(f.handoff.apiUrl, new FileBridgeStore(f.options.stateDir));
    await c.observeError(new EnvoiError('Paused', 409, 'AGENT_PAUSED')); f.toolFails(true);
    const stop = new AbortController(); let ready!: () => void; const readyPromise = new Promise<void>(resolve => { ready = resolve; });
    const running = startConnection(f.options.stateDir, stop.signal, f.resolver, { ...f.options, onReady: ready });
    try { await readyPromise; expect(await doctorConnection(f.options.stateDir, f.resolver, f.options)).toMatchObject({ status: 'paused', lifecycle: { state: 'PAUSED' }, runtimeChecks: 'deferred_while_paused', nextAction: expect.stringContaining('owner to resume') }); }
    finally { stop.abort(); await running; }
    expect(await connectionStatus(f.options.stateDir)).toMatchObject({ lifecycle: { state: 'STOPPED', paused: true },
      nextAction: expect.stringContaining('Start the existing connector') });
    const restarted = new EnvoiConnector(f.handoff.apiUrl, new FileBridgeStore(f.options.stateDir));
    await restarted.start(); expect(await restarted.lifecycle()).toMatchObject({ state: 'PAUSED', paused: true });
  });
});
