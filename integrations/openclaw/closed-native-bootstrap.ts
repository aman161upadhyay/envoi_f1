import fs from 'node:fs/promises';import path from 'node:path';import {pathToFileURL} from 'node:url';import {createHash} from 'node:crypto';
import {createClosedNativeOwner,type ClosedNativeBinding,type ClosedNativeOwnerPorts} from './closed-native-owner';
import {NATIVE_OBSERVER_MODULE} from './native-observer-patch';
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const FILES={host:'node_modules/@openclaw/ai/dist/index.mjs',coreHost:'dist/ai-transport-host-M96B-3Jx.mjs',runtimeHost:'dist/ai-transport-runtime-host-CKPjGYa5.mjs',observer:'dist/'+NATIVE_OBSERVER_MODULE,
 server:'dist/server-DflCEUMg.mjs',registry:'dist/model-registry-Bc1CKDx-.mjs',selection:'dist/selection-BCmRjyeC.mjs',config:'dist/io.runtime-CjTVy3UH.mjs',plugins:'dist/runtime-DTYJlWfc.mjs'} as const;
type Role=keyof typeof FILES;
export interface ClosedNativeBootstrapOptions{nativeRoot:string;binding:Readonly<ClosedNativeBinding>;port:number;sourceSha256:Readonly<Record<Role,string>>;
 paths:Readonly<{stateDirectory:string;configurationPath:string;workspace:string;agentState:string}>;
 /** Actual source/target/capability adoption and current window checks. Never automated human approval. */
 authorize():Promise<void>;ports:ClosedNativeOwnerPorts;}
export interface ClosedNativeBootstrapDependencies{readBytes(file:string):Promise<Uint8Array>;loadModule(file:string):Promise<Record<string,any>>;readPathEnvironment():{stateDirectory?:string;configurationPath?:string};}
const real:ClosedNativeBootstrapDependencies={readBytes:fs.readFile,loadModule:file=>import(pathToFileURL(file).href),readPathEnvironment:()=>({stateDirectory:process.env.OPENCLAW_STATE_DIR,configurationPath:process.env.OPENCLAW_CONFIG_PATH})};

/** Invoke ONLY inside the new owned one-work native child after its native path env is selected. */
export async function startClosedNativeGateway(options:ClosedNativeBootstrapOptions,deps:ClosedNativeBootstrapDependencies=real){
 await options.authorize();options.ports.assertLive(options.binding);
 const env=deps.readPathEnvironment();
 for(const key of['stateDirectory','configurationPath','workspace','agentState']as const){const selected=options.paths[key];if(!path.isAbsolute(selected)||digest(Buffer.from(path.resolve(selected)))!==options.binding[(key+'Sha256')as keyof ClosedNativeBinding])throw Error('REVIEWED_NATIVE_PRIVATE_PATH_REQUIRED');}
 if(!env.stateDirectory||!env.configurationPath||path.resolve(env.stateDirectory)!==path.resolve(options.paths.stateDirectory)||path.resolve(env.configurationPath)!==path.resolve(options.paths.configurationPath))throw Error('NEW_NATIVE_CHILD_PATH_SELECTION_REQUIRED');
 if(!path.isAbsolute(options.nativeRoot)||!Number.isInteger(options.port)||options.port<1||options.port>65535)throw Error('EXACT_NATIVE_BOOTSTRAP_REQUIRED');
 for(const role of Object.keys(FILES)as Role[]){const expected=options.sourceSha256[role];if(!/^[a-f0-9]{64}$/.test(expected)||digest(await deps.readBytes(path.join(options.nativeRoot,FILES[role])))!==expected)throw Error('REVIEWED_NATIVE_SOURCE_ADOPTION_REQUIRED');}
 // Complete both native installers before capturing the actual host implementation.
 const host=await deps.loadModule(path.join(options.nativeRoot,FILES.host));
 await deps.loadModule(path.join(options.nativeRoot,FILES.coreHost));await deps.loadModule(path.join(options.nativeRoot,FILES.runtimeHost));
 const nativeObserver=await deps.loadModule(path.join(options.nativeRoot,FILES.observer)),configuration=await deps.loadModule(path.join(options.nativeRoot,FILES.config)),plugins=await deps.loadModule(path.join(options.nativeRoot,FILES.plugins));
 if(typeof host.getDefaultAiTransportHost!=='function'||typeof host.configureAiTransportHost!=='function'||typeof nativeObserver.installClosedNativeObserver!=='function'
  ||typeof configuration.r!=='function'||typeof configuration.i!=='function'||typeof plugins.l!=='function'||typeof plugins.m!=='function')throw Error('EXACT_NATIVE_OBSERVER_EXPORTS_REQUIRED');
 // Native loader resolves the selected private config; reject unsupported selectors before startup.
 options.ports.assertEffectiveConfiguration(configuration.i());
 const owner=createClosedNativeOwner(options.binding,host.getDefaultAiTransportHost(),{getRuntimeConfig:configuration.r,getActivePluginRegistry:plugins.l,listImportedRuntimePluginIds:plugins.m},options.ports);
 let gateway:{startupSettled?:Promise<unknown>;close(options:{reason:string}):Promise<void>}|undefined;
 try{nativeObserver.installClosedNativeObserver(owner.observer);host.configureAiTransportHost(owner.transportHost);
  if(typeof nativeObserver.getClosedNativeObserver!=='function'||nativeObserver.getClosedNativeObserver()?.transportHost!==owner.transportHost)throw Error('ACTUAL_NATIVE_GATE_INSTALLATION_REQUIRED');
  const server=await deps.loadModule(path.join(options.nativeRoot,FILES.server));if(typeof server.startGatewayServer!=='function')throw Error('EXACT_NATIVE_GATEWAY_EXPORT_REQUIRED');
  if(host.getDefaultAiTransportHost().buildModelFetch!==owner.transportHost.buildModelFetch)throw Error('NATIVE_TRANSPORT_HOST_REPLACED');
  gateway=await server.startGatewayServer(options.port,{bind:'loopback'});await gateway?.startupSettled;options.ports.assertLive(options.binding);
  if(host.getDefaultAiTransportHost().buildModelFetch!==owner.transportHost.buildModelFetch)throw Error('NATIVE_TRANSPORT_HOST_REPLACED');
  owner.readiness();return{readiness:owner.readiness,snapshot:owner.snapshot,pending:owner.pending,async close(){owner.close();await gateway!.close({reason:'approved-one-work-native-process-ended'});if(owner.pending())throw Error('ACTUAL_NATIVE_TRANSPORT_DRAIN_REQUIRED');}};
 }catch(error){owner.close();try{await gateway?.close({reason:'closed-native-bootstrap-failed'});}catch(cleanup){throw new AggregateError([error,cleanup],'Native bootstrap and cleanup failed');}throw error;}
}
export {FILES as CLOSED_NATIVE_BOOTSTRAP_FILES};
