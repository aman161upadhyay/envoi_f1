import {createHash} from 'node:crypto';import fs from 'node:fs/promises';import path from 'node:path';import {tmpdir} from 'node:os';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {EnvoiConnector,type ConnectorSession} from '../../sdk/typescript/src/connector';
import {EnvoiError} from '../../sdk/typescript/src/index';
import {contractRegistry,loadContractFixture} from '../contract-fixtures/setup';
import {createContinuationReceiver} from './continuation-receiver';
import type {ContinuationController} from './continuation-controller';
import {openClawTargetDigest,type OpenClawTargetResolver,type OpenClawWorkTarget,type OpenClawTargetSelectionAuthority} from '../openclaw/scoped-target';
import {startOwnedClosedNativeProcess,closedNativeManifestDigest} from '../openclaw/owned-native-process';
import {EventEmitter} from 'node:events';
import {prepareOwnedOpenClawFactory} from '../openclaw/per-work-native';
import {CLOSED_NATIVE_BOOTSTRAP_FILES} from '../openclaw/closed-native-bootstrap';
import nativeFixture from '../openclaw/native-observer-sources.fixture.json';
const state=vi.hoisted(()=>({saved:{} as any,context:{} as any,create:undefined as any,discoverCount:0,startupCount:0}));
vi.mock('../connector/core',()=>({readConnection:async()=>state.saved}));
vi.mock('../connector/store',()=>({acquireConnectorLock:async()=>async()=>{},privateJson:async()=>{throw Error('UNEXPECTED_TASK_WRITE');}}));
vi.mock('../connector/adapters',()=>({adapterFor:()=>({discover:async()=>{state.discoverCount++;return state.saved.configuration;},startupCheck:async()=>{state.startupCount++;},createBridge:async(_c:unknown,ctx:unknown)=>{state.context=ctx;return state.create(ctx);}})}));
vi.mock('../connector/control',()=>({startControl:async()=>({close:async()=>{}})}));
const contract=contractRegistry.contracts.find(c=>c.id==='case-session')!,origin='https://sinaloa-staging.rachelgonsalves821.workers.dev';
const rpc=(name:string,args:unknown={})=>JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};};
const cleanups:Array<()=>Promise<unknown>>=[];
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-17T12:00:06Z'));});
afterEach(async()=>{for(const fn of cleanups.splice(0).reverse())await fn();vi.useRealTimers();vi.restoreAllMocks();});
async function setup({role='je1',process,tokenReuse=false,noAction=false,removeAfter=false,tamperAfterEnd=false,expectedCaseState,returnedCaseState='inProgress',decisionOutcome,targetResolver,targetSelection,ownedNative}:{role?:'je1'|'testowner'|'openclaw';process?:(channel:any,context:any)=>Promise<void>;tokenReuse?:boolean;noAction?:boolean;removeAfter?:boolean;tamperAfterEnd?:boolean;expectedCaseState?:'inProgress'|'completed';returnedCaseState?:'inProgress'|'completed';decisionOutcome?:'declined'|null;targetResolver?:OpenClawTargetResolver;targetSelection?:OpenClawTargetSelectionAuthority;ownedNative?:Parameters<typeof createContinuationReceiver>[0]['openClawOwnedNative']}={}){
 const dir=await fs.mkdtemp(path.join(tmpdir(),'envoi-rx-batch-'));cleanups.push(async()=>{const target=path.resolve(dir);if(!target.startsWith(path.resolve(tmpdir())+path.sep)||!path.basename(target).startsWith('envoi-rx-batch-'))throw Error('CLEANUP_REFUSED');await fs.rm(target,{recursive:true,force:true});});
 const expected={address:'example@envoi.mail',agentId:'agent_example',inboxId:'inbox_example',installationId:'installation_example'};
 state.saved={version:1,runtime:role==='openclaw'?'openclaw':'hermes',apiUrl:origin,address:expected.address,configuration:{gatewayUrl:'http://127.0.0.1:19002',agentId:'inert'},activationSetup:{agentId:expected.agentId,inboxId:expected.inboxId,installationId:expected.installationId}};
 const fenceOrder:Array<{kind:string;workId:string}>=[];
 const native=vi.fn(async()=>{}),controller={active:()=>true,receipt:{serverSource:'2ae',clientSource:'d'.repeat(40),hardStopUtc:new Date(Date.now()+5400000).toISOString()},control:new AbortController(),ledger:{window:'a'.repeat(64),snapshot:()=>({chargedAttempts:30,pending:0})},expectWork:vi.fn(),observeClaim:vi.fn(),assertScopedTool:vi.fn(),closeNativeForwarding:vi.fn((_id:string,p:{workId:string})=>{fenceOrder.push({kind:'provider_closed',workId:p.workId});}),nativeGuard:()=>native,flowPolicy:()=>({noAction,decisionOutcome:decisionOutcome===undefined?(noAction?'declined':null):decisionOutcome,allowHumanEnd:true,...(expectedCaseState?{expectedCaseState}:{})})} as unknown as ContinuationController;
 const works=['a','b'].map(id=>({workId:'msg_'+id,leaseToken:'INERT_LEASE_'+id,leaseExpiresAt:new Date(Date.now()+120000).toISOString(),message:{id:'msg_'+id,caseId:'case_'+id,recipientAgentId:expected.agentId,senderAgentId:'agent_counterparty',from:{agentId:'agent_counterparty',address:'counterparty@envoi.mail'},text:'inert '+id}}));
 let claims=0;const tokens=new Map<string,string>(),record=vi.fn(async()=>{}),reserveOperation=vi.fn(async()=>{}),calls:Array<{method:string;workId?:string;tool?:string}>=[];
 const fetcher=vi.fn<typeof fetch>(async(input,init)=>{
  const url=new URL(String(input)),pathname=url.pathname,op=pathname.split('/').at(-1)!,id=pathname.split('/')[4],work=works.find(w=>w.workId===id);calls.push({method:op,workId:work?.workId});
  if(op==='responses')return Response.json({status:'completed',output:[{type:'message'}]});
  if(op==='status')return Response.json({state:'active',inboxId:expected.inboxId,agent:{id:expected.agentId},caseSessions:{available:true,version:1}});
  if(op==='claim')return Response.json({work:works[claims++]??null});
  if(op==='session'){const payload=(loadContractFixture(contract,'session-created.json') as any).response.body,token='envoi_case_session_PLACEHOLDER_PRIVATE_'+(tokenReuse?'a':id);
   Object.assign(payload.session,{id:'case_session_'+id,token,workId:id,caseId:work!.message.caseId,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+900000).toISOString(),transport:{kind:'mcp_streamable_http',url:origin+'/mcp'}});Object.assign(payload.lease,{workId:id,leaseExpiresAt:work!.leaseExpiresAt});tokens.set('Bearer '+token,id);return Response.json(payload,{status:201});}
  if(op==='end')return Response.json({session:{id:JSON.parse(String(init?.body)).sessionId,status:'ended'}});
  if(op==='acknowledge'||op==='complete'){const status=op==='complete'?'processed':'acknowledged';return Response.json({workId:id,status,receipt:{messageId:id,state:status}});}
  if(op==='fail')return Response.json({workId:id,status:'retryable'});
  if(op==='renew')return Response.json({workId:id,leaseToken:work!.leaseToken,leaseExpiresAt:new Date(Date.now()+120000).toISOString()});
  if(op==='mcp'){const token=new Headers(init?.headers).get('authorization')!,body=JSON.parse(String(init?.body)),tool=body.params?.name,workId=tokens.get(token);calls.push({method:body.method,workId,tool});return Response.json({jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:JSON.stringify({ok:true,result:{workId,...(tool==='envoi_request_human'?{endTurn:true}:{})}})}]}});}
  if(op==='messages'){const caseId=url.searchParams.get('caseId');return Response.json(removeAfter&&calls.some(c=>c.method==='complete')?[]:[{id:'msg_prior_'+caseId,caseId}]);}
  if(pathname.includes('/cases/'))return Response.json({id:op,state:returnedCaseState});
  throw Error('UNEXPECTED_INERT_ROUTE');
 });
 state.create=async(ctx:any)=>{
  let saved:ConnectorSession={...expected,agentApiToken:'INERT_AGENT_ACCESS',agentRefreshToken:'INERT_AGENT_REFRESH',agentTokenExpiresAt:'2026-10-17T13:00:00Z',agentRefreshTokenExpiresAt:'2026-11-17T12:00:00Z',cursor:null};
  const connector=new EnvoiConnector(origin,{load:async()=>saved,save:async next=>{saved=next;}},{fetch:ctx.fetch,caseSessionHandler:{admit:async()=>{},process:async(channel,context)=>{
   await ctx.beforeScopedTurn(context.workId,context.signal);
   if(targetResolver){const t=await ctx.openClawTargetResolver(context.workId,context.signal);await fs.mkdir(path.join(dir,'scoped-runs'),{recursive:true});await fs.writeFile(path.join(dir,'scoped-runs',context.workId+'.json'),JSON.stringify({version:1,workId:context.workId,model:'openclaw:'+t.gatewayUrl+':'+t.agentId,completed:false,pending:[],providerCalls:1,input:[]}));await ctx.fetch(t.gatewayUrl+'/v1/responses',{method:'POST',headers:{authorization:'Bearer '+t.gatewayToken},body:JSON.stringify({model:'openclaw/'+t.agentId,input:[]})});}
   else await ctx.beforeNativeSubmit({workId:context.workId,sessionId:'native_'+context.workId,deadlineUnixMs:Date.now()+10000},context.signal);
   if(process)await process(channel,context);else await channel.forward(rpc('envoi_case_snapshot'));
   await fs.mkdir(path.join(dir,'scoped-runs'),{recursive:true});await fs.writeFile(path.join(dir,'scoped-runs',context.workId+'.json'),JSON.stringify({workId:context.workId,completed:true,pending:[],providerCalls:1,input:[]}));
  }}});return{connector,close:async()=>{}};
 };
 const gate={policySha256:'b'.repeat(64),moduleSha256:'c'.repeat(64),factoriesSha256:'d'.repeat(64),profileHash:'e'.repeat(64),window:'a'.repeat(64),role:role==='openclaw'?'je1' as const:role,meterToken:'f'.repeat(64)};
 const receiver=await createContinuationReceiver({controller,role,stateDir:dir,env:{ENVOI_SCOPED_TOOLS:'true',ENVOI_HERMES_GATE_REQUIRED:'1'},meterToken:'f'.repeat(64),nativeGate:role==='openclaw'?undefined:gate,expected,allowedNewSends:[],fetch:fetcher,reserveOperation,record,openClawTargetResolver:targetResolver,openClawTargetSelection:targetSelection,openClawOwnedNative:ownedNative,
  observeTransport:async(input,init,next)=>{const end=new URL(String(input)).pathname.match(/\/work\/([^/]+)\/session\/end$/);if(end)fenceOrder.push({kind:'outer_end_observer',workId:end[1]});const response=await next(input,init);if(end&&tamperAfterEnd)await fs.appendFile(path.join(dir,'scoped-runs',end[1]+'.json'),'\n');return response;}});cleanups.push(receiver.close);
 const flows=works.map((w,index)=>({flowId:index?'second':'first',workId:w.workId,caseId:w.message.caseId,evidenceSha256:String(index+1).repeat(64)}));
 return{receiver,controller,native,flows,fetcher,record,reserveOperation,calls,tokens,fenceOrder,claims:()=>claims};
}
it('uses the actual SDK batch to interleave two work sessions and correlates initialize/list/tools by their private minted token',async()=>{
 const both=deferred();let entered=0;
 const s=await setup({process:async(channel,ctx)=>{if(++entered===2)both.resolve();await both.promise;for(const method of ['initialize','tools/list','ping'])await channel.forward(JSON.stringify({jsonrpc:'2.0',id:1,method}));const p=await(await channel.forward(rpc('envoi_case_reply',{text:'inert'}))).json();expect(JSON.parse(p.result.content[0].text).result.workId).toBe(ctx.workId);}});
 const result=await s.receiver.runMany(s.flows);expect(result.map(p=>p.workId)).toEqual(['msg_a','msg_b']);expect(s.claims()).toBe(2);expect(s.controller.assertScopedTool).toHaveBeenCalledWith('je1','envoi_case_reply','msg_a');expect(s.controller.assertScopedTool).toHaveBeenCalledWith('je1','envoi_case_reply','msg_b');expect(s.reserveOperation.mock.calls.map(([p])=>[p.workId,p.caseId])).toEqual(expect.arrayContaining([['msg_a','case_a'],['msg_b','case_b']]));expect(JSON.stringify(s.record.mock.calls)).not.toMatch(/INERT_AGENT|envoi_case_session_|INERT_LEASE/);
});
it('attributes a human-end result only to its own concurrent work',async()=>{
 const s=await setup({role:'testowner',process:async(channel,ctx)=>{await channel.forward(rpc(ctx.workId==='msg_a'?'envoi_request_human':'envoi_case_snapshot'));}});const results=await s.receiver.runMany(s.flows);expect(results.map(p=>p.nativeOutcome)).toEqual(['ended_for_human','completed']);
});
it('never reassigns a late A or operational bearer to active B, including initialize/list',async()=>{
 const hold=deferred(),started=deferred();const s=await setup({process:async(_channel,ctx)=>{if(ctx.workId==='msg_b'){started.resolve();await hold.promise;}}});const batch=s.receiver.runMany(s.flows);await started.promise;await vi.waitFor(()=>expect(s.record).toHaveBeenCalledWith(expect.objectContaining({kind:'canonical_settlement',workId:'msg_a'})));
 const token=[...s.tokens].find(([,id])=>id==='msg_a')![0],count=s.fetcher.mock.calls.length;
 for(const auth of [token,'Bearer INERT_AGENT_ACCESS'])for(const method of ['initialize','tools/list','tools/call'])await expect(state.context.fetch(origin+'/mcp',{method:'POST',headers:{authorization:auth},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{name:'envoi_case_reply',arguments:{}}})})).rejects.toMatchObject({code:'EXACT_SCOPED_WORK_TOKEN_REQUIRED'});
 await expect(state.context.fetch(origin+'/api/agent/work/msg_foreign/complete',{method:'POST',body:'{}'})).rejects.toMatchObject({code:'UNBOUND_WORK_ROUTE'});
 await expect(state.context.fetch(origin+'/api/agent/work/claim',{method:'POST',body:'{}'})).rejects.toMatchObject({code:'EXPLICIT_WORK_STEP_REQUIRED'});
 expect(s.fetcher).toHaveBeenCalledTimes(count);expect(s.fenceOrder.filter(x=>x.workId==='msg_a')).toEqual([{kind:'provider_closed',workId:'msg_a'},{kind:'outer_end_observer',workId:'msg_a'}]);expect(s.controller.closeNativeForwarding).not.toHaveBeenCalledWith('second',expect.anything());hold.resolve();await batch;
});
it('rejects a recycled token naming a different work rather than silently rebinding its old authority',async()=>{
 vi.spyOn(Math,'random').mockReturnValue(0);const s=await setup({tokenReuse:true});const batch=s.receiver.runMany(s.flows);const checked=expect(batch).rejects.toMatchObject({code:'EXPLICIT_NATIVE_BATCH_INCOMPLETE'});await vi.advanceTimersByTimeAsync(10000);await checked;expect(s.native.mock.calls.every(([frame])=>frame.workId==='msg_a')).toBe(true);
});
it('preserves a successful sibling proof when the other actual SDK case handler fails',async()=>{
 const fault=new EnvoiError('Controlled',409,'CASE_CONTROLLED'),s=await setup({process:async(_channel,ctx)=>{if(ctx.workId==='msg_a')throw fault;}});await expect(s.receiver.runMany(s.flows)).rejects.toMatchObject({code:'EXPLICIT_NATIVE_BATCH_INCOMPLETE',completedWorkIds:['msg_b']});expect(s.record).toHaveBeenCalledWith(expect.objectContaining({kind:'canonical_settlement',workId:'msg_b',status:'processed'}));
});
it('fails same-role OpenClaw batching before claim, runtime or native/model submission until attribution exists',async()=>{
 const s=await setup({role:'openclaw'});await expect(s.receiver.runMany(s.flows)).rejects.toMatchObject({code:'SAME_ROLE_NATIVE_ATTRIBUTION_REQUIRED'});expect(s.fetcher.mock.calls.filter(([url])=>String(url).endsWith('/claim'))).toHaveLength(0);expect(s.native).not.toHaveBeenCalled();
});
it('also refuses sequential runOne under a reviewed multi-OpenClaw graph because late native A could be retagged as B',async()=>{
 const s=await setup({role:'openclaw'});Object.assign(s.controller.ledger,{reviewedPlan:{reviewOnly:true},flows:[{role:'openclaw'},{role:'openclaw'}]});const f=s.flows[0];await expect(s.receiver.runOne(f.flowId,f.workId,f.caseId,f.evidenceSha256)).rejects.toMatchObject({code:'SAME_ROLE_NATIVE_ATTRIBUTION_REQUIRED'});expect(s.fetcher.mock.calls.filter(([url])=>String(url).endsWith('/claim'))).toHaveLength(0);expect(s.native).not.toHaveBeenCalled();
});
it('uses reviewed flow policy for independent declined no-action proofs and rejects removed canonical effects',async()=>{
 const s=await setup({role:'testowner',noAction:true});const results=await s.receiver.runMany(s.flows);expect(results.every(p=>'decisionOutcome' in p&&p.decisionOutcome==='declined'&&p.newCanonicalEffects===0)).toBe(true);expect(s.reserveOperation).not.toHaveBeenCalled();
 const changed=await setup({role:'testowner',noAction:true,removeAfter:true});await expect(changed.receiver.runMany(changed.flows)).rejects.toMatchObject({code:'EXPLICIT_NATIVE_BATCH_INCOMPLETE',completedWorkIds:[]});
});
it('refuses a native journal changed after its provider forwarding fence was closed',async()=>{
 const s=await setup({tamperAfterEnd:true});await expect(s.receiver.runMany(s.flows)).rejects.toMatchObject({code:'EXPLICIT_NATIVE_BATCH_INCOMPLETE',completedWorkIds:[]});expect(s.controller.closeNativeForwarding).toHaveBeenCalledTimes(2);expect(s.record).toHaveBeenCalledWith(expect.objectContaining({kind:'canonical_settlement',status:'processed'}));
});

