import vm from 'node:vm';import path from 'node:path';import {createHash} from 'node:crypto';import {EventEmitter} from 'node:events';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import originals from './native-observer-sources.fixture.json';
import {prepareNativeObserverPatch,NATIVE_OBSERVER_MODULE,OBSERVED_INITIALIZE_MODEL_REGISTRY} from './native-observer-patch';
import {createClosedNativeOwner,type ClosedNativeBinding} from './closed-native-owner';
import {startClosedNativeGateway,CLOSED_NATIVE_BOOTSTRAP_FILES} from './closed-native-bootstrap';
import {startOwnedClosedNativeProcess,assertOwnedClosedNativeAuthority,closedNativeManifestDigest,type OwnedClosedNativePins} from './owned-native-process';
import {assertRestrictedNativeConfiguration,assertRestrictedNativeEnvironment} from './closed-native-policy';
import {NativePhysicalIntents} from './native-physical-intents';
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-02T23:55:00Z'));});afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
function binding(id='a'):ClosedNativeBinding{return{window:'a'.repeat(64),workId:'msg_'+id,caseId:'case_'+id,caseSessionId:'case_session_'+id,toolChannelSha256:'b'.repeat(64),processIdentity:'owned_'+id,
 stateDirectorySha256:'c'.repeat(64),configurationPathSha256:'d'.repeat(64),workspaceSha256:'e'.repeat(64),agentStateSha256:'f'.repeat(64),nativeAgentId:'main',modelId:'claude-haiku-4-5-20251001',proxyOrigin:'http://127.0.0.1:'+(id==='a'?42001:42002),hardStopUnixMs:Date.now()+90000,nativeSources:{patch:'1'.repeat(64),packageTree:'2'.repeat(64)}};}
