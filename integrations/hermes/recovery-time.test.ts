import fs from'node:fs/promises';import path from'node:path';import{tmpdir}from'node:os';import{createHash}from'node:crypto';import{afterEach,expect,it}from'vitest';
import{authorizeRecoveryTime,validateRecoveryTime}from'./recovery-time';import type{ContinuationReceipt}from'./continuation-controller';
const h=(x:string)=>x.repeat(64),hash=(x:string)=>createHash('sha256').update(x).digest('hex'),dirs:string[]=[];
afterEach(async()=>{for(const d of dirs.splice(0)){if(!path.resolve(d).startsWith(path.resolve(tmpdir())+path.sep)||!path.basename(d).startsWith('envoi-recovery-time-'))throw Error('CLEANUP_REFUSED');await fs.rm(d,{recursive:true,force:true});}});
async function setup(change:Record<string,unknown>={}){
 const releaseRoot=await fs.mkdtemp(path.join(tmpdir(),'envoi-recovery-time-'));dirs.push(releaseRoot);
 const receipt={version:1,ownerApproved:true,approvalReceiptSha256:h('1'),packetSha256:h('2'),clientSource:'a'.repeat(40),serverSource:'b'.repeat(40),runnerSha256:h('3'),ciHead:'a'.repeat(40),ciPassed:true,modelCap:64,startUtc:'2020-01-02T00:00:00.000Z',hardStopUtc:'2020-01-02T01:30:00.000Z'} satisfies ContinuationReceipt;
 const original={...receipt,startUtc:'2020-01-01T00:00:00.000Z',hardStopUtc:'2020-01-01T01:30:00.000Z'},priorWindow=h('4'),priorPacketSha256=h('5'),stateSha256=h('6'),programSha256=h('7');
 const d={purpose:'phase-c-explicit-new-recovery-interval',version:1,owner:'pjsk02',ownerApproved:true,clientSource:receipt.clientSource,serverSource:receipt.serverSource,runnerSha256:receipt.runnerSha256,packetSha256:receipt.packetSha256,priorWindow,priorPacketSha256,priorStateSha256:stateSha256,priorProgramSha256:programSha256,modelCap:64,operationCap:60,caseCap:9,installationCap:5,assetCap:6,currentModels:30,currentOperations:24,currentCanonicalMessages:11,repeatOnboarding:false,replayAcceptedSends:false,pauseFailureWaived:false,decisionId:'inert-decision-123',receivedAtUtc:'2020-01-01T23:00:00.000Z',maximumIntervalMs:5400000,...change};
 const raw=JSON.stringify(d),decisionPath=path.join(releaseRoot,'time.json'),decisionSha256=hash(raw);await fs.writeFile(decisionPath,raw);
 const aRaw=JSON.stringify({recovery:{timeMode:'new-interval',timeDecisionSha256:decisionSha256,timeDecisionId:d.decisionId}}),amendmentPath=path.join(releaseRoot,'amendment.json');await fs.writeFile(amendmentPath,aRaw);
 receipt.approvalReceiptSha256=hash(aRaw);
 return{link:{mode:'new-interval' as const,decisionPath,decisionSha256,amendmentPath},original,receipt,priorWindow,priorPacketSha256,stateSha256,programSha256,amendmentSha256:hash(aRaw),releaseRoot};
}
it('validates an explicit separate interval without changing the original receipt or consuming at inspection',async()=>{
 const s=await setup(),before=JSON.stringify(s.original);await validateRecoveryTime(s);expect((await fs.readdir(s.releaseRoot)).length).toBe(2);const authority=await authorizeRecoveryTime(s);await authority!.consume();expect(JSON.stringify(s.original)).toBe(before);await expect(authority!.consume()).rejects.toThrow('RECOVERY_TIME_DECISION_ALREADY_CONSUMED');await expect(validateRecoveryTime(s)).rejects.toThrow('RECOVERY_TIME_DECISION_ALREADY_CONSUMED');
});
it('refuses missing/incorrect modes and never treats a new deadline as same-fixed recovery',async()=>{
 const s=await setup();await expect(authorizeRecoveryTime({...s,link:undefined} as never)).rejects.toThrow('EXPLICIT_RECOVERY_TIME_MODE_REQUIRED');await expect(authorizeRecoveryTime({...s,link:{mode:'same-fixed'}})).rejects.toThrow('ORIGINAL_RECOVERY_INTERVAL_REQUIRED');await expect(authorizeRecoveryTime({...s,link:{...s.link,mode:'auto-extend'}} as never)).rejects.toThrow('EXPLICIT_RECOVERY_TIME_MODE_REQUIRED');
});
it('refuses foreign source, packet, prior scope, reused sends and increased counters or caps',async()=>{
 for(const change of[{clientSource:'f'.repeat(40)},{packetSha256:h('f')},{priorWindow:h('f')},{priorStateSha256:h('f')},{replayAcceptedSends:true},{currentOperations:22},{modelCap:65}])await expect(authorizeRecoveryTime(await setup(change))).rejects.toThrow('EXACT_NEW_RECOVERY_TIME_DECISION_REQUIRED');
});
it('refuses an oversized duration, extra fields and a decision made after start',async()=>{
 for(const change of[{maximumIntervalMs:5400001},{maximumIntervalMs:60000},{receivedAtUtc:'2020-01-02T00:00:01.000Z'},{override:true}])await expect(authorizeRecoveryTime(await setup(change))).rejects.toThrow('BOUNDED_NEW_RECOVERY_INTERVAL_REQUIRED');
});
it('requires the exact decision hash in the genuine amendment, with no age-expiry on an unconsumed approval',async()=>{
 const s=await setup({receivedAtUtc:'2019-01-01T00:00:00.000Z'});await expect(validateRecoveryTime(s)).resolves.toBeUndefined();const raw=JSON.stringify({recovery:{timeMode:'new-interval',timeDecisionSha256:h('e')}});await fs.writeFile(s.link.amendmentPath,raw);await expect(authorizeRecoveryTime({...s,receipt:{...s.receipt,approvalReceiptSha256:hash(raw)},amendmentSha256:hash(raw)})).rejects.toThrow('RECOVERY_TIME_NOT_BOUND_TO_AMENDMENT');
});
it('refuses another encoding of the same actual decision and retains an uncertain partial marker',async()=>{
 const s=await setup(),a=await authorizeRecoveryTime(s);await a!.consume();const decision=JSON.parse(await fs.readFile(s.link.decisionPath,'utf8')),raw=JSON.stringify(decision,null,2),decisionSha256=hash(raw);await fs.writeFile(s.link.decisionPath,raw);const amendment=JSON.stringify({recovery:{timeMode:'new-interval',timeDecisionSha256:decisionSha256,timeDecisionId:decision.decisionId}});await fs.writeFile(s.link.amendmentPath,amendment);
 const replay={...s,receipt:{...s.receipt,approvalReceiptSha256:hash(amendment)},link:{...s.link,decisionSha256},amendmentSha256:hash(amendment)};await expect(validateRecoveryTime(replay)).rejects.toThrow('RECOVERY_TIME_DECISION_ALREADY_CONSUMED');
 const marker=(await fs.readdir(s.releaseRoot)).find(x=>x.endsWith('.used.json'))!;await fs.writeFile(path.join(s.releaseRoot,marker),'{partial');await expect(validateRecoveryTime(replay)).rejects.toThrow('RECOVERY_TIME_DECISION_ALREADY_CONSUMED');expect(await fs.readFile(path.join(s.releaseRoot,marker),'utf8')).toBe('{partial');
});
