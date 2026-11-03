import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { afterEach,expect,it } from 'vitest';
import { ContinuationController,type ContinuationReceipt } from './continuation-controller';
import { DECLINE_CONTINUATION } from './continuation-plan';
import { nativeWorkToken } from './request-budget';

const h=(s:string)=>s.repeat(64),hash=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex');
const directories:string[]=[];
afterEach(async()=>{for(const dir of directories.splice(0)){const resolved=path.resolve(dir);if(!resolved.startsWith(path.resolve(tmpdir())+path.sep)||!path.basename(resolved).startsWith('envoi-continuation-controller-'))throw Error('CLEANUP_REFUSED');await fs.rm(resolved,{recursive:true,force:true});}});
async function setup(){
  const releaseRoot=await fs.mkdtemp(path.join(tmpdir(),'envoi-continuation-controller-'));directories.push(releaseRoot);
  const prior={actualCalls:30,actualHermesApiCalls:24,openClawProviderRequestsReserved:6,possibleHostMessageEffects:22,canonicalEffects:9,caseIds:['a','b','c','d'],newInstallationsUsed:5,priorUploadedAssets:0,stopped:true,failure:'LIVE_ASSERTION_FAILED',history:['retained']};
  const bytes=JSON.stringify(prior);await fs.writeFile(path.join(releaseRoot,'budget-7c522b08c11f.terminal-dd4debf.json'),bytes);
  const receipt:ContinuationReceipt={version:1,ownerApproved:true,approvalReceiptSha256:h('1'),packetSha256:h('2'),clientSource:h('a'),serverSource:h('b'),runnerSha256:h('c'),ciHead:h('a'),ciPassed:true,modelCap:64,startUtc:new Date(Date.now()-1000).toISOString(),hardStopUtc:new Date(Date.now()+60000).toISOString()};
  const preflight={checkedAtMs:Date.now(),allSelectedHostsStopped:true as const,activeLeases:0 as const,protectedCasePaused:true as const,originalDispositionMatches:true as const,actualHermesCalls:24 as const,actualOpenClawCalls:6 as const,conservativeMessages:22 as const,canonicalEffects:9 as const,cases:4 as const,newInstallations:5 as const,assets:0 as const};
  const expected={clientSource:h('a'),serverSource:h('b'),runnerSha256:h('c'),packetSha256:h('2'),priorLedgerSha256:hash(bytes)};
  const flowCases=Object.fromEntries(DECLINE_CONTINUATION.map(f=>[f.id,'case_'+f.id.replaceAll('-','_')]));
  const actorIds={je1:'agent_je1',je2:'agent_je2',testowner:'agent_testowner',openclaw:'agent_oc'};
  return {releaseRoot,receipt,preflight,expected,flowCases,actorIds};
}
function claim(flowId:string,role:'je1'|'je2'|'testowner',flowCases:Record<string,string>,outcome:'declined'|'approved'='declined'){
  const workId='msg_'+flowId.replaceAll('-','_'),at=new Date().toISOString();
  const message:Record<string,unknown>={id:workId,caseId:flowCases[flowId],recipientAgentId:'agent_'+role};
  if(flowId==='declined-resume')Object.assign(message,{kind:'humanDecision',type:'humanDecision',inboxId:'inbox_test',recipientInboxId:'inbox_test',senderType:'human',senderHumanId:'human_fixture',from:{humanId:'human_fixture'},counterpartyAgentId:'agent_other',counterpartyInboxId:'inbox_other',counterpartyAddress:'other@inert.example',requestId:'request_fixture',policyEvaluationId:'policy_eval_fixture',action:'proposal.accept',outcome,text:'Declined. Leave open.',status:'delivered',createdAt:at,deliveredAt:at,updatedAt:at});
  return {workId,message:message as {id:string;caseId:string;[key:string]:unknown}};
}
it('separates an exact pre-native control from graph admission and leaves all physical history untouched',async()=>{
  const s=await setup(),c=await ContinuationController.open(s),before=await fs.readFile(c.ledger.filename,'utf8');
  const work=claim('private-backlog','je2',s.flowCases),control={controlId:'pause-private',mode:'pause' as const,role:'je2' as const,caseId:work.message.caseId,workId:work.workId,evidenceSha256:h('4')};
  c.beginPreNativeControl(control);expect(c.modelActive()).toBe(false);
  c.observePreNativeControlClaim(control.controlId,'je2',work);
  expect(()=>c.observePreNativeControlClaim(control.controlId,'je2',{...work,message:{...work.message,recipientAgentId:'agent_other'}})).toThrow('CANONICAL_CONTROL_WORK_MISMATCH');
  expect(()=>c.releaseGroup(['private-backlog'])).toThrow('PRE_NATIVE_CONTROL_ACTIVE');
  await expect(c.nativeGuard('je2',h('6'))({workId:work.workId,sessionId:'native_forbidden',deadlineUnixMs:Date.now()+1000},new AbortController().signal)).rejects.toThrow('PRE_NATIVE_CONTROL_FORBIDS_NATIVE');
  c.endPreNativeControl(control.controlId);expect(await fs.readFile(c.ledger.filename,'utf8')).toBe(before);
  expect(c.summary().budget.chargedAttempts).toBe(30);expect(c.summary().released).toEqual([]);
  expect(()=>c.beginPreNativeControl(control)).toThrow('EXACT_PRE_NATIVE_CONTROL_REQUIRED');
  c.releaseGroup(['private-backlog']);
});
it('refuses unknown cases and controls while a native group or physical request is unresolved',async()=>{
  const s=await setup(),c=await ContinuationController.open(s),control={controlId:'expiry',mode:'expiry' as const,role:'je1' as const,caseId:s.flowCases.green,workId:'msg_control',evidenceSha256:h('4')};
  expect(()=>c.beginPreNativeControl({...control,caseId:'case_unknown'})).toThrow('EXACT_PRE_NATIVE_CONTROL_REQUIRED');
  c.releaseGroup(['green']);expect(()=>c.beginPreNativeControl(control)).toThrow('PRIOR_FLOW_NOT_RECONCILED');
});
it('refuses missing new approval, old source, stale guards and expired windows before any seed',async()=>{
  const s=await setup();
  for(const receipt of [{...s.receipt,ownerApproved:false},{...s.receipt,clientSource:h('f')},{...s.receipt,hardStopUtc:new Date(Date.now()-1).toISOString()}])await expect(ContinuationController.open({...s,receipt:receipt as ContinuationReceipt})).rejects.toThrow('FRESH_EXACT_CONTINUATION_APPROVAL_REQUIRED');
  await expect(ContinuationController.open({...s,preflight:{...s.preflight,checkedAtMs:Date.now()-300001}})).rejects.toThrow('FRESH_PRESERVED_PREFLIGHT_REQUIRED');
  await expect(fs.stat(path.join(s.releaseRoot,'phase-c-cumulative-requests.jsonl'))).rejects.toMatchObject({code:'ENOENT'});
});
it('opens only the canonical carried ledger and refuses an implicit new approval/window reset',async()=>{
  const s=await setup(),c=await ContinuationController.open(s);expect(c.ledger.snapshot()).toMatchObject({chargedAttempts:30,modelCap:64});
  const reopened=await ContinuationController.open(s);expect(reopened.ledger.filename).toBe(c.ledger.filename);
  await expect(ContinuationController.open({...s,receipt:{...s.receipt,approvalReceiptSha256:h('8')}})).rejects.toThrow('CANONICAL_CONTINUATION_RECONCILIATION_REQUIRED');
  const original=JSON.parse(await fs.readFile(path.join(s.releaseRoot,'budget-7c522b08c11f.terminal-dd4debf.json'),'utf8'));expect(original).toMatchObject({stopped:true,failure:'LIVE_ASSERTION_FAILED',actualCalls:30});
});
it('starts a distinct-role cohort only after both exact canonical/native bindings, within their original deadlines',async()=>{
  const s=await setup(),c=await ContinuationController.open(s);c.releaseGroup(['private-backlog','green']);
  const p=claim('private-backlog','je2',s.flowCases),g=claim('green','je1',s.flowCases);
  expect(()=>c.observeClaim('private-backlog','je2',p,JSON.stringify(p))).toThrow('CANONICAL_WORK_GRAPH_MISMATCH');
  c.expectWork('private-backlog',p.workId,h('4'));c.expectWork('green',g.workId,h('5'));
  c.observeClaim('private-backlog','je2',p,JSON.stringify(p));c.observeClaim('green','je1',g,JSON.stringify(g));
  const a=c.nativeGuard('je2',h('6'))({workId:p.workId,sessionId:'native_private',deadlineUnixMs:Date.now()+10000},new AbortController().signal);
  await expect(c.ledger.reserve('je2',h('9'))).rejects.toThrow('NATIVE_DEADLINE_EXPIRED');
  const b=c.nativeGuard('je1',h('7'))({workId:g.workId,sessionId:'native_green',deadlineUnixMs:Date.now()+9000},new AbortController().signal);
  await Promise.all([a,b]);expect(c.ledger.snapshot().lastActive).toEqual(['private-backlog','green']);
  const id=await c.ledger.reserve('je2',nativeWorkToken(h('6'),c.ledger.window,'je2','native_private'));await c.ledger.finish(id,'response');
  expect(()=>c.releaseGroup(['asset-share'])).toThrow('PRIOR_FLOW_NOT_RECONCILED');
  for(const [flowId,workId] of [['private-backlog',p.workId],['green',g.workId]])c.finishWork(flowId,{workId,canonicalStatus:'processed',journalCompleted:true,journalSha256:h('8'),nativeOutcome:'completed'});
  c.releaseGroup(['asset-share']);expect(c.ledger.snapshot().chargedAttempts).toBe(31);
});
it('requires a real declined decision work binding and native settlement, not an approved lookalike or server-only assertion',async()=>{
  const s=await setup(),c=await ContinuationController.open(s);c.releaseGroup(['declined-resume']);const w=claim('declined-resume','testowner',s.flowCases);
  c.expectWork('declined-resume',w.workId,h('4'));
  expect(()=>c.observeClaim('declined-resume','testowner',claim('declined-resume','testowner',s.flowCases,'approved'),'inert')).toThrow('CANONICAL_HUMAN_DECISION_REQUIRED');
  c.observeClaim('declined-resume','testowner',w,JSON.stringify(w));
  await c.nativeGuard('testowner',h('6'))({workId:w.workId,sessionId:'native_declined',deadlineUnixMs:Date.now()+10000},new AbortController().signal);
  const id=await c.ledger.reserve('testowner',nativeWorkToken(h('6'),c.ledger.window,'testowner','native_declined'));await c.ledger.finish(id,'response');
  const proof={workId:w.workId,canonicalStatus:'processed' as const,journalCompleted:true as const,journalSha256:h('8'),nativeOutcome:'completed' as const};
  expect(()=>c.finishWork('declined-resume',proof)).toThrow('NO_ACTION_RESUMPTION_PROOF_REQUIRED');
  c.finishWork('declined-resume',{...proof,caseStillOpen:true,newCanonicalEffects:0,decisionOutcome:'declined'});
  expect(c.summary().finished).toEqual(['declined-resume']);expect(c.summary().budget.chargedAttempts).toBe(31);
});
it('stops before any unexpected write in a declined-resume admission',async()=>{
  const s=await setup(),c=await ContinuationController.open(s);c.releaseGroup(['declined-resume']);const w=claim('declined-resume','testowner',s.flowCases);
  c.expectWork('declined-resume',w.workId,h('4'));c.observeClaim('declined-resume','testowner',w,JSON.stringify(w));
  await c.nativeGuard('testowner',h('6'))({workId:w.workId,sessionId:'native_declined',deadlineUnixMs:Date.now()+10000},new AbortController().signal);
  c.assertScopedTool('testowner','envoi_case_snapshot');expect(()=>c.assertScopedTool('testowner','envoi_case_decide')).toThrow('UNEXPECTED_NO_ACTION_FLOW_WRITE');
  expect(c.active()).toBe(false);expect(c.ledger.snapshot().chargedAttempts).toBe(30);
});
