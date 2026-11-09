import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {FileStore} from '../src/storage.js';
import {createHttpWake} from '../src/http-wake.js';
import {createProviderEventWake,signProviderWebhook} from '../src/provider-event-wake.js';
import {createMcpWakeTools,mcpWakeTools} from '../src/mcp-wake-tools.js';
import {createWakeTransport} from '../src/http-wake-transport.js';
import {EventEmitter,once} from 'node:events';
import {handleAgentMcp} from '../src/agent-mcp.js';
import {wakeSubscriptionPath,wakeSubscriptionIndexDir,wakeQueueDir,wakeLiveDir} from '../src/http-wake-paths.js';

const pair=crypto.generateKeyPairSync('ed25519');
const keys=JSON.stringify([{kid:'provider_test',privateKey:pair.privateKey.export({type:'pkcs8',format:'der'}).toString('base64'),activeFrom:'2026-01-01T00:00:00Z'}]);
const identity={inboxId:'inbox_provider',agent:{id:'agent_provider',permissions:['receive_agent_messages']},family:{id:'family_provider',audience:'https://envoi.example/mcp',oauthClientId:'client_test'},installationId:'installation_provider',familyId:'family_provider'};
const binding={inboxId:identity.inboxId,agentId:identity.agent.id,familyId:identity.familyId,installationId:identity.installationId};
const secret=`whsec_${Buffer.alloc(32,5).toString('base64')}`;
const secondSecret=`whsec_${Buffer.alloc(32,6).toString('base64')}`;
const protocol='2026-07-28';
const parameters=(overrides={})=>({name:'envoi.work_available',arguments:{},delivery:{mode:'webhook',url:'https://callbacks.envoi-provider.com/events',secret},...overrides});
async function harness(t,kind='file',overrides={},providerOverrides={}){
  let store;
  if(kind==='postgres'){
    const {PostgresStore}=await import('../src/postgres-storage.js');const base=new PostgresStore(process.env.DATABASE_URL);await base.init();const prefix=`test/provider_wake_${crypto.randomUUID()}`;
    store={withTransaction:base.withTransaction.bind(base),getJson:(p,d)=>base.getJson(`${prefix}/${p}`,d),putJson:(p,v)=>base.putJson(`${prefix}/${p}`,v),listJson:p=>base.listJson(`${prefix}/${p}`),deleteJson:p=>base.deleteJson(`${prefix}/${p}`)};t.after(async()=>{try{await base.deleteJsonTree(prefix);}finally{await base.close();}});
  }else{const dir=await mkdtemp(path.join(process.cwd(),'.provider-wake-test-'));store=new FileStore(dir);await store.init();t.after(()=>rm(dir,{recursive:true,force:true}));}
  let clock=Date.parse('2026-10-24T12:00:00Z'),response={status:202,failureClass:null},beforeResolve,beforeSend,verificationResponse;
  const sent=[],audits=[],diagnostics=[],state={family:{refreshExpiresAt:'2027-01-01T00:00:00Z'},agent:{status:'active',onboardingStatus:'approved',permissions:['receive_agent_messages']},installation:{status:'active'}};
  const now=()=>new Date(clock).toISOString();
  const resolveDestination=async url=>{await beforeResolve?.();return {url,addresses:['192.0.43.11']};};
  const options={store,enabled:true,installationsEnabled:true,mcpWakeEnabled:true,mcpEventsEnabled:true,grokTriggerEnabled:true,env:{ENVOI_WAKE_SIGNING_KEYS:keys},facts:async()=>state,now,random:()=>0.5,resolveDestination,observe:()=>{},audit:async(...args)=>audits.push(args),transport:async request=>{sent.push(request);await beforeSend?.(request);const body=JSON.parse(request.bodyText);return body.type==='verification'?(verificationResponse||{status:200,failureClass:null,bodyText:JSON.stringify({challenge:body.challenge})}):response;},...overrides};
  const http=createHttpWake(options);
  const providerOptions={httpWake:http,store,mcpEventsEnabled:options.mcpEventsEnabled,grokTriggerEnabled:options.grokTriggerEnabled,key:Buffer.alloc(32,7),env:{ENVOI_MCP_EVENTS_CALLBACK_ORIGINS:'https://callbacks.envoi-provider.com',ENVOI_GROK_TRIGGER_ORIGINS:'https://triggers.envoi-provider.com'},now,resolveDestination,audit:options.audit,observe:record=>diagnostics.push(record),eventHistory:async()=>({cursor:'00000000000000000012',truncated:false,events:[]}),...providerOverrides};
  const provider=createProviderEventWake(providerOptions);await http.startup();
  const tx=fn=>store.withTransaction([`inbox:${identity.inboxId}:mutations`],fn);
  return {store,http,provider,options,providerOptions,now,tx,state,sent,audits,diagnostics,advance:ms=>clock+=ms,response:r=>response=r,beforeResolve:fn=>beforeResolve=fn,beforeSend:fn=>beforeSend=fn,verificationResponse:r=>verificationResponse=r};
}
function parity(name,operation){for(const kind of ['file','postgres'])test(`${kind}: ${name}`,{skip:kind==='postgres'&&!process.env.DATABASE_URL},t=>operation(t,kind));}
const verifyHmac=(request,key=secret,index=0)=>{
  const content=`${request.headers['webhook-id']}.${request.headers['webhook-timestamp']}.${request.bodyText}`;
  const expected=crypto.createHmac('sha256',Buffer.from(key.slice(6),'base64')).update(content).digest('base64');
  assert.equal(request.headers['webhook-signature'].split(' ')[index],`v1,${expected}`);
};

