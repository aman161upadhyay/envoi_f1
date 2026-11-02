import { QuickConnectError } from '../openclaw/quick-connect-error';
import { execFile } from 'node:child_process';
import { mkdir, writeFile, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { CONNECTOR_RUNTIMES } from '../../sdk/typescript/src/quick-connect';
import { rm } from 'node:fs/promises';
import { windowsAccountSid, windowsExecutable } from './windows';
import { prepareHostedWakeService } from './hosted-wake-config';

const execute = promisify(execFile);
const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const unitArgument = (value: string) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', () => '$$')}"`;
const windowsArgument = (value: string) => `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
const defaultPeriodicStart = new Date(Math.ceil((Date.now() + 60_000) / 60_000) * 60_000).toISOString();

export interface ServiceDefinition { name: string; filename: string; contents: string; commands: Array<{ executable: string; args: string[] }> }
export type ServiceRegistration = 'registered' | 'not_installed' | 'unverified';
export type ServiceManagerState = 'running' | 'stopped' | 'failed' | 'unknown';

/** All service manifests contain file paths only. Credentials remain in private local storage. */
export function connectorService(directory: string, options: { platform?: string; home?: string; node?: string; user?: string; runtime?: string; env?: NodeJS.ProcessEnv; now?: Date } = {}): ServiceDefinition {
  if (options.runtime && !CONNECTOR_RUNTIMES.includes(options.runtime as typeof CONNECTOR_RUNTIMES[number])) throw new QuickConnectError('Unsupported startup runtime');
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const node = options.node ?? process.execPath;
  if ([directory, home, node, options.user || ''].some(value => /[\r\n\0]/.test(value))) throw new QuickConnectError('Service paths cannot contain control characters');
  const id = createHash('sha256').update(directory).digest('hex').slice(0, 16);
  const name = `envoi-${options.runtime || 'openclaw'}-${id}`;
  const connector = path.join(directory, 'connector.mjs');
  const args = [connector, 'start', '--state-dir', directory];
  if (platform === 'linux') {
    const filename = path.join(home, '.config', 'systemd', 'user', `${name}.service`);
    return { name, filename, contents: `[Unit]\nDescription=Envoi agent connector\nStartLimitIntervalSec=0\n\n[Service]\nType=simple\nExecStart=${[node, ...args].map(unitArgument).join(' ')}\nWorkingDirectory=${unitArgument(directory)}\nRestart=on-failure\nRestartSec=60\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`, commands: [
      { executable: 'systemctl', args: ['--user', 'daemon-reload'] },
      { executable: 'systemctl', args: ['--user', 'enable', '--now', `${name}.service`] }
    ] };
  }
  if (platform === 'darwin') {
    const label = `com.envoi.${name}`;
    const filename = path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
    return { name: label, filename,
      contents: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${[node, ...args].map(value => `<string>${xml(value)}</string>`).join('')}</array><key>WorkingDirectory</key><string>${xml(directory)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(path.join(directory, 'service.log'))}</string><key>StandardErrorPath</key><string>${xml(path.join(directory, 'service.log'))}</string></dict></plist>\n`,
      commands: [{ executable: 'launchctl', args: ['load', '-w', filename] }] };
  }
  if (platform === 'win32') {
    if (!options.user) throw new QuickConnectError('Windows startup requires the current account SID');
    const filename = path.join(directory, 'startup-task.xml');
    // A repeating logon trigger is not scheduled until the next logon when a
    // task is registered during an existing session. Keep logon startup and
    // add an independently scheduled one-minute recovery trigger.
    const periodicStart = options.now ? new Date(options.now.getTime() + 60_000).toISOString() : defaultPeriodicStart;
    return { name, filename,
      contents: `<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(options.user)}</UserId></LogonTrigger><TimeTrigger><Enabled>true</Enabled><StartBoundary>${periodicStart}</StartBoundary><Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition></TimeTrigger></Triggers><Principals><Principal id="Author"><UserId>${xml(options.user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>5</Count></RestartOnFailure></Settings><Actions Context="Author"><Exec><Command>${xml(node)}</Command><Arguments>${xml(args.map(windowsArgument).join(' '))}</Arguments><WorkingDirectory>${xml(directory)}</WorkingDirectory></Exec></Actions></Task>`,
      commands: [{ executable: windowsExecutable('schtasks.exe', options.env), args: ['/Create', '/TN', name, '/XML', filename, '/F'] }, { executable: windowsExecutable('schtasks.exe', options.env), args: ['/Run', '/TN', name] }] };
  }
  throw new QuickConnectError('Automatic startup supports Linux systemd, macOS launchd and Windows Task Scheduler. Use your host process supervisor');
}

