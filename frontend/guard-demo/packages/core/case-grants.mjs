export const caseActionLabels = {
  message: 'send a message',
  file_open: 'open a file',
  file_edit: 'edit a file',
  share: 'share a file',
  external_send: 'send a deliverable outside the case',
  payment: 'make a payment',
  approval_request: 'request approval'
};

const levels = new Set(['allowed', 'ask_first', 'off']);
const fileActions = new Set(['file_open', 'file_edit', 'share', 'external_send']);

export function displayCasePolicy(policy) {
  const { caseRef, expiresAtMs, grants } = policy;
  if (!caseRef || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0 || !Array.isArray(grants)) {
    throw new TypeError('Invalid case policy');
  }
  const lines = [`Case ${caseRef}. Access expires ${new Date(expiresAtMs).toISOString()}.`];
  const unique = new Set();
  for (const { action, level, fileId, counterparty, parts } of grants) {
    if (!Object.hasOwn(caseActionLabels, action) || !levels.has(level) ||
      fileActions.has(action) !== (typeof fileId === 'string' && fileId.length > 0) ||
      typeof counterparty !== 'string' || !counterparty ||
      (parts !== undefined && (action !== 'file_edit' || !Array.isArray(parts) || !parts.length ||
        parts.some(part => !Number.isSafeInteger(part) || part <= 0) || new Set(parts).size !== parts.length))) {
      throw new TypeError('Invalid case grant');
    }
    const key = JSON.stringify([action, fileId, counterparty]);
    if (unique.has(key)) throw new TypeError('Duplicate case grant');
    unique.add(key);
    const access = { allowed: 'Allowed', ask_first: 'Ask first', off: 'Off' }[level];
    lines.push(`${access} to ${caseActionLabels[action]}${fileId ? ` (${fileId})` : ''} with ${counterparty}${parts ? ` for parts ${parts.join(', ')}` : ''}.`);
  }
  return lines;
}
