import {createHash} from 'node:crypto';
type NativeModel=Readonly<{id:string;provider:string;api:string;baseUrl:string}>;
type Registration=Readonly<{api:string;sourceId:string}>;
type RegistryView=Readonly<{runtime:object;registry:{getApiProviders():readonly {api:string}[]};readRegistrations():readonly Registration[]}>;
type Host=Record<string,unknown>&{buildModelFetch(model:NativeModel,...args:unknown[]):typeof fetch};
export interface ClosedNativeBinding {window:string;workId:string;caseId:string;caseSessionId:string;toolChannelSha256:string;processIdentity:string;stateDirectorySha256:string;configurationPathSha256:string;workspaceSha256:string;agentStateSha256:string;nativeAgentId:string;modelId:string;proxyOrigin:string;hardStopUnixMs:number;nativeSources:Readonly<Record<string,string>>}
export interface ActualNativeReaders {
  /** These readers execute in the actual Gateway process; never substitute config projections. */
  getRuntimeConfig():unknown;
  getActivePluginRegistry():unknown;
  listImportedRuntimePluginIds():readonly string[];
}
export interface ClosedNativeOwnerPorts {
  assertLive(binding:Readonly<ClosedNativeBinding>):void;
  assertEffectiveConfiguration(actual:unknown):void;
  /** Provenance authorization ONLY. The proxy is the sole durable reservation owner. */
  authorizePhysical(observation:Readonly<Record<string,unknown>>,signal:AbortSignal):Promise<void>;
  recordPhysicalOutcome(observation:Readonly<Record<string,unknown>>):Promise<void>;
  recordObservation(observation:Readonly<Record<string,unknown>>):Promise<void>;
}
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
function refuse(code:string):never{throw Object.assign(new Error(code),{code});}

