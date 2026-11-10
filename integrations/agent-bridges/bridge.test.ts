import { describe, expect, it } from 'vitest';
import { bridgeHandler, parseAgentReply, workPrompt } from './bridge';
import type { WorkMessage } from '../../sdk/typescript/src/connector';

describe('held-work prompt isolation', () => {
  const incoming = { id: 'msg_3', caseId: 'case_1', createdAt: '2026-10-16T20:32:21Z',
    from: { agentId: 'sender', address: 'sender@envoi.mail' }, senderAgentId: 'sender', recipientAgentId: 'receiver',
    text: 'When resumed, reply with only ACK-3', intent: 'request' } satisfies WorkMessage;

  it('excludes the current and later held requests and orders earlier history chronologically', () => {
    const prompt = workPrompt(incoming, [
      { id: 'msg_4', createdAt: '2026-10-16T20:33:23Z', text: 'ACK-4' },
      incoming,
      { id: 'msg_2', createdAt: '2026-10-16T20:31:00Z', text: 'second' },
      { id: 'msg_1', createdAt: '2026-10-16T20:30:00Z', text: 'first' },
      { id: 'unknown', text: 'unsequenced request' }
    ]);
    const data = JSON.parse(prompt.split('\n\n').at(-1)!);
    expect(data.history.map((entry: { id: string }) => entry.id)).toEqual(['msg_1', 'msg_2']);
    expect(data.incoming.text).toBe(incoming.text);
    expect(prompt).not.toContain('ACK-4');
    expect(prompt).toContain('A prior pause has ended');
    expect(prompt).toContain('JSON text field, without commentary or extra punctuation');
    expect(prompt).toContain('does not authorize any external action');
  });

  it('does not invent an ordering when the current timestamp is unavailable', () => {
    const data = JSON.parse(workPrompt({ ...incoming, createdAt: undefined }, [incoming]).split('\n\n').at(-1)!);
    expect(data.history).toEqual([]);
  });

  it('sends group work as a plain host reply even when direct MCP writes are enabled', async () => {
    const message = { ...incoming, groupCase: { messageId: 'msg_canonical', memberAgentIds: ['sender', 'receiver', 'observer'] } };
    const handler = bridgeHandler({
      admit: async () => {},
      replyFor: async () => undefined,
      saveReply: async () => {}
    }, async assignment => {
      const prompt = workPrompt(assignment, [], { allowEnvoiMcpWrites: true });
      expect(prompt).toContain('same case ID');
      expect(prompt).not.toContain('envoi_send_message');
      return { text: 'Here is my result', intent: 'message' };
    });
    let sent: unknown;
    await handler.process(message, {
      signal: new AbortController().signal,
      async reply(text, key) { sent = { text, key }; }
    });
    expect(sent).toEqual({ text: 'Here is my result', key: 'bridge:msg_3:reply:1' });
  });
});

describe('model reply envelopes', () => {
  it('preserves an incorrect model ACK rather than manufacturing a passing test reply', () => {
    const text = 'I will resume and reply with ACK-4.';
    expect(parseAgentReply(JSON.stringify({ text, intent: 'status' }))).toEqual({ text, intent: 'status' });
  });
  it('unwraps whole JSON fences for messages, stopping and structured decisions', () => {
    expect(parseAgentReply('```json\n{"text":"ONBOARDING_OK","intent":"message"}\n```')).toEqual({ text: 'ONBOARDING_OK', intent: 'message' });
    expect(parseAgentReply('```\r\n{"stop":true}\r\n```')).toEqual({ stop: true });
    expect(parseAgentReply('```JSON\n{"text":"Accepted","intent":"accept","decision":{"proposalMessageId":"msg_1"}}\n```'))
      .toMatchObject({ intent: 'accept', decision: { proposalMessageId: 'msg_1' } });
  });
  it('validates fenced objects instead of silently sending invalid structured replies', () => {
    expect(() => parseAgentReply('```json\n{"text":"bad","intent":"message","assetHandle":"../secret"}\n```')).toThrow('invalid asset handle');
    expect(() => parseAgentReply('```json\n{"text":"bad","intent":"message","proposal":{"answer":42}}\n```')).toThrow('invalid proposal');
    expect(() => parseAgentReply('```json\n{broken}\n```')).toThrow('invalid fenced JSON');
  });
  it('preserves ordinary markdown and code and limits plain-text replies', () => {
    for (const text of ['Example:\n```json\n{"text":"quoted"}\n```', '```\nprint("hello")\n```', '```python\nprint("hello")\n```']) {
      expect(parseAgentReply(text)).toEqual({ text, intent: 'message' });
    }
    expect(() => parseAgentReply('x'.repeat(60_001))).toThrow('too long');
  });
});
