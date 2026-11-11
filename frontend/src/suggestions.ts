// Suggested highlights: a second, optional layer on top of the rule based marks in highlights.ts.
// A language model (or a recorded response) proposes quotes worth a second look. Nothing it returns
// is trusted: every quote must appear word for word in the message, may not overlap a rule mark,
// can never say "blocked", and the whole case is capped. Only Envoi's policy can block.

import { findHighlights } from './highlights';

export type FlagCategory = 'scope' | 'commitment' | 'term_change' | 'missing_answer' | 'inconsistency' | 'redundancy';
export type FlagSeverity = 'review' | 'info';

export type SuggestedFlag = { eventId: string; quote: string; category: FlagCategory; reason: string; mandateRef: string | null; severity: FlagSeverity };
export type SuggestionResponse = { caseId: string; flags: SuggestedFlag[] };
export type ResolvedFlag = SuggestedFlag & { key: string; start: number; end: number };

export type SuggestionRequest = {
  caseId: string;
  objective: string;
  constraints?: Record<string, unknown>;
  messages: { id: string; sender: string; text: string }[];
};
export type SuggestionProvider = (request: SuggestionRequest) => Promise<SuggestionResponse>;

export const FLAG_CATEGORY_LABEL: Record<FlagCategory, string> = {
  scope: 'Outside the task', commitment: 'Commitment', term_change: 'Changed term', missing_answer: 'Unanswered question', inconsistency: 'Inconsistent', redundancy: 'Repeated'
};
export const SEVERITY_LABEL: Record<FlagSeverity, string> = { review: 'Worth reviewing', info: 'For information' };

export const MAX_FLAGS_PER_CASE = 5;
const MIN_QUOTE_LENGTH = 8;
const CATEGORIES = Object.keys(FLAG_CATEGORY_LABEL) as FlagCategory[];

/** Keep only flags we can verify against the message text. Order of the response decides who wins the cap. */
export function resolveFlags(messages: { id: string; text: string }[], flags: SuggestedFlag[], cap = MAX_FLAGS_PER_CASE): ResolvedFlag[] {
  const texts = new Map(messages.map(message => [message.id, message.text]));
  const taken = new Map<string, { start: number; end: number }[]>();
  const resolved: ResolvedFlag[] = [];
  for (const flag of flags) {
    if (resolved.length >= cap) break;
    if (flag.severity !== 'review' && flag.severity !== 'info') continue;
    if (!CATEGORIES.includes(flag.category)) continue;
    const text = texts.get(flag.eventId);
    if (text === undefined || typeof flag.quote !== 'string' || flag.quote.trim().length < MIN_QUOTE_LENGTH) continue;
    if (!taken.has(flag.eventId)) taken.set(flag.eventId, findHighlights(text).map(mark => ({ start: mark.start, end: mark.end })));
    const spans = taken.get(flag.eventId)!;
    let at = text.indexOf(flag.quote);
    let found = -1;
    while (at !== -1) {
      const from = at;
      const to = at + flag.quote.length;
      if (!spans.some(span => from < span.end && span.start < to)) { found = at; break; }
      at = text.indexOf(flag.quote, at + 1);
    }
    if (found === -1) continue;
    spans.push({ start: found, end: found + flag.quote.length });
    resolved.push({ ...flag, key: `${flag.eventId}:${found}`, start: found, end: found + flag.quote.length });
  }
  return resolved;
}

/** Turn whatever a model returned into a SuggestionResponse, dropping anything malformed. */
export function parseSuggestionResponse(value: unknown, caseId: string): SuggestionResponse {
  const raw = value && typeof value === 'object' ? (value as { flags?: unknown }).flags : undefined;
  const flags: SuggestedFlag[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      if (typeof row.eventId !== 'string' || typeof row.quote !== 'string' || typeof row.reason !== 'string') continue;
      if (!CATEGORIES.includes(row.category as FlagCategory)) continue;
      if (row.severity !== 'review' && row.severity !== 'info') continue;
      flags.push({ eventId: row.eventId, quote: row.quote, category: row.category as FlagCategory, reason: row.reason.slice(0, 240), mandateRef: typeof row.mandateRef === 'string' ? row.mandateRef : null, severity: row.severity });
    }
  }
  return { caseId, flags };
}

