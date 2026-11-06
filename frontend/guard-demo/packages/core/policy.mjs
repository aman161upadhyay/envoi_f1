const scale = 10n ** 24n;

export function parseAmount(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,38})$/.test(value)) throw new TypeError('Invalid amount');
  const amount = BigInt(value);
  if (amount >= 2n ** 128n) throw new RangeError('Amount exceeds u128');
  return amount;
}

export function formatNear(value) {
  const amount = parseAmount(value);
  const fraction = String(amount % scale).padStart(24, '0').replace(/0+$/, '');
  return String(amount / scale) + (fraction ? '.' + fraction : '') + ' NEAR';
}

export function validAccount(value) {
  return typeof value === 'string' && value.length >= 2 && value.length <= 64 && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value);
}

export function displayPermission(document) {
  const { spend_money: spend, share_files: share, send_messages: send } = document.rules;
  if (spend.unit !== 'yoctoNEAR' || !Array.isArray(spend.payees) || !Array.isArray(share.allow)) throw new TypeError('Invalid rules');
  if (!['allowed', 'off'].includes(share.default) || !['allowed', 'ask_first', 'off'].includes(send)) throw new TypeError('Invalid rules');
  if (!share.allow.every(validAccount) || new Set(share.allow).size !== share.allow.length) throw new TypeError('Invalid file recipients');
  const cap = parseAmount(spend.dailyCap);
  const accounts = new Set();
  const lines = spend.payees.map(({ account, label, maxPerPayment }) => {
    const max = parseAmount(maxPerPayment);
    if (!validAccount(account) || accounts.has(account) || typeof label !== 'string' || !/^[\p{L}\p{N} .&'-]{1,64}$/u.test(label) || max === 0n || max > cap) {
      throw new TypeError('Invalid payee');
    }
    accounts.add(account);
    return `Milo can pay ${label} (${account}) up to ${formatNear(maxPerPayment)} per payment`;
  });
  lines.push(`Milo can spend up to ${formatNear(spend.dailyCap)} a day`);
  if (share.default === 'allowed') lines.push('Milo can share files with anyone');
  else if (share.allow.length) lines.push(`Milo can share files with ${share.allow.join(', ')}`);
  else lines.push("Milo can't share files with anyone");
  lines.push({ allowed: 'Milo can send messages', ask_first: 'Milo must ask before sending messages', off: "Milo can't send messages" }[send]);
  return lines;
}

export function refusalReason({ policy, to, amount, spent, balance }) {
  const value = parseAmount(amount);
  if (value === 0n) throw new RangeError('Payment must be positive');
  if (!policy) return 'not_registered';
  if (policy.paused) return 'paused';
  const payee = policy.payees.find(entry => entry.account === to);
  if (!payee) return 'not_payee';
  if (value > parseAmount(payee.maxPerPayment)) return 'over_max';
  if (value + spent > parseAmount(policy.dailyCap)) return 'over_daily_cap';
  if (value > balance) return 'vault_low';
  return null;
}
