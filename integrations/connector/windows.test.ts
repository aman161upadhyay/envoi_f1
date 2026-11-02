import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { windowsAccountSid, windowsExecutable } from './windows';
import { privateDirectory } from './store';
import { replaceConfiguration } from '../hermes/config';
import { connectorService, inspectConnectorService } from './service';

afterEach(() => vi.unstubAllEnvs());
describe('native Windows helpers', () => {
  it('resolves Windows tools independently of PATH and environment-key casing', () => {
    const env = { SYSTEMROOT: 'D:/Windows', PATH: 'C:\\Program Files\\Git\\usr\\bin' };
    expect(windowsExecutable('whoami.exe', env)).toBe('D:\\Windows\\System32\\whoami.exe');
    expect(windowsExecutable('powershell.exe', env)).toBe('D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(windowsExecutable('icacls.exe', { windir: 'C:\\Windows' })).toBe('C:\\Windows\\System32\\icacls.exe');
    const service = connectorService('C:\\private\\agent', { platform: 'win32', user: 'S-1-5-123', env,
      now: new Date('2026-11-01T19:00:00.000Z') });
    expect(service.commands.map(command => command.executable)).toEqual(['D:\\Windows\\System32\\schtasks.exe', 'D:\\Windows\\System32\\schtasks.exe']);
    expect(service.contents).toContain('<LogonTrigger><Enabled>true</Enabled><UserId>S-1-5-123</UserId></LogonTrigger>');
    expect(service.contents).toContain('<TimeTrigger><Enabled>true</Enabled><StartBoundary>2026-11-01T19:01:00.000Z</StartBoundary><Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition></TimeTrigger>');
    expect(service.contents).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
    expect(service.contents).toContain('<RestartOnFailure><Interval>PT1M</Interval><Count>5</Count></RestartOnFailure>');
  });
  it('rejects unavailable or unsafe system directories without echoing environment values', () => {
    for (const SystemRoot of [undefined, 'relative', '\\\\remote\\Windows', 'C:\\bad\nsecret', 'C:\\Windows|secret']) {
      try { windowsExecutable('whoami.exe', { SystemRoot }); throw new Error('Unexpected success'); }
      catch (error) {
        expect(error).toMatchObject({ code: 'WINDOWS_HELPER_UNAVAILABLE' });
        expect((error as Error).message).not.toContain('secret');
      }
    }
  });
  it('distinguishes a service manifest from a confirmed host registration across platforms', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'envoi-service-observe-'));
    try {
      const directory = path.join(root, 'agent'); await mkdir(directory);
      for (const platform of ['win32', 'linux', 'darwin']) {
        const options = { platform, home: root, env: { SystemRoot: 'C:\\Windows' } };
        const service = connectorService(directory, { ...options, runtime: 'hermes', user: 'S-1-5-123' });
        expect(await inspectConnectorService(directory, 'hermes', { ...options, run: async () => { throw new Error('must not query'); } }))
          .toMatchObject({ registration: 'not_installed' });
        await mkdir(path.dirname(service.filename), { recursive: true }); await writeFile(service.filename, service.contents);
        let command: [string, string[]] | undefined;
        const output = platform === 'win32' ? 'Running|True\r\n' : platform === 'linux'
          ? 'LoadState=loaded\nUnitFileState=enabled\nActiveState=active\n'
          : `PID\tStatus\tLabel\n123\t0\t${service.name}\n`;
        const observed = await inspectConnectorService(directory, 'hermes', { ...options, run: async (executable, args) => { command = [executable, args]; return output; } });
        expect(observed).toMatchObject({ name: service.name, registration: 'registered' });
        if (platform !== 'darwin') expect(command?.[1].join(' ')).toContain(service.name + (platform === 'linux' ? '.service' : ''));
        else expect(command?.[1]).toEqual(['list']);
        if (platform === 'win32') expect(command).toMatchObject([expect.stringContaining('powershell.exe'),
          expect.arrayContaining(['-NoProfile', '-NonInteractive', '-Command'])]);
        if (platform === 'win32') expect(command?.[1].join(' ')).toContain('MSFT_TaskTimeTrigger');
        if (platform === 'linux') expect(command?.[1]).toContain('ActiveState');
        if (platform !== 'darwin') expect(observed).toMatchObject({ enabled: true, managerState: 'running',
          ...(platform === 'win32' ? { recoveryPolicy: 'current' } : {}) });
        else expect(observed).toMatchObject({ managerState: 'running' });
        expect(await inspectConnectorService(directory, 'hermes', { ...options, run: async () => { throw new Error('manager unavailable'); } }))
          .toMatchObject({ registration: 'unverified' });
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('shows disabled and failed host supervision without treating a manifest as a running connector', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'envoi-service-state-'));
    try {
      const directory = path.join(root, 'agent'); await mkdir(directory);
      for (const platform of ['win32', 'linux', 'darwin']) {
        const options = { platform, home: root, env: { SystemRoot: 'C:\\Windows' } };
        const service = connectorService(directory, { ...options, runtime: 'hermes', user: 'S-1-5-123' });
        await mkdir(path.dirname(service.filename), { recursive: true }); await writeFile(service.filename, service.contents);
        expect(await inspectConnectorService(directory, 'hermes', { ...options, run: async () => platform === 'win32' ? 'Disabled|True\r\n'
          : platform === 'linux' ? 'LoadState=loaded\nUnitFileState=disabled\nActiveState=failed\n'
          : `PID\tStatus\tLabel\n-\t1\t${service.name}\n` })).toMatchObject(platform === 'darwin'
          ? { registration: 'registered', managerState: 'failed' }
          : { registration: 'registered', enabled: false, managerState: platform === 'win32' ? 'stopped' : 'failed' });
        expect(await inspectConnectorService(directory, 'hermes', { ...options, run: async () => 'unexpected private manager output' }))
          .toMatchObject({ registration: 'unverified' });
        if (platform === 'darwin') {
          expect(await inspectConnectorService(directory, 'hermes', { ...options, run: async () => `-\t0\t${service.name}\n` }))
            .toMatchObject({ registration: 'registered', managerState: 'stopped' });
          expect(await inspectConnectorService(directory, 'hermes', { ...options, run: async () => '123\t0\tcom.envoi.other-installation\n' }))
            .toMatchObject({ registration: 'unverified' });
        }
      }
      expect(await inspectConnectorService(directory, 'hermes', { platform: 'win32', home: root, env: { SystemRoot: 'C:\\Windows' }, run: async () => 'Ready|False\r\n' }))
        .toMatchObject({ registration: 'registered', managerState: 'stopped', recoveryPolicy: 'outdated' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it.skipIf(process.platform !== 'win32')('protects credentials despite Git-style PATH shadows', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'envoi-windows-path-'));
    try {
      const shadow = path.join(root, 'shadow'); await mkdir(shadow);
      for (const tool of ['whoami.exe', 'powershell.exe', 'icacls.exe', 'schtasks.exe']) {
        await writeFile(path.join(shadow, tool), 'This is deliberately not a Windows executable.');
      }
      vi.stubEnv('PATH', `${shadow};${process.env.PATH ?? ''}`);
      expect(await windowsAccountSid()).toMatch(/^S-1-/);
      const state = await privateDirectory(path.join(root, 'state'));
      await writeFile(path.join(state, 'existing.json'), '{}');
      await expect(privateDirectory(state)).resolves.toBe(state); // Existing-file ACL reset too.
      await expect(replaceConfiguration(path.join(state, '.env'), null, 'API_SERVER_KEY=fixture-private-key\n')).resolves.toBeUndefined();
    } finally { vi.unstubAllEnvs(); await rm(root, { force: true, recursive: true }); }
  });
});
