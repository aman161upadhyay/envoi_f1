import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {ContinuationController,type ContinuationReceipt,type SameRoleNativeAttributionGuard} from './continuation-controller';
import {RequestBudgetLedger,nativeWorkToken} from './request-budget';
import {DECLINE_CONTINUATION,continuationAllocation,defaultContinuationFlowPolicy,hashReviewedContinuationPlan,validateReviewedContinuationPlan,type ReviewedContinuationPlan,type ReviewedContinuationFlow} from './continuation-plan';

const h=(s:string)=>s.repeat(64),hash=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex');
const directories:string[]=[],controllers:ContinuationController[]=[];
afterEach(async()=>{for(const c of controllers.splice(0))c.stop();for(const dir of directories.splice(0)){const p=path.resolve(dir);if(!p.startsWith(path.resolve(tmpdir())+path.sep)||!path.basename(p).startsWith('envoi-reviewed-graph-'))throw Error('CLEANUP_REFUSED');await fs.rm(dir,{recursive:true,force:true});}});

async function setup(){
 const releaseRoot=await fs.mkdtemp(path.join(tmpdir(),'envoi-reviewed-graph-'));directories.push(releaseRoot);
 const prior={actualCalls:30,actualHermesApiCalls:24,openClawProviderRequestsReserved:6,possibleHostMessageEffects:22,canonicalEffects:9,caseIds:['a','b','c','d'],newInstallationsUsed:5,priorUploadedAssets:0,stopped:true,failure:'LIVE_ASSERTION_FAILED',history:['retained']};
 const bytes=JSON.stringify(prior);await fs.writeFile(path.join(releaseRoot,'budget-7c522b08c11f.terminal-dd4debf.json'),bytes);
 const receipt:ContinuationReceipt={version:1,ownerApproved:true,approvalReceiptSha256:h('1'),packetSha256:h('2'),clientSource:'a'.repeat(40),serverSource:'b'.repeat(40),runnerSha256:h('c'),ciHead:'a'.repeat(40),ciPassed:true,modelCap:64,startUtc:new Date(Date.now()-1000).toISOString(),hardStopUtc:new Date(Date.now()+60000).toISOString()};
 const preflight={checkedAtMs:Date.now(),allSelectedHostsStopped:true as const,activeLeases:0 as const,protectedCasePaused:true as const,originalDispositionMatches:true as const,actualHermesCalls:24 as const,actualOpenClawCalls:6 as const,conservativeMessages:22 as const,canonicalEffects:9 as const,cases:4 as const,newInstallations:5 as const,assets:0 as const};
 const expected={clientSource:receipt.clientSource,serverSource:receipt.serverSource,runnerSha256:receipt.runnerSha256,packetSha256:receipt.packetSha256,priorLedgerSha256:hash(bytes)};
 const flowCases=Object.fromEntries(DECLINE_CONTINUATION.map(f=>[f.id,'case_'+(['private-backlog','private-receipt-review'].includes(f.id)?'private':['green','accept-authority','approved-accept-complete'].includes(f.id)?'negotiation':f.id==='openclaw'?'openclaw':'assets')]));
 const actorIds={je1:'agent_je1',je2:'agent_je2',testowner:'agent_testowner',openclaw:'agent_openclaw'};
 const options={releaseRoot,receipt,preflight,expected,flowCases,actorIds};
 const c=await ContinuationController.open(options);controllers.push(c);
 return {...options,c,filename:path.join(releaseRoot,'phase-c-cumulative-requests.jsonl')};
}
function plan(s:Awaited<ReturnType<typeof setup>>):ReviewedContinuationPlan{
 const flows:ReviewedContinuationFlow[]=[...continuationAllocation('sequential').map(f=>({...f,policy:defaultContinuationFlowPolicy(f.id)})),
  ...['oc-private','oc-negotiation','oc-accept','oc-decline','oc-outcome'].map(id=>({id,role:'openclaw' as const,requests:2,workHash:null,
   policy:{noAction:id==='oc-decline',decisionOutcome:id==='oc-decline'?'declined' as const:id==='oc-accept'?'approved' as const:null,allowHumanEnd:false}}))];
 const flowCases={...s.flowCases,'oc-private':'case_oc_private','oc-negotiation':'case_oc_negotiation','oc-accept':'case_oc_negotiation','oc-decline':'case_oc_decline','oc-outcome':'case_oc_negotiation'};
 const payload={purpose:'phase-c-reviewed-graph' as const,version:1 as const,allowSameRoleCohorts:true,flows,flowCases,actorIds:s.actorIds};
 return {...payload,ownerApprovalHash:h('9'),planSha256:hashReviewedContinuationPlan(payload)};
}
function sign(p:ReviewedContinuationPlan):ReviewedContinuationPlan{return {...p,planSha256:hashReviewedContinuationPlan(p)};}
const proof=(ledger:RequestBudgetLedger)=>({expectedWindow:ledger.window,allHostsStopped:true,canonicalLeasesZero:true,previousNativeTerminal:true,chargedAttempts:ledger.snapshot().chargedAttempts});
async function adopt(s:Awaited<ReturnType<typeof setup>>,p=plan(s),guard?:SameRoleNativeAttributionGuard){
 await s.c.ledger.amendReviewedPlan(p,proof(s.c.ledger));
 const c=await ContinuationController.open({...s,flowCases:p.flowCases,actorIds:p.actorIds,reviewedPlan:p,...(guard?{sameRoleNativeAttribution:guard}:{})});controllers.push(c);return c;
}
function claim(c:ContinuationController,p:ReviewedContinuationPlan,id:string,outcome:'approved'|'declined'='declined'){
 const f=p.flows.find(f=>f.id===id)!,workId='msg_'+id.replaceAll('-','_'),at=new Date().toISOString();
 const message:Record<string,unknown>={id:workId,caseId:p.flowCases[id],recipientAgentId:p.actorIds[f.role]};
 if(f.policy.decisionOutcome!==null)Object.assign(message,{kind:'humanDecision',type:'humanDecision',inboxId:'inbox_fixture',recipientInboxId:'inbox_fixture',senderType:'human',senderHumanId:'human_fixture',from:{humanId:'human_fixture'},counterpartyAgentId:'agent_other',counterpartyInboxId:'inbox_other',counterpartyAddress:'other@inert.example',requestId:'request_fixture',policyEvaluationId:'policy_eval_fixture',action:'proposal.accept',outcome,text:'Inert decision.',status:'delivered',createdAt:at,deliveredAt:at,updatedAt:at});
 const work={workId,message:message as {id:string;caseId:string;recipientAgentId:string;[key:string]:unknown}};
 c.expectWork(id,workId,h('4'));c.observeClaim(id,f.role,work,JSON.stringify(work));return workId;
}

