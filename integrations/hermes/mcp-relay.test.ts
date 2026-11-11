import { describe, expect, it, vi } from 'vitest';
import { EnvoiConnector, type ConnectorSession, type ConnectorStore } from '../../sdk/typescript/src/connector';
import { startMcpRelay } from '../agent-bridges/mcp-relay';
import { authorizedHermesReply, authorizedHermesWrite } from './lease-write';

const relayToken = 'hermes-local-mcp-secret-at-least-32-characters';

describe('Hermes loopback MCP lease fence', () => {
  it('fences group replies to the active group case, message and live turn', () => {
    const controller = new AbortController();
    const active = { signal: controller.signal, message: {
      id: 'work_message', caseId: 'group_case', text: 'Request',
      from: { agentId: 'peer', address: 'peer@envoi.mail' },
      groupCase: { messageId: 'group_message', memberAgentIds: ['peer', 'hermes', 'third'] }
    } };
    const args = { caseId: 'group_case', inReplyTo: 'group_message', idempotencyKey: 'bridge:work_message:reply:1' };
    expect(authorizedHermesWrite(active, 'envoi_send_group_message', args)).toBe(true);
    expect(authorizedHermesWrite(active, 'envoi_send_group_message', { ...args, caseId: 'other' })).toBe(false);
    expect(authorizedHermesWrite(active, 'envoi_send_group_message', { ...args, inReplyTo: 'other' })).toBe(false);
    expect(authorizedHermesWrite(active, 'envoi_send_message', { ...args, recipientAddress: 'peer@envoi.mail' })).toBe(false);
    expect(authorizedHermesWrite(null, 'envoi_start_group_case', { idempotencyKey: 'interactive:group' })).toBe(true);
    expect(authorizedHermesWrite(null, 'envoi_send_group_message', args)).toBe(false);
    controller.abort();
    expect(authorizedHermesWrite(active, 'envoi_send_group_message', args)).toBe(false);
  });
  it('permits an interactive first send, fences automatic replies, and denies stale writes', async () => {
    const session: ConnectorSession = {
      agentId: 'hermes_agent', inboxId: 'inbox_hermes', address: 'hermes@envoi.mail', cursor: null,
      agentApiToken: 'access', agentRefreshToken: 'refresh',
      agentTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
      agentRefreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString()
    };
    const store: ConnectorStore = { load: async () => session, save: async () => {} };
    const upstream = vi.fn<typeof fetch>(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { id: number; method: string };
      if (request.method === 'tools/list') return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id,
        result: { tools: ['envoi_agent_info', 'envoi_send_message', 'envoi_start_case']
          .map(name => ({ name })) } }), { headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id,
        result: { content: [{ type: 'text', text: JSON.stringify({ status: 202, payload: { id: 'reply_1' } }) }] } }),
      { headers: { 'content-type': 'application/json' } });
    });
    const active = new AbortController();
    const message = { id: 'msg_1', caseId: 'case_1', senderAgentId: 'peer', recipientAgentId: 'hermes_agent',
      text: 'Request', from: { agentId: 'peer', address: 'peer@envoi.mail' } };
    let current: { message: typeof message; signal: AbortSignal } | null = null;
    const recorded: string[] = [];
    const relay = await startMcpRelay({
      connector: new EnvoiConnector('https://envoi.example.test', store, { fetch: upstream }),
      bearerToken: relayToken, port: 0, allowCollaborationWrites: true,
      collaborationToolNames: ['envoi_start_case', 'envoi_send_message', 'envoi_send_proposal', 'envoi_send_decision'],
      authorizeWrite: (name, args) => authorizedHermesWrite(current, name, args),
      onSuccessfulWrite: async (_name, args) => { recorded.push(String(args.idempotencyKey)); }
    });
    const call = (method: string, name?: string, key = 'bridge:msg_1:reply:1', id = 1) => fetch(relay.url, { method: 'POST',
      headers: { authorization: `Bearer ${relayToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method,
        ...(name ? { params: { name, arguments: { recipientAddress: 'peer@envoi.mail',
          caseId: 'case_1', text: 'Reply', idempotencyKey: key } } } : {}) }) });
    try {
      const catalog = await call('tools/list');
      expect((await catalog.json()).result.tools.map((tool: { name: string }) => tool.name))
        .toEqual(['envoi_agent_info', 'envoi_send_message', 'envoi_start_case']);
      expect((await call('tools/call', 'envoi_start_case', 'interactive:first-case')).status).toBe(200);
      expect((await call('tools/call', 'envoi_send_message', 'interactive:follow-up')).status).toBe(200);
      expect((await call('tools/call', 'envoi_send_message')).status).toBe(403);
      current = { message, signal: active.signal };
      expect((await call('tools/call', 'envoi_start_case', 'interactive:second-case')).status).toBe(403);
      expect((await call('tools/call', 'envoi_send_message', 'interactive:follow-up')).status).toBe(403);
      expect((await call('tools/call', 'envoi_send_message')).status).toBe(200);
      expect(recorded).toEqual(['interactive:first-case', 'interactive:follow-up', 'bridge:msg_1:reply:1']);
      expect(authorizedHermesReply(current, 'envoi_send_message', { idempotencyKey: 'bridge:msg_1:reply:1',
        caseId: 'case_2', recipientAddress: 'peer@envoi.mail' })).toBe(false);
      expect(authorizedHermesReply(current, 'envoi_send_message', { idempotencyKey: 'bridge:msg_1:reply:1',
        caseId: 'case_1', recipientAddress: 'other@envoi.mail' })).toBe(false);
      active.abort();
      expect((await call('tools/call', 'envoi_send_message')).status).toBe(403);
      current = null;
      expect((await call('tools/call', 'envoi_send_message')).status).toBe(403);
      expect(upstream).toHaveBeenCalledTimes(4);
    } finally { await relay.close(); }
  });
});
