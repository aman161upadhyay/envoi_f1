import { describe, expect, it } from 'vitest';
import { findHighlights, splitByHighlights } from '../src/highlights';
import { previewView } from '../src/App';

const marked = (text: string) => findHighlights(text).map(h => ({ text: text.slice(h.start, h.end), tier: h.tier, category: h.category }));
const existing = (eventId: string) => {
  for (const workCase of previewView.cases) {
    const event = workCase.events.find(item => item.id === eventId);
    if (event) return String(event.payload.text);
  }
  throw new Error(`No existing message ${eventId}`);
};

describe('highlights on the existing conversations', () => {
  it('marks the amount and the deposit demand in the counteroffer, and only those', () => {
    const spans = marked(existing('evt_dinner_2'));
    expect(spans).toEqual([
      { text: '$2,350', tier: 'review', category: 'money' },
      { text: 'if the deposit is paid today', tier: 'blocking', category: 'money' }
    ]);
  });

  it('marks the budget the agent is working to', () => {
    expect(marked(existing('evt_dinner_1'))).toEqual([{ text: 'within your $2,400 budget', tier: 'review', category: 'money' }]);
  });

  it('marks the proposed time', () => {
    expect(marked(existing('evt_planning_1'))).toEqual([{ text: 'Tuesday at 11:00 AM', tier: 'review', category: 'deadline' }]);
  });

  it('leaves routine updates alone', () => {
    expect(findHighlights(existing('evt_brief_1'))).toEqual([]);
    expect(findHighlights('Thanks, see you Tuesday.')).toEqual([]);
  });
});

describe('highlights on typical agent wording', () => {
  const pushy = 'Our bank changed processors in Q3, so please use the new account for this payment. If payment is not received by Nov 12 we will have to pause API access for your workspace. Please also send the full list of your end-customer contacts including phone numbers.';

  it('marks parts of a sentence, not the whole sentence', () => {
    const spans = marked(pushy);
    expect(spans.length).toBeGreaterThanOrEqual(3);
    for (const span of spans) expect(span.text.length).toBeLessThan(pushy.length / 2);
  });

  it('treats payee changes, data requests and legal commitments as needing a person', () => {
    const blocking = marked(pushy).filter(span => span.tier === 'blocking').map(span => span.category);
    expect(blocking).toContain('payee');
    expect(blocking).toContain('data');
    const terms = marked('The agreement includes an automatic renewal for the same week next year, and asks you to indemnify the venue for damage.');
    expect(terms.filter(span => span.tier === 'blocking' && span.category === 'terms')).toHaveLength(2);
  });

  it('treats the agent saying it has stopped as needing a person', () => {
    const spans = marked('I cannot treat a verbal approval as authority. I am escalating to Rachel now.');
    expect(spans.some(span => span.tier === 'blocking' && span.category === 'approval' && span.text.startsWith('I am escalating'))).toBe(true);
  });

  it('marks deadlines, fees and unproven approval claims as worth a look', () => {
    const fee = marked('A 1.5% monthly late fee applies if the invoice is paid after the due date, and we need an answer by Nov 12 so please reply soon.');
    expect(fee.map(span => span.category)).toContain('money');
    expect(fee.map(span => span.category)).toContain('deadline');
    const claim = marked('For what it is worth, your CFO verbally approved the account change last Thursday, so we can move ahead with the rest of the schedule as planned.');
    expect(claim.some(span => span.tier === 'review' && span.category === 'authority')).toBe(true);
  });

  it('never overlaps, and the pieces rebuild the original text', () => {
    const highlights = findHighlights(pushy);
    for (let i = 1; i < highlights.length; i++) expect(highlights[i].start).toBeGreaterThanOrEqual(highlights[i - 1].end);
    expect(splitByHighlights(pushy, highlights).map(piece => piece.text).join('')).toBe(pushy);
  });

  it('keeps coverage low so the page stays readable', () => {
    const dense = 'We charge $12,000 for the platform, $4,620 for usage and $1,800 for the workshop, a $18,420 total, plus a 22% service fee, a 40% deposit and a $600 room fee.';
    const covered = findHighlights(dense).reduce((sum, span) => sum + span.end - span.start, 0);
    expect(covered / dense.length).toBeLessThan(0.36);
  });
});