it('retains the default ten-flow graph and requires explicit exact reviewed metadata after append-only amendment',async()=>{
 const s=await setup(),before=await fs.readFile(s.filename),anchor=await fs.readFile(path.join(s.releaseRoot,'phase-c-request-ledger.anchor')),p=plan(s);
 expect(s.c.ledger.reviewedPlan).toBeUndefined();expect(s.c.ledger.flows).toEqual(continuationAllocation('bounded-contingency'));
 await expect(ContinuationController.open({...s,flowCases:p.flowCases,reviewedPlan:p})).rejects.toThrow('CANONICAL_CONTINUATION_RECONCILIATION_REQUIRED');
 await s.c.ledger.amendReviewedPlan(p,proof(s.c.ledger));const after=await fs.readFile(s.filename);expect(after.subarray(0,before.length)).toEqual(before);expect(await fs.readFile(path.join(s.releaseRoot,'phase-c-request-ledger.anchor'))).toEqual(anchor);
 expect(s.c.ledger.snapshot()).toMatchObject({chargedAttempts:30,modelCap:64,remainingModelAttempts:34,carriedMessageReservations:22,carriedNewInstallations:5});
 const reopened=await RequestBudgetLedger.open(s.filename);expect(reopened.reviewedPlan).toEqual(p);expect(reopened.flows).toHaveLength(15);expect(reopened.flows.reduce((n,f)=>n+f.requests,0)).toBe(34);
 await expect(ContinuationController.open(s)).rejects.toThrow('CANONICAL_CONTINUATION_RECONCILIATION_REQUIRED');
 const c=await ContinuationController.open({...s,flowCases:p.flowCases,reviewedPlan:p});controllers.push(c);expect(c.flowPolicy('oc-decline')).toEqual({noAction:true,decisionOutcome:'declined',allowHumanEnd:false});
 await reopened.amendReviewedPlan(p,proof(reopened));expect(await fs.readFile(s.filename)).toEqual(after);
});

