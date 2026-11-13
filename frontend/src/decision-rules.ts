import { humanize } from './model';
import type { Asset, ParticipantIdentity } from './types';

// Plain-words descriptions of what an agent tried to do and which rule decided it.
// Pure functions over the shapes the server returns; nothing here decides anything.

type Directory = Record<string, ParticipantIdentity> | ParticipantIdentity[] | undefined;
export type SpendScopeLabels = { payees?: Array<{ label: string; account: string }> } | null | undefined;

// Known payee accounts and their labels. The spend scope supplies these when the server exposes it;
// the dev preview registers its own. A payee is an account, so the agent directory is never used for it.
let knownPayeeLabels: Record<string, string> = {};
export function setPayeeLabels(labels: Record<string, string>) { knownPayeeLabels = { ...labels }; }

function payeeName(account: unknown, scope?: SpendScopeLabels): string | null {
  if (typeof account !== 'string' || !account) return null;
  return scope?.payees?.find(payee => payee.account === account)?.label || knownPayeeLabels[account] || account;
}

export function sourceLabel(value: string | null | undefined, fallback = 'Source not stated'): string {
  if (!value) return fallback;
  if (value === 'offline-replay') return 'Offline replay';
  if (value.startsWith('near-testnet')) return 'NEAR testnet';
  return fallback;
}

const YOCTO_PER_NEAR = 10n ** 24n;

export function formatNear(units: unknown): string | null {
  let value: bigint;
  try { value = BigInt(String(units)); } catch { return null; }
  if (value < 0n) return null;
  const whole = value / YOCTO_PER_NEAR;
  const thousandths = ((value % YOCTO_PER_NEAR) * 1000n) / YOCTO_PER_NEAR;
  const fraction = thousandths.toString().padStart(3, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''} NEAR`;
}

function nameFor(id: unknown, directory: Directory, scope?: SpendScopeLabels): string | null {
  if (typeof id !== 'string' || !id) return null;
  const entries = Array.isArray(directory) ? directory : Object.entries(directory || {}).map(([key, value]) => ({ ...value, id: value.id || key }));
  const listed = entries.find(item => item.id === id || (item.address && item.address === id));
  return listed?.displayName || scope?.payees?.find(payee => payee.account === id)?.label || id;
}

export function slideList(parts: unknown): string | null {
  if (!Array.isArray(parts)) return null;
  const numbers = [...new Set(parts.filter((part): part is number => Number.isInteger(part)))].sort((a, b) => a - b);
  if (!numbers.length) return null;
  const ranges: string[] = [];
  for (let index = 0; index < numbers.length;) {
    let end = index;
    while (end + 1 < numbers.length && numbers[end + 1] === numbers[end] + 1) end += 1;
    ranges.push(end > index ? `${numbers[index]}–${numbers[end]}` : String(numbers[index]));
    index = end + 1;
  }
  return `${numbers.length > 1 ? 'slides' : 'slide'} ${ranges.join(', ')}`;
}

export function describeAction(action: string, target: Record<string, unknown> | null | undefined, assets: Asset[] = [], directory?: Directory, scope?: SpendScopeLabels): string {
  const details = target || {};
  const file = (() => {
    const asset = assets.find(item => item.id === details.assetId);
    return asset?.filename || asset?.name || (typeof details.assetId === 'string' ? details.assetId : 'a file');
  })();
  const recipient = nameFor(details.recipientAgentId ?? details.recipient, directory, scope);
  if (action === 'payment.near') {
    const money = formatNear((details.amount as { units?: unknown } | undefined)?.units);
    const payee = payeeName(details.payee, scope);
    return `Pay ${money ?? 'an amount'}${payee ? ` to ${payee}` : ''}`;
  }
  if (action === 'asset.share') return `Share ${file}${recipient ? ` with ${recipient}` : ''}`;
  if (action === 'asset.edit') {
    const parts = slideList(details.parts);
    return `Edit ${parts ? `${parts} of ` : ''}${file}`;
  }
  if (action === 'asset.read') return `Open ${file}`;
  if (action === 'message.send') {
    const what = details.assetId ? file : 'a message';
    return `Send ${what}${recipient ? ` to ${recipient}` : ''}`;
  }
  return humanize(action);
}

export type RuleOutcome = 'Allowed' | 'Denied' | 'Refused by contract' | string;
export interface RuleContext { ownerName?: string; assets?: Asset[]; directory?: Directory; scope?: SpendScopeLabels }

export function ruleFor(reasonCode: string | null | undefined, decision: 'allow' | 'deny' | 'needsHuman' | string, grant?: { action: string; target?: Record<string, unknown> } | null, context: RuleContext = {}): { outcome: RuleOutcome; rule: string } {
  const owner = context.ownerName || 'the owner';
  const possessive = context.ownerName ? `${context.ownerName}'s` : "the owner's";
  const code = reasonCode || '';
  const lower = code.toLowerCase();
  const base = decision === 'allow' ? 'Allowed' : decision === 'needsHuman' ? `Needs ${owner}` : 'Denied';
  if (code === 'ownerSignedGrant') {
    const what = grant ? describeAction(grant.action, grant.target, context.assets, context.directory, context.scope) : null;
    return { outcome: base, rule: `Allowed by ${possessive} signed grant${what ? `: ${what}` : ''}.` };
  }
  if (code === 'ownerSignedApprovalRequired') return { outcome: base, rule: `${possessive[0].toUpperCase()}${possessive.slice(1)} signed policy says to ask ${context.ownerName ? 'her' : 'the owner'} first.` };
  if (code === 'ownerSignedGrantDenied') return { outcome: base, rule: `${possessive[0].toUpperCase()}${possessive.slice(1)} signed policy turns this off.` };
  if (code === 'ownerSignedGrantMissing') return { outcome: base, rule: `No signed grant covers this. Everything ${context.ownerName || 'the owner'} didn't list is off.` };
  if (lower.includes('payee')) return { outcome: 'Refused by contract', rule: `The spending contract only pays payees on ${possessive} signed list.` };
  if (lower.includes('per_payment') || lower.includes('perpayment')) return { outcome: 'Refused by contract', rule: 'Over the per-payment limit.' };
  if (lower.includes('daily')) return { outcome: 'Refused by contract', rule: 'Over the daily limit.' };
  return { outcome: base, rule: code ? `${humanize(code)}.` : 'No reason was recorded.' };
}
