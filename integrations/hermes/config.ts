import { lstat, readFile, writeFile, rename, rm, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ConnectorSetupError, type AdapterOptions } from '../connector/adapter';
import { windowsAccountSid, windowsExecutable } from '../connector/windows';

export interface HermesConfiguration {
  home: string;
  profile: string;
  configPath: string;
  apiUrl: string;
  apiKey: string;
  assetManifestPath?: string;
}

export async function optionalText(filename: string): Promise<string | null> {
  try { return await readFile(filename, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

/** Parse assignments as data. No expansion, shell execution or provider-secret output. */
export function envValue(text: string, name: string): string | undefined {
  const matches = text.replace(/^\uFEFF/, '').split(/\r?\n/)
    .map(line => line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/))
    .filter(match => match?.[1] === name);
  if (matches.length > 1) throw new ConnectorSetupError('CONFIG_AMBIGUOUS', `Hermes has duplicate ${name} assignments. Resolve them locally and retry.`);
  if (!matches.length) return undefined;
  const raw = matches[0]![2].trim();
  const quote = raw[0];
  if (quote === '"' || quote === "'") {
    const end = raw.indexOf(quote, 1);
    if (end < 0 || !/^\s*(?:#.*)?$/.test(raw.slice(end + 1))) throw new ConnectorSetupError('CONFIG_INVALID', `Hermes ${name} must be a single-line literal.`);
    return raw.slice(1, end);
  }
  return raw.replace(/\s+#.*$/, '').trim();
}

export function setEnvValue(text: string, name: string, value: string): string {
  envValue(text, name); // Reject duplicate/malformed existing assignments first.
  if (!/^[A-Za-z0-9_]+$/.test(name) || /[\r\n\x00]/.test(value)) throw new ConnectorSetupError('CONFIG_INVALID', 'Invalid local environment assignment.');
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const index = lines.findIndex(line => new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(line));
  const assignment = `${name}=${value}`;
  if (index >= 0) lines[index] = assignment;
  else { if (lines.at(-1) === '') lines.pop(); lines.push(assignment); }
  return `${lines.join('\n').replace(/\n*$/, '')}\n`;
}

/** Atomic changes, immutable private backup, and no writes through symlink files. */
export async function replaceConfiguration(filename: string, original: string | null, updated: string) {
  if (original === updated) return;
  const existing = await lstat(filename).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new ConnectorSetupError('CONFIG_INVALID', 'Hermes configuration must be a regular file, without symbolic links.');
  if (await optionalText(filename) !== original) throw new ConnectorSetupError('CONFIG_CHANGED', 'Hermes configuration changed during setup. Retry without concurrent configuration edits.');
  if (original !== null) {
    const backup = `${filename}.envoi-backup-${randomUUID()}`;
    await writeFile(backup, original, { flag: 'wx', mode: 0o600 });
    await protectFile(backup);
  }
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, updated, { flag: 'wx', mode: 0o600 });
  try { await protectFile(temporary); await rename(temporary, filename); }
  finally { await rm(temporary, { force: true }); }
}

async function protectFile(filename: string) {
  if (process.platform !== 'win32') return chmod(filename, 0o600);
  const execute = promisify(execFile);
  const sid = await windowsAccountSid();
  const script = `$ErrorActionPreference='Stop'; $p='${filename.replaceAll("'", "''")}'; $s=New-Object System.Security.Principal.SecurityIdentifier('${sid}'); $a=New-Object System.Security.AccessControl.FileSecurity; $a.SetAccessRuleProtection($true,$false); $a.SetOwner($s); $a.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($s,'FullControl','Allow'))); ([System.IO.FileInfo]::new($p)).SetAccessControl($a)`;
  try {
    await execute(windowsExecutable('powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20_000 });
  } catch { throw new ConnectorSetupError('STATE_UNAVAILABLE', 'Windows could not protect Hermes local credentials for your account. Choose an owned profile directory and retry; preserve its private backups.'); }
}

const validProfile = (value: string) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);

/** Read only known scalar paths from ordinary block YAML, without evaluating tags. */
export function yamlScalar(text: string, dottedPath: string): string | undefined {
  const wanted = dottedPath.split('.');
  const parents: Array<{ indent: number; name: string }> = [];
  let found: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = line.match(/^( *)([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!match) continue;
    const indent = match[1].length;
    while (parents.length && parents.at(-1)!.indent >= indent) parents.pop();
    const names = [...parents.map(item => item.name), match[2]];
    const raw = match[3].replace(/\s+#.*$/, '').trim();
    if (names.length < wanted.length && names.every((name, index) => name === wanted[index]) && raw) {
      throw new ConnectorSetupError('CONFIG_UNSUPPORTED', `Hermes ${names.join('.')} uses a nonstandard YAML mapping. Select ordinary block configuration explicitly.`);
    }
    if (names.join('.') === wanted.join('.')) {
      if (found !== undefined || !raw || /^[!&*{|>]/.test(raw)) throw new ConnectorSetupError('CONFIG_UNSUPPORTED', `Hermes ${dottedPath} must be one ordinary scalar value.`);
      found = raw.replace(/^(['"])(.*)\1$/, '$2');
    }
    if (!raw) parents.push({ indent, name: match[2] });
  }
  return found;
}

export function hermesApiBase(value: string, profile?: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new ConnectorSetupError('CONFIG_INVALID', 'Hermes API URL must be an HTTPS or loopback HTTP origin.'); }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  const profileRoute = local && /^\/p\/[a-z][a-z0-9-]*$/.test(url.pathname)
    && (profile === undefined || url.pathname === `/p/${profile}`);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && !profileRoute)) {
    throw new ConnectorSetupError('CONFIG_INVALID', 'Hermes API URL must be an HTTPS or loopback HTTP origin.');
  }
  return profileRoute ? `${url.origin}${url.pathname}` : url.origin;
}

export async function discoverHermes(options: AdapterOptions, previous?: HermesConfiguration): Promise<HermesConfiguration> {
  if (previous !== undefined) {
    if (!previous || typeof previous !== 'object' || Array.isArray(previous)
      || Object.keys(previous).some(key => !['home', 'profile', 'configPath', 'apiUrl', 'apiKey', 'assetManifestPath'].includes(key))
      || typeof previous.home !== 'string' || !path.isAbsolute(previous.home)
      || typeof previous.configPath !== 'string' || !path.isAbsolute(previous.configPath)
      || typeof previous.profile !== 'string' || !validProfile(previous.profile)
      || typeof previous.apiUrl !== 'string' || typeof previous.apiKey !== 'string' || !previous.apiKey
      || /[\r\n\x00]/.test(previous.apiKey)
      || previous.assetManifestPath !== undefined && (typeof previous.assetManifestPath !== 'string' || !path.isAbsolute(previous.assetManifestPath) || /[\r\n\x00]/.test(previous.assetManifestPath))) {
      throw new ConnectorSetupError('STATE_INVALID', 'The saved Hermes configuration is invalid; preserve the connection directory.');
    }
    hermesApiBase(previous.apiUrl, previous.profile);
  }
  const env = options.env ?? process.env;
  const accountHome = options.homeDir ?? env.HERMES_REAL_HOME ?? homedir();
  const absolutePath = (value: string) => path.resolve(/^~[\\/]/.test(value) ? path.join(accountHome, value.slice(2)) : value);
  let home: string;
  let profile = options.profile;
  const resumeSelected = !!previous && !options.configPath && !options.profile;
  if (resumeSelected) { home = previous!.home; profile = previous!.profile; }
  else if (options.configPath) home = path.dirname(absolutePath(options.configPath));
  else if (env.HERMES_HOME && !profile) home = absolutePath(env.HERMES_HOME);
  else if (previous && !profile && !env.HERMES_HOME) home = previous.home;
  else {
    const suffix = env.HERMES_DATA_DIR_SUFFIX ?? '';
    if (!/^[A-Za-z0-9_-]*$/.test(suffix)) throw new ConnectorSetupError('CONFIG_INVALID', 'Hermes data directory suffix is invalid.');
    const candidates = env.HERMES_HOME ? [path.basename(path.dirname(absolutePath(env.HERMES_HOME))) === 'profiles'
      ? path.dirname(path.dirname(absolutePath(env.HERMES_HOME))) : absolutePath(env.HERMES_HOME)]
      : [path.join(accountHome, `.hermes${suffix}`)];
    if (!env.HERMES_HOME && (options.platform ?? process.platform) === 'win32') candidates.push(path.join(env.LOCALAPPDATA ?? path.join(accountHome, 'AppData', 'Local'), `hermes${suffix}`));
    const found: string[] = [];
    for (const candidate of candidates) {
      if (await optionalText(path.join(candidate, 'config.yaml')) !== null || await optionalText(path.join(candidate, '.env')) !== null) found.push(candidate);
    }
    const distinct = [...new Set(found.map(value => path.resolve(value)))];
    if (!distinct.length) throw new ConnectorSetupError('RUNTIME_NOT_FOUND', 'Hermes profile was not found on this host. Run setup on its persistent host or provide --config /path/to/config.yaml.');
    if (distinct.length > 1) throw new ConnectorSetupError('CONFIG_AMBIGUOUS', 'Several Hermes installations were found. Select the intended profile with HERMES_HOME or --config.');
    const root = distinct[0];
    profile ??= (await optionalText(path.join(root, 'active_profile')))?.trim() || 'default';
    if (!validProfile(profile)) throw new ConnectorSetupError('CONFIG_INVALID', 'Hermes active profile is invalid. Select a valid profile explicitly.');
    home = profile === 'default' ? root : path.join(root, 'profiles', profile);
  }
  profile ??= path.basename(path.dirname(home)) === 'profiles' ? path.basename(home) : 'default';
  if (!validProfile(profile)) throw new ConnectorSetupError('CONFIG_INVALID', 'Hermes profile name is invalid.');
  const configPath = options.configPath ? absolutePath(options.configPath) : resumeSelected ? previous!.configPath : path.join(home, 'config.yaml');
  const configuration = await optionalText(configPath);
  const envPath = path.join(home, '.env');
  const original = await optionalText(envPath);
  if (configuration === null && original === null) throw new ConnectorSetupError('RUNTIME_NOT_FOUND', 'The selected Hermes profile has no configuration. Configure it with hermes setup first.');
  const terminalBackend = env.TERMINAL_ENV ?? env.TERMINAL_BACKEND ?? yamlScalar(configuration ?? '', 'terminal.backend') ?? 'local';
  if (!options.configPath && !resumeSelected && env.HERMES_HOME && terminalBackend !== 'local') throw new ConnectorSetupError('RUNTIME_HOST_MISMATCH', 'Hermes terminal tools use a nonlocal backend. Run this installer directly on the persistent Gateway host and explicitly select its config with --config; do not install unattended receiving in an agent sandbox.');
  // The shared core supplies stateDir during setup/start. Standalone prepare has
  // no future connection identity, so existing Envoi entries require doctor
  // or deliberate migration rather than being silently attached to a new agent.
  const stateDir = (options as AdapterOptions & { stateDir?: string }).stateDir;
  let serverName = stateDir ? hermesServerName(stateDir) : 'envoi_preflight';
  if (stateDir) {
    const savedRelay = await optionalText(path.join(stateDir, 'hermes-relay.json'));
    if (savedRelay !== null) {
      let relay: { serverName?: unknown };
      try { relay = JSON.parse(savedRelay) as { serverName?: unknown }; }
      catch { throw new ConnectorSetupError('STATE_INVALID', 'Hermes relay state is unreadable. Restore its private saved configuration.'); }
      if (!relay || typeof relay !== 'object' || Array.isArray(relay) || typeof relay.serverName !== 'string' || !/^envoi_[a-f0-9]{16}$/.test(relay.serverName)) throw new ConnectorSetupError('STATE_INVALID', 'Hermes relay identity is invalid.');
      serverName = relay.serverName;
    }
  }
  // This validates deterministic YAML/profile conflicts before enrollment or
  // local API-key preparation. It does not allocate ports or write config.
  mergeMcpConfiguration(configuration ?? '', serverName, [`  ${serverName}:`, '    url: "http://127.0.0.1:1/mcp"']);
  let text = original ?? '';
  let apiKey = env.HERMES_API_KEY || envValue(text, 'API_SERVER_KEY') || env.API_SERVER_KEY;
  const yamlEnabled = yamlScalar(configuration ?? '', 'gateway.platforms.api_server.enabled') ?? yamlScalar(configuration ?? '', 'platforms.api_server.enabled');
  const enabled = yamlEnabled ?? envValue(text, 'API_SERVER_ENABLED') ?? env.API_SERVER_ENABLED;
  if (yamlEnabled === 'false') throw new ConnectorSetupError('GATEWAY_NOT_ENABLED', 'Hermes config.yaml explicitly disables its API Server. Enable the selected profile API Server there; environment settings cannot override that configuration.');
  if (!options.gatewayUrl && !env.HERMES_API_URL && !previous?.apiUrl && enabled !== 'true' && !options.prepareRuntime) {
    throw new ConnectorSetupError('GATEWAY_NOT_ENABLED', 'Hermes API Server is disabled. Retry with --prepare-runtime, then start the selected profile Gateway.');
  }
  const port = yamlScalar(configuration ?? '', 'gateway.platforms.api_server.port') ?? yamlScalar(configuration ?? '', 'platforms.api_server.port') ?? envValue(text, 'API_SERVER_PORT') ?? env.API_SERVER_PORT ?? '8642';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new ConnectorSetupError('CONFIG_INVALID', 'Hermes API_SERVER_PORT is invalid.');
  const apiUrl = hermesApiBase(options.gatewayUrl ?? env.HERMES_API_URL ?? previous?.apiUrl ?? `http://127.0.0.1:${port}`, profile);
  const remote = !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(apiUrl).hostname);
  if (remote) {
    // Never attach a discovered local API key to an arbitrary HTTPS host.
    apiKey = env.HERMES_API_KEY || (previous?.apiUrl === apiUrl ? previous.apiKey : undefined);
    if (!apiKey) throw new ConnectorSetupError('GATEWAY_KEY_MISSING', 'A remote Hermes API requires explicitly supplied HERMES_API_KEY for that origin. Local profile keys are never forwarded to a new remote host.');
  } else if (options.prepareRuntime) {
    apiKey ||= randomBytes(32).toString('hex');
    text = setEnvValue(text, 'API_SERVER_KEY', apiKey);
    text = setEnvValue(text, 'API_SERVER_ENABLED', 'true');
    await replaceConfiguration(envPath, original, text);
  }
  if (!apiKey) throw new ConnectorSetupError('GATEWAY_KEY_MISSING', 'Hermes local API_SERVER_KEY is missing. Retry with --prepare-runtime to generate it. This key is separate from model-provider credentials.');
  if (/[\r\n\x00]/.test(apiKey)) throw new ConnectorSetupError('CONFIG_INVALID', 'Hermes local API Server key must be a single-line literal.');
  const manifest = env.ENVOI_ASSET_MANIFEST_PATH ?? previous?.assetManifestPath;
  if (manifest && /[\r\n\x00]/.test(manifest)) throw new ConnectorSetupError('CONFIG_INVALID', 'The approved asset manifest must be a local file path.');
  return { home, profile, configPath, apiUrl, apiKey, ...(manifest ? { assetManifestPath: path.resolve(manifest) } : {}) };
}

export function hermesServerName(stateDir: string) {
  return `envoi_${createHash('sha256').update(path.resolve(stateDir)).digest('hex').slice(0, 16)}`;
}

/** Conservative block-YAML edit: untouched sections remain byte-for-byte equivalent. */
export function mergeMcpConfiguration(text: string, name: string, block: string[]): string {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const sections = lines.map((line, index) => /^mcp_servers\s*:/.test(line) ? index : -1).filter(index => index >= 0);
  if (sections.length > 1 || (sections.length === 1 && !/^mcp_servers:\s*(?:#.*)?$/.test(lines[sections[0]]))) {
    throw new ConnectorSetupError('CONFIG_UNSUPPORTED', 'Hermes MCP configuration uses an unsupported or duplicate YAML section. Preserve it and configure the connector entry manually.');
  }
  if (!sections.length) {
    if (lines.at(-1) === '') lines.pop();
    lines.push('', 'mcp_servers:', ...block);
  } else {
    const start = sections[0] + 1;
    let end = start;
    while (end < lines.length && !/^[^\s#]/.test(lines[end])) end++;
    const entries: Array<{ name: string; start: number }> = [];
    for (let index = start; index < end; index++) {
      const match = lines[index].match(/^  ([A-Za-z0-9_-]+):\s*(?:#.*)?$/);
      if (match) entries.push({ name: match[1], start: index });
      else if (lines[index].trim() && !lines[index].trimStart().startsWith('#') && !/^ {4,}\S/.test(lines[index])) {
        throw new ConnectorSetupError('CONFIG_UNSUPPORTED', 'Hermes MCP section must use ordinary block YAML with two-space server entries.');
      }
    }
    if (entries.some(entry => (entry.name === 'envoi' || entry.name.startsWith('envoi_')) && entry.name !== name)) {
      throw new ConnectorSetupError('PROFILE_ALREADY_CONNECTED', 'This Hermes profile already has an Envoi MCP entry. Preserve its connection or deliberately migrate that entry; use a separate Hermes profile for another enrolled agent.');
    }
    const matching = entries.filter(entry => entry.name === name);
    if (matching.length > 1) throw new ConnectorSetupError('CONFIG_AMBIGUOUS', 'Hermes has duplicate connector MCP entries.');
    if (matching.length) {
      const entry = matching[0];
      const next = entries.find(item => item.start > entry.start)?.start ?? end;
      lines.splice(entry.start, next - entry.start, ...block);
    } else lines.splice(start, 0, ...block);
  }
  return `${lines.join('\n').replace(/\n*$/, '')}\n`;
}
