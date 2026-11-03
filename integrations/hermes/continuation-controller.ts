import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertHumanDecisionMessage, type HumanDecisionWorkMessage } from '../../sdk/typescript/src/connector';
import { continuationAllocation,defaultContinuationFlowPolicy,validateReviewedContinuationPlan,validateReviewedGraphApproval,type ReviewedContinuationPlan } from './continuation-plan';
import { RequestBudgetLedger, nativeWorkToken } from './request-budget';
import { guardNativeSubmission, type NativeSubmissionGuard } from './native-binding';

type Role=RequestBudgetLedger['flows'][number]['role'];
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function refuse(code:string):never{throw Object.assign(new Error(code),{code});}
export type ContinuationReceipt=Readonly<{
  version:1;ownerApproved:true;approvalReceiptSha256:string;packetSha256:string;clientSource:string;serverSource:string;runnerSha256:string;
  ciHead:string;ciPassed:true;modelCap:54|64;startUtc:string;hardStopUtc:string;
}>;
export type ContinuationPreflight=Readonly<{
  checkedAtMs:number;allSelectedHostsStopped:true;activeLeases:0;protectedCasePaused:true;originalDispositionMatches:true;
  actualHermesCalls:24;actualOpenClawCalls:6;conservativeMessages:22;canonicalEffects:9;cases:4;newInstallations:5;assets:0;
}>;
type Work=Readonly<{workId:string;message:{id:string;caseId:string;kind?:string;outcome?:string;recipientAgentId?:string;[key:string]:unknown}}>; 
type Binding={flowId:string;role:Role;caseId:string;workId:string;evidenceSha256:string;submitted:boolean;finished:boolean;forwardingClosed:boolean;closedJournalSha256?:string;sessionId?:string;nativeToken?:string};
type Deferred={promise:Promise<void>;resolve:()=>void;reject:(reason:unknown)=>void};
/** Supplied by a trusted host only after establishing its real per-native-session meter attribution.
 * Multi-work OpenClaw plans need it even for sequential groups: an earlier turn may issue a late request.
 * Merely reviewing a graph or returning a fixture object is not a host capability proof. */
export type SameRoleNativeAttribution=Readonly<{window:string;role:Role;flowId:string;caseId:string;agentId:string;workId:string;sessionId:string;nativeToken:string}>;
export type SameRoleNativeAttributionGuard=(binding:SameRoleNativeAttribution,signal:AbortSignal)=>Promise<SameRoleNativeAttribution>;
/** A trusted operator checkpoint, not a native flow or an acceptance proof. */
export type PreNativeControl=Readonly<{controlId:string;mode:'pause'|'expiry'|'revoke'|'authority-expiry';role:Role;caseId:string;workId:string;evidenceSha256:string}>;
const deferred=():Deferred=>{let resolve!:()=>void,reject!:(reason:unknown)=>void;const promise=new Promise<void>((a,b)=>{resolve=a;reject=b;});void promise.catch(()=>{});return {promise,resolve,reject};};

/** Trusted local execution controller. No model-facing API, startup, enrollment or send operation. */
export class ContinuationController {
  readonly control=new AbortController();
  private group:{ids:string[];ready:Map<string,number>;gate:Deferred;activating:boolean}|undefined;
  private bindings=new Map<string,Binding>();
  private released=new Set<string>();
  private expectedWork=new Map<string,{workId:string;evidenceSha256:string}>();
  private preNativeControl:Readonly<PreNativeControl & {baseline:number}>|undefined;
  private usedControlIds=new Set<string>();
  private constructor(readonly ledger:RequestBudgetLedger,readonly receipt:ContinuationReceipt,
    private flowCases:Readonly<Record<string,string>>,private actorIds:Readonly<Record<Role,string>>,private sameRoleNativeAttribution?:SameRoleNativeAttributionGuard){}

