import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api';
import { invalidateSessionRequests } from '../src/session-lifecycle';
import { cachedWorkspaceView, validateWorkspaceReturn, withReadDeadline } from '../src/session-validation';
import type { Human, HumanView, Inbox } from '../src/types';

const actor = { id: 'human', auth: { provider: 'local', assurance: 'mfa' } };
const snapshot = (requester: unknown = actor) => ({ inbox: { id: 'workspace' }, requester }) as HumanView;
function fixture() {
  const controller = new AbortController();
  const readers = {
    snapshot: vi.fn().mockResolvedValue(snapshot()),
    identity: vi.fn().mockResolvedValue({ ...actor, displayName: 'Owner' } as Human),
    directory: vi.fn().mockResolvedValue([{ id: 'workspace' }] as Inbox[]),
    legacyView: vi.fn().mockResolvedValue(snapshot())
  };
  return { controller, readers, run: () => validateWorkspaceReturn('human', 'workspace', 'local', controller.signal, readers) };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('same-session workspace view cache', () => {
  it('reuses only a verified view for the same human and inbox', () => {
    const valid = snapshot();
    const views = { workspace: valid };
    expect(cachedWorkspaceView(views, 'workspace', 'human')).toBe(valid);
    expect(cachedWorkspaceView(views, 'workspace', 'another-human')).toBeNull();
    expect(cachedWorkspaceView(views, 'another-workspace', 'human')).toBeNull();
    expect(cachedWorkspaceView({ workspace: { ...valid, inbox: { id: 'other' } } }, 'workspace', 'human')).toBeNull();
    expect(cachedWorkspaceView({ workspace: snapshot({ id: 'human', auth: { provider: 'local', assurance: 'phone' } }) }, 'workspace', 'human')).toBeNull();
  });
});

describe('authorized return snapshot', () => {
  it('validates a same-account return using only one request', async () => {
    const { run, readers } = fixture();
    await expect(run()).resolves.toMatchObject({ kind: 'ready', requester: actor, directoryLoaded: false });
    expect(readers.identity).not.toHaveBeenCalled();
    expect(readers.directory).not.toHaveBeenCalled();
    expect(readers.legacyView).not.toHaveBeenCalled();
  });

  it('falls back to identity, directory, and a fresh view on an older server', async () => {
    const { run, readers } = fixture();
    readers.snapshot.mockResolvedValue({ inbox: { id: 'workspace' } });
    await expect(run()).resolves.toMatchObject({ kind: 'ready', directoryLoaded: true, human: { displayName: 'Owner' } });
    expect(readers.identity).toHaveBeenCalledTimes(1);
    expect(readers.directory).toHaveBeenCalledTimes(1);
    expect(readers.legacyView).toHaveBeenCalledTimes(1);
  });

  it.each([null, {}, { id: 'human' }, { ...actor, auth: { provider: 'local', assurance: 'provider' } }])('keeps malformed requester metadata fail-closed: %j', async requester => {
    const { run, readers } = fixture(); readers.snapshot.mockResolvedValue(snapshot(requester));
    await expect(run()).rejects.toThrow('could not be verified');
    expect(readers.identity).not.toHaveBeenCalled();
  });

  it('rejects a snapshot for another workspace', async () => {
    const { run, readers } = fixture(); readers.snapshot.mockResolvedValue({ ...snapshot(), inbox: { id: 'other' } });
    await expect(run()).rejects.toThrow('another workspace');
  });

  it.each([401, 403])('routes a phone-only session to account/MFA flow after snapshot denial %s', async status => {
    const { run, readers } = fixture();
    readers.snapshot.mockRejectedValue(new ApiError('Denied', status));
    readers.identity.mockResolvedValue({ id: 'human', auth: { provider: 'local', assurance: 'phone' }, mfaSetupRequired: false });
    await expect(run()).resolves.toMatchObject({ kind: 'account', human: { mfaSetupRequired: false } });
    expect(readers.directory).not.toHaveBeenCalled(); expect(readers.legacyView).not.toHaveBeenCalled();
  });

  it('never merges another account snapshot into the existing account', async () => {
    const { run, readers } = fixture(); readers.snapshot.mockResolvedValue(snapshot({ ...actor, id: 'other' }));
    await expect(run()).resolves.toEqual({ kind: 'account' });
    expect(readers.directory).not.toHaveBeenCalled();
  });

  it('checks the requester again if the account switches during legacy fallback', async () => {
    const { run, readers } = fixture(); readers.snapshot.mockResolvedValue({ inbox: { id: 'workspace' } });
    readers.legacyView.mockResolvedValue(snapshot({ ...actor, id: 'other' }));
    await expect(run()).resolves.toEqual({ kind: 'account' });
  });

  it('does not override genuine workspace loss with a cached view', async () => {
    const { run, readers } = fixture(); readers.snapshot.mockRejectedValue(new ApiError('Denied', 403)); readers.directory.mockResolvedValue([]);
    await expect(run()).resolves.toEqual({ kind: 'denied' });
    expect(readers.legacyView).not.toHaveBeenCalled();
  });

  it('handles membership loss between directory and fallback view', async () => {
    const { run, readers } = fixture(); readers.snapshot.mockRejectedValue(new ApiError('Denied', 401));
    readers.legacyView.mockRejectedValue(new ApiError('Membership required', 403));
    await expect(run()).resolves.toEqual({ kind: 'denied' });
  });

  it('preserves a terminal identity denial and does not loop', async () => {
    const { run, readers } = fixture(); readers.snapshot.mockRejectedValue(new ApiError('Denied', 401)); readers.identity.mockRejectedValue(new ApiError('Expired', 401));
    await expect(run()).rejects.toMatchObject({ status: 401 });
    expect(readers.directory).not.toHaveBeenCalled();
  });

  it('keeps provider outages recoverable without treating them as a compatibility fallback', async () => {
    const { run, readers } = fixture(); readers.snapshot.mockRejectedValue(new ApiError('Unavailable', 503));
    await expect(run()).rejects.toMatchObject({ status: 503 });
    expect(readers.identity).not.toHaveBeenCalled();
  });

  it('stops fallback after cancellation even if a read ignores its signal', async () => {
    const { run, readers, controller } = fixture();
    let complete!: (value: HumanView) => void;
    readers.snapshot.mockImplementation(() => new Promise<HumanView>(resolve => { complete = resolve; }));
    const rejected = expect(run()).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); complete({ inbox: { id: 'workspace' } } as HumanView);
    await rejected; expect(readers.identity).not.toHaveBeenCalled();
  });

  it('does not broadcast expiry for the initial snapshot, but does for a terminal /me denial', async () => {
    const window = new EventTarget(); const expired = vi.fn();
    window.addEventListener('envoi:session-expired', expired);
    vi.stubGlobal('window', window);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Denied' }), { status: 401 })));
    const controller = new AbortController();
    await expect(api.sessionView('workspace', controller.signal)).rejects.toMatchObject({ status: 401 });
    expect(expired).not.toHaveBeenCalled();
    await expect(api.me(controller.signal)).rejects.toMatchObject({ status: 401 });
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it('rejects a snapshot completing after logout even with caller-managed denial', async () => {
    let complete!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise<Response>(resolve => { complete = resolve; })));
    const rejected = expect(api.sessionView('workspace', new AbortController().signal)).rejects.toMatchObject({ name: 'AbortError' });
    invalidateSessionRequests(); complete(new Response(JSON.stringify(snapshot()), { status: 200 }));
    await rejected;
  });
});

describe('read-only validation deadline', () => {
  it('aborts at the deadline and rejects a later successful response', async () => {
    vi.useFakeTimers();
    const { readers, controller, run } = fixture();
    let complete!: (value: HumanView) => void;
    readers.snapshot.mockImplementation(() => new Promise<HumanView>(resolve => { complete = resolve; }));
    const published = vi.fn();
    const pending = withReadDeadline(controller, run, 100).then(published);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(100); await rejected;
    expect(controller.signal.aborted).toBe(true);
    complete(snapshot()); await Promise.resolve(); await Promise.resolve();
    expect(published).not.toHaveBeenCalled();
  });

  it('cancels promptly when logout aborts even if the read never settles', async () => {
    const controller = new AbortController();
    const rejected = expect(withReadDeadline(controller, () => new Promise(() => {}))).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await rejected;
  });

  it('clears the timer after a successful validation', async () => {
    vi.useFakeTimers(); const controller = new AbortController();
    await expect(withReadDeadline(controller, async () => 1, 100)).resolves.toBe(1);
    await vi.advanceTimersByTimeAsync(100); expect(controller.signal.aborted).toBe(false);
  });
});
