import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {defaultContinuationFlowPolicy,sameContinuationFlowPolicy,validateReviewedContinuationPlan,validateReviewedGraphApproval,type ReviewedContinuationPlan} from './continuation-plan';

export const REQUEST_CAPS = Object.freeze({ models: 48, messages: 60, cases: 9, installations: 5, assets: 6 });
export type PhysicalMeterEvent=Readonly<{phase:'reserved'|'dispatched'|'response'|'lost'|'aborted'|'not_forwarded';reservationId:string}>;
export type PhysicalMeterAuthorization=Readonly<{onMeterEvent(event:PhysicalMeterEvent):void|Promise<void>}>;
export type ModelBudgetAmendment = Readonly<{ purpose:'phase-c-decline-continuation'; models:number; approvalReceiptSha256:string }>;
type Role = 'je1' | 'je2' | 'testowner' | 'openclaw';
type Flow = Readonly<{ id: string; role: Role; requests: number; workHash: string | null }>;
type Prior = { actualCalls: number; actualHermesApiCalls: number; openClawProviderRequestsReserved: number;
  possibleHostMessageEffects: number; canonicalEffects: number; caseIds: string[]; newInstallationsUsed: number;
  priorUploadedAssets: number; stopped: boolean; failure: string; [key: string]: unknown };
type RecordLine = { previous: string; kind: string; [key: string]: unknown };
export type ReviewedGraphAmendmentProof=Readonly<{expectedWindow:string;allHostsStopped:boolean;canonicalLeasesZero:boolean;previousNativeTerminal:boolean;chargedAttempts:number;
  graphApprovalRaw:string;clientSource:string;serverSource:string;packetSha256:string}>;
const nativeHistoryKinds=new Set(['binding','phase','attempt','dispatched','finished']);
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function refuse(code: string): never { throw Object.assign(new Error(code), { code }); }
const exactHash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function approvedCaps(amendment: unknown) {
  if(amendment===undefined || amendment===null) return REQUEST_CAPS;
  if(typeof amendment!=='object' || Array.isArray(amendment)) refuse('MODEL_BUDGET_APPROVAL_REQUIRED');
  const a=amendment as Record<string,unknown>;
  if(Object.keys(a).sort().join()!=='approvalReceiptSha256,models,purpose' || a.purpose!=='phase-c-decline-continuation'
    || typeof a.models!=='number' || ![54,64].includes(a.models)
    || !exactHash(a.approvalReceiptSha256)) refuse('MODEL_BUDGET_APPROVAL_REQUIRED');
  return Object.freeze({...REQUEST_CAPS,models:a.models});
}
export function nativeWorkToken(token: string, window: string, role: Role, nativeSessionId: string) {
  if (!exactHash(token) || !exactHash(window) || !nativeSessionId || nativeSessionId.length > 256) refuse('NATIVE_WORK_BINDING_REQUIRED');
  return createHmac('sha256', Buffer.from(token, 'hex')).update(`${window}\0${role}\0${nativeSessionId}`).digest('hex');
}

/** Private append-only accounting. There is no provider/runtime/start operation here. */
export class RequestBudgetLedger {
  private tail = Promise.resolve();
  private denied = false;
  private constructor(readonly filename: string, private lines: RecordLine[], private digest: string,
    private syncFile: (handle: Awaited<ReturnType<typeof fs.open>>) => Promise<void>) {}