it('hashes exact roles/quotas/cases/recipients/policy and rejects malformed, extra-key or unapproved graph metadata before writing',async()=>{
 const s=await setup(),p=plan(s),before=await fs.readFile(s.filename);
 for(const bad of [{...p,ownerApprovalHash:''},{...p,planSha256:h('0')},{...p,extra:true},
  {...p,flowCases:{...p.flowCases,openclaw:'case_other'}},{...p,actorIds:{...p.actorIds,openclaw:'agent_other'}},
  sign({...p,flows:p.flows.map((f,i)=>i?f:{...f,policy:{...f.policy,noAction:'yes' as unknown as boolean}})})]){
  expect(()=>validateReviewedContinuationPlan(bad)).toThrow();await expect(s.c.ledger.amendReviewedPlan(bad as ReviewedContinuationPlan,proof(s.c.ledger))).rejects.toThrow();
 }
 expect(await fs.readFile(s.filename)).toEqual(before);
 await expect(adopt(s,p)).resolves.toBeDefined();
 await expect(ContinuationController.open({...s,flowCases:{...p.flowCases,openclaw:'case_changed'},reviewedPlan:p})).rejects.toThrow('REVIEWED_GRAPH_CANONICAL_SCOPE_CHANGED');
 await expect(ContinuationController.open({...s,flowCases:p.flowCases,actorIds:{...p.actorIds,openclaw:'agent_changed'},reviewedPlan:p})).rejects.toThrow('REVIEWED_GRAPH_CANONICAL_SCOPE_CHANGED');
});

it('refuses budget/identity/policy broadening, removed history, wrong window, pending work and unconfirmed stopped guards',async()=>{
 const s=await setup(),p=plan(s),before=await fs.readFile(s.filename);
 const variants=[sign({...p,flows:p.flows.slice(1),flowCases:Object.fromEntries(Object.entries(p.flowCases).filter(([key])=>key!=='private-backlog'))}),
  sign({...p,flows:p.flows.map((f,i)=>i?f:{...f,role:'je1'})}),sign({...p,flows:p.flows.map((f,i)=>i?f:{...f,workHash:h('8')})}),
  sign({...p,flows:p.flows.map(f=>f.id==='declined-resume'?{...f,policy:{noAction:false,decisionOutcome:'declined',allowHumanEnd:false}}:f)}),
  sign({...p,flows:p.flows.map(f=>f.id==='green'?{...f,requests:99}:f)})];
 for(const bad of variants)await expect(s.c.ledger.amendReviewedPlan(bad,proof(s.c.ledger))).rejects.toThrow();
 for(const bad of [{...proof(s.c.ledger),allHostsStopped:false},{...proof(s.c.ledger),canonicalLeasesZero:false},{...proof(s.c.ledger),previousNativeTerminal:false},{...proof(s.c.ledger),expectedWindow:h('0')},{...proof(s.c.ledger),chargedAttempts:29}])await expect(s.c.ledger.amendReviewedPlan(p,bad)).rejects.toThrow('REVIEWED_GRAPH_RECONCILIATION_REQUIRED');
 expect(await fs.readFile(s.filename)).toEqual(before);
 await s.c.ledger.bindWork('private-backlog',{canonicalWorkHash:h('3'),nativeToken:h('4'),evidenceHash:h('5')});await s.c.ledger.selectPhase('hermes',['private-backlog'],Date.now()+10000);await s.c.ledger.reserve('je2',h('4'));
 await expect(s.c.ledger.amendReviewedPlan(p,proof(s.c.ledger))).rejects.toThrow('REVIEWED_GRAPH_RECONCILIATION_REQUIRED');expect(s.c.ledger.snapshot()).toMatchObject({chargedAttempts:31,pending:1});
});

it('never refunds completed calls, reduces below charged quota, resets native deadlines, rebinds old work or reuses a plan approval',async()=>{
 const s=await setup(),p=plan(s);await s.c.ledger.bindWork('private-backlog',{canonicalWorkHash:h('3'),nativeToken:h('4'),evidenceHash:h('5')});await s.c.ledger.selectPhase('hermes',['private-backlog'],Date.now()+10000);
 for(let n=0;n<3;n++){const a=await s.c.ledger.reserve('je2',h('4'));await s.c.ledger.markDispatched(a);await s.c.ledger.finish(a,'response');}
 await expect(s.c.ledger.amendReviewedPlan(sign({...p,flows:p.flows.map(f=>f.id==='private-backlog'?{...f,requests:2}:f)}),proof(s.c.ledger))).rejects.toThrow('REVIEWED_GRAPH_HISTORY_CHANGED');
 await s.c.ledger.amendReviewedPlan(p,proof(s.c.ledger));expect((await RequestBudgetLedger.open(s.filename)).snapshot()).toMatchObject({chargedAttempts:33,remainingModelAttempts:31});
 await expect(s.c.ledger.selectPhase('hermes',['private-backlog'],Date.now()+11000)).rejects.toThrow('NATIVE_DEADLINE_CANNOT_RESET');
 await expect(s.c.ledger.bindWork('private-backlog',{canonicalWorkHash:h('6'),nativeToken:h('7'),evidenceHash:h('8')})).rejects.toThrow('CANONICAL_WORK_BINDING_CHANGED');
 await expect(s.c.ledger.amendReviewedPlan(sign({...p,allowSameRoleCohorts:false}),proof(s.c.ledger))).rejects.toThrow('REVIEWED_GRAPH_RECONCILIATION_REQUIRED');
 const newApproval=sign({...p,ownerApprovalHash:h('8'),flowCases:{...p.flowCases,'private-backlog':'case_drift'}});
 await expect(s.c.ledger.amendReviewedPlan(newApproval,proof(s.c.ledger))).rejects.toThrow('REVIEWED_GRAPH_HISTORY_CHANGED');
});

