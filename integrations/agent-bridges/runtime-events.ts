/** Trusted-host diagnostics only: never provider text, transport credentials or native IDs. */
export interface ScopedRuntimeEvent {
  runtime: 'hermes';
  kind: 'turn_started' | 'turn_aborted' | 'turn_failed' | 'turn_terminal' | 'bridge_stop_requested'
    | 'status_transport_lost' | 'status_reconnect_started' | 'status_reconnected' | 'status_reconnect_refused'
    | 'native_cancel_started' | 'native_cancel_finished';
  workId?: string;
  monotonicMs: number;
  elapsedMs?: number;
  timeoutMs?: number;
  pendingMcpCalls?: number;
  reconnectAttempt?: number;
  source?: 'deadline' | 'turn_signal' | 'transport' | 'runtime';
  code?: string;
  reason?: string;
  outcome?: string;
}
export type ScopedRuntimeObserver = (event: Readonly<ScopedRuntimeEvent>) => void | Promise<void>;
export function observeRuntime(observer: ScopedRuntimeObserver | undefined, event: ScopedRuntimeEvent) {
  // Diagnostics cannot grant authority or replace the initiating execution failure.
  try { void Promise.resolve(observer?.(Object.freeze(event))).catch(() => {}); } catch {}
}
