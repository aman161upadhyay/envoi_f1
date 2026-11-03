import fs from 'node:fs/promises';import path from 'node:path';import {tmpdir} from 'node:os';
import {afterEach,expect,it,vi} from 'vitest';
import {ContinuationController} from './continuation-controller';
import {createContinuationReceiver,type TrustedScopedControlContext} from './continuation-receiver';
import {createHash} from 'node:crypto';
const state=vi.hoisted(()=>({saved:{} as any,context:{} as any,bridge:{} as any,send:undefined as any,unlock:vi.fn(),startup:vi.fn()}));
vi.mock('../connector/core',()=>({readConnection:async()=>state.saved}));
vi.mock('../connector/store',()=>({acquireConnectorLock:async()=>state.unlock,privateJson:async()=>{throw Error('UNEXPECTED_FIXTURE_TASK_WRITE');}}));
vi.mock('../connector/adapters',()=>({adapterFor:()=>({discover:async()=>state.saved.configuration,startupCheck:state.startup,preflight:()=>{throw Error('UNEXPECTED_MODEL_PREFLIGHT');},createBridge:async(_c:unknown,context:unknown)=>{state.context=context;return state.bridge;}})}));
vi.mock('../connector/control',()=>({startControl:async(_d:unknown,_i:unknown,_s:unknown,_q:unknown,send:unknown)=>{state.send=send;return {close:async()=>{}};}}));
const cleanups:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const f of cleanups.splice(0).reverse())await f();vi.clearAllMocks();});
async function setup({held=false,role='je1',flowId='green',trustedControl,observeTransport,observeNativeEnd,beforeFirstScopedSnapshot}:{held?:boolean;role?:'je1'|'testowner'|'openclaw';flowId?:string;trustedControl?:(context:TrustedScopedControlContext,signal:AbortSignal)=>Promise<never>;observeTransport?:Parameters<typeof createContinuationReceiver>[0]['observeTransport'];observeNativeEnd?:Parameters<typeof createContinuationReceiver>[0]['observeNativeEnd'];beforeFirstScopedSnapshot?:Parameters<typeof createContinuationReceiver>[0]['beforeFirstScopedSnapshot']}={}){
  const dir=await fs.mkdtemp(path.join(tmpdir(),'envoi-continuation-receiver-'));
  cleanups.push(async()=>{const target=path.resolve(dir);if(!target.startsWith(path.resolve(tmpdir())+path.sep)||!path.basename(target).startsWith('envoi-continuation-receiver-'))throw Error('CLEANUP_REFUSED');await fs.rm(target,{recursive:true,force:true});});
  const origin='https://sinaloa-staging.rachelgonsalves821.workers.dev',gateway='http://127.0.0.1:19001',workId='msg_inert_work',caseId='case_inert',address='inert@agents-staging.sinaloa-inbox.com';
  const expected={address,agentId:'agent_inert',inboxId:'inbox_inert',installationId:'installation_inert'};
  state.saved={version:1,runtime:role==='openclaw'?'openclaw':'hermes',apiUrl:origin,address,configuration:{gatewayUrl:gateway,agentId:'inert'},activationSetup:{agentId:expected.agentId,inboxId:expected.inboxId,installationId:expected.installationId}};
  const controller={active:()=>true,receipt:{serverSource:'2ae',clientSource:'inert-source'},control:new AbortController(),ledger:{window:'a'.repeat(64),snapshot:()=>({chargedAttempts:30,pending:0})},expectWork:vi.fn(),observeClaim:vi.fn(),beginPreNativeControl:vi.fn(),observePreNativeControlClaim:vi.fn(),endPreNativeControl:vi.fn(),assertScopedTool:vi.fn(),closeNativeForwarding:vi.fn(),nativeGuard:()=>vi.fn(async()=>{}),stop:vi.fn()} as unknown as ContinuationController;
  const fetcher=vi.fn<typeof fetch>(async(input,init)=>{
    const url=new URL(String(input));if(url.origin===gateway)return Response.json({status:'completed',output:[{type:'message',content:[]}]});
    if(url.pathname.endsWith('/claim'))return Response.json({work:{workId,leaseToken:'PRIVATE_LEASE',leaseExpiresAt:new Date(Date.now()+60000).toISOString(),message:{id:workId,caseId,recipientAgentId:expected.agentId}}});
    if(url.pathname.endsWith('/renew'))return Response.json({workId,leaseToken:'PRIVATE_LEASE',leaseExpiresAt:new Date(Date.now()+120000).toISOString()});
    if(url.pathname.endsWith('/complete'))return Response.json({workId,status:'processed'});
    if(url.pathname.endsWith('/fail'))return Response.json({workId,status:'retryable'});
    if(url.pathname.endsWith('/session/end'))return Response.json({session:{id:'session_inert',status:'ended'}});
    if(url.pathname.endsWith('/session'))return Response.json({session:{id:'session_inert',workId,caseId,agentId:expected.agentId,installationId:expected.installationId,fence:2,expiresAt:new Date(Date.now()+900000).toISOString(),token:'PRIVATE_INERT_TOKEN',allowedTools:['envoi_case_snapshot','envoi_case_list_assets','envoi_case_decide'],transport:{kind:'mcp'}}});
    if(url.pathname==='/mcp'){const body=JSON.parse(String(init?.body));if(body.params.name==='envoi_case_decide')return Response.json({result:{content:[{text:JSON.stringify({ok:false,error:{code:'AUTHORITY_EXPIRED'}})}]}});return Response.json({result:{content:[{text:JSON.stringify({ok:true,result:{case:{id:caseId,state:'inProgress'},tools:{decide:'actual_new_ref'}}})}]}});}
    throw Error('UNEXPECTED_SYNTHETIC_ROUTE');
  });
  const process=vi.fn(async(signal=new AbortController().signal)=>{
    const context=state.context;await context.fetch(origin+'/api/agent/work/claim',{method:'POST',body:'{}'});
    if(trustedControl||observeNativeEnd||beforeFirstScopedSnapshot){await context.fetch(origin+'/api/agent/work/'+workId+'/session',{method:'POST',body:'{}'});await context.fetch(origin+'/mcp',{method:'POST',headers:{authorization:'Bearer PRIVATE_INERT_TOKEN','mcp-protocol-version':'2025-11-25'},body:JSON.stringify({jsonrpc:'2.0',id:'snapshot',method:'tools/call',params:{name:'envoi_case_snapshot',arguments:{}}})});}
    await context.beforeScopedTurn(workId,signal);
    const file=path.join(dir,'scoped-runs',workId+'.json');await fs.mkdir(path.dirname(file),{recursive:true});
    const input=[{role:'system',content:'inert system'},{role:'user',content:'inert canonical snapshot'}];
    if(role==='openclaw'){
      await fs.writeFile(file,JSON.stringify({version:1,workId,model:'openclaw:'+gateway+':inert',completed:false,pending:[],providerCalls:1,input}));
      await context.fetch(gateway+'/v1/responses',{method:'POST',body:JSON.stringify({model:'openclaw/inert',input:input.map(i=>({type:'message',...i}))})});
    }else await context.beforeNativeSubmit({workId,sessionId:'native_inert',deadlineUnixMs:Date.now()+10000},new AbortController().signal);
    await fs.writeFile(file,JSON.stringify({version:1,workId,model:role==='openclaw'?'openclaw:'+gateway+':inert':'hermes-inert',completed:true,pending:[],providerCalls:1,input}));
    await context.fetch(origin+'/api/agent/work/'+workId+'/session/end',{method:'POST',body:JSON.stringify({sessionId:'session_inert'})});
    await context.fetch(origin+'/api/agent/work/'+workId+'/complete',{method:'POST',body:'{}'});return true;
  });
  state.bridge={connector:{start:vi.fn(async()=>{}),checkStatus:vi.fn(async()=>{}),scopedWakeWorkDriver:()=>({processWorkOnce:process}),startCase:vi.fn(async()=>{}),listCaseMessages:vi.fn(async()=>[]),getCase:vi.fn(async()=>({state:'inProgress'}))},close:vi.fn(async()=>{})};
  const reserveOperation=vi.fn(async()=>{}),record=vi.fn(async()=>{});
  const nativeGate={policySha256:'b'.repeat(64),moduleSha256:'c'.repeat(64),factoriesSha256:'d'.repeat(64),profileHash:'e'.repeat(64),window:'a'.repeat(64),role:role==='openclaw'?'je1' as const:role,meterToken:'f'.repeat(64)};
  const request={requestId:'5f75da53-d134-4203-86e3-a161caf5b65c',recipientAddress:'other@inert.example',text:'An unsent synthetic test only.'};
  const receiver=await createContinuationReceiver({controller,role,stateDir:dir,env:{ENVOI_SCOPED_TOOLS:'true',ENVOI_HERMES_GATE_REQUIRED:'1'},meterToken:'f'.repeat(64),nativeGate:role==='openclaw'?undefined:nativeGate,
    expected,allowedNewSends:[request],fetch:fetcher,reserveOperation,record,beforeTrustedScopedControl:trustedControl,observeTransport,observeNativeEnd,beforeFirstScopedSnapshot,
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
  expect(s.controller.closeNativeForwarding).not.toHaveBeenCalled();
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
it('captures the actual private scope before native admission without exposing tokens or consuming a native flow',async()=>{
  let context:TrustedScopedControlContext|undefined;
  const s=await setup({trustedControl:async c=>{context=c;throw Object.assign(Error('EXPECTED_CONTROL_STOP'),{code:'EXPECTED_CONTROL_STOP'});}});
  const input={controlId:'authority-expiry',mode:'authority-expiry' as const,role:'je1' as const,caseId:s.caseId,workId:s.workId,evidenceSha256:'7'.repeat(64)};
  const result=await s.receiver.runPreNativeControl(input);
  expect(result).toMatchObject({status:'stopped_before_native',modelPrompts:0,errorCode:'EXPECTED_CONTROL_STOP'});
  expect(context?.session).toMatchObject({id:'session_inert',fence:2,token:'[REDACTED]'});
  expect(context?.snapshot).toMatchObject({tools:{decide:'actual_new_ref'}});
  expect(JSON.stringify(context)).not.toContain('PRIVATE_INERT_TOKEN');
  expect(s.controller.beginPreNativeControl).toHaveBeenCalledWith(input);expect(s.controller.endPreNativeControl).toHaveBeenCalledWith(input.controlId);
  expect(s.controller.expectWork).not.toHaveBeenCalled();expect(s.controller.observeClaim).not.toHaveBeenCalled();
  expect(s.controller.assertScopedTool).not.toHaveBeenCalled();expect(s.reserveOperation).not.toHaveBeenCalled();
  await expect(fs.stat(path.join(s.dir,'scoped-runs',s.workId+'.json'))).rejects.toMatchObject({code:'ENOENT'});
  await expect(context!.channel.forward(JSON.stringify({method:'tools/call',params:{name:'envoi_case_snapshot',arguments:{}}}))).rejects.toThrow('CONTROL_CHANNEL_CLOSED');
});
it('forwards one exact expected-denial request through the observer then the same action reserve, without retry',async()=>{
  const order:string[]=[],body=JSON.stringify({jsonrpc:'2.0',id:'c08-expired',method:'tools/call',params:{name:'envoi_case_decide',arguments:{evaluation:'actual_new_ref',decision:'decline'}}});
  let s:Awaited<ReturnType<typeof setup>>;
  s=await setup({observeTransport:async(input,init,next)=>{if(String(init?.body)===body)order.push('observer');return next(input,init);},trustedControl:async c=>{
    await expect(c.channel.forward(body)).rejects.toThrow('EXACT_EXPECTED_DENIAL_REQUEST_REQUIRED');
    expect(()=>c.channel.registerExpectedDenial(body,'0'.repeat(64))).toThrow('EXACT_EXPECTED_DENIAL_REQUEST_REQUIRED');
    c.channel.registerExpectedDenial(body,createHash('sha256').update(body).digest('hex'));
    expect(()=>c.channel.registerExpectedDenial(body,createHash('sha256').update(body).digest('hex'))).toThrow('EXACT_EXPECTED_DENIAL_REQUEST_REQUIRED');
    const response=await c.channel.forward(body);expect(await response.text()).toContain('AUTHORITY_EXPIRED');
    await expect(c.channel.forward(body)).rejects.toThrow('EXACT_EXPECTED_DENIAL_REQUEST_REQUIRED');
    throw Error('SUPPORTED_RETRYABLE_STOP');
  }});
  s.reserveOperation.mockImplementation(async()=>{order.push('reserve');});
  await s.receiver.runPreNativeControl({controlId:'c08',mode:'authority-expiry',role:'je1',caseId:s.caseId,workId:s.workId,evidenceSha256:'7'.repeat(64)});
  expect(order).toEqual(['observer','reserve']);expect(s.reserveOperation).toHaveBeenCalledTimes(1);
  expect(s.fetcher.mock.calls.filter(([,init])=>init?.body===body)).toHaveLength(1);
});
it('refuses a control on retained native journal bytes before any claim or controller mutation',async()=>{
  const s=await setup({trustedControl:async()=>{throw Error('NOT_REACHED');}});await fs.mkdir(path.join(s.dir,'scoped-runs'));
  await fs.writeFile(path.join(s.dir,'scoped-runs',s.workId+'.json'),'retained');
  await expect(s.receiver.runPreNativeControl({controlId:'expiry',mode:'expiry',role:'je1',caseId:s.caseId,workId:s.workId,evidenceSha256:'7'.repeat(64)})).rejects.toThrow('CONTROL_MUST_PRECEDE_NATIVE_JOURNAL');
  expect(s.fetcher).not.toHaveBeenCalled();expect(s.controller.beginPreNativeControl).not.toHaveBeenCalled();
});
it('reads the renewed real lease without exposing its private token or changing any fixed deadline',async()=>{
  const s=await setup({trustedControl:async c=>{
    const before=c.leaseExpiresAt();await state.context.fetch('https://sinaloa-staging.rachelgonsalves821.workers.dev/api/agent/work/'+String(c.work.workId)+'/renew',{method:'POST',body:JSON.stringify({leaseToken:'PRIVATE_LEASE'})});
    expect(Date.parse(c.leaseExpiresAt())).toBeGreaterThan(Date.parse(before));
    expect(JSON.stringify(c)).not.toContain('PRIVATE_LEASE');throw Error('DONE_NO_NATIVE');
  }});
  await s.receiver.runPreNativeControl({controlId:'lease',mode:'expiry',role:'je1',caseId:s.caseId,workId:s.workId,evidenceSha256:'7'.repeat(64)});
  expect(s.reserveOperation).not.toHaveBeenCalled();expect(s.controller.closeNativeForwarding).not.toHaveBeenCalled();
});
it('captures real frame, completed journal and raw canonical ending only after actual processed settlement',async()=>{
  const ends:unknown[]=[];const s=await setup({observeNativeEnd:async facts=>{ends.push(facts);expect(facts.frame).toMatchObject({workId:facts.workId,sessionId:'native_inert'});expect(JSON.parse(facts.journalRawBytes)).toMatchObject({workId:facts.workId,completed:true});expect(JSON.parse(facts.sessionEndRawBytes)).toMatchObject({session:{id:'session_inert',status:'ended'}});expect(JSON.parse(facts.completeRawBytes)).toMatchObject({workId:facts.workId,status:'processed'});expect(JSON.stringify(facts.session)).not.toContain('PRIVATE_INERT_TOKEN');}});
  await expect(s.receiver.nativeFacts(s.workId)).rejects.toThrow('ACTUAL_NATIVE_WORK_FACTS_REQUIRED');
  await s.receiver.runOne('green',s.workId,s.caseId,'1'.repeat(64));expect(ends).toHaveLength(1);
  await expect(s.receiver.nativeFacts(s.workId)).rejects.toThrow('ACTUAL_NATIVE_WORK_FACTS_REQUIRED');
});
it('retains actual ended scope and retryable failure responses with lease authority omitted',async()=>{
  const s=await setup({trustedControl:async()=>{throw Error('CONTROLLED_C08_REOFFER');}}),original=s.process.getMockImplementation()!;
  s.process.mockImplementation(async()=>{try{return await original();}catch(error){
    await state.context.fetch('https://sinaloa-staging.rachelgonsalves821.workers.dev/api/agent/work/'+s.workId+'/session/end',{method:'POST',body:JSON.stringify({leaseToken:'PRIVATE_LEASE',sessionId:'session_inert'})});
    await state.context.fetch('https://sinaloa-staging.rachelgonsalves821.workers.dev/api/agent/work/'+s.workId+'/fail',{method:'POST',body:JSON.stringify({leaseToken:'PRIVATE_LEASE',retryable:true,reasonCode:'HANDLER_FAILED'})});throw error;
  }});
  const result=await s.receiver.runPreNativeControl({controlId:'c08',mode:'authority-expiry',role:'je1',caseId:s.caseId,workId:s.workId,evidenceSha256:'7'.repeat(64)});
  expect(JSON.parse(result.failureRequestRedactedBytes!)).toEqual({retryable:true,reasonCode:'HANDLER_FAILED'});
  expect(JSON.parse(result.failureResponseRawBytes!)).toEqual({workId:s.workId,status:'retryable'});
  expect(JSON.parse(result.sessionEndRawBytes!)).toMatchObject({session:{id:'session_inert',status:'ended'}});
  expect(result).toMatchObject({modelChargedAttemptsBefore:30,modelChargedAttemptsAfter:30,journalAbsent:true});
  expect(JSON.stringify(result)).not.toContain('PRIVATE_LEASE');
});
it('does not permit scope overrides or registered denial writes in a different control mode',async()=>{
  const s=await setup({trustedControl:async c=>{
    const override=JSON.stringify({jsonrpc:'2.0',id:'override',method:'tools/call',params:{name:'envoi_case_snapshot',arguments:{caseId:'case_other'}}});
    await expect(c.channel.forward(override)).rejects.toThrow('INVALID_SCOPED_OPERATOR_REQUEST');
    const body=JSON.stringify({jsonrpc:'2.0',id:'deny',method:'tools/call',params:{name:'envoi_case_decide',arguments:{evaluation:'actual_ref'}}});
    expect(()=>c.channel.registerExpectedDenial(body,createHash('sha256').update(body).digest('hex'))).toThrow('EXACT_EXPECTED_DENIAL_REQUEST_REQUIRED');throw Error('DONE');
  }});
  await s.receiver.runPreNativeControl({controlId:'expiry-read',mode:'expiry',role:'je1',caseId:s.caseId,workId:s.workId,evidenceSha256:'7'.repeat(64)});
  expect(s.reserveOperation).not.toHaveBeenCalled();
});
it('runs the once-only trusted fixture before the original snapshot is sent or any native frame exists',async()=>{
  let s:Awaited<ReturnType<typeof setup>>,entered=0;
  s=await setup({beforeFirstScopedSnapshot:async facts=>{
    entered++;expect(facts).toMatchObject({role:'je1',workId:s.workId,caseId:s.caseId,session:{id:'session_inert',fence:2}});
    expect(JSON.stringify(facts)).not.toContain('PRIVATE_LEASE');expect(JSON.stringify(facts)).not.toContain('PRIVATE_INERT_TOKEN');
    expect(s.fetcher.mock.calls.some(([input])=>String(input).endsWith('/mcp'))).toBe(false);
    await expect(s.receiver.nativeFacts(s.workId)).rejects.toThrow('ACTUAL_NATIVE_WORK_FACTS_REQUIRED');
    expect(s.receiver.scopedFacts(s.workId).session).toBe(facts.session);
  }});
  await s.receiver.runOne('green',s.workId,s.caseId,'1'.repeat(64));expect(entered).toBe(1);
});
it('retains a failed first-snapshot gate so a transport retry cannot skip the fixture',async()=>{
  let calls=0;const s=await setup({beforeFirstScopedSnapshot:async()=>{calls++;throw Error('FIXTURE_REFUSED');}});
  s.process.mockImplementation(async()=>{
    const root='https://sinaloa-staging.rachelgonsalves821.workers.dev';await state.context.fetch(root+'/api/agent/work/claim',{method:'POST',body:'{}'});await state.context.fetch(root+'/api/agent/work/'+s.workId+'/session',{method:'POST',body:'{}'});
    for(let i=0;i<2;i++)await expect(state.context.fetch(root+'/mcp',{method:'POST',headers:{authorization:'Bearer PRIVATE_INERT_TOKEN','mcp-protocol-version':'2025-11-25'},body:JSON.stringify({jsonrpc:'2.0',id:'snapshot'+i,method:'tools/call',params:{name:'envoi_case_snapshot',arguments:{}}})})).rejects.toThrow('FIXTURE_REFUSED');return false;
  });
  await expect(s.receiver.runOne('green',s.workId,s.caseId,'1'.repeat(64))).rejects.toThrow('ACTUAL_WORK_SETTLEMENT_REQUIRED');
  expect(calls).toBe(1);expect(s.fetcher.mock.calls.some(([input])=>String(input).endsWith('/mcp'))).toBe(false);
});
it('retains only trusted stale-scope reads after SDK cancellation until explicit control close',async()=>{
  const s=await setup({trustedControl:async()=>{throw Error('RUN_CALLBACK_MUST_NOT_EXECUTE');}});
  const handle=await s.receiver.startPreNativeControl({controlId:'retained-expiry',mode:'expiry',role:'je1',caseId:s.caseId,workId:s.workId,evidenceSha256:'7'.repeat(64)}),context=await handle.ready;
  handle.cancel();const drained=await handle.finished;expect(drained).toMatchObject({status:'stopped_before_native',modelPrompts:0});
  expect(s.controller.endPreNativeControl).not.toHaveBeenCalled();expect(context.leaseExpiresAt()).toBeTruthy();
  const response=await context.channel.forward(JSON.stringify({jsonrpc:'2.0',id:'late-server-probe',method:'tools/call',params:{name:'envoi_case_snapshot',arguments:{}}}));
  expect(response.status).toBe(200);expect(s.fetcher.mock.calls.at(-1)?.[1]?.headers).toMatchObject({authorization:'Bearer PRIVATE_INERT_TOKEN'});
  expect(s.controller.expectWork).not.toHaveBeenCalled();expect(s.reserveOperation).not.toHaveBeenCalled();
  await handle.close();await handle.close();expect(s.controller.endPreNativeControl).toHaveBeenCalledTimes(1);
  await expect(context.channel.forward(JSON.stringify({jsonrpc:'2.0',id:'closed',method:'tools/call',params:{name:'envoi_case_snapshot',arguments:{}}}))).rejects.toThrow('CONTROL_CHANNEL_CLOSED');
});
it('keeps the original ready scope, private bearer and protocol after a later SDK remint',async()=>{
  const s=await setup({trustedControl:async()=>{throw Error('UNUSED');}}),original=s.fetcher.getMockImplementation()!,root='https://sinaloa-staging.rachelgonsalves821.workers.dev';let remint=false;
  s.fetcher.mockImplementation(async(input,init)=>{
    const response=await original(input,init);
    if(remint&&String(input).endsWith('/session')){const p=await response.json();Object.assign(p.session,{id:'session_reminted',fence:3,token:'PRIVATE_REMINTED_TOKEN',allowedTools:['envoi_case_snapshot','envoi_case_list_assets']});return Response.json(p);}
    if(remint&&String(input).endsWith('/mcp'))return Response.json({result:{content:[{text:JSON.stringify({ok:true,result:{tools:{decide:'new_scope_ref'}}})}]}});
    return response;
  });
  const handle=await s.receiver.startPreNativeControl({controlId:'expiry-remint',mode:'expiry',role:'je1',caseId:s.caseId,workId:s.workId,evidenceSha256:'7'.repeat(64)}),context=await handle.ready;
  const oldFacts=s.receiver.scopedFacts(s.workId),oldDigest=context.toolChannelSha256;expect(oldFacts.toolChannelSha256).toBe(oldDigest);expect(oldDigest).toMatch(/^[a-f0-9]{64}$/);
  remint=true;await state.context.fetch(root+'/api/agent/work/'+s.workId+'/session',{method:'POST',body:'{}'});
  await state.context.fetch(root+'/mcp',{method:'POST',headers:{authorization:'Bearer PRIVATE_REMINTED_TOKEN','mcp-protocol-version':'2026-01-01'},body:JSON.stringify({jsonrpc:'2.0',id:'new-snapshot',method:'tools/call',params:{name:'envoi_case_snapshot',arguments:{}}})});
  const current=s.receiver.scopedFacts(s.workId);expect(current.session).toMatchObject({id:'session_reminted',fence:3});expect(current.toolChannelSha256).not.toBe(oldDigest);
  expect(oldFacts.toolChannelSha256).toBe(oldDigest);expect(context.toolChannelSha256).toBe(oldDigest);expect(context.session).toMatchObject({id:'session_inert',fence:2});expect(context.snapshot).toMatchObject({tools:{decide:'actual_new_ref'}});
  await expect(state.context.beforeScopedTurn(s.workId,new AbortController().signal)).rejects.toThrow('ACTUAL_CONTROL_SCOPE_REQUIRED');
  handle.cancel();await handle.finished;
  await context.channel.forward(JSON.stringify({jsonrpc:'2.0',id:'probe-original-only',method:'tools/call',params:{name:'envoi_case_snapshot',arguments:{}}}));
  expect(new Headers(s.fetcher.mock.calls.at(-1)![1]!.headers).get('authorization')).toBe('Bearer PRIVATE_INERT_TOKEN');expect(new Headers(s.fetcher.mock.calls.at(-1)![1]!.headers).get('mcp-protocol-version')).toBe('2025-11-25');
  expect(JSON.stringify(context)).not.toContain('PRIVATE_');expect(context.session.allowedTools).toContain('envoi_case_decide');expect(Object.isFrozen(context.session.allowedTools)).toBe(true);await handle.close();
});
it('uses a private exact stale-settlement marker only after SDK drain, without native processed hooks',async()=>{
  const s=await setup({trustedControl:async()=>{throw Error('UNUSED');}}),original=s.fetcher.getMockImplementation()!;
  s.fetcher.mockImplementation(async(input,init)=>String(input).endsWith('/complete')?Response.json({code:'WORK_LEASE_STALE'},{status:409}):original(input,init));
  const handle=await s.receiver.startPreNativeControl({controlId:'late-settle',mode:'expiry',role:'je1',caseId:s.caseId,workId:s.workId,evidenceSha256:'7'.repeat(64)}),context=await handle.ready;
  state.bridge.connector.probeStaleControlSettlementOnce=vi.fn(async(input:any)=>{
    expect(input).toMatchObject({workId:s.workId,leaseToken:'PRIVATE_LEASE',expected:'expired'});
    const response=await state.context.fetch('https://sinaloa-staging.rachelgonsalves821.workers.dev/api/agent/work/'+s.workId+'/complete',{method:'POST',body:JSON.stringify({leaseToken:input.leaseToken})});
    return{status:{status:200,raw:'{"state":"active"}'},settlement:{status:response.status,raw:await response.text()}};
  });
  await expect(context.probeLateSettlement('expired')).rejects.toThrow('EXACT_STALE_CONTROL_PROBE_REQUIRED');
  handle.cancel();await handle.finished;
  await expect(state.context.fetch('https://sinaloa-staging.rachelgonsalves821.workers.dev/api/agent/work/'+s.workId+'/complete',{method:'POST',body:JSON.stringify({leaseToken:'PRIVATE_LEASE'})})).rejects.toThrow('PRE_NATIVE_CONTROL_FORBIDS_PROCESSING');
  const probe=await context.probeLateSettlement('expired');expect(probe.settlement).toEqual({status:409,raw:'{"code":"WORK_LEASE_STALE"}'});
  await expect(context.probeLateSettlement('paused')).rejects.toThrow('EXACT_STALE_CONTROL_PROBE_REQUIRED');
  expect(s.controller.closeNativeForwarding).not.toHaveBeenCalled();expect(s.record).not.toHaveBeenCalledWith(expect.objectContaining({kind:'canonical_settlement',status:'processed'}));await handle.close();
});
