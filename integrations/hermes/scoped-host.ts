import { connect } from 'node:net';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { lstat, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { ConnectorSetupError } from '../connector/adapter';
import { EnvoiError } from '../../sdk/typescript/src/index';
import { PermanentWorkError } from '../../sdk/typescript/src/connector';
import type { ScopedModelTurn } from '../agent-bridges/scoped-turn';
import type { ScopedRunRecord, ScopedRunStore } from '../grok/scoped-store';
import { startScopedMcpRelay } from './scoped-relay';
import { guardNativeSubmission } from './native-binding';
import { verifyNativeGateAttestation, type NativeRequestGateExpectation } from './request-gate-attestation';
import { observeRuntime, type ScopedRuntimeEvent, type ScopedRuntimeObserver } from '../agent-bridges/runtime-events';

const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = (code = 'HERMES_SCOPED_UNAVAILABLE') => new EnvoiError('Hermes scoped execution unavailable; preserve the turn journal for recovery', undefined, code);
const daemonUnavailable = () => failure('HERMES_DAEMON_UNREACHABLE');
const protocol = 'hermes-gateway-v1';
// Exact native JSON-RPC response bytes, retained only for that parsed result's
// lifetime. Never reconstruct a native receipt from an Envoi run journal.
const nativeRpcBytes=new WeakMap<object,string>();
const requiredCapabilities = ['acp-editor-policy-v1', 'acp-session-mcp-v1'];

export interface HermesScopedHost {
  home: string;
  origin: string;
  cwd: string;
}

/** Validate the selected profile before accepting the live daemon's origin. */
export function selectedHermesProfile(identity: Record<string, any>, host: HermesScopedHost): string {
  if (identity.state === 'starting' || identity.state === 'draining') throw daemonUnavailable();
  const canonical = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const matches = Array.isArray(identity.served_profiles) ? identity.served_profiles.filter((entry: unknown) => object(entry)
    && typeof entry.home === 'string' && canonical(entry.home) === canonical(host.home)) : [];
  if (identity.runtime_protocol !== 1 || identity.state !== 'ready'
    || !Array.isArray(identity.capabilities) || !identity.capabilities.includes('session-authority-v1')
    || typeof identity.instance_id !== 'string' || matches.length !== 1 || typeof matches[0].profile_id !== 'string') throw failure();
  if (identity.api_origin !== host.origin) throw failure('HERMES_ORIGIN_CHANGED');
  return matches[0].profile_id;
}

export interface HermesHostObservation {
  connection: 'ready' | 'origin_changed' | 'not_ready' | 'unverified';
  supervisor: 'none' | 'systemd' | 'launchd' | 'external' | 'unknown';
  originMatches: boolean | null;
}

/** Project only safe live descriptor fields; never expose profile IDs, origins or tickets. */
export function summarizeHermesIdentity(identity: Record<string, any>, host: HermesScopedHost): HermesHostObservation {
  try {
    selectedHermesProfile(identity, host);
    const supervisor = ['none', 'systemd', 'launchd', 'external'].includes(identity.supervisor) ? identity.supervisor : 'unknown';
    return { connection: 'ready', supervisor, originMatches: true };
  } catch (error) {
    if (error instanceof EnvoiError && error.code === 'HERMES_ORIGIN_CHANGED') {
      const supervisor = ['none', 'systemd', 'launchd', 'external'].includes(identity.supervisor) ? identity.supervisor : 'unknown';
      return { connection: 'origin_changed', supervisor, originMatches: false };
    }
    return { connection: error instanceof EnvoiError && error.code === 'HERMES_DAEMON_UNREACHABLE' ? 'not_ready' : 'unverified',
      supervisor: 'unknown', originMatches: null };
  }
}

export async function inspectHermesHost(host: HermesScopedHost): Promise<HermesHostObservation> {
  validateHermesHost(host);
  try { return summarizeHermesIdentity(await control(host.home, 'identify', {}, AbortSignal.timeout(6000)), host); }
  catch { return { connection: 'unverified', supervisor: 'unknown', originMatches: null }; }
}

export function validateHermesHost(host: HermesScopedHost) {
  const url = new URL(host.origin);
  if (!path.isAbsolute(host.home) || !path.isAbsolute(host.cwd) || /[\x00\r\n]/.test(host.home + host.cwd)
    || !['127.0.0.1', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol)
    || !url.port || url.origin !== host.origin || url.username || url.password) throw new ConnectorSetupError('CONFIG_INVALID', 'Scoped Hermes requires an explicit loopback daemon origin and absolute local profile/workspace paths');
}

async function controlPath(home: string) {
  if (process.platform === 'win32') return `\\\\.\\pipe\\hermes-gateway-${createHash('sha256').update(path.resolve(home).toLowerCase()).digest('hex').slice(0, 16)}`;
  const direct = path.join(home, 'gateway.sock');
  if (await lstat(direct).catch(() => null)) return direct;
  const pointer = path.join(home, 'gateway.sock.path');
  const stat = await lstat(pointer).catch(error => { if (error.code === 'ENOENT') throw daemonUnavailable(); throw error; });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 || stat.mode & 0o077) throw failure();
  const target = (await readFile(pointer, 'utf8')).trim();
  if (!path.isAbsolute(target)) throw failure();
  return target;
}

