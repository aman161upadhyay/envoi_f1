import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {EnvoiConnector,type ConnectorSession,type WorkLease,type CaseSessionWorkHandler} from '../src/connector';
import {EnvoiError} from '../src/index';
import {contractRegistry,loadContractFixture} from '../../../integrations/contract-fixtures/setup';
const contract=contractRegistry.contracts.find(c=>c.id==='case-session')!;
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return{promise,resolve};}
const snapshot=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'envoi_case_snapshot',arguments:{}}});
function setup(process?:CaseSessionWorkHandler['process']){
 let saved:ConnectorSession={agentId:'agent_example',inboxId:'inbox_example',address:'example@envoi.mail',agentApiToken:'INERT_ACCESS',agentRefreshToken:'INERT_REFRESH',agentTokenExpiresAt:'2026-10-17T13:00:00Z',agentRefreshTokenExpiresAt:'2026-11-17T12:00:00Z',cursor:null};
 const works:WorkLease[]=['a','b'].map(id=>({workId:'msg_'+id,leaseToken:'INERT_LEASE_'+id,leaseExpiresAt:new Date(Date.now()+120000).toISOString(),message:{id:'msg_'+id,caseId:'case_'+id,senderAgentId:'agent_counterparty',recipientAgentId:'agent_example',text:'inert '+id,from:{agentId:'agent_counterparty',address:'counterparty@envoi.mail'}}}));
 const expected=works.map(w=>({workId:w.workId,caseId:w.message.caseId!}));
 const events:string[]=[],receivedTokens:string[]=[],tokens=new Map<string,string>(),renewFailures=new Set<string>();let claims=0,claimHold:Promise<unknown>|undefined,agentPaused=false;
 const fetcher=vi.fn<typeof fetch>(async(input,init)=>{
  const pathname=new URL(String(input)).pathname,op=pathname.split('/').at(-1)!,id=pathname.split('/')[4],work=works.find(w=>w.workId===id);events.push(op+':'+(id??''));
  if(op==='status')return Response.json({state:agentPaused?'paused':'active',inboxId:saved.inboxId,agent:{id:saved.agentId},caseSessions:{available:true,version:1}});
  if(op==='claim'){const index=claims++;if(index===1&&claimHold)await claimHold;return Response.json({work:works[index]??null});}
  if(op==='renew'){if(renewFailures.has(id))return Response.json({code:'CASE_CONTROLLED'},{status:409});work!.leaseExpiresAt=new Date(Date.now()+120000).toISOString();return Response.json({workId:id,leaseToken:work!.leaseToken,leaseExpiresAt:work!.leaseExpiresAt});}
  if(op==='acknowledge'||op==='complete'){const state=op==='complete'?'processed':'acknowledged';return Response.json({workId:id,status:state,receipt:{messageId:id,state}});}
  if(op==='session'){
   const payload=(loadContractFixture(contract,'session-created.json') as any).response.body,token='envoi_case_session_PLACEHOLDER_PRIVATE_'+id;
   Object.assign(payload.session,{id:'case_session_'+id,token,workId:id,caseId:work!.message.caseId,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+900000).toISOString()});Object.assign(payload.lease,{workId:id,leaseExpiresAt:work!.leaseExpiresAt});tokens.set('Bearer '+token,id);return Response.json(payload,{status:201});
  }
  if(op==='end')return Response.json({session:{id:JSON.parse(String(init?.body)).sessionId,status:'ended'}});
  if(op==='mcp'){const auth=new Headers(init?.headers).get('authorization')!;receivedTokens.push(auth);return Response.json({jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:JSON.stringify({workId:tokens.get(auth)})}]}});}
  if(op==='fail')return Response.json({workId:id,status:'retryable'});
  throw Error('UNEXPECTED_INERT_ROUTE');
 });
 const handler:CaseSessionWorkHandler={admit:vi.fn(async()=>{expect(claims).toBe(2);}),process:vi.fn(process??(async channel=>{await channel.forward(snapshot);} ))};
 const connector=new EnvoiConnector('https://envoi.example',{load:async()=>saved,save:async next=>{saved=structuredClone(next);}},{fetch:fetcher,caseSessionHandler:handler});
 return{connector,driver:connector.scopedWakeWorkDriver(),handler,works,expected,events,fetcher,receivedTokens,getClaims:()=>claims,holdSecond:(p:Promise<unknown>)=>{claimHold=p;},pauseAgent:()=>{agentPaused=true;},renewFailures};
}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-17T12:00:06Z'));});afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});

