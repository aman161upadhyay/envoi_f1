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
import { ContinuationController } from './continuation-controller';
import type {ContinuationFlowPolicy} from './continuation-plan';

type Role='je1'|'je2'|'testowner'|'openclaw';
export type ContinuationWork=Readonly<{flowId:string;workId:string;caseId:string;evidenceSha256:string}>;
type ActiveWork=ContinuationWork & {humanEnd:boolean;settled:boolean;failed:boolean;deadline?:number;nativeBinding?:Promise<void>;held?:boolean;workStop?:AbortController;beforeIds?:Set<unknown>;completedJournalHash?:string};
type FlowPolicy=ContinuationFlowPolicy;
const hash=(x:string|Buffer)=>createHash('sha256').update(x).digest('hex');
function refuse(code:string):never{throw Object.assign(new Error(code),{code});}
const readEnvelope=async(response:Response)=>{const p=await response.clone().json();return p.result?.content?.[0]?.text?JSON.parse(p.result.content[0].text):null;};

/** One enrollment/control listener; bounded explicit work, never automatic parallelism. */
export async function createContinuationReceiver(options:{
  controller:ContinuationController;role:Role;stateDir:string;env:NodeJS.ProcessEnv;meterToken:string;nativeGate?:NativeRequestGateExpectation;
  expected:{address:string;agentId:string;inboxId:string;installationId:string};
  allowedNewSends:readonly HostTaskRequest[];
  reserveOperation(input:{kind:'message'|'tool';caseId?:string;tool?:string;workId?:string}):Promise<void>;
  observeTransport?(input:Parameters<typeof fetch>[0],init:Parameters<typeof fetch>[1],next:typeof fetch):Promise<Response>;
  beforeScopedControl?(workId:string,signal:AbortSignal):Promise<never>;
  verifyHeldControl?(workId:string):Promise<{lateScopeDenied:true;lateSettlementDenied:true;heldWorkResumable:true;evidenceSha256:string}>;
  record(event:Readonly<Record<string,unknown>>):Promise<void>;fetch?:typeof fetch;
}) {
  const {controller,role}=options,origin=controller.receipt.serverSource&&'https://sinaloa-staging.rachelgonsalves821.workers.dev';
  if(!controller.active())refuse('CONTINUATION_WINDOW_CLOSED');
  const saved=await readConnection(options.stateDir),runtime=role==='openclaw'?'openclaw':'hermes';
  if(saved.apiUrl!==origin||saved.runtime!==runtime||saved.address!==options.expected.address
    ||saved.activationSetup?.agentId!==options.expected.agentId||saved.activationSetup?.inboxId!==options.expected.inboxId
    ||saved.activationSetup?.installationId!==options.expected.installationId)refuse('EXISTING_ENROLLMENT_BINDING_MISMATCH');
  if(runtime==='hermes'&&(!options.nativeGate||options.nativeGate.role!==role||options.nativeGate.meterToken!==options.meterToken
    ||options.nativeGate.window!==controller.ledger.window||options.env.ENVOI_HERMES_GATE_REQUIRED!=='1'))refuse('REQUIRED_NATIVE_GATE_EXPECTATION_MISSING');
  const unlock=await acquireConnectorLock(options.stateDir),local=new AbortController();
  const signal=AbortSignal.any([local.signal,controller.control.signal]);let bridge:RuntimeBridge|undefined,control:Awaited<ReturnType<typeof startControl>>|undefined;
  const runs=new FileScopedRunStore(options.stateDir),upstream=options.fetch??fetch;
  const active=new Map<string,ActiveWork>(),scopedTokens=new Map<string,string>(),issuedTokens=new Map<string,string>();
  let claims:string[]=[],claimIndex=0,recovery:{workId:string;caseId:string;journalSha256:string}|undefined;
  const ensure=()=>{signal.throwIfAborted();if(!controller.active())refuse('CONTINUATION_WINDOW_CLOSED');};
  const policy=(flowId:string):FlowPolicy=>{
    const current=controller as unknown as {flowPolicy?:(id:string)=>FlowPolicy};
    return current.flowPolicy?current.flowPolicy.call(controller,flowId):{noAction:['declined-resume','private-receipt-review'].includes(flowId),decisionOutcome:flowId==='declined-resume'?'declined':null,allowHumanEnd:['accept-authority','asset-decline'].includes(flowId)};
  };
  const workForToken=(init:RequestInit):ActiveWork=>{const token=new Headers(init.headers).get('authorization'),workId=token&&scopedTokens.get(token),state=workId&&active.get(workId);if(!state||state.settled||state.failed)refuse('EXACT_SCOPED_WORK_TOKEN_REQUIRED');return state;};
  const forget=(workId:string)=>{active.delete(workId);for(const [token,id]of scopedTokens)if(id===workId)scopedTokens.delete(token);};
  const direct:typeof fetch=async(input,init={})=>{
    ensure();const url=new URL(input instanceof Request?input.url:String(input));
    if(url.origin!==origin){
      const selected=saved.configuration as {gatewayUrl?:string;agentId?:string};
      if(role!=='openclaw'||!selected.gatewayUrl||url.origin!==new URL(selected.gatewayUrl).origin||url.pathname!=='/v1/responses'||init.method!=='POST'||!active.size||recovery)refuse('FOREIGN_RUNTIME_REQUEST_REFUSED');
      let body;try{body=JSON.parse(String(init.body));}catch{refuse('INVALID_OPERATOR_REQUEST_BODY');}
      const matches:ActiveWork[]=[];
      for(const state of active.values()){
        const journal=await runs.load(state.workId);
        if(journal&&journal.workId===state.workId&&!journal.completed&&body.model===`openclaw/${selected.agentId}`
          &&JSON.stringify(body.input)===JSON.stringify(journal.input.map(item=>item.type===undefined&&typeof item.role==='string'?{type:'message',...item}:item)))matches.push(state);
      }
      if(matches.length!==1)refuse(matches.length?'AMBIGUOUS_OPENCLAW_NATIVE_WORK':'EXACT_OPENCLAW_JOURNAL_REQUIRED');
      const state=matches[0];
      if(!state.nativeBinding){state.deadline=Date.now()+120000;state.nativeBinding=controller.nativeGuard('openclaw',options.meterToken)({workId:state.workId,sessionId:'openclaw:'+state.workId,deadlineUnixMs:state.deadline},signal);}
      await state.nativeBinding;if(!state.deadline||Date.now()>=state.deadline)refuse('NATIVE_DEADLINE_EXPIRED');
      return upstream(input,{...init,redirect:'error',signal:AbortSignal.any([signal,...(init.signal?[init.signal]:[]),AbortSignal.timeout(Math.max(1,state.deadline-Date.now()))])});
    }
    let body:Record<string,any>|undefined;if(typeof init.body==='string'){try{body=JSON.parse(init.body);}catch{refuse('INVALID_OPERATOR_REQUEST_BODY');}}
    const claim=init.method==='POST'&&url.pathname==='/api/agent/work/claim';
    if(claim&&(!active.size||claimIndex>=claims.length))refuse('EXPLICIT_WORK_STEP_REQUIRED');
    const route=url.pathname.match(/^\/api\/agent\/work\/([^/]+)\/(acknowledge|renew|session(?:\/end)?|complete|fail)$/),routed=route&&active.get(decodeURIComponent(route[1]));if(route&&!routed)refuse('UNBOUND_WORK_ROUTE');
    let scoped:ActiveWork|undefined;
    if(url.pathname==='/mcp'){if(!body||!['initialize','notifications/initialized','ping','tools/list','tools/call'].includes(body.method)||body.method==='tools/call'&&(typeof body.params?.name!=='string'||!body.params.name))refuse('INVALID_SCOPED_OPERATOR_REQUEST');scoped=workForToken(init);}
    const tool=scoped&&body?.method==='tools/call'?body.params?.name:undefined;
    if(tool){
      if(recovery){if(!['envoi_case_snapshot','envoi_case_list_assets'].includes(tool))refuse('RECOVERY_MUST_NOT_EXECUTE_TOOLS');}
      else(controller.assertScopedTool as(role:Role,name:string,workId?:string)=>void)(role,tool,scoped!.workId);
      if(!['envoi_case_snapshot','envoi_case_list_assets'].includes(tool))await options.reserveOperation({kind:'tool',tool,caseId:scoped!.caseId,workId:scoped!.workId});
    }else if(init.method==='POST'&&/^\/api\/inboxes\/[^/]+\/messages$/.test(url.pathname))await options.reserveOperation({kind:'message',caseId:body?.caseId});
    const response=await upstream(input,{...init,redirect:'error'});
    if(claim&&response.ok){const raw=await response.clone().text(),work=JSON.parse(raw).work;
      if(work){const expected=active.get(claims[claimIndex]);if(!expected||work.workId!==expected.workId||work.message?.id!==expected.workId||work.message?.caseId!==expected.caseId||work.message?.recipientAgentId!==options.expected.agentId)refuse('CANONICAL_WORK_GRAPH_MISMATCH');claimIndex++;
        if(recovery){if(work.workId!==recovery.workId||work.message?.caseId!==recovery.caseId)refuse('RETAINED_RECOVERY_WORK_MISMATCH');}else controller.observeClaim(expected.flowId,role,work,raw);
      }
    }
    if(route?.[2]==='session'&&response.ok){const p=await response.clone().json(),session=p.session;
      if(!session||session.workId!==routed!.workId||session.caseId!==routed!.caseId||session.agentId!==options.expected.agentId||session.installationId!==options.expected.installationId||typeof session.token!=='string')refuse('SCOPED_TOKEN_WORK_BINDING_MISMATCH');
      const token='Bearer '+session.token,prior=issuedTokens.get(token);if(prior&&prior!==routed!.workId)refuse('SCOPED_TOKEN_WORK_BINDING_MISMATCH');issuedTokens.set(token,routed!.workId);scopedTokens.set(token,routed!.workId);
    }
    if(route?.[2]==='session/end'&&response.ok)for(const[token,id]of scopedTokens)if(id===routed!.workId)scopedTokens.delete(token);
    if(tool&&response.ok){const e=await readEnvelope(response);if(e?.ok===true&&tool==='envoi_request_human'&&e.result?.endTurn===true)scoped!.humanEnd=true;}
    if(route&&response.ok&&['complete','fail'].includes(route[2])){const p=await response.clone().json(),state=routed!;
      if(route[2]==='complete'&&p.workId===state.workId&&p.status==='processed')state.settled=true;
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
    controller.closeNativeForwarding(state.flowId,{workId:state.workId,journalCompleted:true,journalSha256:digest});state.completedJournalHash=digest;
  };
  // Fence provider forwarding before the outer observer performs its pre-end
  // scope/idempotency probes, even while another work's request is pending.
  const fetcher:typeof fetch=async(input,init)=>{await closeCompletedForwarding(input,init);return options.observeTransport?options.observeTransport(input,init,direct):direct(input,init);};
  try{
    const adapter=adapterFor(runtime),context={apiUrl:origin,stateDir:options.stateDir,env:options.env,signal,fetch:fetcher,
      nativeRequestGate:options.nativeGate,beforeNativeSubmit:controller.nativeGuard(role,options.meterToken),
      beforeScopedTurn:async(workId:string,scopedSignal:AbortSignal)=>{const state=active.get(workId);if(!state)refuse('EXPLICIT_WORK_STEP_REQUIRED');if(state.held){if(!options.beforeScopedControl)refuse('DECLARED_CONTROL_CHECKPOINT_REQUIRED');await options.beforeScopedControl(workId,scopedSignal);refuse('CONTROL_CHECKPOINT_MUST_NOT_START_NATIVE');}}};
    const config=await adapter.discover(context,saved.configuration);if(!adapter.startupCheck)refuse('READONLY_STARTUP_CHECK_REQUIRED');await adapter.startupCheck(config,context);
    bridge=await adapter.createBridge(config,context);await bridge.connector.start();await bridge.connector.checkStatus();
    const send=createHostTaskSender(options.stateDir,saved,()=>{ensure();return bridge!.connector;});
    control=await startControl(options.stateDir,saved,()=>local.abort(),()=>({status:'running',runtimeChecks:'passed',receiving:'explicit-reviewed-step'}),async value=>{ensure();if(!options.allowedNewSends.some(v=>JSON.stringify(v)===JSON.stringify(value)))throw new HostTaskError('TASK_INVALID');return send(value);});
    await options.record({kind:'existing_receiver_ready',role,address:saved.address,receivingStarted:false,newEnrollment:false});
    const open=(flows:readonly ContinuationWork[])=>{
      ensure();if(active.size||recovery)refuse('ONE_EXPLICIT_NATIVE_FLOW_REQUIRED');
      if(!Array.isArray(flows)||!flows.length||flows.length>2||new Set(flows.map(f=>f.workId)).size!==flows.length||new Set(flows.map(f=>f.caseId)).size!==flows.length||new Set(flows.map(f=>f.flowId)).size!==flows.length)refuse('EXACT_DISTINCT_NATIVE_WORK_REQUIRED');
      const ledger=controller.ledger as unknown as {reviewedPlan?:unknown;flows?:readonly {role:string}[]};
      if(role==='openclaw'&&(flows.length>1||ledger.reviewedPlan&&(ledger.flows?.filter(f=>f.role==='openclaw').length??0)>1))refuse('SAME_ROLE_NATIVE_ATTRIBUTION_REQUIRED');
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
    return{runOne,runMany,runHeldControl,recoverRetainedFailure,connector:bridge.connector,
      cancelHeldWork:(workId?:string)=>{if(workId)active.get(workId)?.workStop?.abort();else{if(active.size>1)refuse('EXACT_HELD_WORK_REQUIRED');for(const state of active.values())state.workStop?.abort();}},
      async awaitMeterIdle(){while(controller.ledger.snapshot().pending){ensure();await delay(20,undefined,{signal});}},
      async close(){local.abort();await control?.close();await bridge?.close();active.clear();scopedTokens.clear();issuedTokens.clear();await unlock();}};
  }catch(error){local.abort();await control?.close();await bridge?.close();await unlock();throw error;}
}
