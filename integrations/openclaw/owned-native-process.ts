import fs from 'node:fs/promises';import {spawn,type ChildProcess} from 'node:child_process';import {createHash,randomBytes} from 'node:crypto';
import type {ClosedNativeBinding,ClosedNativeOwnerPorts} from './closed-native-owner';
import type {ClosedNativeBootstrapOptions} from './closed-native-bootstrap';
import {NativePhysicalIntents} from './native-physical-intents';
declare const ownedNativeBrand:unique symbol;
export type OwnedClosedNativeAuthority=Readonly<{[ownedNativeBrand]:true}>;
export interface OwnedClosedNativePins {window:string;workId:string;caseId:string;caseSessionId:string;toolChannelSha256:string;processIdentity:string;
 clientSource:string;nativeSourceSha256:string;capabilitySha256:string;ownerSelectionSha256:string;targetSha256:string;}
type Child=Pick<ChildProcess,'on'|'once'|'off'|'send'|'kill'|'exitCode'|'connected'|'pid'>;
interface State{pins:Readonly<OwnedClosedNativePins>;child:Child;live:boolean;ready:unknown;deadline:number;}
const authorities=new WeakMap<object,State>();
const physicalRows=new WeakMap<object,State>();
export function ownedClosedNativeAuthorityPins(authority:OwnedClosedNativeAuthority,signal:AbortSignal){const state=authorities.get(authority);if(!state)refuse('OWNED_NATIVE_AUTHORITY_REQUIRED');assertOwnedClosedNativeAuthority(authority,state.pins,signal);return state.pins;}
export function assertAuthenticatedNativePhysicalIntent(row:Readonly<Record<string,unknown>>,authority:OwnedClosedNativeAuthority){if(physicalRows.get(row)!==authorities.get(authority)||!authorities.has(authority))throw Error('ACTUAL_OWNED_CHILD_INTENT_REQUIRED');}
const hash=(s:Uint8Array)=>createHash('sha256').update(s).digest('hex');
export function closedNativeManifestDigest(sources:Readonly<Record<string,string>>){return hash(Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(sources).sort(([a],[b])=>a.localeCompare(b))))));}
function refuse(code:string):never{throw Object.assign(new Error(code),{code});}
export function assertOwnedClosedNativeAuthority(authority:OwnedClosedNativeAuthority,expected:Readonly<OwnedClosedNativePins>,signal:AbortSignal){
 signal.throwIfAborted();const state=authorities.get(authority);if(!state||!state.live||state.child.exitCode!==null||!state.child.connected||Date.now()>=state.deadline)refuse('OWNED_NATIVE_AUTHORITY_REQUIRED');
 const keys=Object.keys(state.pins)as(keyof OwnedClosedNativePins)[];
 if(Object.keys(expected).length!==keys.length||keys.some(key=>expected[key]!==state.pins[key]))refuse('OWNED_NATIVE_AUTHORITY_BINDING_MISMATCH');
 return state.ready;
}
export interface OwnedClosedNativeOptions{nodeExecutable:string;childEntry:string;childEntrySha256:string;environment:NodeJS.ProcessEnv;
 nativeEnvironmentFile?:string;
 bootstrap:Omit<ClosedNativeBootstrapOptions,'authorize'|'ports'>;pins:Readonly<OwnedClosedNativePins>;authorize():Promise<void>;
 meterBinding:Readonly<{nativeToken:string;deadlineUnixMs:number}>;
 ports:Pick<ClosedNativeOwnerPorts,'assertLive'|'authorizePhysical'|'recordObservation'|'recordPhysicalOutcome'>;signal:AbortSignal;}
