import { describe, expect, it, vi } from 'vitest';
import { EnvoiConnector, type ConnectorSession, type ConnectorStore } from '../../sdk/typescript/src/connector';
import { startOpenClawMcpRelay } from './mcp-relay';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const relayToken = 'local-openclaw-mcp-token-at-least-32-chars';

describe('OpenClaw local MCP relay', () => {
  it('records a native MCP write before acknowledging it and fails closed if the record cannot be saved', async () => {
    const session: ConnectorSession = {
      agentId: 'agent_one', inboxId: 'inbox_one', address: 'one@envoi.mail', cursor: null,
      agentApiToken: 'access', agentRefreshToken: 'private-refresh',
      agentTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
      agentRefreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString()
    };
    const store: ConnectorStore = { load: async () => session, save: async () => {} };
    const upstream = vi.fn<typeof fetch>(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      return json({ jsonrpc: '2.0', id: request.id,
        result: { content: [{ type: 'text', text: JSON.stringify({ status: 202, payload: { id: 'sent_1' } }) }] } });
    });
    const recorded: string[] = [];
    let failSave = true;
    const relay = await startOpenClawMcpRelay({
      connector: new EnvoiConnector('https://envoi.example.test', store, { fetch: upstream }),
      bearerToken: relayToken, port: 0, allowCollaborationWrites: true,
      onSuccessfulWrite: async (_name, args) => {
        if (failSave) throw new Error('disk unavailable');
        recorded.push(String(args.idempotencyKey));
      }
    });
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'envoi_send_message', arguments: { recipientAddress: 'peer@envoi.mail',
        caseId: 'case_1', text: 'done', idempotencyKey: 'bridge:msg_1:reply:1' }
    } });
    try {
      const call = () => fetch(relay.url, { method: 'POST', headers: {
        authorization: `Bearer ${relayToken}`, 'content-type': 'application/json' }, body });
      const failed = await call();
      expect(failed.status).toBe(502);
      expect(JSON.stringify(await failed.json())).not.toContain('disk unavailable');
      failSave = false;
      const success = await call();
      expect(success.status).toBe(200);
      expect(recorded).toEqual(['bridge:msg_1:reply:1']);
    } finally { await relay.close(); }
  });

  it('keeps collaboration writes disabled unless the operator opts in', async () => {
    const current: ConnectorSession = {
      agentId: 'agent_one', inboxId: 'inbox_one', address: 'one@envoi.mail', cursor: null,
      agentApiToken: 'access', agentRefreshToken: 'private-refresh',
      agentTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
      agentRefreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString()
    };
    const store: ConnectorStore = { load: async () => current, save: async () => {} };
    const upstream = vi.fn<typeof fetch>(async () => json({ jsonrpc: '2.0', id: 1, result: { tools: [
      { name: 'envoi_agent_info' }, { name: 'envoi_send_message' },
      { name: 'envoi_read_group_case' }, { name: 'envoi_start_group_case' }, { name: 'envoi_send_group_message' }
    ] } }));
    const relay = await startOpenClawMcpRelay({
      connector: new EnvoiConnector('https://envoi.example.test', store, { fetch: upstream }),
      bearerToken: relayToken, port: 0
    });
    try {
      const call = (request: unknown) => fetch(relay.url, { method: 'POST',
        headers: { authorization: `Bearer ${relayToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(request) });
      const catalog = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      expect((await catalog.json()).result.tools.map((tool: { name: string }) => tool.name)).toEqual(['envoi_agent_info', 'envoi_read_group_case']);
      for (const name of ['envoi_start_group_case', 'envoi_send_group_message']) {
        const deniedGroup = await call({ jsonrpc: '2.0', id: 3, method: 'tools/call',
          params: { name, arguments: { idempotencyKey: 'group' } } });
        expect(deniedGroup.status).toBe(403);
      }
      const denied = await call({ jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'envoi_send_message', arguments: { idempotencyKey: 'one' } } });
      expect(denied.status).toBe(403);
      expect(upstream).toHaveBeenCalledTimes(1);
    } finally { await relay.close(); }
  });

  it('renews credentials and permits scoped, idempotent collaboration tools', async () => {
    let current: ConnectorSession = {
      agentId: 'agent_one', inboxId: 'inbox_one', address: 'one@envoi.mail', cursor: null,
      agentApiToken: 'expired-access', agentRefreshToken: 'private-refresh',
      agentTokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
      agentRefreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString()
    };
    const store: ConnectorStore = { load: async () => current, save: async value => { current = value; } };
    const writes = new Map<string, string>();
    const upstream = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith('/api/agent-token')) {
        expect(JSON.parse(String(init?.body)).agentRefreshToken).toBe('private-refresh');
        expect(JSON.parse(String(init?.body)).rotationId).toMatch(/^[0-9a-f-]{36}$/);
        return json({
          agentApiToken: 'fresh-access', agentRefreshToken: 'next-private-refresh',
          agentTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
          agentRefreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString()
        });
      }
      expect(String(url)).toBe('https://envoi.example.test/mcp');
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer fresh-access');
      expect(headers.get('mcp-protocol-version')).toBe('2025-11-25');
      const request = JSON.parse(String(init?.body));
      if (request.method === 'tools/list') return json({ jsonrpc: '2.0', id: request.id, result: { tools: [
        { name: 'envoi_agent_info' }, { name: 'envoi_read_case' },
        { name: 'envoi_start_case' }, { name: 'envoi_send_message' },
        { name: 'envoi_send_proposal' }, { name: 'envoi_send_decision' },
        { name: 'envoi_begin_asset_upload' },
        { name: 'envoi_read_group_case' }, { name: 'envoi_start_group_case' }, { name: 'envoi_send_group_message' }
      ] } });
      if (request.method === 'tools/call') {
        const key = request.params.arguments.idempotencyKey;
        if (key) {
          if (!writes.has(key)) writes.set(key, `message-${writes.size + 1}`);
          return json({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: writes.get(key) }] } });
        }
        return json({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'read result' }] } });
      }
      return json({ jsonrpc: '2.0', id: request.id, result: {} });
    });
    const connector = new EnvoiConnector('https://envoi.example.test', store, { fetch: upstream });
    let relay = await startOpenClawMcpRelay({ connector, bearerToken: relayToken, port: 0, allowCollaborationWrites: true });
    const call = (body: unknown, headers: Record<string, string> = {}) => fetch(relay.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${relayToken}`, 'content-type': 'application/json', 'mcp-protocol-version': '2025-11-25', ...headers },
      body: JSON.stringify(body)
    });
    try {
      const unauthenticated = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: 'Bearer wrong' });
      expect(unauthenticated.status).toBe(401);
      const browser = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { origin: 'https://outside.example.test' });
      expect(browser.status).toBe(403);
      const unauthenticatedWrite = await call({ jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'envoi_send_message', arguments: { idempotencyKey: 'unauthorized-write' } } },
      { authorization: 'Bearer wrong' });
      expect(unauthenticatedWrite.status).toBe(401);
      expect(upstream).not.toHaveBeenCalled();

      const catalog = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      expect(catalog.status).toBe(200);
      expect((await catalog.json()).result.tools.map((tool: { name: string }) => tool.name)).toEqual([
        'envoi_agent_info', 'envoi_read_case', 'envoi_start_case',
        'envoi_send_message', 'envoi_send_proposal', 'envoi_send_decision',
        'envoi_read_group_case', 'envoi_start_group_case', 'envoi_send_group_message'
      ]);
      expect(current.agentRefreshToken).toBe('next-private-refresh');

      const allowed = await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'envoi_read_case', arguments: { caseId: 'case_one' } } });
      expect(allowed.status).toBe(200);
      expect((await allowed.json()).result.content[0].text).toBe('read result');
      for (const name of ['envoi_start_case', 'envoi_send_message', 'envoi_send_proposal', 'envoi_send_decision', 'envoi_start_group_case', 'envoi_send_group_message']) {
        const args = { recipientAddress: 'peer@envoi.example', caseId: 'case_one', text: 'A proposed plan',
          ...(name === 'envoi_send_proposal' ? { proposal: { plan: 'meet' } } : {}),
          ...(name === 'envoi_send_decision' ? { decision: 'accept' } : {}),
          ...(name === 'envoi_start_group_case' ? { memberAddresses: ['peer@envoi.example', 'third@envoi.example'] } : {}),
          ...(name === 'envoi_send_group_message' ? { inReplyTo: 'group_message' } : {}),
          idempotencyKey: `openclaw-case-one-${name}` };
        const first = await call({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name, arguments: args } });
        const second = await call({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name, arguments: args } });
        expect(first.status).toBe(200);
        expect((await first.json()).result.content).toEqual((await second.json()).result.content);
      }
      expect(writes.size).toBe(6);
      const count = upstream.mock.calls.length;
      const missingKey = await call({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'envoi_send_message', arguments: {} } });
      expect(missingKey.status).toBe(400);
      const denied = await call({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'envoi_begin_asset_upload', arguments: { idempotencyKey: 'asset-one' } } });
      expect(denied.status).toBe(403);
      expect(upstream).toHaveBeenCalledTimes(count);
      await relay.close();
      relay = await startOpenClawMcpRelay({ connector, bearerToken: relayToken, port: 0, allowCollaborationWrites: true });
      const afterRestart = await call({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: {
        name: 'envoi_send_proposal', arguments: { recipientAddress: 'peer@envoi.example',
          caseId: 'case_one', text: 'A proposed plan', proposal: { plan: 'meet' },
          idempotencyKey: 'openclaw-case-one-envoi_send_proposal' }
      } });
      expect(afterRestart.status).toBe(200);
      expect((await afterRestart.json()).result.content[0].text).toBe('message-3');
      expect(writes.size).toBe(6);
    } finally { await relay.close(); }
  });
});