async function control(home: string, verb: string, params: Record<string, unknown>, signal: AbortSignal) {
  signal.throwIfAborted();
  const target = await controlPath(home);
  return new Promise<Record<string, any>>((resolve, reject) => {
    const socket = connect(target);
    let buffered = '';
    const timer = setTimeout(() => finish(daemonUnavailable()), 5000);
    const abort = () => finish(signal.reason);
    const finish = (error?: unknown, result?: Record<string, any>) => {
      clearTimeout(timer); signal.removeEventListener('abort', abort); socket.destroy();
      if (error) reject(error); else resolve(result!);
    };
    signal.addEventListener('abort', abort, { once: true });
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify({ protocol: 1, id: 1, verb, params }) + '\n'));
    socket.on('error', error => finish(['ENOENT', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'].includes((error as NodeJS.ErrnoException).code ?? '')
      ? daemonUnavailable() : failure()));
    socket.on('end', () => { if (!buffered.includes('\n')) finish(failure()); });
    socket.on('data', chunk => {
      buffered += chunk;
      if (Buffer.byteLength(buffered) > 65536) return finish(failure());
      if (!buffered.includes('\n')) return;
      try {
        const frame = JSON.parse(buffered.split('\n')[0]);
        if (!object(frame) || frame.protocol !== 1 || frame.id !== 1 || frame.ok !== true || !object(frame.result)) throw failure();
        finish(undefined, frame.result);
      } catch { finish(failure()); }
    });
    if (signal.aborted) abort();
  });
}

