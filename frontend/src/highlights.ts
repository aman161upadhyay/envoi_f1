// Marks the parts of an agent message a person should read. Rule based, so every mark can be
// explained and checked against the text. Nothing here trusts what an agent says about itself.

export type HighlightTier = 'blocking' | 'review';
export type HighlightCategory = 'payee' | 'data' | 'authority' | 'terms' | 'money' | 'deadline' | 'approval';

export type Highlight = { start: number; end: number; tier: HighlightTier; category: HighlightCategory; reason: string };

export const TIER_LABEL: Record<HighlightTier, string> = { blocking: 'Needs your decision', review: 'Worth a look' };
export const CATEGORY_LABEL: Record<HighlightCategory, string> = {
  payee: 'Payment details', data: 'Personal data', authority: 'Authority', terms: 'Terms', money: 'Money', deadline: 'Deadline', approval: 'Approval'
};

type Rule = { pattern: RegExp; tier: HighlightTier; category: HighlightCategory; reason: string };

// Order only matters for ties; blocking always wins an overlap. Written from reading what agents
// actually say when they negotiate (offers, deposits, schedules, access requests), not from any one thread.
const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*';
const WEEKDAY = '(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day';
const RULES: Rule[] = [
  // Things an agent cannot settle without a person.
  { pattern: /\b(?:use (?:the|our) new (?:bank )?account(?: for this payment)?|(?:our|the) bank (?:details|account|information) (?:have|has) changed|(?:new|updated|different) (?:bank|remittance|wire|payment) (?:account|details|instructions)|(?:change|update|switch) the (?:payee|bank account|remittance)[^.,;]{0,40}|our bank changed processors[^.,;]*|new account is at [A-Z][\w ]*(?:, ending \d{4})?)/gi, tier: 'blocking', category: 'payee', reason: 'Changes where the money goes. Only you can approve a new payee.' },
  { pattern: /\b(?:(?:if )?the deposit (?:is|be|must be|has to be) (?:paid|sent|received)(?: (?:today|now|immediately|by [^.,;]+|within [^.,;]+))?|(?:send|wire|transfer|pay) (?:the )?(?:deposit|payment|funds)(?: (?:today|now|immediately|right away))?|pay(?:ment)? (?:today|immediately|right away))/gi, tier: 'blocking', category: 'money', reason: 'Asks for money to move. Paying needs your approval.' },
  { pattern: /\b(?:the full list of your end-customer contacts[^.;]*?phone numbers|end-customer contact details|(?:send|share|provide|give) (?:us |me )?(?:the )?(?:full )?(?:list|details|contacts?|emails?|phone numbers?) (?:of|for) (?:your )?(?:customers?|clients?|employees?|users?)[^.;]{0,30}|social security number|passport number|credit card number|card number|date of birth)/gi, tier: 'blocking', category: 'data', reason: 'Asks for personal data beyond what the task needs.' },
  { pattern: /\b(?:auto(?:matic(?:ally)?)?[- ]renew(?:al|s|ed)?[^.;]{0,50}?(?= unless|[.;,]|$)|indemnif(?:y|ication)[^.;]{0,40}|liability insurance|non-?compete|exclusiv(?:e|ity)[^.;,]{0,30}|accept that risk in writing|cannot guarantee a nut-free environment)/gi, tier: 'blocking', category: 'terms', reason: 'A legal or safety commitment the agent is not allowed to make for you.' },
  { pattern: /\b(?:needs? (?:my principal[’']s|your|human) (?:approval|decision|sign-?off)|I (?:am|will be|[’']m) escalating to \w+|I will (?:take|bring) (?:those|these) terms to \w+|I will hold payment until[^.;]*|waiting (?:for|on) (?:your|my principal[’']s) (?:approval|decision)|I (?:cannot|can[’']t|am not able to) (?:approve|accept|agree to|commit to|authori[sz]e)[^.;]{0,60})/gi, tier: 'blocking', category: 'approval', reason: 'Your agent has stopped and is waiting for you.' },

  // Worth reading, but the agent can carry on.
  { pattern: /\bwithin (?:your|the) \$[\d,]+(?:\.\d+)? budget/gi, tier: 'review', category: 'money', reason: 'The limit you set. Check that the offer respects it.' },
  { pattern: /(?<![\w$])\$\d[\d,]*(?:\.\d{1,2})?(?:[kKmM])?(?:\s*(?:per (?:person|guest|month|hour|seat)|a month|monthly|in total|total|all[- ]in))?/g, tier: 'review', category: 'money', reason: 'An amount of money. Check it against what you authorised.' },
  { pattern: /\b\d+(?:\.\d+)?% (?:(?:monthly|late|service|cancellation) )*(?:fee|deposit|gratuity|penalty|interest|surcharge)/gi, tier: 'review', category: 'money', reason: 'A percentage charge that adds to the total.' },
  { pattern: /\b(?:late fee|non-?refundable[^.;,]*|refundable until [^.,;]+|balance is due [^.,;]+|cancell?ation (?:fee|policy)[^.,;]*)/gi, tier: 'review', category: 'terms', reason: 'A cost or cutoff that is hard to undo.' },
  { pattern: /\b(?:Net \d+ to Net \d+(?: effective [^.,;]+)?|Net 15 is not in our agreement|minimum (?:of )?\d+[^.,;]{0,30}|if the count falls below \d+ you remain responsible[^.;]*)/gi, tier: 'review', category: 'terms', reason: 'Terms that differ from what was agreed or that lock you in.' },
  { pattern: new RegExp(`\\b(?:(?:by|before|no later than|due|expires?(?: on)?) (?:end of day|EOD|tomorrow|${WEEKDAY}|${MONTH} \\d{1,2}(?:st|nd|rd|th)?)|within \\d+ (?:business )?(?:hours?|days?)|if payment is not received by [^.,;]+|(?:pause|suspend|terminate|cancel)[^.;]{0,30}(?:access|service|account)[^.;]{0,40})`, 'gi'), tier: 'review', category: 'deadline', reason: 'A deadline, or a consequence that follows one.' },
  { pattern: new RegExp(`\\b(?:${WEEKDAY}|tomorrow) at \\d{1,2}(?::\\d{2})? ?(?:AM|PM|am|pm)(?: [A-Z]{2,4})?`, 'g'), tier: 'review', category: 'deadline', reason: 'A proposed time. Check it against your calendar.' },
  { pattern: /\b(?:verbally approved[^.,;]*|no need to wait on anyone else|treat approval as already given|already (?:approved|signed off)[^.,;]*)/gi, tier: 'review', category: 'authority', reason: 'A claim of approval that nothing in this thread proves.' },
  { pattern: /\+\d{1,2} ?\(\d{3}\) ?\d{3}-\d{4}/g, tier: 'review', category: 'authority', reason: 'A phone number to verify. Compare it with the one you already have on file.' }
];