  static async open(options:{releaseRoot:string;receipt:ContinuationReceipt;preflight:ContinuationPreflight;
    expected:{clientSource:string;serverSource:string;runnerSha256:string;packetSha256:string;priorLedgerSha256:string};
    flowCases:Readonly<Record<string,string>>;actorIds:Readonly<Record<Role,string>>;reviewedPlan?:ReviewedContinuationPlan;sameRoleNativeAttribution?:SameRoleNativeAttributionGuard}) {
    const {receipt:r,preflight:p,expected:e}=options;const start=Date.parse(r.startUtc),stop=Date.parse(r.hardStopUtc),now=Date.now();
    if(r.version!==1||r.ownerApproved!==true||!digest(r.approvalReceiptSha256)||!digest(r.packetSha256)
      ||r.clientSource!==e.clientSource||r.serverSource!==e.serverSource||r.runnerSha256!==e.runnerSha256||r.packetSha256!==e.packetSha256
      ||!r.ciPassed||r.ciHead!==r.clientSource||![54,64].includes(r.modelCap)
      ||!Number.isFinite(start)||!Number.isFinite(stop)||start>now||stop<=now||stop-start>90*60*1000) refuse('FRESH_EXACT_CONTINUATION_APPROVAL_REQUIRED');
    if(!Number.isFinite(p.checkedAtMs)||p.checkedAtMs>now||now-p.checkedAtMs>300000||!p.allSelectedHostsStopped||p.activeLeases!==0
      ||!p.protectedCasePaused||!p.originalDispositionMatches||p.actualHermesCalls!==24||p.actualOpenClawCalls!==6
      ||p.conservativeMessages!==22||p.canonicalEffects!==9||p.cases!==4||p.newInstallations!==5||p.assets!==0) refuse('FRESH_PRESERVED_PREFLIGHT_REQUIRED');
    const reviewed=options.reviewedPlan?validateReviewedContinuationPlan(options.reviewedPlan):undefined;
    if(options.sameRoleNativeAttribution!==undefined&&typeof options.sameRoleNativeAttribution!=='function')refuse('SAME_ROLE_NATIVE_ATTRIBUTION_REQUIRED');
    if(reviewed&&(Object.keys(options.flowCases).length!==reviewed.flows.length||reviewed.flows.some(f=>options.flowCases[f.id]!==reviewed.flowCases[f.id])
      ||Object.keys(options.actorIds).some(role=>options.actorIds[role as Role]!==reviewed.actorIds[role as Role])))refuse('REVIEWED_GRAPH_CANONICAL_SCOPE_CHANGED');
    const flows=reviewed?reviewed.flows.map(({policy:_policy,...flow})=>flow):continuationAllocation(r.modelCap===64?'bounded-contingency':'sequential');
    if(flows.some(f=>!/^case_[A-Za-z0-9_-]+$/.test(options.flowCases[f.id]??'')||!/^agent_[A-Za-z0-9_-]+$/.test(options.actorIds[f.role]??''))) refuse('EXACT_FIXTURE_BINDINGS_REQUIRED');
    const root=path.resolve(options.releaseRoot),filename=path.join(root,'phase-c-cumulative-requests.jsonl');
    const priorBytes=await fs.readFile(path.join(root,'budget-7c522b08c11f.terminal-dd4debf.json'));
    if(!digest(e.priorLedgerSha256)||hash(priorBytes)!==e.priorLedgerSha256) refuse('PRIOR_LEDGER_CHANGED');
    const prior={...JSON.parse(priorBytes.toString('utf8')),actualHermesApiCalls:24,canonicalEffects:9,priorUploadedAssets:0,carriedLedgerSha256:e.priorLedgerSha256};
    const window=hash(JSON.stringify(r));let ledger:RequestBudgetLedger;
    try{await fs.lstat(filename);ledger=await RequestBudgetLedger.open(filename);}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
      if(reviewed)refuse('EXISTING_REVIEWED_GRAPH_LEDGER_REQUIRED');
      // A stranded anchor is never replaced by another seed.
      try{await fs.lstat(path.join(root,'phase-c-request-ledger.anchor'));refuse('CANONICAL_REQUEST_LEDGER_REQUIRED');}catch(check){if((check as NodeJS.ErrnoException).code!=='ENOENT')throw check;}
      ledger=await RequestBudgetLedger.prepare(filename,prior,flows,window,{purpose:'phase-c-decline-continuation',models:r.modelCap,approvalReceiptSha256:r.approvalReceiptSha256});
    }
    if(ledger.window!==window||ledger.modelCap!==r.modelCap||ledger.snapshot().pending||JSON.stringify(ledger.flows)!==JSON.stringify(flows)
      ||JSON.stringify(ledger.reviewedPlan)!==JSON.stringify(reviewed)) refuse('CANONICAL_CONTINUATION_RECONCILIATION_REQUIRED');
    if(reviewed){const approval=validateReviewedGraphApproval(ledger.reviewedGraphApprovalRaw,{planSha256:reviewed.planSha256,window,clientSource:r.clientSource,serverSource:r.serverSource,packetSha256:r.packetSha256});
      if(approval.approvalHash!==reviewed.ownerApprovalHash)refuse('GRAPH_SOURCE_APPROVAL_HASH_MISMATCH');}
    return new ContinuationController(ledger,Object.freeze({...r}),Object.freeze({...options.flowCases}),Object.freeze({...options.actorIds}),options.sameRoleNativeAttribution);
  }
  active(){return !this.control.signal.aborted&&Date.now()<Date.parse(this.receipt.hardStopUtc);}
  modelActive(){return this.active()&&!!this.group&&this.group.ready.size===this.group.ids.length&&this.group.ids.some(id=>{const b=this.bindings.get(id);return b?.submitted&&!b.finished&&!b.forwardingClosed;});}
  allowMeterWork(role:Role,token:string){return this.modelActive()&&[...this.bindings.values()].some(b=>b.role===role&&b.nativeToken===token&&b.submitted&&!b.finished&&!b.forwardingClosed&&this.group?.ids.includes(b.flowId));}
  private live(){if(!this.active())refuse('CONTINUATION_WINDOW_CLOSED');}
  private needsNativeAttribution(ids:readonly string[],role:Role){
    return ids.filter(id=>this.ledger.flows.find(f=>f.id===id)?.role===role).length>1
      ||role==='openclaw'&&(this.ledger.reviewedPlan?.flows.filter(f=>f.role==='openclaw').length??0)>1;
  }
  stop(reason='CONTROLLED_STOP'){this.control.abort(new Error(reason));this.group?.gate.reject(this.control.signal.reason);}
  releaseGroup(ids:readonly string[]) {
    this.live();if(this.preNativeControl)refuse('PRE_NATIVE_CONTROL_ACTIVE');if(this.ledger.snapshot().pending||this.group&&!this.group.ids.every(id=>this.bindings.get(id)?.finished))refuse('PRIOR_FLOW_NOT_RECONCILED');
    const flows=ids.map(id=>this.ledger.flows.find(f=>f.id===id));
    const sameRole=new Set(flows.map(f=>f?.role)).size!==ids.length;
    if(!ids.length||new Set(ids).size!==ids.length||flows.some(f=>!f)||ids.some(id=>this.released.has(id))
      ||sameRole&&(!this.ledger.reviewedPlan?.allowSameRoleCohorts||ids.length!==2||new Set(ids.map(id=>this.flowCases[id])).size!==2)
      ||this.ledger.reviewedPlan&&(ids.length>2||new Set(flows.map(f=>f?.role==='openclaw')).size>1))refuse('REVIEWED_DISTINCT_FLOW_GROUP_REQUIRED');
    if(flows.some(f=>this.needsNativeAttribution(ids,f!.role))&&!this.sameRoleNativeAttribution)refuse('SAME_ROLE_NATIVE_ATTRIBUTION_REQUIRED');
    this.group={ids:[...ids],ready:new Map(),gate:deferred(),activating:false};for(const id of ids)this.released.add(id);
  }
  /** Trusted canonical GET/effect observer pins the exact work before any claim/native admission. */
  expectWork(flowId:string,workId:string,canonicalEvidenceSha256:string){
    this.live();const bound=this.bindings.get(flowId);if(!this.group?.ids.includes(flowId)||bound&&(bound.submitted||bound.workId!==workId)||!/^msg_[A-Za-z0-9_-]+$/.test(workId)||!digest(canonicalEvidenceSha256)
      ||[...this.expectedWork.entries()].some(([id,v])=>id!==flowId&&v.workId===workId))refuse('EXACT_CANONICAL_RECEIPT_REQUIRED');
    const previous=this.expectedWork.get(flowId);if(previous&&previous.workId!==workId)refuse('CANONICAL_WORK_BINDING_CHANGED');
    this.expectedWork.set(flowId,{workId,evidenceSha256:canonicalEvidenceSha256});
  }
  /** Only the trusted authenticated claim observer calls this; raw receipt stays private/in RAM. */
  observeClaim(flowId:string,role:Role,work:Work,receiptBytes:string) {
    this.live();const flow=this.ledger.flows.find(f=>f.id===flowId);
    const expected=this.expectedWork.get(flowId);
    if(!flow||flow.role!==role||!this.group?.ids.includes(flowId)||!expected||work.workId!==expected.workId||work.workId!==work.message.id
      ||!/^msg_[A-Za-z0-9_-]+$/.test(work.workId)||work.message.caseId!==this.flowCases[flowId]
      ||work.message.recipientAgentId!==this.actorIds[role])refuse('CANONICAL_WORK_GRAPH_MISMATCH');
    const policy=this.flowPolicy(flowId);
    if(policy.decisionOutcome!==null){
      if(work.message.kind!=='humanDecision')refuse('CANONICAL_HUMAN_DECISION_REQUIRED');
      assertHumanDecisionMessage(work.message as unknown as HumanDecisionWorkMessage);
      if(work.message.outcome!==policy.decisionOutcome)refuse('CANONICAL_HUMAN_DECISION_REQUIRED');
    }
    const previous=this.bindings.get(flowId);
    if(previous&&(previous.workId!==work.workId||previous.submitted))refuse('CANONICAL_WORK_BINDING_CHANGED');
    this.bindings.set(flowId,{flowId,role,workId:work.workId,caseId:work.message.caseId,evidenceSha256:hash(JSON.stringify([expected.evidenceSha256,hash(receiptBytes)])),submitted:false,finished:false,forwardingClosed:false});
  }
  nativeGuard(role:Role,meterToken:string):NativeSubmissionGuard {
    return async(frame,signal)=>{
      this.live();if(this.preNativeControl)refuse('PRE_NATIVE_CONTROL_FORBIDS_NATIVE');signal.throwIfAborted();const group=this.group;
      const binding=[...this.bindings.values()].find(b=>b.role===role&&b.workId===frame.workId&&group?.ids.includes(b.flowId));
      if(!binding||!group||binding.submitted||frame.deadlineUnixMs<=Date.now()||frame.deadlineUnixMs>Date.now()+120000)refuse('EXACT_NATIVE_WORK_REQUIRED');
      const nativeSignal=AbortSignal.any([signal,this.control.signal,AbortSignal.timeout(Math.max(1,frame.deadlineUnixMs-Date.now()))]);
      const token=nativeWorkToken(meterToken,this.ledger.window,role,frame.sessionId);
      if(this.needsNativeAttribution(group.ids,role)){
        if(!this.sameRoleNativeAttribution)refuse('SAME_ROLE_NATIVE_ATTRIBUTION_REQUIRED');
        const expected={window:this.ledger.window,role,flowId:binding.flowId,caseId:binding.caseId,agentId:this.actorIds[role],workId:frame.workId,sessionId:frame.sessionId,nativeToken:token};
        let observed:SameRoleNativeAttribution|undefined;
        await guardNativeSubmission(async(_binding,bounded)=>{
          const result=await this.sameRoleNativeAttribution!(Object.freeze(expected),bounded);
          bounded.throwIfAborted();
          if(Date.now()>=frame.deadlineUnixMs)refuse('NATIVE_DEADLINE_EXPIRED');
          observed=result;
        },frame,nativeSignal);
        nativeSignal.throwIfAborted();
        const proof=observed;
        if(!proof||Object.keys(proof).length!==Object.keys(expected).length||Object.entries(expected).some(([key,value])=>proof[key as keyof SameRoleNativeAttribution]!==value))refuse('SAME_ROLE_NATIVE_ATTRIBUTION_REQUIRED');
        this.live();
      }
      nativeSignal.throwIfAborted();
      if(Date.now()>=frame.deadlineUnixMs)refuse('NATIVE_DEADLINE_EXPIRED');
      await this.ledger.bindWork(binding.flowId,{canonicalWorkHash:hash(frame.workId),nativeToken:token,evidenceHash:binding.evidenceSha256});
      nativeSignal.throwIfAborted();this.live();binding.submitted=true;binding.sessionId=frame.sessionId;binding.nativeToken=nativeWorkToken(meterToken,this.ledger.window,role,frame.sessionId);group.ready.set(binding.flowId,frame.deadlineUnixMs);
      if(group.ready.size===group.ids.length&&!group.activating){group.activating=true;
        try{const phase=role==='openclaw'?'openclaw':'hermes';if(group.ids.some(id=>(this.bindings.get(id)!.role==='openclaw')!==(phase==='openclaw')))refuse('MIXED_HOST_PHASE_REFUSED');
          await this.ledger.selectPhase(phase,group.ids,Math.min(...group.ready.values()));this.live();group.gate.resolve();
        }catch(error){this.stop('NATIVE_GROUP_REFUSED');throw error;}}
      await guardNativeSubmission(async()=>group.gate.promise,frame,nativeSignal);
      nativeSignal.throwIfAborted();this.live();
    };
  }
  flowPolicy(flowId:string){
    if(!this.ledger.flows.some(f=>f.id===flowId))refuse('REVIEWED_FLOW_REQUIRED');
    return this.ledger.reviewedPlan?.flows.find(f=>f.id===flowId)!.policy??defaultContinuationFlowPolicy(flowId);
  }
  /** This mutex never binds/charges/completes a native flow. The separate trusted
   * observer must prove the actual negative outcome and canonical reoffer. */
  beginPreNativeControl(input:PreNativeControl){
    this.live();
    if(this.preNativeControl||this.ledger.snapshot().pending||this.group&&!this.group.ids.every(id=>this.bindings.get(id)?.finished))refuse('PRIOR_FLOW_NOT_RECONCILED');
    if(Object.keys(input).sort().join(',')!=='caseId,controlId,evidenceSha256,mode,role,workId'
      ||!/^[A-Za-z0-9_-]{1,100}$/.test(input.controlId)||this.usedControlIds.has(input.controlId)
      ||!['pause','expiry','revoke','authority-expiry'].includes(input.mode)||!this.actorIds[input.role]
      ||!Object.values(this.flowCases).includes(input.caseId)||!/^msg_[A-Za-z0-9_-]+$/.test(input.workId)||!digest(input.evidenceSha256)
      ||[...this.bindings.values()].some(b=>b.workId===input.workId&&b.submitted))refuse('EXACT_PRE_NATIVE_CONTROL_REQUIRED');
    this.usedControlIds.add(input.controlId);this.preNativeControl=Object.freeze({...input,baseline:this.ledger.snapshot().chargedAttempts});
  }
  observePreNativeControlClaim(controlId:string,role:Role,work:Work){
    this.live();const c=this.preNativeControl;
    if(!c||c.controlId!==controlId||c.role!==role||work.workId!==c.workId||work.message.id!==c.workId
      ||work.message.caseId!==c.caseId||work.message.recipientAgentId!==this.actorIds[role])refuse('CANONICAL_CONTROL_WORK_MISMATCH');
  }
  endPreNativeControl(controlId:string){
    this.live();const c=this.preNativeControl;
    if(!c||c.controlId!==controlId||this.ledger.snapshot().pending||this.ledger.snapshot().chargedAttempts!==c.baseline)refuse('PRE_NATIVE_CONTROL_MODEL_ACTIVITY');
    this.preNativeControl=undefined;
  }
  assertScopedTool(role:Role,name:string,workId?:string){
    this.live();const candidates=[...this.bindings.values()].filter(b=>b.role===role&&this.group?.ids.includes(b.flowId));
    if(candidates.length>1&&!workId)refuse('EXACT_SCOPED_WORK_REQUIRED');
    const active=candidates.find(b=>!workId||b.workId===workId);
    if(!active)refuse('UNBOUND_SCOPED_OPERATION');
    if(!active.submitted&&!['envoi_case_snapshot','envoi_case_list_assets'].includes(name))refuse('UNBOUND_SCOPED_OPERATION');
    if(this.flowPolicy(active.flowId).noAction&&!['envoi_case_snapshot','envoi_case_list_assets'].includes(name)){
      this.stop('UNEXPECTED_NO_ACTION_FLOW_WRITE');refuse('UNEXPECTED_NO_ACTION_FLOW_WRITE');
    }
  }
  /** Trusted host reads the completed native journal before probes/settlement.
   * This only closes that work's provider fence; it claims no canonical processing or refund. */
  closeNativeForwarding(flowId:string,proof:{workId:string;journalCompleted:true;journalSha256:string}){
    this.live();const b=this.bindings.get(flowId);
    if(!b?.submitted||proof.workId!==b.workId||proof.journalCompleted!==true||!digest(proof.journalSha256)
      ||b.closedJournalSha256&&b.closedJournalSha256!==proof.journalSha256)refuse('ACTUAL_NATIVE_COMPLETION_FENCE_PROOF_REQUIRED');
    b.forwardingClosed=true;b.closedJournalSha256=proof.journalSha256;
  }
  /** Proof is read by the trusted runner from the real saved journal + canonical settlement. */
  finishWork(flowId:string,proof:{workId:string;canonicalStatus:'processed';journalCompleted:true;journalSha256:string;nativeOutcome:'completed'|'ended_for_human';
    caseStillOpen?:true;caseState?:'inProgress'|'completed';newCanonicalEffects?:0;decisionOutcome?:'declined'}) {
    this.live();const b=this.bindings.get(flowId);
    if(!b?.submitted||b.finished||proof.workId!==b.workId||proof.canonicalStatus!=='processed'||proof.journalCompleted!==true
      ||!digest(proof.journalSha256)||!['completed','ended_for_human'].includes(proof.nativeOutcome)||this.ledger.snapshot().pending)refuse('ACTUAL_NATIVE_SETTLEMENT_PROOF_REQUIRED');
    const policy=this.flowPolicy(flowId);
    if(proof.nativeOutcome==='ended_for_human'&&!policy.allowHumanEnd)refuse('UNEXPECTED_HUMAN_END');
    const expectedState=policy.expectedCaseState??'inProgress',provedState=proof.caseState??(proof.caseStillOpen===true?'inProgress':undefined);
    if(policy.noAction&&(provedState!==expectedState||proof.newCanonicalEffects!==0
      ||expectedState==='completed'&&proof.caseStillOpen!==undefined
      ||policy.decisionOutcome==='declined'&&proof.decisionOutcome!=='declined'))refuse('NO_ACTION_RESUMPTION_PROOF_REQUIRED');
    this.closeNativeForwarding(flowId,proof);
    b.finished=true;
  }
  summary(){return {active:this.active(),source:this.receipt.clientSource,modelCap:this.ledger.modelCap,budget:this.ledger.snapshot(),
    released:[...this.released],finished:[...this.bindings.values()].filter(b=>b.finished).map(b=>b.flowId),onboardingPerformed:false,acceptedSendsRepeated:false};}
}
