import crypto from 'node:crypto';
import net from 'node:net';
import { createWakeDestination, wakeError } from './http-wake-destination.js';

export const providerEventsProtocolVersion='2026-07-28';
export const providerEvents = Object.freeze([
  {name:'envoi.work_available',description:'Work for this connection became claimable. Opaque hint: claim to learn what.',delivery:['webhook'],inputSchema:{type:'object',additionalProperties:false,properties:{}},payloadSchema:{type:'object',additionalProperties:false,required:['reason'],properties:{reason:{enum:['message_delivered','human_instruction','agent_resumed','case_resumed','counterparty_resumed','work_due','subscription_activated']}}}},
  {name:'envoi.control_changed',description:"This connection's pause state or a case control changed. Opaque hint.",delivery:['webhook'],inputSchema:{type:'object',additionalProperties:false,properties:{}},payloadSchema:{type:'object',additionalProperties:false,required:['reason'],properties:{reason:{enum:['agent_paused','case_controlled']}}}}
]);
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const equal=(a,b)=>{const one=Buffer.from(String(a??'')),two=Buffer.from(String(b??''));return one.length===two.length&&crypto.timingSafeEqual(one,two);};
const rpc=(code,message,reason)=>Object.assign(new Error(message),{rpcCode:code,...(reason?{reason}:{})});
const invalid=()=>rpc(-32602,'Invalid params');
const callbackError=reason=>rpc(-32015,'CallbackEndpointError',reason);
const closed=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key));
const empty=value=>closed(value,[])&&Object.keys(value).length===0;
// Common protocol metadata is inert; only method-specific parameters reach validation/storage.
function eventParams(params){
  if(!params||typeof params!=='object'||Array.isArray(params))throw invalid();
  if(Object.hasOwn(params,'_meta')&&(!params._meta||typeof params._meta!=='object'||Array.isArray(params._meta)))throw invalid();
  const {_meta,...methodParams}=params;
  return methodParams;
}
function secretBytes(secret){
  if(typeof secret!=='string'||secret.length>94||!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret))throw invalid();
  const text=secret.slice(6),bytes=Buffer.from(text,'base64');
  if(bytes.length<24||bytes.length>64||bytes.toString('base64').replace(/=+$/,'')!==text.replace(/=+$/,''))throw invalid();
  return bytes;
}
export function signProviderWebhook({secret,previousSecret,bodyText,id,at,subscriptionId}){
  const timestamp=String(Math.floor(Date.parse(at)/1000));
  const signatures=[secret,...(previousSecret?[previousSecret]:[])].map(value=>`v1,${crypto.createHmac('sha256',secretBytes(value)).update(`${id}.${timestamp}.${bodyText}`).digest('base64')}`);
  return {'content-type':'application/json','user-agent':'Envoi-Wake/1','webhook-id':id,'webhook-timestamp':timestamp,'webhook-signature':signatures.join(' '),...(subscriptionId?{'x-mcp-subscription-id':subscriptionId}:{})};
}
function originSet(value){
  const values=Array.isArray(value)?value:String(value||'').split(',').map(value=>value.trim()).filter(Boolean);
  return new Set(values.map(value=>{let url;try{url=new URL(value);}catch{throw new Error('Invalid provider wake origin');}if(url.protocol!=='https:'||url.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash||net.isIP(url.hostname.replace(/^\[|\]$/g,''))||url.origin!==value)throw new Error('Invalid provider wake origin');return url.origin;}));
}
export function createProviderEventWake({httpWake,store,mcpEventsEnabled=false,grokTriggerEnabled=false,key,env=process.env,now=()=>new Date().toISOString(),audit=async()=>{},observe=record=>console.error(JSON.stringify(record)),resolveDestination,authorizeOwner=async()=>{},validateCursor=async()=>{},eventHistory=async()=>({cursor:null,truncated:false,events:[]})}={}){
  const dataKey=key||((mcpEventsEnabled||grokTriggerEnabled)&&env.ENVOI_DATA_ENCRYPTION_KEY?crypto.createHash('sha256').update(env.ENVOI_DATA_ENCRYPTION_KEY).digest():null);
  if((mcpEventsEnabled||grokTriggerEnabled)&&(!Buffer.isBuffer(dataKey)||dataKey.length!==32))throw new Error('Provider wake requires the server data encryption key');
  const destination=createWakeDestination({env});const resolve=resolveDestination||destination.resolve;
  const callbacks=originSet(env.ENVOI_MCP_EVENTS_CALLBACK_ORIGINS),triggers=originSet(env.ENVOI_GROK_TRIGGER_ORIGINS);
  const allowlistDigest=hash([...callbacks].sort().join('\n'));
  const time=()=>Date.parse(now());
  const encode=(secret,id)=>{const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',dataKey,iv);cipher.setAAD(Buffer.from(id));const ciphertext=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);return {iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')};};
  const decode=(encrypted,id)=>{const decipher=crypto.createDecipheriv('aes-256-gcm',dataKey,Buffer.from(encrypted.iv,'base64'));decipher.setAAD(Buffer.from(id));decipher.setAuthTag(Buffer.from(encrypted.tag,'base64'));return Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext,'base64')),decipher.final()]).toString('utf8');};
  const bound=identity=>({inboxId:identity.inboxId,agentId:identity.agent?.id||identity.agentId,familyId:identity.family?.id||identity.familyId,installationId:identity.installationId||identity.family?.installationId});
  const available=(identity,version)=>Boolean(mcpEventsEnabled&&version===providerEventsProtocolVersion&&identity.family?.audience&&!identity.mcpScope&&(identity.connectionRoute===undefined||['remote_mcp_oauth','provider_connector'].includes(identity.connectionRoute))&&identity.agent?.permissions?.includes('receive_agent_messages')&&bound(identity).installationId);
  const requireEvents=(identity,version)=>{if(!available(identity,version))throw rpc(-32601,'Method not found');};
  const cachePath=(identity,url)=>`http-wake/verification/${hash(`${identity.installationId}\n${url}`)}.json`;
  const checked=(url,allowlist)=>{const canonical=destination.canonical(url);if(!allowlist.has(new URL(canonical).origin))throw wakeError(400,'WAKE_URL_REJECTED','origin_not_allowed');return canonical;};
  const signature=(sub,event)=>signProviderWebhook({secret:decode(sub.secretEncrypted,sub.id),previousSecret:sub.previousSecretEncrypted&&Date.parse(sub.previousSecretUntil)>time()?decode(sub.previousSecretEncrypted,sub.id):null,bodyText:event.bodyText,id:event.id,at:new Date(Math.max(time(),Date.parse(event.createdAt))).toISOString(),subscriptionId:sub.profile==='mcp_events'?sub.id:undefined});
  const ended=async sub=>{if(sub.profile==='mcp_events')await store.deleteJson(cachePath(sub,sub.url));};
  httpWake.registerProfile('mcp_events',{
    destination:url=>checked(url,callbacks),headers:signature,ended,
    accepts:(sub,event)=>sub.eventName===event.type.replace(/^wake\./,'envoi.')&&providerEvents.find(row=>row.name===sub.eventName).payloadSchema.properties.reason.enum.includes(event.reason),
    body:(sub,event)=>({eventId:event.id,name:event.type.replace(/^wake\./,'envoi.'),timestamp:event.createdAt,data:{reason:event.reason},cursor:sub.cursor||null})
  });
  httpWake.registerProfile('grok_trigger',{destination:url=>checked(url,triggers),headers:signature});
  function paramsValid(params,subscribe){
    if(!closed(params,subscribe?['name','arguments','delivery','cursor','ttlMs']:['name','arguments','delivery'])||!providerEvents.some(event=>event.name===params.name)||!empty(params.arguments)||!closed(params.delivery,subscribe?['mode','url','secret']:['mode','url'])||params.delivery.mode!=='webhook'||typeof params.delivery.url!=='string'||params.delivery.url.length>2048)throw invalid();
    if(subscribe&&params.cursor!==undefined&&params.cursor!==null&&(typeof params.cursor!=='string'||!/^[0-9]{20}$/.test(params.cursor)))throw invalid();
    if(subscribe&&params.ttlMs!==undefined&&params.ttlMs!==null&&(!Number.isSafeInteger(params.ttlMs)||params.ttlMs<3600000||params.ttlMs>604800000))throw invalid();
    if(subscribe)secretBytes(params.delivery.secret);
  }
  const identityId=(identity,name,url)=>`evtsub_${hash(JSON.stringify([identity.installationId,name,{},url])).slice(0,20)}`;
  // The frozen public flag records that a secret was provisioned. Ended targets retain
  // this historical metadata while their encrypted secret has already been deleted.
  const grokPublic=sub=>({id:sub.id,kind:'grok_webhook_trigger',installationId:sub.installationId,agentId:sub.agentId,url:sub.url,secretSet:true,state:sub.status==='ended'?'ended':sub.targetState||'active',stateReason:sub.status==='ended'?sub.endedReason:sub.stateReason||null,createdAt:sub.createdAt,updatedAt:sub.updatedAt||sub.createdAt,lastAttemptAt:sub.delivery.lastAttemptAt,lastAcceptedAt:sub.delivery.lastSuccessAt,consecutiveFailures:sub.delivery.consecutiveFailures});
  const grokAvailable=()=>{if(!grokTriggerEnabled)throw wakeError(404,'FEATURE_DISABLED');};
  return {available,events:providerEvents,
    discover(identity,version){requireEvents(identity,version);return {resultType:'complete',supportedVersions:[providerEventsProtocolVersion],capabilities:{tools:{},events:{}}};},
    list(identity,params={},version){requireEvents(identity,version);params=eventParams(params);if(!empty(params))throw invalid();return {events:providerEvents};},
    async subscribe(identity,params,version){
      requireEvents(identity,version);params=eventParams(params);paramsValid(params,true);const binding=bound(identity);await validateCursor(binding,params.cursor??null);let url;
      try{url=checked(params.delivery.url,callbacks);}catch(error){throw callbackError(error.reason==='origin_not_allowed'?'origin_not_allowed':'address_not_allowed');}
      await httpWake.reserveProfileCreate(binding,'mcp_events',identityId(binding,params.name,url));
      const cache=cachePath(binding,url),oneWayKey=hash(`${params.delivery.secret}\n${allowlistDigest}`);
      const existing=(await httpWake.profileRecords(binding,'mcp_events')).find(sub=>sub.id===identityId(binding,params.name,url));
      let resolution;try{resolution=await resolve(url);}catch{await store.deleteJson(cache);throw callbackError('address_not_allowed');}
      if(!resolution?.addresses?.length||resolution.addresses.some(address=>!destination.allowed(address))){await store.deleteJson(cache);throw callbackError('address_not_allowed');}
      const cached=await store.getJson(cache);
      let verified=false;
      if(existing?.status==='ended'||!cached||cached.key!==oneWayKey||Date.parse(cached.expiresAt)<=time()){
        await store.deleteJson(cache);
        const challenge=`envoi_wake_challenge_${crypto.randomBytes(32).toString('base64url')}`,bodyText=JSON.stringify({type:'verification',challenge}),id=`wake_evt_${crypto.randomBytes(18).toString('base64url')}`;
        let response;
        try{response=await httpWake.verifyCallback(binding,url,{bodyText,headers:signProviderWebhook({secret:params.delivery.secret,bodyText,id,at:now(),subscriptionId:identityId(binding,params.name,url)})});}
        catch(error){if(error.code==='WAKE_URL_REJECTED')throw callbackError('address_not_allowed');throw error;}
        let echoed=response.body?.challenge;try{echoed||=JSON.parse(response.bodyText).challenge;}catch{/* Bounded malformed response is a verification refusal. */}
        if(response.failureClass==='timeout')throw callbackError('timeout');
        if(!(response.status>=200&&response.status<300)||response.bodyTooLarge||!equal(echoed,challenge))throw callbackError('challenge_failed');
        verified=true;
      }
      // Verification performs network I/O without the inbox lock. Activation, its
      // cache and catch-up queue must then commit together: a later storage failure
      // must not expose a half-created subscription to the delivery worker.
      const id=identityId(binding,params.name,url),started=time();let phase='acquire';
      try{return await store.withTransaction([`inbox:${binding.inboxId}:mutations`],async()=>{
        phase='history';const history=await eventHistory(binding,params.cursor??null);
        phase='subscription';
        const current=(await httpWake.profileRecords(binding,'mcp_events')).find(sub=>sub.id===id);
        const priorChanged=current?.status==='active'&&current.secretEncrypted&&!equal(current.secretHash,hash(params.delivery.secret));
        const sub=await httpWake.createProfile(binding,'mcp_events',{id,url,quotaReserved:true,expiresAt:new Date(time()+(params.ttlMs??604800000)).toISOString(),eventName:params.name,cursor:history.cursor||null,secretHash:hash(params.delivery.secret),secretEncrypted:encode(params.delivery.secret,id),previousSecretEncrypted:priorChanged?current.secretEncrypted:current?.previousSecretEncrypted,previousSecretUntil:priorChanged?new Date(time()+600000).toISOString():current?.previousSecretUntil});
        phase='verification_cache';if(verified)await store.putJson(cache,{key:oneWayKey,expiresAt:new Date(time()+3600000).toISOString()});
        phase='replay';
        // With the inbox locked, the lane cannot drain during catch-up. Its first
        // hint stays queued and later hints overwrite one dirty marker. Preserve
        // those first/latest hints without hundreds of redundant database writes.
        const matching=(history.events||[]).filter(event=>event.type===params.name.replace(/^envoi\./,'wake.'));
        const catchUp=matching.length>1?[matching[0],matching.at(-1)]:matching;
        for(const event of catchUp)await httpWake.queueProfile(sub,event.type,event.reason,event.cursor);
        phase='commit';
        return {id,refreshBefore:sub.expiresAt,cursor:history.cursor||null,truncated:Boolean(history.truncated)};
      });}catch(error){
        if(!error?.rpcCode&&(!Number.isInteger(error?.statusCode)||error.statusCode>=500)){
          // Error messages/stacks can contain SQL values, callback URLs or secrets.
          // Only fixed stages/classes/codes and the opaque subscription id leave here.
          const errorClass=['Error','TypeError','RangeError','SyntaxError','AbortError','TimeoutError'].includes(error?.name)?error.name:'Error';
          const code=['40001','40P01','53300','57014','55P03','08006','57P01','ETIMEDOUT','ECONNRESET','ENOSPC','EPERM','EBUSY','LOCK_TIMEOUT'].includes(error?.code)?error.code:'unexpected';
          try{observe({event:'envoi.mcp_events_subscribe_failed',subscriptionId:id,phase,errorClass,code,durationMs:Math.max(0,time()-started)});}catch{/* Diagnostics must preserve the original error. */}
        }
        throw error;
      }
    },
    async unsubscribe(identity,params,version){requireEvents(identity,version);params=eventParams(params);paramsValid(params,false);const binding=bound(identity);let url;try{url=destination.canonical(params.delivery.url);}catch{throw invalid();}const id=identityId(binding,params.name,url);const sub=(await httpWake.profileRecords(binding,'mcp_events')).find(sub=>sub.id===id);if(sub)await httpWake.endProfile(binding,id);await store.deleteJson(cachePath(binding,url));return {};},
    async putGrok(identity,params){
      grokAvailable();const binding=bound(identity);if(!binding.installationId||!binding.familyId)throw wakeError(400,'WAKE_TARGET_INVALID','installation_required');
      if(!closed(params,['url','secret'])||typeof params.url!=='string')throw wakeError(400,'WAKE_TARGET_INVALID','secret_invalid');
      try{secretBytes(params.secret);}catch{throw wakeError(400,'WAKE_TARGET_INVALID','secret_invalid');}
      const url=checked(params.url,triggers);
      const records=await httpWake.profileRecords({inboxId:binding.inboxId,agentId:binding.agentId},'grok_trigger');
      const current=records.find(sub=>sub.status!=='ended');
      const id=current?.installationId===binding.installationId?current.id:`wake_target_${crypto.randomBytes(18).toString('base64url')}`;
      await httpWake.reserveProfileCreate(binding,'grok_trigger',id);await resolve(url);
      const guard=()=>authorizeOwner(identity);
      return store.withTransaction([`inbox:${binding.inboxId}:mutations`],async()=>{
        for(const sub of records)if(sub.installationId!==binding.installationId&&sub.status!=='ended')await httpWake.endProfile({inboxId:binding.inboxId,agentId:binding.agentId},sub.id,'replaced',guard);
        const sub=await httpWake.createProfile(binding,'grok_trigger',{id,url,allowPaused:true,quotaReserved:true,beforeCommit:guard,resetGeneration:true,secretEncrypted:encode(params.secret,id),previousSecretEncrypted:undefined,previousSecretUntil:undefined,targetState:'active',stateReason:null,updatedAt:now()});
        await audit(binding.inboxId,'agent.wake_target_secret_set',{agentId:binding.agentId,installationId:binding.installationId,secretSet:true},now());
        await httpWake.queueProfile(sub,'wake.work_available','work_due');return {target:grokPublic(sub)};
      });
    },
    async getGrok(identity){const binding=bound(identity);const records=await httpWake.profileRecords({inboxId:binding.inboxId,agentId:binding.agentId},'grok_trigger');grokAvailable();const sub=records.find(sub=>sub.status!=='ended')||records[0];return {target:sub?grokPublic(sub):null};},
    async deleteGrok(identity){const binding=bound(identity);grokAvailable();return store.withTransaction([`inbox:${binding.inboxId}:mutations`],async()=>{await authorizeOwner(identity);const records=await httpWake.profileRecords({inboxId:binding.inboxId,agentId:binding.agentId},'grok_trigger');for(const sub of records)await httpWake.endProfile({inboxId:binding.inboxId,agentId:binding.agentId},sub.id,'ended_by_owner',()=>authorizeOwner(identity));return {};});}
  };
}