it('proves an explicitly reviewed completed ordinary receipt as no-action without inventing an open-case proof',async()=>{
 const s=await setup({noAction:true,decisionOutcome:null,expectedCaseState:'completed',returnedCaseState:'completed'}),f=s.flows[0];
 const result=await s.receiver.runOne(f.flowId,f.workId,f.caseId,f.evidenceSha256);
 expect(result).toMatchObject({canonicalStatus:'processed',nativeOutcome:'completed',caseState:'completed',newCanonicalEffects:0});
 expect(result).not.toHaveProperty('caseStillOpen');expect(result).not.toHaveProperty('decisionOutcome');expect(s.reserveOperation).not.toHaveBeenCalled();
 const wrongState=await setup({noAction:true,decisionOutcome:null,expectedCaseState:'completed',returnedCaseState:'inProgress'}),wrong=wrongState.flows[0];
 await expect(wrongState.receiver.runOne(wrong.flowId,wrong.workId,wrong.caseId,wrong.evidenceSha256)).rejects.toMatchObject({code:'NO_ACTION_RESUMPTION_CHANGED_CASE'});
 const changed=await setup({noAction:true,decisionOutcome:null,expectedCaseState:'completed',returnedCaseState:'completed',removeAfter:true}),effect=changed.flows[0];
 await expect(changed.receiver.runOne(effect.flowId,effect.workId,effect.caseId,effect.evidenceSha256)).rejects.toMatchObject({code:'NO_ACTION_RESUMPTION_CHANGED_CASE'});
});

