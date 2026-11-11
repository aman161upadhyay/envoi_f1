import { McpWakeClient, type EventInput, type EventSubscription } from './mcp-wake-client';
import type { McpEventHint } from './mcp-events-receiver';
import { HostRequestError } from './private-host-http';

export interface McpEventsHostStore {
  read(): Promise<{ subscription: EventSubscription | null; cursor: string | null }>;
  save(value: { subscription: EventSubscription | null; cursor: string | null }): Promise<void>;
  pending(): Promise<McpEventHint[]>;
  processed(eventId: string): Promise<void>;
}
export interface McpEventsWorkDriver {
  /** Fetch authoritative installation/lifecycle state and reconcile a4 delta; hints grant no authority. */
  catchUp(cursor: string | null, truncated: boolean): Promise<void>;
  processWorkOnce(): Promise<void>;
}

/** Invoke tick on host startup and a trusted scheduler (at most 900 seconds apart), never a model timer. */
export class McpEventsHost {
  #nextPoll = 0;
  #retryAt = 0;
  #renewRetryAt = 0;
  #ready = false;
  #flight: Promise<void> | null = null;
  #stopped = false;
  #pollMs: number;
  #now: () => number;
  constructor(private readonly client: McpWakeClient, private readonly store: McpEventsHostStore,
    private readonly driver: McpEventsWorkDriver, private readonly privateInput: () => Promise<EventInput>, options: { pollMs?: number; now?: () => number } = {}) {
    this.#pollMs = options.pollMs ?? 60000;
    if (!Number.isSafeInteger(this.#pollMs) || this.#pollMs < 1000 || this.#pollMs > 900000) throw new TypeError('Safety poll must be between 1 and 900 seconds');
    this.#now = options.now ?? Date.now;
  }
  tick(): Promise<void> {
    if (this.#flight) return this.#flight;
    if (this.#now() < this.#retryAt) return Promise.resolve();
    const operation = this.#tick().catch(error => {
      if (error instanceof HostRequestError && (error.retryAfterSeconds !== undefined || error.status === 429 || error.status === 503)) {
        this.#retryAt = this.#now() + (error.retryAfterSeconds !== undefined ? error.retryAfterSeconds * 1000 : this.#pollMs);
      }
      throw error;
    }).then(renewalError => {
      if (renewalError) throw renewalError;
    }); this.#flight = operation;
    void operation.finally(() => { this.#flight = null; }).catch(() => {});
    return operation;
  }
  async #tick() {
    if (this.#stopped || this.client.lifecycle !== 'RUNNING') return;
    if (!this.#ready) {
      if (!await this.client.discoverEvents()) throw new HostRequestError('EVENTS_UNAVAILABLE');
      this.#ready = true;
    }
    let state = await this.store.read();
    let claimed = false;
    let renewalError: HostRequestError | undefined;
    // Renewal is early enough for a tick at the maximum allowed safety interval.
    if (!state.subscription || (this.#now() >= this.#renewRetryAt
      && Date.parse(state.subscription.refreshBefore) - this.#now() <= this.#pollMs)) {
      const input = await this.privateInput();
      if (this.#stopped || this.client.lifecycle !== 'RUNNING') return;
      const subscription = await this.client.subscribe({ ...input, cursor: state.cursor }).catch(error => {
        if (!state.subscription || !(error instanceof HostRequestError)
          || !(error.status === 429 || (error.status ?? 0) >= 500 || ['NETWORK_ERROR', 'TIMEOUT'].includes(error.code))) throw error;
        this.#renewRetryAt = this.#now() + (error.retryAfterSeconds === undefined ? this.#pollMs : error.retryAfterSeconds * 1000);
        renewalError = error;
        return null;
      });
      if (this.#stopped || this.client.lifecycle !== 'RUNNING') return;
      if (subscription) {
        state = { subscription, cursor: subscription.cursor };
        await this.store.save(state); // persist the cursor before any uncertain work effect
        claimed = await this.#process(subscription.cursor, subscription.truncated);
      }
    }
    for (const hint of await this.store.pending()) {
      if (this.#stopped || this.client.lifecycle !== 'RUNNING') return;
      if (!await this.#process(hint.cursor, false)) return;
      // Mark only after authoritative processing; a restart replays safely under work fences.
      await this.store.processed(hint.eventId);
      // Out-of-order deliveries must not move a durable cursor backwards.
      if (hint.cursor && (!state.cursor || hint.cursor > state.cursor)) {
        state = { ...state, cursor: hint.cursor }; await this.store.save(state);
      }
      claimed = true;
    }
    if (!claimed && this.#now() >= this.#nextPoll) {
      claimed = await this.#process(state.cursor, false);
    }
    if (claimed) this.#nextPoll = this.#now() + this.#pollMs;
    return renewalError;
  }
  async #process(cursor: string | null, truncated: boolean): Promise<boolean> {
    if (this.#stopped || this.client.lifecycle !== 'RUNNING') return false;
    await this.driver.catchUp(cursor, truncated);
    if (this.#stopped || this.client.lifecycle !== 'RUNNING') return false;
    await this.driver.processWorkOnce();
    return true;
  }
  /** Stop scheduling immediately on owner unsubscribe/revoke; private receiver custody is destroyed separately. */
  stop() { this.#stopped = true; }
}
