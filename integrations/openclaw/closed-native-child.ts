// Entry for a NEW exact source-reviewed owned native process; never import on an owner host.
import {startClosedNativeGateway} from './closed-native-bootstrap';
import {assertRestrictedNativeConfiguration,assertRestrictedNativeEnvironment,CLOSED_NATIVE_FORBIDDEN_ENV} from './closed-native-policy';
let started=false,nonce='',gateway:Awaited<ReturnType<typeof startClosedNativeGateway>>|undefined,sequence=0;
let booting:Promise<Awaited<ReturnType<typeof startClosedNativeGateway>>>|undefined;
const pending=new Map<number,{resolve():void;reject(e:unknown):void}>();
const control=new AbortController();
const send=(m:unknown)=>{if(!process.connected)throw Error('OWNED_NATIVE_PARENT_REQUIRED');process.send?.(m as any);};
process.on('disconnect',()=>{control.abort();for(const p of pending.values())p.reject(new Error('OWNED_NATIVE_PARENT_DISCONNECTED'));pending.clear();void(async()=>{try{await booting?.catch(()=>undefined);await gateway?.close();}finally{process.exit(1);}})();});
process.on('message',(m:any)=>{void(async()=>{
 if(m?.kind==='start'){
  if(started||typeof m.nonce!=='string'||!/^[a-f0-9]{64}$/.test(m.nonce))throw Error('SINGLE_OWNED_NATIVE_START_REQUIRED');started=true;nonce=m.nonce;
  assertRestrictedNativeEnvironment(Object.fromEntries(CLOSED_NATIVE_FORBIDDEN_ENV.map(k=>[k,process.env[k]])));
  const binding=m.bootstrap.binding;
  booting=startClosedNativeGateway({...m.bootstrap,authorize:async()=>{if(!process.connected||!nonce)throw Error('OWNED_NATIVE_PARENT_REQUIRED');},ports:{
   assertLive:()=>{control.signal.throwIfAborted();if(Date.now()>=binding.hardStopUnixMs)throw Error('NATIVE_DEADLINE_EXPIRED');},
   assertEffectiveConfiguration:c=>assertRestrictedNativeConfiguration(c,binding),
   recordObservation:async observation=>{const id=++sequence;await new Promise<void>((resolve,reject)=>{pending.set(id,{resolve,reject});send({kind:'observation',id,nonce,observation});});},
   recordPhysicalOutcome:async observation=>{const id=++sequence;await new Promise<void>((resolve,reject)=>{pending.set(id,{resolve,reject});send({kind:'physical_outcome',id,nonce,observation});});},
   authorizePhysical:async(observation,signal)=>{signal.throwIfAborted();const id=++sequence;await new Promise<void>((resolve,reject)=>{const abort=()=>{pending.delete(id);reject(signal.reason);};signal.addEventListener('abort',abort,{once:true});pending.set(id,{resolve:()=>{signal.removeEventListener('abort',abort);resolve();},reject:e=>{signal.removeEventListener('abort',abort);reject(e);}});send({kind:'physical',id,nonce,observation});});}
  }});gateway=await booting;send({kind:'ready',nonce,observation:gateway.readiness()});
 }else if(m?.nonce===nonce&&(m.kind==='physical_result'||m.kind==='observation_result'||m.kind==='physical_outcome_result')){const p=pending.get(m.id);pending.delete(m.id);if(m.error)p?.reject(new Error('NATIVE_PHYSICAL_DISPATCH_REFUSED'));else p?.resolve();
 }else if(m?.nonce===nonce&&m.kind==='stop'){control.abort();for(const p of pending.values())p.reject(new Error('OWNED_NATIVE_STOPPED'));pending.clear();await booting?.catch(()=>undefined);await gateway?.close();send({kind:'closed',nonce});process.disconnect();process.exit(0);}
 })().catch(()=>{if(process.connected)send({kind:'failed',nonce});control.abort();void gateway?.close().finally(()=>process.exit(1));});});
