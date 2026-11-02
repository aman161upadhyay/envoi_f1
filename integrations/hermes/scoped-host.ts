import { connect } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { lstat, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { ConnectorSetupError } from '../connector/adapter';
import { EnvoiError } from '../../sdk/typescript/src/index';
import { PermanentWorkError } from '../../sdk/typescript/src/connector';
import type { ScopedModelTurn } from '../agent-bridges/scoped-turn';
import type { ScopedRunStore } from '../grok/scoped-store';
import { startScopedMcpRelay } from './scoped-relay';

const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = (code = 'HERMES_SCOPED_UNAVAILABLE') => new EnvoiError('Hermes scoped execution unavailable; preserve the turn journal for recovery', undefined, code);
const daemonUnavailable = () => failure('HERMES_DAEMON_UNREACHABLE');
const protocol = 'hermes-gateway-v1';
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

export function hermesSocketWire(socket: WebSocket): HermesWire {
  let sequence = 0, active = true, total = 0;
  const pending = new Map<number, { resolve(value: Record<string, any>): void; reject(error: unknown): void; cleanup(): void }>();
  const close = () => {
    if (!active) return;
    active = false;
    for (const operation of pending.values()) { operation.cleanup(); operation.reject(failure()); }
    pending.clear();
    socket.removeEventListener('message', receive); socket.removeEventListener('error', close); socket.removeEventListener('close', close);
    socket.close();
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
      } else if (object(frame.result)) operation.resolve(frame.result);
      else { operation.reject(failure()); close(); }
    } catch { close(); }
  };
  socket.addEventListener('message', receive); socket.addEventListener('error', close); socket.addEventListener('close', close);
  return { close, rpc(method, params, signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      if (!active || pending.size >= 4 || socket.readyState !== 1) return reject(failure());
      const id = ++sequence;
      const abort = () => { close(); reject(signal.reason); };
      const timer = setTimeout(close, 30000);
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
      pending.set(id, { resolve, reject, cleanup }); signal.addEventListener('abort', abort, { once: true });
      const text = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      if (Buffer.byteLength(text) > 524288 || socket.bufferedAmount > 524288) return close();
      try { socket.send(text); } catch { close(); }
      if (signal.aborted) abort();
    });
  } };
}

export async function connectHermesHost(host: HermesScopedHost, signal: AbortSignal): Promise<HermesWire> {
  validateHermesHost(host);
  const identity = await control(host.home, 'identify', {}, signal);
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
      return wire;
    } catch (error) { wire.close(); throw error; }
  } catch (error) { socket.close(); throw error; }
}

type TurnState = { kind: 'hermes-scoped-v1'; requestId: string; inputId: string; text: string; sessionId?: string; admissionId?: string };

function receipt(value: Record<string, any>, sessionId: string, admissionId?: string) {
  if (typeof value.admission_id !== 'string' || !value.admission_id || value.admission_id.length > 256
    || admissionId !== undefined && value.admission_id !== admissionId || !object(value.ref) || value.ref.session_id !== sessionId
    || !['queued', 'started', 'unknown', 'terminal'].includes(value.status)
    || value.status === 'started' && (!Number.isSafeInteger(value.execution_generation) || value.execution_generation < 1)) throw failure();
  return value;
}

async function cancelAdmission(wire: HermesWire, sessionId: string, admissionId: string) {
  const signal = AbortSignal.timeout(5000);
  try { await wire.rpc('prompt.cancel', { session_id: sessionId, admission_id: admissionId }, signal); }
  catch (error) { if (!(error instanceof EnvoiError) || error.code !== 'HERMES_STALE_GENERATION') throw error; }
  let current = receipt(await wire.rpc('prompt.receipt', { session_id: sessionId, admission_id: admissionId }, signal), sessionId, admissionId);
  if (current.status === 'started') {
    try { await wire.rpc('session.interrupt', { session_id: sessionId, execution_generation: current.execution_generation }, signal); }
    catch (error) { if (!(error instanceof EnvoiError) || error.code !== 'HERMES_STALE_GENERATION') throw error; }
  }
  while (current.status !== 'terminal' && current.status !== 'unknown') {
    await delay(50, undefined, { signal });
    current = receipt(await wire.rpc('prompt.receipt', { session_id: sessionId, admission_id: admissionId }, signal), sessionId, admissionId);
  }
}

