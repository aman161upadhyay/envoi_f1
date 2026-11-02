import { EnvoiError } from '../../sdk/typescript/src/index';
import type { EnvoiConnector } from '../../sdk/typescript/src/connector';
import type { WakeNotification, WakeStore } from './http-wake-receiver';

export interface WakeSubscription {
  id: string;
  installationId: string;
  agentId: string;
  url: string;
  status: 'pending' | 'active' | 'ended';
  endedReason: string | null;
  expiresAt: string | null;
  replacesSubscriptionId: string | null;
}

export interface WakeAvailability {
  available: boolean;
  version: 1;
  subscription: { id: string; status: 'pending' | 'active' | 'ended'; endedReason: string | null; expiresAt: string | null } | null;
}

export interface WakeIdentity { agentId: string; installationId: string; inboxId: string }
export interface WakeHostTransport {
  readonly identity: WakeIdentity;
  status(signal?: AbortSignal): Promise<{ paused: boolean; wake: WakeAvailability | null }>;
  create(url: string, signal?: AbortSignal): Promise<WakeSubscription>;
  activate(id: string, challenge: string, signal?: AbortSignal): Promise<WakeSubscription>;
  end?(id: string, signal?: AbortSignal): Promise<WakeSubscription>;
  list(signal?: AbortSignal): Promise<WakeSubscription[]>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const subscriptionPattern = /^wake_sub_[A-Za-z0-9_-]{3,64}$/;
const endings = new Set(['superseded', 'replaced', 'challenge_expired', 'ended_by_host', 'revoked_by_owner', 'credential_ended', 'receiver_gone', 'delivery_failed', 'expired', 'feature_disabled']);
const retryEndings = new Set(['challenge_expired', 'delivery_failed', 'expired', 'feature_disabled']);

function canonicalUrl(value: string): string {
  const destination = new URL(value);
  if (destination.protocol !== 'https:' || destination.username || destination.password || destination.search || destination.hash || destination.port || value.length > 8192) throw new TypeError('A fixed HTTPS wake URL without credentials, query or fragment is required');
  return destination.href;
}

function summary(value: unknown): WakeAvailability['subscription'] {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.id !== 'string' || !subscriptionPattern.test(value.id) || typeof value.status !== 'string' || !['pending', 'active', 'ended'].includes(value.status)
    || !(value.expiresAt === null || typeof value.expiresAt === 'string' && Number.isFinite(Date.parse(value.expiresAt)))
    || !(value.endedReason === null || typeof value.endedReason === 'string' && endings.has(value.endedReason))
    || (value.status === 'ended') !== (value.endedReason !== null) || value.status === 'active' && value.expiresAt === null) throw new EnvoiError('Invalid wake subscription response');
  return value as unknown as NonNullable<WakeAvailability['subscription']>;
}

export class EnvoiWakeHostTransport implements WakeHostTransport {
  constructor(origin: string, readonly identity: WakeIdentity, private readonly connector: Pick<EnvoiConnector, 'wakeOrigin' | 'wakeRequest'>) {
    const configured = new URL(origin);
    if (configured.protocol !== 'https:' || configured.username || configured.password || configured.href !== `${configured.origin}/`) throw new TypeError('A fixed HTTPS Envoi origin is required');
    if (configured.origin !== connector.wakeOrigin) throw new TypeError('Wake receiver and connector origins must match');
    if (!/^agent_[A-Za-z0-9_-]{3,128}$/.test(identity.agentId) || !/^installation_[A-Za-z0-9_-]{3,128}$/.test(identity.installationId) || !/^inbox_[A-Za-z0-9_-]{3,128}$/.test(identity.inboxId)) throw new TypeError('A trusted installation identity is required');
    this.identity = Object.freeze({ ...identity });
  }

  private async request(route: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    try {
      return await this.connector.wakeRequest(route, body as Record<string, unknown> | undefined, signal);
    } catch (error) {
      if (error instanceof EnvoiError) throw new EnvoiError('Wake host request was refused', error.status, error.code, { reason: error.reason, retryAfterSeconds: error.retryAfterSeconds, requestId: error.requestId });
      throw new EnvoiError('Wake host request failed');
    }
  }

