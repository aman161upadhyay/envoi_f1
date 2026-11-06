import { ApiError } from './api';
import type { Human, HumanView, Inbox, WorkspaceRequester } from './types';

// The captured legacy check took 8–10 seconds. Bound return validation at 15s;
// tune with staging measurements without adding deadlines to mutations.
export const SESSION_VALIDATION_TIMEOUT_MS = 15_000;
// A background check after a short absence blocks nothing, so it can wait longer
// than the blocking one. Aborting a request mid-flight can also lose a refreshed
// session cookie, which is worth avoiding when nobody is waiting.
export const QUIET_VALIDATION_TIMEOUT_MS = 45_000;

export async function withReadDeadline<T>(controller: AbortController, read: (signal: AbortSignal) => Promise<T>, timeoutMs = SESSION_VALIDATION_TIMEOUT_MS): Promise<T> {
  const { signal } = controller;
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const timer = setTimeout(() => controller.abort(new DOMException('Session checking took too long. Retry loading or sign out.', 'TimeoutError')), timeoutMs);
  try { return await Promise.race([read(signal), aborted]); }
  finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); }
}

function requester(value: unknown): WorkspaceRequester {
  const candidate = value as Partial<WorkspaceRequester> | null;
  if (!candidate || typeof candidate.id !== 'string' || !candidate.id
      || !candidate.auth || !['local', 'workos'].includes(candidate.auth.provider)
      || !(candidate.auth.provider === 'local' ? ['mfa', 'phone'] : ['provider']).includes(candidate.auth.assurance)) {
    throw new Error('The session response could not be verified. Retry loading.');
  }
  return candidate as WorkspaceRequester;
}

export function workspaceRequester(view: HumanView, workspaceId: string): WorkspaceRequester | undefined {
  if (view.inbox?.id !== workspaceId) throw new Error('The session response belongs to another workspace.');
  return Object.hasOwn(view, 'requester') ? requester(view.requester) : undefined;
}

export function cachedWorkspaceView(views: Record<string, HumanView>, workspaceId: string, accountId: string): HumanView | null {
  const view = views[workspaceId];
  if (!view) return null;
  try {
    const actor = workspaceRequester(view, workspaceId);
    return actor?.id === accountId && actor.auth.assurance !== 'phone' ? view : null;
  } catch { return null; }
}

type Readers = {
  snapshot: (signal: AbortSignal) => Promise<HumanView>;
  identity: (signal: AbortSignal) => Promise<Human>;
  directory: (signal: AbortSignal) => Promise<Inbox[]>;
  legacyView: (signal: AbortSignal) => Promise<HumanView>;
};
type ValidationResult = { kind: 'ready'; view: HumanView; human?: Human; requester?: WorkspaceRequester; directoryLoaded: boolean }
  | { kind: 'account'; human?: Human }
  | { kind: 'denied' };

export async function validateWorkspaceReturn(accountId: string, workspaceId: string, provider: string, signal: AbortSignal, readers: Readers): Promise<ValidationResult> {
  const read = async <T>(operation: (signal: AbortSignal) => Promise<T>) => {
    signal.throwIfAborted();
    const result = await operation(signal);
    signal.throwIfAborted();
    return result;
  };
  let snapshot: HumanView | undefined;
  try { snapshot = await read(readers.snapshot); }
  catch (error) {
    signal.throwIfAborted();
    if (!(error instanceof ApiError && [401, 403].includes(error.status))) throw error;
  }
  if (snapshot && Object.hasOwn(snapshot, 'requester')) {
    const actor = workspaceRequester(snapshot, workspaceId)!;
    if (actor.id !== accountId || actor.auth.provider !== provider || actor.auth.assurance === 'phone') return { kind: 'account' };
    return { kind: 'ready', view: snapshot, requester: actor, directoryLoaded: false };
  }

  // Old servers and denied snapshots must identify phone-only sessions through
  // /me before deciding between MFA step-up and actual loss of workspace access.
  const human = await read(readers.identity);
  if (human.id !== accountId || human.auth?.assurance === 'phone') return { kind: 'account', human };
  const directory = await read(readers.directory);
  if (!directory.some(item => item.id === workspaceId)) return { kind: 'denied' };
  let view: HumanView;
  try { view = await read(readers.legacyView); }
  catch (error) {
    signal.throwIfAborted();
    if (error instanceof ApiError && error.status === 403) return { kind: 'denied' };
    throw error;
  }
  const actor = workspaceRequester(view, workspaceId);
  if (actor) {
    if (actor.id !== human.id || actor.auth.provider !== provider || actor.auth.assurance === 'phone') return { kind: 'account' };
  }
  return { kind: 'ready', view, human, directoryLoaded: true };
}