it('claims two exact cases serially before either admission, then processes distinct scoped channels concurrently',async()=>{
 const entered:string[]=[],both=deferred<void>();
 const s=setup(async(channel,ctx)=>{entered.push(ctx.workId!);if(entered.length===2)both.resolve();await both.promise;const response=await channel.forward(snapshot),p=await response.json();expect(JSON.parse(p.result.content[0].text).workId).toBe(ctx.workId);});
 const outcomes=await s.driver.processWorkBatch(s.expected);expect(entered.sort()).toEqual(['msg_a','msg_b']);expect(outcomes.map(o=>o.status)).toEqual(['fulfilled','fulfilled']);expect(s.receivedTokens).toHaveLength(2);expect(new Set(s.receivedTokens).size).toBe(2);expect(s.getClaims()).toBe(2);expect(vi.getTimerCount()).toBe(0);
});
it('renews the first lease behind the admission barrier while the second claim is delayed',async()=>{
 const s=setup(),second=deferred<void>();s.holdSecond(second.promise);const batch=s.driver.processWorkBatch(s.expected);
 await vi.waitFor(()=>expect(s.getClaims()).toBe(2));expect(s.handler.admit).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(20001);expect(s.events).toContain('renew:msg_a');expect(s.handler.process).not.toHaveBeenCalled();s.expected[0].workId='msg_mutated_by_caller';second.resolve();const outcomes=await batch;expect(outcomes[0].workId).toBe('msg_a');expect(vi.getTimerCount()).toBe(0);
});
it('a second mismatched claim aborts/drains the first lease without any handler or extra claim',async()=>{
 const s=setup();s.works[1].message.caseId='case_foreign';await expect(s.driver.processWorkBatch(s.expected)).rejects.toMatchObject({code:'SCOPED_BATCH_CLAIM_MISMATCH'});expect(s.handler.admit).not.toHaveBeenCalled();expect(s.handler.process).not.toHaveBeenCalled();expect(s.getClaims()).toBe(2);expect(s.events.some(e=>e.startsWith('complete:')||e.startsWith('fail:'))).toBe(false);expect(vi.getTimerCount()).toBe(0);
});
it('one case-local failure preserves its own error and allows the independent sibling to settle',async()=>{
 const both=deferred<void>();let entered=0;const fault=new EnvoiError('Case controlled',409,'CASE_CONTROLLED');
 const s=setup(async(_channel,ctx)=>{if(++entered===2)both.resolve();await both.promise;if(ctx.workId==='msg_a')throw fault;});
 const outcomes=await s.driver.processWorkBatch(s.expected);expect(outcomes[0]).toMatchObject({status:'rejected',error:fault});expect(outcomes[1]).toEqual({workId:'msg_b',caseId:'case_b',status:'fulfilled',worked:true});expect(s.events).toContain('complete:msg_b');expect(s.events).not.toContain('complete:msg_a');expect(vi.getTimerCount()).toBe(0);
});
it('explicit batch ownership refuses normal coalescing or a second batch without claiming followup work',async()=>{
 const hold=deferred<void>(),entered=deferred<void>();let count=0;const s=setup(async()=>{if(++count===2)entered.resolve();await hold.promise;});
 const batch=s.driver.processWorkBatch(s.expected);await entered.promise;await expect(s.connector.processWorkOnce()).rejects.toMatchObject({code:'SCOPED_BATCH_IN_FLIGHT'});await expect(s.driver.processWorkBatch(s.expected)).rejects.toMatchObject({code:'SCOPED_BATCH_IN_FLIGHT'});hold.resolve();await batch;expect(s.getClaims()).toBe(2);
});
it('rejects duplicate, same-case, excessive or malformed expectations before any network call',async()=>{
 for(const expected of [[],[{workId:'msg_a',caseId:'case_a'},{workId:'msg_a',caseId:'case_b'}],[{workId:'msg_a',caseId:'case_a'},{workId:'msg_b',caseId:'case_a'}],[{workId:'bad',caseId:'case_a'}],[{workId:'msg_a',caseId:'case_a'},{workId:'msg_b',caseId:'case_b'},{workId:'msg_c',caseId:'case_c'}]]){const s=setup();await expect(s.driver.processWorkBatch(expected)).rejects.toThrow();expect(s.fetcher).not.toHaveBeenCalled();}
});
it('owner abort drains both independent lease/session handlers with no completion or extra claim',async()=>{
 const started=deferred<void>();let count=0;const s=setup(async(_channel,ctx)=>{if(++count===2)started.resolve();await new Promise<void>((_,reject)=>ctx.signal.addEventListener('abort',()=>reject(ctx.signal.reason),{once:true}));});
 const stop=new AbortController(),batch=s.driver.processWorkBatch(s.expected,stop.signal);await started.promise;stop.abort();const outcomes=await batch;expect(outcomes.every(o=>o.status==='rejected')).toBe(true);expect(s.events.some(e=>e.startsWith('complete:'))).toBe(false);expect(s.getClaims()).toBe(2);expect(vi.getTimerCount()).toBe(0);
});
it('a case-local renewal/fence denial aborts only that work while the sibling retains its own lease and settlement',async()=>{
 const entered=deferred<void>(),releaseB=deferred<void>();let count=0;
 const s=setup(async(_channel,ctx)=>{if(++count===2)entered.resolve();if(ctx.workId==='msg_b')await releaseB.promise;else await new Promise<void>((_,reject)=>ctx.signal.addEventListener('abort',()=>reject(ctx.signal.reason),{once:true}));});
 const batch=s.driver.processWorkBatch(s.expected);await entered.promise;s.renewFailures.add('msg_a');await s.driver.revalidateLiveLeases();releaseB.resolve();const outcomes=await batch;expect(outcomes[0]).toMatchObject({status:'rejected',error:{code:'CASE_CONTROLLED'}});expect(outcomes[1]).toMatchObject({status:'fulfilled',worked:true});expect(s.events).toContain('renew:msg_b');expect(s.events).toContain('complete:msg_b');expect(s.events).not.toContain('complete:msg_a');expect(vi.getTimerCount()).toBe(0);
});
it('an agent-global pause aborts both active cases instead of treating it as a case-local fence',async()=>{
 const entered=deferred<void>();let count=0;const s=setup(async(_channel,ctx)=>{if(++count===2)entered.resolve();await new Promise<void>((_,reject)=>ctx.signal.addEventListener('abort',()=>reject(ctx.signal.reason),{once:true}));});
 const batch=s.driver.processWorkBatch(s.expected);await entered.promise;s.pauseAgent();await s.connector.checkStatus();const outcomes=await batch;expect(outcomes.every(o=>o.status==='rejected')).toBe(true);expect(s.events.some(e=>e.startsWith('complete:'))).toBe(false);expect(s.getClaims()).toBe(2);expect(vi.getTimerCount()).toBe(0);
});
