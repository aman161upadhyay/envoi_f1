import path from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { EnvoiConnector, type ConnectorSession } from '../src/connector';
import { lifecyclePolicy } from '../src/lifecycle';
import { EnvoiError, rotateAgentToken } from '../src/index';
import { contractRegistryPath, loadContractFixture, loadContractRegistry } from '../../../integrations/contract-fixtures/setup';
const source = process.env.ENVOI_CONTRACT_FIXTURES_ROOT ?? path.dirname(contractRegistryPath);
const contract = loadContractRegistry(source).contracts.find(item => item.id === 'envoi-names' && item.version === 1);
if (!contract?.schemas) throw new Error('Point ENVOI_CONTRACT_FIXTURES_ROOT at the canonical envoi-names publication');
const fixtures = contract.fixtures.map(file => loadContractFixture(contract, file, source) as any);
const schemas = loadContractFixture(contract, contract.schemas, source) as any;
const ajv = new Ajv({ allErrors: true, strict: false }); addFormats(ajv); ajv.addSchema(schemas);
const byId = (id: string) => fixtures.find(fixture => fixture.id === id)!;
const validator = (name: string) => ajv.getSchema(`${schemas.$id}#/definitions/${name}`)!;
const savedSession = (): ConnectorSession => ({ agentId: 'agent_example', inboxId: 'inbox_example', address: 'example@envoi.mail',
  agentApiToken: byId('access-old-prefix').request.headers.authorization.slice(7),
  agentRefreshToken: byId('refresh-old-prefix').request.body.agentRefreshToken,
  agentTokenExpiresAt: new Date(Date.now() + 900000).toISOString(), agentRefreshTokenExpiresAt: new Date(Date.now() + 86400000).toISOString(), cursor: null });
describe('envoi-names v1 fixture-only consumer review', () => {
  it.each(fixtures)('loads and validates $id from canonical publication', fixture => {
    expect(validator('fixture')(fixture), JSON.stringify(validator('fixture').errors)).toBe(true);
    const validate = validator(fixture.response.schema);
    expect(validate(fixture.response.body), JSON.stringify(validate.errors)).toBe(true);
    if (typeof fixture.response.body.code === 'string') {
      const code = fixture.response.body.code;
      expect(fixture.response.status).toBe(schemas['x-codes'][code].status);
      const policy = lifecyclePolicy(new EnvoiError(fixture.response.body.message, fixture.response.status, code));
      expect(policy).toMatchObject({ lifecycle: fixture.client.lifecycle, retry: fixture.client.retry, guidance: fixture.client.guidance });
    }
  });
  it('maps legacy tools uniquely and verifies the full and case-read catalogs', () => {
    const map = schemas['x-tool-names']; const names = Object.values(map);
    expect(fixtures).toHaveLength(8); expect(names).toHaveLength(19); expect(new Set(names).size).toBe(19);
    for (const [old, next] of Object.entries(map)) expect(next).toBe(old.replace(/^sinaloa_/, 'envoi_'));
    const groupTools = ['envoi_start_group_case', 'envoi_read_group_case', 'envoi_send_group_message'];
    expect(byId('mcp-tools-list').response.body.result.tools.map((tool: any) => tool.name).sort())
      .toEqual([...names, ...groupTools].sort());
    expect(byId('mcp-tools-list-case-read').response.body.result.tools.map((tool: any) => tool.name).sort())
      .toEqual(['envoi_agent_info', 'envoi_read_case', 'envoi_list_messages'].sort());
    const full = structuredClone(byId('mcp-tools-list').response.body); full.result.tools[0].name = 'sinaloa_agent_info';
    expect(validator('mcpToolsList')(full)).toBe(false);
  });
  it('consumes issued successors through the real SDK rotation parser', async () => {
    const fixture = byId('credentials-issued');
    const pair = await rotateAgentToken('https://fixture.example', fixture.request.body.agentRefreshToken, fixture.request.body.rotationId, {
      fetch: (async (_input, init) => { expect(JSON.parse(String(init?.body))).toEqual(fixture.request.body); return Response.json(fixture.response.body); }) as typeof fetch
    });
    const { tokenType, ...savedFields } = fixture.response.body;
    expect(tokenType).toBe('Bearer'); expect(pair).toEqual(savedFields);
    expect(pair.agentApiToken).toMatch(/^envoi_agent_access_[A-Za-z0-9_-]{43}$/);
    expect(pair.agentRefreshToken).toMatch(/^envoi_agent_refresh_[A-Za-z0-9_-]{64}$/);
  });
  it.each(['access-old-prefix', 'mcp-read-old-prefix'])('reaches NEEDS_RECONNECT after %s and rejected old refresh without enrollment', async id => {
    let saved = savedSession(); const calls: string[] = [];
    const fetcher = (async (input: string | URL | Request) => {
      const route = new URL(String(input)).pathname; calls.push(route);
      const fixture = byId(route === '/api/agent-token' ? 'refresh-old-prefix' : id);
      return Response.json(fixture.response.body, { status: fixture.response.status });
    }) as typeof fetch;
    const connector = new EnvoiConnector('https://fixture.example', { load: async () => saved, save: async value => { saved = structuredClone(value); } }, { fetch: fetcher, handler: { admit: async () => {}, process: async () => {} } });
    if (id === 'access-old-prefix') await expect(connector.processWorkOnce()).rejects.toMatchObject({ code: 'REFRESH_TOKEN_INVALID' });
    else await expect(connector.forwardMcpRequest(JSON.stringify(byId('mcp-call-old-name').request.body))).rejects.toMatchObject({ code: 'REFRESH_TOKEN_INVALID' });
    expect((await connector.lifecycle()).state).toBe('NEEDS_RECONNECT');
    expect(saved.agentId).toBe('agent_example'); expect(saved.inboxId).toBe('inbox_example');
    expect(calls).toEqual([id === 'access-old-prefix' ? '/api/agent/work/claim' : '/mcp', '/api/agent-token']);
    await expect(connector.currentAccessToken()).rejects.toMatchObject({ code: 'REFRESH_TOKEN_INVALID' }); expect(calls).toHaveLength(2);
  });
  it('passes new tools/list and retired-name JSON-RPC errors through the real trusted MCP consumer', async () => {
    for (const id of ['mcp-tools-list', 'mcp-tools-list-case-read', 'mcp-call-old-name']) {
      let saved = { ...savedSession(), agentApiToken: 'envoi_agent_access_PLACEHOLDERxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' };
      const fixture = byId(id);
      const connector = new EnvoiConnector('https://fixture.example', { load: async () => saved, save: async value => { saved = value; } }, {
        fetch: (async (_input, init) => { expect(JSON.parse(String(init?.body))).toEqual(fixture.request.body); return Response.json(fixture.response.body); }) as typeof fetch
      });
      const response = await connector.forwardMcpRequest(JSON.stringify(fixture.request.body));
      expect(await response.json()).toEqual(fixture.response.body); expect((await connector.lifecycle()).state).toBe('RUNNING');
    }
  });
});
