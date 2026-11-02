import {createHash} from 'node:crypto';import vm from 'node:vm';
import {expect,it} from 'vitest';
import fixture from './closed-capability-native-selectors.fixture.json';
import {CLOSED_OPENCLAW_SOURCES,closedOpenClawCapabilityDigest,closedOpenClawApprovalReceiptDigest,validateClosedOpenClawCapability,type ClosedOpenClawExpected,type ClosedOpenClawObservation} from './closed-capability';
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const stable=(v:unknown):string=>JSON.stringify(v,(_k,x)=>x!==null&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
// Entirely synthetic observation bytes. These never authorize a real native process.
function sample(){
 const sources=Object.fromEntries(CLOSED_OPENCLAW_SOURCES.map(key=>[key,hash('FAKE_OFFLINE_SOURCE_'+key)])) as ClosedOpenClawExpected['sources'];
 const expected:ClosedOpenClawExpected={approvalReceiptSha256:hash('FAKE_OFFLINE_OWNER_RECEIPT'),capabilitySha256:'',window:hash('FAKE_WINDOW'),clientSource:'a'.repeat(40),nativeSourceSha256:hash('FAKE_NATIVE'),
 processIdentity:'FAKE_PROCESS',configurationSha256:hash('FAKE_CONFIG'),stateDirectorySha256:hash('FAKE_STATE'),configurationPathSha256:hash('FAKE_PATH'),workspaceSha256:hash('FAKE_WORKSPACE'),agentStateSha256:hash('FAKE_AGENT_STATE'),registrySha256:'',nativeAgentId:'main',modelId:'claude-haiku-4-5-20251001',proxyOrigin:'http://127.0.0.1:42001',proxyIdentity:'FAKE_PROXY',toolChannelSha256:hash('FAKE_CHANNEL'),sources,observations:{configuration:'',environment:'',runtime:''}};
 const binding={window:expected.window,clientSource:expected.clientSource,nativeSourceSha256:expected.nativeSourceSha256,processIdentity:expected.processIdentity,configurationSha256:expected.configurationSha256,stateDirectorySha256:expected.stateDirectorySha256,configurationPathSha256:expected.configurationPathSha256,workspaceSha256:expected.workspaceSha256,agentStateSha256:expected.agentStateSha256,proxyOrigin:expected.proxyOrigin,proxyIdentity:expected.proxyIdentity,toolChannelSha256:expected.toolChannelSha256};
 const ref='anthropic/'+expected.modelId,configuration={binding,effectiveSelectors:{plugins:{enabled:false,allow:[],deny:[],entries:{},load:{paths:[]},slots:{memory:'none',contextEngine:'none'}},agents:{defaults:{model:{primary:ref,fallbacks:[]},models:{[ref]:{agentRuntime:{id:'openclaw'}}}},list:[{id:expected.nativeAgentId}]},models:{mode:'replace',providers:{anthropic:{api:'anthropic-messages',baseUrl:expected.proxyOrigin,agentRuntime:{id:'openclaw'},models:[{id:expected.modelId}]}}}}};
 const environment={binding,selectorEnvironment:{}},runtime={binding,harness:{id:'openclaw',owner:'core',sourceSha256:sources.nativeAgent},modelRuntime:{owner:'core',sourceSha256:sources.modelRuntime},selectedModel:{provider:'anthropic',api:'anthropic-messages',id:expected.modelId,nativeAgentId:expected.nativeAgentId,baseUrl:expected.proxyOrigin,fallbacks:[]},providerStream:null,apiProvider:{api:'anthropic-messages',owner:'core:built-in',sourceSha256:sources.anthropicTransport},registryEntries:[{api:'anthropic-messages',owner:'core:built-in',sourceSha256:sources.apiRegistry}],loadedPluginArtifacts:[],autoloadArtifacts:[],auxiliaryRoutes:[{kind:'summary',owner:'core',sourceSha256:sources.summary,transportSourceSha256:sources.anthropicTransport},{kind:'slug',owner:'core',sourceSha256:sources.slug,transportSourceSha256:sources.anthropicTransport}],externalToolRoutes:[]};
 let observed:ClosedOpenClawObservation;
 const seal=()=>{expected.registrySha256=hash(stable(runtime.registryEntries));observed={configuration:JSON.stringify(configuration),environment:JSON.stringify(environment),runtime:JSON.stringify(runtime),approvalDecision:'',sources};for(const k of['configuration','environment','runtime']as const)expected.observations[k]=hash(String(observed[k]));expected.capabilitySha256=closedOpenClawCapabilityDigest(expected);const decision={version:1 as const,purpose:'closed-openclaw-core-anthropic-capability' as const,ownerApproved:true as const,approvalId:'capability_FAKE_OFFLINE',approvedAtUtc:new Date(Date.now()-1000).toISOString(),expiresAtUtc:new Date(Date.now()+60000).toISOString(),subjectHash:expected.capabilitySha256,window:expected.window,clientSource:expected.clientSource,nativeSourceSha256:expected.nativeSourceSha256};observed.approvalDecision=JSON.stringify(decision);expected.approvalReceiptSha256=closedOpenClawApprovalReceiptDigest(decision);};seal();
 return{expected,observed:()=>observed,configuration,environment,runtime,seal};
}
it('validates separate exact observation bytes and explicit reviewed pins without granting native admission',()=>{
 const s=sample(),result=validateClosedOpenClawCapability(s.expected,s.observed());expect(result.classification).toBe('closed_core_anthropic_observations_match');expect(Object.keys(result)).toEqual(['classification','capabilitySha256','approvalReceiptSha256','processIdentity']);expect(result).not.toHaveProperty('nativeEgressAttested');
});
it.each(['configuration','environment','runtime']as const)('refuses missing or byte-drifted %s observation even with a valid static config',key=>{
 const s=sample();for(const value of[undefined,'true',String(s.observed()[key])+' '])expect(()=>validateClosedOpenClawCapability(s.expected,{...s.observed(),[key]:value} as never)).toThrow(expect.objectContaining({code:'TRUSTED_NATIVE_OBSERVATION_REQUIRED'}));
});
it('requires explicit review hashes rather than ownerApproved or nativeSafe flags',()=>{
 const s=sample();expect(()=>validateClosedOpenClawCapability({...s.expected,approvalReceiptSha256:''},s.observed())).toThrow(expect.objectContaining({code:'CLOSED_NATIVE_POLICY_REVIEW_REQUIRED'}));
 expect(()=>validateClosedOpenClawCapability(s.expected,{...s.observed(),runtime:'{"nativeSafe":true}'})).toThrow(expect.objectContaining({code:'TRUSTED_NATIVE_OBSERVATION_REQUIRED'}));
});
function changedDecision(s:ReturnType<typeof sample>,change:Record<string,unknown>,rehash=true){
 const d={...JSON.parse(String(s.observed().approvalDecision)),...change};if(rehash)s.expected.approvalReceiptSha256=closedOpenClawApprovalReceiptDigest(d);return{...s.observed(),approvalDecision:JSON.stringify(d)};
}
it('requires a raw capability-specific human decision, not an earlier cap/time/graph/source approval',()=>{
 for(const purpose of['phase-c-model-call-cap','phase-c-time-extension','reviewed-phase-c-graph','client-source-adoption']){const s=sample();expect(()=>validateClosedOpenClawCapability(s.expected,changedDecision(s,{purpose}))).toThrow(expect.objectContaining({code:'CLOSED_NATIVE_CAPABILITY_APPROVAL_REQUIRED'}));}
 const s=sample();expect(()=>validateClosedOpenClawCapability(s.expected,{...s.observed(),approvalDecision:undefined} as never)).toThrow(expect.objectContaining({code:'CLOSED_NATIVE_CAPABILITY_APPROVAL_REQUIRED'}));
});
it.each(['subjectHash','window','clientSource','nativeSourceSha256'])('refuses an earlier or changed capability decision binding: %s',field=>{
 const s=sample(),value=field==='clientSource'?'0'.repeat(40):'0'.repeat(64);expect(()=>validateClosedOpenClawCapability(s.expected,changedDecision(s,{[field]:value}))).toThrow(expect.objectContaining({code:'CLOSED_NATIVE_CAPABILITY_APPROVAL_MISMATCH'}));
});
it('computes the receipt from its canonical actual decision and detects unhashed record changes',()=>{
 const s=sample();expect(()=>validateClosedOpenClawCapability(s.expected,changedDecision(s,{approvalId:'capability_another'},false))).toThrow(expect.objectContaining({code:'CLOSED_NATIVE_CAPABILITY_APPROVAL_MISMATCH'}));
 const reordered=Object.fromEntries(Object.entries(JSON.parse(String(s.observed().approvalDecision))).reverse());expect(()=>validateClosedOpenClawCapability(s.expected,{...s.observed(),approvalDecision:JSON.stringify(reordered,null,2)})).not.toThrow();
});
it('keeps the capability subject independent of the approving record and receipt hash',()=>{
 const s=sample(),subject=s.expected.capabilitySha256;expect(closedOpenClawCapabilityDigest({...s.expected,approvalReceiptSha256:'0'.repeat(64)})).toBe(subject);
 const observed=changedDecision(s,{approvalId:'capability_replacement_review'});expect(closedOpenClawCapabilityDigest(s.expected)).toBe(subject);expect(JSON.parse(String(observed.approvalDecision)).subjectHash).toBe(subject);expect(()=>validateClosedOpenClawCapability(s.expected,observed)).not.toThrow();
});
it.each([
 {version:2},{ownerApproved:false},{approvalId:'capability_'+'a'.repeat(101)},
 {approvedAtUtc:new Date(Date.now()+60000).toISOString()},
 {expiresAtUtc:new Date(Date.now()-1).toISOString()},
 {expiresAtUtc:new Date(Date.now()+91*60000).toISOString()}
])('refuses an unapproved, unbounded or out-of-time capability record %j',change=>{
 const s=sample();expect(()=>validateClosedOpenClawCapability(s.expected,changedDecision(s,change))).toThrow(expect.objectContaining({code:'CLOSED_NATIVE_CAPABILITY_APPROVAL_REQUIRED'}));
});
it('refuses native source drift or incomplete source inventory',()=>{
 const s=sample();expect(()=>validateClosedOpenClawCapability(s.expected,{...s.observed(),sources:{...s.expected.sources,anthropicTransport:'0'.repeat(64)}})).toThrow(expect.objectContaining({code:'CLOSED_NATIVE_SOURCE_DRIFT'}));
 expect(()=>validateClosedOpenClawCapability(s.expected,{...s.observed(),sources:{package:s.expected.sources.package} as never})).toThrow(expect.objectContaining({code:'CLOSED_NATIVE_SOURCE_DRIFT'}));
});
it.each(['providerStream','harness','modelRuntime','loadedPluginArtifacts','autoloadArtifacts','externalToolRoutes']as const)('refuses re-pinned but unsupported actual runtime state: %s',key=>{
 const s=sample();(s.runtime as any)[key]=key.endsWith('Artifacts')||key==='externalToolRoutes'?[{id:'custom'}]:{owner:'custom',id:'custom'};s.seal();expect(()=>validateClosedOpenClawCapability(s.expected,s.observed())).toThrow(expect.objectContaining({code:'CLOSED_NATIVE_RUNTIME_REFUSED'}));
});
it('refuses a custom or changed in-memory API registry independently of the configured provider',()=>{
 const s=sample();s.runtime.registryEntries.push({api:'custom-api',owner:'custom',sourceSha256:s.expected.sources.apiRegistry});s.seal();expect(()=>validateClosedOpenClawCapability(s.expected,s.observed())).toThrow(expect.objectContaining({code:'CLOSED_NATIVE_REGISTRY_REFUSED'}));
});
it.each(['OPENCLAW_BUILD_PRIVATE_QA','OPENCLAW_QA_FORCE_RUNTIME','NODE_OPTIONS','ANTHROPIC_BASE_URL','HTTPS_PROXY'])('refuses inherited selector override %s even when observation hashes are re-pinned',name=>{
 const s=sample();s.environment.selectorEnvironment={[name]:'unsupported'};s.seal();expect(()=>validateClosedOpenClawCapability(s.expected,s.observed())).toThrow(expect.objectContaining({code:'CLOSED_NATIVE_ENVIRONMENT_REFUSED'}));
});
it.each(['plugins','fallback','provider','runtime','autoload','cloudWorker'])('refuses supported native selector changes outside the closed candidate: %s',kind=>{
 const s=sample(),c=s.configuration.effectiveSelectors as any;
 if(kind==='plugins')c.plugins.enabled=true;if(kind==='fallback')c.agents.defaults.model.fallbacks=['openai/other'];if(kind==='provider')c.models.providers.custom={api:'custom'};
 if(kind==='runtime')c.models.providers.anthropic.agentRuntime.id='codex';if(kind==='autoload')c.plugins.load.paths=['C:/inert/custom'];if(kind==='cloudWorker')c.cloudWorkers={requiredProfile:'other'};
 s.seal();expect(()=>validateClosedOpenClawCapability(s.expected,s.observed())).toThrow(expect.objectContaining({code:'CLOSED_NATIVE_SELECTOR_REFUSED'}));
});
it('refuses runtime observations belonging to another process/config/state/channel',()=>{
 for(const key of['processIdentity','configurationSha256','stateDirectorySha256','configurationPathSha256','workspaceSha256','agentStateSha256','toolChannelSha256']as const){const s=sample();s.runtime.binding={...s.runtime.binding,[key]:'foreign'};s.seal();expect(()=>validateClosedOpenClawCapability(s.expected,s.observed())).toThrow(expect.objectContaining({code:'NATIVE_CAPABILITY_BINDING_MISMATCH'}));}
});
it('executes exact extracted pinned native plugin activation: disabled is closed, empty allow is not deny-all',()=>{
 const context=vm.createContext({normalizePluginPolicyId:(x:string)=>x.trim().toLowerCase(),resolveChannelConfigEnablement:()=>undefined});
 for(const f of Object.values(fixture.functions)){expect(hash(f.body)).toBe(f.sha256);vm.runInContext(f.body,context);}
 const base={id:'custom',origin:'external',rootConfig:{},config:{enabled:true,allow:[],deny:[],entries:{},slots:{memory:null,contextEngine:null}}};context.params=base;
 expect(vm.runInContext('resolvePluginActivationStateShared(params)',context)).toMatchObject({enabled:true,source:'default'});
 context.params={...base,config:{...base.config,enabled:false}};expect(vm.runInContext('resolvePluginActivationStateShared(params)',context)).toMatchObject({enabled:false,reason:'plugins disabled'});
 context.params={...base,config:{...base.config,allow:['approved']}};expect(vm.runInContext('resolvePluginActivationStateShared(params)',context)).toMatchObject({enabled:false,reason:'not in allowlist'});
});
