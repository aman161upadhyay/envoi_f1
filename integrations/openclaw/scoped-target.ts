import { EnvoiError } from '../../sdk/typescript/src/index';
import { createHash } from 'node:crypto';

/** Trusted host data only. Never saved in enrollment state or exposed to a model. */
export interface OpenClawWorkTarget {
  readonly binding: Readonly<{
    window: string; workId: string; caseId: string; caseSessionId: string;
    recipientAgentId: string; installationId: string; fence: number;
  }>;
  readonly gatewayUrl: string;
  readonly gatewayToken: string;
  readonly agentId: string;
  readonly processIdentity: string;
  readonly configurationSha256: string;
  /** Hashes of canonical native paths, not credentials or raw private paths. */
  readonly stateDirectorySha256: string;
  readonly configurationPathSha256: string;
  readonly workspaceSha256: string;
  readonly agentStateSha256: string;
  readonly proxyOrigin: string;
  readonly proxyIdentity: string;
  readonly deadlineUnixMs: number;
  readonly toolChannelSha256: string;
  readonly ownerSelectionSha256: string;
}

/** A local resolver is plumbing, NOT proof that every native provider path is metered. */
export type OpenClawTargetResolver = (workId: string, signal: AbortSignal) => Promise<Readonly<OpenClawWorkTarget>>;

/** Supplied only by a trusted host after reading/verifying an actual personal selection. */
export interface OpenClawTargetSelectionAuthority {
  readonly clientSource: string; readonly nativeSourceSha256: string; readonly window: string;
  readPersonalSelection(workId: string, signal: AbortSignal): Promise<Readonly<{
    receiptSha256: string; clientSource: string; nativeSourceSha256: string; window: string;
    role: 'openclaw'; workId: string; caseSessionId: string; toolChannelSha256: string; targetSha256: string;
  }> | null>;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
/** Stable non-secret digest for the host's independently reviewed receipt. */
export function openClawTargetDigest(t: Readonly<OpenClawWorkTarget>) {
  return hash(JSON.stringify({binding:{window:t.binding.window,workId:t.binding.workId,caseId:t.binding.caseId,
    caseSessionId:t.binding.caseSessionId,recipientAgentId:t.binding.recipientAgentId,installationId:t.binding.installationId,fence:t.binding.fence},
    gatewayOrigin:origin(t.gatewayUrl),gatewayTokenSha256:hash(t.gatewayToken),agentId:t.agentId,processIdentity:t.processIdentity,
    configurationSha256:t.configurationSha256,stateDirectorySha256:t.stateDirectorySha256,configurationPathSha256:t.configurationPathSha256,
    workspaceSha256:t.workspaceSha256,agentStateSha256:t.agentStateSha256,proxyOrigin:origin(t.proxyOrigin),proxyIdentity:t.proxyIdentity,
    deadlineUnixMs:t.deadlineUnixMs,toolChannelSha256:t.toolChannelSha256}));
}

function refuse(code: string): never { throw new EnvoiError('Trusted OpenClaw target is unavailable', undefined, code); }
const safe = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(value);
function origin(value: string) {
  let parsed: URL;
  try { parsed = new URL(value); } catch { return refuse('OPENCLAW_TARGET_INVALID'); }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/'
    || !(parsed.protocol === 'https:' || parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname))) refuse('OPENCLAW_TARGET_INVALID');
  return parsed.origin;
}

/** In-RAM immutable ownership; closed/reused targets cannot silently become another work. */
export class OpenClawTargetRegistry {
  private targets = new Map<string, Readonly<OpenClawWorkTarget>>();
  private pending = new Map<string, Promise<Readonly<OpenClawWorkTarget>>>();
  private closed = new Set<string>();
  private stops = new Map<string, AbortController>();
  private readonly selection?: OpenClawTargetSelectionAuthority;
  constructor(private readonly resolver: OpenClawTargetResolver, selection?: OpenClawTargetSelectionAuthority) {
    // Authority pins and reader identity cannot change while a selection is pending.
    if(selection)this.selection=Object.freeze({clientSource:selection.clientSource,nativeSourceSha256:selection.nativeSourceSha256,
      window:selection.window,readPersonalSelection:selection.readPersonalSelection.bind(selection)});
  }

