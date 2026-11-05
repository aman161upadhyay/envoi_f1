import fs from 'node:fs/promises';import path from 'node:path';import{createHash}from'node:crypto';
import type{ContinuationReceipt}from'./continuation-controller';
export type RecoveryTimeLink=Readonly<{mode:'same-fixed'}>|Readonly<{mode:'new-interval';decisionPath:string;decisionSha256:string;amendmentPath:string}>;
const hash=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex'),digest=(x:unknown):x is string=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
function refuse(code:string):never{throw Object.assign(Error(code),{code});}
async function read(file:string,pin:string){if(!path.isAbsolute(file)||!digest(pin))refuse('PINNED_RECOVERY_TIME_DECISION_REQUIRED');const s=await fs.lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.size<=0||s.size>32768)refuse('BOUNDED_RECOVERY_TIME_DECISION_REQUIRED');const raw=await fs.readFile(file);if(hash(raw)!==pin)refuse('RECOVERY_TIME_DECISION_CHANGED');return JSON.parse(raw.toString('utf8'));}
/** No host/model start. A new clock needs a separate, exact decision and a one-use marker.
 * The historical receipt is read only and never gets a different deadline. */
type RecoveryTimeInput={link:RecoveryTimeLink;original:ContinuationReceipt;receipt:ContinuationReceipt;priorWindow:string;priorPacketSha256:string;stateSha256:string;programSha256:string;amendmentSha256:string;releaseRoot:string};
export async function validateRecoveryTime(input:RecoveryTimeInput){await authorizeRecoveryTime(input);}
export async function authorizeRecoveryTime(input:RecoveryTimeInput){
 const {link,original,receipt:r}=input;
 if(link?.mode==='same-fixed'){
  if(Object.keys(link).join()!=='mode'||r.hardStopUtc!==original.hardStopUtc)refuse('ORIGINAL_RECOVERY_INTERVAL_REQUIRED');return;
 }
 if(link?.mode!=='new-interval'||Object.keys(link).sort().join()!=='amendmentPath,decisionPath,decisionSha256,mode')refuse('EXPLICIT_RECOVERY_TIME_MODE_REQUIRED');
 if(r.approvalReceiptSha256!==input.amendmentSha256)refuse('RECOVERY_TIME_NOT_BOUND_TO_AMENDMENT');
 const d=await read(link.decisionPath,link.decisionSha256),a=await read(link.amendmentPath,input.amendmentSha256);
 if(a.recovery?.timeMode!=='new-interval'||a.recovery?.timeDecisionSha256!==link.decisionSha256||a.recovery?.timeDecisionId!==d.decisionId)refuse('RECOVERY_TIME_NOT_BOUND_TO_AMENDMENT');
 const exact={purpose:'phase-c-explicit-new-recovery-interval',version:1,owner:'pjsk02',ownerApproved:true,clientSource:r.clientSource,serverSource:r.serverSource,runnerSha256:r.runnerSha256,packetSha256:r.packetSha256,priorWindow:input.priorWindow,priorPacketSha256:input.priorPacketSha256,priorStateSha256:input.stateSha256,priorProgramSha256:input.programSha256,modelCap:64,operationCap:60,caseCap:9,installationCap:5,assetCap:6,currentModels:30,currentOperations:24,currentCanonicalMessages:11,repeatOnboarding:false,replayAcceptedSends:false,pauseFailureWaived:false};
 for(const[k,v]of Object.entries(exact))if(d[k]!==v)refuse('EXACT_NEW_RECOVERY_TIME_DECISION_REQUIRED');
 const keys=[...Object.keys(exact),'decisionId','receivedAtUtc','maximumIntervalMs'].sort().join();
 const start=Date.parse(r.startUtc),stop=Date.parse(r.hardStopUtc),received=Date.parse(d.receivedAtUtc);
 if(Object.keys(d).sort().join()!==keys||typeof d.decisionId!=='string'||!/^[A-Za-z0-9_-]{8,100}$/.test(d.decisionId)||!Number.isSafeInteger(d.maximumIntervalMs)||d.maximumIntervalMs<=0||d.maximumIntervalMs>5400000||!Number.isFinite(start)||!Number.isFinite(stop)||!Number.isFinite(received)||received>start||start<Date.parse(original.startUtc)||stop<=start||stop-start>d.maximumIntervalMs)refuse('BOUNDED_NEW_RECOVERY_INTERVAL_REQUIRED');
 // The stable identity is the actual human-decision record, not its JSON encoding.
 const marker=path.join(path.resolve(input.releaseRoot),'phase-c-recovery-time-'+hash('pjsk02\0'+d.decisionId)+'.used.json');
 try{await fs.lstat(marker);refuse('RECOVERY_TIME_DECISION_ALREADY_CONSUMED');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 return{async consume(){let handle:Awaited<ReturnType<typeof fs.open>>|undefined;try{handle=await fs.open(marker,'wx',0o600);await handle.writeFile(JSON.stringify({purpose:'phase-c-one-use-recovery-time',decisionId:d.decisionId,decisionSha256:link.decisionSha256,amendmentSha256:input.amendmentSha256,window:hash(JSON.stringify(r)),originalHardStopUtc:original.hardStopUtc})+'\n');await handle.sync();}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')refuse('RECOVERY_TIME_DECISION_ALREADY_CONSUMED');throw error;}finally{await handle?.close();}}};
}