  static async prepare(filename: string, prior: Prior, flows: readonly Flow[], window: string, amendment?:ModelBudgetAmendment) {
    const caps=approvedCaps(amendment);
    if (!exactHash(window) || prior.actualCalls !== 30 || prior.actualHermesApiCalls !== 24
      || prior.openClawProviderRequestsReserved !== 6 || prior.possibleHostMessageEffects !== 22
      || prior.canonicalEffects !== 9 || prior.caseIds.length !== 4 || prior.newInstallationsUsed !== 5
      || prior.priorUploadedAssets !== 0 || !prior.stopped || prior.failure !== 'LIVE_ASSERTION_FAILED') refuse('CARRIED_HISTORY_REQUIRED');
    if (!flows.length || new Set(flows.map(f => f.id)).size !== flows.length || flows.some(f => !/^[a-z0-9-]{1,80}$/.test(f.id)
      || !['je1','je2','testowner','openclaw'].includes(f.role) || f.workHash !== null && !exactHash(f.workHash)
      || !Number.isSafeInteger(f.requests) || f.requests < 1) || flows.reduce((n, f) => n + f.requests, 0) > caps.models-30) refuse('FLOW_ALLOCATION_REFUSED');
    const seed = { previous: '0'.repeat(64), kind: 'seed', version: 1, prior: structuredClone(prior),
      priorSha256: hash(JSON.stringify(prior)), flows: structuredClone(flows), window, caps, executionAllowed: false,
      ...(amendment?{modelBudgetAmendment:structuredClone(amendment)}:{}) };
    const handle = await fs.open(filename, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(seed) + '\n'); await handle.sync(); } finally { await handle.close(); }
    const anchor = await fs.open(path.join(path.dirname(filename), 'phase-c-request-ledger.anchor'), 'wx', 0o600);
    try { await anchor.writeFile(JSON.stringify({ filename: path.resolve(filename), seedSha256: hash(JSON.stringify(seed) + '\n') })); await anchor.sync(); }
    finally { await anchor.close(); }
    return this.open(filename);
  }

  static async open(filename: string, options: { syncFile?: (handle: Awaited<ReturnType<typeof fs.open>>) => Promise<void> } = {}) {
    const raw = await fs.readFile(filename, 'utf8');
    if (!raw.endsWith('\n') || raw.length > 1_000_000) refuse('REQUEST_LEDGER_INCOMPLETE');
    let previous = '0'.repeat(64); const lines: RecordLine[] = [];
    for (const value of raw.trimEnd().split('\n')) {
      let line: RecordLine; try { line = JSON.parse(value); } catch { return refuse('REQUEST_LEDGER_CORRUPT'); }
      if (line.previous !== previous) refuse('REQUEST_LEDGER_CHAIN_MISMATCH');
      lines.push(line); previous = hash(value + '\n');
    }
    const seed = lines[0];
    if (seed?.kind !== 'seed' || seed.version !== 1 || !exactHash(seed.window) || JSON.stringify(seed.caps) !== JSON.stringify(approvedCaps(seed.modelBudgetAmendment))) refuse('REQUEST_LEDGER_SEED_INVALID');
    const p = seed.prior as Prior;
    if (p.actualCalls !== 30 || p.actualHermesApiCalls !== 24 || p.openClawProviderRequestsReserved !== 6
      || p.possibleHostMessageEffects !== 22 || p.canonicalEffects !== 9 || p.newInstallationsUsed !== 5
      || p.caseIds.length !== 4 || p.priorUploadedAssets !== 0 || !p.stopped || p.failure !== 'LIVE_ASSERTION_FAILED'
      || hash(JSON.stringify(p)) !== seed.priorSha256) refuse('CARRIED_HISTORY_REQUIRED');
    const anchor = JSON.parse(await fs.readFile(path.join(path.dirname(filename), 'phase-c-request-ledger.anchor'), 'utf8'));
    if (anchor.filename !== path.resolve(filename) || anchor.seedSha256 !== hash(JSON.stringify(seed) + '\n')) refuse('CANONICAL_REQUEST_LEDGER_REQUIRED');
    const ledger = new RequestBudgetLedger(filename, lines, previous, options.syncFile ?? (h => h.sync()));
    ledger.validate(); return ledger;
  }

  get window() { return (this.lines.filter(l => l.kind === 'window').at(-1)?.window ?? this.lines[0].window) as string; }
  get reviewedPlan() { return structuredClone(this.lines.filter(l=>l.kind==='plan').at(-1)?.plan) as ReviewedContinuationPlan|undefined; }
  get reviewedGraphApprovalRaw(){return (this.lines.filter(l=>l.kind==='plan').at(-1)?.proof as ReviewedGraphAmendmentProof|undefined)?.graphApprovalRaw;}
  get flows() { const plan=this.reviewedPlan;return plan?plan.flows.map(({policy:_policy,...flow})=>flow):structuredClone(this.lines[0].flows) as Flow[]; }
  get prior() { return structuredClone(this.lines[0].prior) as Prior; }
  get modelCap() { return approvedCaps(this.lines[0].modelBudgetAmendment).models; }
  snapshot() {
    const requests = this.lines.filter(l => l.kind === 'attempt');
    const finished = new Set(this.lines.filter(l => l.kind === 'finished').map(l => l.attempt));
    return { chargedAttempts: 30 + requests.length, modelCap:this.modelCap, remainingModelAttempts:this.modelCap-30-requests.length,
      carriedMessageReservations: 22, carriedCanonicalEffects: 9,
      carriedCases: 4, carriedNewInstallations: 5, carriedAssets: 0, priorOpenClawCalls: 6, priorHermesCalls: 24,
      pending: requests.filter(l => !finished.has(l.attempt)).length,
      lastPhase: this.lines.filter(l => l.kind === 'phase').at(-1)?.phase as string | undefined,
      lastActive: this.lines.filter(l => l.kind === 'phase').at(-1)?.active as string[] | undefined,
      activeDeadline: this.lines.filter(l => l.kind === 'phase').at(-1)?.deadline as number | undefined,
      carriedActualCalls: 30, conservativeChargedAttempts: 30 + requests.length,
      knownDispatchedRequests: this.lines.filter(l => l.kind === 'dispatched').length,
      unresolvedDispatches: requests.filter(l => !this.lines.some(f => f.kind === 'dispatched' && f.attempt === l.attempt)
        && !this.lines.some(f => f.kind === 'finished' && f.attempt === l.attempt && f.outcome === 'not_forwarded')).length,
      carriedActionBaselinesOnly: true,
      requests: requests.map(l => ({ attempt: l.attempt as string, flow: l.flow as string, role: l.role as Role })) };
  }
  private validate() {
    const s = this.snapshot();
    const flows = this.flows;
    if (!flows.length || new Set(flows.map(f => f.id)).size !== flows.length || flows.some(f => !/^[a-z0-9-]{1,80}$/.test(f.id)
      || !['je1','je2','testowner','openclaw'].includes(f.role) || !Number.isSafeInteger(f.requests) || f.requests < 1
      || f.workHash !== null && !exactHash(f.workHash))) refuse('REQUEST_LEDGER_FLOW_INVALID');
    if (this.lines.some(l => !['seed','binding','phase','attempt','dispatched','finished','window','plan'].includes(l.kind))) refuse('REQUEST_LEDGER_RECORD_INVALID');
    this.validatePlans();
    if (s.chargedAttempts > this.modelCap || this.flows.reduce((n, f) => n + f.requests, 0) > this.modelCap-30) refuse('REQUEST_LEDGER_CAP_INVALID');
    for (const flow of this.flows) if (s.requests.filter(r => r.flow === flow.id).length > flow.requests) refuse('REQUEST_LEDGER_FLOW_INVALID');
  }
  private validatePlans(){
    let previousFlows=structuredClone(this.lines[0].flows) as Flow[];
    let policies=new Map(previousFlows.map(f=>[f.id,defaultContinuationFlowPolicy(f.id)]));
    let previousPlan:ReviewedContinuationPlan|undefined;
    let window=this.lines[0].window;
    const approvals=new Set<string>();
    for(let index=1;index<this.lines.length;index++){
      const row=this.lines[index];if(row.kind==='window')window=row.window;
      if(row.kind!=='plan')continue;
      const plan=validateReviewedContinuationPlan(row.plan);
      const proof=row.proof as ReviewedGraphAmendmentProof;
      const prefix=this.lines.slice(0,index),attempts=prefix.filter(r=>r.kind==='attempt');
      if(!previousPlan&&prefix.some(r=>nativeHistoryKinds.has(r.kind)))refuse('FIRST_REVIEWED_GRAPH_REQUIRES_UNUSED_NATIVE_HISTORY');
      const approval=validateReviewedGraphApproval(proof?.graphApprovalRaw,{planSha256:plan.planSha256,window:String(window),clientSource:proof?.clientSource,serverSource:proof?.serverSource,packetSha256:proof?.packetSha256});
      if(approval.approvalHash!==plan.ownerApprovalHash||row.approvalHash!==approval.approvalHash)refuse('GRAPH_SOURCE_APPROVAL_HASH_MISMATCH');
      if(row.window!==window||proof?.expectedWindow!==window||proof.allHostsStopped!==true||proof.canonicalLeasesZero!==true||proof.previousNativeTerminal!==true
        ||proof.chargedAttempts!==30+attempts.length||approvals.has(plan.ownerApprovalHash)
        ||attempts.some(a=>!prefix.some(f=>f.kind==='finished'&&f.attempt===a.attempt))
        ||attempts.some(a=>!prefix.some(f=>f.kind==='dispatched'&&f.attempt===a.attempt)&&!prefix.some(f=>f.kind==='finished'&&f.attempt===a.attempt&&f.outcome==='not_forwarded'))
        ||plan.flows.reduce((n,f)=>n+f.requests,0)>this.modelCap-30)refuse('REVIEWED_GRAPH_RECONCILIATION_REQUIRED');
      for(const old of previousFlows){
        const next=plan.flows.find(f=>f.id===old.id),charged=attempts.filter(a=>a.flow===old.id).length;
        if(!next||next.role!==old.role||next.workHash!==old.workHash||next.requests>old.requests||next.requests<charged
          ||!sameContinuationFlowPolicy(next.policy,policies.get(old.id)!)||previousPlan&&plan.flowCases[old.id]!==previousPlan.flowCases[old.id])refuse('REVIEWED_GRAPH_HISTORY_CHANGED');
      }
      if(previousPlan&&Object.keys(previousPlan.actorIds).some(role=>previousPlan!.actorIds[role as Role]!==plan.actorIds[role as Role]))refuse('REVIEWED_GRAPH_HISTORY_CHANGED');
      approvals.add(plan.ownerApprovalHash);previousFlows=plan.flows.map(({policy:_policy,...flow})=>flow);policies=new Map(plan.flows.map(f=>[f.id,f.policy]));previousPlan=plan;
    }
  }
  /** Called only by the trusted before-submit guard, after authenticated canonical receipt checks. */
  async bindWork(flowId: string, proof: { canonicalWorkHash: string; nativeToken: string; evidenceHash: string }) {
    return this.serialized(async () => {
      const flow = this.flows.find(f => f.id === flowId);
      if (!flow || !exactHash(proof.canonicalWorkHash) || !exactHash(proof.nativeToken) || !exactHash(proof.evidenceHash)
        || flow.workHash !== null && flow.workHash !== proof.canonicalWorkHash) refuse('CANONICAL_WORK_BINDING_REQUIRED');
      if (this.lines.some(l => l.kind === 'binding' && l.flow !== flowId && (l.nativeToken === proof.nativeToken || l.canonicalWorkHash === proof.canonicalWorkHash))) refuse('CANONICAL_WORK_BINDING_CHANGED');
      const prior = this.lines.find(l => l.kind === 'binding' && l.flow === flowId);
      if (prior && prior.canonicalWorkHash !== proof.canonicalWorkHash) refuse('CANONICAL_WORK_BINDING_CHANGED');
      const existing = this.lines.find(l => l.kind === 'binding' && l.flow === flowId && l.window === this.window);
      if (existing) {
        if (existing.flow === flowId && existing.canonicalWorkHash === proof.canonicalWorkHash && existing.nativeToken === proof.nativeToken) return;
        refuse('CANONICAL_WORK_BINDING_CHANGED');
      }
      await this.append('binding', { flow: flowId, role: flow.role, window: this.window, ...proof });
    });
  }
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation); this.tail = result.then(() => undefined, () => undefined); return result;
  }
  private async append(kind: string, fields: Record<string, unknown>) {
    if (this.denied) refuse('REQUEST_LEDGER_STOPPED');
    let lock: Awaited<ReturnType<typeof fs.open>>;
    try { lock = await fs.open(this.filename + '.lock', 'wx', 0o600); }
    catch { return refuse('REQUEST_LEDGER_LOCKED'); }
    try {
      const disk = await fs.readFile(this.filename, 'utf8');
      if (disk !== this.lines.map(l => JSON.stringify(l) + '\n').join('')) refuse('REQUEST_LEDGER_CHANGED');
      const line = { previous: this.digest, kind, ...fields };
      const text = JSON.stringify(line) + '\n'; const handle = await fs.open(this.filename, 'a');
      try { await handle.writeFile(text); await this.syncFile(handle); }
      finally { await handle.close(); }
      this.lines.push(line); this.digest = hash(text); this.validate();
    } catch { this.denied = true; return refuse('REQUEST_LEDGER_WRITE_UNCERTAIN'); }
    finally { await lock.close(); await fs.unlink(this.filename + '.lock'); }
  }
  async bindApprovedWindow(window: string, proof: { approvalReceiptHash: string; allHostsStopped: boolean;
    canonicalLeasesZero: boolean; previousNativeTerminal: boolean; chargedAttempts: number }) {
    return this.serialized(async () => {
      const s = this.snapshot();
      if (!exactHash(window) || window === this.window || !exactHash(proof.approvalReceiptHash) || !proof.allHostsStopped
        || !proof.canonicalLeasesZero || !proof.previousNativeTerminal || s.pending || proof.chargedAttempts !== s.chargedAttempts) refuse('APPROVED_WINDOW_RECONCILIATION_REQUIRED');
      await this.append('window', { window, proof: structuredClone(proof) });
    });
  }
  /** Explicit reviewed graph metadata only: no implicit adoption, new seed, budget increase or deadline reset. */
  async amendReviewedPlan(value:ReviewedContinuationPlan,proof:ReviewedGraphAmendmentProof){
    return this.serialized(async()=>{
      const plan=validateReviewedContinuationPlan(value),current=this.reviewedPlan,s=this.snapshot();
      if(!current&&this.lines.some(r=>nativeHistoryKinds.has(r.kind)))refuse('FIRST_REVIEWED_GRAPH_REQUIRES_UNUSED_NATIVE_HISTORY');
      const approval=validateReviewedGraphApproval(proof.graphApprovalRaw,{planSha256:plan.planSha256,window:this.window,clientSource:proof.clientSource,serverSource:proof.serverSource,packetSha256:proof.packetSha256});
      if(approval.approvalHash!==plan.ownerApprovalHash)refuse('GRAPH_SOURCE_APPROVAL_HASH_MISMATCH');
      if(proof.expectedWindow!==this.window||proof.allHostsStopped!==true||proof.canonicalLeasesZero!==true||proof.previousNativeTerminal!==true
        ||proof.chargedAttempts!==s.chargedAttempts||s.pending||s.unresolvedDispatches)refuse('REVIEWED_GRAPH_RECONCILIATION_REQUIRED');
      if(current&&JSON.stringify(current)===JSON.stringify(plan))return;
      if(this.lines.some(l=>l.kind==='plan'&&(l.plan as ReviewedContinuationPlan).ownerApprovalHash===plan.ownerApprovalHash)
        ||plan.flows.reduce((n,f)=>n+f.requests,0)>this.modelCap-30)refuse('REVIEWED_GRAPH_RECONCILIATION_REQUIRED');
      for(const old of this.flows){
        const next=plan.flows.find(f=>f.id===old.id),policy=current?.flows.find(f=>f.id===old.id)?.policy??defaultContinuationFlowPolicy(old.id);
        if(!next||next.role!==old.role||next.workHash!==old.workHash||next.requests>old.requests||next.requests<s.requests.filter(r=>r.flow===old.id).length
          ||!sameContinuationFlowPolicy(next.policy,policy)||current&&next&&plan.flowCases[old.id]!==current.flowCases[old.id])refuse('REVIEWED_GRAPH_HISTORY_CHANGED');
      }
      if(current&&Object.keys(current.actorIds).some(role=>current.actorIds[role as Role]!==plan.actorIds[role as Role]))refuse('REVIEWED_GRAPH_HISTORY_CHANGED');
      await this.append('plan',{window:this.window,plan,proof:structuredClone(proof),approvalHash:approval.approvalHash});
    });
  }
  async selectPhase(phase: 'hermes' | 'openclaw', active: readonly string[], absoluteDeadline: number) {
    return this.serialized(async () => {
      if (this.snapshot().pending) refuse('UNKNOWN_PROVIDER_ATTEMPT');
      if (!active.length || active.some(id => !this.flows.some(f => f.id === id && (phase === 'openclaw' ? f.role === 'openclaw' : f.role !== 'openclaw')))) refuse('HOST_PHASE_REFUSED');
      const roles = active.map(id => this.flows.find(f => f.id === id)!.role);
      const sameRole=new Set(roles).size!==roles.length;
      if(sameRole&&(!this.reviewedPlan?.allowSameRoleCohorts||active.length!==2||new Set(active.map(id=>this.reviewedPlan!.flowCases[id])).size!==2)
        ||this.reviewedPlan&&active.length>2
        ||active.some(id=>!this.lines.some(l=>l.kind==='binding'&&l.flow===id&&l.window===this.window)))refuse('AMBIGUOUS_OR_UNBOUND_WORK');
      if (!Number.isSafeInteger(absoluteDeadline) || absoluteDeadline <= Date.now() || absoluteDeadline > Date.now() + 120000) refuse('NATIVE_DEADLINE_REQUIRED');
      if (this.lines.some(l => l.kind === 'phase' && (l.active as string[]).some(id => active.includes(id)))) refuse('NATIVE_DEADLINE_CANNOT_RESET');
      await this.append('phase', { phase, active, deadline: absoluteDeadline });
    });
  }
  async reserve(role: Role, nativeToken: string) {
    return this.serialized(async () => {
      const s = this.snapshot();
      if (!s.activeDeadline || Date.now() >= s.activeDeadline) refuse('NATIVE_DEADLINE_EXPIRED');
      if (this.denied || (s.lastPhase === 'openclaw') !== (role === 'openclaw') || !s.lastPhase) refuse('HOST_PHASE_REFUSED');
      const binding = this.lines.find(l => l.kind === 'binding' && l.window === this.window && l.role === role && l.nativeToken === nativeToken && s.lastActive?.includes(l.flow as string));
      const flow = this.flows.find(f => f.id === binding?.flow && f.role === role);
      if (!flow || s.chargedAttempts >= this.modelCap || s.requests.filter(r => r.flow === flow.id).length >= flow.requests) refuse('MODEL_REQUEST_CAP_REACHED');
      const attempt = randomBytes(16).toString('hex');
      await this.append('attempt', { attempt, flow: flow.id, role, canonicalWorkHash: binding!.canonicalWorkHash });
      return attempt;
    });
  }
  async finish(attempt: string, outcome: 'response' | 'lost' | 'aborted' | 'not_forwarded') {
    return this.serialized(async () => {
      const s = this.snapshot();
      if (!s.requests.some(r => r.attempt === attempt) || this.lines.some(l => l.kind === 'finished' && l.attempt === attempt)) refuse('REQUEST_ATTEMPT_MISMATCH');
      await this.append('finished', { attempt, outcome });
    });
  }
  async markDispatched(attempt: string) {
    return this.serialized(async () => {
      if (!this.snapshot().requests.some(r => r.attempt === attempt) || this.lines.some(l => l.kind === 'dispatched' && l.attempt === attempt)) refuse('REQUEST_ATTEMPT_MISMATCH');
      await this.append('dispatched', { attempt });
    });
  }
}

