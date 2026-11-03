import {createHash} from 'node:crypto';
export const NATIVE_OBSERVER_BASE=Object.freeze({
  'model-registry-Bc1CKDx-.mjs':'172d04253afe995ff9dc96801e60c108b38be84f1081a148310eb47474e218b2',
  'selection-BCmRjyeC.mjs':'54c1249c4bcbdf8ac47e50dab3db36073113453140d4985bc91566a8a886c74d'});
export const NATIVE_OBSERVER_MODULE='envoi-closed-native-observer.mjs';
export const NATIVE_OBSERVER_MODULE_SOURCE=`// Explicit reviewed native capability; no public route, model field, key or prompt.
let observer;
export function installClosedNativeObserver(value) {
 if(observer)throw Error('NATIVE_OBSERVER_ALREADY_INSTALLED');
 if(!value||typeof value.beforeRegistration!=='function'||typeof value.modelRegistryCreated!=='function'||typeof value.beforeHarness!=='function'||!value.transportHost)throw Error('NATIVE_OBSERVER_REQUIRED');
 observer=Object.freeze({beforeRegistration:value.beforeRegistration.bind(value),modelRegistryCreated:value.modelRegistryCreated.bind(value),beforeHarness:value.beforeHarness.bind(value),transportHost:value.transportHost});
}
export function getClosedNativeObserver(){return observer;}
`;
const original=`function initializeModelRegistryRuntime(owner) {
\tconst apiRegistry = createApiRegistry();
\tconst llmRuntime = {
\t\t...createLlmRuntime(apiRegistry),
\t\trunStream: runPluginStreamConsumer
\t};
\tconst runtime = {
\t\tapiRegistry,
\t\tllmRuntime
\t};
\tbindStreamLlmRuntime(llmRuntime.streamSimple, llmRuntime);
\tresetApiRegistry(runtime);
\tmodelRegistryRuntimes.set(owner, runtime);
}`;
export const OBSERVED_INITIALIZE_MODEL_REGISTRY=`function initializeModelRegistryRuntime(owner) {
 const observer=getClosedNativeObserver();
 const apiRegistry=createApiRegistry(),registrations=new Map();
 if(observer){
  const register=apiRegistry.registerApiProvider.bind(apiRegistry),clear=apiRegistry.clearApiProviders.bind(apiRegistry),remove=apiRegistry.unregisterApiProviders.bind(apiRegistry);
  apiRegistry.registerApiProvider=(provider,sourceId)=>{observer.beforeRegistration({api:provider.api,sourceId});register(provider,sourceId);registrations.set(provider.api,Object.freeze({api:provider.api,sourceId}));};
  apiRegistry.clearApiProviders=()=>{clear();registrations.clear();};
  apiRegistry.unregisterApiProviders=sourceId=>{remove(sourceId);for(const[api,r]of registrations)if(r.sourceId===sourceId)registrations.delete(api);};
 }
 const llmRuntime={...(observer?createNodeLlmRuntime(apiRegistry,observer.transportHost):createLlmRuntime(apiRegistry)),runStream:runPluginStreamConsumer};
 const runtime={apiRegistry,llmRuntime};
 bindStreamLlmRuntime(llmRuntime.streamSimple,llmRuntime);
 resetApiRegistry(runtime);modelRegistryRuntimes.set(owner,runtime);
 if(observer)observer.modelRegistryCreated(owner,Object.freeze({runtime:llmRuntime,registry:apiRegistry,readRegistrations:()=>[...registrations.values()]}));
}`;
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
function once(source:string,from:string,to:string){if(source.split(from).length!==2)throw Error('EXACT_NATIVE_PATCH_CONTEXT_REQUIRED');return source.replace(from,to);}
/** Returns new bytes only. Never writes or imports the installed native package. */
export function prepareNativeObserverPatch(input:Readonly<Record<keyof typeof NATIVE_OBSERVER_BASE,string>>){
 for(const[name,digest]of Object.entries(NATIVE_OBSERVER_BASE))if(hash(input[name as keyof typeof input])!==digest)throw Error('PINNED_NATIVE_SOURCE_REQUIRED');
 let registry=input['model-registry-Bc1CKDx-.mjs'],selection=input['selection-BCmRjyeC.mjs'];
 registry=once(registry,'import { createApiRegistry, createLlmRuntime } from "@openclaw/ai";','import { createApiRegistry, createLlmRuntime, createNodeLlmRuntime } from "@openclaw/ai";\nimport { getClosedNativeObserver } from "./'+NATIVE_OBSERVER_MODULE+'";');
 registry=once(registry,original,OBSERVED_INITIALIZE_MODEL_REGISTRY);
 selection='import { getClosedNativeObserver } from "./'+NATIVE_OBSERVER_MODULE+'";\n'+selection;
 selection=once(selection,'\tconst harness = selection.harness;\n\tconst nativeOwnsModel',
  '\tconst harness = selection.harness;\n\tawait getClosedNativeObserver()?.beforeHarness({harnessId:harness.id,builtIn:selection.builtIn===true,modelRegistry:params.modelRegistry,model:params.model,provider:params.provider,modelId:params.modelId,agentId:params.agentId});\n\tconst nativeOwnsModel');
 return Object.freeze({'model-registry-Bc1CKDx-.mjs':registry,'selection-BCmRjyeC.mjs':selection,[NATIVE_OBSERVER_MODULE]:NATIVE_OBSERVER_MODULE_SOURCE});
}