export interface HermesWire {
  rpc(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, any>>;
  close(): void;
}
interface HermesHostWire extends HermesWire { readonly instanceId: string; readonly profileId: string }

/** Only genuine status socket loss/deadline is reconnectable, never protocol rejection. */
class HermesStatusTransportError extends EnvoiError {
  constructor(reason: 'rpc_deadline' | 'socket_error' | 'peer_close') {
    super('Hermes status transport was lost', undefined, 'HERMES_SCOPED_UNAVAILABLE', { reason });
  }
}

export function hermesSocketWire(socket: WebSocket): HermesWire {
  let sequence = 0, active = true, total = 0;
  let closedReason: unknown;
  const closing = () => socket.readyState === 2 || socket.readyState === 3;
  const pending = new Map<number, { resolve(value: Record<string, any>): void; reject(error: unknown): void; cleanup(): void }>();
  const close = (error: unknown = failure()) => {
    if (!active) return;
    active = false; closedReason = error;
    for (const operation of pending.values()) { operation.cleanup(); operation.reject(error); }
    pending.clear();
    socket.removeEventListener('message', receive); socket.removeEventListener('error', lost); socket.removeEventListener('close', lost);
    socket.close();
  };
  const lost = (event?: Event) => {
    const code = event?.type === 'close' ? (event as CloseEvent).code : undefined;
    // Protocol/policy close frames are refusals, not a temporary status outage.
    if (code !== undefined && ![1000, 1001, 1005, 1006, 1011, 1012, 1013].includes(code))
      close(failure('HERMES_SCOPED_REFUSED'));
    else close(new HermesStatusTransportError(event?.type === 'close' ? 'peer_close' : event?.type === 'error' ? 'socket_error' : 'rpc_deadline'));
  };
  const receive = (event: MessageEvent) => {
    try {
      if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > 1000000 || (total += Buffer.byteLength(event.data)) > 16000000) throw failure();
      const frame: unknown = JSON.parse(event.data);
      if (!object(frame) || frame.jsonrpc !== '2.0') throw failure();
      if (!('id' in frame) && typeof frame.method === 'string') return;
      const operation = pending.get(frame.id);
      if (!operation || ('result' in frame) === ('error' in frame)) throw failure();
      pending.delete(frame.id); operation.cleanup();
      if (object(frame.error)) {
        const reason = frame.error.message === 'stale_generation' ? 'HERMES_STALE_GENERATION' : 'HERMES_SCOPED_REFUSED';
        operation.reject(failure(reason));
      } else if (object(frame.result)){nativeRpcBytes.set(frame.result,event.data);operation.resolve(frame.result);}
      else { operation.reject(failure()); close(); }
    } catch { close(); }
  };
  socket.addEventListener('message', receive); socket.addEventListener('error', lost); socket.addEventListener('close', lost);
  return { close: () => close(), rpc(method, params, signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      if (!active) return reject(closedReason);
      if (pending.size >= 4 || socket.readyState === 0) return reject(failure());
      const id = ++sequence;
      const abort = () => { close(signal.reason); reject(signal.reason); };
      // A closing socket's CloseEvent owns the protocol/policy verdict. Wait
      // for it instead of classifying its not-yet-delivered code as an outage.
      const timer = setTimeout(() => { if (closing()) close(); else lost(); }, 30000);
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
      pending.set(id, { resolve, reject, cleanup }); signal.addEventListener('abort', abort, { once: true });
      if (closing()) { if (signal.aborted) abort(); return; }
      const text = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      if (Buffer.byteLength(text) > 524288 || socket.bufferedAmount > 524288) return close();
      try { socket.send(text); }
      catch { if (active && !closing()) close(); }
      if (signal.aborted) abort();
    });
  } };
}

export async function connectHermesHost(host: HermesScopedHost, signal: AbortSignal, expectedInstanceId?: string): Promise<HermesHostWire> {
  validateHermesHost(host);
  const identity = await control(host.home, 'identify', {}, signal);
  if (expectedInstanceId !== undefined && identity.instance_id !== expectedInstanceId) throw failure('HERMES_INSTANCE_CHANGED');
  const profileId = selectedHermesProfile(identity, host);
  const grant = await control(host.home, 'session-ticket', { profile_id: profileId, instance_id: identity.instance_id, purpose: 'interactive' }, signal);
  if (grant.runtime_protocol !== 1 || grant.profile_id !== profileId || grant.instance_id !== identity.instance_id
    || typeof grant.ticket !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(grant.ticket)) throw failure();
  const socket = new WebSocket(host.origin.replace(/^http/, 'ws') + '/api/ws', [protocol, 'hermes-gateway-ticket.' + grant.ticket]);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(failure()), 10000);
      const abort = () => finish(signal.reason);
      const failed = () => finish(failure());
      const opened = () => finish(socket.protocol === protocol ? undefined : failure());
      const finish = (error?: unknown) => {
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        socket.removeEventListener('open', opened); socket.removeEventListener('error', failed); socket.removeEventListener('close', failed);
        if (error) reject(error); else resolve();
      };
      signal.addEventListener('abort', abort, { once: true }); socket.addEventListener('open', opened);
      socket.addEventListener('error', failed); socket.addEventListener('close', failed);
      if (signal.aborted) abort();
    });
    const wire = hermesSocketWire(socket);
    try {
      const descriptor = await wire.rpc('runtime.describe', {}, signal);
      if (descriptor.profile_id !== profileId || descriptor.instance_id !== identity.instance_id
        || !Array.isArray(descriptor.capabilities) || requiredCapabilities.some(capability => !descriptor.capabilities.includes(capability))
        || !object(descriptor.session_create) || !descriptor.session_create.sources?.includes('acp')) throw failure();
      return Object.freeze({ ...wire, instanceId: identity.instance_id, profileId });
    } catch (error) { wire.close(); throw error; }
  } catch (error) { socket.close(); throw error; }
}

