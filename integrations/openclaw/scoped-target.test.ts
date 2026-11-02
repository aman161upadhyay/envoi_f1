import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {OpenClawTargetRegistry,openClawTargetDigest,type OpenClawWorkTarget,type OpenClawTargetResolver,type OpenClawTargetSelectionAuthority} from './scoped-target';
const signal=new AbortController().signal;
function target(id='a',change:Partial<OpenClawWorkTarget>={}):OpenClawWorkTarget{return{
 binding:{window:'f'.repeat(64),workId:'msg_'+id,caseId:'case_'+id,caseSessionId:'case_session_'+id,recipientAgentId:'agent_one',installationId:'installation_one',fence:1},
 gatewayUrl:'http://127.0.0.1:'+(id==='a'?41001:41002),gatewayToken:'inert-private-'+id,agentId:'main',processIdentity:'process_'+id,
 configurationSha256:'a'.repeat(64),proxyOrigin:'http://127.0.0.1:'+(id==='a'?42001:42002),proxyIdentity:'proxy_'+id,deadlineUnixMs:Date.now()+120000,toolChannelSha256:'b'.repeat(64),ownerSelectionSha256:'c'.repeat(64),...change};}

// Explicitly INERT receipts. No test receipt authorizes a native host or adoption.
function reviewedRegistry(resolver:OpenClawTargetResolver,edit:(r:any)=>any=r=>r){
 const values=new Map<string,OpenClawWorkTarget>();
 const authority:OpenClawTargetSelectionAuthority={clientSource:'d'.repeat(40),nativeSourceSha256:'e'.repeat(64),window:'f'.repeat(64),
  readPersonalSelection:async(id,s)=>{const t=await resolver(id,s);values.set(id,t);return edit({receiptSha256:t.ownerSelectionSha256,clientSource:'d'.repeat(40),nativeSourceSha256:'e'.repeat(64),window:'f'.repeat(64),role:'openclaw',workId:id,caseSessionId:t.binding.caseSessionId,toolChannelSha256:t.toolChannelSha256,targetSha256:openClawTargetDigest(t)});}};
 return new OpenClawTargetRegistry(async id=>values.get(id)!,authority);
}