// These receipts are deliberately fake offline inputs, never live owner approvals.
function fakeTarget(id:string):OpenClawWorkTarget{
 const caseId=id==='msg_a'?'case_a':'case_b',sessionId='case_session_'+id,token='envoi_case_session_PLACEHOLDER_PRIVATE_'+id;
 return{binding:{window:'a'.repeat(64),workId:id,caseId,caseSessionId:sessionId,recipientAgentId:'agent_example',installationId:'installation_example',fence:1},
 gatewayUrl:'http://127.0.0.1:'+(id==='msg_a'?41001:41002),gatewayToken:'inert-target-'+id,agentId:'inert',processIdentity:'process_'+id,configurationSha256:'b'.repeat(64),stateDirectorySha256:(id==='msg_a'?'1':'2').repeat(64),configurationPathSha256:(id==='msg_a'?'3':'4').repeat(64),workspaceSha256:(id==='msg_a'?'5':'6').repeat(64),agentStateSha256:(id==='msg_a'?'7':'8').repeat(64),proxyOrigin:'http://127.0.0.1:'+(id==='msg_a'?42001:42002),proxyIdentity:'proxy_'+id,deadlineUnixMs:Date.now()+10000,ownerSelectionSha256:'c'.repeat(64),
 toolChannelSha256:createHash('sha256').update(JSON.stringify(['a'.repeat(64),id,caseId,sessionId,1,token,{kind:'mcp_streamable_http',url:origin+'/mcp'}])).digest('hex')};
}
function fakeSelection(target:(id:string)=>OpenClawWorkTarget,nativeSourceSha256='e'.repeat(64)):OpenClawTargetSelectionAuthority{return{clientSource:'d'.repeat(40),nativeSourceSha256,window:'a'.repeat(64),readPersonalSelection:async id=>{const t=target(id);return{receiptSha256:t.ownerSelectionSha256,clientSource:'d'.repeat(40),nativeSourceSha256,window:'a'.repeat(64),role:'openclaw',workId:id,caseSessionId:t.binding.caseSessionId,toolChannelSha256:t.toolChannelSha256,targetSha256:openClawTargetDigest(t)};}};}
it('routes a reviewed immutable target using the actual SDK-minted canonical session and private channel hash, then rejects late dispatch',async()=>{
 const resolver=vi.fn(async(id:string)=>fakeTarget(id)),s=await setup({role:'openclaw',targetResolver:resolver,targetSelection:fakeSelection(fakeTarget)}),f=s.flows[0];
 const p=await s.receiver.runOne(f.flowId,f.workId,f.caseId,f.evidenceSha256);expect(p.canonicalStatus).toBe('processed');expect(s.calls.filter(c=>c.method==='responses')).toHaveLength(1);
 const t=fakeTarget(f.workId),before=s.fetcher.mock.calls.length;await expect(state.context.fetch(t.gatewayUrl+'/v1/responses',{method:'POST',headers:{authorization:'Bearer '+t.gatewayToken},body:JSON.stringify({model:'openclaw/inert',input:[]})})).rejects.toMatchObject({code:'FOREIGN_RUNTIME_REQUEST_REFUSED'});expect(s.fetcher).toHaveBeenCalledTimes(before);
 expect(JSON.stringify(s.record.mock.calls)).not.toMatch(/inert-target|envoi_case_session_|INERT_AGENT/);
});
it('rejects a personally reviewed target for a foreign canonical channel before native dispatch',async()=>{
 const wrong=(id:string)=>({...fakeTarget(id),toolChannelSha256:'0'.repeat(64)}),s=await setup({role:'openclaw',targetResolver:async id=>wrong(id),targetSelection:fakeSelection(wrong)}),f=s.flows[0];
 await expect(s.receiver.runOne(f.flowId,f.workId,f.caseId,f.evidenceSha256)).rejects.toMatchObject({code:'OPENCLAW_CANONICAL_TARGET_MISMATCH'});expect(s.calls.filter(c=>c.method==='responses')).toHaveLength(0);expect(s.native).not.toHaveBeenCalled();
});
it('does not treat a trusted resolver or offline receipt as permission to enable multi-OpenClaw admission',async()=>{
 const resolver=vi.fn(async(id:string)=>fakeTarget(id)),s=await setup({role:'openclaw',targetResolver:resolver,targetSelection:fakeSelection(fakeTarget)});
 await expect(s.receiver.runMany(s.flows)).rejects.toMatchObject({code:'SAME_ROLE_NATIVE_ATTRIBUTION_REQUIRED'});expect(resolver).not.toHaveBeenCalled();expect(s.claims()).toBe(0);
});
it('refuses a forged owned-native object before controller/native dispatch despite resolver and reviewed metadata',async()=>{
 const s=await setup({role:'openclaw',targetResolver:async id=>fakeTarget(id),targetSelection:fakeSelection(fakeTarget),ownedNative:{factoryPolicySha256:'f'.repeat(64),authorityForTarget:async()=>({}as any)}});
 Object.assign(s.controller.ledger,{reviewedPlan:{reviewOnly:true},flows:[{role:'openclaw'},{role:'openclaw'}]});const f=s.flows[0];
 await expect(s.receiver.runOne(f.flowId,f.workId,f.caseId,f.evidenceSha256)).rejects.toMatchObject({code:'OWNED_NATIVE_AUTHORITY_REQUIRED'});
 expect(s.calls.filter(c=>c.method==='responses')).toHaveLength(0);expect(s.native).not.toHaveBeenCalled();
});
it('cancels a never-resolving owned authority lookup before native admission or Gateway dispatch',async()=>{
 const entered=deferred(),s=await setup({role:'openclaw',targetResolver:async id=>fakeTarget(id),targetSelection:fakeSelection(fakeTarget),ownedNative:{factoryPolicySha256:'f'.repeat(64),authorityForTarget:async()=>{entered.resolve();return new Promise(()=>{});}}}),f=s.flows[0];
 const running=s.receiver.runOne(f.flowId,f.workId,f.caseId,f.evidenceSha256);await entered.promise;s.controller.control.abort(new Error('OWNER_ABORTED_LOOKUP'));
 await expect(running).rejects.toMatchObject({code:'REQUEST_CANCELLED'});expect(s.controller.control.signal.reason.message).toBe('OWNER_ABORTED_LOOKUP');expect(s.native).not.toHaveBeenCalled();expect(s.calls.filter(c=>c.method==='responses')).toHaveLength(0);
});
it('rejects fabricated prepared-factory metadata before skipping the saved gateway startup checks',async()=>{
 const before=state.discoverCount;
 await expect(setup({role:'openclaw',targetResolver:async id=>fakeTarget(id),targetSelection:fakeSelection(fakeTarget),ownedNative:{factoryPolicySha256:'f'.repeat(64),factory:{}as any,authorityForTarget:async()=>({}as any)}})).rejects.toThrow('PREPARED_OWNED_NATIVE_FACTORY_REQUIRED');
 expect(state.discoverCount).toBe(before);
});
it('opens the existing connector against an actual prepared-code factory without probing the obsolete base gateway or inventing scope',async()=>{
 // Actual source-copy/factory code with fake vendor fixture files in fresh temp;
 // this is an offline startup-routing test, not a native capability attestation.
 const root=await fs.mkdtemp(path.join(tmpdir(),'envoi-rx-batch-'));cleanups.push(async()=>{const p=path.resolve(root);if(!p.startsWith(path.resolve(tmpdir())+path.sep)||!path.basename(p).startsWith('envoi-rx-batch-'))throw Error('CLEANUP_REFUSED');await fs.rm(p,{recursive:true,force:true});});
 const native=path.join(root,'native'),profile=path.join(root,'profile'),entry=path.join(root,'child.mjs');
 for(const[role,name]of Object.entries(CLOSED_NATIVE_BOOTSTRAP_FILES)){if(role==='observer')continue;const file=path.join(native,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,(nativeFixture.files as any)[path.basename(file)]??'INERT_CODE_'+role);}
 for(const name of['package.json','node_modules/@openclaw/ai/package.json']){const file=path.join(native,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'{"version":"2026.10.5"}');}
 await fs.mkdir(profile);await fs.writeFile(entry,'INERT_CHILD');const authorize=vi.fn(async()=>{}),prepared=await prepareOwnedOpenClawFactory({sourceNativeRoot:native,destinationNativeRoot:path.join(root,'copy'),workRoot:path.join(root,'works'),originalProfile:profile,nodeExecutable:'INERT_NODE',childEntry:entry,childEntrySha256:createHash('sha256').update('INERT_CHILD').digest('hex'),clientSource:'d'.repeat(40),factoryPolicySha256:'f'.repeat(64),authorize});
 const before={discover:state.discoverCount,startup:state.startupCount},s=await setup({role:'openclaw',targetResolver:async id=>fakeTarget(id),targetSelection:fakeSelection(fakeTarget,prepared.pins.nativeSourceSha256),ownedNative:{factoryPolicySha256:prepared.pins.factoryPolicySha256,factory:prepared.factory,authorityForTarget:async()=>{throw Error('NO_WORK_AT_STARTUP');}}});
 expect(state.discoverCount).toBe(before.discover);expect(state.startupCount).toBe(before.startup);expect(s.claims()).toBe(0);expect(s.native).not.toHaveBeenCalled();expect(authorize.mock.calls.length).toBeGreaterThan(1);
 expect(s.record).toHaveBeenCalledWith(expect.objectContaining({kind:'owned_native_factory_ready',nativeGatewayStarted:false,modelPromptsSubmitted:0}));
});
// This composes the actual opaque allocator and SDK against a FAKE child IPC
// dependency. It proves plumbing only and is not an actual native capability.
class InertOwnedChild extends EventEmitter{pid=123;exitCode:number|null=null;connected=true;send(message:any){if(message.kind==='start')queueMicrotask(()=>this.emit('message',{kind:'ready',nonce:message.nonce,observation:{...message.bootstrap.binding,kind:'actual_native_gateway_bootstrap_observation',runtimeObservation:'pending_first_harness'}}));if(message.kind==='stop')queueMicrotask(()=>{this.emit('message',{kind:'closed',nonce:message.nonce});this.exitCode=0;this.connected=false;this.emit('exit',0);});return true;}kill(){this.exitCode=1;this.connected=false;this.emit('exit',1);return true;}}
it('composes exact opaque owned-child bootstrap admission with actual SDK per-work target binding',async()=>{
 const nativeSourceSha256=closedNativeManifestDigest({}),handles:Array<Awaited<ReturnType<typeof startOwnedClosedNativeProcess>>>=[],seen:string[]=[];
 const s=await setup({role:'openclaw',targetResolver:async id=>fakeTarget(id),targetSelection:fakeSelection(fakeTarget,nativeSourceSha256),ownedNative:{factoryPolicySha256:'f'.repeat(64),authorityForTarget:async(t,signal)=>{
  const b={...t.binding,toolChannelSha256:t.toolChannelSha256,processIdentity:t.processIdentity,hardStopUnixMs:t.deadlineUnixMs,proxyOrigin:t.proxyOrigin,nativeSources:{}}as any;
  const handle=await startOwnedClosedNativeProcess({nodeExecutable:'inert',childEntry:'inert',childEntrySha256:createHash('sha256').update('entry').digest('hex'),environment:{},bootstrap:{nativeRoot:'inert',binding:b,port:1,paths:{}as any,sourceSha256:{}as any},pins:{window:t.binding.window,workId:t.binding.workId,caseId:t.binding.caseId,caseSessionId:t.binding.caseSessionId,toolChannelSha256:t.toolChannelSha256,processIdentity:t.processIdentity,clientSource:'d'.repeat(40),nativeSourceSha256,capabilitySha256:(t.binding.workId==='msg_a'?'f':'c').repeat(64),ownerSelectionSha256:t.ownerSelectionSha256,targetSha256:openClawTargetDigest(t)},authorize:async()=>{},meterBinding:{nativeToken:'inert',deadlineUnixMs:t.deadlineUnixMs},ports:{assertLive:()=>{},authorizePhysical:async()=>{throw Error('NO_PHYSICAL_REQUEST_ALLOWED');},recordObservation:async()=>{},recordPhysicalOutcome:async()=>{}},signal},{readBytes:async()=>Buffer.from('entry'),spawnChild:()=>new InertOwnedChild()as any,nonce:()=> 'a'.repeat(64)});
  handles.push(handle);seen.push(t.binding.workId);return handle.authority;
 }}});
 Object.assign(s.controller.ledger,{reviewedPlan:{reviewOnly:true},flows:[{role:'openclaw'},{role:'openclaw'}]});
 const results=await s.receiver.runMany(s.flows);expect(results).toHaveLength(2);expect(seen.sort()).toEqual(['msg_a','msg_b']);
 expect(s.native).toHaveBeenCalledTimes(2);expect(s.record).toHaveBeenCalledWith(expect.objectContaining({kind:'owned_native_bootstrap_admitted',runtimeObservation:'pending_first_harness'}));
 for(const handle of handles)await handle.close();
});