export async function requestBudgetMeter(options: {
  ledger: RequestBudgetLedger; bindings: ReadonlyArray<{ role: Role; token: string; models: readonly string[] }>;
  active?: () => boolean; signal: AbortSignal; fetch?: typeof fetch;
  allowWork?: (role:Role,nativeToken:string)=>boolean;
  /** Consume an out-of-band, actual owned-native intent for these exact bytes.
   * This callback NEVER charges: this meter remains the sole durable owner. */
  authorizePhysical?(request:Readonly<{role:Role;nativeToken:string;window:string;bodySha256:string;deadlineUnixMs:number}>,signal:AbortSignal):Promise<void|PhysicalMeterAuthorization>;
}) {
  const upstream = options.fetch ?? fetch, active = options.active ?? (() => false);
  const servedWindow = options.ledger.window;
  const tasks = new Set<Promise<void>>();
  const tokens = options.bindings;
  if (!tokens.length || tokens.some(b => !exactHash(b.token) || !b.models.length) || new Set(tokens.map(b => b.role)).size !== tokens.length) refuse('METER_BINDINGS_INVALID');
  // A crashed meter with an unresolved attempt never silently resumes work or switches hosts.
  if (options.ledger.snapshot().pending) refuse('UNKNOWN_PROVIDER_ATTEMPT');
  let expectedHost = ''; const controllers = new Set<AbortController>();
  const respond = (res: ServerResponse, status: number, code: string) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ error: { type: 'request_budget_guard', message: code } })); };
  const server = createServer((req, res) => {
    const task = handle(req, res).catch(() => { if (!res.headersSent && !res.destroyed) respond(res, 503, 'PROVIDER_REQUEST_REFUSED'); else res.destroy(); });
    tasks.add(task); void task.finally(() => tasks.delete(task));
  });
  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (options.ledger.window !== servedWindow) return respond(res, 503, 'WINDOW_REPLACED');
    const role = req.headers['x-envoi-meter-role'], token = req.headers['x-phase-c-meter'];
    const binding = tokens.find(b => b.role === role);
    if (req.headers.host !== expectedHost || req.headers.origin !== undefined || req.headers['x-envoi-meter-window'] !== servedWindow
      || !binding || !exactHash(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(binding.token))) return respond(res, 403, 'METER_AUTH_REQUIRED');
    if (req.method !== 'POST' || req.url !== '/v1/messages' || req.headers['transfer-encoding']) return respond(res, 404, 'PROVIDER_ROUTE_REFUSED');
    if (!active() || options.signal.aborted) return respond(res, 503, 'WINDOW_NOT_ACTIVE');
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 2_000_000) return respond(res, 413, 'BODY_LIMIT'); chunks.push(chunk); }
    const body = Buffer.concat(chunks); let payload: { model?: unknown; messages?: unknown };
    try { payload = JSON.parse(body.toString('utf8')); } catch { return respond(res, 400, 'INVALID_BODY'); }
    if (!payload || typeof payload !== 'object' || !binding.models.includes(String(payload.model)) || !Array.isArray(payload.messages)) return respond(res, 403, 'MODEL_REFUSED');
    const controller = new AbortController(); controllers.add(controller);
    const abort = () => controller.abort(); res.once('close', abort); options.signal.addEventListener('abort', abort, { once: true });
    const monitor = setInterval(() => { if (!active() || options.signal.aborted || Date.now() >= (options.ledger.snapshot().activeDeadline ?? 0)) abort(); }, 20);
    let attempt: string | undefined;
    let physicalAuthorization:void|PhysicalMeterAuthorization=undefined;
    let upstreamCalled = false;
    try {
      if (!active() || options.signal.aborted) return respond(res, 503, 'WINDOW_NOT_ACTIVE');
      const nativeToken = req.headers['x-envoi-meter-work'];
      if (!exactHash(nativeToken)) return respond(res, 403, 'NATIVE_WORK_BINDING_REQUIRED');
      if(options.allowWork&&!options.allowWork(binding.role,nativeToken))return respond(res,403,'NATIVE_WORK_NOT_ACTIVE');
      if(options.authorizePhysical){
        const commitment=Object.freeze({role:binding.role,nativeToken,window:servedWindow,bodySha256:hash(body),deadlineUnixMs:options.ledger.snapshot().activeDeadline!});
        let abort=()=>{};
        try{physicalAuthorization=await Promise.race([Promise.resolve().then(()=>{controller.signal.throwIfAborted();return options.authorizePhysical!(commitment,controller.signal);}),
          new Promise<never>((_,reject)=>{abort=()=>reject(controller.signal.reason);controller.signal.addEventListener('abort',abort,{once:true});if(controller.signal.aborted)abort();})]);}
        finally{controller.signal.removeEventListener('abort',abort);}
        controller.signal.throwIfAborted();
      }
      attempt = await options.ledger.reserve(binding.role, nativeToken); // durable fsync BEFORE upstream bytes
      await physicalAuthorization?.onMeterEvent({phase:'reserved',reservationId:attempt});
      if (!active() || controller.signal.aborted || options.allowWork&&!options.allowWork(binding.role,nativeToken)) return respond(res, 503, 'WINDOW_NOT_ACTIVE');
      const headers = new Headers();
      const hop = new Set(['host','content-length','connection','transfer-encoding','te','trailer','upgrade','keep-alive','proxy-authenticate','proxy-authorization']);
      for (const nominated of String(req.headers.connection ?? '').split(',')) if (nominated.trim()) hop.add(nominated.trim().toLowerCase());
      for (const [name, value] of Object.entries(req.headers)) {
        if (!hop.has(name) && !name.startsWith('x-phase-c-') && !name.startsWith('x-envoi-meter-') && typeof value === 'string') headers.set(name, value);
      }
      if (!active() || controller.signal.aborted) return respond(res, 503, 'WINDOW_NOT_ACTIVE');
      upstreamCalled = true;
      const response = await upstream('https://api.anthropic.com/v1/messages', { method: 'POST', redirect: 'error', headers, body, signal: controller.signal });
      await options.ledger.markDispatched(attempt);
      await physicalAuthorization?.onMeterEvent({phase:'dispatched',reservationId:attempt});
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); refuse('UPSTREAM_REDIRECT_REFUSED'); }
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' });
      if (response.body) await pipeline(Readable.fromWeb(response.body as never), res); else res.end();
      const completed=attempt;await options.ledger.finish(completed, 'response');attempt=undefined;
      await physicalAuthorization?.onMeterEvent({phase:'response',reservationId:completed});
    } finally {
      clearInterval(monitor); res.removeListener('close', abort); options.signal.removeEventListener('abort', abort); controllers.delete(controller);
      if (attempt){const completed=attempt,outcome=!upstreamCalled?'not_forwarded':controller.signal.aborted?'aborted':'lost';
        await options.ledger.finish(completed,outcome);attempt=undefined;
        await physicalAuthorization?.onMeterEvent({phase:outcome,reservationId:completed});}
    }
  }
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') return refuse('METER_BIND_FAILED');
  expectedHost = `127.0.0.1:${address.port}`;
  const close = async () => {
    await new Promise<void>(resolve => { for (const c of controllers) c.abort(); server.close(() => resolve()); server.closeAllConnections(); });
    await Promise.allSettled([...tasks]);
  };
  return { origin: `http://${expectedHost}`, close };
}
