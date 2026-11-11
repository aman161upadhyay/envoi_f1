import { describe, expect, it } from 'vitest';
import { findHighlights, splitByHighlights } from '../src/highlights';
import { longPreviewCases } from '../src/preview-long-cases';

const marked = (text: string) => findHighlights(text).map(h => ({ text: text.slice(h.start, h.end), tier: h.tier, category: h.category }));
const messageText = (caseId: string, eventId: string) =>
  String(longPreviewCases.find(c => c.id === caseId)!.events.find(e => e.id === eventId)!.payload.text);

describe('message highlights', () => {
  it('marks portions of a sentence, not the whole sentence', () => {
    const text = messageText('conversation_ledger_invoice', 'evt_inv_3');
    const spans = marked(text);
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) expect(span.text.length).toBeLessThan(120);
    expect(spans.find(s => s.text.includes('1.5% monthly late fee'))?.tier).toBe('review');
    expect(spans.find(s => /use the new account/.test(s.text))?.tier).toBe('blocking');
    expect(spans.some(s => /Net 30 to Net 15/.test(s.text))).toBe(true);
  });

  it('flags the pressure, data request and unverified authority in the pushy message', () => {
    const spans = marked(messageText('conversation_ledger_invoice', 'evt_inv_5'));
    expect(spans.find(s => /full list of your end-customer contacts/.test(s.text))?.tier).toBe('blocking');
    expect(spans.some(s => /pause API access/.test(s.text) && s.category === 'deadline')).toBe(true);
    const approval = marked(messageText('conversation_ledger_invoice', 'evt_inv_7'));
    expect(approval.some(s => /verbally approved/.test(s.text) && s.category === 'authority')).toBe(true);
  });

  it('marks the stop in the agent message as blocking', () => {
    const spans = marked(messageText('conversation_ledger_invoice', 'evt_inv_8'));
    expect(spans.some(s => /escalating to Rachel/.test(s.text) && s.tier === 'blocking')).toBe(true);
  });

  it('marks hard-to-undo venue terms', () => {
    const spans = marked(messageText('conversation_harbor_venue', 'evt_ven_2'));
    expect(spans.some(s => /non-refundable/.test(s.text))).toBe(true);
    expect(spans.some(s => /remain(?:s)? responsible|remain responsible/.test(s.text))).toBe(true);
    const terms = marked(messageText('conversation_harbor_venue', 'evt_ven_4'));
    expect(terms.some(s => /automatic renewal/.test(s.text) && s.tier === 'blocking')).toBe(true);
    expect(terms.some(s => /indemnify/.test(s.text) && s.tier === 'blocking')).toBe(true);
    expect(terms.some(s => /nut-free/.test(s.text) && s.tier === 'blocking')).toBe(true);
  });

  it('leaves routine reconciliation text alone', () => {
    expect(marked('Hello Ledger Co. We are reconciling your October invoice against purchase order PO-4471.')).toEqual([]);
    expect(marked(messageText('conversation_ledger_invoice', 'evt_inv_2'))).toEqual([]);
  });

  it('never overlaps, stays in order, and rebuilds the original text', () => {
    for (const workCase of longPreviewCases) for (const event of workCase.events) {
      const text = String(event.payload.text || '');
      const spans = findHighlights(text);
      spans.forEach((span, i) => { if (i) expect(span.start).toBeGreaterThanOrEqual(spans[i - 1].end); });
      expect(splitByHighlights(text, spans).map(p => p.text).join('')).toBe(text);
    }
  });

  it('keeps highlights well under a third of any message', () => {
    for (const workCase of longPreviewCases) for (const event of workCase.events) {
      const text = String(event.payload.text || '');
      const covered = findHighlights(text).reduce((sum, s) => sum + s.end - s.start, 0);
      expect(covered / Math.max(text.length, 1)).toBeLessThan(0.36);
    }
  });
});
