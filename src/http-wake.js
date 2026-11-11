import crypto from 'node:crypto';
import path from 'node:path';
import { createWakeDestination, wakeError } from './http-wake-destination.js';
import { createWakeKeys, createWakeTransport } from './http-wake-transport.js';
import { createWakeAdmission } from './http-wake-limits.js';
import { wakeEventPath as eventPath, wakeLiveDir, wakeLivePath, wakeQueueDir, wakeRoot as root, wakeSubscriptionDir, wakeSubscriptionIndexDir, wakeSubscriptionIndexPath, wakeSubscriptionPath as subPath } from './http-wake-paths.js';

const epochPath = 'config/http-wake-epoch';
const heartbeatEveryMs = 60000;
const cleanupEveryMs = 600000;
const workDueMinIntervalMs = 60000;
const lock = inboxId => `inbox:${inboxId}:mutations`;
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const live = record => ['queued','processing','retrying'].includes(record.status);
const iso = n => new Date(n).toISOString();
const retryable = new Set(['timeout','connect_failed','tls_failed','address_rejected','interrupted','http_retryable']);
const challengeRetryable = new Set(['interrupted','http_retryable']);
const schedule = [10,30,120,600,1800];
const publicSub = sub => Object.fromEntries(['id','installationId','agentId','url','status','endedReason','endedAt','createdAt','activatedAt','expiresAt','challengeExpiresAt','replacesSubscriptionId','delivery'].map(key => [key, sub[key]]));
export function createHttpWake({ store, enabled = false, installationsEnabled = false, mcpWakeEnabled = false, mcpEventsEnabled = false, grokTriggerEnabled = false, env = process.env, facts, audit = async () => {}, observe = record => console.info(JSON.stringify(record)), now = () => new Date().toISOString(), random = Math.random, resolveDestination, transport, signingKeys } = {}) {
  if (enabled && !installationsEnabled) throw new Error('ENVOI_HTTP_WAKE_V1 requires ENVOI_INSTALLATIONS_V2');
  if (enabled && ['1','true'].includes(env.NODE_USE_ENV_PROXY)) throw new Error('Wake cannot use environment proxy transport');
  const destination = createWakeDestination({ env });
  const resolve = resolveDestination || destination.resolve;
  const keys = enabled ? (signingKeys || createWakeKeys(env.ENVOI_WAKE_SIGNING_KEYS, () => Date.parse(now()))) : null;
  const send = transport || createWakeTransport();
  const time = () => Date.parse(now());
  const admission = createWakeAdmission({store,now:time});
  const profiles = new Map();
  const flags = { mcp:mcpWakeEnabled, mcp_events:mcpEventsEnabled, grok_trigger:grokTriggerEnabled };
  const profileEpochPath = name => `config/http-wake-${name}-epoch`;
  const profileOf = sub => sub.profile ? profiles.get(sub.profile) : null;
  const extension = sub => Boolean(sub.profile || sub.createdVia==='mcp');
  const extensionLive = ({family,agent,installation}) => Boolean(family&&!family.revokedAt
    &&Number.isFinite(Date.parse(family.refreshExpiresAt))&&Date.parse(family.refreshExpiresAt)>time()
    &&agent&&['active','paused'].includes(agent.status)&&agent.onboardingStatus==='approved'
    &&agent.permissions?.includes('receive_agent_messages')&&installation?.status==='active');
  const log = record => { try { observe(record); } catch { /* Observability cannot change delivery. */ } };
  const logAttempt = (event,sub,result,address=null) => log({event:'http_wake.attempt',subscriptionId:sub.id,origin:new URL(sub.url).origin,address,attempt:event.attempts,class:result.notSent?'not_sent':result.failureClass||'acknowledged',durationMs:Math.max(0,time()-Date.parse(event.startedAt))});
  // One agent's subscriptions; nothing lists every subscription except the throttled cleanup.
  const agentSubs = agentId => store.listJson(wakeSubscriptionDir(agentId));
  const save = sub => store.putJson(subPath(sub.agentId, sub.id), sub);
  // The index records each subscription's status, written whenever the status changes.
  const index = sub => store.putJson(wakeSubscriptionIndexPath(sub.id), { id:sub.id, inboxId:sub.inboxId, agentId:sub.agentId, status:sub.status, endedAt:sub.endedAt || null });
  // Every notification write goes through here, so the live index matches the queue.
  async function putEvent(event) {
    await store.putJson(eventPath(event.id), event);
    if (live(event)) await store.putJson(wakeLivePath(event.id), { id:event.id, inboxId:event.inboxId, agentId:event.agentId, subscriptionId:event.subscriptionId, status:event.status, availableAt:event.availableAt, lockedUntil:event.lockedUntil || null });
    else await store.deleteJson(wakeLivePath(event.id));
  }
  // A lane holds at most one live notification, which its subscription points at.
  async function liveEventsOf(sub) {
    const records = [];
    for (const id of Object.values(sub.liveEvents || {})) { const event = id && await store.getJson(eventPath(id)); if (event && live(event)) records.push(event); }
    return records;
  }
  function available() { if (!enabled) throw wakeError(404, 'FEATURE_DISABLED'); }
  async function endRecord(sub, reason, at = now()) {
    if (sub.status === 'ended') return sub;
    sub.status = 'ended'; sub.endedReason = reason; sub.endedAt = at; sub.challengeExpiresAt = null; sub.challengeHash = null; sub.dirty = {};
    delete sub.secretEncrypted; delete sub.secretHash; delete sub.previousSecretEncrypted; delete sub.previousSecretUntil;
    await profileOf(sub)?.ended?.(sub);
    await save(sub); await index(sub);
    for (const event of await liveEventsOf(sub)) if (event.status !== 'processing') { event.status = 'cancelled'; event.finishedAt = at; await putEvent(event); }
    await audit(sub.inboxId, 'agent.wake_subscription_ended', { agentId:sub.agentId, installationId:sub.installationId, subscriptionId:sub.id, endedReason:reason }, at);
    return sub;
  }
  async function derive(sub) {
    if (!sub || sub.status === 'ended') return sub;
    const epoch = await store.getJson(epochPath);
    if (epoch && sub.createdAt < epoch.epoch) return endRecord(sub, 'feature_disabled', epoch.epoch);
    const feature = sub.profile || (sub.createdVia === 'mcp' ? 'mcp' : null);
    if (feature) {
      const featureEpoch = await store.getJson(profileEpochPath(feature));
      if (!flags[feature] || (featureEpoch && sub.createdAt < featureEpoch.epoch)) return endRecord(sub, 'feature_disabled', featureEpoch?.epoch || now());
    }
    const { family, agent, installation } = await facts(sub);
    if (!family || family.revokedAt || installation?.status==='ended' || !agent || !['active','paused'].includes(agent.status) || agent.onboardingStatus !== 'approved') return endRecord(sub, 'credential_ended', family?.revokedAt || installation?.endedAt || agent?.revokedAt || agent?.removedAt || now());
    if(extension(sub)&&!extensionLive({family,agent,installation}))return endRecord(sub,'credential_ended');
    if(sub.previousSecretEncrypted&&Date.parse(sub.previousSecretUntil)<=time()){delete sub.previousSecretEncrypted;delete sub.previousSecretUntil;await save(sub);}
    if (sub.status === 'pending' && Date.parse(sub.challengeExpiresAt) <= time()) return endRecord(sub, 'challenge_expired', sub.challengeExpiresAt);
    if (sub.status === 'active' && Date.parse(sub.expiresAt) <= time()) return endRecord(sub, 'expired', sub.expiresAt);
    return sub;
  }
  async function queue(sub, type, reason, challenge, cursor = null) {
    // Canonical owner decisions reoffer work; extension hints use the approved general due reason.
    if ((sub.profile || sub.createdVia === 'mcp') && reason === 'human_decision') reason = 'work_due';
    if(cursor&&(!sub.cursor||cursor>sub.cursor))sub.cursor=cursor;
    const lane = type === 'wake.challenge' ? 'challenge' : type === 'wake.work_available' ? 'work' : 'control';
    const existing = (await liveEventsOf(sub)).find(event => event.lane === lane);
    if (existing) { sub.dirty ||= {}; sub.dirty[lane] = { type, reason, ...(sub.cursor?{cursor:sub.cursor}:{}) }; await save(sub); return; }
    sub.sequence = Number(sub.sequence || 0) + 1;
    const body = { type, version:1, id:`wake_evt_${crypto.randomBytes(18).toString('base64url')}`, subscriptionId:sub.id, sequence:sub.sequence, ...(reason ? { reason } : {}), createdAt:now(), ...(challenge ? { challenge, expiresAt:sub.challengeExpiresAt } : {}) };
    const profile = profileOf(sub);
    if (profile?.accepts && !profile.accepts(sub, body)) return;
    const bodyText = JSON.stringify(profile?.body ? profile.body(sub, body) : body);
    if (Buffer.byteLength(bodyText) > 1024) throw new Error('Wake event exceeds opaque notification limit');
    const targetAttemptAt=sub.grokLastAttemptAt||sub.delivery.lastAttemptAt;
    const event = { ...body, ...(sub.generation?{generation:sub.generation}:{}), inboxId:sub.inboxId, agentId:sub.agentId, lane, bodyText, status:'queued', attempts:0, availableAt:iso(Math.max(time() + (challenge ? 2000 : 0), sub.profile === 'grok_trigger' && targetAttemptAt ? Date.parse(targetAttemptAt)+5000 : 0)), deadline:challenge ? sub.challengeExpiresAt : iso(time()+3600000) };
    sub.liveEvents = { ...sub.liveEvents, [lane]:event.id };
    await save(sub); await putEvent(event);
  }
  async function startup() {
    await store.withTransaction(['http-wake:epoch'], async () => {
      const previous = await store.getJson(epochPath); const at = now();
      const move = !enabled || !previous || Date.parse(previous.activeUntil) <= time();
      const record = { epoch:move ? at : previous.epoch, activeUntil:enabled ? iso(time()+21600000) : at };
      await store.putJson(epochPath, record);
      if (move) { const cause=enabled ? 'active_until_passed' : 'flag_off_at_startup';await audit(null, 'http_wake.epoch_moved', { cause }, at);log({event:'http_wake.epoch_moved',cause,epoch:at}); }
    });
    for (const [name,on] of Object.entries(flags)) if (!on) await store.withTransaction([`http-wake:profile:${name}`],async()=>store.putJson(profileEpochPath(name),{epoch:now()}));
  }
  // activeUntil runs 6 h ahead, so refreshing it once a minute is plenty; the maintenance tick
  // calls this every second.
  let lastHeartbeat = -Infinity;
  async function heartbeat() { if (!enabled || time()-lastHeartbeat < heartbeatEveryMs) return; lastHeartbeat = time(); await store.withTransaction(['http-wake:epoch'], async () => { const record = await store.getJson(epochPath); if (!record || Date.parse(record.activeUntil) <= time()) return startup(); await store.putJson(epochPath, { ...record, activeUntil:iso(time()+21600000) }); }); }
  async function owned(identity, id, includeProfiles = false) { const sub = await store.getJson(subPath(identity.agentId, id)); if (!sub || (!includeProfiles && sub.profile) || sub.inboxId !== identity.inboxId || sub.agentId !== identity.agentId || (identity.installationId && sub.installationId !== identity.installationId)) throw wakeError(404,'WAKE_SUBSCRIPTION_NOT_FOUND'); return derive(sub); }
  async function consumeCreate(identity) {
    const counterPath = path.join(root, 'create-limits', `${identity.agentId}.json`);
    const counter = await store.getJson(counterPath, { entries:[] });
    counter.entries = counter.entries.filter(item => item.at > time()-3600000);
    const prior = counter.entries.filter(item => item.installationId === identity.installationId);
    const limited = prior.length >= 5 || counter.entries.length >= 10;
    const oldest = Math.min(...(prior.length >= 5 ? prior : counter.entries).map(item => item.at));
    counter.entries.push({ at:time(), installationId:identity.installationId }); await store.putJson(counterPath,counter);
    if (limited) throw Object.assign(wakeError(429,'RATE_LIMITED','wake_subscription_create_limit'), { retryAfter:Math.max(1,Math.ceil((oldest+3600000-time())/1000)) });
  }
  async function create(identity, { url }, { createdVia } = {}) {
    available(); destination.canonical(url);
    if (createdVia === 'mcp' && !mcpWakeEnabled) throw wakeError(404,'FEATURE_DISABLED');
    await consumeCreate(identity);
    const resolved = await resolve(url);
    if(createdVia==='mcp'){const current=await facts(identity);if(!extensionLive(current))throw wakeError(401,'CREDENTIAL_REVOKED');if(current.agent.status==='paused')throw wakeError(409,'AGENT_PAUSED');}
    const existing = (await agentSubs(identity.agentId)).filter(sub => !sub.profile && sub.installationId === identity.installationId && sub.agentId === identity.agentId);
    for (const sub of existing) await derive(sub);
    for (const sub of existing.filter(sub => sub.status === 'pending')) await endRecord(sub,'superseded');
    const challenge = `envoi_wake_challenge_${crypto.randomBytes(32).toString('base64url')}`;
    const sub = { id:`wake_sub_${crypto.randomBytes(18).toString('base64url')}`, ...identity, ...(createdVia ? {createdVia}:{}), url:resolved.url, status:'pending', endedReason:null, endedAt:null, createdAt:now(), activatedAt:null, expiresAt:null, challengeExpiresAt:iso(time()+600000), replacesSubscriptionId:existing.find(sub => sub.status === 'active')?.id || null, delivery:{ state:'unverified', lastAttemptAt:null,lastSuccessAt:null,consecutiveFailures:0,lastFailureClass:null }, challengeHash:hash(challenge),sequence:0,dirty:{} };
    await queue(sub,'wake.challenge',null,challenge); await index(sub);
    await audit(sub.inboxId,'agent.wake_subscription_created',{ agentId:sub.agentId,installationId:sub.installationId,subscriptionId:sub.id,origin:new URL(sub.url).origin },now());
    return { subscription:publicSub(sub) };
  }
  async function activate(identity,id,{ challenge }) {
    available(); const sub = await owned(identity,id);
    if(sub.createdVia==='mcp'){const current=await facts(sub);if(!extensionLive(current))throw wakeError(401,'CREDENTIAL_REVOKED');if(current.agent.status==='paused')throw wakeError(409,'AGENT_PAUSED');}
    if (sub.status === 'ended') throw wakeError(409,'WAKE_SUBSCRIPTION_ENDED',sub.endedReason);
    const supplied = Buffer.from(hash(String(challenge))); const stored = Buffer.from(sub.challengeHash);
    if (supplied.length !== stored.length || !crypto.timingSafeEqual(supplied,stored)) throw wakeError(400,'WAKE_CHALLENGE_INVALID');
    if (sub.status === 'active') return { subscription:publicSub(sub) };
    for (const old of await agentSubs(sub.agentId)) if (!old.profile && old.installationId === sub.installationId && old.agentId === sub.agentId && old.status === 'active') await endRecord(old,'replaced');
    if(sub.createdVia==='mcp'){const current=await facts(sub);if(!extensionLive(current))throw wakeError(401,'CREDENTIAL_REVOKED');if(current.agent.status==='paused')throw wakeError(409,'AGENT_PAUSED');}
    sub.status='active'; sub.activatedAt=now(); sub.expiresAt=iso(time()+2592000000); sub.challengeExpiresAt=null;
    if(sub.challengeDelivery)sub.delivery={...sub.challengeDelivery};
    await save(sub); await index(sub);
    for(const event of await liveEventsOf(sub))if(event.lane==='challenge'&&['queued','retrying'].includes(event.status)){event.status='cancelled';event.finishedAt=now();await putEvent(event);}
    const { agent } = await facts(sub); if (agent.status !== 'paused') await queue(sub,'wake.work_available','subscription_activated');
    await audit(sub.inboxId,'agent.wake_subscription_activated',{ agentId:sub.agentId,installationId:sub.installationId,subscriptionId:sub.id },now());
    return { subscription:publicSub(sub) };
  }
  async function listFor(identity, includeProfiles = false) {
    const records = [];
    for (const sub of await agentSubs(identity.agentId)) if ((includeProfiles || !sub.profile) && sub.inboxId === identity.inboxId && sub.agentId === identity.agentId && (!identity.installationId || sub.installationId === identity.installationId)) records.push(await derive(sub));
    const active = records.filter(sub => sub.status !== 'ended').sort((a,b) => (a.status === 'pending' ? 0 : 1)-(b.status === 'pending' ? 0 : 1));
    const ended = records.filter(sub => sub.status === 'ended').sort((a,b)=>b.endedAt.localeCompare(a.endedAt)).slice(0,5);
    return [...active,...ended];
  }
  async function trigger({ inboxId, agentId, type='wake.work_available', reason, cursor=null, requiresInstructionClaims=false }) {
    if (!enabled) return;
    for (const sub of await agentSubs(agentId)) if (sub.inboxId === inboxId && sub.agentId === agentId) {
      await derive(sub); if (sub.status !== 'active' || (sub.targetState && sub.targetState !== 'active')) continue;
      if (requiresInstructionClaims && sub.profile) continue;
      const { family,agent } = await facts(sub);
      if (Date.parse(family.refreshExpiresAt) <= time() || (type === 'wake.work_available' && agent.status === 'paused')) continue;
      if (reason === 'work_due') { if (sub.lastWorkDueAt && time()-Date.parse(sub.lastWorkDueAt)<workDueMinIntervalMs) continue; sub.lastWorkDueAt=now(); }
      await queue(sub,type,reason,undefined,cursor);
    }
  }
  async function pause(inboxId,agentId,cursor=null) {
    for (const sub of await agentSubs(agentId)) if (sub.inboxId === inboxId && sub.agentId === agentId && sub.status === 'active') {
      sub.dirty ||= {}; delete sub.dirty.work; await save(sub);
      for (const event of await liveEventsOf(sub)) if (event.lane === 'work' && ['queued','retrying'].includes(event.status)) { event.status='cancelled';event.finishedAt=now();await putEvent(event); }
    }
    await trigger({ inboxId,agentId,type:'wake.control_changed',reason:'agent_paused',cursor });
  }
  async function finish(event,sub,result) {
    // A deterministic subscription id or stable owner target may have been replaced while
    // the request was in flight. Its old receipt cannot change the new generation's state.
    if(!sub||event.generation!==sub.generation){event.status='cancelled';event.finishedAt=now();event.claimToken=null;event.lockedUntil=null;await putEvent(event);return;}
    const at=time(); event.lastFailureClass=result.failureClass || null;
    if(sub.profile==='grok_trigger'&&result.status===425)result={...result,failureClass:'http_rejected'};
    if (sub.profile === 'grok_trigger' && [400,401,413].includes(result.status) && sub.status !== 'ended') {
      sub.targetState=result.status===401?'needs_secret':'needs_attention';sub.stateReason=result.status===401?'receiver_unauthorized':'sender_rejected';
      result={...result,failureClass:'http_rejected'};
      await audit(sub.inboxId,'agent.wake_target_attention',{agentId:sub.agentId,installationId:sub.installationId,subscriptionId:sub.id,state:sub.targetState,status:result.status},now());
    }
    const retry = (event.lane === 'challenge' ? challengeRetryable : retryable).has(result.failureClass);
    const delay = Math.max((schedule[Math.min(event.attempts-1,4)] * (0.8+random()*0.4)),result.retryAfterSeconds || 0)*1000;
    const next = Date.parse(event.startedAt)+delay;
    if (retry && event.attempts < (event.lane === 'challenge' ? 3 : 6) && next <= Date.parse(event.deadline) && sub.status !== 'ended') { event.status='retrying';event.availableAt=iso(Math.max(at,next)); }
    else { event.status=result.notSent ? 'cancelled' : !result.failureClass ? 'acknowledged' : retry ? 'exhausted' : 'failed';event.finishedAt=now(); }
    event.claimToken=null; event.lockedUntil=null; await putEvent(event);
    if(sub.status!=='ended'&&!result.notSent){sub.lastTransportFailure=['timeout','connect_failed','tls_failed','address_rejected'].includes(result.failureClass);await save(sub);}
    if(sub.status!=='ended'&&event.lane==='challenge'&&!result.failureClass&&!result.notSent){sub.challengeDelivery={state:'healthy',lastAttemptAt:event.startedAt,lastSuccessAt:now(),consecutiveFailures:0,lastFailureClass:null};if(sub.activatedAt)sub.delivery={...sub.challengeDelivery};await save(sub);}
    if (sub.status !== 'ended' && sub.activatedAt && event.lane !== 'challenge' && !result.notSent) {
      sub.delivery.lastAttemptAt=event.startedAt;
      if (!result.failureClass) sub.delivery={ state:'healthy',lastAttemptAt:event.startedAt,lastSuccessAt:now(),consecutiveFailures:0,lastFailureClass:null };
      else if (!live(event)) sub.delivery={ ...sub.delivery,state:'failing',consecutiveFailures:sub.delivery.consecutiveFailures+1,lastFailureClass:result.failureClass };
      await save(sub);
      if (result.failureClass === 'receiver_gone') await endRecord(sub,'receiver_gone');
      else if (sub.delivery.consecutiveFailures>=10 && at-Date.parse(sub.delivery.lastSuccessAt || sub.activatedAt)>=86400000) await endRecord(sub,'delivery_failed');
    }
    if (!live(event) && sub.status === 'active' && (!sub.targetState || sub.targetState==='active') && sub.dirty?.[event.lane]) { const dirty=sub.dirty[event.lane];delete sub.dirty[event.lane];await save(sub);await queue(sub,dirty.type,dirty.reason,undefined,dirty.cursor); }
  }
  async function runOnce() {
    if (!enabled) return false;
    // Only the live index is listed, and only entries that are due are visited: a queued or
    // retrying notification whose time has come, or a processing one whose lease ran out.
    const candidates=(await store.listJson(wakeLiveDir)).filter(entry=>entry.status==='processing' ? Date.parse(entry.lockedUntil)<=time() : Date.parse(entry.availableAt)<=time())
      .sort((a,b)=>a.availableAt.localeCompare(b.availableAt));
    for (const candidate of candidates) {
      let claimed;
      await store.withTransaction([lock(candidate.inboxId)],async()=>{
        const event=await store.getJson(eventPath(candidate.id)); if (!event || !live(event)) { await store.deleteJson(wakeLivePath(candidate.id)); return; }
        const sub=await derive(await store.getJson(subPath(event.agentId,event.subscriptionId))); if (!sub) return;
        if (event.status === 'processing') { if (Date.parse(event.lockedUntil)>time()) return; const result={failureClass:'interrupted'};logAttempt(event,sub,result);await finish(event,sub,result);return; }
        if (Date.parse(event.availableAt)>time()) return;
        const {family,agent}=await facts(sub);
        if (event.generation!==sub.generation || sub.status === 'ended' || (sub.targetState && sub.targetState!=='active') || Date.parse(family?.refreshExpiresAt)<=time() || (event.lane==='work' && agent?.status==='paused') || (sub.status==='pending' && event.lane!=='challenge') || (sub.status==='active' && event.lane==='challenge')) { await finish(event,sub,{notSent:true});return; }
        const targetAttemptAt=sub.grokLastAttemptAt||sub.delivery.lastAttemptAt;
        if(sub.profile==='grok_trigger'&&targetAttemptAt&&time()-Date.parse(targetAttemptAt)<5000){event.availableAt=iso(Date.parse(targetAttemptAt)+5000);await putEvent(event);return;}
        if (Date.parse(event.deadline)<time()) { event.attempts=6;event.startedAt=now();await finish(event,sub,{failureClass:'interrupted'});return; }
        event.status='processing';event.attempts++;event.startedAt=now();event.claimToken=crypto.randomUUID();event.lockedUntil=iso(time()+15000);await putEvent(event);claimed={event,sub};
      });
      if (!claimed) continue;
      const {event,sub}=claimed;let result,address=null;
      try { destination.canonical(sub.url);profileOf(sub)?.destination?.(sub.url); } catch { result={failureClass:'url_rejected'}; }
      if (!result) {
        try {
          const resolved=await resolve(sub.url);
          address=resolved.addresses[0]||null;
          const admitted=await admission.admit({subscriptionId:sub.id,eventId:event.id,host:new URL(sub.url).hostname,addresses:resolved.addresses,token:event.claimToken,limited:Boolean(sub.profile)||event.lane==='challenge'||sub.lastTransportFailure===true});
          if(!admitted){await store.withTransaction([lock(sub.inboxId)],async()=>{const current=await store.getJson(eventPath(event.id));if(current?.claimToken===event.claimToken){current.status='queued';current.attempts--;current.availableAt=iso(time()+1000);current.claimToken=null;await putEvent(current);}});continue;}
          // Recheck control after asynchronous DNS, immediately before the external effect.
          let permitted=false, currentSub;
          await store.withTransaction([lock(sub.inboxId)],async()=>{
            const queued=await store.getJson(eventPath(event.id));
            const current=await derive(await store.getJson(subPath(sub.agentId,sub.id)));
            if(!current)return;
            const state=await facts(current);
            if(extension(current)&&!extensionLive(state))await endRecord(current,'credential_ended');
            permitted=queued?.status==='processing' && queued.claimToken===event.claimToken
              && Date.parse(queued.lockedUntil)>time() && Date.parse(queued.deadline)>=time()
              && time()-Date.parse(queued.startedAt)<10000 && queued.generation===current.generation && current.status!=='ended' && (!current.targetState || current.targetState==='active')
              && Date.parse(state.family?.refreshExpiresAt)>time()
              && !(event.lane==='work' && state.agent?.status==='paused')
              && (event.lane==='challenge' ? current.status==='pending' : current.status==='active');
            if(permitted&&current.profile==='grok_trigger'){
              const next=Date.parse(current.grokLastAttemptAt||current.delivery.lastAttemptAt||'1970-01-01T00:00:00Z')+5000;
              if(next>time()){queued.status='queued';queued.availableAt=iso(next);queued.attempts--;queued.claimToken=null;queued.lockedUntil=null;await putEvent(queued);permitted=false;}
              else{current.grokLastAttemptAt=now();await save(current);}
            }
            currentSub=current;
          });
          if (!permitted) result={notSent:true};
          else result=await send({...resolved,bodyText:event.bodyText,standardWebhooks:Boolean(currentSub.profile),headers:currentSub.profile ? await profileOf(currentSub).headers(currentSub,event) : keys.sign(sub.url,event.bodyText,event.id),remainingMs:Math.max(1,10000-(time()-Date.parse(event.startedAt)))});
        } catch { result={failureClass:'address_rejected'}; }
      }
      await admission.release(event.claimToken);
      logAttempt(event,sub,result,address);
      await store.withTransaction([lock(sub.inboxId)],async()=>{
        const current=await store.getJson(eventPath(event.id));if(current?.claimToken!==event.claimToken)return;
        // A result arriving beyond its lease is uncertain even if this process knows it. The
        // durable queue recovers it as interrupted, exactly as a different worker would.
        if(Date.parse(current.lockedUntil)<=time())result={failureClass:'interrupted'};
        await finish(current,await derive(await store.getJson(subPath(sub.agentId,sub.id))),result);
      });
      return true;
    }
    return false;
  }
  // Retention (§6.5) is counted in hours and days, so cleanup runs at most every 10 minutes even
  // though the maintenance tick calls it every second. Expiry found here is recorded as before.
  let lastCleanup = -Infinity;
  async function cleanup(){
    if(time()-lastCleanup<cleanupEveryMs)return;
    lastCleanup=time();
    for(const entry of await store.listJson(wakeSubscriptionIndexDir))await store.withTransaction([lock(entry.inboxId)],async()=>{
      const current=await derive(await store.getJson(subPath(entry.agentId,entry.id)));
      if(!current){await store.deleteJson(wakeSubscriptionIndexPath(entry.id));return;}
      if(current.status==='ended'&&time()-Date.parse(current.endedAt)>2592000000){await store.deleteJson(subPath(current.agentId,current.id));await store.deleteJson(wakeSubscriptionIndexPath(current.id));}
    });
    for(const event of await store.listJson(wakeQueueDir))if(!live(event)&&event.finishedAt&&time()-Date.parse(event.finishedAt)>86400000){await store.deleteJson(eventPath(event.id));await store.deleteJson(wakeLivePath(event.id));}
  }
  return { enabled, startup, heartbeat, create, activate, trigger, pause, runOnce,
    registerProfile(name,hooks){if(!['mcp_events','grok_trigger'].includes(name)||profiles.has(name))throw new Error('Invalid or duplicate wake profile');profiles.set(name,hooks);},
    async profileRecords(identity,profile){return store.withTransaction([lock(identity.inboxId)],async()=>(await listFor(identity,true)).filter(sub=>sub.profile===profile));},
    async reserveProfileCreate(identity,profile,id){return store.withTransaction([lock(identity.inboxId)],async()=>{available();if(!flags[profile])throw wakeError(404,'FEATURE_DISABLED');const current=await derive(await store.getJson(subPath(identity.agentId,id)));if(!current||current.status==='ended')await consumeCreate(identity);});},
    async createProfile(identity,profile,{id,url,expiresAt=null,allowPaused=false,quotaReserved=false,beforeCommit,resetGeneration=false,...fields}){return store.withTransaction([lock(identity.inboxId)],async()=>{
      await beforeCommit?.();
      available();if(!flags[profile]||!profiles.has(profile))throw wakeError(404,'FEATURE_DISABLED');
      const state=await facts(identity);if(!extensionLive(state))throw wakeError(401,'CREDENTIAL_REVOKED');
      if(!allowPaused&&state.agent.status==='paused')throw wakeError(409,'AGENT_PAUSED');
      const records=await listFor(identity,true);const current=records.find(sub=>sub.id===id&&sub.profile===profile);
      if(!quotaReserved&&(!current||current.status==='ended'))await consumeCreate(identity);
      for(const old of records)if(old.profile===profile&&old.id!==id&&old.status!=='ended'&&(profile==='grok_trigger'||old.eventName===fields.eventName))await endRecord(old,'replaced');
      if(resetGeneration&&current)for(const event of await liveEventsOf(current)){event.status='cancelled';event.finishedAt=now();event.claimToken=null;event.lockedUntil=null;await putEvent(event);}
      const at=now();const sub={...(current?.status!=='ended'?current:{}),id,...identity,generation:current?.status==='active'&&!resetGeneration?current.generation:crypto.randomUUID(),...(resetGeneration?{liveEvents:{}}:{}),profile,url,status:'active',endedReason:null,endedAt:null,createdAt:current?.status!=='ended'?current?.createdAt||at:at,activatedAt:current?.status!=='ended'?current?.activatedAt||at:at,expiresAt:expiresAt||iso(time()+2592000000),challengeExpiresAt:null,delivery:current?.delivery||{state:'healthy',lastAttemptAt:null,lastSuccessAt:null,consecutiveFailures:0,lastFailureClass:null},sequence:current?.sequence||0,dirty:{},...fields};
      await save(sub);await index(sub);return sub;
    });},
    async endProfile(identity,id,reason='ended_by_host',beforeCommit){return store.withTransaction([lock(identity.inboxId)],async()=>{await beforeCommit?.();const sub=await owned(identity,id,true);if(!sub.profile)throw wakeError(404,'WAKE_SUBSCRIPTION_NOT_FOUND');return endRecord(sub,reason);});},
    async queueProfile(sub,type,reason,cursor=null){return store.withTransaction([lock(sub.inboxId)],async()=>{const current=await derive(await store.getJson(subPath(sub.agentId,sub.id)));if(!current||current.generation!==sub.generation)return;if(current.status==='active'&&(!current.targetState||current.targetState==='active'))await queue(current,type,reason,undefined,cursor);});},
    async verifyCallback(identity,url,{bodyText,headers}){
      available();const resolved=await resolve(url);const token=crypto.randomUUID();const admitted=await admission.admit({subscriptionId:`verify:${identity.installationId}`,host:new URL(url).hostname,addresses:resolved.addresses,token,limited:true});
      if(!admitted)throw Object.assign(wakeError(429,'RATE_LIMITED'),{retryAfter:1});
      try{const state=await facts(identity);if(!extensionLive(state))throw wakeError(401,'CREDENTIAL_REVOKED');if(state.agent.status==='paused')throw wakeError(409,'AGENT_PAUSED');return await send({...resolved,bodyText,headers,readResponseBody:true,remainingMs:10000});}finally{await admission.release(token);}
    },
    keys:()=>{available();return keys.jwks();},
    async end(identity,id){available();return {subscription:publicSub(await endRecord(await owned(identity,id),'ended_by_host'))};},
    async ownerRevoke(inboxId,agentId,id){available();return {subscription:publicSub(await endRecord(await owned({inboxId,agentId},id),'revoked_by_owner'))};},
    async list(identity){available();return {installationId:identity.installationId,subscriptions:(await listFor(identity)).map(publicSub)};},
    async ownerList(inboxId,agentId){available();return {agentId,subscriptions:(await listFor({inboxId,agentId})).map(publicSub)};},
    async status(identity){if(!enabled)return {available:false,version:1,subscription:null};const records=await listFor(identity);const sub=records.find(s=>s.status==='active') || records.find(s=>s.status==='pending') || records[0];return {available:true,version:1,subscription:sub?{id:sub.id,status:sub.status,endedReason:sub.endedReason,expiresAt:sub.expiresAt}:null};},
    async endForFamily(inboxId,agentId,familyId){for(const sub of await agentSubs(agentId))if(sub.inboxId===inboxId&&sub.agentId===agentId&&sub.familyId===familyId)await endRecord(sub,'credential_ended');},
    cleanup,
    // The subscriptions the work-due scan should look at: active ones whose last work_due wake
    // is old enough that trigger would send another (workDueMinIntervalSeconds).
    async workDueTargets(){
      if(!enabled)return [];
      const targets=[];
      for(const entry of await store.listJson(wakeSubscriptionIndexDir))if(entry.status==='active'){
        const sub=await store.getJson(subPath(entry.agentId,entry.id));
        if (sub?.status !== 'active' || sub.targetState && sub.targetState !== 'active') continue;
        if (sub.profile === 'mcp_events' && sub.eventName !== 'envoi.work_available') continue;
        if (sub.lastWorkDueAt && time() - Date.parse(sub.lastWorkDueAt) < workDueMinIntervalMs) continue;
        targets.push({ id:sub.id, inboxId:sub.inboxId, agentId:sub.agentId, acceptsInstructions:!sub.profile });
      }
      return targets;
    }
  };
}