const request=(t:OpenClawWorkTarget):RequestInit=>({method:'POST',headers:{authorization:'Bearer '+t.gatewayToken},body:JSON.stringify({model:'openclaw/'+t.agentId,input:[]})});
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-02T18:00:00Z'));});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
it('defaults closed without an independently supplied personal selection receipt',async()=>{
 const resolver=vi.fn(async()=>target());await expect(new OpenClawTargetRegistry(resolver).resolve('msg_a',signal)).rejects.toMatchObject({code:'PERSONAL_OPENCLAW_TARGET_REVIEW_REQUIRED'});expect(resolver).not.toHaveBeenCalled();
 await expect(reviewedRegistry(resolver,()=>null).resolve('msg_a',signal)).rejects.toMatchObject({code:'PERSONAL_OPENCLAW_TARGET_REVIEW_REQUIRED'});
});
it.each(['receiptSha256','clientSource','nativeSourceSha256','window','role','workId','caseSessionId','toolChannelSha256','targetSha256'])('refuses a wrong or changed personal receipt %s',async key=>{
 const registry=reviewedRegistry(async()=>target(),r=>({...r,[key]:'changed'}));await expect(registry.resolve('msg_a',signal)).rejects.toMatchObject({code:'PERSONAL_OPENCLAW_TARGET_REVIEW_MISMATCH'});
});
it('pins immutable one-work targets and keeps interleaved gateway retries on their original target',async()=>{
 const resolver=vi.fn(async(id:string)=>target(id.slice(4))),registry=reviewedRegistry(resolver),upstream=vi.fn(async()=>Response.json({}));
 const[a,b]=await Promise.all([registry.resolve('msg_a',signal),registry.resolve('msg_b',signal)]);
 for(const t of[a,b,a,b])await registry.dispatch(t.binding.workId,t.gatewayUrl+'/v1/responses',request(t),upstream);
 expect(upstream.mock.calls.map(([u])=>u)).toEqual([a.gatewayUrl+'/v1/responses',b.gatewayUrl+'/v1/responses',a.gatewayUrl+'/v1/responses',b.gatewayUrl+'/v1/responses']);
 expect(Object.isFrozen(a)).toBe(true);expect(Object.isFrozen(a.binding)).toBe(true);
 expect(await registry.resolve('msg_a',signal)).toBe(a);expect(resolver).toHaveBeenCalledTimes(2);
});
it.each(['gatewayUrl','gatewayToken','processIdentity','proxyOrigin','proxyIdentity'] as const)('rejects reusing another work’s %s including after closure',async key=>{
 const a=target(),b=target('b',{[key]:a[key]}),registry=reviewedRegistry(async id=>id==='msg_a'?a:b);
 await registry.resolve('msg_a',signal);registry.close('msg_a');await expect(registry.resolve('msg_b',signal)).rejects.toMatchObject({code:'OPENCLAW_TARGET_REUSED'});
});
it('closes A in-flight and rejects late A without preventing B from dispatching',async()=>{
 const registry=reviewedRegistry(async id=>target(id.slice(4))),a=await registry.resolve('msg_a',signal),b=await registry.resolve('msg_b',signal);
 let inFlight:AbortSignal|undefined;const upstream=vi.fn(async(_u:unknown,init?:RequestInit)=>{inFlight=init?.signal!;return Response.json({});});
 await registry.dispatch('msg_a',a.gatewayUrl+'/v1/responses',request(a),upstream);const aSignal=inFlight!;registry.close('msg_a');expect(aSignal.aborted).toBe(true);
 await expect(registry.dispatch('msg_a',a.gatewayUrl+'/v1/responses',request(a),upstream)).rejects.toMatchObject({code:'OPENCLAW_TARGET_CLOSED'});
 await expect(registry.resolve('msg_a',signal)).rejects.toMatchObject({code:'OPENCLAW_TARGET_CLOSED'});
 await registry.dispatch('msg_b',b.gatewayUrl+'/v1/responses',request(b),upstream);expect(upstream).toHaveBeenCalledTimes(2);expect(inFlight!.aborted).toBe(false);
});
it.each([
 {binding:{...target().binding,workId:'msg_foreign'}}, {binding:{...target().binding,fence:0}}, {binding:{...target().binding,window:'bad'}},
 {gatewayUrl:'http://foreign.invalid'},{gatewayUrl:'http://127.0.0.1:41001/path'},{gatewayUrl:'https://user:pass@example.com'},
 {gatewayToken:'bad\r\ntoken'},{processIdentity:''},{configurationSha256:'bad'},{deadlineUnixMs:0}
])('refuses malformed/foreign target before dispatch %j',async change=>{
 const registry=reviewedRegistry(async()=>target('a',change));await expect(registry.resolve('msg_a',signal)).rejects.toMatchObject({code:'OPENCLAW_TARGET_INVALID'});
});
it('rejects missing, foreign, spoofed, expired and redirected gateway requests before upstream',async()=>{
 const registry=reviewedRegistry(async()=>target()),a=await registry.resolve('msg_a',signal),upstream=vi.fn(async()=>Response.json({}));
 await expect(registry.dispatch('msg_foreign',a.gatewayUrl+'/v1/responses',request(a),upstream)).rejects.toMatchObject({code:'EXACT_OPENCLAW_TARGET_REQUIRED'});
 for(const[u,init]of[[a.gatewayUrl+'/other',request(a)],['http://127.0.0.1:41002/v1/responses',request(a)],[a.gatewayUrl+'/v1/responses?work=other',request(a)],
  [a.gatewayUrl+'/v1/responses',{...request(a),headers:{authorization:'Bearer foreign'}}],[a.gatewayUrl+'/v1/responses',{...request(a),body:'{"model":"openclaw/foreign"}'}]] as const)
  await expect(registry.dispatch('msg_a',u,init,upstream)).rejects.toMatchObject({code:'FOREIGN_OPENCLAW_TARGET_REFUSED'});
 vi.advanceTimersByTime(120000);await expect(registry.dispatch('msg_a',a.gatewayUrl+'/v1/responses',request(a),upstream)).rejects.toMatchObject({code:'NATIVE_DEADLINE_EXPIRED'});expect(upstream).not.toHaveBeenCalled();
});
it('aborts an unresolved trusted selector and refuses a late result after closure',async()=>{
 let release!:(t:OpenClawWorkTarget)=>void;const pending=new Promise<OpenClawWorkTarget>(r=>{release=r;}),registry=reviewedRegistry(async()=>pending),stop=new AbortController();
 const selected=registry.resolve('msg_a',stop.signal),rejected=expect(selected).rejects.toThrow('Stopped');stop.abort(new Error('Stopped'));await rejected;release(target());
 const other=reviewedRegistry(async()=>target());other.close('msg_a');await expect(other.resolve('msg_a',signal)).rejects.toMatchObject({code:'OPENCLAW_TARGET_CLOSED'});
});
it('closing while the personal receipt is unavailable prevents any later target resolution',async()=>{
 let release!:(r:any)=>void;const receipt=new Promise<any>(r=>{release=r;}),resolver=vi.fn(async()=>target());
 const registry=new OpenClawTargetRegistry(resolver,{clientSource:'d'.repeat(40),nativeSourceSha256:'e'.repeat(64),window:'f'.repeat(64),readPersonalSelection:async()=>receipt});
 const selecting=registry.resolve('msg_a',signal),checked=expect(selecting).rejects.toMatchObject({code:'OPENCLAW_TARGET_CLOSED'});await Promise.resolve();registry.close('msg_a');await checked;release(null);await Promise.resolve();expect(resolver).not.toHaveBeenCalled();
});
