import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readConnection } from '../connector/core';
import { adapterFor } from '../connector/adapters';
import { acquireConnectorLock } from '../connector/store';
import { startControl } from '../connector/control';
import { createHostTaskSender,HostTaskError,type HostTaskRequest } from '../connector/host-task';
import { FileScopedRunStore } from '../grok/scoped-store';
import type { RuntimeBridge } from '../connector/adapter';
import type { NativeRequestGateExpectation } from './request-gate-attestation';
import { ContinuationController,type PreNativeControl } from './continuation-controller';
import type {ContinuationFlowPolicy} from './continuation-plan';
import {guardNativeSubmission,type NativeSubmissionGuard} from './native-binding';
import {OpenClawTargetRegistry,openClawTargetDigest,type OpenClawWorkTarget,type OpenClawTargetResolver,type OpenClawTargetSelectionAuthority} from '../openclaw/scoped-target';
import {assertOwnedClosedNativeAuthority,ownedClosedNativeAuthorityPins,type OwnedClosedNativeAuthority} from '../openclaw/owned-native-process';
import {assertOwnedOpenClawFactory,type OwnedOpenClawFactory} from '../openclaw/per-work-native';

type Role='je1'|'je2'|'testowner'|'openclaw';
export type ContinuationWork=Readonly<{flowId:string;workId:string;caseId:string;evidenceSha256:string}>;
type ActiveWork=ContinuationWork & {humanEnd:boolean;settled:boolean;failed:boolean;deadline?:number;nativeBinding?:Promise<void>;held?:boolean;workStop?:AbortController;beforeIds?:Set<unknown>;completedJournalHash?:string;controlDrained?:boolean;leaseExpiresAt?:string;leaseToken?:string;nativeFrame?:Parameters<NativeSubmissionGuard>[0];sessionSafe?:Readonly<Record<string,unknown>>;workSafe?:Readonly<Record<string,unknown>>;claimRedactedBytes?:string;sessionRedactedBytes?:string;firstSnapshotGate?:Promise<void>;sessionEndRawBytes?:string;completeRawBytes?:string;caseSession?:{id:string;fence:number;expiresAt:string;toolChannelSha256:string};controlCapture?:{work:Readonly<Record<string,unknown>>;claimRedactedBytes:string;session?:Readonly<Record<string,unknown>>;sessionRedactedBytes?:string;authorization?:string;snapshot?:unknown;snapshotRawBytes?:string;protocolVersion?:string;expectedDenial?:string;denialForwarded?:boolean;entered?:boolean;failureRequestRedactedBytes?:string;failureResponseRawBytes?:string}};
export type NativeWorkFacts=Readonly<{window:string;clientSource:string;serverSource:string;role:Role;workId:string;caseId:string;frame:Parameters<NativeSubmissionGuard>[0];session:Readonly<Record<string,unknown>>;journalRawBytes:string}>;
export type ScopedWorkFacts=Readonly<{window:string;clientSource:string;serverSource:string;role:Role;flowId:string;workId:string;caseId:string;toolChannelSha256:string;work:Readonly<Record<string,unknown>>;session:Readonly<Record<string,unknown>>;claimRedactedBytes:string;sessionRedactedBytes:string;leaseExpiresAt():string}>;
export type TrustedScopedControlContext=Readonly<{
  control:PreNativeControl;window:string;clientSource:string;serverSource:string;
  work:Readonly<Record<string,unknown>>;session:Readonly<Record<string,unknown>>;toolChannelSha256:string;
  claimRedactedBytes:string;sessionRedactedBytes:string;snapshot:unknown;snapshotRawBytes:string;
  leaseExpiresAt():string;
  probeLateSettlement(expected:'paused'|'revoked'|'expired'):Promise<{status:{status:number;raw:string};settlement:{status:number;raw:string}}>;
  /** Token never leaves this closure. Only reads and one explicitly registered
   * authority-expiry denial probe can be forwarded. This is not a native tool. */
  channel:Readonly<{forward(body:string):Promise<Response>;registerExpectedDenial(body:string,sha256:string):void}>;
}>;
type FlowPolicy=ContinuationFlowPolicy;
const hash=(x:string|Buffer)=>createHash('sha256').update(x).digest('hex');
function refuse(code:string):never{throw Object.assign(new Error(code),{code});}
const readEnvelope=async(response:Response)=>{const p=await response.clone().json();return p.result?.content?.[0]?.text?JSON.parse(p.result.content[0].text):null;};
async function boundedPreparation(operation:()=>Promise<unknown>,signal:AbortSignal){let abort=()=>{};signal.throwIfAborted();try{await Promise.race([Promise.resolve().then(operation),new Promise<never>((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();})]);signal.throwIfAborted();}finally{signal.removeEventListener('abort',abort);}}
const redactControl=(value:unknown):any=>Array.isArray(value)?value.map(redactControl):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,v])=>[key,/token|secret|authorization|credential/i.test(key)?'[REDACTED]':redactControl(v)])):value;

