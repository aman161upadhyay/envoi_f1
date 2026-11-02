import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {ContinuationController,type ContinuationReceipt,type SameRoleNativeAttributionGuard} from './continuation-controller';
import {RequestBudgetLedger,nativeWorkToken} from './request-budget';
import {DECLINE_CONTINUATION,continuationAllocation,defaultContinuationFlowPolicy,hashReviewedContinuationPlan,validateReviewedContinuationPlan,validateReviewedGraphApproval,type ReviewedContinuationPlan,type ReviewedContinuationFlow} from './continuation-plan';

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
 return approved(s,{...payload,ownerApprovalHash:h('9'),planSha256:hashReviewedContinuationPlan(payload)});
}
function sign(p:ReviewedContinuationPlan):ReviewedContinuationPlan{return {...p,planSha256:hashReviewedContinuationPlan(p)};}
function approvalRaw(s:Awaited<ReturnType<typeof setup>>,p:ReviewedContinuationPlan,change:Record<string,unknown>={}){
 return JSON.stringify({purpose:'phase-c-reviewed-graph-source-approval',version:1,ownerApproved:true,approvalId:'inert-graph-'+p.planSha256,planSha256:p.planSha256,
  window:s.c.ledger.window,clientSource:s.receipt.clientSource,serverSource:s.receipt.serverSource,packetSha256:s.receipt.packetSha256,...change});
}
function approved(s:Awaited<ReturnType<typeof setup>>,p:ReviewedContinuationPlan){const signed=sign(p);return{...signed,ownerApprovalHash:hash(approvalRaw(s,signed))};}
const proof=(s:Awaited<ReturnType<typeof setup>>,p:ReviewedContinuationPlan,ledger=s.c.ledger)=>({expectedWindow:ledger.window,allHostsStopped:true,canonicalLeasesZero:true,previousNativeTerminal:true,chargedAttempts:ledger.snapshot().chargedAttempts,
 graphApprovalRaw:approvalRaw(s,p),clientSource:s.receipt.clientSource,serverSource:s.receipt.serverSource,packetSha256:s.receipt.packetSha256});
async function adopt(s:Awaited<ReturnType<typeof setup>>,p=plan(s),guard?:SameRoleNativeAttributionGuard){
 p=approved(s,p);await s.c.ledger.amendReviewedPlan(p,proof(s,p));
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
 await s.c.ledger.amendReviewedPlan(p,proof(s,p));const after=await fs.readFile(s.filename);expect(after.subarray(0,before.length)).toEqual(before);expect(await fs.readFile(path.join(s.releaseRoot,'phase-c-request-ledger.anchor'))).toEqual(anchor);
 expect(s.c.ledger.snapshot()).toMatchObject({chargedAttempts:30,modelCap:64,remainingModelAttempts:34,carriedMessageReservations:22,carriedNewInstallations:5});
 const reopened=await RequestBudgetLedger.open(s.filename);expect(reopened.reviewedPlan).toEqual(p);expect(reopened.flows).toHaveLength(15);expect(reopened.flows.reduce((n,f)=>n+f.requests,0)).toBe(34);
 await expect(ContinuationController.open(s)).rejects.toThrow('CANONICAL_CONTINUATION_RECONCILIATION_REQUIRED');
 const c=await ContinuationController.open({...s,flowCases:p.flowCases,reviewedPlan:p});controllers.push(c);expect(c.flowPolicy('oc-decline')).toEqual({noAction:true,decisionOutcome:'declined',allowHumanEnd:false});
 await reopened.amendReviewedPlan(p,proof(s,p,reopened));expect(await fs.readFile(s.filename)).toEqual(after);
});

