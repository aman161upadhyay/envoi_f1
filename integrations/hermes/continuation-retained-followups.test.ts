import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {afterEach,expect,it} from 'vitest';
import {ContinuationController,type ContinuationReceipt} from './continuation-controller';
import {defaultContinuationFlowPolicy,hashReviewedContinuationPlan} from './continuation-plan';
const hash=(x:string|Buffer)=>createHash('sha256').update(x).digest('hex'),h=(x:string)=>x.repeat(64),dirs:string[]=[];
afterEach(async()=>{for(const dir of dirs.splice(0)){if(!path.resolve(dir).startsWith(path.resolve(tmpdir())+path.sep)||!path.basename(dir).startsWith('envoi-retained-test-'))throw Error('CLEANUP_REFUSED');await fs.rm(dir,{recursive:true,force:true});}});
async function setup(){
 const releaseRoot=await fs.mkdtemp(path.join(tmpdir(),'envoi-retained-test-'));dirs.push(releaseRoot);
 const prior={actualCalls:30,actualHermesApiCalls:24,openClawProviderRequestsReserved:6,possibleHostMessageEffects:22,canonicalEffects:9,caseIds:['a','b','c','d'],newInstallationsUsed:5,priorUploadedAssets:0,stopped:true,failure:'LIVE_ASSERTION_FAILED'};
 const raw=JSON.stringify(prior);await fs.writeFile(path.join(releaseRoot,'budget-7c522b08c11f.terminal-dd4debf.json'),raw);
 const receipt:ContinuationReceipt={version:1,ownerApproved:true,approvalReceiptSha256:h('1'),packetSha256:h('2'),clientSource:'a'.repeat(40),serverSource:'b'.repeat(40),runnerSha256:h('c'),ciHead:'a'.repeat(40),ciPassed:true,modelCap:64,startUtc:new Date(Date.now()-1000).toISOString(),hardStopUtc:new Date(Date.now()+60000).toISOString()};
 const preflight={checkedAtMs:Date.now(),allSelectedHostsStopped:true as const,activeLeases:0 as const,protectedCasePaused:true as const,originalDispositionMatches:true as const,actualHermesCalls:24 as const,actualOpenClawCalls:6 as const,conservativeMessages:22 as const,canonicalEffects:9 as const,cases:4 as const,newInstallations:5 as const,assets:0 as const};
 const expected={clientSource:receipt.clientSource,serverSource:receipt.serverSource,runnerSha256:receipt.runnerSha256,packetSha256:receipt.packetSha256,priorLedgerSha256:hash(raw)};
 const roles={je1:'agent_je1',je2:'agent_je2',testowner:'agent_owner',openclaw:'agent_oc'};
 const initialIds=['private-backlog','private-receipt-review','green','accept-authority','approved-accept-complete','asset-share','asset-read-proposal','asset-decline','declined-resume','openclaw'];
 const initialCases=Object.fromEntries(initialIds.map((id,i)=>[id,'case_initial_'+(i%4)]));
 const initial=await ContinuationController.open({releaseRoot,receipt,preflight,expected,flowCases:initialCases,actorIds:roles});
 const specs:[string,keyof typeof roles,number][]=[['private-backlog','je2',1],['green','je1',1],['private-followup','je2',3],['amber-followup','je1',1],['private-receipt-review','je1',1],['accept-authority','testowner',2],['approved-accept-complete','testowner',4],['asset-share','testowner',4],['asset-read-proposal','je1',1],['asset-decline','testowner',3],['declined-resume','testowner',1],['openclaw','openclaw',3],['oc-shared-read-propose','openclaw',4],['oc-canary-no-action','openclaw',2],['oc-accepted-decision-no-action','openclaw',1],['hermes-final-proposal','je1',2]];
 const flows=specs.map(([id,role,requests])=>({id,role,requests,workHash:null,policy:defaultContinuationFlowPolicy(id)}));
 const flowCases={...initialCases,'private-followup':initialCases['private-backlog'],'amber-followup':initialCases.green,...Object.fromEntries(specs.filter(([id])=>!(id in initialCases)&&!['private-followup','amber-followup'].includes(id)).map(([id],i)=>[id,'case_extra_'+(i%3)]))};
 const graph={purpose:'phase-c-reviewed-graph' as const,version:1 as const,allowSameRoleCohorts:true,flows,flowCases,actorIds:roles},planSha256=hashReviewedContinuationPlan(graph);
 const graphApprovalRaw=JSON.stringify({purpose:'phase-c-reviewed-graph-source-approval',version:1,ownerApproved:true,approvalId:'inert-retained-approval',planSha256,window:initial.ledger.window,clientSource:receipt.clientSource,serverSource:receipt.serverSource,packetSha256:receipt.packetSha256});
 const reviewedPlan={...graph,planSha256,ownerApprovalHash:hash(graphApprovalRaw)};
 await initial.ledger.amendReviewedPlan(reviewedPlan,{expectedWindow:initial.ledger.window,allHostsStopped:true,canonicalLeasesZero:true,previousNativeTerminal:true,chargedAttempts:30,graphApprovalRaw,clientSource:receipt.clientSource,serverSource:receipt.serverSource,packetSha256:receipt.packetSha256});initial.stop();
 const statePath=path.join(releaseRoot,'retained.json'),state={phase:'prepared',window:initial.ledger.window,planSha256:h('5'),started:{},results:{},effects:{},controlProofs:{},taskReceipts:{},followups:{private:{state:'accepted',messageId:'msg_private',caseId:flowCases['private-followup'],ownerReceiptSha256:h('6')},amber:{state:'accepted',messageId:'msg_amber',caseId:flowCases['amber-followup'],ownerReceiptSha256:h('7')}}};
 const stateRaw=JSON.stringify(state);await fs.writeFile(statePath,stateRaw);
 const originalExecutionPath=path.join(releaseRoot,'original-execution.json'),originalRaw=JSON.stringify({window:state.window,packetSha256:receipt.packetSha256,receipt});await fs.writeFile(originalExecutionPath,originalRaw);
 const recovery={purpose:'phase-c-retained-followups-before-native' as const,priorWindow:state.window,priorProgramSha256:state.planSha256,originalExecutionPath,originalExecutionSha256:hash(originalRaw),statePath,stateSha256:hash(stateRaw),approvedAmendmentSha256:receipt.approvalReceiptSha256,time:{mode:'same-fixed' as const}};
 return{options:{releaseRoot,receipt,expected,flowCases,actorIds:roles,reviewedPlan,preflight:{...preflight,conservativeMessages:24 as const,canonicalEffects:11 as const},recovery},state,initial};
}
async function historicalFixture(){
 const s=await setup(),ledger=s.initial.ledger;
 await ledger.bindWork('green',{canonicalWorkHash:h('8'),nativeToken:h('9'),evidenceHash:h('a')});await ledger.selectPhase('hermes',['green'],Date.now()+30000);
 const filename=path.join(s.options.releaseRoot,'phase-c-cumulative-requests.jsonl'),oldPrefix=await fs.readFile(filename),receipt={...s.options.receipt,approvalReceiptSha256:h('b')},priorWindow=hash(JSON.stringify(receipt));
 await ledger.bindApprovedWindow(priorWindow,{approvalReceiptHash:h('b'),allHostsStopped:true,canonicalLeasesZero:true,previousNativeTerminal:true,chargedAttempts:30});
 const graphApprovalRaw=JSON.stringify({purpose:'phase-c-reviewed-graph-source-approval',version:1,ownerApproved:true,approvalId:'inert-recovery-boundary',planSha256:s.options.reviewedPlan.planSha256,window:priorWindow,clientSource:receipt.clientSource,serverSource:receipt.serverSource,packetSha256:receipt.packetSha256}),reviewedPlan={...s.options.reviewedPlan,ownerApprovalHash:hash(graphApprovalRaw)};
 await ledger.amendReviewedPlan(reviewedPlan,{expectedWindow:priorWindow,allHostsStopped:true,canonicalLeasesZero:true,previousNativeTerminal:true,chargedAttempts:30,graphApprovalRaw,clientSource:receipt.clientSource,serverSource:receipt.serverSource,packetSha256:receipt.packetSha256});
 s.state.window=priorWindow;const raw=JSON.stringify(s.state),executionRaw=JSON.stringify({window:priorWindow,packetSha256:receipt.packetSha256,receipt});await fs.writeFile(s.options.recovery.statePath,raw);await fs.writeFile(s.options.recovery.originalExecutionPath,executionRaw);
 const options={...s.options,receipt,reviewedPlan,recovery:{...s.options.recovery,priorWindow,stateSha256:hash(raw),originalExecutionSha256:hash(executionRaw),approvedAmendmentSha256:receipt.approvalReceiptSha256}};
 return{...s,options,ledger,filename,oldPrefix};
}
it('opens the explicit retained path with current counts without writing old state, seed or ledger',async()=>{
 const {options}=await setup(),before=await fs.readFile(path.join(options.releaseRoot,'phase-c-cumulative-requests.jsonl')),state=await fs.readFile(options.recovery.statePath);
 const c=await ContinuationController.recoverRetainedFollowups(options);expect(c.active()).toBe(true);expect(c.ledger.hasNativeHistory).toBe(false);expect(c.ledger.snapshot().chargedAttempts).toBe(30);c.stop();
 expect(await fs.readFile(path.join(options.releaseRoot,'phase-c-cumulative-requests.jsonl'))).toEqual(before);expect(await fs.readFile(options.recovery.statePath)).toEqual(state);
 await expect(ContinuationController.open(options as never)).rejects.toThrow('FRESH_PRESERVED_PREFLIGHT_REQUIRED');
});
it('refuses an old count, stale check, expired clock, unknown amendment or altered retained state',async()=>{
 const {options}=await setup();
 for(const preflight of [{...options.preflight,conservativeMessages:22},{...options.preflight,canonicalEffects:9},{...options.preflight,checkedAtMs:Date.now()-300001}])await expect(ContinuationController.recoverRetainedFollowups({...options,preflight} as never)).rejects.toThrow('FRESH_PRESERVED_PREFLIGHT_REQUIRED');
 await expect(ContinuationController.recoverRetainedFollowups({...options,receipt:{...options.receipt,hardStopUtc:new Date(Date.now()-1).toISOString()}})).rejects.toThrow('ORIGINAL_RECOVERY_INTERVAL_REQUIRED');
 await expect(ContinuationController.recoverRetainedFollowups({...options,recovery:{...options.recovery,approvedAmendmentSha256:h('f')}})).rejects.toThrow('EXACT_RETAINED_FOLLOWUP_RECOVERY_REQUIRED');
 await fs.appendFile(options.recovery.statePath,' ');await expect(ContinuationController.recoverRetainedFollowups(options)).rejects.toThrow('RETAINED_RECOVERY_STATE_CHANGED');
});
it('refuses any started native attempt even if no provider request was made',async()=>{
 const {options,state}=await setup();state.started={flow:{workId:'msg_private'}} as never;const raw=JSON.stringify(state);await fs.writeFile(options.recovery.statePath,raw);
 await expect(ContinuationController.recoverRetainedFollowups({...options,recovery:{...options.recovery,stateSha256:hash(raw)}})).rejects.toThrow('ZERO_NATIVE_RETAINED_STATE_REQUIRED');
});
it('refuses a missing acceptance or wrong causal case without relaxing the original path',async()=>{
 const {options,state}=await setup();state.followups.private.caseId='case_other';const raw=JSON.stringify(state);await fs.writeFile(options.recovery.statePath,raw);
 await expect(ContinuationController.recoverRetainedFollowups({...options,recovery:{...options.recovery,stateSha256:hash(raw)}})).rejects.toThrow('BOTH_ACCEPTED_FOLLOWUPS_REQUIRED');
});
it('refuses a ledger admission which happened before any model call or conductor checkpoint',async()=>{
 const {options,initial}=await setup();
 await initial.ledger.bindWork('private-followup',{canonicalWorkHash:h('8'),nativeToken:h('9'),evidenceHash:h('a')});
 expect(initial.ledger.snapshot().chargedAttempts).toBe(30);expect(initial.ledger.hasNativeHistory).toBe(true);
 await expect(ContinuationController.recoverRetainedFollowups(options)).rejects.toThrow('ZERO_NATIVE_LEDGER_REQUIRED');
});
it('binds the original execution, exact program and absolute deadline independently of operator fields',async()=>{
 const {options}=await setup();
 await expect(ContinuationController.recoverRetainedFollowups({...options,recovery:{...options.recovery,priorWindow:h('e')}})).rejects.toThrow('ORIGINAL_RECOVERY_INTERVAL_REQUIRED');
 await expect(ContinuationController.recoverRetainedFollowups({...options,recovery:{...options.recovery,priorProgramSha256:h('e')}})).rejects.toThrow('ZERO_NATIVE_RETAINED_STATE_REQUIRED');
 await expect(ContinuationController.recoverRetainedFollowups({...options,receipt:{...options.receipt,hardStopUtc:new Date(Date.parse(options.receipt.hardStopUtc)+60000).toISOString()}})).rejects.toThrow('ORIGINAL_RECOVERY_INTERVAL_REQUIRED');
 await fs.appendFile(options.recovery.originalExecutionPath,' ');await expect(ContinuationController.recoverRetainedFollowups(options)).rejects.toThrow('ORIGINAL_RECOVERY_EXECUTION_CHANGED');
});
it('preserves prior bindings and a phase without a window, while recovering only after the proven stopped boundary',async()=>{
 const s=await historicalFixture();expect(s.ledger.hasNativeHistory).toBe(true);expect(s.ledger.hasNativeHistorySinceWindow(s.options.recovery.priorWindow)).toBe(false);
 const c=await ContinuationController.recoverRetainedFollowups(s.options);c.stop();expect(c.ledger.snapshot().chargedAttempts).toBe(30);expect((await fs.readFile(s.filename)).subarray(0,s.oldPrefix.length)).toEqual(s.oldPrefix);
 const rows=(await fs.readFile(s.filename,'utf8')).trim().split('\n').map(x=>JSON.parse(x));expect(rows.find(r=>r.kind==='phase')).not.toHaveProperty('window');
});
it('refuses every native row after the boundary, including a phase without window and a later-window admission',async()=>{
 for(const later of[false,true]){const s=await historicalFixture();if(later)await s.ledger.bindApprovedWindow(h('c'),{approvalReceiptHash:h('d'),allHostsStopped:true,canonicalLeasesZero:true,previousNativeTerminal:true,chargedAttempts:30});
  await s.ledger.bindWork('private-followup',{canonicalWorkHash:h('c'),nativeToken:h('d'),evidenceHash:h('e')});await s.ledger.selectPhase('hermes',['private-followup'],Date.now()+30000);
  expect(s.ledger.hasNativeHistorySinceWindow(s.options.recovery.priorWindow)).toBe(true);await expect(ContinuationController.recoverRetainedFollowups(s.options)).rejects.toThrow('ZERO_NATIVE_LEDGER_REQUIRED');
 }
});
it('refuses missing and ambiguous stopped boundaries rather than guessing the latest window',async()=>{
 const s=await historicalFixture(),window=s.options.recovery.priorWindow;expect(()=>s.ledger.hasNativeHistorySinceWindow(h('e'))).toThrow('EXACT_RECOVERY_START_WINDOW_REQUIRED');
 await s.ledger.bindApprovedWindow(h('c'),{approvalReceiptHash:h('d'),allHostsStopped:true,canonicalLeasesZero:true,previousNativeTerminal:true,chargedAttempts:30});await s.ledger.bindApprovedWindow(window,{approvalReceiptHash:h('e'),allHostsStopped:true,canonicalLeasesZero:true,previousNativeTerminal:true,chargedAttempts:30});expect(()=>s.ledger.hasNativeHistorySinceWindow(window)).toThrow('EXACT_RECOVERY_START_WINDOW_REQUIRED');
});