const model=(b:ClosedNativeBinding)=>({id:b.modelId,provider:'anthropic',api:'anthropic-messages',baseUrl:b.proxyOrigin});
const physical=(b:ClosedNativeBinding)=>({method:'POST',headers:{'x-api-key':'INERT_NOT_A_KEY','anthropic-version':'2023-06-01'},body:JSON.stringify({model:b.modelId,messages:[]})});
function ownerSample(id='a'){
 const b=binding(id),config={inert:'actual-object'},plugins={plugins:[],providers:[],agentHarnesses:[]},calls:any[]=[],records:any[]=[],reserved:any[]=[];
 const upstream=vi.fn<typeof fetch>(async(input,init)=>{calls.push({input,init});return new Response('inert response',{status:200});});
 const ports={assertLive:vi.fn(),assertEffectiveConfiguration:vi.fn(),recordObservation:vi.fn(async r=>{records.push(r);}),authorizePhysical:vi.fn(async r=>{reserved.push(r);}),recordPhysicalOutcome:vi.fn(async()=>{})};
 const owner=createClosedNativeOwner(b,{buildModelFetch:()=>upstream},{getRuntimeConfig:()=>config,getActivePluginRegistry:()=>plugins,listImportedRuntimePluginIds:()=>[]},ports);
 const registrations=[{api:'anthropic-messages',sourceId:'core:built-in'}],nativeOwner={},view={runtime:{actualRuntime:true},registry:{getApiProviders:()=>registrations.map(r=>({api:r.api}))},readRegistrations:()=>registrations};
 owner.observer.modelRegistryCreated(nativeOwner,view);
 const harness=()=>owner.observer.beforeHarness({harnessId:'openclaw',builtIn:true,modelRegistry:nativeOwner,model:model(b),provider:'anthropic',modelId:b.modelId,agentId:'main'});
 return{b,owner,ports,calls,records,reserved,upstream,config,plugins,registrations,harness,nativeOwner,view};
}
it('patches only exact native code bytes, preserving installed source inputs',()=>{
 const before=JSON.stringify(originals.files),patched=prepareNativeObserverPatch(originals.files);expect(JSON.stringify(originals.files)).toBe(before);
 expect(Object.keys(patched)).toHaveLength(3);expect(patched['model-registry-Bc1CKDx-.mjs']).toContain('createNodeLlmRuntime(apiRegistry,observer.transportHost)');
 expect(patched['selection-BCmRjyeC.mjs']).toContain('modelRegistry:params.modelRegistry');expect(patched[NATIVE_OBSERVER_MODULE]).toContain('NATIVE_OBSERVER_ALREADY_INSTALLED');
 expect(()=>prepareNativeObserverPatch({...originals.files,'selection-BCmRjyeC.mjs':originals.files['selection-BCmRjyeC.mjs']+' '})).toThrow('PINNED_NATIVE_SOURCE_REQUIRED');
});
it('executes the actual proposed native runtime factory callback body and retains real registration source arguments',()=>{
 const s=ownerSample(),nativeOwner={};let capturedHost:unknown;
 const context=vm.createContext({Map,Object,getClosedNativeObserver:()=>s.owner.observer,modelRegistryRuntimes:new WeakMap(),
  createApiRegistry:()=>{const values=new Map<string,any>();return{registerApiProvider:(p:any)=>values.set(p.api,p),getApiProviders:()=>[...values.values()],clearApiProviders:()=>values.clear(),unregisterApiProviders:()=>values.clear()};},
  createNodeLlmRuntime:(registry:any,host:unknown)=>{capturedHost=host;return{streamSimple(){},registry};},createLlmRuntime:()=>{throw Error('MUST_CAPTURE_GATE_HOST');},runPluginStreamConsumer(){},bindStreamLlmRuntime(){},
  resetApiRegistry:(r:any)=>r.apiRegistry.registerApiProvider({api:'anthropic-messages'},'core:built-in')});
 vm.runInContext(OBSERVED_INITIALIZE_MODEL_REGISTRY,context);context.owner=nativeOwner;vm.runInContext('initializeModelRegistryRuntime(owner)',context);expect(capturedHost).toBe(s.owner.transportHost);
 expect(()=>vm.runInContext('modelRegistryRuntimes.get(owner).apiRegistry.registerApiProvider({api:"anthropic-messages"},"provider:custom")',context)).toThrow('ACTUAL_NATIVE_CUSTOM_REGISTRY_REFUSED');
});
it('has no loaded-runtime proof before real native callbacks and gates every physical primary/helper/summary/retry',async()=>{
 const s=ownerSample();expect(s.owner.snapshot()).toBeUndefined();expect(s.owner.readiness()).toMatchObject({runtimeObservation:'pending_first_harness'});
 const fetcher=s.owner.transportHost.buildModelFetch(model(s.b));await expect(fetcher(s.b.proxyOrigin+'/v1/messages',physical(s.b))).rejects.toThrow('ACTUAL_NATIVE_HARNESS_OBSERVATION_REQUIRED');expect(s.reserved).toHaveLength(0);
 await s.harness();expect(s.owner.snapshot()).toMatchObject({kind:'actual_native_harness_registry_observation',processIdentity:s.b.processIdentity});
 for(const _kind of['primary','helper','summary','retry']){const r=await fetcher(s.b.proxyOrigin+'/v1/messages',physical(s.b));expect(s.owner.pending()).toBeGreaterThan(0);await r.text();}
 expect(s.reserved).toHaveLength(4);expect(s.owner.pending()).toBe(0);expect(s.calls.every(c=>c.init.redirect==='error'&&new Headers(c.init.headers).get('x-api-key')==='INERT_NOT_A_KEY')).toBe(true);
 expect(JSON.stringify(s.records)).not.toContain('INERT_NOT_A_KEY');
});
it('preserves immutable A/B attribution and refuses closed A while B remains live',async()=>{
 const a=ownerSample(),b=ownerSample('b');await a.harness();await b.harness();const fa=a.owner.transportHost.buildModelFetch(model(a.b)),fb=b.owner.transportHost.buildModelFetch(model(b.b));
 await(await fa(a.b.proxyOrigin+'/v1/messages',physical(a.b))).text();a.owner.close();await expect(fa(a.b.proxyOrigin+'/v1/messages',physical(a.b))).rejects.toThrow('CLOSED_NATIVE_PROCESS_ENDED');
 await(await fb(b.b.proxyOrigin+'/v1/messages',physical(b.b))).text();expect(a.reserved.every(r=>r.workId==='msg_a')).toBe(true);expect(b.reserved.every(r=>r.workId==='msg_b')).toBe(true);
});
it('rejects unknown actual owner, custom harness, model/provider/registry/plugin/config drift and foreign physical routes',async()=>{
 const s=ownerSample();await expect(s.owner.observer.beforeHarness({harnessId:'custom',builtIn:false,modelRegistry:{},model:model(s.b),provider:'anthropic',modelId:s.b.modelId,agentId:'main'})).rejects.toThrow('ACTUAL_NATIVE_HARNESS_REFUSED');
 await expect(s.owner.observer.beforeHarness({harnessId:'openclaw',builtIn:true,modelRegistry:{},model:model(s.b),provider:'anthropic',modelId:s.b.modelId,agentId:'main'})).rejects.toThrow('ACTUAL_NATIVE_RUNTIME_OWNER_REQUIRED');
 await s.harness();const fetcher=s.owner.transportHost.buildModelFetch(model(s.b));await expect(fetcher('https://api.anthropic.com/v1/messages',physical(s.b))).rejects.toThrow('ACTUAL_NATIVE_PHYSICAL_ROUTE_REFUSED');
 await expect(fetcher(s.b.proxyOrigin+'/v1/messages',{...physical(s.b),body:'{"model":"foreign","messages":[]}'})).rejects.toThrow('ACTUAL_NATIVE_PHYSICAL_BODY_REFUSED');
 s.registrations.push({api:'custom',sourceId:'provider:custom'});await expect(fetcher(s.b.proxyOrigin+'/v1/messages',physical(s.b))).rejects.toThrow('ACTUAL_NATIVE_HARNESS_OBSERVATION_REQUIRED');expect(s.reserved).toHaveLength(0);
});
it('awaits parent verification before releasing a native harness and refuses durable reservation failure',async()=>{
 const s=ownerSample();let release!:()=>void;s.ports.recordObservation.mockImplementation(async()=>new Promise<void>(r=>{release=r;}));const proof=s.harness();await Promise.resolve();expect(s.owner.snapshot()).toBeUndefined();release();await proof;
 s.ports.authorizePhysical.mockRejectedValue(new Error('CAP_REACHED'));await expect(s.owner.transportHost.buildModelFetch(model(s.b))(s.b.proxyOrigin+'/v1/messages',physical(s.b))).rejects.toThrow('CAP_REACHED');expect(s.upstream).not.toHaveBeenCalled();expect(s.owner.pending()).toBe(0);
});
it('charges uncertain native attempts without retrying them and aborts/drains an owned response on close',async()=>{
 const s=ownerSample();await s.harness();const fetcher=s.owner.transportHost.buildModelFetch(model(s.b));s.upstream.mockRejectedValueOnce(new Error('UNCERTAIN_NETWORK_RESULT'));
 await expect(fetcher(s.b.proxyOrigin+'/v1/messages',physical(s.b))).rejects.toThrow('UNCERTAIN_NETWORK_RESULT');expect(s.reserved).toHaveLength(1);expect(s.upstream).toHaveBeenCalledTimes(1);expect(s.owner.pending()).toBe(0);
 const response=await fetcher(s.b.proxyOrigin+'/v1/messages',physical(s.b));expect(s.owner.pending()).toBe(1);s.owner.close();await response.body!.cancel();await Promise.resolve();expect(s.owner.pending()).toBe(0);
});
it('refuses paused/revoked/deadline requests before dispatch and never uses a spoofed physical work header as authority',async()=>{
 const s=ownerSample();await s.harness();const fetcher=s.owner.transportHost.buildModelFetch(model(s.b));await(await fetcher(s.b.proxyOrigin+'/v1/messages',{...physical(s.b),headers:{'x-envoi-meter-work':'msg_foreign'}})).text();expect(s.reserved[0].workId).toBe(s.b.workId);
 s.ports.assertLive.mockImplementation(()=>{throw Error('OWNER_PAUSED');});await expect(fetcher(s.b.proxyOrigin+'/v1/messages',physical(s.b))).rejects.toThrow('OWNER_PAUSED');s.ports.assertLive.mockImplementation(()=>{});vi.advanceTimersByTime(90000);await expect(fetcher(s.b.proxyOrigin+'/v1/messages',physical(s.b))).rejects.toThrow('NATIVE_DEADLINE_EXPIRED');expect(s.reserved).toHaveLength(1);
});
it('refuses unsupported effective selector/environment state without changing actual config',()=>{
 const b=binding(),config={plugins:{enabled:false},models:{mode:'replace',providers:{anthropic:{api:'anthropic-messages',baseUrl:b.proxyOrigin,models:[{id:b.modelId}]}}},agents:{defaults:{model:{primary:'anthropic/'+b.modelId,fallbacks:[]}},list:[{id:'main'}]},tools:{profile:'minimal',deny:['*']},gateway:{reload:{mode:'off'}}};
 expect(()=>assertRestrictedNativeConfiguration(config,b)).not.toThrow();expect(()=>assertRestrictedNativeConfiguration({...config,plugins:{enabled:true}},b)).toThrow();expect(()=>assertRestrictedNativeEnvironment({NODE_OPTIONS:'--import unreviewed'})).toThrow();
});
it('orders real Gateway bootstrap module seams after source/path authorization and exposes pending-harness readiness honestly',async()=>{
 const b=binding(),s=ownerSample(),paths={stateDirectory:path.resolve('inert/state'),configurationPath:path.resolve('inert/config'),workspace:path.resolve('inert/workspace'),agentState:path.resolve('inert/agent')};
 for(const k of Object.keys(paths)as(keyof typeof paths)[])b[(k+'Sha256')as keyof ClosedNativeBinding]=hash(paths[k])as never;
 const sourceSha256=Object.fromEntries(Object.keys(CLOSED_NATIVE_BOOTSTRAP_FILES).map(k=>[k,hash(k)]))as any,order:string[]=[],gatewayClose=vi.fn(async()=>{});let installed:any,activeHost:any={buildModelFetch:()=>vi.fn()};
 Object.assign(b.nativeSources,sourceSha256);
 const result=await startClosedNativeGateway({nativeRoot:path.resolve('inert/native'),binding:b,paths,port:19000,sourceSha256,authorize:async()=>{order.push('authorized');},ports:s.ports},{readPathEnvironment:()=>paths,readBytes:async f=>Buffer.from(Object.entries(CLOSED_NATIVE_BOOTSTRAP_FILES).find(([,p])=>f.endsWith(path.normalize(p)))![0]),loadModule:async f=>{
  const role=Object.entries(CLOSED_NATIVE_BOOTSTRAP_FILES).find(([,p])=>f.endsWith(path.normalize(p)))![0];order.push(role);
  if(role==='host')return{getDefaultAiTransportHost:()=>activeHost,configureAiTransportHost:(h:any)=>{activeHost=h;}};
  if(role==='observer')return{installClosedNativeObserver:(v:any)=>{installed=v;},getClosedNativeObserver:()=>installed};if(role==='config')return{r:()=>s.config,i:()=>s.config};if(role==='plugins')return{l:()=>s.plugins,m:()=>[]};if(role==='server')return{startGatewayServer:async()=>({close:gatewayClose,startupSettled:Promise.resolve()})};return{};
 }});
 expect(order.slice(0,4)).toEqual(['authorized','host','coreHost','runtimeHost']);expect(result.readiness()).toMatchObject({runtimeObservation:'pending_first_harness'});expect(result.snapshot()).toBeUndefined();await result.close();expect(gatewayClose).toHaveBeenCalledTimes(1);
});
it('checks all26 bootstrap/selector hashes before any import and refuses every individual drift or missing source pin without a per-child tree scan',async()=>{
 expect(Object.keys(CLOSED_NATIVE_BOOTSTRAP_FILES)).toHaveLength(26);
 for(const changed of Object.keys(CLOSED_NATIVE_BOOTSTRAP_FILES)){
  const b=binding(),paths={stateDirectory:path.resolve('inert/state'),configurationPath:path.resolve('inert/config'),workspace:path.resolve('inert/workspace'),agentState:path.resolve('inert/agent')};
  for(const k of Object.keys(paths)as(keyof typeof paths)[])b[(k+'Sha256')as keyof ClosedNativeBinding]=hash(paths[k])as never;
  const sourceSha256=Object.fromEntries(Object.keys(CLOSED_NATIVE_BOOTSTRAP_FILES).map(k=>[k,hash(k)]))as any;Object.assign(b.nativeSources,sourceSha256);const loadModule=vi.fn(),readBytes=vi.fn(async(file:string)=>{const role=Object.entries(CLOSED_NATIVE_BOOTSTRAP_FILES).find(([,p])=>file.endsWith(path.normalize(p)))![0];return Buffer.from(role===changed?'CHANGED_CODE':role);});
  await expect(startClosedNativeGateway({nativeRoot:path.resolve('inert/native'),binding:b,paths,port:19000,sourceSha256,authorize:async()=>{},ports:ownerSample().ports},{readBytes,readPathEnvironment:()=>paths,loadModule})).rejects.toThrow('REVIEWED_NATIVE_SOURCE_ADOPTION_REQUIRED');expect(loadModule).not.toHaveBeenCalled();expect(readBytes.mock.calls.every(([file])=>Object.values(CLOSED_NATIVE_BOOTSTRAP_FILES).some(p=>file.endsWith(path.normalize(p))))).toBe(true);
  delete b.nativeSources[changed];await expect(startClosedNativeGateway({nativeRoot:path.resolve('inert/native'),binding:b,paths,port:19000,sourceSha256,authorize:async()=>{},ports:ownerSample().ports},{readBytes:async file=>Buffer.from(Object.entries(CLOSED_NATIVE_BOOTSTRAP_FILES).find(([,p])=>file.endsWith(path.normalize(p)))![0]),readPathEnvironment:()=>paths,loadModule})).rejects.toThrow('REVIEWED_NATIVE_SOURCE_ADOPTION_REQUIRED');expect(loadModule).not.toHaveBeenCalled();
 }
});
class FakeChild extends EventEmitter{pid:number|undefined=123;exitCode:number|null=null;connected=true;sent:any[]=[];send(m:any){this.sent.push(m);if(m.kind==='start')queueMicrotask(()=>this.emit('message',{kind:'ready',nonce:m.nonce,observation:{...m.bootstrap.binding,kind:'actual_native_gateway_bootstrap_observation',runtimeObservation:'pending_first_harness'}}));if(m.kind==='stop')queueMicrotask(()=>{this.emit('message',{kind:'closed',nonce:m.nonce});this.exitCode=0;this.connected=false;this.emit('exit',0);});return true;}kill(){this.exitCode=1;this.connected=false;this.emit('exit',1);return true;}}
it('mints a parent authority only through its exact owned child channel; plain metadata and foreign pins cannot substitute',async()=>{
 const b=binding(),pins:OwnedClosedNativePins={window:b.window,workId:b.workId,caseId:b.caseId,caseSessionId:b.caseSessionId,toolChannelSha256:b.toolChannelSha256,processIdentity:b.processIdentity,clientSource:'a'.repeat(40),nativeSourceSha256:closedNativeManifestDigest(b.nativeSources),capabilitySha256:'c'.repeat(64),ownerSelectionSha256:'d'.repeat(64),targetSha256:'e'.repeat(64)},child=new FakeChild(),signal=new AbortController().signal,ports=ownerSample().ports;
 const process=await startOwnedClosedNativeProcess({nodeExecutable:'inert-node',childEntry:'inert-entry',childEntrySha256:hash('entry'),environment:{},meterBinding:{nativeToken:'inert-native-token',deadlineUnixMs:b.hardStopUnixMs},bootstrap:{nativeRoot:'inert',binding:b,port:19000,paths:{}as any,sourceSha256:{}as any},pins,authorize:async()=>{},ports,signal},{readBytes:async()=>Buffer.from('entry'),spawnChild:()=>child as any,nonce:()=> 'a'.repeat(64)});
 expect(()=>assertOwnedClosedNativeAuthority({}as any,pins,signal)).toThrow('OWNED_NATIVE_AUTHORITY_REQUIRED');expect(()=>assertOwnedClosedNativeAuthority(process.authority,{...pins,workId:'msg_foreign'},signal)).toThrow('OWNED_NATIVE_AUTHORITY_BINDING_MISMATCH');expect(process.readiness()).toMatchObject({processIdentity:b.processIdentity});
 await process.close();expect(()=>assertOwnedClosedNativeAuthority(process.authority,pins,signal)).toThrow('OWNED_NATIVE_AUTHORITY_REQUIRED');
});
it('refuses entry/source drift before starting any child',async()=>{
 const b=binding(),spawn=vi.fn(),pins={window:b.window,workId:b.workId,caseId:b.caseId,caseSessionId:b.caseSessionId,toolChannelSha256:b.toolChannelSha256,processIdentity:b.processIdentity,clientSource:'a'.repeat(40),nativeSourceSha256:closedNativeManifestDigest(b.nativeSources),capabilitySha256:'c'.repeat(64),ownerSelectionSha256:'d'.repeat(64),targetSha256:'e'.repeat(64)};
 await expect(startOwnedClosedNativeProcess({nodeExecutable:'inert',childEntry:'inert',childEntrySha256:hash('wrong'),environment:{},meterBinding:{nativeToken:'inert-native-token',deadlineUnixMs:b.hardStopUnixMs},bootstrap:{nativeRoot:'inert',binding:b,port:1,paths:{}as any,sourceSha256:{}as any},pins,authorize:async()=>{},ports:ownerSample().ports,signal:new AbortController().signal},{readBytes:async()=>Buffer.from('entry'),spawnChild:spawn,nonce:()=> 'a'.repeat(64)})).rejects.toThrow('REVIEWED_NATIVE_CHILD_SOURCE_REQUIRED');expect(spawn).not.toHaveBeenCalled();
});
it('acknowledges actual harness evidence only after parent verification, then reserves each physical dispatch once',async()=>{
 const b=binding(),pins={window:b.window,workId:b.workId,caseId:b.caseId,caseSessionId:b.caseSessionId,toolChannelSha256:b.toolChannelSha256,processIdentity:b.processIdentity,clientSource:'a'.repeat(40),nativeSourceSha256:closedNativeManifestDigest(b.nativeSources),capabilitySha256:'c'.repeat(64),ownerSelectionSha256:'d'.repeat(64),targetSha256:'e'.repeat(64)},child=new FakeChild(),ports=ownerSample().ports;
 let release!:()=>void;ports.recordObservation.mockImplementation(async()=>new Promise<void>(r=>{release=r;}));
 const p=await startOwnedClosedNativeProcess({nodeExecutable:'inert',childEntry:'inert',childEntrySha256:hash('entry'),environment:{},meterBinding:{nativeToken:'inert-native-token',deadlineUnixMs:b.hardStopUnixMs},bootstrap:{nativeRoot:'inert',binding:b,port:1,paths:{}as any,sourceSha256:{}as any},pins,authorize:async()=>{},ports,signal:new AbortController().signal},{readBytes:async()=>Buffer.from('entry'),spawnChild:()=>child as any,nonce:()=> 'a'.repeat(64)});
 const intents=p.physicalIntents,durableMeterReserve=vi.fn();expect(()=>new NativePhysicalIntents(p.authority,pins,b.proxyOrigin,new AbortController().signal,()=>{}).authorizePhysical({...b,kind:'actual_native_physical_dispatch',intentId:hash('forged'),bodySha256:hash('body'),requestOrigin:b.proxyOrigin,requestPath:'/v1/messages'})).toThrow('ACTUAL_OWNED_CHILD_INTENT_REQUIRED');
 child.emit('message',{kind:'observation',id:1,nonce:'a'.repeat(64),observation:{...b,kind:'actual_native_harness_registry_observation',registrySha256:hash('registry'),configurationSha256:hash('config'),pluginRegistrySha256:hash('plugins')}});await Promise.resolve();expect(child.sent.some(m=>m.kind==='observation_result')).toBe(false);release();await Promise.resolve();await Promise.resolve();expect(child.sent.some(m=>m.kind==='observation_result'&&m.id===1)).toBe(true);
 child.emit('message',{kind:'physical',id:2,nonce:'a'.repeat(64),observation:{...b,kind:'actual_native_physical_dispatch',registrySha256:hash('registry'),configurationSha256:hash('config'),pluginRegistrySha256:hash('plugins'),intentId:hash('intent_a'),bodySha256:hash('body'),requestOrigin:b.proxyOrigin,requestPath:'/v1/messages'}});await Promise.resolve();await Promise.resolve();expect(ports.authorizePhysical).toHaveBeenCalledTimes(1);expect(child.sent.some(m=>m.kind==='physical_result'&&m.id===2)).toBe(true);
 expect(durableMeterReserve).not.toHaveBeenCalled();expect(()=>intents.takeForProxy(Buffer.from('foreign'))).toThrow('OWNED_NATIVE_BODY_INTENT_REQUIRED');const ticket=intents.takeForMeter({role:'openclaw',nativeToken:'inert-native-token',window:b.window,bodySha256:hash('body'),deadlineUnixMs:b.hardStopUnixMs},new AbortController().signal);durableMeterReserve(ticket);intents.proxyEvent(ticket.intentId,{phase:'reserved',reservationId:'reservation_1'});intents.proxyEvent(ticket.intentId,{phase:'not_forwarded',reservationId:'reservation_1'});expect(()=>intents.proxyEvent(ticket.intentId,{phase:'dispatched',reservationId:'reservation_1'})).toThrow('NATIVE_PROXY_DISPATCH_ORDER_REQUIRED');expect(()=>intents.takeForProxy(Buffer.from('body'))).toThrow();expect(durableMeterReserve).toHaveBeenCalledTimes(1);
 child.emit('message',{kind:'physical_outcome',id:3,nonce:'a'.repeat(64),observation:{...b,kind:'actual_native_physical_outcome',intentId:hash('intent_a'),bodySha256:hash('body'),stage:'headers',httpStatus:200}});await Promise.resolve();await Promise.resolve();child.emit('message',{kind:'physical_outcome',id:4,nonce:'a'.repeat(64),observation:{...b,kind:'actual_native_physical_outcome',intentId:hash('intent_a'),bodySha256:hash('body'),stage:'body_drained',httpStatus:200}});await Promise.resolve();await Promise.resolve();intents.assertDrained();await p.close();
});
