import { formatNear, parseAmount } from './policy.mjs';
import { caseActionLabels } from './case-grants.mjs';

// The caller supplies the verified owner document and server-observed targets and spend.
export function evaluateCaseAction(document, request, { now, spent } = {}) {
  const { agent, caseRef, action, fileId, counterparty, changedParts, amount } = request;
  const result = (decision, rule, reason) => ({ decision, rule, reason, policyVersion: document.version });
  const deny = (rule, reason) => result('deny', rule, reason);
  const policy = document.casePolicy;
  if (agent !== document.agent || !policy || caseRef !== policy.caseRef ||
    !Number.isSafeInteger(now) || now >= policy.expiresAtMs) {
    return deny('case_scope', 'This agent has no current grant for this case.');
  }
  const grant = policy.grants.find(entry => entry.action === action && entry.fileId === fileId && entry.counterparty === counterparty);
  if (!grant || grant.level === 'off') {
    const label = Object.hasOwn(caseActionLabels, action) ? caseActionLabels[action] : 'perform this action';
    return deny('action_scope', `The case grant does not allow the agent to ${label}${fileId ? ` (${fileId})` : ''} with this counterparty.`);
  }
  if (grant.parts && (!Array.isArray(changedParts) || changedParts.some(part => !grant.parts.includes(part)))) {
    return deny('edit_scope', `Edits are limited to parts ${grant.parts.join(', ')}.`);
  }
  const messageRule = action === 'message' ? document.rules.send_messages : null;
  if (messageRule === 'off') return deny('messages_off', 'The signed policy turns off outgoing messages.');
  if (action === 'share') {
    const sharing = document.rules.share_files;
    if (sharing.default !== 'allowed' && !sharing.allow.includes(counterparty)) {
      return deny('file_sharing_off', 'The signed policy turns off file sharing for this counterparty.');
    }
  }
  let allowedReason = `The signed case grant allows the agent to ${caseActionLabels[action]}${fileId ? ` (${fileId})` : ''}.`;
  if (action === 'payment') {
    const spending = document.rules.spend_money;
    const payee = spending.payees.find(entry => entry.account === counterparty);
    if (!payee) return deny('payee', 'This counterparty is outside the signed payee list.');
    try {
      const value = parseAmount(amount);
      if (value <= 0n || typeof spent !== 'bigint' || spent < 0n) throw new TypeError('Invalid spend');
      if (value > parseAmount(payee.maxPerPayment)) return deny('payment_limit', 'The amount exceeds the per-payment limit.');
      if (value + spent > parseAmount(spending.dailyCap)) return deny('daily_limit', 'The payment would exceed the daily limit.');
    } catch {
      return deny('payment_input', 'The amount or current daily spend could not be verified.');
    }
    allowedReason = `${payee.label} is an approved payee, with a limit of ${formatNear(payee.maxPerPayment)} per payment.`;
  }
  if (grant.level === 'ask_first' || messageRule === 'ask_first') {
    return result('ask_owner', 'owner_approval', 'The signed policy requires the owner to approve.');
  }
  if (grant.level !== 'allowed') return deny('action_scope', 'This action is outside the case grant.');
  return result('allow', 'case_grant', allowedReason);
}