/** Observation only: a saved manifest is not proof that the host registered it. */
export async function inspectConnectorService(directory: string, runtime: string,
  options: { platform?: string; home?: string; env?: NodeJS.ProcessEnv;
    run?: (executable: string, args: string[]) => Promise<string | void> } = {}) {
  const platform = options.platform ?? process.platform;
  const service = connectorService(path.resolve(directory), { platform, home: options.home, env: options.env, runtime,
    // Only the generated XML needs a SID; the task name depends solely on stateDir/runtime.
    user: platform === 'win32' ? 'S-1-0-0' : undefined });
  let manifest;
  try { manifest = await lstat(service.filename); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { name: service.name, registration: 'not_installed' as ServiceRegistration };
    return { name: service.name, registration: 'unverified' as ServiceRegistration };
  }
  if (!manifest.isFile() || manifest.isSymbolicLink()) return { name: service.name, registration: 'unverified' as ServiceRegistration };
  const command = platform === 'linux' ? { executable: 'systemctl', args: ['--user', 'show', '-p', 'LoadState', '-p', 'UnitFileState', '-p', 'ActiveState', `${service.name}.service`] }
    : platform === 'darwin' ? { executable: 'launchctl', args: ['list'] }
    : { executable: windowsExecutable('powershell.exe', options.env), args: ['-NoProfile', '-NonInteractive', '-Command',
      `$task = Get-ScheduledTask -TaskName '${service.name}' -TaskPath '\\' -ErrorAction Stop; $logon = @($task.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' -and $_.Enabled }).Count -gt 0; $periodic = @($task.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskTimeTrigger' -and $_.Enabled -and $_.StartBoundary -and [string]$_.Repetition.Interval -eq 'PT1M' -and -not $_.Repetition.Duration }).Count -gt 0; Write-Output "$($task.State)|$($logon -and $periodic)"`] };
  try {
    const output = options.run ? await options.run(command.executable, command.args)
      : (await execute(command.executable, command.args, { timeout: 15_000, windowsHide: true })).stdout;
    if (platform === 'linux' && typeof output === 'string') {
      const values = Object.fromEntries(output.trim().split(/\r?\n/).map(line => line.split('=', 2)));
      if (values.LoadState !== 'loaded') return { name: service.name, registration: 'unverified' as ServiceRegistration };
      const enabled = values.UnitFileState === 'enabled' ? true : values.UnitFileState === 'disabled' || values.UnitFileState === 'masked' ? false : undefined;
      const managerState: ServiceManagerState = values.ActiveState === 'active' ? 'running' : values.ActiveState === 'failed' ? 'failed'
        : values.ActiveState === 'inactive' ? 'stopped' : 'unknown';
      return { name: service.name, registration: 'registered' as ServiceRegistration, enabled, managerState };
    }
    if (platform === 'win32' && typeof output === 'string') {
      const match = /^(Running|Ready|Disabled|Queued|Unknown)\|(True|False)$/i.exec(output.trim());
      if (!match) return { name: service.name, registration: 'unverified' as ServiceRegistration };
      const state = match[1];
      if (!['Running', 'Ready', 'Disabled', 'Queued', 'Unknown'].includes(state)) return { name: service.name, registration: 'unverified' as ServiceRegistration };
      return { name: service.name, registration: 'registered' as ServiceRegistration, enabled: state !== 'Disabled',
        managerState: (state === 'Running' ? 'running' : state === 'Ready' || state === 'Disabled' ? 'stopped' : 'unknown') as ServiceManagerState,
        recoveryPolicy: match[2].toLowerCase() === 'true' ? 'current' as const : 'outdated' as const };
    }
    if (platform === 'darwin' && typeof output === 'string') {
      // launchctl list uses PID, last exit status, and label columns. Match the
      // complete generated label; another Envoi installation is not this owner.
      const rows = output.trim().split(/\r?\n/).map(line => line.trim().split(/\s+/));
      const row = rows.find(parts => parts.length === 3 && parts[2] === service.name);
      if (!row || !/^(?:\d+|-)$/.test(row[0]) || !/^-?\d+$/.test(row[1]))
        return { name: service.name, registration: 'unverified' as ServiceRegistration };
      const managerState: ServiceManagerState = row[0] !== '-' ? 'running' : Number(row[1]) === 0 ? 'stopped' : 'failed';
      return { name: service.name, registration: 'registered' as ServiceRegistration, managerState };
    }
    return { name: service.name, registration: 'registered' as ServiceRegistration, managerState: 'unknown' as ServiceManagerState };
  } catch { return { name: service.name, registration: 'unverified' as ServiceRegistration }; }
}