it('hashes exact roles/quotas/cases/recipients/policy and rejects malformed, extra-key or unapproved graph metadata before writing',async()=>{
 const s=await setup(),p=plan(s),before=await fs.readFile(s.filename);
 for(const bad of [{...p,ownerApprovalHash:''},{...p,planSha256:h('0')},{...p,extra:true},
  {...p,flowCases:{...p.flowCases,openclaw:'case_other'}},{...p,actorIds:{...p.actorIds,openclaw:'agent_other'}},
  sign({...p,flows:p.flows.map((f,i)=>i?f:{...f,policy:{...f.policy,noAction:'yes' as unknown as boolean}})})]){
  expect(()=>validateReviewedContinuationPlan(bad)).toThrow();await expect(s.c.ledger.amendReviewedPlan(bad as ReviewedContinuationPlan,proof(s,p))).rejects.toThrow();
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
 for(const bad of variants)await expect(s.c.ledger.amendReviewedPlan(bad,proof(s,p))).rejects.toThrow();
 for(const bad of [{...proof(s,p),allHostsStopped:false},{...proof(s,p),canonicalLeasesZero:false},{...proof(s,p),previousNativeTerminal:false},{...proof(s,p),expectedWindow:h('0')},{...proof(s,p),chargedAttempts:29}])await expect(s.c.ledger.amendReviewedPlan(p,bad)).rejects.toThrow('REVIEWED_GRAPH_RECONCILIATION_REQUIRED');
 expect(await fs.readFile(s.filename)).toEqual(before);
 await s.c.ledger.bindWork('private-backlog',{canonicalWorkHash:h('3'),nativeToken:h('4'),evidenceHash:h('5')});await s.c.ledger.selectPhase('hermes',['private-backlog'],Date.now()+10000);await s.c.ledger.reserve('je2',h('4'));
 await expect(s.c.ledger.amendReviewedPlan(p,proof(s,p))).rejects.toThrow('FIRST_REVIEWED_GRAPH_REQUIRES_UNUSED_NATIVE_HISTORY');expect(s.c.ledger.snapshot()).toMatchObject({chargedAttempts:31,pending:1});
});

it('never refunds completed calls, reduces below charged quota, resets native deadlines, rebinds old work or reuses a plan approval',async()=>{
 const s=await setup(),p=plan(s);await s.c.ledger.amendReviewedPlan(p,proof(s,p));await s.c.ledger.bindWork('private-backlog',{canonicalWorkHash:h('3'),nativeToken:h('4'),evidenceHash:h('5')});await s.c.ledger.selectPhase('hermes',['private-backlog'],Date.now()+10000);
 for(let n=0;n<3;n++){const a=await s.c.ledger.reserve('je2',h('4'));await s.c.ledger.markDispatched(a);await s.c.ledger.finish(a,'response');}
 const reduced=approved(s,{...p,flows:p.flows.map(f=>f.id==='private-backlog'?{...f,requests:2}:f)});
 await expect(s.c.ledger.amendReviewedPlan(reduced,proof(s,reduced))).rejects.toThrow('REVIEWED_GRAPH_HISTORY_CHANGED');
 await s.c.ledger.amendReviewedPlan(p,proof(s,p));expect((await RequestBudgetLedger.open(s.filename)).snapshot()).toMatchObject({chargedAttempts:33,remainingModelAttempts:31});
 await expect(s.c.ledger.selectPhase('hermes',['private-backlog'],Date.now()+11000)).rejects.toThrow('NATIVE_DEADLINE_CANNOT_RESET');
 await expect(s.c.ledger.bindWork('private-backlog',{canonicalWorkHash:h('6'),nativeToken:h('7'),evidenceHash:h('8')})).rejects.toThrow('CANONICAL_WORK_BINDING_CHANGED');
 await expect(s.c.ledger.amendReviewedPlan(sign({...p,allowSameRoleCohorts:false}),proof(s,p))).rejects.toThrow('GRAPH_SOURCE_APPROVAL_SUBJECT_MISMATCH');
 const newApproval=approved(s,{...p,flowCases:{...p.flowCases,'private-backlog':'case_drift'}});
 await expect(s.c.ledger.amendReviewedPlan(newApproval,proof(s,newApproval))).rejects.toThrow('REVIEWED_GRAPH_HISTORY_CHANGED');
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

it('closes one completed native provider fence while the other cohort work still has a physical request pending',async()=>{
 const s=await setup(),p=plan(s),c=await adopt(s,p,async binding=>({...binding}));
 c.releaseGroup(['openclaw','oc-private']);const first=claim(c,p,'openclaw'),second=claim(c,p,'oc-private'),meter=h('6');
 await Promise.all([c.nativeGuard('openclaw',meter)({workId:first,sessionId:'native_first',deadlineUnixMs:Date.now()+10000},new AbortController().signal),
  c.nativeGuard('openclaw',meter)({workId:second,sessionId:'native_second',deadlineUnixMs:Date.now()+10000},new AbortController().signal)]);
 const firstToken=nativeWorkToken(meter,c.ledger.window,'openclaw','native_first'),secondToken=nativeWorkToken(meter,c.ledger.window,'openclaw','native_second');
 const a=await c.ledger.reserve('openclaw',firstToken);await c.ledger.markDispatched(a);await c.ledger.finish(a,'response');
 const b=await c.ledger.reserve('openclaw',secondToken);await c.ledger.markDispatched(b);
 expect(c.ledger.snapshot()).toMatchObject({chargedAttempts:32,pending:1});expect(c.allowMeterWork('openclaw',firstToken)).toBe(true);expect(c.allowMeterWork('openclaw',secondToken)).toBe(true);
 const completedA={workId:first,journalCompleted:true as const,journalSha256:h('8')};
 c.closeNativeForwarding('openclaw',completedA);c.closeNativeForwarding('openclaw',completedA);
 expect(c.allowMeterWork('openclaw',firstToken)).toBe(false);expect(c.allowMeterWork('openclaw',secondToken)).toBe(true);expect(c.modelActive()).toBe(true);expect(c.summary().finished).toEqual([]);
 const proofA={...completedA,canonicalStatus:'processed' as const,nativeOutcome:'completed' as const};
 expect(()=>c.finishWork('openclaw',proofA)).toThrow('ACTUAL_NATIVE_SETTLEMENT_PROOF_REQUIRED');
 for(const [id,proof] of [['oc-private',completedA],['unknown-flow',completedA],['openclaw',{...completedA,journalSha256:'unknown'}],['openclaw',{...completedA,journalSha256:h('7')}]] as const){
  expect(()=>c.closeNativeForwarding(id,proof)).toThrow('ACTUAL_NATIVE_COMPLETION_FENCE_PROOF_REQUIRED');
 }
 expect(c.allowMeterWork('openclaw',secondToken)).toBe(true);expect(c.ledger.snapshot()).toMatchObject({chargedAttempts:32,pending:1});
 await c.ledger.finish(b,'response');c.finishWork('openclaw',proofA);
 c.finishWork('oc-private',{workId:second,journalCompleted:true,journalSha256:h('9'),canonicalStatus:'processed',nativeOutcome:'completed'});
 expect(c.summary().finished).toEqual(['openclaw','oc-private']);expect(c.modelActive()).toBe(false);expect(c.allowMeterWork('openclaw',secondToken)).toBe(false);expect(c.ledger.snapshot()).toMatchObject({chargedAttempts:32,pending:0});
});

it('does not turn a closed native fence into canonical processing after the controller was stopped',async()=>{
 const s=await setup(),p=plan(s),c=await adopt(s,p,async binding=>({...binding}));c.releaseGroup(['openclaw']);const workId=claim(c,p,'openclaw');
 await c.nativeGuard('openclaw',h('6'))({workId,sessionId:'native_closed',deadlineUnixMs:Date.now()+10000},new AbortController().signal);
 const proof={workId,journalCompleted:true as const,journalSha256:h('8'),canonicalStatus:'processed' as const,nativeOutcome:'completed' as const};c.closeNativeForwarding('openclaw',proof);c.stop('INERT_REVOKED_CONTROL');
 expect(()=>c.finishWork('openclaw',proof)).toThrow('CONTINUATION_WINDOW_CLOSED');expect(c.summary().finished).toEqual([]);expect(c.allowMeterWork('openclaw',nativeWorkToken(h('6'),c.ledger.window,'openclaw','native_closed'))).toBe(false);expect(c.ledger.snapshot().chargedAttempts).toBe(30);
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

it('requires explicit reviewed completed-state no-action proof for an ordinary receipt without claiming the case is open',async()=>{
 const s=await setup(),base=plan(s);
 const flow:ReviewedContinuationFlow={id:'oc-completed-review',role:'openclaw',requests:1,workHash:null,policy:{noAction:true,decisionOutcome:null,allowHumanEnd:false,expectedCaseState:'completed'}};
 const p=sign({...base,flows:[...base.flows.map(f=>f.id==='approved-accept-complete'?{...f,requests:f.requests-1}:f),flow],flowCases:{...base.flowCases,[flow.id]:'case_assets'}});
 expect(validateReviewedContinuationPlan(p).flows.at(-1)?.policy.expectedCaseState).toBe('completed');
 const changedHash=hashReviewedContinuationPlan({...p,flows:p.flows.map(f=>f.id===flow.id?{...f,policy:{...f.policy,expectedCaseState:'inProgress'}}:f)});expect(changedHash).not.toBe(p.planSha256);
 const c=await adopt(s,p,async b=>({...b}));c.releaseGroup([flow.id]);const workId=claim(c,p,flow.id);
 await c.nativeGuard('openclaw',h('6'))({workId,sessionId:'native_completed_receipt',deadlineUnixMs:Date.now()+10000},new AbortController().signal);
 const proofValue={workId,canonicalStatus:'processed' as const,journalCompleted:true as const,journalSha256:h('8'),nativeOutcome:'completed' as const,newCanonicalEffects:0 as const};
 for(const bad of [{...proofValue,caseState:'inProgress' as const},{...proofValue,caseStillOpen:true as const},{...proofValue,caseState:'completed' as const,caseStillOpen:true as const}])expect(()=>c.finishWork(flow.id,bad)).toThrow('NO_ACTION_RESUMPTION_PROOF_REQUIRED');
 c.finishWork(flow.id,{...proofValue,caseState:'completed'});expect(c.summary().finished).toEqual([flow.id]);expect(c.ledger.snapshot().chargedAttempts).toBe(30);
});

it('keeps historical open no-action policies and refuses completed decline or a later state-policy broadening',async()=>{
 const s=await setup(),p=plan(s);
 expect(defaultContinuationFlowPolicy('declined-resume')).toEqual({noAction:true,decisionOutcome:'declined',allowHumanEnd:false});
 for(const bad of [sign({...p,flows:p.flows.map(f=>f.id==='oc-decline'?{...f,policy:{...f.policy,expectedCaseState:'completed'}}:f)}),
  sign({...p,flows:p.flows.map(f=>f.id==='green'?{...f,policy:{...f.policy,expectedCaseState:'completed'}}:f)})])expect(()=>validateReviewedContinuationPlan(bad)).toThrow();
 const c=await adopt(s,p,async b=>({...b}));c.releaseGroup(['declined-resume']);const workId=claim(c,p,'declined-resume');
 await c.nativeGuard('testowner',h('6'))({workId,sessionId:'native_legacy_open',deadlineUnixMs:Date.now()+10000},new AbortController().signal);
 const proofValue={workId,canonicalStatus:'processed' as const,journalCompleted:true as const,journalSha256:h('8'),nativeOutcome:'completed' as const,newCanonicalEffects:0 as const,decisionOutcome:'declined' as const};
 expect(()=>c.finishWork('declined-resume',{...proofValue,caseState:'completed',caseStillOpen:true})).toThrow('NO_ACTION_RESUMPTION_PROOF_REQUIRED');
 c.finishWork('declined-resume',{...proofValue,caseStillOpen:true});expect(c.summary().finished).toEqual(['declined-resume']);
 const broaden=approved(s,{...p,flows:p.flows.map(f=>f.id==='private-receipt-review'?{...f,policy:{...f.policy,expectedCaseState:'completed'}}:f)});
 await expect(c.ledger.amendReviewedPlan(broaden,proof(s,broaden,c.ledger))).rejects.toThrow('REVIEWED_GRAPH_HISTORY_CHANGED');
});

it('refuses the first graph over any legacy native binding or completed charged history before writing and on replay',async()=>{
 for(const charged of [false,true]){
  const s=await setup();await s.c.ledger.bindWork('private-backlog',{canonicalWorkHash:h('3'),nativeToken:h('4'),evidenceHash:h('5')});
  if(charged){await s.c.ledger.selectPhase('hermes',['private-backlog'],Date.now()+10000);const a=await s.c.ledger.reserve('je2',h('4'));await s.c.ledger.markDispatched(a);await s.c.ledger.finish(a,'response');}
  const before=await fs.readFile(s.filename),anchor=await fs.readFile(path.join(s.releaseRoot,'phase-c-request-ledger.anchor')),base=plan(s);
  const relabeled=approved(s,{...base,flowCases:{...base.flowCases,'private-backlog':'case_relabel'},actorIds:{...base.actorIds,je2:'agent_relabel'}}),p=proof(s,relabeled);
  await expect(s.c.ledger.amendReviewedPlan(relabeled,p)).rejects.toThrow('FIRST_REVIEWED_GRAPH_REQUIRES_UNUSED_NATIVE_HISTORY');
  expect(await fs.readFile(s.filename)).toEqual(before);expect(await fs.readFile(path.join(s.releaseRoot,'phase-c-request-ledger.anchor'))).toEqual(anchor);
  expect((await RequestBudgetLedger.open(s.filename)).snapshot().chargedAttempts).toBe(charged?31:30);
  // Simulate an old writer trying to append an otherwise valid, chained approval.
  const last=before.toString('utf8').trimEnd().split('\n').at(-1)!;
  await fs.appendFile(s.filename,JSON.stringify({previous:hash(last+'\n'),kind:'plan',window:s.c.ledger.window,plan:relabeled,proof:p,approvalHash:relabeled.ownerApprovalHash})+'\n');
  await expect(RequestBudgetLedger.open(s.filename)).rejects.toThrow('FIRST_REVIEWED_GRAPH_REQUIRES_UNUSED_NATIVE_HISTORY');
 }
});

it('persists an exact raw new graph/source decision and opens the actual controller without changing seed, counters or clock',async()=>{
 const s=await setup(),base=plan(s),raw=approvalRaw(s,base)+'\n',p={...base,ownerApprovalHash:hash(raw)},decision=validateReviewedGraphApproval(raw,{planSha256:p.planSha256,window:s.c.ledger.window,clientSource:s.receipt.clientSource,serverSource:s.receipt.serverSource,packetSha256:s.receipt.packetSha256});
 expect(decision.approvalHash).toBe(p.ownerApprovalHash);const seed=await fs.readFile(path.join(s.releaseRoot,'budget-7c522b08c11f.terminal-dd4debf.json'));
 await s.c.ledger.amendReviewedPlan(p,{...proof(s,p),graphApprovalRaw:raw});const reopened=await RequestBudgetLedger.open(s.filename);
 expect(reopened.reviewedGraphApprovalRaw).toBe(raw);expect(reopened.snapshot()).toMatchObject({chargedAttempts:30,modelCap:64,remainingModelAttempts:34,carriedMessageReservations:22,carriedNewInstallations:5});
 const c=await ContinuationController.open({...s,flowCases:p.flowCases,reviewedPlan:p});controllers.push(c);expect(c.receipt).toEqual(s.receipt);expect(c.modelActive()).toBe(false);expect(await fs.readFile(path.join(s.releaseRoot,'budget-7c522b08c11f.terminal-dd4debf.json'))).toEqual(seed);
 const row=JSON.parse((await fs.readFile(s.filename,'utf8')).trimEnd().split('\n').at(-1)!);expect(row.approvalHash).toBe(hash(raw));expect(row.proof.graphApprovalRaw).toBe(raw);
 // Harmless-looking raw-byte formatting drift still changes the approval hash.
 row.proof.graphApprovalRaw+=' ';const lines=(await fs.readFile(s.filename,'utf8')).trimEnd().split('\n');lines[lines.length-1]=JSON.stringify(row);await fs.writeFile(s.filename,lines.join('\n')+'\n');
 await expect(RequestBudgetLedger.open(s.filename)).rejects.toThrow('GRAPH_SOURCE_APPROVAL_HASH_MISMATCH');
});

it('rejects changed graph/window/source/purpose and old cap or time decisions before any plan append',async()=>{
 const s=await setup(),p=plan(s),before=await fs.readFile(s.filename);
 const variants=[approvalRaw(s,p,{planSha256:h('0')}),approvalRaw(s,p,{window:h('0')}),approvalRaw(s,p,{clientSource:'e'.repeat(40)}),approvalRaw(s,p,{serverSource:'e'.repeat(40)}),approvalRaw(s,p,{packetSha256:h('0')}),
  approvalRaw(s,p,{purpose:'phase-c-additional-interval'}),approvalRaw(s,p,{ownerApproved:false}),approvalRaw(s,p,{version:2}),
  JSON.stringify({purpose:'phase-c-decline-continuation',models:64,approvalReceiptSha256:s.receipt.approvalReceiptSha256}),JSON.stringify(s.receipt)];
 for(const raw of variants){const candidate={...p,ownerApprovalHash:hash(raw)};await expect(s.c.ledger.amendReviewedPlan(candidate,{...proof(s,p),graphApprovalRaw:raw})).rejects.toThrow();expect(await fs.readFile(s.filename)).toEqual(before);}
 await expect(s.c.ledger.amendReviewedPlan({...p,ownerApprovalHash:h('0')},proof(s,p))).rejects.toThrow('GRAPH_SOURCE_APPROVAL_HASH_MISMATCH');expect(await fs.readFile(s.filename)).toEqual(before);
});

it('compares a self-labelled ledger graph decision with actual controller receipt source and packet pins',async()=>{
 for(const [key,value]of [['clientSource','e'.repeat(40)],['serverSource','f'.repeat(40)],['packetSha256',h('0')]] as const){
  const s=await setup(),base=plan(s),raw=approvalRaw(s,base,{[key]:value}),p={...base,ownerApprovalHash:hash(raw)};
  // A ledger can record a decision without knowing the execution receipt; opening
  // the controller must independently compare its actual immutable source pins.
  await s.c.ledger.amendReviewedPlan(p,{...proof(s,p),[key]:value,graphApprovalRaw:raw});
  const reopened=await RequestBudgetLedger.open(s.filename);expect(reopened.reviewedGraphApprovalRaw).toBe(raw);
  await expect(ContinuationController.open({...s,flowCases:p.flowCases,reviewedPlan:p})).rejects.toThrow('GRAPH_SOURCE_APPROVAL_SUBJECT_MISMATCH');expect(reopened.snapshot().chargedAttempts).toBe(30);
 }
});
