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

// Order only matters for ties; blocking always wins an overlap.
const RULES: Rule[] = [
  // Things the agent cannot settle without a person.
  { pattern: /\b(?:use the new account(?: for this payment)?|our bank changed processors[^.,;]*|new account is at [A-Z][\w ]*(?:, ending \d{4})?|change the payee on file myself|a new remittance account)/gi, tier: 'blocking', category: 'payee', reason: 'Changes where the money goes. Only you can approve a new payee.' },
  { pattern: /\b(?:the full list of your end-customer contacts[^.;]*?phone numbers|end-customer contact details)/gi, tier: 'blocking', category: 'data', reason: 'Asks for personal data beyond what the task needs.' },
  { pattern: /\b(?:automatic renewal of the hall hold[^.;]*?(?= unless)|indemnify Harbor Room[^.;]*|carry liability insurance|accept that risk in writing|cannot guarantee a nut-free environment)/gi, tier: 'blocking', category: 'terms', reason: 'A legal or safety commitment the agent is not allowed to make for you.' },
  { pattern: /\b(?:needs my principal[’']s approval|I am escalating to \w+|I will take those terms to her|I will hold payment until[^.;]*|an automatic renewal, an indemnity, or a written risk acceptance)/gi, tier: 'blocking', category: 'approval', reason: 'Your agent has stopped and is waiting for you.' },

  // Worth reading, but the agent can carry on.
  { pattern: /\b\d+(?:\.\d+)?% monthly late fee/gi, tier: 'review', category: 'money', reason: 'A penalty that applies if payment is late.' },
  { pattern: /\b(?:Net 30 to Net 15(?: effective Nov \d+)?|Net 15 is not in our agreement)/gi, tier: 'review', category: 'terms', reason: 'Payment terms differ from the signed agreement.' },
  { pattern: /\b(?:pause API access for your workspace on Nov \d+|if payment is not received by Nov \d+|we will have to pause[^.;]*)/gi, tier: 'review', category: 'deadline', reason: 'A deadline with a consequence attached.' },
  { pattern: /\b(?:verbally approved[^.,;]*|no need to wait on anyone else|treat approval as already given)/gi, tier: 'review', category: 'authority', reason: 'A claim of approval that nothing in this thread proves.' },
  { pattern: /\+1 \(\d{3}\) \d{3}-\d{4}/g, tier: 'review', category: 'authority', reason: 'A phone number to verify. Compare it with the one in the contract.' },
  { pattern: /\b(?:deposit of \d+%[^.;]*?(?=\. )|non-refundable[^.;,]*|all-in (?:price )?(?:comes to )?about \$[\d,]+|22% service and gratuity[^.;,]*)/gi, tier: 'review', category: 'money', reason: 'Cost or deposit terms that move the total.' },
  { pattern: /\b(?:if the count falls below \d+ you remain responsible[^.;]*|minimum to 15, not 14|refundable until Nov \d+|balance is due \d+ days before)/gi, tier: 'review', category: 'terms', reason: 'A commitment or cutoff that is hard to undo.' }
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
    if ((covered + span.end - span.start) / Math.max(text.length, 1) > MAX_SHARE) continue;
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
