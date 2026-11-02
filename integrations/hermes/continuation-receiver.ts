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

type Role='je1'|'je2'|'testowner'|'openclaw';
const hash=(x:string|Buffer)=>createHash('sha256').update(x).digest('hex');
function refuse(code:string):never{throw Object.assign(new Error(code),{code});}
const readEnvelope=async(response:Response)=>{const p=await response.clone().json();return p.result?.content?.[0]?.text?JSON.parse(p.result.content[0].text):null;};

/** Opens an already-enrolled helper/control listener; receiving is explicit one-work-at-a-time.
 * This never invokes setup, enrollment, claim approval or a human send confirmation.
 */
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
  let active:{flowId:string;workId:string;caseId:string;humanEnd:boolean;settled:boolean;failed:boolean;deadline?:number;ocBound?:boolean;held?:boolean;workStop?:AbortController}|undefined;
  let recovery:{workId:string;caseId:string;journalSha256:string}|undefined;
  const ensure=()=>{signal.throwIfAborted();if(!controller.active())refuse('CONTINUATION_WINDOW_CLOSED');};
  const direct:typeof fetch=async(input,init={})=>{
    ensure();const url=new URL(input instanceof Request?input.url:String(input));
    if(url.origin!==origin){
      // Only the exact selected OpenClaw Gateway may receive a native request.
      const selected=saved.configuration as {gatewayUrl?:string;agentId?:string};
      if(role!=='openclaw'||!selected.gatewayUrl||url.origin!==new URL(selected.gatewayUrl).origin||url.pathname!=='/v1/responses'||init.method!=='POST'||!active||recovery)refuse('FOREIGN_RUNTIME_REQUEST_REFUSED');
      const journal=await runs.load(active.workId),body=JSON.parse(String(init.body));
      if(!journal||journal.workId!==active.workId||journal.completed||body.model!==`openclaw/${selected.agentId}`
        ||JSON.stringify(body.input)!==JSON.stringify(journal.input.map(item=>item.type===undefined&&typeof item.role==='string'?{type:'message',...item}:item)))refuse('EXACT_OPENCLAW_JOURNAL_REQUIRED');
      if(!active.ocBound){active.deadline=Date.now()+120000;await controller.nativeGuard('openclaw',options.meterToken)({workId:active.workId,sessionId:'openclaw:'+active.workId,deadlineUnixMs:active.deadline},signal);active.ocBound=true;}
      if(!active.deadline||Date.now()>=active.deadline)refuse('NATIVE_DEADLINE_EXPIRED');
      return upstream(input,{...init,redirect:'error',signal:AbortSignal.any([signal,...(init.signal?[init.signal]:[]),AbortSignal.timeout(Math.max(1,active.deadline-Date.now()))])});
    }
    let body:Record<string,any>|undefined;
    if(typeof init.body==='string'){try{body=JSON.parse(init.body);}catch{refuse('INVALID_OPERATOR_REQUEST_BODY');}}
    const claim=init.method==='POST'&&url.pathname==='/api/agent/work/claim';
    if(claim&&!active&&!recovery)refuse('EXPLICIT_WORK_STEP_REQUIRED');
    const tool=url.pathname==='/mcp'&&body?.method==='tools/call'?body.params?.name:undefined;
    if(tool){
      if(recovery){if(!['envoi_case_snapshot','envoi_case_list_assets'].includes(tool))refuse('RECOVERY_MUST_NOT_EXECUTE_TOOLS');}
      else controller.assertScopedTool(role,tool);
      if(!['envoi_case_snapshot','envoi_case_list_assets'].includes(tool))await options.reserveOperation({kind:'tool',tool,caseId:active?.caseId,workId:active?.workId});
    }else if(init.method==='POST'&&/^\/api\/inboxes\/[^/]+\/messages$/.test(url.pathname))await options.reserveOperation({kind:'message',caseId:body?.caseId});
    const response=await upstream(input,{...init,redirect:'error'});
    if(claim&&response.ok){const raw=await response.clone().text(),work=JSON.parse(raw).work;
      if(work){if(recovery){if(work.workId!==recovery.workId||work.message?.caseId!==recovery.caseId)refuse('RETAINED_RECOVERY_WORK_MISMATCH');}
        else{if(work.workId!==active!.workId)refuse('CANONICAL_WORK_GRAPH_MISMATCH');controller.observeClaim(active!.flowId,role,work,raw);}}
    }
    if(tool&&response.ok){const e=await readEnvelope(response);if(e?.ok===true&&tool==='envoi_request_human'&&e.result?.endTurn===true&&active)active.humanEnd=true;}
    const settle=url.pathname.match(/^\/api\/agent\/work\/([^/]+)\/(complete|fail)$/);
    if(settle&&response.ok){const p=await response.clone().json(),workId=decodeURIComponent(settle[1]);
      if(active&&workId===active.workId&&settle[2]==='complete'&&p.status==='processed')active.settled=true;
      if(recovery&&workId===recovery.workId&&settle[2]==='fail'&&body?.retryable===false&&p.status==='failed'&&active)active.failed=true;
      await options.record({kind:'canonical_settlement',role,workId,status:p.status,operation:settle[2]});
    }
    return response;
  };
  const fetcher:typeof fetch=options.observeTransport?(input,init)=>options.observeTransport!(input,init,direct):direct;
  try{
    const adapter=adapterFor(runtime),context={apiUrl:origin,stateDir:options.stateDir,env:options.env,signal,fetch:fetcher,
      nativeRequestGate:options.nativeGate,beforeNativeSubmit:controller.nativeGuard(role,options.meterToken),
      beforeScopedTurn:async(workId:string,scopedSignal:AbortSignal)=>{if(active?.held){if(!options.beforeScopedControl)refuse('DECLARED_CONTROL_CHECKPOINT_REQUIRED');await options.beforeScopedControl(workId,scopedSignal);refuse('CONTROL_CHECKPOINT_MUST_NOT_START_NATIVE');}}};
    const config=await adapter.discover(context,saved.configuration);
    if(!adapter.startupCheck)refuse('READONLY_STARTUP_CHECK_REQUIRED');await adapter.startupCheck(config,context);
    bridge=await adapter.createBridge(config,context);await bridge.connector.start();await bridge.connector.checkStatus();
    // The existing native helper owns the review/confirmation prompt; this listener only accepts exact NEW planned requests.
    const send=createHostTaskSender(options.stateDir,saved,()=>{ensure();return bridge!.connector;});
    control=await startControl(options.stateDir,saved,()=>local.abort(),()=>({status:'running',runtimeChecks:'passed',receiving:'explicit-reviewed-step'}),async value=>{
      ensure();if(!options.allowedNewSends.some(v=>JSON.stringify(v)===JSON.stringify(value)))throw new HostTaskError('TASK_INVALID');return send(value);
    });
    await options.record({kind:'existing_receiver_ready',role,address:saved.address,receivingStarted:false,newEnrollment:false});
    const runOne=async(flowId:string,workId:string,caseId:string,evidenceSha256:string)=>{
      ensure();if(active)refuse('ONE_EXPLICIT_NATIVE_FLOW_REQUIRED');controller.expectWork(flowId,workId,evidenceSha256);
      active={flowId,workId,caseId,humanEnd:false,settled:false,failed:false};
      let beforeIds:Set<unknown>|undefined;
      if(['declined-resume','private-receipt-review'].includes(flowId)){const messages=await bridge!.connector.listCaseMessages(caseId);if(messages.length>=50)refuse('BOUNDED_CASE_INVENTORY_REQUIRED');beforeIds=new Set(messages.map(m=>m.id));}
      try{
        const worked=await bridge!.connector.scopedWakeWorkDriver().processWorkOnce(signal);if(!worked||!active.settled)refuse('ACTUAL_WORK_SETTLEMENT_REQUIRED');
        const bytes=await fs.readFile(path.join(options.stateDir,'scoped-runs',workId+'.json')),journal=JSON.parse(bytes.toString('utf8'));
        if(journal.workId!==workId||journal.completed!==true||journal.pending?.length)refuse('ACTUAL_NATIVE_COMPLETION_REQUIRED');
        const proof={workId,canonicalStatus:'processed' as const,journalCompleted:true as const,journalSha256:hash(bytes),nativeOutcome:active.humanEnd?'ended_for_human' as const:'completed' as const};
        if(beforeIds){const after=await bridge!.connector.listCaseMessages(caseId),record=await bridge!.connector.getCase(caseId);
          if(after.length>=50||after.some(m=>!beforeIds!.has(m.id))||record.state!=='inProgress')refuse('NO_ACTION_RESUMPTION_CHANGED_CASE');
          return {...proof,caseStillOpen:true as const,newCanonicalEffects:0 as const,...(flowId==='declined-resume'?{decisionOutcome:'declined' as const}:{})};}
        return proof;
      }finally{active=undefined;}
    };
    const runHeldControl=async(flowId:string,workId:string,caseId:string,evidenceSha256:string)=>{
      ensure();if(active||!options.beforeScopedControl||!options.verifyHeldControl)refuse('DECLARED_CONTROL_CHECKPOINT_REQUIRED');
      if(!/^msg_[A-Za-z0-9_-]+$/.test(workId))refuse('EXACT_NATIVE_WORK_REQUIRED');
      const filename=path.join(options.stateDir,'scoped-runs',workId+'.json');
      try{await fs.stat(filename);refuse('CONTROL_MUST_PRECEDE_NATIVE_JOURNAL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      const baseline=controller.ledger.snapshot().chargedAttempts;controller.expectWork(flowId,workId,evidenceSha256);
      active={flowId,workId,caseId,humanEnd:false,settled:false,failed:false,held:true,workStop:new AbortController()};
      try{
        try{await bridge!.connector.scopedWakeWorkDriver().processWorkOnce(AbortSignal.any([signal,active.workStop!.signal]));}catch{/* Actual control outcome is verified below, never converted to model success. */}
        const proof=await options.verifyHeldControl(workId);
        if(proof.lateScopeDenied!==true||proof.lateSettlementDenied!==true||proof.heldWorkResumable!==true||!/^[a-f0-9]{64}$/.test(proof.evidenceSha256)
          ||controller.ledger.snapshot().chargedAttempts!==baseline)refuse('CONTROL_CHECKPOINT_UNVERIFIED');
        try{await fs.stat(filename);refuse('CONTROL_CREATED_NATIVE_JOURNAL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
        await options.record({kind:'pre_native_control_verified',role,workId,evidenceSha256:proof.evidenceSha256,nativePrompts:0});
      }finally{active=undefined;}
    };
    const recoverRetainedFailure=async(expected:{workId:string;caseId:string;journalSha256:string})=>{
      ensure();if(active)refuse('ONE_EXPLICIT_NATIVE_FLOW_REQUIRED');const filename=path.join(options.stateDir,'scoped-runs',expected.workId+'.json');
      if(!/^msg_[A-Za-z0-9_-]+$/.test(expected.workId)||hash(await fs.readFile(filename))!==expected.journalSha256)refuse('RETAINED_JOURNAL_CHANGED');
      recovery=expected;active={...expected,flowId:'retained-terminal-failure',humanEnd:false,settled:false,failed:false};
      try{let failure:unknown;try{await bridge!.connector.scopedWakeWorkDriver().processWorkOnce(signal);}catch(error){failure=error;}
        if(!active.failed||hash(await fs.readFile(filename))!==expected.journalSha256)throw failure??new Error('RETAINED_FAILURE_RECOVERY_UNVERIFIED');
        await options.record({kind:'retained_terminal_failed_without_reprompt',role,workId:expected.workId,journalUnchanged:true});
      }finally{active=undefined;recovery=undefined;}
    };
    return {runOne,runHeldControl,recoverRetainedFailure,connector:bridge.connector,cancelHeldWork:()=>active?.workStop?.abort(),
      async awaitMeterIdle(){while(controller.ledger.snapshot().pending){ensure();await delay(20,undefined,{signal});}},
      async close(){local.abort();await control?.close();await bridge?.close();await unlock();}};
  }catch(error){local.abort();await control?.close();await bridge?.close();await unlock();throw error;}
}
