import { createHash } from 'node:crypto';
import { RequestBudgetLedger, nativeWorkToken } from './request-budget';
import type { NativeSubmissionGuard } from './native-binding';

/** Bind a trusted canonical receipt, never a role's next arbitrary claim or model input.
 * The caller must construct this closure from its private reviewed work graph and
 * authenticated receipt. It performs no registration, claim, prompt or approval.
 */
export function bindNativeBudget(options: {
  ledger: RequestBudgetLedger; flowId:string; canonicalWorkId:string; canonicalReceiptSha256:string; meterToken:string;
}): NativeSubmissionGuard {
  const flow=options.ledger.flows.find(f=>f.id===options.flowId);
  const workHash=createHash('sha256').update(options.canonicalWorkId).digest('hex');
  if(!flow || flow.role==='openclaw' || !options.canonicalWorkId || !/^[a-f0-9]{64}$/.test(options.canonicalReceiptSha256)
    || flow.workHash!==null && flow.workHash!==workHash) throw Error('REVIEWED_CANONICAL_WORK_REQUIRED');
  return async(binding,signal)=>{
    signal.throwIfAborted();
    if(binding.workId!==options.canonicalWorkId || !Number.isSafeInteger(binding.deadlineUnixMs)
      || binding.deadlineUnixMs<=Date.now() || binding.deadlineUnixMs>Date.now()+120000) throw Error('REVIEWED_CANONICAL_WORK_REQUIRED');
    await options.ledger.bindWork(flow.id,{canonicalWorkHash:workHash,
      nativeToken:nativeWorkToken(options.meterToken,options.ledger.window,flow.role,binding.sessionId),evidenceHash:options.canonicalReceiptSha256});
    signal.throwIfAborted();
    await options.ledger.selectPhase('hermes',[flow.id],binding.deadlineUnixMs);
    signal.throwIfAborted();
  };
}

/** Model-attempt counts never masquerade as a current action inventory. */
export function cumulativeBudgetReport(ledger:RequestBudgetLedger, actionInventory:{
  conservativeMessages:number;canonicalEffects:number;cases:number;newInstallations:number;assets:number;inventorySha256:string;
}) {
  const a=actionInventory;
  if(!/^[a-f0-9]{64}$/.test(a.inventorySha256)
    || ![a.conservativeMessages,a.canonicalEffects,a.cases,a.newInstallations,a.assets].every(Number.isSafeInteger)
    || a.conservativeMessages<22 || a.conservativeMessages>60 || a.canonicalEffects<9 || a.canonicalEffects>a.conservativeMessages
    || a.cases<4 || a.cases>9 || a.newInstallations!==5 || a.assets<0 || a.assets>6) throw Error('CURRENT_ACTION_INVENTORY_REQUIRED');
  return Object.freeze({...ledger.snapshot(),currentActionInventory:structuredClone(a)});
}