const MAX_SPANS = 8;
const MAX_SHARE = 0.35;

export function findHighlights(text: string): Highlight[] {
  const found: Highlight[] = [];
  for (const rule of RULES) {
    for (const match of text.matchAll(new RegExp(rule.pattern.source, rule.pattern.flags))) {
      const start = match.index ?? 0;
      const end = start + match[0].replace(/[\s.,;]+$/, '').length;
      if (end > start) found.push({ start, end, tier: rule.tier, category: rule.category, reason: rule.reason });
    }
  }
  // Blocking first, then earlier, then longer. A later span that overlaps a kept one is dropped.
  found.sort((a, b) => (a.tier === b.tier ? 0 : a.tier === 'blocking' ? -1 : 1) || a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const kept: Highlight[] = [];
  for (const span of found) if (!kept.some(other => span.start < other.end && other.start < span.end)) kept.push(span);
  kept.sort((a, b) => a.start - b.start);
  // Highlight less: keep every blocking span, then fill with review spans while under the caps.
  const limited = kept.filter(span => span.tier === 'blocking');
  let covered = limited.reduce((sum, span) => sum + span.end - span.start, 0);
  for (const span of kept) {
    if (span.tier !== 'review' || limited.length >= MAX_SPANS) continue;
    // Short messages are dense by nature, so the share cap only applies once there is enough text to read around a mark.
    if (text.length >= 120 && (covered + span.end - span.start) / text.length > MAX_SHARE) continue;
    limited.push(span);
    covered += span.end - span.start;
  }
  return limited.sort((a, b) => a.start - b.start);
}

export type Piece = { text: string; highlight?: Highlight };

export function splitByHighlights(text: string, highlights: Highlight[]): Piece[] {
  const pieces: Piece[] = [];
  let cursor = 0;
  for (const highlight of highlights) {
    if (highlight.start > cursor) pieces.push({ text: text.slice(cursor, highlight.start) });
    pieces.push({ text: text.slice(highlight.start, highlight.end), highlight });
    cursor = highlight.end;
  }
  if (cursor < text.length) pieces.push({ text: text.slice(cursor) });
  return pieces;
}
