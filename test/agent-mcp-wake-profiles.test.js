import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {handleAgentMcp,agentMcpTools} from '../src/agent-mcp.js';
import {createMcpWakeTools} from '../src/mcp-wake-tools.js';
import {publicHttpError} from '../src/http-security.js';

const identity={inboxId:'inbox_mcp_wake',agent:{id:'agent_mcp_wake',permissions:['send_agent_messages','receive_agent_messages','create_assets']},family:{id:'family_mcp_wake',audience:'https://envoi.example/mcp',oauthClientId:'client_backend'},familyId:'family_mcp_wake',installationId:'installation_mcp_wake'};
const publicTool=({name,description,inputSchema})=>({name,description,inputSchema});
const protocol='2026-07-28';
async function invoke(method,params,options={},headers={}){
  const req=Readable.from([Buffer.from(JSON.stringify({jsonrpc:'2.0',id:1,method,...(params===undefined?{}:{params})}))]);
  req.method='POST';req.headers={accept:'application/json, text/event-stream','content-type':'application/json','mcp-protocol-version':'2025-11-25',...headers};
  const response={headers:{},status:null,value:null,setHeader(name,value){this.headers[name.toLowerCase()]=String(value);},writeHead(status,headers){this.status=status;for(const [name,value]of Object.entries(headers))this.setHeader(name,value);},end(text){this.value=text?JSON.parse(text):null;}};
  let error;
  try{await handleAgentMcp(req,response,{identity,callRest:async()=>({status:200,payload:{}}),...options});}
  catch(failure){error=failure;const outward=publicHttpError(failure,'req_mcp_wake_test');response.writeHead(outward.status,{'content-type':'application/json'});response.end(JSON.stringify(outward.body));}
  return {...response,error};
}
async function canonical(contract,file,ref){
  const relative=`test/contract-fixtures/${contract}/${file}`;
  try{return JSON.parse(await readFile(new URL(`../${relative}`,import.meta.url),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;return JSON.parse(execFileSync('git',['show',`${ref}:${relative}`],{cwd:new URL('..',import.meta.url),encoding:'utf8',windowsHide:true}));}
}
function wakeTools(httpWake={}){return createMcpWakeTools({httpWake,enabled:true,clientFor:()=>({connectionRoute:'provider_connector',wakeOrigins:['https://hooks.envoi-provider.com']})});}

test('default MCP behavior retains the original tools and version negotiation',async()=>{
  const list=await invoke('tools/list',{});assert.equal(list.status,200);assert.deepEqual(list.value.result.tools.map(publicTool),agentMcpTools.map(publicTool));assert.equal(list.value.result.tools.length,19);
  assert.equal(list.value.result.tools.find(tool=>tool.name==='envoi_agent_info').annotations.readOnlyHint,true);
  assert.deepEqual(list.value.result.tools.find(tool=>tool.name==='envoi_send_message').annotations,{readOnlyHint:false,destructiveHint:true,openWorldHint:true});
  assert.ok(list.value.result.tools.every(tool=>tool.securitySchemes===undefined),'legacy credentials do not declare OAuth');
  const initialize=await invoke('initialize',{protocolVersion:protocol,capabilities:{},clientInfo:{name:'test',version:'1'}});assert.equal(initialize.status,200);assert.equal(initialize.value.result.protocolVersion,'2025-11-25');assert.deepEqual(initialize.value.result.capabilities,{tools:{listChanged:false}});
  const invalid=await invoke('tools/call',{name:'envoi_claim_work',arguments:{unexpected:true}});assert.equal(invalid.value.error.code,-32602);
  const unknown=await invoke('tools/list',{}, {}, {'mcp-protocol-version':protocol});assert.equal(unknown.status,400);assert.equal(unknown.value.error.code,-32600);
});
test('disabled and unqualified event methods answer method-not-found even with the MCP2026 header',async()=>{
  for(const options of [{},{eventsEnabled:false,providerEvents:{available:()=>false}},{eventsEnabled:true,providerEvents:{available:()=>false}}]){
    for(const method of ['server/discover','events/list','events/subscribe','events/unsubscribe','events/not-real']){
      const result=await invoke(method,{},options,{'mcp-protocol-version':protocol});assert.equal(result.status,200,method);assert.deepEqual(result.value,{jsonrpc:'2.0',id:1,error:{code:-32601,message:'Method not found'}});
    }
  }
  const unsupported=await invoke('events/list',{}, {}, {'mcp-protocol-version':'2027-01-01'});assert.equal(unsupported.status,400);assert.equal(unsupported.value.error.code,-32600);
});
test('events capabilities are qualified and stay unavailable at older protocol versions',async()=>{
  let called=0;const providerEvents={available:(caller,version)=>Boolean(caller.family?.audience&&!caller.mcpScope&&version===protocol),list:()=>{called++;return {events:[]};},discover:()=>({resultType:'complete',supportedVersions:[protocol],capabilities:{tools:{},events:{}}})};
  const options={eventsEnabled:true,providerEvents};
  const init=await invoke('initialize',{protocolVersion:protocol,capabilities:{},clientInfo:{name:'test',version:'1'}},options);assert.equal(init.value.result.protocolVersion,protocol);assert.deepEqual(init.value.result.capabilities.events,{});
  const old=await invoke('events/list',{},options);assert.equal(old.status,200);assert.equal(old.value.error.code,-32601);assert.equal(called,0);
  const live=await invoke('events/list',{},options,{'mcp-protocol-version':protocol});assert.equal(live.status,200);assert.deepEqual(live.value.result,{events:[]});assert.equal(called,1);
  const unqualified=await invoke('events/list',{}, {...options,identity:{...identity,family:{}}},{'mcp-protocol-version':protocol});assert.equal(unqualified.value.error.code,-32601);assert.equal(called,1);
  const scoped=await invoke('events/list',{}, {...options,identity:{...identity,mcpScope:{caseId:'case_read'}}},{'mcp-protocol-version':protocol});assert.equal(scoped.value.error.code,-32601);assert.equal(called,1);
});
test('wake invalid arguments reach the canonical tool failure envelope before side effects',async()=>{
  const fixture=await canonical('mcp-wake','create-invalid-args.json','32975892945718296a4968a3d6ddbc40ef6d175b');let calls=0;
  const result=await invoke(fixture.request.body.method,fixture.request.body.params,{wakeTools:wakeTools({create:async()=>{calls++;throw new Error('Must not call');}})});
  assert.equal(result.status,fixture.response.status);assert.deepEqual(result.value,fixture.response.body);assert.equal(calls,0);
  for(const argumentsValue of [{},null,{url:17},[],{url:'https://hooks.envoi-provider.com/wake',installationId:'foreign'}]){
    const invalid=await invoke('tools/call',{name:'envoi_wake_create',arguments:argumentsValue},{wakeTools:wakeTools()});assert.equal(invalid.status,200);assert.equal(JSON.parse(invalid.value.result.content[0].text).code,'WAKE_SUBSCRIPTION_INVALID');
  }
  const invalidStatus=await invoke('tools/call',{name:'envoi_wake_status',arguments:null},{wakeTools:wakeTools()});assert.equal(JSON.parse(invalidStatus.value.result.content[0].text).code,'WAKE_SUBSCRIPTION_INVALID');
});
test('wake tools disappear while disabled or scoped; normal calls retain the approved result envelope',async()=>{
  const disabled=await invoke('tools/call',{name:'envoi_wake_create',arguments:{url:'https://hooks.envoi-provider.com/wake'}});assert.equal(disabled.value.error.code,-32602);
  const scoped=await invoke('tools/list',{}, {identity:{...identity,mcpScope:{caseId:'case_read'}},wakeTools:wakeTools()});assert.equal(scoped.value.result.tools.some(tool=>tool.name.startsWith('envoi_wake_')),false);
  const expected={httpWake:{available:true,version:1,subscription:null}};const status=await invoke('tools/call',{name:'envoi_wake_status',arguments:{}},{wakeTools:wakeTools({status:async()=>expected.httpWake})});assert.equal(status.status,200);assert.deepEqual(JSON.parse(status.value.result.content[0].text),{ok:true,tool:'envoi_wake_status',result:expected});
});
test('wake and event HTTP refusals retain canonical reason and bounded retry metadata',async()=>{
  for(const surface of ['wake','events']){
    for(const supplied of [600,999999,-1,undefined,2.3]){
      const failure=Object.assign(new Error('Too many subscriptions were created. Try again later.'),{statusCode:429,code:'RATE_LIMITED',reason:'wake_subscription_create_limit',...(supplied===undefined?{}:{retryAfter:supplied})});
      const options=surface==='wake'?{wakeTools:wakeTools({create:async()=>{throw failure;}})}:{eventsEnabled:true,providerEvents:{available:()=>true,subscribe:async()=>{throw failure;}}};
      const result=surface==='wake'?await invoke('tools/call',{name:'envoi_wake_create',arguments:{url:'https://hooks.envoi-provider.com/wake'}},options):await invoke('events/subscribe',{},options,{'mcp-protocol-version':protocol});
      const expected=supplied===600?600:supplied===999999?3600:supplied===2.3?3:1;
      assert.equal(result.status,429);assert.equal(result.error.statusCode,429);assert.equal(result.value.code,'RATE_LIMITED');assert.equal(result.value.reason,'wake_subscription_create_limit');assert.equal(result.value.retryAfterSeconds,expected);assert.equal(result.headers['retry-after'],String(expected));
    }
  }
  const reason=await invoke('events/subscribe',{}, {eventsEnabled:true,providerEvents:{available:()=>true,subscribe:async()=>{throw Object.assign(new Error('Not allowed'),{statusCode:400,code:'WAKE_URL_REJECTED',reason:'origin_not_allowed'});}}},{'mcp-protocol-version':protocol});assert.equal(reason.status,400);assert.equal(reason.value.reason,'origin_not_allowed');assert.equal(reason.headers['retry-after'],undefined);
});
test('callback RPC errors stay RPC errors without conversion into HTTP refusals',async()=>{
  const fixture=await canonical('provider-event-wake','subscribe-callback-origin-not-allowed.json','d920f65cf2ad2ec1933ab92c29d46fbdb4397a7b');
  const result=await invoke('events/subscribe',{}, {eventsEnabled:true,providerEvents:{available:()=>true,subscribe:async()=>{throw Object.assign(new Error('CallbackEndpointError'),{rpcCode:-32015,reason:'origin_not_allowed'});}}},{'mcp-protocol-version':protocol});assert.equal(result.status,200);assert.deepEqual(result.value,fixture.response.body);
});