it('requires actual per-session native attribution beyond an approved same-role graph',async()=>{
 const s=await setup(),p=plan(s),c=await adopt(s,p);expect(()=>c.releaseGroup(['openclaw','oc-private'])).toThrow('SAME_ROLE_NATIVE_ATTRIBUTION_REQUIRED');expect(c.summary().released).toEqual([]);
 expect(()=>c.releaseGroup(['openclaw'])).toThrow('SAME_ROLE_NATIVE_ATTRIBUTION_REQUIRED');
 const wrong=await adopt(s,p,async binding=>({...binding,workId:'msg_wrong'}));wrong.releaseGroup(['openclaw','oc-private']);const w=claim(wrong,p,'openclaw');
 await expect(wrong.nativeGuard('openclaw',h('3'))({workId:w,sessionId:'session_one',deadlineUnixMs:Date.now()+10000},new AbortController().signal)).rejects.toThrow('SAME_ROLE_NATIVE_ATTRIBUTION_REQUIRED');
 expect(wrong.ledger.snapshot()).toMatchObject({chargedAttempts:30,pending:0});expect((await fs.readFile(s.filename,'utf8')).includes('"kind":"binding"')).toBe(false);
});

for(const source of ['controller','caller'] as const)it(`cancels a never-resolving attribution hook with the initiating ${source} abort reason before any ledger binding`,async()=>{
 const s=await setup(),p=plan(s);let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});let seen:AbortSignal|undefined;
 const c=await adopt(s,p,async(_binding,signal)=>{seen=signal;entered();return new Promise(()=>{});});
 c.releaseGroup(['openclaw']);const workId=claim(c,p,'openclaw'),caller=new AbortController();
 const pending=c.nativeGuard('openclaw',h('3'))({workId,sessionId:'never_resolving',deadlineUnixMs:Date.now()+10000},caller.signal).catch(error=>error);
 await started;const reason=new Error('INERT_INITIATING_ABORT');
 if(source==='controller')c.control.abort(reason);else caller.abort(reason);
 expect(await pending).toBe(reason);expect(seen?.aborted).toBe(true);expect(seen?.reason).toBe(reason);
 expect(c.ledger.snapshot()).toMatchObject({chargedAttempts:30,pending:0});expect((await fs.readFile(s.filename,'utf8')).includes('"kind":"binding"')).toBe(false);
});

it('expires the original short attribution deadline and ignores a proof returned after the guard already ended',async()=>{
 const s=await setup(),p=plan(s);let resolveProof!:(value:Parameters<SameRoleNativeAttributionGuard>[0])=>void,frame:Parameters<SameRoleNativeAttributionGuard>[0]|undefined;
 const c=await adopt(s,p,async binding=>{frame=binding;return new Promise(resolve=>{resolveProof=resolve;});});
 c.releaseGroup(['openclaw']);const workId=claim(c,p,'openclaw');
 const failure=c.nativeGuard('openclaw',h('3'))({workId,sessionId:'late_proof',deadlineUnixMs:Date.now()+40},new AbortController().signal).catch(error=>error);
 let watchdog:ReturnType<typeof setTimeout>|undefined;
 const error=await Promise.race([failure,new Promise<never>((_resolve,reject)=>{watchdog=setTimeout(()=>reject(Error('ORIGINAL_DEADLINE_NOT_ENFORCED')),1000);})]).finally(()=>clearTimeout(watchdog));
 expect(error.name).toBe('TimeoutError');resolveProof(frame!);await new Promise(resolve=>setTimeout(resolve,0));
 expect(c.ledger.snapshot()).toMatchObject({chargedAttempts:30,pending:0});expect((await fs.readFile(s.filename,'utf8')).includes('"kind":"binding"')).toBe(false);
});

