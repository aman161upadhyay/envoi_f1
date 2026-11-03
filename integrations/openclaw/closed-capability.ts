import {createHash} from 'node:crypto';
import {EnvoiError} from '../../sdk/typescript/src/index';

/** Review-only local capability candidate. This is not a native protocol or attestation. */
export const CLOSED_OPENCLAW_SOURCES=Object.freeze(['package','responsesIngress','nativeAgent','anthropicProvider','anthropicTransport',
  'simpleOptions','streamSelector','providerSelector','providerRegistry','apiRegistry','pluginPolicy','harnessPolicy','modelPolicy','modelRuntime','modelFetch','summary','slug'] as const);
type SourceName=typeof CLOSED_OPENCLAW_SOURCES[number];
export interface ClosedOpenClawExpected {
  approvalReceiptSha256:string;capabilitySha256:string;window:string;clientSource:string;nativeSourceSha256:string;
  processIdentity:string;configurationSha256:string;stateDirectorySha256:string;configurationPathSha256:string;workspaceSha256:string;agentStateSha256:string;registrySha256:string;
  nativeAgentId:string;modelId:string;proxyOrigin:string;proxyIdentity:string;toolChannelSha256:string;
  sources:Readonly<Record<SourceName,string>>;
  observations:Readonly<{configuration:string;environment:string;runtime:string}>;
}
export interface ClosedOpenClawObservation {
  /** Exact bytes from a trusted native observer; never fabricate these from the config. */
  configuration:Uint8Array|string;environment:Uint8Array|string;runtime:Uint8Array|string;
  /** Actual purpose-specific human decision from a separately trusted receipt source. */
  approvalDecision:Uint8Array|string;
  sources:Readonly<Record<SourceName,string>>;
}
export interface ClosedOpenClawApprovalDecision {
  version:1;purpose:'closed-openclaw-core-anthropic-capability';ownerApproved:true;
  approvalId:string;approvedAtUtc:string;expiresAtUtc:string;
  subjectHash:string;window:string;clientSource:string;nativeSourceSha256:string;
}
const hash=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const plain=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const canonical=(v:unknown):string=>JSON.stringify(v,(_k,value)=>plain(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))):value);
const equal=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
function refuse(code:string):never{throw new EnvoiError('Closed OpenClaw capability is unverified',undefined,code);}
function exactKeys(value:unknown,keys:readonly string[]){return plain(value)&&equal(Object.keys(value).sort(),[...keys].sort());}

/** Hash for a separately reviewed policy receipt; computing it supplies no approval. */
export function closedOpenClawCapabilityDigest(expected:Omit<ClosedOpenClawExpected,'capabilitySha256'>|ClosedOpenClawExpected){
  const{capabilitySha256:_hash,approvalReceiptSha256:_receipt,...pins}=expected as ClosedOpenClawExpected;return hash(canonical(pins));
}
export function closedOpenClawApprovalReceiptDigest(decision:Readonly<ClosedOpenClawApprovalDecision>){return hash(canonical(decision));}