export async function checkServiceManager() {
  try {
    if (process.platform === 'linux') await execute('systemctl', ['--user', 'show-environment'], { timeout: 10_000 });
    else if (process.platform === 'darwin') await execute('launchctl', ['list'], { timeout: 10_000 });
    else if (process.platform === 'win32') await execute(windowsExecutable('schtasks.exe'), ['/Query', '/FO', 'CSV', '/NH'], { timeout: 10_000, windowsHide: true });
    else throw new QuickConnectError('unsupported');
  } catch { throw new QuickConnectError('A user startup service is unavailable. Run setup without --install-service and use your host process supervisor to run the printed start command'); }
}

export async function installConnectorService(directory: string, runtime = 'openclaw') {
  await checkServiceManager();
  await prepareHostedWakeService(directory);
  let user: string | undefined;
  if (process.platform === 'win32') {
    user = await windowsAccountSid();
  }
  const service = connectorService(directory, { user, runtime });
  await mkdir(path.dirname(service.filename), { recursive: true, mode: 0o700 });
  await writeFile(service.filename, process.platform === 'win32' ? Buffer.from(`\uFEFF${service.contents}`, 'utf16le') : service.contents, { mode: 0o600 });
  try {
    for (const command of service.commands) await execute(command.executable, command.args, { timeout: 20_000, windowsHide: true });
  } catch { throw new QuickConnectError('Startup registration failed. Your connection is saved; use the printed start command or retry install-service after checking the host service manager'); }
  return service.name;
}

export async function uninstallConnectorService(directory: string, runtime: string) {
  let user: string | undefined;
  if (process.platform === 'win32') {
    user = await windowsAccountSid();
  }
  const service = connectorService(path.resolve(directory), { user, runtime });
  // No manifest means this connection was never registered by this installer.
  // Still let the caller stop a foreground connector and preserve its state.
  if (!await lstat(service.filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) return service.name;
  if (process.platform === 'linux') {
    await execute('systemctl', ['--user', 'disable', '--now', `${service.name}.service`], { timeout: 20_000 });
    await rm(service.filename, { force: true });
    await execute('systemctl', ['--user', 'daemon-reload'], { timeout: 20_000 });
  } else if (process.platform === 'darwin') {
    await execute('launchctl', ['unload', '-w', service.filename], { timeout: 20_000 });
    await rm(service.filename, { force: true });
  } else if (process.platform === 'win32') {
    await execute(windowsExecutable('schtasks.exe'), ['/Change', '/TN', service.name, '/DISABLE'], { timeout: 20_000, windowsHide: true });
    // Deleting a task does not stop its running process. Disable restarts first;
    // the authenticated control channel then performs a graceful shutdown.
    await execute(windowsExecutable('schtasks.exe'), ['/Delete', '/TN', service.name, '/F'], { timeout: 20_000, windowsHide: true });
    await rm(service.filename, { force: true });
  }
  return service.name;
}
