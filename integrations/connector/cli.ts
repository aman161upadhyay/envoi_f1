import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONNECTOR_RUNTIMES, type ConnectorRuntime } from '../../sdk/typescript/src/quick-connect';
import { adapterFor } from './adapters';
import { ConnectorSetupError } from './adapter';
import { connectionStatus, doctorConnection, prepareConnection, readConnection, refreshInstalledExecutable, removeInstalledExecutable, setupConnection, startCommand, startConnection } from './core';
import { checkServiceManager, installConnectorService, uninstallConnectorService } from './service';
import { queryOwnedControl } from './control';
import { clearHostedWake, configureHostedWake } from './hosted-wake-config';

const usage = `Envoi connector (Node.js 22+) — OpenClaw, Hermes, Grok\n
prepare --runtime <openclaw|hermes|grok> --api-url <Envoi origin> [--prepare-runtime]\n
setup --handoff <private JSON file> [--install-service] [--prepare-runtime]\n
setup --handoff-stdin [--install-service] [--prepare-runtime]\n
start|status|doctor|install-service|configure-wake|clear-wake|stop|uninstall --state-dir <directory>\n
Discovery overrides: --config <path> --profile <name> --agent <id> --gateway-url <origin>\n
Keep keys in local secret storage. Never pass them as arguments.\n
Hermes --prepare-runtime configures its local API key and API settings.\n
It does not configure a missing model provider or restart a Gateway serving your chat.\n`;
const stringOptions = ['--handoff', '--state-dir', '--runtime', '--api-url', '--config', '--profile', '--agent', '--gateway-url'];
const flagOptions = ['--handoff-stdin', '--install-service', '--prepare-runtime'];
export async function connectorMain(args = process.argv.slice(2)) {
  if (!args.length || args.length === 1 && args[0] === '--help') { process.stdout.write(usage); return; }
  if (Number(process.versions.node.split('.')[0]) < 22) throw new ConnectorSetupError('NODE_UNSUPPORTED', 'Install Node.js 22 or newer before connecting');
  const [command, ...rest] = args;
  const values = new Map<string, string>(); const flags = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (flagOptions.includes(key)) { if (flags.has(key)) throw new ConnectorSetupError('ARGUMENT_INVALID', 'Duplicate option'); flags.add(key); continue; }
    if (!stringOptions.includes(key) || !rest[i + 1] || rest[i + 1].startsWith('--') || values.has(key)) throw new ConnectorSetupError('ARGUMENT_INVALID', 'Unknown, duplicate or incomplete option. Run --help');
    values.set(key, rest[++i]);
  }
  const options = { configPath: values.get('--config'), profile: values.get('--profile'), agentId: values.get('--agent'),
    gatewayUrl: values.get('--gateway-url'), prepareRuntime: flags.has('--prepare-runtime') };
  if (command === 'prepare') {
    if (!CONNECTOR_RUNTIMES.includes(values.get('--runtime') as ConnectorRuntime) || !values.get('--api-url') || flags.has('--install-service')
      || flags.has('--handoff-stdin') || values.has('--handoff') || values.has('--state-dir')) throw new ConnectorSetupError('ARGUMENT_INVALID', 'Supply --runtime and --api-url for prepare. Run --help');
    const result = await prepareConnection(values.get('--runtime') as ConnectorRuntime, values.get('--api-url')!, adapterFor, options);
    process.stdout.write(`${JSON.stringify(result)}\n`); return;
  }
  if (command === 'setup') {
    if (values.has('--handoff') === flags.has('--handoff-stdin') || values.has('--runtime') || values.has('--api-url')) throw new ConnectorSetupError('ARGUMENT_INVALID', 'Supply either --handoff <file> or --handoff-stdin. The runtime and origin come from the handoff');
    let source: string;
    if (flags.has('--handoff-stdin')) {
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of process.stdin) { length += chunk.length; if (length > 16_384) throw new ConnectorSetupError('HANDOFF_INVALID', 'Setup input is too large'); chunks.push(Buffer.from(chunk)); }
      source = Buffer.concat(chunks).toString('utf8');
    } else {
      const filename = path.resolve(values.get('--handoff')!); const stat = await lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) throw new ConnectorSetupError('HANDOFF_INVALID', 'Choose a regular private setup file of at most 16 KB');
      if (process.platform !== 'win32' && stat.mode & 0o077) throw new ConnectorSetupError('HANDOFF_INVALID', 'Restrict the setup file to your account (chmod 600)');
      source = await readFile(filename, 'utf8');
    }
    let input: unknown;
    try { input = JSON.parse(source); } catch { throw new ConnectorSetupError('HANDOFF_INVALID', 'Download a valid Envoi setup file'); }
    const result = await setupConnection(input, adapterFor, { ...options, stateDir: values.get('--state-dir'),
      installService: flags.has('--install-service'), executableFile: fileURLToPath(import.meta.url), onProgress: text => process.stderr.write(`${text}…\n`) });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.stderr.write(`Setup checks: ${result.checks === 'passed' ? 'passed' : 'tool verification deferred while paused'}. Delete the temporary handoff.\nStart: ${startCommand(result.stateDir)}\n`);
    if (flags.has('--install-service')) {
      const name = await installConnectorService(result.stateDir, result.runtime);
      process.stdout.write(`${JSON.stringify({ startupService: name, startsAt: 'user login', note: 'Check status after startup; user services do not guarantee operation after logout' })}\n`);
    } else process.stderr.write('Run install-service or supervise the reported start command. A terminal-only process stops when its session ends.\n');
    return;
  }
  if (!['start', 'status', 'doctor', 'install-service', 'configure-wake', 'clear-wake', 'stop', 'uninstall'].includes(command) || !values.get('--state-dir') || values.size !== 1 || flags.size) throw new ConnectorSetupError('ARGUMENT_INVALID', 'Supply a supported command and --state-dir. Run --help');
  const directory = path.resolve(values.get('--state-dir')!);
  if (command === 'configure-wake' || command === 'clear-wake') {
    await readConnection(directory);
    if (command === 'configure-wake') await configureHostedWake(directory);
    else await clearHostedWake(directory);
    process.stdout.write(`${JSON.stringify({ hostedWake: command === 'configure-wake' ? 'configured' : 'disabled', note: 'Restart the connector service to apply this change' })}\n`);
    return;
  }
  if (command === 'status') { process.stdout.write(`${JSON.stringify(await connectionStatus(directory))}\n`); return; }
  if (command === 'doctor') { process.stdout.write(`${JSON.stringify(await doctorConnection(directory, adapterFor))}\n`); return; }
  if (command === 'install-service') {
    const saved = await readConnection(directory);
    await checkServiceManager();
    const executable = await refreshInstalledExecutable(directory, fileURLToPath(import.meta.url));
    const startupService = await installConnectorService(directory, saved.runtime);
    process.stdout.write(`${JSON.stringify({ startupService, startsAt: 'user login', executable })}\n`);
    return;
  }
  if (command === 'stop') {
    const saved = await readConnection(directory);
    await queryOwnedControl(directory, 'stop', saved).catch(error => {
      if (error instanceof ConnectorSetupError && error.code === 'CONTROL_INVALID') throw error;
      throw new ConnectorSetupError('CONNECTOR_UNREACHABLE', 'No responding connector. Use status or stop the installed service through its supervisor');
    });
    process.stdout.write(`${JSON.stringify({ status: 'stop requested', note: 'An external supervisor may restart this service. Disable it to keep the connection stopped' })}\n`); return;
  }
  if (command === 'uninstall') {
    const saved = await readConnection(directory);
    let responding = false;
    try { await queryOwnedControl(directory, 'status', saved); responding = true; }
    catch (error) { if (error instanceof ConnectorSetupError && error.code === 'CONTROL_INVALID') throw error; }
    await uninstallConnectorService(directory, saved.runtime);
    if (responding) await queryOwnedControl(directory, 'stop', saved).catch(error => {
      if (error instanceof ConnectorSetupError && error.code === 'CONTROL_INVALID') throw error;
    });
    await removeInstalledExecutable(directory);
    process.stdout.write(`${JSON.stringify({ status: 'startup removed', note: 'Credentials and work history are preserved. Revoke access in Envoi to invalidate credentials' })}\n`); return;
  }
  const stop = new AbortController(); const cancel = () => stop.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try { await startConnection(directory, stop.signal, adapterFor, { onReady: () => process.stdout.write('Envoi connector started. Waiting for incoming work.\n'),
    onWaiting: code => process.stderr.write(`Connection temporarily unavailable (${code}); retrying automatically.\n`) }); }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
