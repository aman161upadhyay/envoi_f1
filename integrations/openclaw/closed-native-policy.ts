import type {ClosedNativeBinding} from './closed-native-owner';
function refuse():never{throw Error('ACTUAL_RESTRICTED_NATIVE_CONFIGURATION_REQUIRED');}
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
/** Inspect ACTUAL native effective config; never populate a loaded-state observation from it. */
export function assertRestrictedNativeConfiguration(actual:unknown,b:Readonly<ClosedNativeBinding>){
 if(!object(actual)||actual.plugins?.enabled!==false||actual.cloudWorkers||actual.hooks?.enabled||actual.cron?.enabled)refuse();
 const plugins=actual.plugins;if(plugins.load?.paths?.length||Object.values(plugins.entries??{}).some((v:any)=>v?.enabled!==false)
  ||Object.values(plugins.slots??{}).some(v=>v!=='none'))refuse();
 const providers=actual.models?.providers;if(actual.models?.mode!=='replace'||!object(providers)||Object.keys(providers).length!==1||!object(providers.anthropic))refuse();
 const p=providers.anthropic;if(p.api!=='anthropic-messages'||p.baseUrl!==b.proxyOrigin||p.request?.proxy||p.request?.tls||p.localService)refuse();
 const policy=(v:any)=>v===undefined||object(v)&&v.id==='openclaw'&&Object.keys(v).length===1;
 if(!policy(p.agentRuntime)||!Array.isArray(p.models)||p.models.length!==1||p.models[0]?.id!==b.modelId||!policy(p.models[0]?.agentRuntime))refuse();
 const ref='anthropic/'+b.modelId,defaults=actual.agents?.defaults,primary=typeof defaults?.model==='string'?defaults.model:defaults?.model?.primary;
 if(primary!==ref||defaults?.model?.fallbacks?.length||defaults?.imageModel||defaults?.cliBackends&&Object.keys(defaults.cliBackends).length)refuse();
 for(const [key,value]of Object.entries(defaults?.models??{}))if(key!==ref||!object(value)||!policy(value.agentRuntime))refuse();
 const agents=actual.agents?.list;if(!Array.isArray(agents)||agents.length!==1||agents[0]?.id!==b.nativeAgentId)refuse();
 const a=agents[0];if(a.model||a.models||a.agentRuntime||a.subagents||a.runtime||a.tools||a.hooks)refuse();
 // Client-supplied Responses functions remain the only permitted tool channel.
 if(actual.tools?.profile!=='minimal'||!Array.isArray(actual.tools?.deny)||!actual.tools.deny.includes('*'))refuse();
 if(actual.gateway?.reload?.mode!=='off')refuse();
}
export const CLOSED_NATIVE_FORBIDDEN_ENV=Object.freeze(['OPENCLAW_BUILD_PRIVATE_QA','OPENCLAW_QA_FORCE_RUNTIME','NODE_OPTIONS','ANTHROPIC_BASE_URL','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','OPENCLAW_INCLUDE_ROOTS','OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS']);
export function assertRestrictedNativeEnvironment(env:Readonly<Record<string,string|undefined>>){if(CLOSED_NATIVE_FORBIDDEN_ENV.some(key=>env[key]!==undefined&&env[key]!==''))throw Error('ACTUAL_RESTRICTED_NATIVE_ENVIRONMENT_REQUIRED');}
