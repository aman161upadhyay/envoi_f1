import { describe, expect, it } from 'vitest';
import { longPreviewCases } from '../src/preview-long-cases';
import { recordedProvider } from '../src/preview-suggestions';
import { findHighlights } from '../src/highlights';
import { buildSuggestionPrompt, parseSuggestionResponse, providerFromCompletion, resolveFlags, type SuggestedFlag } from '../src/suggestions';

const messagesOf = (caseId: string) => longPreviewCases.find(item => item.id === caseId)!.events
  .filter(event => event.type === 'message' && event.payload.messageType !== 'instruction')
  .map(event => ({ id: event.id, sender: String(event.payload.senderAgentId), text: String(event.payload.text) }));

const flag = (over: Partial<SuggestedFlag>): SuggestedFlag => ({ eventId: 'm1', quote: 'a quote long enough', category: 'commitment', reason: 'why', mandateRef: null, severity: 'review', ...over });

describe('suggested highlights', () => {
  it('keeps every recorded flag: quotes are exact and do not overlap rule marks', async () => {
    for (const item of longPreviewCases) {
      const recorded = await recordedProvider({ caseId: item.id, objective: item.objective, messages: messagesOf(item.id) });
      expect(recorded.flags.length).toBeGreaterThan(0);
      expect(resolveFlags(messagesOf(item.id), recorded.flags)).toHaveLength(recorded.flags.length);
    }
  });

  it('drops quotes that are not in the message, are too short, or are paraphrased', () => {
    const messages = [{ id: 'm1', text: 'Please send the signed copy back by Friday afternoon.' }];
    const out = resolveFlags(messages, [flag({ quote: 'send the signed copy back' }), flag({ quote: 'send the signed copies back' }), flag({ quote: 'Friday' }), flag({ eventId: 'nope', quote: 'send the signed copy back' })]);
    expect(out.map(item => item.quote)).toEqual(['send the signed copy back']);
  });

  it('never accepts a blocking severity or an unknown category', () => {
    const messages = [{ id: 'm1', text: 'Please send the signed copy back by Friday afternoon.' }];
    expect(resolveFlags(messages, [flag({ quote: 'send the signed copy back', severity: 'blocked' as never })])).toEqual([]);
    expect(resolveFlags(messages, [flag({ quote: 'send the signed copy back', category: 'made_up' as never })])).toEqual([]);
  });

  it('drops a suggestion that overlaps a rule mark and caps the case at five', () => {
    const text = 'Please use the new account for this payment and keep the receipt for your records today.';
    const rule = findHighlights(text)[0];
    expect(resolveFlags([{ id: 'm1', text }], [flag({ quote: text.slice(rule.start, rule.end) })])).toEqual([]);
    const long = Array.from({ length: 9 }, (_, i) => `distinct phrase number ${i} here`).join('. ');
    const many = Array.from({ length: 9 }, (_, i) => flag({ quote: `distinct phrase number ${i} here` }));
    expect(resolveFlags([{ id: 'm1', text: long }], many)).toHaveLength(5);
  });

  it('parses model output defensively and builds a prompt that carries the rules', async () => {
    expect(parseSuggestionResponse({ flags: [{ eventId: 'e', quote: 'q', category: 'scope', reason: 'r', severity: 'review' }, { nope: 1 }, null] }, 'c').flags).toHaveLength(1);
    expect(parseSuggestionResponse('garbage', 'c').flags).toEqual([]);
    const request = { caseId: 'c', objective: 'Pay the invoice', messages: [{ id: 'e1', sender: 'agent_x', text: 'Hello there' }] };
    const prompt = buildSuggestionPrompt(request);
    expect(prompt).toContain('Never say a message is blocked');
    expect(prompt).toContain('[e1] agent_x: Hello there');
    const provider = providerFromCompletion(async () => 'Sure! {"flags":[{"eventId":"e1","quote":"Hello there","category":"redundancy","reason":"Greeting","mandateRef":null,"severity":"info"}]}');
    expect((await provider(request)).flags).toHaveLength(1);
    expect((await providerFromCompletion(async () => 'no json here')(request)).flags).toEqual([]);
  });
});
