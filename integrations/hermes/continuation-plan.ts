import {createHash} from 'node:crypto';

/** Finite physical-request allocation. This data grants no live execution or budget increase. */
export const DECLINE_CONTINUATION = Object.freeze([
  {id:'private-backlog',role:'je2',batched:2,sequential:3,contingency:1},
  {id:'green',role:'je1',batched:2,sequential:2,contingency:1},
  {id:'private-receipt-review',role:'je1',batched:1,sequential:1,contingency:1},
  {id:'accept-authority',role:'testowner',batched:2,sequential:2,contingency:1},
  {id:'approved-accept-complete',role:'testowner',batched:3,sequential:4,contingency:1},
  {id:'asset-share',role:'testowner',batched:2,sequential:3,contingency:1},
  {id:'asset-read-proposal',role:'je1',batched:3,sequential:3,contingency:1},
  {id:'asset-decline',role:'testowner',batched:2,sequential:2,contingency:1},
  {id:'declined-resume',role:'testowner',batched:1,sequential:1,contingency:1},
  {id:'openclaw',role:'openclaw',batched:2,sequential:3,contingency:1},
] as const);
export function continuationAllocation(mode:'sequential'|'bounded-contingency') {
  return DECLINE_CONTINUATION.map(f=>({id:f.id,role:f.role,requests:f.sequential+(mode==='bounded-contingency'?f.contingency:0),workHash:null}));
}
export function continuationRequirements() {
  const sum=(key:'batched'|'sequential'|'contingency')=>DECLINE_CONTINUATION.reduce((n,f)=>n+f[key],0);
  return Object.freeze({carriedActual:30,currentModelCap:48,remainingAtCurrentCap:18,
    nominalBatched:sum('batched'),sequential:sum('sequential'),contingency:sum('contingency'),
    sequentialTotalCap:30+sum('sequential'),boundedTotalCap:30+sum('sequential')+sum('contingency'),
    requestIncreaseForSequential:sum('sequential')-18,requestIncreaseForBounded:sum('sequential')+sum('contingency')-18,
    budgetApproved:false,executionAllowed:false});
}

export type ContinuationRole='je1'|'je2'|'testowner'|'openclaw';
export type ContinuationFlowPolicy=Readonly<{noAction:boolean;decisionOutcome:'approved'|'declined'|null;allowHumanEnd:boolean;expectedCaseState?:'inProgress'|'completed'}>;
export type ReviewedContinuationFlow=Readonly<{id:string;role:ContinuationRole;requests:number;workHash:string|null;policy:ContinuationFlowPolicy}>;
export type ReviewedContinuationPlan=Readonly<{purpose:'phase-c-reviewed-graph';version:1;ownerApprovalHash:string;planSha256:string;
  allowSameRoleCohorts:boolean;flows:readonly ReviewedContinuationFlow[];flowCases:Readonly<Record<string,string>>;actorIds:Readonly<Record<ContinuationRole,string>>}>;
export type ReviewedGraphApprovalSubject=Readonly<{planSha256:string;window:string;clientSource:string;serverSource:string;packetSha256:string}>;
export type ReviewedGraphApproval=ReviewedGraphApprovalSubject&Readonly<{purpose:'phase-c-reviewed-graph-source-approval';version:1;ownerApproved:true;approvalId:string}>;
const closed=(value:object,keys:string[])=>Object.keys(value).sort().join()===keys.sort().join();
const digest=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function refuse():never{throw Object.assign(new Error('Reviewed continuation plan is invalid'),{code:'REVIEWED_CONTINUATION_PLAN_INVALID'});}

/** Exact raw human decision binding, not chat authentication or native capability attestation.
 * The trusted execution owner must independently establish actual human provenance. */
export function validateReviewedGraphApproval(raw:unknown,subject:ReviewedGraphApprovalSubject){
  const fail=(code:string):never=>{throw Object.assign(new Error(code),{code});};
  if(typeof raw!=='string')return fail('EXPLICIT_GRAPH_SOURCE_APPROVAL_REQUIRED');
  if(Buffer.byteLength(raw,'utf8')>32768)fail('EXPLICIT_GRAPH_SOURCE_APPROVAL_REQUIRED');
  let value:ReviewedGraphApproval;
  try{value=JSON.parse(raw.replace(/^\uFEFF/,''));}catch{return fail('EXPLICIT_GRAPH_SOURCE_APPROVAL_REQUIRED');}
  if(!value||typeof value!=='object'||Array.isArray(value)||!closed(value,['purpose','version','ownerApproved','approvalId','planSha256','window','clientSource','serverSource','packetSha256'])
    ||value.purpose!=='phase-c-reviewed-graph-source-approval'||value.version!==1||value.ownerApproved!==true
    ||typeof value.approvalId!=='string'||!value.approvalId.trim()||value.approvalId.length>256||/[\x00-\x1f\x7f]/.test(value.approvalId)
    ||![value.planSha256,value.window,value.packetSha256].every(digest)||!/^[a-f0-9]{40}$/.test(value.clientSource)||!/^[a-f0-9]{40}$/.test(value.serverSource))fail('EXPLICIT_GRAPH_SOURCE_APPROVAL_REQUIRED');
  if(![subject.planSha256,subject.window,subject.packetSha256].every(digest)||!/^[a-f0-9]{40}$/.test(subject.clientSource)||!/^[a-f0-9]{40}$/.test(subject.serverSource)
    ||Object.entries(subject).some(([key,expected])=>value[key as keyof ReviewedGraphApprovalSubject]!==expected))fail('GRAPH_SOURCE_APPROVAL_SUBJECT_MISMATCH');
  return {decision:structuredClone(value),approvalHash:createHash('sha256').update(raw).digest('hex')};
}