/** Discover only the canonical listener owned by the selected local profile. */
export async function currentHermesHost(home: string, cwd: string, signal: AbortSignal): Promise<HermesScopedHost> {
  const identity = await control(home, 'identify', {}, signal);
  const host = { home, cwd, origin: identity.api_origin };
  validateHermesHost(host);
  const canonical = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const matches = Array.isArray(identity.served_profiles) ? identity.served_profiles.filter((entry: unknown) => object(entry)
    && typeof entry.home === 'string' && canonical(entry.home) === canonical(home)) : [];
  if (identity.runtime_protocol !== 1 || identity.state !== 'ready' || !Array.isArray(identity.capabilities)
    || !identity.capabilities.includes('session-authority-v1') || typeof identity.instance_id !== 'string'
    || matches.length !== 1 || typeof matches[0].profile_id !== 'string') throw failure();
  // Recheck the ticketed descriptor; identify alone is not runtime readiness.
  const wire = await connectHermesHost(host, signal);
  wire.close();
  return host;
}

export function hermesProfileIdentity(host: HermesScopedHost): string {
  validateHermesHost(host);
  return `hermes-profile:${JSON.stringify([host.home, host.cwd])}`;
}

export function hermesJournalMatches(record: { model: string; completed: boolean }, host: HermesScopedHost): boolean {
  if (record.model === hermesProfileIdentity(host) || record.model === `hermes-daemon:${host.origin}:${host.home}:${host.cwd}`) return true;
  // Completed legacy checkpoints remain dedupe evidence for this exact profile
  // and workspace. An unfinished legacy turn never changes daemon implicitly.
  const suffix = `:${host.home}:${host.cwd}`;
  if (!record.completed || !record.model.startsWith('hermes-daemon:') || !record.model.endsWith(suffix)) return false;
  const origin = record.model.slice('hermes-daemon:'.length, -suffix.length);
  try { validateHermesHost({ ...host, origin }); return true; } catch { return false; }
}

type TurnState = { kind: 'hermes-scoped-v1'; requestId: string; inputId: string; text: string; sessionId?: string; admissionId?: string };

function receipt(value: Record<string, any>, sessionId: string, admissionId?: string, profileId?: string) {
  if (typeof value.admission_id !== 'string' || !value.admission_id || value.admission_id.length > 256
    || admissionId !== undefined && value.admission_id !== admissionId || !object(value.ref) || value.ref.session_id !== sessionId
    || profileId !== undefined && value.ref.profile_id !== profileId
    || !['queued', 'started', 'unknown', 'terminal'].includes(value.status)
    || value.status === 'started' && (!Number.isSafeInteger(value.execution_generation) || value.execution_generation < 1)) throw failure();
  return value;
}

async function cancelAdmission(wire: HermesHostWire, sessionId: string, admissionId: string) {
  const signal = AbortSignal.timeout(5000);
  try { await wire.rpc('prompt.cancel', { session_id: sessionId, admission_id: admissionId }, signal); }
  catch (error) { if (!(error instanceof EnvoiError) || error.code !== 'HERMES_STALE_GENERATION') throw error; }
  let current = receipt(await wire.rpc('prompt.receipt', { session_id: sessionId, admission_id: admissionId }, signal), sessionId, admissionId, wire.profileId);
  if (current.status === 'started') {
    try { await wire.rpc('session.interrupt', { session_id: sessionId, execution_generation: current.execution_generation }, signal); }
    catch (error) { if (!(error instanceof EnvoiError) || error.code !== 'HERMES_STALE_GENERATION') throw error; }
  }
  while (current.status !== 'terminal' && current.status !== 'unknown') {
    await delay(50, undefined, { signal });
    current = receipt(await wire.rpc('prompt.receipt', { session_id: sessionId, admission_id: admissionId }, signal), sessionId, admissionId, wire.profileId);
  }
}