  private subscription(value: unknown): WakeSubscription {
    if (!isRecord(value) || !isRecord(value.subscription)) throw new EnvoiError('Invalid wake subscription response');
    const entry = value.subscription;
    summary(entry);
    if (entry.installationId !== this.identity.installationId || entry.agentId !== this.identity.agentId || typeof entry.url !== 'string'
      || canonicalUrl(entry.url) !== entry.url || !(entry.replacesSubscriptionId === null || typeof entry.replacesSubscriptionId === 'string' && subscriptionPattern.test(entry.replacesSubscriptionId))) throw new EnvoiError('Wake subscription identity changed');
    return entry as unknown as WakeSubscription;
  }

  async status(signal?: AbortSignal) {
    const value = await this.request('/api/agent/status', undefined, signal);
    if (!isRecord(value) || typeof value.state !== 'string' || !['active', 'paused'].includes(value.state) || value.inboxId !== this.identity.inboxId || !isRecord(value.agent) || value.agent.id !== this.identity.agentId
      || !isRecord(value.installation) || value.installation.id !== this.identity.installationId) throw new EnvoiError('Wake host identity changed');
    if (value.httpWake === undefined) return { paused: value.state === 'paused', wake: null };
    const availability = value.httpWake;
    if (!isRecord(availability) || typeof availability.available !== 'boolean' || availability.version !== 1 || !isRecord(value.installation) || value.installation.id !== this.identity.installationId) throw new EnvoiError('Invalid wake availability response');
    return { paused: value.state === 'paused', wake: { available: availability.available, version: 1 as const, subscription: summary(availability.subscription) } };
  }

  async create(url: string, signal?: AbortSignal) { return this.subscription(await this.request('/api/agent/wake-subscriptions', { url: canonicalUrl(url) }, signal)); }
  async activate(id: string, challenge: string, signal?: AbortSignal) {
    if (!subscriptionPattern.test(id) || !/^envoi_wake_challenge_[A-Za-z0-9_-]{43}$/.test(challenge)) throw new TypeError('Invalid wake activation');
    return this.subscription(await this.request(`/api/agent/wake-subscriptions/${encodeURIComponent(id)}/activate`, { challenge }, signal));
  }
  async list(signal?: AbortSignal) {
    const value = await this.request('/api/agent/wake-subscriptions', undefined, signal);
    if (!isRecord(value) || value.installationId !== this.identity.installationId || !Array.isArray(value.subscriptions)) throw new EnvoiError('Invalid wake subscription list');
    const subscriptions = value.subscriptions.map(subscription => this.subscription({ subscription }));
    if (new Set(subscriptions.map(entry => entry.id)).size !== subscriptions.length || subscriptions.filter(entry => entry.status === 'active').length > 1 || subscriptions.filter(entry => entry.status === 'pending').length > 1) throw new EnvoiError('Inconsistent wake subscription list');
    return subscriptions;
  }
  async end(id: string, signal?: AbortSignal) {
    if (!subscriptionPattern.test(id)) throw new TypeError('Invalid wake subscription');
    return this.subscription(await this.request(`/api/agent/wake-subscriptions/${encodeURIComponent(id)}/end`, {}, signal));
  }
}

export interface WakeWorkDriver {
  processWorkOnce(signal?: AbortSignal): Promise<boolean>;
  revalidateLiveLeases(signal?: AbortSignal): Promise<void>;
  nextAvailableInMs?(): number | undefined;
}

export class HttpWakeHost {
  private flight: Promise<void> | null = null;
  private followup = false;
  private paused = false;
  private createFlight: Promise<void> | null = null;
  private claimFlight: Promise<void> | null = null;
  private controlFlight: Promise<void> | null = null;
  private generation = 0;
  private wakeAvailable = true;
  private subscriptionRetryAt = 0;
  private readonly url: string;

  constructor(private readonly transport: WakeHostTransport, private readonly store: WakeStore, private readonly driver: WakeWorkDriver,
    url: string, private readonly now: () => number = Date.now) { this.url = canonicalUrl(url); }

  private async disableWake(): Promise<void> {
    this.wakeAvailable = false;
    await this.store.update(state => {
      const identifiers = new Set(Object.entries(state.subscriptions).filter(([, entry]) => entry.installationId === this.transport.identity.installationId).map(([identifier]) => identifier));
      for (const identifier of identifiers) delete state.subscriptions[identifier];
      for (const entry of Object.values(state.accepted)) if (identifiers.has(entry.notification.subscriptionId)) entry.pending = false;
    });
  }