/** One immutable owner for one real native process; has no Envoi credential store. */
export function createClosedNativeOwner(binding:Readonly<ClosedNativeBinding>,baseHost:Host,readers:ActualNativeReaders,ports:ClosedNativeOwnerPorts){
 const b=Object.freeze({...binding,nativeSources:Object.freeze({...binding.nativeSources})}),stop=new AbortController(),registries=new WeakMap<object,RegistryView>();
 let current:Readonly<Record<string,unknown>>|undefined,currentView:RegistryView|undefined,pending=0,unknown=0,sequence=0;
 const live=()=>{stop.signal.throwIfAborted();if(Date.now()>=b.hardStopUnixMs)refuse('NATIVE_DEADLINE_EXPIRED');ports.assertLive(b);};
 const actual=()=>{live();const config=readers.getRuntimeConfig();ports.assertEffectiveConfiguration(config);
  const registry=readers.getActivePluginRegistry() as {plugins?:unknown[];providers?:unknown[];agentHarnesses?:unknown[]}|undefined;
  if(!registry||!Array.isArray(registry.plugins)||registry.plugins.length||readers.listImportedRuntimePluginIds().length
    ||Array.isArray(registry.providers)&&registry.providers.length||Array.isArray(registry.agentHarnesses)&&registry.agentHarnesses.length)refuse('ACTUAL_NATIVE_PLUGIN_STATE_REFUSED');
  return{configurationSha256:hash(config),pluginRegistrySha256:hash({plugins:registry.plugins,providers:registry.providers??[],agentHarnesses:registry.agentHarnesses??[]})};};
 const model=(m:NativeModel)=>{if(!m||m.provider!=='anthropic'||m.api!=='anthropic-messages'||m.id!==b.modelId||new URL(m.baseUrl).origin!==b.proxyOrigin)refuse('ACTUAL_NATIVE_MODEL_ROUTE_REFUSED');};
 const host=Object.freeze({...baseHost,buildModelFetch(m:NativeModel,...args:unknown[]){model(m);const upstream=baseHost.buildModelFetch(m,...args);
  return async(input,init={})=>{live();model(m);const observed=actual();if(!current||!currentView||current.registrySha256!==hash(currentView.readRegistrations())||current.configurationSha256!==observed.configurationSha256||current.pluginRegistrySha256!==observed.pluginRegistrySha256)refuse('ACTUAL_NATIVE_HARNESS_OBSERVATION_REQUIRED');
   const url=new URL(input instanceof Request?input.url:String(input));if(url.origin!==b.proxyOrigin||url.pathname!=='/v1/messages'||url.search||url.hash||url.username||url.password||init.method!=='POST')refuse('ACTUAL_NATIVE_PHYSICAL_ROUTE_REFUSED');
   if(typeof init.body!=='string'||Buffer.byteLength(init.body)>2000000)refuse('ACTUAL_NATIVE_PHYSICAL_BODY_REFUSED');
   let body;try{body=JSON.parse(init.body);}catch{return refuse('ACTUAL_NATIVE_PHYSICAL_BODY_REFUSED');}if(body.model!==b.modelId||!Array.isArray(body.messages))refuse('ACTUAL_NATIVE_PHYSICAL_BODY_REFUSED');
   const signal=AbortSignal.any([stop.signal,...(init.signal?[init.signal]:[]),AbortSignal.timeout(Math.max(1,b.hardStopUnixMs-Date.now()))]);
   const receipt=Object.freeze({...current,kind:'actual_native_physical_dispatch',physicalSequence:++sequence,intentId:hash([b.processIdentity,b.window,b.workId,sequence]),bodySha256:createHash('sha256').update(init.body).digest('hex'),requestOrigin:url.origin,requestPath:url.pathname});pending++;
   let released=false;const release=()=>{if(!released){released=true;pending--;}};
   let terminal=false,authorized=false;
   const outcome=async(stage:string,status?:number)=>{try{await ports.recordPhysicalOutcome(Object.freeze({...receipt,kind:'actual_native_physical_outcome',stage,...(status===undefined?{}:{httpStatus:status})}));}catch(error){unknown++;throw error;}};
   const finish=async(stage:string,status?:number)=>{if(terminal)return;terminal=true;try{await outcome(stage,status);}finally{release();}};
   try{await ports.authorizePhysical(receipt,signal);authorized=true;live();signal.throwIfAborted();const response=await upstream(input,{...init,redirect:'error',signal});await outcome('headers',response.status);
    if(!response.body){await finish('body_drained',response.status);return response;}
    const reader=response.body.getReader();const abort=()=>{void reader.cancel().catch(()=>{}).then(()=>finish('aborted',response.status)).catch(()=>{});};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    const settled=async(stage:string)=>{signal.removeEventListener('abort',abort);await finish(stage,response.status);};
    return new Response(new ReadableStream({async pull(controller){try{signal.throwIfAborted();const chunk=await reader.read();if(chunk.done){await settled('body_drained');controller.close();}else controller.enqueue(chunk.value);}catch(error){try{await settled(signal.aborted?'aborted':'lost');}catch(outcomeError){controller.error(new AggregateError([error,outcomeError],'Native transport and outcome failed'));return;}controller.error(error);}},async cancel(reason){try{await reader.cancel(reason);}finally{await settled('aborted');}}}),{status:response.status,statusText:response.statusText,headers:response.headers});
   }catch(error){if(!authorized){release();throw error;}try{await finish(signal.aborted?'aborted':'lost');}catch(outcomeError){throw new AggregateError([error,outcomeError],'Native dispatch and outcome failed');}throw error;}
  };}} satisfies Host);
 const observer=Object.freeze({transportHost:host,
  beforeRegistration(r:Registration){live();if(!r||r.sourceId!=='core:built-in'||typeof r.api!=='string')refuse('ACTUAL_NATIVE_CUSTOM_REGISTRY_REFUSED');},
  modelRegistryCreated(owner:object,view:RegistryView){live();if(!owner||registries.has(owner)||!view.runtime||!view.registry||typeof view.readRegistrations!=='function')refuse('ACTUAL_NATIVE_RUNTIME_OWNER_REQUIRED');registries.set(owner,view);},
  async beforeHarness(frame:{harnessId:string;builtIn:boolean;modelRegistry:object;model:NativeModel;provider:string;modelId:string;agentId:string}){
   live();if(frame.harnessId!=='openclaw'||frame.builtIn!==true||frame.agentId!==b.nativeAgentId||frame.provider!=='anthropic'||frame.modelId!==b.modelId)refuse('ACTUAL_NATIVE_HARNESS_REFUSED');model(frame.model);
   const view=registries.get(frame.modelRegistry);if(!view)refuse('ACTUAL_NATIVE_RUNTIME_OWNER_REQUIRED');
   const registrations=view.readRegistrations(),apis=view.registry.getApiProviders();if(!registrations.length||registrations.some(r=>r.sourceId!=='core:built-in')||!registrations.some(r=>r.api==='anthropic-messages')
    ||JSON.stringify(registrations.map(r=>r.api).sort())!==JSON.stringify(apis.map(r=>r.api).sort()))refuse('ACTUAL_NATIVE_REGISTRY_DRIFT');
   const observed=actual(),receipt=Object.freeze({...b,...observed,kind:'actual_native_harness_registry_observation',harnessId:frame.harnessId,registrySha256:hash(registrations),registrations:registrations.map(r=>({...r})),sequence:++sequence});
   await ports.recordObservation(receipt);live();currentView=view;current=receipt;
  }});
 return{observer,transportHost:host,readiness:()=>Object.freeze({...b,...actual(),kind:'actual_native_gateway_bootstrap_observation',runtimeObservation:current?'observed':'pending_first_harness'}),snapshot:()=>current,close:()=>{current=undefined;stop.abort(new Error('CLOSED_NATIVE_PROCESS_ENDED'));},pending:()=>pending+unknown};
}