/** The approved hash covers order, quotas, host roles, work pin and all flow policies. */
export function hashReviewedContinuationPlan(plan:Omit<ReviewedContinuationPlan,'planSha256'|'ownerApprovalHash'>):string {
  return createHash('sha256').update(JSON.stringify({purpose:plan.purpose,version:plan.version,allowSameRoleCohorts:plan.allowSameRoleCohorts,flows:plan.flows,
    flowCases:plan.flowCases,actorIds:plan.actorIds})).digest('hex');
}
export function validateReviewedContinuationPlan(value:unknown):ReviewedContinuationPlan {
  if(!value||typeof value!=='object'||Array.isArray(value))refuse();
  const p=value as ReviewedContinuationPlan;
  if(!closed(p,['purpose','version','ownerApprovalHash','planSha256','allowSameRoleCohorts','flows','flowCases','actorIds'])
    ||p.purpose!=='phase-c-reviewed-graph'||p.version!==1||!digest(p.ownerApprovalHash)||!digest(p.planSha256)
    ||typeof p.allowSameRoleCohorts!=='boolean'||!Array.isArray(p.flows)||!p.flows.length||p.flows.length>24)refuse();
  for(const f of p.flows){
    if(!f||typeof f!=='object'||Array.isArray(f)||!closed(f,['id','role','requests','workHash','policy'])
      ||typeof f.id!=='string'||!/^[a-z0-9-]{1,80}$/.test(f.id)||!['je1','je2','testowner','openclaw'].includes(f.role)
      ||!Number.isSafeInteger(f.requests)||f.requests<1||f.workHash!==null&&!digest(f.workHash)
      ||!f.policy||typeof f.policy!=='object'||Array.isArray(f.policy)||!closed(f.policy,['noAction','decisionOutcome','allowHumanEnd',...(Object.hasOwn(f.policy,'expectedCaseState')?['expectedCaseState']:[])])
      ||typeof f.policy.noAction!=='boolean'||typeof f.policy.allowHumanEnd!=='boolean'
      ||f.policy.decisionOutcome!==null&&!['approved','declined'].includes(f.policy.decisionOutcome)
      ||f.policy.noAction&&f.policy.allowHumanEnd
      ||Object.hasOwn(f.policy,'expectedCaseState')&&(!f.policy.noAction||!['inProgress','completed'].includes(f.policy.expectedCaseState!)
        ||f.policy.expectedCaseState==='completed'&&f.policy.decisionOutcome!==null))refuse();
  }
  if(!p.flowCases||typeof p.flowCases!=='object'||Array.isArray(p.flowCases)||!closed(p.flowCases,p.flows.map(f=>f.id))
    ||p.flows.some(f=>typeof p.flowCases[f.id]!=='string'||!/^case_[A-Za-z0-9_-]+$/.test(p.flowCases[f.id]))||new Set(Object.values(p.flowCases)).size>9
    ||!p.actorIds||typeof p.actorIds!=='object'||Array.isArray(p.actorIds)||!closed(p.actorIds,['je1','je2','testowner','openclaw'])
    ||Object.values(p.actorIds).some(id=>typeof id!=='string'||!/^agent_[A-Za-z0-9_-]+$/.test(id)))refuse();
  if(new Set(p.flows.map(f=>f.id)).size!==p.flows.length||hashReviewedContinuationPlan(p)!==p.planSha256)refuse();
  return structuredClone(p);
}
export function sameContinuationFlowPolicy(a:ContinuationFlowPolicy,b:ContinuationFlowPolicy){
  return a.noAction===b.noAction&&a.decisionOutcome===b.decisionOutcome&&a.allowHumanEnd===b.allowHumanEnd
    &&(a.expectedCaseState??'inProgress')===(b.expectedCaseState??'inProgress');
}
/** Existing flows keep their historical semantics even when quotas are amended. */
export function defaultContinuationFlowPolicy(id:string):ContinuationFlowPolicy {
  return {noAction:['declined-resume','private-receipt-review'].includes(id),
    decisionOutcome:id==='declined-resume'?'declined':id==='approved-accept-complete'?'approved':null,
    allowHumanEnd:['accept-authority','asset-decline'].includes(id)};
}