it('rejects a proof that crosses the original wall-clock deadline before the timeout event is serviced',async()=>{
 const s=await setup(),p=plan(s);let deadline=0;
 const c=await adopt(s,p,async binding=>{vi.spyOn(Date,'now').mockReturnValue(deadline+1);return {...binding};});
 c.releaseGroup(['openclaw']);const workId=claim(c,p,'openclaw');deadline=Date.now()+10000;
 try{await expect(c.nativeGuard('openclaw',h('3'))({workId,sessionId:'clock_crossing',deadlineUnixMs:deadline},new AbortController().signal)).rejects.toThrow('NATIVE_DEADLINE_EXPIRED');}
 finally{vi.restoreAllMocks();}
 expect(c.ledger.snapshot()).toMatchObject({chargedAttempts:30,pending:0});expect((await fs.readFile(s.filename,'utf8')).includes('"kind":"binding"')).toBe(false);
});

it('admits a bounded distinct-case same-role cohort only with injected inert per-native-session proofs and exact scoped work',async()=>{
 const s=await setup(),p=plan(s),seen:string[]=[],c=await adopt(s,p,async binding=>{seen.push(binding.workId);return {...binding};});
 c.releaseGroup(['openclaw','oc-private']);const first=claim(c,p,'openclaw'),second=claim(c,p,'oc-private');
 expect(()=>c.assertScopedTool('openclaw','envoi_case_snapshot')).toThrow('EXACT_SCOPED_WORK_REQUIRED');expect(()=>c.assertScopedTool('openclaw','envoi_case_snapshot','msg_foreign')).toThrow('UNBOUND_SCOPED_OPERATION');
 const meter=h('6'),a=c.nativeGuard('openclaw',meter)({workId:first,sessionId:'native_first',deadlineUnixMs:Date.now()+10000},new AbortController().signal),b=c.nativeGuard('openclaw',meter)({workId:second,sessionId:'native_second',deadlineUnixMs:Date.now()+9000},new AbortController().signal);
 await Promise.all([a,b]);expect(seen.sort()).toEqual([first,second].sort());expect(c.ledger.snapshot().lastActive).toEqual(['openclaw','oc-private']);
 c.assertScopedTool('openclaw','envoi_case_snapshot',first);c.assertScopedTool('openclaw','envoi_case_snapshot',second);
 const attempt=await c.ledger.reserve('openclaw',nativeWorkToken(meter,c.ledger.window,'openclaw','native_first'));await c.ledger.markDispatched(attempt);await c.ledger.finish(attempt,'response');expect(c.ledger.snapshot().chargedAttempts).toBe(31);
 await expect(c.ledger.reserve('openclaw',nativeWorkToken(meter,c.ledger.window,'openclaw','unknown_session'))).rejects.toThrow('MODEL_REQUEST_CAP_REACHED');
});

it('rejects same-case or mixed-host cohorts and keeps exact human-decision/no-action policy for additional flows',async()=>{
 const s=await setup(),base=plan(s),sameCase=sign({...base,flowCases:{...base.flowCases,'oc-private':base.flowCases.openclaw}}),c=await adopt(s,sameCase,async b=>({...b}));
 expect(()=>c.releaseGroup(['openclaw','oc-private'])).toThrow('REVIEWED_DISTINCT_FLOW_GROUP_REQUIRED');expect(()=>c.releaseGroup(['green','oc-private'])).toThrow('REVIEWED_DISTINCT_FLOW_GROUP_REQUIRED');
 c.releaseGroup(['oc-decline']);const workId='msg_oc_decline';c.expectWork('oc-decline',workId,h('4'));
 expect(()=>claim(c,sameCase,'oc-decline','approved')).toThrow('CANONICAL_HUMAN_DECISION_REQUIRED');claim(c,sameCase,'oc-decline','declined');
 await c.nativeGuard('openclaw',h('5'))({workId,sessionId:'native_decline',deadlineUnixMs:Date.now()+10000},new AbortController().signal);
 const proofValue={workId,canonicalStatus:'processed' as const,journalCompleted:true as const,journalSha256:h('8'),nativeOutcome:'completed' as const};
 expect(()=>c.finishWork('oc-decline',proofValue)).toThrow('NO_ACTION_RESUMPTION_PROOF_REQUIRED');
 c.finishWork('oc-decline',{...proofValue,caseStillOpen:true,newCanonicalEffects:0,decisionOutcome:'declined'});expect(c.summary().finished).toEqual(['oc-decline']);
});