  async resolve(workId: string, inputSignal: AbortSignal) {
    inputSignal.throwIfAborted();
    if (!/^msg_[A-Za-z0-9_-]+$/.test(workId) || this.closed.has(workId)) refuse('OPENCLAW_TARGET_CLOSED');
    const existing = this.targets.get(workId);
    if (existing) { this.live(existing, inputSignal); return existing; }
    const pending = this.pending.get(workId); if (pending) return pending;
    const stop=new AbortController();this.stops.set(workId,stop);
    const signal=AbortSignal.any([inputSignal,stop.signal]);
    const resolve = async () => {
      let abort = () => {};
      try {
        const operation = async () => {
          const authority=this.selection;
          if(!authority||!/^[a-f0-9]{40}$/.test(authority.clientSource)||!/^[a-f0-9]{64}$/.test(authority.nativeSourceSha256)||!/^[a-f0-9]{64}$/.test(authority.window))refuse('PERSONAL_OPENCLAW_TARGET_REVIEW_REQUIRED');
          const received=await authority.readPersonalSelection(workId,signal);signal.throwIfAborted();
          if(!received)refuse('PERSONAL_OPENCLAW_TARGET_REVIEW_REQUIRED');
          // The trusted reader can reuse an object; capture it before another await.
          const receipt=Object.freeze({...received});
          const value=await this.resolver(workId,signal);signal.throwIfAborted();
          return{value,receipt,authority};
        };
        const {value,receipt,authority} = await Promise.race([Promise.resolve().then(operation), new Promise<never>((_, reject) => {
          abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
        })]);
        signal.throwIfAborted();
        const b = value?.binding;
        if (!b || b.workId !== workId || !/^[a-f0-9]{64}$/.test(b.window) || !/^case_[A-Za-z0-9_-]+$/.test(b.caseId)
          || !/^case_session_[A-Za-z0-9_-]+$/.test(b.caseSessionId) || !/^agent_[A-Za-z0-9_-]+$/.test(b.recipientAgentId)
          || !/^installation_[A-Za-z0-9_-]+$/.test(b.installationId) || !Number.isSafeInteger(b.fence) || b.fence < 1
          || !safe(value.agentId) || !safe(value.processIdentity) || !safe(value.proxyIdentity) || !/^[a-f0-9]{64}$/.test(value.configurationSha256)
          || ![value.stateDirectorySha256,value.configurationPathSha256,value.workspaceSha256,value.agentStateSha256].every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v))
          || typeof value.gatewayToken !== 'string' || !value.gatewayToken || value.gatewayToken.length > 16384 || /[\x00-\x20\x7f]/.test(value.gatewayToken)
          || !/^[a-f0-9]{64}$/.test(value.toolChannelSha256)||!/^[a-f0-9]{64}$/.test(value.ownerSelectionSha256)
          || !Number.isSafeInteger(value.deadlineUnixMs) || value.deadlineUnixMs <= Date.now() || value.deadlineUnixMs > Date.now() + 120000) refuse('OPENCLAW_TARGET_INVALID');
        const target = Object.freeze({ ...value, binding: Object.freeze({ ...b }), gatewayUrl: origin(value.gatewayUrl), proxyOrigin: origin(value.proxyOrigin) });
        if(receipt.receiptSha256!==target.ownerSelectionSha256||receipt.clientSource!==authority.clientSource||receipt.nativeSourceSha256!==authority.nativeSourceSha256
          ||receipt.window!==authority.window||receipt.window!==b.window||receipt.role!=='openclaw'||receipt.workId!==workId
          ||receipt.caseSessionId!==b.caseSessionId||receipt.toolChannelSha256!==target.toolChannelSha256||receipt.targetSha256!==openClawTargetDigest(target))refuse('PERSONAL_OPENCLAW_TARGET_REVIEW_MISMATCH');
        if (target.gatewayUrl === target.proxyOrigin || this.closed.has(workId)) refuse('OPENCLAW_TARGET_CLOSED');
        for (const prior of this.targets.values()) if (prior.binding.workId !== workId && (prior.gatewayUrl === target.gatewayUrl
          || prior.gatewayToken === target.gatewayToken || prior.processIdentity === target.processIdentity
          || prior.proxyOrigin === target.proxyOrigin || prior.proxyIdentity === target.proxyIdentity
          || prior.stateDirectorySha256===target.stateDirectorySha256||prior.configurationPathSha256===target.configurationPathSha256
          || prior.workspaceSha256===target.workspaceSha256||prior.agentStateSha256===target.agentStateSha256)) refuse('OPENCLAW_TARGET_REUSED');
        this.live(target, signal); this.targets.set(workId, target); return target;
      } finally { signal.removeEventListener('abort', abort); }
    };
    const task = resolve(); this.pending.set(workId, task);
    try { return await task; } finally { this.pending.delete(workId); }
  }

  get(workId: string) { return this.targets.get(workId); }
  close(workId: string) { this.closed.add(workId); this.stops.get(workId)?.abort(new EnvoiError('Trusted OpenClaw target ended', undefined, 'OPENCLAW_TARGET_CLOSED')); }
  closeAll() { for (const id of [...this.targets.keys(), ...this.pending.keys()]) this.close(id); }

  private live(target: Readonly<OpenClawWorkTarget>, signal?: AbortSignal | null) {
    signal?.throwIfAborted();
    if (this.closed.has(target.binding.workId)) refuse('OPENCLAW_TARGET_CLOSED');
    if (Date.now() >= target.deadlineUnixMs) refuse('NATIVE_DEADLINE_EXPIRED');
  }

  async dispatch(workId: string, input: Parameters<typeof fetch>[0], init: RequestInit, upstream: typeof fetch) {
    const target = this.targets.get(workId); if (!target) refuse('EXACT_OPENCLAW_TARGET_REQUIRED');
    this.live(target, init.signal);
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== target.gatewayUrl || url.username || url.password || url.pathname !== '/v1/responses' || url.search || url.hash
      || init.method !== 'POST' || new Headers(init.headers).get('authorization') !== `Bearer ${target.gatewayToken}`) refuse('FOREIGN_OPENCLAW_TARGET_REFUSED');
    let body: { model?: unknown }; try { body = JSON.parse(String(init.body)); } catch { return refuse('FOREIGN_OPENCLAW_TARGET_REFUSED'); }
    if (body?.model !== `openclaw/${target.agentId}`) refuse('FOREIGN_OPENCLAW_TARGET_REFUSED');
    const signal = AbortSignal.any([this.stops.get(workId)!.signal, ...(init.signal ? [init.signal] : []), AbortSignal.timeout(Math.max(1, target.deadlineUnixMs - Date.now()))]);
    this.live(target, signal); return upstream(input, { ...init, redirect: 'error', signal });
  }
}
