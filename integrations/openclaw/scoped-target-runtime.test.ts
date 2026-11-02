import fs from 'node:fs/promises';import path from 'node:path';import {tmpdir} from 'node:os';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {FileBridgeStore} from '../agent-bridges/file-store';
import {createOpenClawBridge} from './runtime';
import {openClawTargetDigest,type OpenClawWorkTarget,type OpenClawTargetSelectionAuthority} from './scoped-target';
const captured=vi.hoisted(()=>({handler:undefined as any}));
// Expose the trusted callback; actual bridge/store/Responses loop remain under test.
vi.mock('../agent-bridges/scoped-turn',()=>({scopedTurnHandler:(h:unknown)=>{captured.handler=h;return h;}}));
const cleanups:Array<()=>Promise<unknown>>=[];
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-02T18:00:00Z'));});
afterEach(async()=>{for(const fn of cleanups.splice(0).reverse())await fn();vi.useRealTimers();vi.restoreAllMocks();});
function target(id:string):OpenClawWorkTarget{return{binding:{window:'a'.repeat(64),workId:id,caseId:'case_'+id,caseSessionId:'case_session_'+id,recipientAgentId:'agent_one',installationId:'installation_one',fence:1},
 gatewayUrl:'http://127.0.0.1:'+(id==='msg_a'?41001:41002),gatewayToken:'inert-private-'+id,agentId:'main',processIdentity:'process_'+id,configurationSha256:'b'.repeat(64),stateDirectorySha256:(id==='msg_a'?'1':'2').repeat(64),configurationPathSha256:(id==='msg_a'?'3':'4').repeat(64),workspaceSha256:(id==='msg_a'?'5':'6').repeat(64),agentStateSha256:(id==='msg_a'?'7':'8').repeat(64),proxyOrigin:'http://127.0.0.1:'+(id==='msg_a'?42001:42002),proxyIdentity:'proxy_'+id,deadlineUnixMs:Date.now()+120000,toolChannelSha256:'c'.repeat(64),ownerSelectionSha256:'d'.repeat(64)};}
function authority():OpenClawTargetSelectionAuthority{return{clientSource:'e'.repeat(40),nativeSourceSha256:'f'.repeat(64),window:'a'.repeat(64),readPersonalSelection:async id=>{const t=target(id);return{receiptSha256:t.ownerSelectionSha256,clientSource:'e'.repeat(40),nativeSourceSha256:'f'.repeat(64),window:'a'.repeat(64),role:'openclaw',workId:id,caseSessionId:t.binding.caseSessionId,toolChannelSha256:t.toolChannelSha256,targetSha256:openClawTargetDigest(t)};}};}
async function setup(options:Parameters<typeof createOpenClawBridge>[1]={}){
 const directory=await fs.mkdtemp(path.join(tmpdir(),'envoi-target-runtime-'));cleanups.push(async()=>{const resolved=path.resolve(directory);if(!resolved.startsWith(path.resolve(tmpdir())+path.sep)||!path.basename(resolved).startsWith('envoi-target-runtime-'))throw Error('CLEANUP_REFUSED');await fs.rm(resolved,{recursive:true,force:true});});
 const store=new FileBridgeStore(directory);await store.init();await store.save({agentId:'agent_one',inboxId:'inbox_one',address:'agent@inert.invalid',cursor:null} as never);
 const baseline=await fs.readFile(path.join(directory,'session.json'));
 const calls:Array<{url:string;init:RequestInit}>=[],counts=new Map<string,number>();
 const fetcher=vi.fn<typeof fetch>(async(u,init={})=>{const url=String(u);calls.push({url,init});const count=(counts.get(url)??0)+1;counts.set(url,count);
  return Response.json({status:'completed',output:count===1?[{type:'function_call',call_id:'inert_'+new URL(url).port,name:'envoi_case_snapshot',arguments:'{}'}]:[{type:'message',content:[]}]});});
 const bridge=await createOpenClawBridge({apiUrl:'https://server.inert.invalid',stateDir:directory,gatewayUrl:'http://127.0.0.1:19000',gatewayToken:'inert-saved-default',agentId:'main'},
  {env:{ENVOI_SCOPED_TOOLS:'true'},fetch:fetcher,...options});cleanups.push(bridge.close);
 const turn={instruction:'inert',context:{},snapshot:{},tools:[{name:'envoi_case_snapshot',inputSchema:{type:'object'}}],signal:new AbortController().signal,callTool:vi.fn(async()=>({inert:true}))};
 return{directory,baseline,bridge,turn,calls,fetcher,run:captured.handler.run};
}
it('uses one enrollment store and journal root for two immutable factories and their repeated Responses requests',async()=>{
 const resolver=vi.fn(async(id:string)=>target(id)),s=await setup({openClawTargetResolver:resolver,openClawTargetSelection:authority()});
 await Promise.all([s.run(s.turn,{workId:'msg_a'}),s.run(s.turn,{workId:'msg_b'})]);
 expect(s.calls).toHaveLength(4);for(const id of['msg_a','msg_b']){const t=target(id),calls=s.calls.filter(c=>c.url===t.gatewayUrl+'/v1/responses');expect(calls).toHaveLength(2);expect(calls.every(c=>new Headers(c.init.headers).get('authorization')==='Bearer '+t.gatewayToken)).toBe(true);}
 expect(await fs.readFile(path.join(s.directory,'session.json'))).toEqual(s.baseline);
 expect((await fs.readdir(path.join(s.directory,'scoped-runs'))).sort()).toEqual(['msg_a.json','msg_b.json']);
 await expect(s.run(s.turn,{workId:'msg_a'})).rejects.toMatchObject({code:'OPENCLAW_TARGET_CLOSED'});expect(s.fetcher).toHaveBeenCalledTimes(4);
 expect(JSON.stringify(s.calls.map(c=>JSON.parse(String(c.init.body))))).not.toMatch(/inert-private|installation_one|case_session_/);
});
it('preserves the saved single-target default when no resolver is supplied',async()=>{
 const s=await setup();await s.run(s.turn,{workId:'legacy_work'});expect(s.calls).toHaveLength(2);
 expect(s.calls.every(c=>c.url==='http://127.0.0.1:19000/v1/responses'&&new Headers(c.init.headers).get('authorization')==='Bearer inert-saved-default')).toBe(true);
 expect(await fs.readFile(path.join(s.directory,'session.json'))).toEqual(s.baseline);
});
it('refuses new target dispatch when a resolver lacks a personal selection authority',async()=>{
 const resolver=vi.fn(async(id:string)=>target(id)),s=await setup({openClawTargetResolver:resolver});await expect(s.run(s.turn,{workId:'msg_a'})).rejects.toMatchObject({code:'PERSONAL_OPENCLAW_TARGET_REVIEW_REQUIRED'});
 expect(resolver).not.toHaveBeenCalled();expect(s.fetcher).not.toHaveBeenCalled();expect(await fs.readFile(path.join(s.directory,'session.json'))).toEqual(s.baseline);
});