export function hermesScopedTurn(host: HermesScopedHost, runs: ScopedRunStore, options: {
  timeoutMs?: number;
  pollMs?: number;
} = {}) {
  validateHermesHost(host);
  const timeoutMs = options.timeoutMs ?? 120000, pollMs = options.pollMs ?? 250;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900000 || !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 10000) throw new TypeError('Invalid Hermes deadline');
  const identity = `hermes-daemon:${host.origin}:${host.home}:${host.cwd}`;
  return async (turn: ScopedModelTurn, context: Readonly<{ workId?: string }>) => {
    if (!context.workId) throw failure('SCOPED_HOST_CONTEXT_REQUIRED');
    const workId = context.workId;
    return runs.exclusive(workId, async () => {
      turn.signal.throwIfAborted();
      let record = await runs.load(workId);
      if (record && (record.model !== identity || record.admission || record.pending.length)) throw failure('SCOPED_MODEL_CHANGED');
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
      const lifetime = new AbortController();
      const signal = AbortSignal.any([turn.signal, lifetime.signal, AbortSignal.timeout(timeoutMs)]);
      const relay = recovered ? null : await startScopedMcpRelay({ ...turn, signal });
      let wire: HermesWire | undefined;
      let subscriptionId: string | undefined;
      try {
        wire = await connectHermesHost(host, signal);
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
          record.providerCalls = 1;
          await runs.save(record);
          signal.throwIfAborted();
          const admitted = receipt(await wire.rpc('prompt.submit', { session_id: sessionId, input_id: state.inputId, text: state.text }, signal), sessionId);
          state.admissionId = admitted.admission_id;
          await runs.save(record);
        }
        while (true) {
          signal.throwIfAborted();
          const current = receipt(await wire.rpc('prompt.receipt', { session_id: sessionId, admission_id: state.admissionId }, signal), sessionId, state.admissionId);
          if (current.status === 'terminal') {
            if (['failed', 'interrupted', 'cancelled', 'rejected'].includes(current.outcome))
              throw new PermanentWorkError('HERMES_TURN_NOT_COMPLETED');
            if (current.outcome !== 'completed') throw failure('HERMES_EXECUTION_UNCERTAIN');
            record.completed = true; await runs.save(record); return;
          }
          if (current.status === 'unknown' || recovered) throw failure('HERMES_EXECUTION_UNCERTAIN');
          await delay(pollMs, undefined, { signal });
        }
      } finally {
        lifetime.abort();
        await relay?.close();
        if (!record.completed && state.sessionId) {
          const stop = async (target: HermesWire) => {
            if (!state.admissionId) {
              const snapshot = await target.rpc('session.resume', { session_id: state.sessionId, omit_messages: true }, AbortSignal.timeout(1000));
              const admitted = Array.isArray(snapshot.pending) ? snapshot.pending.find((entry: unknown) => object(entry) && entry.input_id === state.inputId) : undefined;
              if (admitted && typeof admitted.admission_id === 'string') state.admissionId = admitted.admission_id;
            }
            if (state.admissionId) await cancelAdmission(target, state.sessionId!, state.admissionId);
          };
          try { if (!wire) throw failure(); await stop(wire); }
          catch {
            let cancellation: HermesWire | undefined;
            try {
              cancellation = await connectHermesHost(host, AbortSignal.timeout(5000));
              await cancellation.rpc('session.resume', { session_id: state.sessionId, omit_messages: true }, AbortSignal.timeout(1000));
              await stop(cancellation);
            }
            catch {} finally { cancellation?.close(); }
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