parity('MCP events verify, renew deterministically, rotate secrets and reuse the durable wake queue',async(t,kind)=>{
  const h=await harness(t,kind);
  const first=await h.provider.subscribe(identity,parameters(),protocol);assert.match(first.id,/^evtsub_[0-9a-f]{20}$/);assert.equal(first.cursor,'00000000000000000012');
  verifyHmac(h.sent[0]);assert.equal(JSON.parse(h.sent[0].bodyText).type,'verification');
  const stored=await h.store.getJson(wakeSubscriptionPath(binding.agentId,first.id));assert.equal(JSON.stringify(stored).includes(secret),false);assert.ok(stored.secretEncrypted.ciphertext);
  h.advance(1000);const renewed=await h.provider.subscribe(identity,parameters(),protocol);assert.equal(renewed.id,first.id);assert.notEqual(renewed.refreshBefore,first.refreshBefore);assert.equal(h.sent.length,1);
  await h.tx(()=>h.http.trigger({...binding,reason:'message_delivered'}));await h.http.runOnce();const event=h.sent.at(-1);verifyHmac(event);const body=JSON.parse(event.bodyText);assert.equal(body.name,'envoi.work_available');assert.equal(body.eventId,event.headers['webhook-id']);assert.deepEqual(body.data,{reason:'message_delivered'});assert.equal(body.cursor,first.cursor);assert.equal(Buffer.byteLength(event.bodyText)<1024,true);assert.equal('agentId' in body,false);
  const params=parameters({delivery:{...parameters().delivery,secret:secondSecret}});await h.provider.subscribe(identity,params,protocol);assert.equal(JSON.parse(h.sent.at(-1).bodyText).type,'verification');
  await h.tx(()=>h.http.trigger({...binding,reason:'work_due'}));await h.http.runOnce();verifyHmac(h.sent.at(-1),secondSecret);verifyHmac(h.sent.at(-1),secret,1);
  h.advance(600001);await h.tx(()=>h.http.trigger({...binding,reason:'message_delivered'}));await h.http.runOnce();assert.equal(h.sent.at(-1).headers['webhook-signature'].split(' ').length,1);assert.equal((await h.store.getJson(wakeSubscriptionPath(binding.agentId,first.id))).previousSecretEncrypted,undefined);
  assert.ok((await h.store.listJson(wakeQueueDir)).length>=3);
});
parity('provider retry preserves event identity and raw bytes with a fresh signing clock',async(t,kind)=>{
  const h=await harness(t,kind);await h.provider.subscribe(identity,parameters(),protocol);await h.tx(()=>h.http.trigger({...binding,reason:'message_delivered'}));h.response({status:429,failureClass:'http_retryable',retryAfterSeconds:60});await h.http.runOnce();const first=h.sent.at(-1);h.advance(59000);assert.equal(await h.http.runOnce(),false);h.advance(1000);h.response({status:202,failureClass:null});await h.http.runOnce();const second=h.sent.at(-1);assert.equal(second.bodyText,first.bodyText);assert.equal(second.headers['webhook-id'],first.headers['webhook-id']);assert.notEqual(second.headers['webhook-timestamp'],first.headers['webhook-timestamp']);verifyHmac(second);
});
parity('post-verification persistence failure rolls back subscription activation and catch-up notifications',async(t,kind)=>{
  const h=await harness(t,kind,{}, {eventHistory:async()=>({cursor:'00000000000000000012',truncated:false,events:[{type:'wake.work_available',reason:'message_delivered',cursor:'00000000000000000012'}]})});
  const put=h.store.putJson.bind(h.store),failure=new Error('Injected notification index write failure');
  h.store.putJson=async(p,value)=>{if(p.startsWith(`${wakeLiveDir}${path.sep}`))throw failure;return put(p,value);};
  await assert.rejects(h.provider.subscribe(identity,parameters(),protocol),error=>error===failure);
  assert.equal(JSON.parse(h.sent[0].bodyText).type,'verification');
  assert.equal(h.diagnostics.length,1);assert.equal(h.diagnostics[0].phase,'replay');
  assert.deepEqual(await h.http.profileRecords(binding,'mcp_events'),[]);
  for(const dir of [wakeSubscriptionIndexDir,wakeQueueDir,wakeLiveDir,'http-wake/verification'])assert.deepEqual(await h.store.listJson(dir),[]);
  assert.equal(await h.http.runOnce(),false);
  h.store.putJson=put;
  const retry=await h.provider.subscribe(identity,parameters(),protocol);
  assert.equal((await h.http.profileRecords(binding,'mcp_events')).length,1);
  assert.equal((await h.store.listJson(wakeQueueDir)).length,1);
  assert.equal(await h.http.runOnce(),true);
  assert.equal(JSON.parse(h.sent.at(-1).bodyText).name,'envoi.work_available');
  assert.equal((await h.store.getJson(wakeSubscriptionPath(binding.agentId,retry.id))).delivery.state,'healthy');
});
parity('failed secret renewal preserves the working subscription and its queued notification',async(t,kind)=>{
  const h=await harness(t,kind);const created=await h.provider.subscribe(identity,parameters(),protocol);
  await h.tx(()=>h.http.trigger({...binding,reason:'message_delivered',cursor:'00000000000000000013'}));
  const before=await h.store.getJson(wakeSubscriptionPath(binding.agentId,created.id));
  const queued=await h.store.listJson(wakeQueueDir),put=h.store.putJson.bind(h.store),failure=new Error('Injected verification cache write failure');
  h.store.putJson=async(p,value)=>{if(p.startsWith('http-wake/verification/'))throw failure;return put(p,value);};
  h.advance(1000);
  await assert.rejects(h.provider.subscribe(identity,parameters({delivery:{...parameters().delivery,secret:secondSecret}}),protocol),error=>error===failure);
  assert.equal(h.diagnostics[0].phase,'verification_cache');
  assert.deepEqual(await h.store.getJson(wakeSubscriptionPath(binding.agentId,created.id)),before);
  assert.deepEqual(await h.store.listJson(wakeQueueDir),queued);
  h.store.putJson=put;
  assert.equal(await h.http.runOnce(),true);verifyHmac(h.sent.at(-1),secret);
});
test('subscription diagnostics expose only bounded failure facts and cannot replace the error',async t=>{
  const failure=Object.assign(new Error(`${secret} https://callbacks.envoi-provider.com/private SQL_VALUE`),{code:'57014'});
  const h=await harness(t,'file',{}, {eventHistory:async()=>{throw failure;}});
  await assert.rejects(h.provider.subscribe(identity,parameters({_meta:{private:'META_NOT_LOGGED'}}),protocol),error=>error===failure);
  assert.deepEqual(h.diagnostics,[{event:'envoi.mcp_events_subscribe_failed',subscriptionId:h.diagnostics[0].subscriptionId,phase:'history',errorClass:'Error',code:'57014',durationMs:0}]);
  assert.match(h.diagnostics[0].subscriptionId,/^evtsub_[0-9a-f]{20}$/);
  for(const marker of [secret,'callbacks.envoi-provider.com','SQL_VALUE','META_NOT_LOGGED'])assert.equal(JSON.stringify(h.diagnostics).includes(marker),false);
  const brokenObserver=createProviderEventWake({...h.providerOptions,httpWake:createHttpWake(h.options),observe:()=>{throw new Error('Observer failed');}});
  await assert.rejects(brokenObserver.subscribe(identity,parameters(),protocol),error=>error===failure);
});
for(const eventName of ['envoi.work_available','envoi.control_changed'])parity(`${eventName}: maximum retained history uses bounded storage work and preserves catch-up hints`,async(t,kind)=>{
  const cursor=n=>String(n).padStart(20,'0');
  const events=Array.from({length:1000},(_,n)=>({type:n%2?'wake.control_changed':'wake.work_available',reason:n%2?'agent_paused':n===0?'agent_resumed':'message_delivered',cursor:cursor(n+1)}));
  const h=await harness(t,kind,{}, {eventHistory:async()=>({cursor:cursor(1000),truncated:true,events})});
  let writes=0;const put=h.store.putJson.bind(h.store);h.store.putJson=(p,value)=>{writes++;return put(p,value);};
  const created=await h.provider.subscribe(identity,parameters({name:eventName,cursor:cursor(0)}),protocol);
  assert.equal(created.cursor,cursor(1000));assert.equal(created.truncated,true);
  assert.ok(writes<40,`Retained history caused ${writes} writes before subscribe returned`);
  assert.equal(await h.http.runOnce(),true);
  const first=JSON.parse(h.sent.at(-1).bodyText);assert.equal(first.name,eventName);assert.equal(first.data.reason,eventName==='envoi.work_available'?'agent_resumed':'agent_paused');assert.equal(first.cursor,cursor(1000));
  assert.equal(await h.http.runOnce(),true);
  const last=JSON.parse(h.sent.at(-1).bodyText);assert.equal(last.name,eventName);assert.equal(last.data.reason,eventName==='envoi.work_available'?'message_delivered':'agent_paused');assert.equal(last.cursor,cursor(1000));
  assert.equal(await h.http.runOnce(),false);
});
parity('dispatcher cannot send catch-up events before the subscribe transaction commits',async(t,kind)=>{
  const h=await harness(t,kind,{}, {eventHistory:async()=>({cursor:'00000000000000000012',truncated:false,events:[{type:'wake.work_available',reason:'message_delivered',cursor:'00000000000000000012'}]})});
  let reached,release,stagedPath;const ready=new Promise(resolve=>reached=resolve),gate=new Promise(resolve=>release=resolve);
  const put=h.store.putJson.bind(h.store);
  h.store.putJson=async(p,value)=>{await put(p,value);if(p.startsWith(`${wakeLiveDir}${path.sep}`)){stagedPath=p;reached();await gate;}};
  const pending=h.provider.subscribe(identity,parameters(),protocol);
  try{
    await Promise.race([ready,pending.then(()=>{throw new Error('Subscribe completed before the commit barrier');})]);
    // FileStore serializes outside readers behind the transaction; its index is
    // not on disk yet. PostgreSQL readers can observe the committed empty index.
    if(kind==='file')await assert.rejects(readFile(h.store.file(stagedPath)),{code:'ENOENT'});
    else assert.equal(await h.http.runOnce(),false);
    assert.equal(h.sent.length,1);
  }finally{release();await pending;h.store.putJson=put;}
  assert.equal(await h.http.runOnce(),true);
  assert.equal(JSON.parse(h.sent.at(-1).bodyText).name,'envoi.work_available');
});
test('retained catch-up returns its HTTP subscribe result before the socket idle timeout',async t=>{
  const events=Array.from({length:200},(_,n)=>({type:'wake.work_available',reason:'message_delivered',cursor:String(n+1).padStart(20,'0')}));
  const h=await harness(t,'file',{}, {eventHistory:async()=>({cursor:events.at(-1).cursor,truncated:false,events})});
  const put=h.store.putJson.bind(h.store);
  // Model database round-trip latency. Per-row replay used to outlive the HTTP
  // idle deadline even though verification succeeded and delivery had started.
  h.store.putJson=async(p,value)=>{await new Promise(resolve=>setTimeout(resolve,25));return put(p,value);};
  let handling=Promise.resolve();
  const server=http.createServer((req,res)=>{
    req.setTimeout(2000);
    handling=handleAgentMcp(req,res,{identity,providerEvents:h.provider,eventsEnabled:true,callRest:async()=>{throw new Error('Not a tool call');}}).catch(()=>{if(!res.destroyed){res.writeHead(500);res.end();}});
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const response=await fetch(`http://127.0.0.1:${server.address().port}/mcp`,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':protocol},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'events/subscribe',params:parameters()}),signal:AbortSignal.timeout(10000)});
    assert.equal(response.status,200);const body=await response.json();assert.match(body.result.id,/^evtsub_[0-9a-f]{20}$/);assert.equal(body.result.cursor,events.at(-1).cursor);
  }finally{await handling;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
parity('unsubscribe deletes secrets, invalidates verification and fences previous generations',async(t,kind)=>{
  const h=await harness(t,kind);const first=await h.provider.subscribe(identity,parameters(),protocol);await h.tx(()=>h.http.trigger({...binding,reason:'message_delivered'}));
  const stale=await h.store.getJson(wakeSubscriptionPath(binding.agentId,first.id));
  const {secret:_,...delivery}=parameters().delivery;const unsubscribe={name:parameters().name,arguments:{},delivery};assert.deepEqual(await h.tx(()=>h.provider.unsubscribe(identity,unsubscribe,protocol)),{});assert.deepEqual(await h.tx(()=>h.provider.unsubscribe(identity,unsubscribe,protocol)),{});
  const ended=await h.store.getJson(wakeSubscriptionPath(binding.agentId,first.id));assert.equal(ended.secretEncrypted,undefined);assert.equal(ended.status,'ended');const sent=h.sent.length;
  await h.http.queueProfile(stale,'wake.work_available','work_due');assert.equal((await h.store.getJson(wakeSubscriptionPath(binding.agentId,first.id))).status,'ended');
  await h.provider.subscribe(identity,parameters(),protocol);assert.equal(h.sent.length,sent+1);assert.equal(await h.http.runOnce(),false);
});
parity('Grok 202 is receipt only; 401 pauses and owner secret replacement resumes; sender defects do not retry',async(t,kind)=>{
  const h=await harness(t,kind);const put=()=>h.provider.putGrok(binding,{url:'https://triggers.envoi-provider.com/run',secret});const initial=await h.tx(put);assert.equal(initial.target.secretSet,true);assert.equal(JSON.stringify(initial).includes(secret),false);
  await assert.rejects(h.http.end(binding,initial.target.id),{code:'WAKE_SUBSCRIPTION_NOT_FOUND'});
  h.response({status:401,failureClass:'http_rejected'});await h.http.runOnce();assert.equal((await h.provider.getGrok(binding)).target.state,'needs_secret');h.advance(120000);assert.equal(await h.http.runOnce(),false);
  await h.tx(put);h.response({status:202,failureClass:null});await h.http.runOnce();const accepted=(await h.provider.getGrok(binding)).target;assert.equal(accepted.state,'active');assert.ok(accepted.lastAcceptedAt);assert.equal('processedAt' in accepted,false);
  await h.tx(()=>h.http.trigger({...binding,reason:'message_delivered'}));assert.equal(await h.http.runOnce(),false);h.advance(5000);h.response({status:413,failureClass:'http_rejected'});await h.http.runOnce();assert.equal((await h.provider.getGrok(binding)).target.state,'needs_attention');assert.ok(h.audits.some(row=>row[1]==='agent.wake_target_attention'));
  await h.tx(()=>h.provider.deleteGrok(binding));const record=await h.store.getJson(wakeSubscriptionPath(binding.agentId,initial.target.id));assert.equal(record.secretEncrypted,undefined);
  const ended=(await h.provider.getGrok(binding)).target;assert.equal(ended.state,'ended');assert.equal(ended.secretSet,true);
});
parity('flag-off ends only its profile, durably deletes secrets and preserves Ed25519 REST subscriptions',async(t,kind)=>{
  const h=await harness(t,kind);const created=await h.tx(()=>h.http.create(binding,{url:'https://callbacks.envoi-provider.com/rest'}));const provider=await h.provider.subscribe(identity,parameters(),protocol);h.advance(1);
  const off=createHttpWake({...h.options,mcpEventsEnabled:false});createProviderEventWake({...h.providerOptions,httpWake:off,mcpEventsEnabled:false});await off.startup();
  const records=await h.tx(()=>off.profileRecords(binding,'mcp_events'));assert.equal(records[0].endedReason,'feature_disabled');assert.equal((await h.store.getJson(wakeSubscriptionPath(binding.agentId,provider.id))).secretEncrypted,undefined);assert.equal((await off.list(binding)).subscriptions.find(row=>row.id===created.subscription.id).status,'pending');
  const restored=createHttpWake(h.options);createProviderEventWake({...h.providerOptions,httpWake:restored});await restored.startup();assert.equal((await restored.profileRecords(binding,'mcp_events'))[0].status,'ended');
});
parity('pause emits control only; revoke or explicit installation end blocks effects and erases secrets',async(t,kind)=>{
  const h=await harness(t,kind);const control=parameters({name:'envoi.control_changed'});const created=await h.provider.subscribe(identity,control,protocol);h.state.agent.status='paused';await h.tx(()=>h.http.pause(binding.inboxId,binding.agentId,'00000000000000000013'));await h.http.runOnce();assert.equal(JSON.parse(h.sent.at(-1).bodyText).name,'envoi.control_changed');assert.equal(JSON.parse(h.sent.at(-1).bodyText).cursor,'00000000000000000013');
  h.state.agent.status='active';await h.tx(()=>h.http.trigger({...binding,type:'wake.control_changed',reason:'case_controlled'}));h.beforeResolve(()=>{h.state.installation.status='ended';});const count=h.sent.length;await h.http.runOnce();assert.equal(h.sent.length,count);const record=await h.store.getJson(wakeSubscriptionPath(binding.agentId,created.id));assert.equal(record.endedReason,'credential_ended');assert.equal(record.secretEncrypted,undefined);
});
test('methods require qualifying audience and MCP2026; closed inputs and TTL/secret bounds are enforced',async t=>{
  const h=await harness(t);assert.throws(()=>h.provider.discover(identity,'2025-11-25'),{rpcCode:-32601});assert.equal(h.provider.discover(identity,protocol).capabilities.events.constructor,Object);assert.throws(()=>h.provider.list(identity,{},'2025-11-25'),{rpcCode:-32601});assert.throws(()=>h.provider.list({...identity,family:{}},{},protocol),{rpcCode:-32601});
  for(const params of [parameters({ttlMs:10}),parameters({ttlMs:604800001}),parameters({arguments:{agentId:'foreign'}}),parameters({delivery:{...parameters().delivery,secret:'whsec_short'}})])await assert.rejects(h.provider.subscribe(identity,params,protocol),{rpcCode:-32602});
  await assert.rejects(h.provider.unsubscribe(identity,{name:'envoi.work_available',arguments:{},delivery:{url:parameters().delivery.url}},protocol),{rpcCode:-32602});
});
test('empty operator allowlists are inert before DNS or verification; cache hits still check DNS',async t=>{
  const h=await harness(t);const emptyHttp=createHttpWake(h.options);const emptyProvider=createProviderEventWake({...h.providerOptions,httpWake:emptyHttp,env:{}});let calls=0;h.beforeResolve(()=>calls++);
  await assert.rejects(emptyProvider.subscribe(identity,parameters(),protocol),{rpcCode:-32015,reason:'origin_not_allowed'});await assert.rejects(emptyProvider.putGrok(binding,{url:'https://triggers.envoi-provider.com/run',secret}),{code:'WAKE_URL_REJECTED',reason:'origin_not_allowed'});assert.equal(calls,0);
  await h.provider.subscribe(identity,parameters(),protocol);h.beforeResolve(()=>{throw new Error('Private address');});await assert.rejects(h.provider.subscribe(identity,parameters(),protocol),{rpcCode:-32015,reason:'address_not_allowed'});
});
test('verification failures persist no subscription or secret; cache expiry requires a new challenge',async t=>{
  const h=await harness(t);h.verificationResponse({status:200,failureClass:null,bodyText:'{"challenge":"wrong"}'});await assert.rejects(h.provider.subscribe(identity,parameters(),protocol),{rpcCode:-32015,reason:'challenge_failed'});assert.deepEqual(await h.http.profileRecords(binding,'mcp_events'),[]);
  h.verificationResponse(null);await h.provider.subscribe(identity,parameters(),protocol);const count=h.sent.length;h.advance(3599000);await h.provider.subscribe(identity,parameters(),protocol);assert.equal(h.sent.length,count);h.advance(1001);await h.provider.subscribe(identity,parameters(),protocol);assert.equal(h.sent.length,count+1);
});
test('MCP tool route/origin binding precedes DNS, hidden createdVia, installation isolation and durable flag-off',async t=>{
  const h=await harness(t);let client={connectionRoute:'provider_connector',wakeOrigins:['https://callbacks.envoi-provider.com']};const tools=createMcpWakeTools({enabled:true,httpWake:h.http,clientFor:()=>client});let dns=0;h.beforeResolve(()=>dns++);
  const refused=JSON.parse((await tools.call('envoi_wake_create',{url:'https://elsewhere.envoi-provider.com/wake'},identity)).content[0].text);assert.equal(refused.code,'WAKE_URL_REJECTED');assert.equal(refused.reason,'origin_not_declared');assert.equal(dns,0);
  client={connectionRoute:'remote_mcp_oauth'};assert.equal(JSON.parse((await tools.call('envoi_wake_create',{url:parameters().delivery.url},identity)).content[0].text).code,'WAKE_ROUTE_NOT_SUPPORTED');client={connectionRoute:'provider_connector',wakeOrigins:['https://callbacks.envoi-provider.com']};
  const created=JSON.parse((await h.tx(()=>tools.call('envoi_wake_create',{url:parameters().delivery.url},identity))).content[0].text);assert.equal(created.ok,true);assert.equal('createdVia' in created.result.subscription,false);const id=created.result.subscription.id;assert.equal((await h.store.getJson(wakeSubscriptionPath(binding.agentId,id))).createdVia,'mcp');
  const foreign=JSON.parse((await tools.call('envoi_wake_end',{subscriptionId:id},{...identity,installationId:'another_installation'})).content[0].text);assert.equal(foreign.code,'WAKE_SUBSCRIPTION_NOT_FOUND');
  h.advance(1);const off=createHttpWake({...h.options,mcpWakeEnabled:false});await off.startup();assert.equal((await off.list(binding)).subscriptions[0].endedReason,'feature_disabled');assert.equal(createMcpWakeTools({enabled:false,httpWake:h.http}).available(identity),false);assert.equal(tools.available({...identity,mcpScope:{caseId:'case_private'}}),false);
});
test('Standard Webhooks signs supplied decoded bytes and never uses the Ed25519 headers',()=>{
  const headers=signProviderWebhook({secret,bodyText:'{}',id:'wake_evt_test',at:'2026-10-24T12:00:00Z'});verifyHmac({headers,bodyText:'{}'});assert.equal(headers['envoi-wake-signature'],undefined);
});
parity('MCP and provider creates share durable quotas before DNS; no installation can multiply events by retrying',async(t,kind)=>{
  const h=await harness(t,kind);let dns=0;h.beforeResolve(()=>dns++);h.verificationResponse({status:400,failureClass:'http_rejected'});
  for(let attempt=0;attempt<5;attempt++)await assert.rejects(h.provider.subscribe(identity,parameters(),protocol),{rpcCode:-32015});
  const prior=dns;await assert.rejects(h.provider.subscribe(identity,parameters(),protocol),{code:'RATE_LIMITED'});assert.equal(dns,prior);
  await assert.rejects(h.tx(()=>h.http.create(binding,{url:'https://callbacks.envoi-provider.com/rest'})),{code:'RATE_LIMITED'});assert.equal(dns,prior);
});
test('provider transport reads only opt-in bounded verification bodies and honors Retry-After on all retry statuses',async()=>{
  for(const [status,readResponseBody]of [[425,true],[500,false]]){
    const send=createWakeTransport({request:(_url,_options,callback)=>{const req=new EventEmitter();req.destroy=()=>{};req.end=()=>{const res=new EventEmitter();res.statusCode=status;res.headers={'retry-after':'90'};res.destroy=()=>res.emit('close');callback(res);res.emit('data',Buffer.from('{"challenge":"ok"}'));res.emit('end');};return req;}});
    const result=await send({url:'https://callbacks.envoi-provider.com/events',addresses:['192.0.43.11'],headers:{},bodyText:'{}',standardWebhooks:true,readResponseBody});assert.equal(result.retryAfterSeconds,90);assert.equal(result.bodyText,readResponseBody?'{"challenge":"ok"}':undefined);
  }
});
async function canonical(contract,file,ref){
  const relative=`test/contract-fixtures/${contract}/${file}`;
  // The implementation task starts at f897404, before these independently approved contract
  // branches are composed. On the combined candidate the canonical files are read directly.
  try{return JSON.parse(await readFile(new URL(`../${relative}`,import.meta.url),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;return JSON.parse(execFileSync('git',['show',`${ref}:${relative}`],{cwd:new URL('..',import.meta.url),encoding:'utf8',windowsHide:true}));}
}
test('MCP wake tool metadata/input schemas and events discovery/list match approved canonical fixture tables',async t=>{
  const h=await harness(t);const mcp=await canonical('mcp-wake','schemas.json','32975892945718296a4968a3d6ddbc40ef6d175b');
  assert.deepEqual(mcpWakeTools.map(({description:_,...tool})=>tool),mcp['x-tools']);
  const discover=await canonical('provider-event-wake-discovery','discover-events-capability.json','4e7163203a78ab584ff9569044b99d28b681f0ba');assert.deepEqual(h.provider.discover(identity,protocol),discover.response.body.result);
  const list=await canonical('provider-event-wake','events-list.json','d920f65cf2ad2ec1933ab92c29d46fbdb4397a7b');assert.deepEqual(h.provider.list(identity,{},protocol),list.response.body.result);
});
parity('live a4 cursors advance through coalescing, retries and reconnect without regressing to older replay',async(t,kind)=>{
  const h=await harness(t,kind);const created=await h.provider.subscribe(identity,parameters(),protocol);
  await h.tx(()=>h.http.trigger({...binding,reason:'message_delivered',cursor:'00000000000000000013'}));
  await h.tx(()=>h.http.trigger({...binding,reason:'message_delivered',cursor:'00000000000000000014'}));
  await h.http.runOnce();assert.equal(JSON.parse(h.sent.at(-1).bodyText).cursor,'00000000000000000013');
  h.response({status:429,failureClass:'http_retryable',retryAfterSeconds:10});await h.http.runOnce();assert.equal(JSON.parse(h.sent.at(-1).bodyText).cursor,'00000000000000000014');const retry=h.sent.at(-1).bodyText;
  h.advance(10000);h.response({status:202,failureClass:null});await h.http.runOnce();assert.equal(h.sent.at(-1).bodyText,retry);
  const current=await h.store.getJson(wakeSubscriptionPath(binding.agentId,created.id));assert.equal(current.cursor,'00000000000000000014');
  await h.http.queueProfile(current,'wake.work_available','work_due','00000000000000000011');await h.http.runOnce();assert.equal(JSON.parse(h.sent.at(-1).bodyText).cursor,'00000000000000000014');
});
parity('Grok owner authority is checked inside the mutation after DNS and before replacement or deletion',async(t,kind)=>{
  let authorized=true,checks=0;
  const h=await harness(t,kind,{}, {authorizeOwner:async caller=>{checks++;assert.equal(caller.ownerMarker,'private-request-context');if(!authorized)throw Object.assign(new Error('Owner authority ended'),{statusCode:403,code:'AUTHENTICATION_REQUIRED'});}});
  const owner={...binding,ownerMarker:'private-request-context',request:()=>{throw new Error('Must never persist request context');}};
  h.beforeResolve(()=>{authorized=false;});
  await assert.rejects(h.provider.putGrok(owner,{url:'https://triggers.envoi-provider.com/run',secret}),{code:'AUTHENTICATION_REQUIRED'});assert.deepEqual(await h.http.profileRecords(binding,'grok_trigger'),[]);assert.equal(checks,1);
  authorized=true;h.beforeResolve(null);const created=await h.provider.putGrok(owner,{url:'https://triggers.envoi-provider.com/run',secret});const original=await h.store.getJson(wakeSubscriptionPath(binding.agentId,created.target.id));assert.equal('request' in original,false);assert.equal('beforeCommit' in original,false);assert.equal('ownerMarker' in original,false);
  h.beforeResolve(()=>{authorized=false;});await assert.rejects(h.provider.putGrok(owner,{url:'https://triggers.envoi-provider.com/changed',secret:secondSecret}),{code:'AUTHENTICATION_REQUIRED'});
  await assert.rejects(h.provider.deleteGrok(owner),{code:'AUTHENTICATION_REQUIRED'});const current=await h.store.getJson(wakeSubscriptionPath(binding.agentId,created.target.id));assert.equal(current.status,'active');assert.deepEqual(current.secretEncrypted,original.secretEncrypted);assert.equal(current.url,original.url);
});
test('cursor validation precedes quota, callback DNS and verification',async t=>{
  let validated=0,dns=0;const h=await harness(t,'file',{}, {validateCursor:async(_identity,cursor)=>{validated++;if(cursor>'00000000000000000012')throw Object.assign(new Error('Invalid params'),{rpcCode:-32602});}});h.beforeResolve(()=>dns++);
  await assert.rejects(h.provider.subscribe(identity,parameters({cursor:'00000000000000000099'}),protocol),{rpcCode:-32602});assert.equal(validated,1);assert.equal(dns,0);assert.equal(h.sent.length,0);assert.equal(await h.store.getJson(path.join('http-wake','create-limits',`${binding.agentId}.json`)),null);
});
parity('Grok URL/secret replacement during DNS prevents the old destination effect and retains the public target id',async(t,kind)=>{
  const h=await harness(t,kind);const first=await h.provider.putGrok(binding,{url:'https://triggers.envoi-provider.com/old',secret});
  const old=await h.store.getJson(wakeSubscriptionPath(binding.agentId,first.target.id));let replaced;
  h.beforeResolve(async()=>{h.beforeResolve(null);replaced=await h.provider.putGrok(binding,{url:'https://triggers.envoi-provider.com/new',secret:secondSecret});});
  await h.http.runOnce();assert.equal(h.sent.length,0);assert.equal(replaced.target.id,first.target.id);
  const current=await h.store.getJson(wakeSubscriptionPath(binding.agentId,first.target.id));assert.notEqual(current.generation,old.generation);assert.equal(current.url,'https://triggers.envoi-provider.com/new');assert.equal(current.status,'active');
  await h.http.runOnce();assert.equal(h.sent.length,1);assert.equal(h.sent[0].url,current.url);verifyHmac(h.sent[0],secondSecret);
});
parity('late old Grok 410 cannot end the replacement target or delete its new secret',async(t,kind)=>{
  const h=await harness(t,kind);const first=await h.provider.putGrok(binding,{url:'https://triggers.envoi-provider.com/old',secret});let replacement;
  h.beforeSend(async()=>{h.beforeSend(null);replacement=await h.provider.putGrok(binding,{url:'https://triggers.envoi-provider.com/new',secret:secondSecret});h.response({status:410,failureClass:'receiver_gone'});});
  await h.http.runOnce();assert.equal(h.sent.length,1);assert.equal(replacement.target.id,first.target.id);
  const current=await h.store.getJson(wakeSubscriptionPath(binding.agentId,first.target.id));assert.equal(current.status,'active');assert.equal(current.targetState,'active');assert.ok(current.secretEncrypted);assert.equal(current.delivery.lastFailureClass,null);assert.equal(current.delivery.lastAttemptAt,null);
  h.response({status:202,failureClass:null});assert.equal(await h.http.runOnce(),false);h.advance(5000);await h.http.runOnce();assert.equal(h.sent.at(-1).url,'https://triggers.envoi-provider.com/new');verifyHmac(h.sent.at(-1),secondSecret);
});
parity('late old MCP event 410 cannot end a newly subscribed generation of the same deterministic id',async(t,kind)=>{
  const h=await harness(t,kind);const first=await h.provider.subscribe(identity,parameters(),protocol);const previous=await h.store.getJson(wakeSubscriptionPath(binding.agentId,first.id));await h.tx(()=>h.http.trigger({...binding,reason:'message_delivered'}));
  h.beforeSend(async()=>{h.beforeSend(null);const {secret:_,...delivery}=parameters().delivery;await h.provider.unsubscribe(identity,{name:'envoi.work_available',arguments:{},delivery},protocol);const replacement=await h.provider.subscribe(identity,parameters({delivery:{...parameters().delivery,secret:secondSecret}}),protocol);assert.equal(replacement.id,first.id);h.response({status:410,failureClass:'receiver_gone'});});
  await h.http.runOnce();const current=await h.store.getJson(wakeSubscriptionPath(binding.agentId,first.id));assert.equal(current.status,'active');assert.notEqual(current.generation,previous.generation);assert.ok(current.secretEncrypted);assert.equal(current.delivery.lastFailureClass,null);
  h.response({status:202,failureClass:null});await h.tx(()=>h.http.trigger({...binding,reason:'message_delivered'}));await h.http.runOnce();verifyHmac(h.sent.at(-1),secondSecret);
});
parity('permission removal during DNS refuses callback verification without storing a profile',async(t,kind)=>{
  const h=await harness(t,kind);h.beforeResolve(()=>{h.state.agent.permissions=[];});
  await assert.rejects(h.provider.subscribe(identity,parameters(),protocol),{statusCode:401,code:'CREDENTIAL_REVOKED'});assert.equal(h.sent.length,0);assert.deepEqual(await h.http.profileRecords(binding,'mcp_events'),[]);
});
parity('permission removal after successful verification refuses subscription commit',async(t,kind)=>{
  const h=await harness(t,kind);h.beforeSend(request=>{if(JSON.parse(request.bodyText).type==='verification')h.state.agent.permissions=[];});
  await assert.rejects(h.provider.subscribe(identity,parameters(),protocol),{statusCode:401,code:'CREDENTIAL_REVOKED'});assert.equal(h.sent.length,1);assert.equal(JSON.parse(h.sent[0].bodyText).type,'verification');assert.deepEqual(await h.http.profileRecords(binding,'mcp_events'),[]);
});
parity('permission loss, missing installation and refresh expiry before delivery end profiles and erase secrets',async(t,kind)=>{
  for(const change of [h=>{h.state.agent.permissions=[];},h=>{h.state.installation=null;},h=>{h.state.family.refreshExpiresAt=h.now();}]){
    const h=await harness(t,kind);const created=await h.provider.subscribe(identity,parameters(),protocol);await h.tx(()=>h.http.trigger({...binding,reason:'message_delivered'}));const sent=h.sent.length;h.beforeResolve(()=>change(h));
    await h.http.runOnce();assert.equal(h.sent.length,sent);const record=await h.store.getJson(wakeSubscriptionPath(binding.agentId,created.id));assert.equal(record.status,'ended');assert.equal(record.endedReason,'credential_ended');assert.equal(record.secretEncrypted,undefined);assert.equal(record.previousSecretEncrypted,undefined);
  }
});
parity('MCP-created subscriptions require live receive authority while legacy REST behavior stays unchanged',async(t,kind)=>{
  const h=await harness(t,kind);const created=await h.tx(()=>h.http.create(binding,{url:'https://callbacks.envoi-provider.com/mcp'},{createdVia:'mcp'}));h.state.installation=null;
  assert.equal((await h.http.status(binding)).subscription.endedReason,'credential_ended');h.state.agent.permissions=[];
  const rest=await h.tx(()=>h.http.create(binding,{url:'https://callbacks.envoi-provider.com/rest'}));assert.equal(rest.subscription.status,'pending');assert.equal((await h.store.getJson(wakeSubscriptionPath(binding.agentId,created.subscription.id))).status,'ended');
});
parity('MCP create and activation recheck authority after asynchronous work and at refresh-expiry timing boundaries',async(t,kind)=>{
  const denied=await harness(t,kind);denied.beforeResolve(()=>{denied.state.agent.permissions=[];});await assert.rejects(denied.tx(()=>denied.http.create(binding,{url:'https://callbacks.envoi-provider.com/mcp'},{createdVia:'mcp'})),{statusCode:401,code:'CREDENTIAL_REVOKED'});assert.deepEqual((await denied.http.list(binding)).subscriptions,[]);assert.equal(denied.sent.length,0);
  let activation=false,reads=0,h;
  h=await harness(t,kind,{facts:async()=>{if(activation&&++reads===3)h.state.family.refreshExpiresAt=h.now();return h.state;}});
  const created=await h.tx(()=>h.http.create(binding,{url:'https://callbacks.envoi-provider.com/mcp'},{createdVia:'mcp'}));h.advance(2000);await h.http.runOnce();const challenge=JSON.parse(h.sent.at(-1).bodyText).challenge;activation=true;
  await assert.rejects(h.tx(()=>h.http.activate(binding,created.subscription.id,{challenge})),{statusCode:401,code:'CREDENTIAL_REVOKED'});assert.equal(reads,3);assert.notEqual((await h.store.getJson(wakeSubscriptionPath(binding.agentId,created.subscription.id))).status,'active');
});

parity('canonical owner decisions wake extension hosts using an approved opaque reason',async(t,kind)=>{
  const h=await harness(t,kind);await h.provider.subscribe(identity,parameters(),protocol);
  await h.tx(()=>h.http.trigger({...binding,reason:'human_decision',cursor:'00000000000000000013'}));
  assert.equal(await h.http.runOnce(),true);
  const delivered=JSON.parse(h.sent.at(-1).bodyText);
  assert.equal(delivered.name,'envoi.work_available');assert.deepEqual(delivered.data,{reason:'work_due'});
  assert.equal(delivered.cursor,'00000000000000000013');assert.equal(JSON.stringify(delivered).includes('human_decision'),false);
});


const metadataRegistry=JSON.parse(await readFile(new URL('./contract-fixtures/index.json',import.meta.url),'utf8'));
const metadataEntry=metadataRegistry.contracts.find(row=>row.id==='provider-event-wake-request-metadata');
const metadataFixtures=await Promise.all(metadataEntry.fixtures.map(name=>readFile(new URL('./contract-fixtures/provider-event-wake-request-metadata/'+name,import.meta.url),'utf8').then(JSON.parse)));
parity('Events methods consume approved metadata vectors without relaxing parameters or persisting metadata',async(t,kind)=>{
  const h=await harness(t,kind);
  for(const fixture of metadataFixtures){
    const method=fixture.method.split('/')[1],params=structuredClone(fixture.params),before=h.sent.length;
    if(!fixture.expected.valid){
      if(method==='list')assert.throws(()=>h.provider.list(identity,params,protocol),{rpcCode:-32602},fixture.id);
      else await assert.rejects(()=>h.provider[method](identity,params,protocol),{rpcCode:-32602},fixture.id);
      assert.equal(h.sent.length,before,fixture.id+': invalid input causes no verification or delivery');
      continue;
    }
    const result=await h.provider[method](identity,params,protocol);
    if(method==='list')assert.deepEqual(result.events.map(event=>event.name),['envoi.work_available','envoi.control_changed']);
    else if(method==='subscribe'){
      assert.match(result.id,/^evtsub_/);
      const records=await h.http.profileRecords(binding,'mcp_events');
      assert.equal(records.length,1);
      assert.equal(JSON.stringify(records).includes('METADATA_ONLY_SYNTHETIC'),false);
      assert.equal(Object.hasOwn(records[0],'_meta'),false);
    }else assert.deepEqual(result,{});
    assert.equal(JSON.stringify([result,h.sent,h.audits]).includes('METADATA_ONLY_SYNTHETIC'),false);
    assert.deepEqual(fixture.params,params,'caller input is not mutated');
  }
});
parity('metadata changes do not change subscription identity, verification, renewal or unsubscribe fencing',async(t,kind)=>{
  const h=await harness(t,kind);const first=await h.provider.subscribe(identity,parameters(),protocol);
  h.advance(1000);
  const renewed=await h.provider.subscribe(identity,parameters({_meta:{agentId:'foreign',permissions:['ignored'],marker:'META_NOT_AUTHORITY'}}),protocol);
  assert.equal(renewed.id,first.id);assert.notEqual(renewed.refreshBefore,first.refreshBefore);assert.equal(h.sent.length,1);
  let records=await h.http.profileRecords(binding,'mcp_events');assert.equal(records.length,1);assert.equal(records[0].installationId,binding.installationId);
  assert.equal(JSON.stringify([records,h.sent,h.audits,renewed]).includes('META_NOT_AUTHORITY'),false);
  const {secret:ignored,...delivery}=parameters().delivery;
  assert.deepEqual(await h.provider.unsubscribe(identity,{name:parameters().name,arguments:{},delivery,_meta:{marker:'META_NOT_AUTHORITY'}},protocol),{});
  records=await h.http.profileRecords(binding,'mcp_events');assert.equal(records[0].status,'ended');assert.equal(records[0].secretEncrypted,undefined);
  assert.deepEqual(await h.provider.unsubscribe(identity,{name:parameters().name,arguments:{},delivery},protocol),{});
});
test('metadata validation follows Events qualification and cannot bypass an empty callback allowlist',async t=>{
  const h=await harness(t);const disabled=createProviderEventWake({...h.providerOptions,httpWake:createHttpWake(h.options),mcpEventsEnabled:false});
  for(const provider of [h.provider,disabled])for(const method of ['list','subscribe','unsubscribe']){
    const who=provider===disabled?identity:{...identity,mcpScope:{caseId:'synthetic'}};
    const call=()=>provider[method](who,{_meta:null},protocol);
    if(method==='list')assert.throws(call,{rpcCode:-32601});else await assert.rejects(call,{rpcCode:-32601});
  }
  for(const method of ['list','subscribe','unsubscribe']){
    const call=()=>h.provider[method](identity,{_meta:null},'2025-11-25');
    if(method==='list')assert.throws(call,{rpcCode:-32601});else await assert.rejects(call,{rpcCode:-32601});
  }
  let resolved=0;const inert=createProviderEventWake({...h.providerOptions,httpWake:createHttpWake(h.options),env:{},resolveDestination:async()=>{resolved++;throw Error('must not resolve');}});
  await assert.rejects(()=>inert.subscribe(identity,parameters({_meta:{delivery:{url:'https://callbacks.envoi-provider.com/events'},callbackOriginAllowlist:['https://callbacks.envoi-provider.com']}}),protocol),{rpcCode:-32015,reason:'origin_not_allowed'});
  assert.equal(resolved,0);
});
