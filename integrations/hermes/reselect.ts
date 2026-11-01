import path from 'node:path';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stderr } from 'node:process';
import { ConnectorSetupError, type AdapterOptions } from '../connector/adapter';
import { privateDirectory, privateJson, acquireConnectorLock } from '../connector/store';
import { FileScopedRunStore } from '../grok/scoped-store';
import { currentHermesHost, hermesJournalMatches, inspectHermesTerminalTurn, type HermesScopedHost } from './scoped-host';
import { assertScopedHermes, hermesHost, readHermesSelection, sameHermesConfiguration, sameHermesProfile, type HermesRuntimeConfiguration } from './scoped-runtime';

export interface GatewayReselectionReview { agentAddress: string; profile: string; workspace: string; previousOrigin: string; nextOrigin: string; retainedTerminalTurns?: number }
export async function nativeGatewayReselection(review: GatewayReselectionReview, signal: AbortSignal): Promise<boolean> {
  if (!stdin.isTTY || !stderr.isTTY) return false;
  const prompt = createInterface({ input: stdin, output: stderr });
  try {
    const answer = await prompt.question(`\nReselect the restarted Hermes gateway for ${review.agentAddress}?\nProfile: ${review.profile}\nWorkspace: ${review.workspace}\nPrevious local address: ${review.previousOrigin}\nVerified current local address: ${review.nextOrigin}\n${review.retainedTerminalTurns ? `${review.retainedTerminalTurns} unfinished local journal(s) have verified terminal native receipts; they stay unchanged and will not be replayed by this operation.\n` : ''}The same enrollment and scoped workspace will be preserved. Type yes to save this selection: `,
      { signal: AbortSignal.any([signal, AbortSignal.timeout(300000)]) });
    return answer.trim().toLowerCase() === 'yes' && !signal.aborted;
  } catch { return false; } finally { prompt.close(); }
}
const refused = (code = 'GATEWAY_RESELECTION_REFUSED') => new ConnectorSetupError(code, 'Preserve the saved enrollment and journals. Review the selected profile before retrying gateway reselection.');
async function privateRecord(filename: string) {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128000) throw refused();
  return JSON.parse(await readFile(filename, 'utf8'));
}
export async function reselectHermesGateway(directory: string, origin: string, signal: AbortSignal, options: AdapterOptions & {
  confirmGateway?: typeof nativeGatewayReselection; discoverGateway?: typeof currentHermesHost;
  inspectTerminalTurn?: typeof inspectHermesTerminalTurn;
  secureDirectory?: typeof privateDirectory; selectionFault?: (stage: string) => Promise<void>;
} = {}): Promise<HermesRuntimeConfiguration | null> {
  await (options.secureDirectory ?? privateDirectory)(directory);
  const unlock = await acquireConnectorLock(directory);
  try {
    const connection = await privateRecord(path.join(directory, 'connection.json'));
    const session = await privateRecord(path.join(directory, 'session.json'));
    const helper = await privateRecord(path.join(directory, 'helper-state.json'));
    const selection = await readHermesSelection(directory);
    if (!selection || connection.version !== 1 || connection.runtime !== 'hermes' || connection.apiUrl !== origin
      || helper.version !== 1 || helper.phase !== 'completed' || helper.origin !== origin || helper.runtime?.type !== 'hermes'
      || typeof helper.completionId !== 'string' || !helper.completionId
      || typeof session.agentId !== 'string' || !session.agentId || typeof session.inboxId !== 'string' || !session.inboxId
      || typeof session._onboarding?.installation?.id !== 'string' || !session._onboarding.installation.id
      || helper.completionId !== session._onboarding?.completionId
      || connection.address !== session.address || !/^[A-Za-z0-9][A-Za-z0-9+_.-]{0,127}@[a-z0-9][a-z0-9.-]+$/.test(session.address)
      || connection.activationSetup?.completionId !== session._onboarding?.completionId
      || connection.activationSetup?.installationId !== session._onboarding?.installation?.id
      || session._onboarding?.origin !== origin || session._onboarding?.runtime?.type !== 'hermes'
      || session._onboarding?.agent?.id !== session.agentId || session._onboarding?.agent?.address !== session.address
      || session._onboarding?.installation?.agentId !== session.agentId
      || connection.activationSetup?.agentId !== session.agentId || connection.activationSetup?.inboxId !== session.inboxId
      || session._onboarding?.installation?.connectionRoute !== 'local_helper'
      || session._onboarding?.installation?.deliveryMode !== 'envoi_link'
      || session._onboarding?.installation?.legacy !== false
      || ['REVOKED', 'NEEDS_RECONNECT'].includes(session.lifecycle?.state)) throw refused();
    const cached = connection.configuration as HermesRuntimeConfiguration;
    if (!sameHermesConfiguration(cached, selection.configuration)
      && !(selection.version === 2 && sameHermesConfiguration(cached, selection.previousConfiguration!))) throw refused();
    const previous = selection.configuration;
    const env = options.env ?? process.env;
    const canonical = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    if (env.HERMES_HOME && canonical(env.HERMES_HOME) !== canonical(previous.home)
      || options.configPath && canonical(options.configPath) !== canonical(previous.configPath)
      || options.profile && options.profile !== previous.profile
      || env.HERMES_SCOPED_CWD && canonical(env.HERMES_SCOPED_CWD) !== canonical(previous.scopedCwd!)) throw refused();
    await assertScopedHermes(previous, env);
    const discover = options.discoverGateway ?? currentHermesHost;
    const host: HermesScopedHost = await discover(previous.home, previous.scopedCwd!, signal);
    const next = { ...previous, apiUrl: host.origin, daemonOrigin: host.origin };
    if (host.home !== previous.home || host.cwd !== previous.scopedCwd || !sameHermesProfile(previous, next)
      || env.HERMES_DAEMON_URL && ![previous.daemonOrigin, next.daemonOrigin].includes(env.HERMES_DAEMON_URL)) throw refused();
    await assertScopedHermes(next, env);
    if (sameHermesConfiguration(previous, next)) return next;
    const runsDirectory = path.join(directory, 'scoped-runs');
    const stat = await lstat(runsDirectory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw refused();
    const runs = new FileScopedRunStore(directory);
    const retained: Array<{ workId: string; serialized: string; outcome: string }> = [];
    for (const name of stat ? await readdir(runsDirectory) : []) {
      signal.throwIfAborted();
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.json$/.test(name)) throw refused();
      const file = path.join(runsDirectory, name), entry = await lstat(file);
      if (!entry.isFile() || entry.isSymbolicLink()) throw refused();
      const run = await runs.load(name.slice(0, -5));
      if (!run || run.pending.length || run.admission || !hermesJournalMatches(run, hermesHost(previous))
        || run.input.length !== 1 || run.input[0]?.kind !== 'hermes-scoped-v1') throw refused('HERMES_TURN_RECOVERY_REQUIRED');
      if (!run.completed) {
        if (!hermesJournalMatches(run, host)) throw refused('HERMES_TURN_RECOVERY_REQUIRED');
        const outcome = await (options.inspectTerminalTurn ?? inspectHermesTerminalTurn)(host, run, signal);
        if (!['completed', 'failed', 'interrupted', 'cancelled', 'rejected'].includes(outcome)) throw refused('HERMES_TURN_RECOVERY_REQUIRED');
        retained.push({ workId: run.workId, serialized: JSON.stringify(run), outcome });
      }
    }
    const answer = await (options.confirmGateway ?? nativeGatewayReselection)({ agentAddress: session.address,
      profile: previous.home, workspace: previous.scopedCwd!, previousOrigin: previous.daemonOrigin!, nextOrigin: next.daemonOrigin!,
      ...(retained.length ? { retainedTerminalTurns: retained.length } : {}) }, signal);
    if (answer !== true || signal.aborted) return null;
    // A gateway can restart again while the owner reads the prompt. Never save
    // an address different from the one they actually confirmed.
    const checked = await discover(previous.home, previous.scopedCwd!, signal);
    if (checked.origin !== host.origin || checked.home !== host.home || checked.cwd !== host.cwd) throw refused();
    for (const prior of retained) {
      const run = await runs.load(prior.workId);
      if (!run || JSON.stringify(run) !== prior.serialized
        || await (options.inspectTerminalTurn ?? inspectHermesTerminalTurn)(checked, run, signal) !== prior.outcome)
        throw refused('HERMES_TURN_RECOVERY_REQUIRED');
    }
    const before = await readHermesSelection(directory);
    if (JSON.stringify(before) !== JSON.stringify(selection)
      || JSON.stringify(await privateRecord(path.join(directory, 'connection.json'))) !== JSON.stringify(connection)
      || JSON.stringify(await privateRecord(path.join(directory, 'session.json'))) !== JSON.stringify(session)
      || JSON.stringify(await privateRecord(path.join(directory, 'helper-state.json'))) !== JSON.stringify(helper)) throw refused();
    await privateJson(path.join(directory, `hermes-scoped-before-${randomUUID()}.json`), selection);
    await options.selectionFault?.('before_selection_commit');
    signal.throwIfAborted();
    await privateJson(path.join(directory, 'hermes-scoped.json'), { version: 2, configuration: next, previousConfiguration: cached });
    await options.selectionFault?.('after_selection_commit');
    return next;
  } finally { await unlock(); }
}