  private async remember(entry: WakeSubscription): Promise<void> {
    if (entry.installationId !== this.transport.identity.installationId || entry.agentId !== this.transport.identity.agentId || entry.url !== this.url) throw new EnvoiError('Wake subscription identity changed');
    await this.store.update(state => {
      if (entry.status === 'ended') {
        delete state.subscriptions[entry.id];
        if (entry.endedReason && state.endedReasons[entry.installationId] !== 'revoked_by_owner') state.endedReasons[entry.installationId] = entry.endedReason;
      } else {
        if (['revoked_by_owner', 'ended_by_host', 'receiver_gone', 'credential_ended'].includes(state.endedReasons[entry.installationId])) throw new EnvoiError('Wake subscription was ended');
        state.subscriptions[entry.id] = { url: entry.url, status: entry.status, installationId: entry.installationId };
        if (entry.status === 'active' && entry.replacesSubscriptionId) delete state.subscriptions[entry.replacesSubscriptionId];
      }
    });
  }

  async maintain(signal?: AbortSignal): Promise<void> {
    if (this.createFlight) return this.createFlight;
    this.createFlight = (async () => {
      const generation = this.generation;
      signal?.throwIfAborted();
      const status = await this.transport.status(signal);
      if (generation !== this.generation) return;
      this.paused = status.paused;
      this.wakeAvailable = status.wake?.available === true;
      const current = status.wake?.subscription;
      if (current?.status === 'ended') {
        await this.store.update(state => {
          delete state.subscriptions[current.id];
          if (state.endedReasons[this.transport.identity.installationId] !== 'revoked_by_owner') state.endedReasons[this.transport.identity.installationId] = current.endedReason!;
        });
      }
      if (!this.wakeAvailable) {
        await this.disableWake();
        return;
      }
      const state = await this.store.read();
      if (generation !== this.generation || ['revoked_by_owner', 'ended_by_host', 'receiver_gone', 'credential_ended'].includes(state.endedReasons[this.transport.identity.installationId])) return;
      const entries = await this.transport.list(signal);
      if (generation !== this.generation) return;
      for (const entry of entries) {
        if (entry.installationId !== this.transport.identity.installationId || entry.agentId !== this.transport.identity.agentId) throw new EnvoiError('Wake subscription identity changed');
        if (entry.endedReason === 'revoked_by_owner') await this.store.update(current => {
          current.endedReasons[entry.installationId] = 'revoked_by_owner';
          for (const [identifier, known] of Object.entries(current.subscriptions)) if (known.installationId === entry.installationId) delete current.subscriptions[identifier];
        });
      }
      if ((await this.store.read()).endedReasons[this.transport.identity.installationId] === 'revoked_by_owner') return;
      for (const entry of entries) {
        if (entry.url === this.url && (entry.status !== 'ended' || entry.id === current?.id)) await this.remember(entry);
      }
      const pending = entries.some(entry => entry.url === this.url && entry.status === 'pending');
      const active = entries.find(entry => entry.status === 'active');
      const reason = (await this.store.read()).endedReasons[this.transport.identity.installationId];
      if (generation !== this.generation || pending || reason && !retryEndings.has(reason)) return;
      if (active && (active.url !== this.url || active.expiresAt && Date.parse(active.expiresAt) > this.now() + 7 * 86_400_000)) return;
      if (this.now() < this.subscriptionRetryAt) return;
      signal?.throwIfAborted();
      const created = await this.transport.create(this.url, signal);
      if (generation !== this.generation) return;
      if (created.status !== 'pending') throw new EnvoiError('Invalid new wake subscription');
      await this.remember(created);
    })().catch(async error => {
      if (error instanceof EnvoiError && error.code === 'FEATURE_DISABLED') { await this.disableWake(); return; }
      if (error instanceof EnvoiError && error.code === 'RATE_LIMITED' && error.reason === 'wake_subscription_create_limit' && Number.isSafeInteger(error.retryAfterSeconds) && error.retryAfterSeconds! >= 0) {
        this.subscriptionRetryAt = this.now() + error.retryAfterSeconds! * 1000;
        return;
      }
      throw error;
    }).finally(() => { this.createFlight = null; });
    return this.createFlight;
  }

  private async claim(signal?: AbortSignal): Promise<void> {
    if (this.claimFlight) return this.claimFlight;
    signal?.throwIfAborted();
    if (this.paused) return;
    this.claimFlight = (async () => {
      while (!signal?.aborted && await this.driver.processWorkOnce(signal)) signal?.throwIfAborted();
    })().finally(() => { this.claimFlight = null; });
    return this.claimFlight;
  }

