import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DotsPermissionRecovery, DotsSetupGuide } from '../src/onboarding/DotsSetupGuide';

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
const origin = 'https://envoi.example';
const render = () => { hooks.cursor = 0; return DotsSetupGuide({ origin, name: 'Example', address: 'example@envoi.example', reconnect: true }); };
beforeEach(() => { hooks.values = []; hooks.cursor = 0; });
afterEach(() => vi.unstubAllGlobals());

it.each([
  ['Copy server URL', `${origin}/mcp`],
  ['Copy verification prompt', 'the address is example@envoi.example'],
  ['Copy connection prompt', 'select Example (example@envoi.example)']
])('copies the selected %s action for the same identity', async (label, expected) => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const button = elements(render()).find(item => item.type === 'button' && item.props.children === label)!;
  button.props.onClick(); await Promise.resolve(); await Promise.resolve();
  expect(writeText).toHaveBeenCalledTimes(1);
  expect(writeText.mock.calls[0][0]).toContain(expected);
  if (label === 'Copy verification prompt') expect(writeText.mock.calls[0][0]).toContain('Do not claim work, send a message');
  expect(elements(render()).some(item => item.props.role === 'status')).toBe(true);
});

it('keeps the endpoint and prompt selectable when clipboard permission fails', async () => {
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('unavailable')) } });
  elements(render()).find(item => item.type === 'button' && item.props.children === 'Copy server URL')!.props.onClick();
  await Promise.resolve(); await Promise.resolve();
  const tree = elements(render());
  expect(tree.some(item => item.props.role === 'alert')).toBe(true);
  expect(tree.some(item => item.type === 'input' && item.props.readOnly && item.props.value === `${origin}/mcp`)).toBe(true);
});

it('opens recovery for the selected existing agent and drops it when that identity is no longer offered', () => {
  const agent = { id: 'agent_example', name: 'Example', address: 'example@envoi.example', principalHumanId: 'owner', status: 'active', onboardingStatus: 'approved', permissions: ['receive_agent_messages'] };
  const draw = (agents = [agent]) => { hooks.cursor = 0; return DotsPermissionRecovery({ agents, origin }); };
  elements(draw()).find(item => item.type === 'select')!.props.onChange({ target: { value: agent.id } });
  const guide = elements(draw()).find(item => item.type === DotsSetupGuide)!;
  expect(guide.props).toMatchObject({ address: agent.address, reconnect: true });
  expect(draw([])).toBeNull();
});
