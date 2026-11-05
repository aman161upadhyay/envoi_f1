import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { contractRegistry, loadContractFixture } from '../../integrations/contract-fixtures/setup';
import { dotsSetupPrompt, dotsSetupSteps, dotsVerificationPrompt } from '../src/quick-connect';
import { ConnectPage } from '../src/onboarding/ConnectPage';
import { DotsPermissionRecovery, DotsSetupGuide } from '../src/onboarding/DotsSetupGuide';
import { connectionOffer } from '../src/onboarding/connect-state';
import { AuthorizeAgentPage } from '../src/onboarding/AuthorizeAgentPage';
import { ConsentController } from '../src/onboarding/consent-state';
import type { RemoteAuthApi } from '../src/onboarding/remote-auth-types';

const contract = contractRegistry.contracts.find(item => item.id === 'agent-remote-auth')!;
const fixture = (name: string): any => loadContractFixture(contract, name + '.json');
const origin = 'https://envoi.example';

describe('Dots onboarding route and grant recovery', () => {
  it.each([['routes-available-remote-mcp', true], ['routes-available-provider', false]])('consumes approved availability %s without rejecting other valid routes', (name, available) => {
    const body = fixture(name as string).response.body;
    expect(connectionOffer(body).remoteMcp).toBe(available);
    const html = renderToStaticMarkup(createElement(ConnectPage, { initialAvailability: body, initialAgentId: 'dots', origin }));
    expect(html.includes('MCP server URL')).toBe(available);
    expect(html.includes('Copy verification prompt')).toBe(available);
    expect(html).not.toContain('envoi-link.mjs task');
    if (!available) expect(html).toContain('Dots OAuth route is unavailable');
  });

  it('refuses inconsistent remote availability instead of inventing a working route', () => {
    const body = fixture('routes-available-remote-mcp').response.body;
    for (const mutate of [
      (value: any) => { value.deliveryModes.find((item: any) => item.deliveryMode === 'on_demand').available = false; },
      (value: any) => { value.registrationEnabled = false; },
      (value: any) => { value.routes.reverse(); }
    ]) { const value = structuredClone(body); mutate(value); expect(() => connectionOffer(value)).toThrow('unavailable'); }
  });

  it('uses one official plugin and reserves the endpoint for diagnostics', () => {
    const html = renderToStaticMarkup(createElement(DotsSetupGuide, { origin, name: 'Example', address: 'example@envoi.example', reconnect: true }));
    expect(html).toContain('value="https://envoi.example/mcp"');
    expect(html).toContain('https://chatgpt.com/plugins');
    expect(html).not.toContain('href="https://envoi.example/mcp"');
    expect(html).not.toContain('Add custom MCP server');
    expect(html).toContain('official Envoi plugin');
    expect(html).toContain('Do not create a separate custom plugin');
    expect(html).toContain('Repeated reconnects cannot fix a missing scope');
    expect(html).toContain('For connection diagnostics');
    expect(html).toContain('receive-only grant cannot send');
    expect(html).toContain('Reconnect an existing agent');
    expect(html).toContain('cases and history');
    expect(html).toContain('Copy verification prompt');
    expect(html).not.toContain('closed-app delivery is still being verified');
  });

  it('reuses installed plugins and verifies identity and scope before any send', () => {
    const prompt = dotsSetupPrompt(origin, 'Example', 'example@envoi.example', true);
    expect(prompt).toContain('Use the official Envoi plugin already installed');
    expect(prompt).not.toContain('Add custom MCP server');
    expect(prompt).toContain('Do not create a separate personal plugin');
    expect(prompt).toContain('stop and report the missing send scope');
    expect(prompt).toContain('envoi.agent envoi.send');
    expect(prompt).toContain('explicitly select Send agent messages');
    expect(prompt).toContain('stop before sending');
    expect(prompt).toContain('envoi_agent_info');
    expect(prompt).toContain('envoi_send_message');
    expect(prompt).toContain('native monitoring task');
    expect(prompt).toContain('canonical reply and settlement');
    expect(dotsSetupSteps(origin).join(' ')).toContain('Each owner connects their own account');
    const check = dotsVerificationPrompt('example@envoi.example');
    expect(check).toContain('example@envoi.example');
    expect(check).toContain('Do not claim work, send a message');
  });

  it('does not offer OAuth permission recovery for frozen identities', () => {
    const html = renderToStaticMarkup(createElement(DotsPermissionRecovery, { origin, agents: [{ id: 'frozen', name: 'Frozen', address: 'frozen@envoi.example', principalHumanId: 'owner', status: 'revoked', onboardingStatus: 'revoked', permissions: [] }] }));
    expect(html).toBe('');
  });

  it.each([false, true])('explains receive-only consent (requested send: %s) without widening the request', async requestedSend => {
    const body = structuredClone(fixture('consent-view').response.body);
    body.requestedPermissions = requestedSend ? ['receive_agent_messages', 'send_agent_messages'] : ['receive_agent_messages'];
    body.grantablePermissions = ['receive_agent_messages'];
    const client = { view: vi.fn().mockResolvedValue(body) } as unknown as RemoteAuthApi;
    const controller = new ConsentController('fixture_handle', client, vi.fn(), () => Date.parse('2026-10-21T12:01:00Z'));
    await controller.load();
    const html = renderToStaticMarkup(createElement(AuthorizeAgentPage, { humanId: 'owner', handle: 'fixture_handle', workspaces: [], agents: [], controller }));
    expect(html).toContain(requestedSend ? 'Workspace policy does not allow sending' : 'Receive-only connection');
    expect(controller.getSnapshot().view!.requestedPermissions).toEqual(body.requestedPermissions);
    expect(html).toContain('Approve access');
  });
});
