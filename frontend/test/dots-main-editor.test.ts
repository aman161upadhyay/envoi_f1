import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentPermissionPicker, PoliciesPage } from '../src/App';
import { ApiError, api } from '../src/api';
import { DotsSetupGuide } from '../src/onboarding/DotsSetupGuide';

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === 'function' ? initial() : initial;
    return [hooks.values[index], (next: unknown) => { hooks.values[index] = typeof next === 'function' ? next(hooks.values[index]) : next; }];
  } };
});
function elements(tree: ReactNode): ReactElement<any>[] {
  const found: ReactElement<any>[] = [];
  Children.forEach(tree, child => { if (isValidElement(child)) { found.push(child); found.push(...elements((child.props as any).children)); } });
  return found;
}
const text = (element: ReactElement<any>) => Children.toArray(element.props.children).filter(item => typeof item === 'string').join('');
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('turns the released editor OAuth refusal into same-agent reconnect instructions without another permission write', async () => {
  hooks.values = []; hooks.cursor = 0;
  vi.stubGlobal('window', { location: { origin: 'https://envoi.example' } });
  const update = vi.spyOn(api, 'updateAgentPermissions').mockRejectedValue(new ApiError('Reconnect this OAuth agent to grant more permissions.', 409, 'OAUTH_RECONSENT_REQUIRED'));
  const agent = { id: 'agent_example', name: 'Example', address: 'example@envoi.example', principalHumanId: 'owner', status: 'active', onboardingStatus: 'approved', permissions: ['receive_agent_messages'] };
  const props: any = { entries: [{ agent, inbox: { id: 'inbox_example' }, view: { canManageInbox: true } }], onConnect: vi.fn(), onRefresh: vi.fn(), notify: vi.fn() };
  const render = () => { hooks.cursor = 0; return PoliciesPage(props); };
  let tree = render();
  elements(tree).find(item => item.type === 'button' && text(item).startsWith('Edit '))!.props.onClick();
  tree = render(); elements(tree).find(item => item.type === AgentPermissionPicker)!.props.onChange(['receive_agent_messages', 'send_agent_messages']);
  tree = render(); elements(tree).find(item => item.type === 'button' && text(item) === 'Save permissions')!.props.onClick();
  await Promise.resolve(); await Promise.resolve();
  tree = render();
  const recovery = elements(tree).find(item => item.type === DotsSetupGuide)!;
  expect(recovery.props).toMatchObject({ name: 'Example', address: 'example@envoi.example', reconnect: true });
  expect(update).toHaveBeenCalledExactlyOnceWith('inbox_example', 'agent_example', ['receive_agent_messages', 'send_agent_messages'], ['receive_agent_messages']);
  expect(props.notify).not.toHaveBeenCalled();
});