export interface OwnedClosedNativeDependencies{readBytes(file:string):Promise<Uint8Array>;spawnChild(node:string,entry:string,env:NodeJS.ProcessEnv,envFile?:string):Child;nonce():string;}
const real:OwnedClosedNativeDependencies={readBytes:fs.readFile,spawnChild:(node,entry,env,envFile)=>spawn(node,[...(envFile?['--env-file='+envFile]:[]),entry],{env,windowsHide:true,stdio:['ignore','ignore','ignore','ipc']}),nonce:()=>randomBytes(32).toString('hex')};
/** Only this allocator can mint authority; it owns and verifies the exact child IPC channel. */
export async function startOwnedClosedNativeProcess(options:OwnedClosedNativeOptions,deps:OwnedClosedNativeDependencies=real){
 await options.authorize();options.signal.throwIfAborted();options.ports.assertLive(options.bootstrap.binding);
 if(hash(await deps.readBytes(options.childEntry))!==options.childEntrySha256)refuse('REVIEWED_NATIVE_CHILD_SOURCE_REQUIRED');
 const b=options.bootstrap.binding,p=options.pins;
 for(const key of['window','workId','caseId','caseSessionId','toolChannelSha256','processIdentity']as const)if(p[key]!==b[key])refuse('OWNED_NATIVE_AUTHORITY_BINDING_MISMATCH');
 if(!/^[a-f0-9]{40}$/.test(p.clientSource)||![p.nativeSourceSha256,p.capabilitySha256,p.ownerSelectionSha256,p.targetSha256].every(v=>/^[a-f0-9]{64}$/.test(v)))refuse('PERSONAL_NATIVE_RECEIPTS_REQUIRED');
 if(p.nativeSourceSha256!==closedNativeManifestDigest(b.nativeSources)||Object.entries(options.bootstrap.sourceSha256).some(([k,v])=>b.nativeSources[k]!==v))refuse('REVIEWED_NATIVE_SOURCE_ADOPTION_REQUIRED');
 const child=deps.spawnChild(options.nodeExecutable,options.childEntry,options.environment,options.nativeEnvironmentFile),nonce=deps.nonce(),authority=Object.freeze({})as OwnedClosedNativeAuthority;
 let readyResolve!:(v:unknown)=>void,readyReject!:(e:unknown)=>void,exitResolve!:()=>void,closeResolve!:()=>void;
 const ready=new Promise(r=>{readyResolve=r;});const failed=new Promise<never>((_,reject)=>{readyReject=reject;}),exited=new Promise<void>(r=>{exitResolve=r;}),closed=new Promise<void>(r=>{closeResolve=r;});
 const state:State={pins:Object.freeze({...p}),child,live:false,ready:undefined,deadline:b.hardStopUnixMs};let stopping=false,closedAck=false;const seen=new Set<number>(),intents=new Map<string,{bodySha256:string;stage:'intent'|'headers';httpStatus?:number}>();
 const broker=new NativePhysicalIntents(authority,p,b.proxyOrigin,options.signal,()=>options.ports.assertLive(b),options.meterBinding);let harnessAcknowledged:Readonly<Record<string,unknown>>|undefined;
 const send=(message:unknown)=>{if(!child.connected)refuse('OWNED_NATIVE_CHILD_DISCONNECTED');child.send?.(message as any);};
 const stop=()=>{state.live=false;if(!stopping){stopping=true;if(child.connected)send({kind:'stop',nonce});else child.kill('SIGTERM');}};
 const abort=()=>{stop();readyReject(options.signal.reason??new Error('OWNED_NATIVE_START_ABORTED'));};options.signal.addEventListener('abort',abort,{once:true});
 const error=(e:unknown)=>{state.live=false;readyReject(e);if(child.pid===undefined)exitResolve();};child.once('error',error);child.once('exit',()=>{state.live=false;exitResolve();readyReject(new Error('OWNED_NATIVE_CHILD_EXITED'));});
 child.on('message',(message:any)=>{if(message?.nonce!==nonce)return;
  if(message.kind==='ready'){if(state.ready||stopping)return;const r=message.observation;if(!r||r.kind!=='actual_native_gateway_bootstrap_observation'||r.runtimeObservation!=='pending_first_harness'
    ||['window','workId','caseId','caseSessionId','toolChannelSha256','processIdentity'].some(key=>r[key]!==b[key as keyof ClosedNativeBinding])){error(new Error('ACTUAL_NATIVE_CHILD_READY_REQUIRED'));stop();return;}
   state.ready=Object.freeze({...r});state.live=true;authorities.set(authority,state);readyResolve(state.ready);
  }else if(message.kind==='observation'||message.kind==='physical'||message.kind==='physical_outcome'){void(async()=>{try{if(message.kind!=='physical_outcome'){options.signal.throwIfAborted();options.ports.assertLive(b);if(!state.live||stopping)refuse('OWNED_NATIVE_AUTHORITY_REQUIRED');}
    if(!Number.isSafeInteger(message.id)||message.id<1||seen.has(message.id))refuse('OWNED_NATIVE_REQUEST_REPLAY');seen.add(message.id);
    const raw=message.observation;if(!raw||raw.kind!==(message.kind==='physical'?'actual_native_physical_dispatch':message.kind==='physical_outcome'?'actual_native_physical_outcome':'actual_native_harness_registry_observation')||['window','workId','caseId','caseSessionId','toolChannelSha256','processIdentity'].some(key=>raw[key]!==b[key as keyof ClosedNativeBinding]))refuse('ACTUAL_NATIVE_PHYSICAL_BINDING_REQUIRED');const r=Object.freeze({...raw});
    if(message.kind==='physical'){if(typeof r.intentId!=='string'||!/^[a-f0-9]{64}$/.test(r.intentId)||typeof r.bodySha256!=='string'||!/^[a-f0-9]{64}$/.test(r.bodySha256)||intents.has(r.intentId)||!harnessAcknowledged
      ||['registrySha256','configurationSha256','pluginRegistrySha256'].some(k=>r[k]!==harnessAcknowledged![k]))refuse('NATIVE_PHYSICAL_INTENT_REQUIRED');physicalRows.set(r,state);broker.authorizePhysical(r);
      try{await options.ports.authorizePhysical(r,options.signal);}catch(error){broker.refuseBeforeDispatch(r.intentId);throw error;}intents.set(r.intentId,{bodySha256:r.bodySha256,stage:'intent'});}
    else if(message.kind==='physical_outcome'){const intent=intents.get(r.intentId);if(!intent||intent.bodySha256!==r.bodySha256||!['headers','body_drained','lost','aborted'].includes(r.stage)
      ||r.stage==='headers'&&(intent.stage!=='intent'||!Number.isInteger(r.httpStatus)||r.httpStatus<100||r.httpStatus>599)
      ||r.stage==='body_drained'&&(intent.stage!=='headers'||r.httpStatus!==intent.httpStatus))refuse('NATIVE_PHYSICAL_INTENT_REQUIRED');await options.ports.recordPhysicalOutcome(r);broker.recordPhysicalOutcome(r);if(r.stage==='headers'){intent.stage='headers';intent.httpStatus=r.httpStatus;}else intents.delete(r.intentId);}
    else{if(['registrySha256','configurationSha256','pluginRegistrySha256'].some(k=>typeof r[k]!=='string'||!/^[a-f0-9]{64}$/.test(r[k])))refuse('ACTUAL_NATIVE_HARNESS_OBSERVATION_REQUIRED');await options.ports.recordObservation(r);harnessAcknowledged=r;}send({kind:message.kind+'_result',id:message.id,nonce});
   }catch{if(child.connected)send({kind:message.kind+'_result',id:message.id,nonce,error:'NATIVE_PHYSICAL_DISPATCH_REFUSED'});stop();}})();
  }else if(message.kind==='closed'){state.live=false;closedAck=true;closeResolve();}else if(message.kind==='failed'){error(new Error('OWNED_NATIVE_CHILD_FAILED'));stop();}
 });
 const timer=setTimeout(()=>{error(new Error('OWNED_NATIVE_BOOTSTRAP_TIMEOUT'));stop();},Math.max(1,Math.min(90000,b.hardStopUnixMs-Date.now())));
 const deadlineTimer=setTimeout(stop,Math.max(1,b.hardStopUnixMs-Date.now()));
 const waitForExit=async()=>{let timeout:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([exited,new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('OWNED_NATIVE_EXIT_UNVERIFIED')),35000);})]);}finally{clearTimeout(timeout);}};
 try{send({kind:'start',nonce,bootstrap:options.bootstrap});await Promise.race([ready,failed]);clearTimeout(timer);
  return{authority,readiness:()=>assertOwnedClosedNativeAuthority(authority,p,options.signal),physicalIntents:Object.freeze({takeForMeter:broker.takeForMeter.bind(broker),takeForProxy:broker.takeForProxy.bind(broker),proxyEvent:broker.proxyEvent.bind(broker),snapshot:broker.snapshot.bind(broker),assertDrained:broker.assertDrained.bind(broker)}),async close(){stop();const cleanupTimer=setTimeout(()=>child.kill('SIGTERM'),30000);try{await waitForExit();if(!closedAck||intents.size)refuse('OWNED_NATIVE_CLEANUP_UNVERIFIED');broker.assertDrained();await closed;}finally{clearTimeout(cleanupTimer);clearTimeout(deadlineTimer);options.signal.removeEventListener('abort',abort);}}};
 }catch(e){clearTimeout(timer);clearTimeout(deadlineTimer);stop();options.signal.removeEventListener('abort',abort);child.kill('SIGTERM');try{await waitForExit();}catch(cleanup){throw new AggregateError([e,cleanup],'Owned native startup and cleanup failed');}throw e;}
}