  private async dispatchControls(signal?: AbortSignal): Promise<void> {
    if (this.controlFlight) return this.controlFlight;
    this.controlFlight = (async () => {
      const state = await this.store.read();
      for (const [identifier, entry] of Object.entries(state.accepted)) {
        if (!entry.pending || !entry.acknowledged || entry.notification.type !== 'wake.control_changed') continue;
        signal?.throwIfAborted();
        const current = await this.store.read();
        const known = current.subscriptions[entry.notification.subscriptionId];
        if (known?.installationId === this.transport.identity.installationId && known.url === this.url) await this.dispatch(entry.notification, signal);
        signal?.throwIfAborted();
        await this.store.update(latest => { if (latest.accepted[identifier]) latest.accepted[identifier].pending = false; });
      }
    })().finally(() => { this.controlFlight = null; });
    return this.controlFlight;
  }

  async dispatchPending(signal?: AbortSignal): Promise<void> {
    const controls = this.dispatchControls(signal);
    await Promise.all([controls, this.dispatchWork(signal)]);
  }

  private dispatchWork(signal?: AbortSignal): Promise<void> {
    if (this.flight) { this.followup = true; return this.flight; }
    this.flight = (async () => {
      do {
        this.followup = false;
        const state = await this.store.read();
        for (const [identifier, entry] of Object.entries(state.accepted)) {
          if (!entry.pending || !entry.acknowledged || entry.notification.type === 'wake.control_changed') continue;
          signal?.throwIfAborted();
          const current = await this.store.read();
          const known = current.subscriptions[entry.notification.subscriptionId];
          if (this.wakeAvailable && known?.installationId === this.transport.identity.installationId && known.url === this.url) await this.dispatch(entry.notification, signal);
          signal?.throwIfAborted();
          await this.store.update(current => { if (current.accepted[identifier]) current.accepted[identifier].pending = false; });
        }
      } while (this.followup && !signal?.aborted);
    })().finally(() => { this.flight = null; });
    return this.flight;
  }

  private async dispatch(notification: WakeNotification, signal?: AbortSignal): Promise<void> {
    if (notification.type === 'wake.challenge') {
      if (!notification.challenge || !notification.expiresAt || Date.parse(notification.expiresAt) <= this.now()) return;
      let activated: WakeSubscription;
      try { activated = await this.transport.activate(notification.subscriptionId, notification.challenge, signal); }
      catch (error) {
        if (error instanceof EnvoiError && error.code === 'FEATURE_DISABLED') { await this.disableWake(); return; }
        if (error instanceof EnvoiError && error.code === 'WAKE_SUBSCRIPTION_ENDED' && error.reason && endings.has(error.reason)) {
          await this.store.update(state => {
            delete state.subscriptions[notification.subscriptionId];
            if (state.endedReasons[this.transport.identity.installationId] !== 'revoked_by_owner') state.endedReasons[this.transport.identity.installationId] = error.reason!;
          });
          return;
        }
        throw error;
      }
      if (activated.status !== 'active' || activated.id !== notification.subscriptionId) throw new EnvoiError('Invalid activated wake subscription');
      await this.remember(activated);
    } else if (notification.type === 'wake.control_changed') {
      await this.driver.revalidateLiveLeases(signal);
      const status = await this.transport.status(signal);
      this.paused = status.paused;
    } else if (notification.type === 'wake.work_available') {
      const status = await this.transport.status(signal);
      this.paused = status.paused;
      await this.claim(signal);
    }
  }

  async poll(signal?: AbortSignal): Promise<void> {
    await this.maintain(signal);
    await this.dispatchPending(signal);
    await this.claim(signal);
  }

  async endSubscription(id: string, signal?: AbortSignal): Promise<void> {
    const entry = (await this.store.read()).subscriptions[id];
    if (!entry || entry.installationId !== this.transport.identity.installationId || entry.url !== this.url || !this.transport.end) throw new EnvoiError('No locally owned wake subscription');
    this.generation++;
    await this.store.update(state => { delete state.subscriptions[id]; state.endedReasons[this.transport.identity.installationId] = 'ended_by_host'; });
    const ended = await this.transport.end(id, signal);
    if (ended.id !== id || ended.status !== 'ended') throw new EnvoiError('Invalid ended wake subscription');
    await this.remember(ended);
  }