/** Read the original admission only. This never submits, interrupts or repairs a turn. */
export async function inspectHermesTerminalEvidence(host: HermesScopedHost, run: ScopedRunRecord, signal: AbortSignal) {
  const state = run.input[0];
  if (!hermesJournalMatches(run, host) || run.input.length !== 1 || state?.kind !== 'hermes-scoped-v1'
    || run.pending.length || run.admission || typeof state.sessionId !== 'string' || !state.sessionId || state.sessionId.length > 256
    || typeof state.admissionId !== 'string' || !state.admissionId || state.admissionId.length > 256) throw failure('HERMES_TURN_RECOVERY_REQUIRED');
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
  const wire = await connectHermesHost(host, bounded);
  let subscription: string | undefined;
  try {
    const attached = await wire.rpc('session.resume', { session_id: state.sessionId, omit_messages: true }, bounded);
    if (attached.session_id !== state.sessionId || typeof attached.subscription_id !== 'string') throw failure();
    subscription = attached.subscription_id;
    const current = receipt(await wire.rpc('prompt.receipt', { session_id: state.sessionId, admission_id: state.admissionId }, bounded), state.sessionId, state.admissionId, wire.profileId);
    if (current.status !== 'terminal' || !['completed', 'failed', 'interrupted', 'cancelled', 'rejected'].includes(current.outcome))
      throw failure('HERMES_TURN_RECOVERY_REQUIRED');
    const receiptRawBytes=nativeRpcBytes.get(current);
    if(!receiptRawBytes||current.input_id!==undefined&&(typeof state.inputId!=='string'||current.input_id!==state.inputId))throw failure('HERMES_TURN_RECOVERY_REQUIRED');
    return Object.freeze({receipt:Object.freeze({...current,ref:Object.freeze({...current.ref})}),receiptRawBytes,
      sessionId:state.sessionId,admissionId:state.admissionId,journalInputId:state.inputId,
      profileId:wire.profileId,instanceId:wire.instanceId,outcome:current.outcome as string});
  } finally {
    if (subscription) await wire.rpc('session.detach', { session_id: state.sessionId, subscription_id: subscription }, AbortSignal.timeout(1000)).catch(() => {});
    wire.close();
  }
}

/** Backwards-compatible terminal verdict from the same read-only native proof. */
export async function inspectHermesTerminalTurn(host: HermesScopedHost, run: ScopedRunRecord, signal: AbortSignal): Promise<string> {
  return(await inspectHermesTerminalEvidence(host,run,signal)).outcome;
}

export async function checkHermesRequestGate(host: HermesScopedHost, expected: NativeRequestGateExpectation,
  signal: AbortSignal, expectedInstanceId?: string) {
  const identity = await control(host.home, 'identify', {}, signal);
  selectedHermesProfile(identity, host);
  if (expectedInstanceId !== undefined && identity.instance_id !== expectedInstanceId) throw failure('HERMES_INSTANCE_CHANGED');
  const challenge = randomBytes(16).toString('hex');
  const attestation = await control(host.home, 'envoi-request-gate-status', { instance_id: identity.instance_id, challenge }, signal);
  return verifyNativeGateAttestation(attestation, expected, identity.instance_id, challenge);
}

