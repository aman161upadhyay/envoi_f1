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