  async acknowledge(id: string): Promise<void> {
    await this.store.update(state => {
      const entry = Object.hasOwn(state.accepted, id) ? state.accepted[id] : undefined;
      if (entry) entry.acknowledged = true;
    });
  }

  async run(signal: AbortSignal, intervalMs = 60_000): Promise<void> {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 900_000) throw new RangeError('Wake polling must run at least every 900 seconds');
    const wake = new AbortController();
    let fatal: unknown;
    let dispatchBackground: Promise<void> | undefined;
    let claimBackground: Promise<void> | undefined;
    let reschedule: (() => void) | undefined;
    let dispatchRetryAt = 0;
    let claimRetryAt = 0;
    let maintainRetryAt = 0;
    const transient = (error: unknown) => error instanceof EnvoiError && (error.status !== undefined && error.status >= 500 || ['NETWORK_ERROR', 'TIMEOUT', 'RATE_LIMITED'].includes(error.code ?? ''));
    while (!signal.aborted) {
      const started = this.now();
      let retryAfterMs = 0;
      try {
        if (this.now() >= maintainRetryAt) {
          try { await this.maintain(signal); }
          catch (error) {
            if (!transient(error)) throw error;
            maintainRetryAt = this.now() + (error instanceof EnvoiError && Number.isSafeInteger(error.retryAfterSeconds) && error.retryAfterSeconds! >= 0
              ? error.retryAfterSeconds! * 1000 : intervalMs);
          }
        }
        await this.dispatchControls(signal);
        if (!dispatchBackground && this.now() >= dispatchRetryAt) dispatchBackground = this.dispatchWork(signal)
          .catch(error => {
            if (!signal.aborted && !transient(error)) { fatal = error; wake.abort(); }
            else if (error instanceof EnvoiError && Number.isSafeInteger(error.retryAfterSeconds) && error.retryAfterSeconds! >= 0)
              dispatchRetryAt = this.now() + error.retryAfterSeconds! * 1000;
          })
          .finally(() => { dispatchBackground = undefined; reschedule?.(); });
        if (!claimBackground && this.now() >= claimRetryAt) claimBackground = this.claim(signal)
          .catch(error => {
            if (!signal.aborted && !transient(error)) { fatal = error; wake.abort(); }
            else if (error instanceof EnvoiError && Number.isSafeInteger(error.retryAfterSeconds) && error.retryAfterSeconds! >= 0)
              claimRetryAt = this.now() + error.retryAfterSeconds! * 1000;
          })
          .finally(() => { claimBackground = undefined; reschedule?.(); });
      }
      catch (error) {
        if (signal.aborted) return;
        if (!transient(error)) throw error;
        if (error instanceof EnvoiError && Number.isSafeInteger(error.retryAfterSeconds) && error.retryAfterSeconds! >= 0) retryAfterMs = error.retryAfterSeconds! * 1000;
      }
      if (fatal) throw fatal;
      if (signal.aborted) return;
      await new Promise<void>(resolve => {
        let timer: ReturnType<typeof setTimeout>;
        const retryAt = this.now() + retryAfterMs;
        const done = () => { clearTimeout(timer); reschedule = undefined; signal.removeEventListener('abort', done); wake.signal.removeEventListener('abort', done); resolve(); };
        const arm = () => {
          clearTimeout(timer);
          const hint = this.driver.nextAvailableInMs?.();
          const hintAt = hint !== undefined && Number.isSafeInteger(hint) && hint >= 0 ? this.now() + Math.max(1000, hint) : Infinity;
          const dispatchDue = !dispatchBackground && dispatchRetryAt > this.now() ? dispatchRetryAt : Infinity;
          const claimDue = !claimBackground && claimRetryAt > this.now() ? claimRetryAt : Infinity;
          const maintainDue = maintainRetryAt > this.now() ? maintainRetryAt : Infinity;
          const next = Math.max(retryAt, Math.min(started + intervalMs, hintAt, dispatchDue, claimDue, maintainDue));
          timer = setTimeout(done, Math.max(0, next - this.now()));
        };
        reschedule = arm;
        arm();
        signal.addEventListener('abort', done, { once: true });
        wake.signal.addEventListener('abort', done, { once: true });
        if (signal.aborted || wake.signal.aborted) done();
      });
      if (fatal) throw fatal;
    }
  }
}