export function hermesScopedTurn(host: HermesScopedHost, runs: ScopedRunStore, options: {
  timeoutMs?: number;
  pollMs?: number;
  onRuntimeEvent?: ScopedRuntimeObserver;
  beforeNativeSubmit?: import('./native-binding').NativeSubmissionGuard;
  nativeRequestGate?: NativeRequestGateExpectation;
} = {}) {
  validateHermesHost(host);
  const timeoutMs = options.timeoutMs ?? 120000, pollMs = options.pollMs ?? 250;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900000 || !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 10000) throw new TypeError('Invalid Hermes deadline');
  const identity = hermesProfileIdentity(host);
  return async (turn: ScopedModelTurn, context: Readonly<{ workId?: string }>) => {
    if (!context.workId) throw failure('SCOPED_HOST_CONTEXT_REQUIRED');
    const workId = context.workId;
    return runs.exclusive(workId, async () => {
      turn.signal.throwIfAborted();
      let record = await runs.load(workId);
      if (record && (!hermesJournalMatches(record, host) || record.admission || record.pending.length)) throw failure('SCOPED_MODEL_CHANGED');
      if (record?.completed) return;
      const recovered = record !== null;
      if (!record) record = { version: 1, workId, model: identity, providerCalls: 0, completed: false, pending: [], input: [{
        kind: 'hermes-scoped-v1', requestId: randomUUID(), inputId: randomUUID(),
        text: turn.instruction + '\n' + JSON.stringify({ context: turn.context, snapshot: turn.snapshot })
      }] };
      const state = record.input[0] as TurnState;
      if (record.input.length !== 1 || state.kind !== 'hermes-scoped-v1' || typeof state.text !== 'string'
        || Buffer.byteLength(state.text) > 262144 || !/^[a-f0-9-]{36}$/.test(state.requestId) || !/^[a-f0-9-]{36}$/.test(state.inputId)
        || state.sessionId !== undefined && (typeof state.sessionId !== 'string' || !state.sessionId || state.sessionId.length > 256)
        || state.admissionId !== undefined && (typeof state.admissionId !== 'string' || !state.admissionId || state.admissionId.length > 256)) throw failure();
      if (recovered && !state.sessionId) throw failure('HERMES_CREATION_UNCERTAIN');
      const startedAt = performance.now();
      const lifetime = new AbortController();
      const deadline = AbortSignal.timeout(timeoutMs);
      const signal = AbortSignal.any([turn.signal, lifetime.signal, deadline]);
      let relay: Awaited<ReturnType<typeof startScopedMcpRelay>> | null = null;
      const emit = (kind: ScopedRuntimeEvent['kind'], fields: Partial<ScopedRuntimeEvent> = {}) =>
        observeRuntime(options.onRuntimeEvent, { runtime: 'hermes', kind, workId, monotonicMs: performance.now(),
          elapsedMs: Math.round(performance.now() - startedAt), timeoutMs, pendingMcpCalls: relay?.pendingCalls ?? 0, ...fields });
      const details = (error: unknown) => ({
        ...(error instanceof EnvoiError && /^[A-Z_]{1,64}$/.test(error.code ?? '') ? { code: error.code } : {}),
        ...(error instanceof EnvoiError && /^[a-z_]{1,64}$/.test(error.reason ?? '') ? { reason: error.reason } : {})
      });
      const aborted = () => emit('turn_aborted', deadline.aborted && signal.reason === deadline.reason
        ? { source: 'deadline', code: 'TIMEOUT' } : { source: 'turn_signal', ...details(signal.reason) });
      signal.addEventListener('abort', aborted, { once: true });
      let wire: HermesHostWire | undefined;
      let originalInstanceId: string | undefined;
      let subscriptionId: string | undefined;
      let reconnects = 0;
      emit('turn_started');
      try {
        signal.throwIfAborted();
        relay = recovered ? null : await startScopedMcpRelay({ ...turn, signal });
        wire = await connectHermesHost(host, signal);
        originalInstanceId = wire.instanceId;
        if (options.nativeRequestGate) await checkHermesRequestGate(host, options.nativeRequestGate, signal, originalInstanceId);
        if (!recovered) {
          await runs.save(record);
          signal.throwIfAborted();
          const created = await wire.rpc('session.create', { request_id: state.requestId, source: 'acp', cwd: host.cwd,
            toolsets: ['no_mcp'], max_turns: 16, accept_hooks: false, follow_profile_config: false,
            editor: { mcp_servers: [relay!.mcpServer], edit_approval_policy: 'ask' } }, signal);
          if (typeof created.session_id !== 'string' || !created.session_id || created.session_id.length > 256
            || typeof created.subscription_id !== 'string' || !relay!.active || !relay!.discovered) throw failure('HERMES_TOOLS_NOT_READY');
          state.sessionId = created.session_id; subscriptionId = created.subscription_id;
          await runs.save(record);
        } else {
          const attached = await wire.rpc('session.resume', { session_id: state.sessionId, omit_messages: true }, signal);
          if (attached.session_id !== state.sessionId || typeof attached.subscription_id !== 'string') throw failure();
          subscriptionId = attached.subscription_id;
        }
        const sessionId = state.sessionId!;
        if (!state.admissionId) {
          if (options.nativeRequestGate) await checkHermesRequestGate(host, options.nativeRequestGate, signal, originalInstanceId);
          await guardNativeSubmission(options.beforeNativeSubmit, Object.freeze({ workId, sessionId,
            deadlineUnixMs: Math.floor(Date.now() + Math.max(0, timeoutMs - (performance.now() - startedAt))) }), signal);
          signal.throwIfAborted();
          record.providerCalls = 1;
          await runs.save(record);
          signal.throwIfAborted();
          const admitted = receipt(await wire.rpc('prompt.submit', { session_id: sessionId, input_id: state.inputId, text: state.text }, signal), sessionId, undefined, wire.profileId);
          state.admissionId = admitted.admission_id;
          await runs.save(record);
        }
        while (true) {
          signal.throwIfAborted();
          let current: Record<string, any>;
          try {
            current = await wire.rpc('prompt.receipt', { session_id: sessionId, admission_id: state.admissionId }, signal);
          } catch (error) {
            signal.throwIfAborted();
            if (!(error instanceof HermesStatusTransportError) || recovered || !relay?.active || !state.admissionId) throw error;
            emit('status_transport_lost', { source: 'transport', ...details(error) });
            if (reconnects >= 2) throw error;
            emit('status_reconnect_started', { reconnectAttempt: ++reconnects });
            wire.close();
            try {
              await delay(100, undefined, { signal });
              wire = await connectHermesHost(host, signal, originalInstanceId);
              const attached = await wire.rpc('session.resume', { session_id: sessionId, omit_messages: true }, signal);
              if (attached.session_id !== sessionId || typeof attached.subscription_id !== 'string') throw failure();
              subscriptionId = attached.subscription_id;
              signal.throwIfAborted();
              emit('status_reconnected', { reconnectAttempt: reconnects });
            } catch (reconnectError) {
              emit('status_reconnect_refused', details(reconnectError));
              throw reconnectError;
            }
            continue;
          }
          current = receipt(current, sessionId, state.admissionId, wire.profileId);
          if (current.status === 'terminal') {
            emit('turn_terminal', { outcome: ['completed', 'failed', 'interrupted', 'cancelled', 'rejected'].includes(current.outcome) ? current.outcome : 'unknown' });
            if (['failed', 'interrupted', 'cancelled', 'rejected'].includes(current.outcome))
              throw new PermanentWorkError('HERMES_TURN_NOT_COMPLETED');
            if (current.outcome !== 'completed') throw failure('HERMES_EXECUTION_UNCERTAIN');
            record.completed = true; await runs.save(record); return;
          }
          if (current.status === 'unknown' || recovered) throw failure('HERMES_EXECUTION_UNCERTAIN');
          await delay(pollMs, undefined, { signal });
        }
      } catch (error) {
        emit('turn_failed', deadline.aborted && signal.reason === deadline.reason
          ? { source: 'deadline', code: 'TIMEOUT' } : { source: 'runtime', ...details(error) });
        if (deadline.aborted && signal.reason === deadline.reason)
          throw new EnvoiError('Hermes scoped turn timed out; preserve its journal for recovery', undefined, 'TIMEOUT');
        throw error;
      } finally {
        signal.removeEventListener('abort', aborted);
        lifetime.abort();
        await relay?.close();
        if (!record.completed && state.sessionId) {
          emit('native_cancel_started');
          const stop = async (target: HermesHostWire) => {
            if (!state.admissionId) {
              const snapshot = await target.rpc('session.resume', { session_id: state.sessionId, omit_messages: true }, AbortSignal.timeout(1000));
              const admitted = Array.isArray(snapshot.pending) ? snapshot.pending.find((entry: unknown) => object(entry) && entry.input_id === state.inputId) : undefined;
              if (admitted && typeof admitted.admission_id === 'string') state.admissionId = admitted.admission_id;
            }
            if (state.admissionId) await cancelAdmission(target, state.sessionId!, state.admissionId);
          };
          try { if (!wire) throw failure(); await stop(wire); emit('native_cancel_finished'); }
          catch {
            let cancellation: HermesHostWire | undefined;
            try {
              cancellation = await connectHermesHost(host, AbortSignal.timeout(5000), originalInstanceId);
              await cancellation.rpc('session.resume', { session_id: state.sessionId, omit_messages: true }, AbortSignal.timeout(1000));
              await stop(cancellation);
              emit('native_cancel_finished');
            }
            catch (error) { emit('native_cancel_finished', details(error)); } finally { cancellation?.close(); }
          }
        }
        if (wire) {
          if (subscriptionId && state.sessionId) await wire.rpc('session.detach', { session_id: state.sessionId, subscription_id: subscriptionId }, AbortSignal.timeout(1000)).catch(() => {});
          wire.close();
        }
      }
    });
  };
}