/** Pure validation only. The caller must independently establish observation provenance. */
export function validateClosedOpenClawCapability(expected:Readonly<ClosedOpenClawExpected>,observed:Readonly<ClosedOpenClawObservation>,nowUnixMs=Date.now()){
  if(!expected||!observed||!exactKeys(expected,['approvalReceiptSha256','capabilitySha256','window','clientSource','nativeSourceSha256','processIdentity',
    'configurationSha256','stateDirectorySha256','configurationPathSha256','workspaceSha256','agentStateSha256','registrySha256','nativeAgentId','modelId','proxyOrigin','proxyIdentity','toolChannelSha256','sources','observations'])
    ||!exactKeys(observed,['configuration','environment','runtime','approvalDecision','sources'])||!digest(expected.approvalReceiptSha256)||!digest(expected.capabilitySha256)
    ||expected.capabilitySha256!==closedOpenClawCapabilityDigest(expected)||!digest(expected.window)||!/^[a-f0-9]{40}$/.test(expected.clientSource)
    ||![expected.nativeSourceSha256,expected.configurationSha256,expected.stateDirectorySha256,expected.configurationPathSha256,expected.workspaceSha256,expected.agentStateSha256,expected.registrySha256,expected.toolChannelSha256].every(digest)
    ||![expected.processIdentity,expected.proxyIdentity,expected.nativeAgentId,expected.modelId].every(v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(v)))refuse('CLOSED_NATIVE_POLICY_REVIEW_REQUIRED');
  const decisionBytes=observed.approvalDecision;
  if(!(typeof decisionBytes==='string'||decisionBytes instanceof Uint8Array)||Buffer.byteLength(decisionBytes)>16384)refuse('CLOSED_NATIVE_CAPABILITY_APPROVAL_REQUIRED');
  let decision:unknown;try{decision=JSON.parse(Buffer.from(decisionBytes).toString('utf8'));}catch{return refuse('CLOSED_NATIVE_CAPABILITY_APPROVAL_REQUIRED');}
  if(!exactKeys(decision,['version','purpose','ownerApproved','approvalId','approvedAtUtc','expiresAtUtc','subjectHash','window','clientSource','nativeSourceSha256']))refuse('CLOSED_NATIVE_CAPABILITY_APPROVAL_REQUIRED');
  const d=decision as unknown as ClosedOpenClawApprovalDecision,start=Date.parse(d.approvedAtUtc),stop=Date.parse(d.expiresAtUtc);
  if(d.version!==1||d.purpose!=='closed-openclaw-core-anthropic-capability'||d.ownerApproved!==true
    ||typeof d.approvalId!=='string'||!/^capability_[A-Za-z0-9_-]{1,100}$/.test(d.approvalId)
    ||!Number.isFinite(nowUnixMs)||!Number.isFinite(start)||!Number.isFinite(stop)||start>nowUnixMs||stop<=nowUnixMs||stop<=start||stop-start>90*60*1000
    ||new Date(start).toISOString()!==d.approvedAtUtc||new Date(stop).toISOString()!==d.expiresAtUtc)refuse('CLOSED_NATIVE_CAPABILITY_APPROVAL_REQUIRED');
  if(closedOpenClawApprovalReceiptDigest(d)!==expected.approvalReceiptSha256||d.subjectHash!==expected.capabilitySha256||d.window!==expected.window
    ||d.clientSource!==expected.clientSource||d.nativeSourceSha256!==expected.nativeSourceSha256)refuse('CLOSED_NATIVE_CAPABILITY_APPROVAL_MISMATCH');
  let proxy:URL;try{proxy=new URL(expected.proxyOrigin);}catch{return refuse('CLOSED_NATIVE_POLICY_REVIEW_REQUIRED');}
  if(proxy.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(proxy.hostname)||proxy.username||proxy.password||proxy.pathname!=='/'||proxy.search||proxy.hash||proxy.origin!==expected.proxyOrigin)refuse('CLOSED_NATIVE_POLICY_REVIEW_REQUIRED');
  if(!exactKeys(expected.sources,CLOSED_OPENCLAW_SOURCES)||!exactKeys(observed.sources,CLOSED_OPENCLAW_SOURCES)
    ||!CLOSED_OPENCLAW_SOURCES.every(key=>digest(expected.sources[key])&&expected.sources[key]===observed.sources[key])
    ||!exactKeys(expected.observations,['configuration','environment','runtime']))refuse('CLOSED_NATIVE_SOURCE_DRIFT');
  const records={} as Record<'configuration'|'environment'|'runtime',Record<string,unknown>>;
  for(const key of['configuration','environment','runtime']as const){
    const bytes=observed[key];if(!(typeof bytes==='string'||bytes instanceof Uint8Array)||Buffer.byteLength(bytes)>1000000||!digest(expected.observations[key])||hash(bytes)!==expected.observations[key])refuse('TRUSTED_NATIVE_OBSERVATION_REQUIRED');
    let record:unknown;try{record=JSON.parse(Buffer.from(bytes).toString('utf8'));}catch{return refuse('TRUSTED_NATIVE_OBSERVATION_REQUIRED');}
    if(!plain(record))refuse('TRUSTED_NATIVE_OBSERVATION_REQUIRED');records[key]=record;
  }
  const binding={window:expected.window,clientSource:expected.clientSource,nativeSourceSha256:expected.nativeSourceSha256,processIdentity:expected.processIdentity,
    configurationSha256:expected.configurationSha256,stateDirectorySha256:expected.stateDirectorySha256,configurationPathSha256:expected.configurationPathSha256,
    workspaceSha256:expected.workspaceSha256,agentStateSha256:expected.agentStateSha256,proxyOrigin:expected.proxyOrigin,proxyIdentity:expected.proxyIdentity,toolChannelSha256:expected.toolChannelSha256};
  const config=records.configuration;
  if(!exactKeys(config,['binding','effectiveSelectors'])||!equal(config.binding,binding))refuse('NATIVE_CAPABILITY_BINDING_MISMATCH');
  const ref='anthropic/'+expected.modelId;
  // Closed supported-selector projection. Additional settings require separate review.
  const closedSelectors={plugins:{enabled:false,allow:[],deny:[],entries:{},load:{paths:[]},slots:{memory:'none',contextEngine:'none'}},
    agents:{defaults:{model:{primary:ref,fallbacks:[]},models:{[ref]:{agentRuntime:{id:'openclaw'}}}},list:[{id:expected.nativeAgentId}]},
    models:{mode:'replace',providers:{anthropic:{api:'anthropic-messages',baseUrl:expected.proxyOrigin,agentRuntime:{id:'openclaw'},models:[{id:expected.modelId}]}}}};
  if(!equal(config.effectiveSelectors,closedSelectors))refuse('CLOSED_NATIVE_SELECTOR_REFUSED');
  const env=records.environment;
  if(!exactKeys(env,['binding','selectorEnvironment'])||!equal(env.binding,binding)||!equal(env.selectorEnvironment,{}))refuse('CLOSED_NATIVE_ENVIRONMENT_REFUSED');
  // A separate runtime observation is mandatory: config bytes cannot prove loaded state.
  const runtime=records.runtime;
  if(!exactKeys(runtime,['binding','harness','modelRuntime','selectedModel','providerStream','apiProvider','registryEntries','loadedPluginArtifacts','autoloadArtifacts','auxiliaryRoutes','externalToolRoutes'])||!equal(runtime.binding,binding))refuse('NATIVE_CAPABILITY_BINDING_MISMATCH');
  const registry=runtime.registryEntries;
  if(!Array.isArray(registry)||!registry.length||hash(canonical(registry))!==expected.registrySha256
    ||new Set(registry.map(r=>plain(r)?r.api:undefined)).size!==registry.length
    ||!registry.every(r=>exactKeys(r,['api','owner','sourceSha256'])&&typeof r.api==='string'&&/^[a-z][a-z0-9-]+$/.test(r.api)
      &&r.owner==='core:built-in'&&r.sourceSha256===expected.sources.apiRegistry)
    ||!registry.some(r=>r.api==='anthropic-messages'))refuse('CLOSED_NATIVE_REGISTRY_REFUSED');
  if(!equal(runtime.harness,{id:'openclaw',owner:'core',sourceSha256:expected.sources.nativeAgent})
    ||!equal(runtime.modelRuntime,{owner:'core',sourceSha256:expected.sources.modelRuntime})
    ||!equal(runtime.selectedModel,{provider:'anthropic',api:'anthropic-messages',id:expected.modelId,nativeAgentId:expected.nativeAgentId,baseUrl:expected.proxyOrigin,fallbacks:[]})
    ||runtime.providerStream!==null||!equal(runtime.apiProvider,{api:'anthropic-messages',owner:'core:built-in',sourceSha256:expected.sources.anthropicTransport})
    ||!equal(runtime.loadedPluginArtifacts,[])||!equal(runtime.autoloadArtifacts,[])||!equal(runtime.externalToolRoutes,[])
    ||!equal(runtime.auxiliaryRoutes,[{kind:'summary',owner:'core',sourceSha256:expected.sources.summary,transportSourceSha256:expected.sources.anthropicTransport},
      {kind:'slug',owner:'core',sourceSha256:expected.sources.slug,transportSourceSha256:expected.sources.anthropicTransport}]))refuse('CLOSED_NATIVE_RUNTIME_REFUSED');
  return Object.freeze({classification:'closed_core_anthropic_observations_match' as const,capabilitySha256:expected.capabilitySha256,
    approvalReceiptSha256:expected.approvalReceiptSha256,processIdentity:expected.processIdentity});
}
