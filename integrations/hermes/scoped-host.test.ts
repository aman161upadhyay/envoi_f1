import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { hermesSocketWire, selectedHermesProfile, summarizeHermesIdentity, validateHermesHost } from './scoped-host';

class InertSocket extends EventTarget {
  readyState = 1;
  bufferedAmount = 0;
  sent: Record<string, any>[] = [];
  close = vi.fn(() => { this.readyState = 3; });
  send(text: string) { this.sent.push(JSON.parse(text)); }
  receive(frame: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) })); }
}

afterEach(() => vi.useRealTimers());

describe('Hermes production daemon wire', () => {
  it('separates a transient daemon restart from a changed pinned origin', () => {
    const host = { home: path.resolve('profile'), cwd: path.resolve('workspace'), origin: 'http://127.0.0.1:65499' };
    const identity = { runtime_protocol: 1, state: 'ready', api_origin: host.origin,
      capabilities: ['session-authority-v1'], instance_id: 'instance',
      served_profiles: [{ home: host.home, profile_id: 'profile' }] };
    expect(selectedHermesProfile(identity, host)).toBe('profile');
    expect(() => selectedHermesProfile({ ...identity, state: 'starting' }, host)).toThrowError(expect.objectContaining({ code: 'HERMES_DAEMON_UNREACHABLE' }));
    expect(() => selectedHermesProfile({ ...identity, state: 'draining' }, host)).toThrowError(expect.objectContaining({ code: 'HERMES_DAEMON_UNREACHABLE' }));
    expect(() => selectedHermesProfile({ ...identity, api_origin: 'http://127.0.0.1:65500' }, host)).toThrowError(expect.objectContaining({ code: 'HERMES_ORIGIN_CHANGED' }));
    expect(() => selectedHermesProfile({ ...identity, served_profiles: [] }, host)).toThrowError(expect.objectContaining({ code: 'HERMES_SCOPED_UNAVAILABLE' }));
    expect(summarizeHermesIdentity({ ...identity, supervisor: 'none', ticket: 'private-ticket' }, host)).toEqual({
      connection: 'ready', supervisor: 'none', originMatches: true });
    expect(summarizeHermesIdentity({ ...identity, api_origin: 'http://127.0.0.1:65500', supervisor: 'systemd' }, host)).toEqual({
      connection: 'origin_changed', supervisor: 'systemd', originMatches: false });
    expect(summarizeHermesIdentity({ ...identity, served_profiles: [], supervisor: 'systemd' }, host)).toEqual({
      connection: 'unverified', supervisor: 'unknown', originMatches: null });
    expect(summarizeHermesIdentity({ ...identity, state: 'draining', supervisor: 'systemd' }, host)).toEqual({
      connection: 'not_ready', supervisor: 'unknown', originMatches: null });
  });
  it.each(['https://remote.example:443', 'http://localhost:1234', 'http://127.0.0.1:1234/path', 'http://user:secret@127.0.0.1:1234'])('refuses a nonlocal or ambiguous daemon origin: %s', origin => {
    expect(() => validateHermesHost({ home: path.resolve('profile'), cwd: path.resolve('workspace'), origin })).toThrow();
  });
  it('serializes canonical JSON-RPC without invented transport fields', async () => {
    const socket = new InertSocket(); const wire = hermesSocketWire(socket as unknown as WebSocket);
    const result = wire.rpc('prompt.receipt', { session_id: 'session', admission_id: 'admission' }, new AbortController().signal);
    expect(socket.sent[0]).toEqual({ jsonrpc: '2.0', id: 1, method: 'prompt.receipt', params: { session_id: 'session', admission_id: 'admission' } });
    socket.receive({ jsonrpc: '2.0', id: 1, result: { status: 'unknown' } });
    await expect(result).resolves.toEqual({ status: 'unknown' }); wire.close();
    expect(socket.close).toHaveBeenCalledTimes(1);
  });
  it('redacts daemon errors while preserving the exact cancellation race verdict', async () => {
    const socket = new InertSocket(); const wire = hermesSocketWire(socket as unknown as WebSocket);
    const result = wire.rpc('prompt.cancel', {}, new AbortController().signal);
    socket.receive({ jsonrpc: '2.0', id: 1, error: { message: 'stale_generation', data: { secret: 'private' } } });
    await expect(result).rejects.toMatchObject({ code: 'HERMES_STALE_GENERATION' });
    const refused = wire.rpc('prompt.submit', {}, new AbortController().signal);
    socket.receive({ jsonrpc: '2.0', id: 2, error: { message: 'private provider key and model diagnostics' } });
    await expect(refused).rejects.toMatchObject({ code: 'HERMES_SCOPED_REFUSED' }); wire.close();
  });
  it('closes on malformed responses and permanently rejects late replies', async () => {
    const socket = new InertSocket(); const wire = hermesSocketWire(socket as unknown as WebSocket);
    const result = wire.rpc('runtime.describe', {}, new AbortController().signal);
    socket.receive({ jsonrpc: '2.0', id: 1, result: {}, error: {} });
    await expect(result).rejects.toThrow();
    socket.receive({ jsonrpc: '2.0', id: 1, result: { accepted: true } });
    await expect(wire.rpc('session.create', {}, new AbortController().signal)).rejects.toThrow();
    expect(socket.close).toHaveBeenCalledTimes(1);
  });
  it('bounds outstanding requests and clears timeout resources on abort', async () => {
    vi.useFakeTimers();
    const socket = new InertSocket(); const wire = hermesSocketWire(socket as unknown as WebSocket);
    const controller = new AbortController();
    const result = expect(wire.rpc('prompt.submit', {}, controller.signal)).rejects.toThrow();
    controller.abort(new Error('fixture stop')); await result;
    expect(vi.getTimerCount()).toBe(0); expect(socket.close).toHaveBeenCalledTimes(1);
  });
  it('bounds silent daemon requests', async () => {
    vi.useFakeTimers();
    const socket = new InertSocket(); const wire = hermesSocketWire(socket as unknown as WebSocket);
    const result = expect(wire.rpc('prompt.submit', {}, new AbortController().signal)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(30000); await result;
    expect(vi.getTimerCount()).toBe(0); expect(socket.readyState).toBe(3);
  });
});
