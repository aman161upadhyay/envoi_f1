import fs from 'node:fs/promises';import path from 'node:path';import {tmpdir} from 'node:os';
import {afterEach,expect,it,vi} from 'vitest';
import {ContinuationController} from './continuation-controller';
import {createContinuationReceiver} from './continuation-receiver';
const state=vi.hoisted(()=>({saved:{} as any,context:{} as any,bridge:{} as any,send:undefined as any,unlock:vi.fn(),startup:vi.fn()}));
vi.mock('../connector/core',()=>({readConnection:async()=>state.saved}));
vi.mock('../connector/store',()=>({acquireConnectorLock:async()=>state.unlock,privateJson:async()=>{throw Error('UNEXPECTED_FIXTURE_TASK_WRITE');}}));
vi.mock('../connector/adapters',()=>({adapterFor:()=>({discover:async()=>state.saved.configuration,startupCheck:state.startup,preflight:()=>{throw Error('UNEXPECTED_MODEL_PREFLIGHT');},createBridge:async(_c:unknown,context:unknown)=>{state.context=context;return state.bridge;}})}));
vi.mock('../connector/control',()=>({startControl:async(_d:unknown,_i:unknown,_s:unknown,_q:unknown,send:unknown)=>{state.send=send;return {close:async()=>{}};}}));
const cleanups:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const f of cleanups.splice(0).reverse())await f();vi.clearAllMocks();});
async function setup({held=false,role='je1',flowId='green'}:{held?:boolean;role?:'je1'|'testowner'|'openclaw';flowId?:string}={}){
  const dir=await fs.mkdtemp(path.join(tmpdir(),'envoi-continuation-receiver-'));
  cleanups.push(async()=>{const target=path.resolve(dir);if(!target.startsWith(path.resolve(tmpdir())+path.sep)||!path.basename(target).startsWith('envoi-continuation-receiver-'))throw Error('CLEANUP_REFUSED');await fs.rm(target,{recursive:true,force:true});});
  const origin='https://sinaloa-staging.rachelgonsalves821.workers.dev',gateway='http://127.0.0.1:19001',workId='msg_inert_work',caseId='case_inert',address='inert@agents-staging.sinaloa-inbox.com';
  const expected={address,agentId:'agent_inert',inboxId:'inbox_inert',installationId:'installation_inert'};
  state.saved={version:1,runtime:role==='openclaw'?'openclaw':'hermes',apiUrl:origin,address,configuration:{gatewayUrl:gateway,agentId:'inert'},activationSetup:{agentId:expected.agentId,inboxId:expected.inboxId,installationId:expected.installationId}};
  const controller={active:()=>true,receipt:{serverSource:'2ae'},control:new AbortController(),ledger:{window:'a'.repeat(64),snapshot:()=>({chargedAttempts:30,pending:0})},expectWork:vi.fn(),observeClaim:vi.fn(),assertScopedTool:vi.fn(),nativeGuard:()=>vi.fn(async()=>{})} as unknown as ContinuationController;
  const fetcher=vi.fn<typeof fetch>(async input=>{
    const url=new URL(String(input));if(url.origin===gateway)return Response.json({status:'completed',output:[{type:'message',content:[]}]});
    if(url.pathname.endsWith('/claim'))return Response.json({work:{workId,message:{id:workId,caseId,recipientAgentId:expected.agentId}}});
    if(url.pathname.endsWith('/complete'))return Response.json({workId,status:'processed'});
    throw Error('UNEXPECTED_SYNTHETIC_ROUTE');
  });
  const process=vi.fn(async()=>{
    const context=state.context;await context.fetch(origin+'/api/agent/work/claim',{method:'POST',body:'{}'});
    await context.beforeScopedTurn(workId,new AbortController().signal);
    const file=path.join(dir,'scoped-runs',workId+'.json');await fs.mkdir(path.dirname(file),{recursive:true});
    const input=[{role:'system',content:'inert system'},{role:'user',content:'inert canonical snapshot'}];
    if(role==='openclaw'){
      await fs.writeFile(file,JSON.stringify({version:1,workId,model:'openclaw:'+gateway+':inert',completed:false,pending:[],providerCalls:1,input}));
      await context.fetch(gateway+'/v1/responses',{method:'POST',body:JSON.stringify({model:'openclaw/inert',input:input.map(i=>({type:'message',...i}))})});
    }else await context.beforeNativeSubmit({workId,sessionId:'native_inert',deadlineUnixMs:Date.now()+10000},new AbortController().signal);
    await fs.writeFile(file,JSON.stringify({version:1,workId,model:role==='openclaw'?'openclaw:'+gateway+':inert':'hermes-inert',completed:true,pending:[],providerCalls:1,input}));
    await context.fetch(origin+'/api/agent/work/'+workId+'/complete',{method:'POST',body:'{}'});return true;
  });
  state.bridge={connector:{start:vi.fn(async()=>{}),checkStatus:vi.fn(async()=>{}),scopedWakeWorkDriver:()=>({processWorkOnce:process}),startCase:vi.fn(async()=>{}),listCaseMessages:vi.fn(async()=>[]),getCase:vi.fn(async()=>({state:'inProgress'}))},close:vi.fn(async()=>{})};
  const reserveOperation=vi.fn(async()=>{}),record=vi.fn(async()=>{});
  const nativeGate={policySha256:'b'.repeat(64),moduleSha256:'c'.repeat(64),factoriesSha256:'d'.repeat(64),profileHash:'e'.repeat(64),window:'a'.repeat(64),role:role==='openclaw'?'je1' as const:role,meterToken:'f'.repeat(64)};
  const request={requestId:'5f75da53-d134-4203-86e3-a161caf5b65c',recipientAddress:'other@inert.example',text:'An unsent synthetic test only.'};
  const receiver=await createContinuationReceiver({controller,role,stateDir:dir,env:{ENVOI_SCOPED_TOOLS:'true',ENVOI_HERMES_GATE_REQUIRED:'1'},meterToken:'f'.repeat(64),nativeGate:role==='openclaw'?undefined:nativeGate,
    expected,allowedNewSends:[request],fetch:fetcher,reserveOperation,record,
    ...(held?{beforeScopedControl:async()=>{throw Error('INERT_CONTROL_ABORT');},verifyHeldControl:async()=>({lateScopeDenied:true as const,lateSettlementDenied:true as const,heldWorkResumable:true as const,evidenceSha256:'9'.repeat(64)})}:{}),
  });cleanups.push(receiver.close);
  return {receiver,controller,fetcher,process,dir,workId,caseId,flowId,request,record,reserveOperation};
}
it('opens the same installed helper without claiming or generating a model request, then processes only its explicitly pinned work',async()=>{
  const s=await setup();expect(s.fetcher).not.toHaveBeenCalled();expect(s.process).not.toHaveBeenCalled();
  const proof=await s.receiver.runOne('green',s.workId,s.caseId,'1'.repeat(64));
  expect(proof).toMatchObject({workId:s.workId,journalCompleted:true,canonicalStatus:'processed',nativeOutcome:'completed'});
  expect(s.controller.expectWork).toHaveBeenCalledWith('green',s.workId,'1'.repeat(64));expect(s.controller.observeClaim).toHaveBeenCalledTimes(1);
  expect(s.fetcher.mock.calls.some(([u])=>/register|activate|enroll/.test(String(u)))).toBe(false);
});
it('verifies declined no-action resumption against actual before/after case/message reads',async()=>{
  const s=await setup({role:'testowner',flowId:'declined-resume'});const proof=await s.receiver.runOne('declined-resume',s.workId,s.caseId,'1'.repeat(64));
  expect(proof).toMatchObject({decisionOutcome:'declined',caseStillOpen:true,newCanonicalEffects:0});
  expect(state.bridge.connector.listCaseMessages).toHaveBeenCalledTimes(2);expect(state.bridge.connector.getCase).toHaveBeenCalledTimes(1);
  expect(s.reserveOperation).not.toHaveBeenCalled();
});
it('returns an evidenced pre-native control result with no journal, prompt or model reservation',async()=>{
  const s=await setup({held:true});await s.receiver.runHeldControl('green',s.workId,s.caseId,'1'.repeat(64));
  await expect(fs.stat(path.join(s.dir,'scoped-runs',s.workId+'.json'))).rejects.toMatchObject({code:'ENOENT'});
  expect(s.record).toHaveBeenCalledWith(expect.objectContaining({kind:'pre_native_control_verified',nativePrompts:0}));
});
it('binds an OpenClaw native body only to its exact saved canonical input before forwarding',async()=>{
  const s=await setup({role:'openclaw',flowId:'openclaw'});await s.receiver.runOne('openclaw',s.workId,s.caseId,'1'.repeat(64));
  expect(s.fetcher.mock.calls.filter(([u])=>String(u).endsWith('/v1/responses'))).toHaveLength(1);
  expect(s.record).toHaveBeenCalledWith(expect.objectContaining({kind:'canonical_settlement',status:'processed'}));
});
it('rejects all unlisted or previously credited send IDs at the local control boundary',async()=>{
  const s=await setup();await expect(state.send({...s.request,requestId:'43f0e326-544a-4b05-bf38-9fe0f0187227'})).rejects.toMatchObject({code:'TASK_INVALID'});
  expect(state.bridge.connector.startCase).not.toHaveBeenCalled();
});