/** One enrollment/control listener; bounded explicit work, never automatic parallelism. */
export async function createContinuationReceiver(options:{
  controller:ContinuationController;role:Role;stateDir:string;env:NodeJS.ProcessEnv;meterToken:string;nativeGate?:NativeRequestGateExpectation;
  expected:{address:string;agentId:string;inboxId:string;installationId:string};
  allowedNewSends:readonly HostTaskRequest[];
  reserveOperation(input:{kind:'message'|'tool';caseId?:string;tool?:string;workId?:string}):Promise<void>;
  observeTransport?(input:Parameters<typeof fetch>[0],init:Parameters<typeof fetch>[1],next:typeof fetch):Promise<Response>;
  beforeScopedControl?(workId:string,signal:AbortSignal):Promise<never>;
  verifyHeldControl?(workId:string):Promise<{lateScopeDenied:true;lateSettlementDenied:true;heldWorkResumable:true;evidenceSha256:string}>;
  beforeTrustedScopedControl?(context:TrustedScopedControlContext,signal:AbortSignal):Promise<never>;
  observeNativeEnd?(context:NativeWorkFacts & Readonly<{sessionEndRawBytes:string;completeRawBytes:string}>):Promise<void>;
  beforeFirstScopedSnapshot?(context:ScopedWorkFacts,signal:AbortSignal):Promise<void>;
  record(event:Readonly<Record<string,unknown>>):Promise<void>;fetch?:typeof fetch;
  /** Trusted local plumbing only; never relaxes the native attribution admission guard. */
  openClawTargetResolver?:OpenClawTargetResolver;
  openClawTargetSelection?:OpenClawTargetSelectionAuthority;
  /** Actual allocator handle only. JSON/resolver metadata cannot mint authority.
   * Bootstrap readiness is pending first harness; the owned child's physical
   * gate still requires its real harness/registry acknowledgement per request. */
  openClawOwnedNative?:Readonly<{factoryPolicySha256:string;factory?:OwnedOpenClawFactory;authorityForTarget(target:Readonly<OpenClawWorkTarget>,signal:AbortSignal):Promise<OwnedClosedNativeAuthority>}>;
}) {
  const {controller,role}=options,origin=controller.receipt.serverSource&&'https://sinaloa-staging.rachelgonsalves821.workers.dev';
  if(!controller.active())refuse('CONTINUATION_WINDOW_CLOSED');
  const saved=await readConnection(options.stateDir),runtime=role==='openclaw'?'openclaw':'hermes';
  if(saved.apiUrl!==origin||saved.runtime!==runtime||saved.address!==options.expected.address
    ||saved.activationSetup?.agentId!==options.expected.agentId||saved.activationSetup?.inboxId!==options.expected.inboxId
    ||saved.activationSetup?.installationId!==options.expected.installationId)refuse('EXISTING_ENROLLMENT_BINDING_MISMATCH');
  if(runtime==='hermes'&&(!options.nativeGate||options.nativeGate.role!==role||options.nativeGate.meterToken!==options.meterToken
    ||options.nativeGate.window!==controller.ledger.window||options.env.ENVOI_HERMES_GATE_REQUIRED!=='1'))refuse('REQUIRED_NATIVE_GATE_EXPECTATION_MISSING');
  if(options.openClawTargetResolver&&role!=='openclaw')refuse('FOREIGN_OPENCLAW_TARGET_REFUSED');
  if(options.openClawTargetResolver&&(!options.openClawTargetSelection||options.openClawTargetSelection.clientSource!==controller.receipt.clientSource||options.openClawTargetSelection.window!==controller.ledger.window))refuse('PERSONAL_OPENCLAW_TARGET_REVIEW_REQUIRED');
  if(options.openClawOwnedNative&&(role!=='openclaw'||!options.openClawTargetResolver||!options.openClawTargetSelection||!/^[a-f0-9]{64}$/.test(options.openClawOwnedNative.factoryPolicySha256)||typeof options.openClawOwnedNative.authorityForTarget!=='function'))refuse('OWNED_NATIVE_AUTHORITY_REQUIRED');
  const ownedNative=options.openClawOwnedNative?Object.freeze({factoryPolicySha256:options.openClawOwnedNative.factoryPolicySha256,factory:options.openClawOwnedNative.factory,authorityForTarget:options.openClawOwnedNative.authorityForTarget.bind(options.openClawOwnedNative),nativeSourceSha256:options.openClawTargetSelection!.nativeSourceSha256}):undefined;
  const unlock=await acquireConnectorLock(options.stateDir),local=new AbortController();
  const signal=AbortSignal.any([local.signal,controller.control.signal]);let bridge:RuntimeBridge|undefined,control:Awaited<ReturnType<typeof startControl>>|undefined;
  const runs=new FileScopedRunStore(options.stateDir),upstream=options.fetch??fetch;
  const active=new Map<string,ActiveWork>(),scopedTokens=new Map<string,string>(),issuedTokens=new Map<string,string>();
  const targets=options.openClawTargetResolver?new OpenClawTargetRegistry(async(workId,bounded)=>{
    const value=await options.openClawTargetResolver!(workId,bounded);ensure();
    const state=active.get(workId),b=value?.binding,s=state?.caseSession;
    if(!state||state.settled||state.failed||!s||!b||b.workId!==workId||b.caseId!==state.caseId
      ||b.caseSessionId!==s.id||b.fence!==s.fence||b.window!==controller.ledger.window
      ||value.toolChannelSha256!==s.toolChannelSha256
      ||b.recipientAgentId!==options.expected.agentId||b.installationId!==options.expected.installationId
      ||value.deadlineUnixMs>Date.parse(s.expiresAt)||value.deadlineUnixMs>Date.parse(controller.receipt.hardStopUtc))refuse('OPENCLAW_CANONICAL_TARGET_MISMATCH');
    return value;
  },options.openClawTargetSelection):undefined;
  let claims:string[]=[],claimIndex=0,recovery:{workId:string;caseId:string;journalSha256:string}|undefined,preNativeControl:PreNativeControl|undefined;
  let controlConsumer:((context:TrustedScopedControlContext,bounded:AbortSignal)=>Promise<never>)|undefined;
  let settlementProbe:{workId:string;leaseToken:string}|undefined;
  const ensure=()=>{signal.throwIfAborted();if(!controller.active())refuse('CONTINUATION_WINDOW_CLOSED');};
  const policy=(flowId:string):FlowPolicy=>{
    const current=controller as unknown as {flowPolicy?:(id:string)=>FlowPolicy};
    return current.flowPolicy?current.flowPolicy.call(controller,flowId):{noAction:['declined-resume','private-receipt-review'].includes(flowId),decisionOutcome:flowId==='declined-resume'?'declined':null,allowHumanEnd:['accept-authority','asset-decline'].includes(flowId)};
  };
  const workForToken=(init:RequestInit):ActiveWork=>{const token=new Headers(init.headers).get('authorization'),workId=token&&scopedTokens.get(token),state=workId&&active.get(workId);if(!state||state.settled||state.failed)refuse('EXACT_SCOPED_WORK_TOKEN_REQUIRED');return state;};
  const forget=(workId:string)=>{targets?.close(workId);active.delete(workId);for(const [token,id]of scopedTokens)if(id===workId)scopedTokens.delete(token);};
  const scopedFacts=(workId:string):ScopedWorkFacts=>{
    ensure();const state=active.get(workId);if(!state?.workSafe||!state.sessionSafe||!state.claimRedactedBytes||!state.sessionRedactedBytes||!state.caseSession)refuse('ACTUAL_CONTROL_SCOPE_REQUIRED');
    return Object.freeze({window:controller.ledger.window,clientSource:controller.receipt.clientSource,serverSource:controller.receipt.serverSource,role,flowId:state.flowId,workId,caseId:state.caseId,toolChannelSha256:state.caseSession.toolChannelSha256,work:state.workSafe,session:state.sessionSafe,claimRedactedBytes:state.claimRedactedBytes,sessionRedactedBytes:state.sessionRedactedBytes,
      leaseExpiresAt:()=>{ensure();if(active.get(workId)!==state||!state.leaseExpiresAt)refuse('ACTUAL_CONTROL_LEASE_REQUIRED');return state.leaseExpiresAt;}});
  };
  const nativeFacts=async(workId:string):Promise<NativeWorkFacts>=>{
    ensure();const state=active.get(workId);if(!state||state.held||!state.nativeFrame||!state.sessionSafe)refuse('ACTUAL_NATIVE_WORK_FACTS_REQUIRED');
    const bytes=await fs.readFile(path.join(options.stateDir,'scoped-runs',workId+'.json'));if(bytes.length>1000000)refuse('BOUNDED_NATIVE_COMPLETION_PROOF_REQUIRED');
    const journalRawBytes=bytes.toString('utf8'),journal=JSON.parse(journalRawBytes);if(journal.workId!==workId)refuse('EXACT_NATIVE_COMPLETION_PROOF_REQUIRED');
    return Object.freeze({window:controller.ledger.window,clientSource:controller.receipt.clientSource,serverSource:controller.receipt.serverSource,role,workId,caseId:state.caseId,frame:state.nativeFrame,session:state.sessionSafe,journalRawBytes});
  };
  const beforeNativeSubmit:NativeSubmissionGuard=async(frame,bounded)=>{const state=active.get(frame.workId);if(!state||state.held||preNativeControl)refuse('PRE_NATIVE_CONTROL_FORBIDS_NATIVE');
    if(ownedNative){const target=targets?.get(frame.workId);if(!target||!state.caseSession)refuse('EXACT_OPENCLAW_TARGET_REQUIRED');
      const authoritySignal=AbortSignal.any([bounded,signal,AbortSignal.timeout(Math.max(1,frame.deadlineUnixMs-Date.now()))]);
      let capabilitySha256:string|undefined;
      await guardNativeSubmission(async(_frame,guardSignal)=>{const authority=await ownedNative.authorityForTarget(target,guardSignal);guardSignal.throwIfAborted();
        const pins=ownedClosedNativeAuthorityPins(authority,guardSignal);
        assertOwnedClosedNativeAuthority(authority,{window:controller.ledger.window,workId:state.workId,caseId:state.caseId,caseSessionId:state.caseSession!.id,toolChannelSha256:target.toolChannelSha256,processIdentity:target.processIdentity,clientSource:controller.receipt.clientSource,nativeSourceSha256:ownedNative.nativeSourceSha256,capabilitySha256:pins.capabilitySha256,ownerSelectionSha256:target.ownerSelectionSha256,targetSha256:openClawTargetDigest(target)},guardSignal);capabilitySha256=pins.capabilitySha256;
      },frame,authoritySignal);authoritySignal.throwIfAborted();ensure();if(Date.now()>=frame.deadlineUnixMs)refuse('NATIVE_DEADLINE_EXPIRED');
      await options.record({kind:'owned_native_bootstrap_admitted',runtimeObservation:'pending_first_harness',role,workId:state.workId,processIdentity:target.processIdentity,capabilitySha256});
    }
    await controller.nativeGuard(role,options.meterToken)(frame,bounded);bounded.throwIfAborted();state.nativeFrame=Object.freeze({...frame});};
  const direct:typeof fetch=async(input,init={})=>{
    ensure();const url=new URL(input instanceof Request?input.url:String(input));
    if(url.origin!==origin){
      if(preNativeControl)refuse('PRE_NATIVE_CONTROL_FORBIDS_NATIVE');
      const selected=saved.configuration as {gatewayUrl?:string;agentId?:string};
      if(role!=='openclaw'||(!targets&&(!selected.gatewayUrl||url.origin!==new URL(selected.gatewayUrl).origin))||url.pathname!=='/v1/responses'||url.search||url.hash||url.username||url.password||init.method!=='POST'||!active.size||recovery)refuse('FOREIGN_RUNTIME_REQUEST_REFUSED');
      let body;try{body=JSON.parse(String(init.body));}catch{refuse('INVALID_OPERATOR_REQUEST_BODY');}
      const matches:ActiveWork[]=[];
      for(const state of active.values()){
        const target=targets?.get(state.workId);
        if(targets&&(!target||target.gatewayUrl!==url.origin||new Headers(init.headers).get('authorization')!==`Bearer ${target.gatewayToken}`))continue;
        const journal=await runs.load(state.workId);
        if(!state.settled&&!state.failed&&journal&&journal.workId===state.workId&&!journal.completed&&body.model===`openclaw/${target?.agentId??selected.agentId}`
          &&JSON.stringify(body.input)===JSON.stringify(journal.input.map(item=>item.type===undefined&&typeof item.role==='string'?{type:'message',...item}:item)))matches.push(state);
      }
      if(matches.length!==1)refuse(matches.length?'AMBIGUOUS_OPENCLAW_NATIVE_WORK':'EXACT_OPENCLAW_JOURNAL_REQUIRED');
      const state=matches[0];
      if(!state.nativeBinding){state.deadline=targets?.get(state.workId)?.deadlineUnixMs??Date.now()+120000;state.nativeBinding=beforeNativeSubmit({workId:state.workId,sessionId:'openclaw:'+state.workId,deadlineUnixMs:state.deadline},signal);}
      await state.nativeBinding;if(!state.deadline||Date.now()>=state.deadline)refuse('NATIVE_DEADLINE_EXPIRED');
      if(targets)return targets.dispatch(state.workId,input,{...init,signal:AbortSignal.any([signal,...(init.signal?[init.signal]:[])])},upstream);
      return upstream(input,{...init,redirect:'error',signal:AbortSignal.any([signal,...(init.signal?[init.signal]:[]),AbortSignal.timeout(Math.max(1,state.deadline-Date.now()))])});
    }
    let body:Record<string,any>|undefined;if(typeof init.body==='string'){try{body=JSON.parse(init.body);}catch{refuse('INVALID_OPERATOR_REQUEST_BODY');}}
    const claim=init.method==='POST'&&url.pathname==='/api/agent/work/claim';
    if(claim&&(!active.size||claimIndex>=claims.length))refuse('EXPLICIT_WORK_STEP_REQUIRED');
    const route=url.pathname.match(/^\/api\/agent\/work\/([^/]+)\/(acknowledge|renew|session(?:\/end)?|complete|fail)$/),routed=route&&active.get(decodeURIComponent(route[1]));if(route&&!routed)refuse('UNBOUND_WORK_ROUTE');
    const isSettlementProbe=!!(preNativeControl&&settlementProbe&&routed?.controlDrained&&route?.[2]==='complete'&&routed.workId===settlementProbe.workId&&body?.leaseToken===settlementProbe.leaseToken&&Object.keys(body).length===1);
    if(preNativeControl&&route?.[2]==='complete'&&!isSettlementProbe)refuse('PRE_NATIVE_CONTROL_FORBIDS_PROCESSING');
    let scoped:ActiveWork|undefined;
    if(url.pathname==='/mcp'){if(!body||!['initialize','notifications/initialized','ping','tools/list','tools/call'].includes(body.method)||body.method==='tools/call'&&(typeof body.params?.name!=='string'||!body.params.name))refuse('INVALID_SCOPED_OPERATOR_REQUEST');scoped=workForToken(init);}
    const tool=scoped&&body?.method==='tools/call'?body.params?.name:undefined;
    if(tool==='envoi_case_snapshot'&&options.beforeFirstScopedSnapshot){
      const state=scoped!,bounded=AbortSignal.any([signal,...(init.signal?[init.signal]:[])]);
      if(!state.firstSnapshotGate){const facts=scopedFacts(state.workId);state.firstSnapshotGate=guardNativeSubmission(async()=>options.beforeFirstScopedSnapshot!(facts,bounded),{workId:state.workId,sessionId:'pre-snapshot-only',deadlineUnixMs:0},bounded);void state.firstSnapshotGate.catch(()=>{});}
      await state.firstSnapshotGate;bounded.throwIfAborted();ensure();
    }
    if(tool){
      if(recovery){if(!['envoi_case_snapshot','envoi_case_list_assets'].includes(tool))refuse('RECOVERY_MUST_NOT_EXECUTE_TOOLS');}
      else if(preNativeControl){if(!['envoi_case_snapshot','envoi_case_list_assets'].includes(tool))refuse('PRE_NATIVE_CONTROL_EXPECTED_DENIAL_CHANNEL_REQUIRED');}
      else(controller.assertScopedTool as(role:Role,name:string,workId?:string)=>void)(role,tool,scoped!.workId);
      if(!['envoi_case_snapshot','envoi_case_list_assets'].includes(tool))await options.reserveOperation({kind:'tool',tool,caseId:scoped!.caseId,workId:scoped!.workId});
    }else if(init.method==='POST'&&/^\/api\/inboxes\/[^/]+\/messages$/.test(url.pathname))await options.reserveOperation({kind:'message',caseId:body?.caseId});
    const response=await upstream(input,{...init,redirect:'error'});
    if(claim&&response.ok){const raw=await response.clone().text(),work=JSON.parse(raw).work;
      if(work){const expected=active.get(claims[claimIndex]);if(!expected||work.workId!==expected.workId||work.message?.id!==expected.workId||work.message?.caseId!==expected.caseId||work.message?.recipientAgentId!==options.expected.agentId)refuse('CANONICAL_WORK_GRAPH_MISMATCH');claimIndex++;expected.leaseExpiresAt=work.leaseExpiresAt;expected.leaseToken=work.leaseToken;expected.workSafe=Object.freeze(redactControl(work));expected.claimRedactedBytes=JSON.stringify(redactControl(JSON.parse(raw)));
        if(preNativeControl){controller.observePreNativeControlClaim(preNativeControl.controlId,role,work);expected.controlCapture={work:Object.freeze(redactControl(work)),claimRedactedBytes:JSON.stringify(redactControl(JSON.parse(raw)))};}
        else if(recovery){if(work.workId!==recovery.workId||work.message?.caseId!==recovery.caseId)refuse('RETAINED_RECOVERY_WORK_MISMATCH');}else controller.observeClaim(expected.flowId,role,work,raw);
      }
    }
    if(route?.[2]==='session'&&response.ok){const p=await response.clone().json(),session=p.session;
      if(!session||session.workId!==routed!.workId||session.caseId!==routed!.caseId||session.agentId!==options.expected.agentId||session.installationId!==options.expected.installationId||typeof session.token!=='string')refuse('SCOPED_TOKEN_WORK_BINDING_MISMATCH');
      const token='Bearer '+session.token,prior=issuedTokens.get(token);if(prior&&prior!==routed!.workId)refuse('SCOPED_TOKEN_WORK_BINDING_MISMATCH');issuedTokens.set(token,routed!.workId);scopedTokens.set(token,routed!.workId);
      routed!.sessionSafe=Object.freeze(redactControl(session));
      routed!.sessionRedactedBytes=JSON.stringify(redactControl(p));
      if(preNativeControl){const capture=routed!.controlCapture;if(!capture||typeof session.id!=='string'||!Number.isSafeInteger(session.fence)||session.fence<1||!Number.isFinite(Date.parse(session.expiresAt)))refuse('ACTUAL_CONTROL_SCOPE_REQUIRED');if(!capture.entered){capture.session=Object.freeze(redactControl(session));capture.sessionRedactedBytes=JSON.stringify(redactControl(p));capture.authorization=token;}}
      if(typeof session.id!=='string'||!Number.isSafeInteger(session.fence)||session.fence<1||!Number.isFinite(Date.parse(session.expiresAt)))refuse('SCOPED_TOKEN_WORK_BINDING_MISMATCH');routed!.caseSession={id:session.id,fence:session.fence,expiresAt:session.expiresAt,toolChannelSha256:hash(JSON.stringify([controller.ledger.window,routed!.workId,routed!.caseId,session.id,session.fence,session.token,session.transport]))};
    }
    if(route?.[2]==='renew'&&response.ok){const renewal=await response.clone().json();if(renewal.workId!==routed!.workId||renewal.leaseToken!==routed!.leaseToken||!Number.isFinite(Date.parse(renewal.leaseExpiresAt))||Date.parse(renewal.leaseExpiresAt)<=Date.now())refuse('ACTUAL_CONTROL_LEASE_REQUIRED');routed!.leaseExpiresAt=renewal.leaseExpiresAt;}
    if(route?.[2]==='session/end'&&response.ok){routed!.sessionEndRawBytes=await response.clone().text();for(const[token,id]of scopedTokens)if(id===routed!.workId)scopedTokens.delete(token);}
    if(tool&&response.ok){const e=await readEnvelope(response);if(e?.ok===true&&tool==='envoi_request_human'&&e.result?.endTurn===true)scoped!.humanEnd=true;
      if(preNativeControl&&tool==='envoi_case_snapshot'&&e?.ok===true){const capture=scoped!.controlCapture,protocolVersion=new Headers(init.headers).get('mcp-protocol-version');if(!capture?.session||!protocolVersion||!/^\d{4}-\d{2}-\d{2}$/.test(protocolVersion))refuse('ACTUAL_CONTROL_SCOPE_REQUIRED');if(!capture.entered){capture.snapshot=e.result;capture.snapshotRawBytes=await response.clone().text();capture.protocolVersion=protocolVersion;}}}
    if(isSettlementProbe&&response.ok)controller.stop('STALE_CONTROL_SETTLEMENT_UNEXPECTEDLY_SUCCEEDED');
    if(!isSettlementProbe&&route&&response.ok&&['complete','fail'].includes(route[2])){const p=await response.clone().json(),state=routed!;
      if(preNativeControl&&route[2]==='fail'&&state.controlCapture){const{leaseToken:_privateLease,...safeBody}=body??{};state.controlCapture.failureRequestRedactedBytes=JSON.stringify(redactControl(safeBody));state.controlCapture.failureResponseRawBytes=await response.clone().text();}
      if(route[2]==='complete'&&p.workId===state.workId&&p.status==='processed'){state.settled=true;state.completeRawBytes=await response.clone().text();
        if(options.observeNativeEnd){if(!state.sessionEndRawBytes||!state.completedJournalHash)refuse('ACTUAL_NATIVE_END_REQUIRED');const facts=await nativeFacts(state.workId);if(hash(facts.journalRawBytes)!==state.completedJournalHash)refuse('NATIVE_COMPLETION_JOURNAL_CHANGED');await options.observeNativeEnd(Object.freeze({...facts,sessionEndRawBytes:state.sessionEndRawBytes,completeRawBytes:state.completeRawBytes}));}}
      if(recovery&&route[2]==='fail'&&p.workId===state.workId&&body?.retryable===false&&p.status==='failed')state.failed=true;
      await options.record({kind:'canonical_settlement',role,workId:state.workId,status:p.status,operation:route[2]});
    }
    return response;
  };
  const closeCompletedForwarding=async(input:Parameters<typeof fetch>[0],init:RequestInit={})=>{
    const url=new URL(input instanceof Request?input.url:String(input));if(url.origin!==origin||init.method!=='POST')return;
    const end=url.pathname.match(/^\/api\/agent\/work\/([^/]+)\/session\/end$/);if(!end||recovery)return;
    const state=active.get(decodeURIComponent(end[1]));if(!state||state.held)return;
    let bytes:Buffer;try{bytes=await fs.readFile(path.join(options.stateDir,'scoped-runs',state.workId+'.json'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
    if(bytes.length>1000000)refuse('BOUNDED_NATIVE_COMPLETION_PROOF_REQUIRED');
    const journal=JSON.parse(bytes.toString('utf8'));if(journal.workId!==state.workId)refuse('EXACT_NATIVE_COMPLETION_PROOF_REQUIRED');
    if(journal.completed!==true)return;if(journal.pending?.length)refuse('ACTUAL_NATIVE_COMPLETION_REQUIRED');
    const digest=hash(bytes);if(state.completedJournalHash&&state.completedJournalHash!==digest)refuse('NATIVE_COMPLETION_JOURNAL_CHANGED');
    controller.closeNativeForwarding(state.flowId,{workId:state.workId,journalCompleted:true,journalSha256:digest});targets?.close(state.workId);state.completedJournalHash=digest;
  };
  // Fence provider forwarding before the outer observer performs its pre-end
  // scope/idempotency probes, even while another work's request is pending.
  const fetcher:typeof fetch=async(input,init)=>{await closeCompletedForwarding(input,init);return options.observeTransport?options.observeTransport(input,init,direct):direct(input,init);};
  try{
    const adapter=adapterFor(runtime),context={apiUrl:origin,stateDir:options.stateDir,env:options.env,signal,fetch:fetcher,
      nativeRequestGate:options.nativeGate,beforeNativeSubmit,
      ...(targets?{openClawTargetResolver:(workId:string,bounded:AbortSignal)=>targets.resolve(workId,bounded),openClawTargetSelection:options.openClawTargetSelection}:{}),
      beforeScopedTurn:async(workId:string,scopedSignal:AbortSignal)=>{const state=active.get(workId);if(!state)refuse('EXPLICIT_WORK_STEP_REQUIRED');if(preNativeControl){
        const c=preNativeControl,capture=state.controlCapture;
        if(!controlConsumer||!capture?.session||!capture.sessionRedactedBytes||!capture.snapshotRawBytes||!capture.authorization||!capture.protocolVersion||!state.caseSession||capture.entered)refuse('ACTUAL_CONTROL_SCOPE_REQUIRED');capture.entered=true;
        const originalScope=Object.freeze({...capture,session:Object.freeze({...capture.session,allowedTools:Object.freeze([...(capture.session.allowedTools as string[])])}),toolChannelSha256:state.caseSession.toolChannelSha256});
        let expectedDenial:string|undefined,denialForwarded=false;
        const channel=Object.freeze({
          registerExpectedDenial:(body:string,sha256:string)=>{ensure();scopedSignal.throwIfAborted();if(c.mode!=='authority-expiry'||expectedDenial||hash(body)!==sha256)refuse('EXACT_EXPECTED_DENIAL_REQUEST_REQUIRED');let request;try{request=JSON.parse(body);}catch{refuse('EXACT_EXPECTED_DENIAL_REQUEST_REQUIRED');}if(request?.method!=='tools/call'||request.params?.name!=='envoi_case_decide'||!request.params?.arguments||typeof request.id!=='string')refuse('EXACT_EXPECTED_DENIAL_REQUEST_REQUIRED');expectedDenial=body;},
          forward:async(body:string)=>{ensure();if(preNativeControl!==c||!active.has(workId))refuse('CONTROL_CHANNEL_CLOSED');let request;try{request=JSON.parse(body);}catch{refuse('INVALID_SCOPED_OPERATOR_REQUEST');}
            const args=request?.params?.arguments,forbidden=['caseId','workId','inboxId','agentId','senderAgentId','senderInboxId','recipientAddress','recipientAgentId','recipientInboxId','recipientEmail','counterpartyAddress','sessionId'];
            if(Buffer.byteLength(body)>1000000||request?.jsonrpc!=='2.0'||!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>forbidden.includes(key))||!originalScope.session.allowedTools.includes(request.params?.name))refuse('INVALID_SCOPED_OPERATOR_REQUEST');
            const read=request?.method==='tools/call'&&['envoi_case_snapshot','envoi_case_list_assets'].includes(request.params?.name);
            if(!read)scopedSignal.throwIfAborted();
            if(!read&&(body!==expectedDenial||denialForwarded))refuse('EXACT_EXPECTED_DENIAL_REQUEST_REQUIRED');
            if(!read)denialForwarded=true;
            const url=origin+'/mcp',init:RequestInit={method:'POST',headers:{authorization:originalScope.authorization!,'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':originalScope.protocolVersion!},body,credentials:'omit',redirect:'error',signal:AbortSignal.any([signal,...(!read?[scopedSignal]:[]),AbortSignal.timeout(30000)])};let forwarded=false;
            const exactForward:typeof fetch=async(input,nextInit)=>{ensure();if(!read)scopedSignal.throwIfAborted();if(forwarded||String(input)!==url||nextInit?.method!=='POST'||nextInit.body!==body||new Headers(nextInit.headers).get('authorization')!==originalScope.authorization)refuse('EXACT_CONTROL_DISPATCH_REQUIRED');forwarded=true;
              if(!read)await options.reserveOperation({kind:'tool',tool:'envoi_case_decide',caseId:state.caseId,workId});
              return upstream(url,init);};
            const response=await(options.observeTransport?options.observeTransport(url,init,exactForward):exactForward(url,init));
            if(!read&&response.ok){const envelope=await readEnvelope(response);if(envelope?.ok===true){controller.stop('EXPECTED_DENIAL_UNEXPECTEDLY_SUCCEEDED');refuse('EXPECTED_DENIAL_UNEXPECTEDLY_SUCCEEDED');}}
            return response;}
        });
        await controlConsumer(Object.freeze({control:c,window:controller.ledger.window,clientSource:controller.receipt.clientSource,serverSource:controller.receipt.serverSource,work:originalScope.work,session:originalScope.session,toolChannelSha256:originalScope.toolChannelSha256,claimRedactedBytes:originalScope.claimRedactedBytes,sessionRedactedBytes:originalScope.sessionRedactedBytes!,snapshot:originalScope.snapshot,snapshotRawBytes:originalScope.snapshotRawBytes!,channel,
          leaseExpiresAt:()=>{ensure();if(preNativeControl!==c||!state.leaseExpiresAt)refuse('ACTUAL_CONTROL_LEASE_REQUIRED');return state.leaseExpiresAt;},
          probeLateSettlement:async(expected:'paused'|'revoked'|'expired')=>{ensure();if(preNativeControl!==c||!state.controlDrained||!state.leaseToken||!state.leaseExpiresAt||settlementProbe
            ||!(c.mode==='pause'&&['paused','expired'].includes(expected)||c.mode==='expiry'&&expected==='expired'||c.mode==='revoke'&&expected==='revoked'))refuse('EXACT_STALE_CONTROL_PROBE_REQUIRED');
            const marker={workId,leaseToken:state.leaseToken};settlementProbe=marker;
            try{const connector=bridge!.connector as unknown as {probeStaleControlSettlementOnce(input:{workId:string;leaseToken:string;leaseExpiresAt:string;expected:'paused'|'revoked'|'expired'},options:{signal:AbortSignal}):Promise<{status:{status:number;raw:string};settlement:{status:number;raw:string}}>};
              if(typeof connector.probeStaleControlSettlementOnce!=='function')refuse('SUPPORTED_STALE_CONTROL_PROBE_REQUIRED');
              return await connector.probeStaleControlSettlementOnce({workId,leaseToken:state.leaseToken,leaseExpiresAt:state.leaseExpiresAt,expected},{signal});
            }finally{if(settlementProbe===marker)settlementProbe=undefined;}}
        }),scopedSignal);
        refuse('CONTROL_CHECKPOINT_MUST_NOT_START_NATIVE');
      }if(state.held){if(!options.beforeScopedControl)refuse('DECLARED_CONTROL_CHECKPOINT_REQUIRED');await options.beforeScopedControl(workId,scopedSignal);refuse('CONTROL_CHECKPOINT_MUST_NOT_START_NATIVE');}}};
    let config;
    if(ownedNative?.factory){
      const factorySignal=AbortSignal.any([signal,AbortSignal.timeout(Math.max(1,Math.min(30000,Date.parse(controller.receipt.hardStopUtc)-Date.now())))]);
      await boundedPreparation(()=>assertOwnedOpenClawFactory(ownedNative.factory!,{clientSource:controller.receipt.clientSource,nativeSourceSha256:ownedNative.nativeSourceSha256,factoryPolicySha256:ownedNative.factoryPolicySha256},factorySignal),factorySignal);factorySignal.throwIfAborted();ensure();
      // Exact source-prepared factory is the startup authority here. The stopped
      // historical gateway is not this per-work runtime. createBridge still
      // validates the saved configuration/scoped mode and uses ONE enrollment.
      config=saved.configuration;await options.record({kind:'owned_native_factory_ready',nativeGatewayStarted:false,modelPromptsSubmitted:0,factoryPolicySha256:ownedNative.factoryPolicySha256});
    }else{config=await adapter.discover(context,saved.configuration);if(!adapter.startupCheck)refuse('READONLY_STARTUP_CHECK_REQUIRED');await adapter.startupCheck(config,context);}
    bridge=await adapter.createBridge(config,context);await bridge.connector.start();await bridge.connector.checkStatus();
    const send=createHostTaskSender(options.stateDir,saved,()=>{ensure();return bridge!.connector;});
    control=await startControl(options.stateDir,saved,()=>local.abort(),()=>({status:'running',runtimeChecks:'passed',receiving:'explicit-reviewed-step'}),async value=>{ensure();if(!options.allowedNewSends.some(v=>JSON.stringify(v)===JSON.stringify(value)))throw new HostTaskError('TASK_INVALID');return send(value);});
    await options.record({kind:'existing_receiver_ready',role,address:saved.address,receivingStarted:false,newEnrollment:false});
    const open=(flows:readonly ContinuationWork[])=>{
      ensure();if(active.size||recovery)refuse('ONE_EXPLICIT_NATIVE_FLOW_REQUIRED');
      if(!Array.isArray(flows)||!flows.length||flows.length>2||new Set(flows.map(f=>f.workId)).size!==flows.length||new Set(flows.map(f=>f.caseId)).size!==flows.length||new Set(flows.map(f=>f.flowId)).size!==flows.length)refuse('EXACT_DISTINCT_NATIVE_WORK_REQUIRED');
      const ledger=controller.ledger as unknown as {reviewedPlan?:unknown;flows?:readonly {role:string}[]};
      if(role==='openclaw'&&!ownedNative&&(flows.length>1||ledger.reviewedPlan&&(ledger.flows?.filter(f=>f.role==='openclaw').length??0)>1))refuse('SAME_ROLE_NATIVE_ATTRIBUTION_REQUIRED');
      for(const f of flows)if(!/^msg_[A-Za-z0-9_-]+$/.test(f.workId)||!/^case_[A-Za-z0-9_-]+$/.test(f.caseId)||!/^[a-f0-9]{64}$/.test(f.evidenceSha256))refuse('EXACT_DISTINCT_NATIVE_WORK_REQUIRED');
      for(const f of flows)controller.expectWork(f.flowId,f.workId,f.evidenceSha256);
      for(const f of flows)active.set(f.workId,{...f,humanEnd:false,settled:false,failed:false});claims=flows.map(f=>f.workId);claimIndex=0;
    };
    const proof=async(state:ActiveWork)=>{
      if(!state.settled)refuse('ACTUAL_WORK_SETTLEMENT_REQUIRED');
      const bytes=await fs.readFile(path.join(options.stateDir,'scoped-runs',state.workId+'.json')),journal=JSON.parse(bytes.toString('utf8'));
      if(journal.workId!==state.workId||journal.completed!==true||journal.pending?.length)refuse('ACTUAL_NATIVE_COMPLETION_REQUIRED');
      const digest=hash(bytes);if(!state.completedJournalHash||state.completedJournalHash!==digest)refuse('NATIVE_COMPLETION_JOURNAL_CHANGED');
      const result={workId:state.workId,canonicalStatus:'processed' as const,journalCompleted:true as const,journalSha256:digest,nativeOutcome:state.humanEnd?'ended_for_human' as const:'completed' as const};
      if(state.beforeIds){const after=await bridge!.connector.listCaseMessages(state.caseId),record=await bridge!.connector.getCase(state.caseId),expectedState=policy(state.flowId).expectedCaseState??'inProgress';
        if(after.length>=50||after.some(m=>!state.beforeIds!.has(m.id))||new Set(after.map(m=>m.id)).size!==state.beforeIds.size||record.state!==expectedState)refuse('NO_ACTION_RESUMPTION_CHANGED_CASE');
        return{...result,caseState:expectedState,...(expectedState==='inProgress'?{caseStillOpen:true as const}:{}),newCanonicalEffects:0 as const,...(policy(state.flowId).decisionOutcome==='declined'?{decisionOutcome:'declined' as const}:{})};}
      return result;
    };
    const runMany=async(flows:readonly ContinuationWork[])=>{
      open(flows);
      try{
        for(const state of active.values())if(policy(state.flowId).noAction){const messages=await bridge!.connector.listCaseMessages(state.caseId);if(messages.length>=50)refuse('BOUNDED_CASE_INVENTORY_REQUIRED');state.beforeIds=new Set(messages.map(m=>m.id));}
        if(flows.length===1){if(!await bridge!.connector.scopedWakeWorkDriver().processWorkOnce(signal))refuse('ACTUAL_WORK_SETTLEMENT_REQUIRED');return[await proof(active.get(flows[0].workId)!)];}
        const outcomes=await bridge!.connector.scopedWakeWorkDriver().processWorkBatch(flows.map(f=>({workId:f.workId,caseId:f.caseId})),signal);
        if(outcomes.length!==flows.length)refuse('EXACT_BATCH_OUTCOMES_REQUIRED');
        const results:Awaited<ReturnType<typeof proof>>[]=[],errors:unknown[]=[];
        for(let index=0;index<outcomes.length;index++){
          const outcome=outcomes[index],expected=flows[index];if(outcome.workId!==expected.workId||outcome.caseId!==expected.caseId)refuse('EXACT_BATCH_OUTCOMES_REQUIRED');
          if(outcome.status==='rejected'){errors.push(outcome.error);continue;}
          try{if(!outcome.worked)refuse('ACTUAL_WORK_SETTLEMENT_REQUIRED');results.push(await proof(active.get(expected.workId)!));}catch(error){errors.push(error);}
        }
        if(errors.length)throw Object.assign(new AggregateError(errors,'Explicit native batch did not complete every work'),{code:'EXPLICIT_NATIVE_BATCH_INCOMPLETE',completedWorkIds:results.map(r=>r.workId)});return results;
      }finally{for(const f of flows)forget(f.workId);claims=[];claimIndex=0;}
    };
    const runOne=async(flowId:string,workId:string,caseId:string,evidenceSha256:string)=>(await runMany([{flowId,workId,caseId,evidenceSha256}]))[0];
    const startPreNativeControl=async(input:PreNativeControl,consume=false)=>{
      ensure();if(active.size||recovery||preNativeControl||input.role!==role||consume&&!options.beforeTrustedScopedControl)refuse('EXACT_PRE_NATIVE_CONTROL_REQUIRED');
      const filename=path.join(options.stateDir,'scoped-runs',input.workId+'.json');
      const noJournal=async()=>{try{await fs.stat(filename);refuse('CONTROL_MUST_PRECEDE_NATIVE_JOURNAL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}};
      await noJournal();controller.beginPreNativeControl(input);preNativeControl=Object.freeze({...input});const baseline=controller.ledger.snapshot().chargedAttempts;
      const state:ActiveWork={...input,flowId:'pre-native-control:'+input.controlId,humanEnd:false,settled:false,failed:false,held:true,workStop:new AbortController()};active.set(input.workId,state);claims=[input.workId];claimIndex=0;
      let readyResolve!:(context:TrustedScopedControlContext)=>void,readyReject!:(error:unknown)=>void;
      const ready=new Promise<TrustedScopedControlContext>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});void ready.catch(()=>{});
      controlConsumer=async(context,bounded)=>{readyResolve(context);if(consume)return options.beforeTrustedScopedControl!(context,bounded);bounded.throwIfAborted();return new Promise<never>((_,reject)=>bounded.addEventListener('abort',()=>reject(bounded.reason),{once:true}));};
      const finished=(async()=>{try{
        let errorCode:string|undefined;try{await bridge!.connector.scopedWakeWorkDriver().processWorkOnce(AbortSignal.any([signal,state.workStop!.signal]));}catch(error){errorCode=String((error as {code?:string}).code??'CONTROLLED_PRE_NATIVE_STOP');}
        await noJournal();if(!state.controlCapture?.entered||state.settled)refuse('ACTUAL_CONTROL_SCOPE_REQUIRED');
        state.controlDrained=true;
        // This is only execution/capture evidence. The caller still has to prove
        // denial, ended scope, retryable settlement and canonical reoffer.
        return Object.freeze({controlId:input.controlId,workId:input.workId,caseId:input.caseId,status:'stopped_before_native' as const,errorCode,claimRedactedSha256:hash(state.controlCapture.claimRedactedBytes),sessionRedactedSha256:hash(state.controlCapture.sessionRedactedBytes!),snapshotSha256:hash(state.controlCapture.snapshotRawBytes!),modelPrompts:0 as const,journalAbsent:true as const,modelChargedAttemptsBefore:baseline,modelChargedAttemptsAfter:controller.ledger.snapshot().chargedAttempts,sessionEndRawBytes:state.sessionEndRawBytes,failureRequestRedactedBytes:state.controlCapture.failureRequestRedactedBytes,failureResponseRawBytes:state.controlCapture.failureResponseRawBytes});
      }catch(error){readyReject(error);throw error;}})();void finished.catch(()=>{});
      let closing:Promise<unknown>|undefined;
      return Object.freeze({ready,finished,cancel:()=>state.workStop!.abort(new Error('CONTROLLED_PRE_NATIVE_STOP')),
        close:()=>closing??=(async()=>{state.workStop!.abort(new Error('CONTROLLED_PRE_NATIVE_STOP'));try{return await finished;}finally{forget(input.workId);claims=[];claimIndex=0;preNativeControl=undefined;controlConsumer=undefined;if(controller.active())controller.endPreNativeControl(input.controlId);}})()});
    };
    const runPreNativeControl=async(input:PreNativeControl)=>{const handle=await startPreNativeControl(input,true);try{return await handle.finished;}finally{await handle.close();}};
    const runHeldControl=async(flowId:string,workId:string,caseId:string,evidenceSha256:string)=>{
      if(!options.beforeScopedControl||!options.verifyHeldControl)refuse('DECLARED_CONTROL_CHECKPOINT_REQUIRED');open([{flowId,workId,caseId,evidenceSha256}]);const state=active.get(workId)!;state.held=true;state.workStop=new AbortController();
      try{
        const filename=path.join(options.stateDir,'scoped-runs',workId+'.json');try{await fs.stat(filename);refuse('CONTROL_MUST_PRECEDE_NATIVE_JOURNAL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
        const baseline=controller.ledger.snapshot().chargedAttempts;
        try{await bridge!.connector.scopedWakeWorkDriver().processWorkOnce(AbortSignal.any([signal,state.workStop.signal]));}catch{/* Actual controls below must prove the outcome. */}
        const p=await options.verifyHeldControl(workId);if(p.lateScopeDenied!==true||p.lateSettlementDenied!==true||p.heldWorkResumable!==true||!/^[a-f0-9]{64}$/.test(p.evidenceSha256)||controller.ledger.snapshot().chargedAttempts!==baseline)refuse('CONTROL_CHECKPOINT_UNVERIFIED');
        try{await fs.stat(filename);refuse('CONTROL_CREATED_NATIVE_JOURNAL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
        await options.record({kind:'pre_native_control_verified',role,workId,evidenceSha256:p.evidenceSha256,nativePrompts:0});
      }finally{forget(workId);claims=[];claimIndex=0;}
    };
    const recoverRetainedFailure=async(expected:{workId:string;caseId:string;journalSha256:string})=>{
      ensure();if(active.size||recovery)refuse('ONE_EXPLICIT_NATIVE_FLOW_REQUIRED');if(!/^msg_[A-Za-z0-9_-]+$/.test(expected.workId)||hash(await fs.readFile(path.join(options.stateDir,'scoped-runs',expected.workId+'.json')))!==expected.journalSha256)refuse('RETAINED_JOURNAL_CHANGED');
      recovery=expected;const state:ActiveWork={...expected,flowId:'retained-terminal-failure',evidenceSha256:expected.journalSha256,humanEnd:false,settled:false,failed:false};active.set(expected.workId,state);claims=[expected.workId];claimIndex=0;
      try{let failure:unknown;try{await bridge!.connector.scopedWakeWorkDriver().processWorkOnce(signal);}catch(error){failure=error;}
        if(!state.failed||hash(await fs.readFile(path.join(options.stateDir,'scoped-runs',expected.workId+'.json')))!==expected.journalSha256)throw failure??new Error('RETAINED_FAILURE_RECOVERY_UNVERIFIED');await options.record({kind:'retained_terminal_failed_without_reprompt',role,workId:expected.workId,journalUnchanged:true});
      }finally{forget(expected.workId);recovery=undefined;claims=[];claimIndex=0;}
    };
    return{runOne,runMany,runHeldControl,runPreNativeControl,startPreNativeControl,scopedFacts,nativeFacts,recoverRetainedFailure,connector:bridge.connector,
      cancelHeldWork:(workId?:string)=>{if(workId)active.get(workId)?.workStop?.abort();else{if(active.size>1)refuse('EXACT_HELD_WORK_REQUIRED');for(const state of active.values())state.workStop?.abort();}},
      async awaitMeterIdle(){while(controller.ledger.snapshot().pending){ensure();await delay(20,undefined,{signal});}},
      async close(){local.abort();targets?.closeAll();await control?.close();await bridge?.close();active.clear();scopedTokens.clear();issuedTokens.clear();await unlock();}};
  }catch(error){local.abort();targets?.closeAll();await control?.close();await bridge?.close();await unlock();throw error;}
}