export const SUGGESTION_RULES = [
  `Return at most ${MAX_FLAGS_PER_CASE} flags.`,
  'Quote the message word for word. Never paraphrase. A quote that is not an exact substring of that message is discarded.',
  'severity is "review" or "info". Never say a message is blocked; only the policy engine can block.',
  'Say nothing rather than guess. Skip greetings, thanks and acknowledgements.',
  'Do not repeat anything an earlier automatic mark already covers: payee changes, requests for personal data, legal commitments, late fees, deadlines with a consequence, unverified approval claims.',
  `category is one of: ${CATEGORIES.join(', ')}.`,
  'reason is one sentence a reviewer can check against the transcript.'
];

/** The prompt a live provider sends. Kept here so tests and reviewers can read exactly what is asked. */
export function buildSuggestionPrompt(request: SuggestionRequest): string {
  const transcript = request.messages.map(message => `[${message.id}] ${message.sender}: ${message.text}`).join('\n\n');
  return [
    'You help a person review a negotiation between two software agents. Flag short passages the person should read twice.',
    `Case objective: ${request.objective}`,
    request.constraints && Object.keys(request.constraints).length ? `Constraints the person set: ${JSON.stringify(request.constraints)}` : '',
    'Rules:', ...SUGGESTION_RULES.map(rule => `- ${rule}`),
    'Reply with JSON only: {"flags":[{"eventId":"","quote":"","category":"","reason":"","mandateRef":null,"severity":"review"}]}',
    'Transcript:', transcript
  ].filter(Boolean).join('\n');
}

/** Wrap any text-completion function (a hosted model, a private TEE model, a test stub) as a provider. */
export function providerFromCompletion(complete: (prompt: string) => Promise<string>): SuggestionProvider {
  return async request => {
    const reply = await complete(buildSuggestionPrompt(request));
    const start = reply.indexOf('{');
    const end = reply.lastIndexOf('}');
    let parsed: unknown = null;
    try { parsed = start >= 0 && end > start ? JSON.parse(reply.slice(start, end + 1)) : null; } catch { parsed = null; }
    return parseSuggestionResponse(parsed, request.caseId);
  };
}

// One provider for the whole app. Preview installs a recorded one; production installs none until a real one is wired.
let current: SuggestionProvider | null = null;
const listeners = new Set<() => void>();
export function setSuggestionProvider(provider: SuggestionProvider | null) { current = provider; listeners.forEach(listener => listener()); }
export function getSuggestionProvider() { return current; }
export function subscribeSuggestionProvider(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

// Cache by case and last event so a case is only sent once until something new arrives.
const cache = new Map<string, SuggestionResponse>();
export function cachedSuggestions(key: string) { return cache.get(key); }
export function storeSuggestions(key: string, response: SuggestionResponse) { cache.set(key, response); }
export function clearSuggestionCache() { cache.clear(); }

// Dismissals are the precision signal: a suggestion people reject is one the model should stop making.
export type Dismissal = { caseId: string; eventId: string; quote: string; category: FlagCategory; at: string };
const DISMISS_KEY = 'envoi.flagDismissals';
export function readDismissals(): Dismissal[] {
  try { const list = JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]'); return Array.isArray(list) ? list : []; } catch { return []; }
}
export function recordDismissal(caseId: string, flag: SuggestedFlag) {
  try {
    const list = readDismissals();
    list.push({ caseId, eventId: flag.eventId, quote: flag.quote, category: flag.category, at: new Date().toISOString() });
    localStorage.setItem(DISMISS_KEY, JSON.stringify(list.slice(-200)));
  } catch { /* storage can be blocked; dismissing still works for this session */ }
}
export function isDismissed(caseId: string, flag: SuggestedFlag) {
  return readDismissals().some(item => item.caseId === caseId && item.eventId === flag.eventId && item.quote === flag.quote);
}
