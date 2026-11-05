import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { contractRegistry, loadContractFixture } from '../../integrations/contract-fixtures/setup';
import { ConsentTargetForm, type ConsentTargetFormProps } from '../src/onboarding/ConsentTargetForm';
import { ClaimController } from '../src/onboarding/claim-state';
import type { OnboardingApi } from '../src/onboarding/types';

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual,
    useState: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks.values[index], (next: unknown) => { hooks.values[index] = typeof next === 'function' ? next(hooks.values[index]) : next; }];
    },
    useMemo: (factory: () => unknown) => factory(), useEffect: () => {},
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot()
  };
});
type Control = ReactElement<{ children?: ReactNode; name?: string; value?: string; type?: string; disabled?: boolean; checked?: boolean;
  onChange?: (event: { target: { value?: string; checked?: boolean } }) => void; onSubmit?: (event: { preventDefault: () => void }) => void }>;
function controls(tree: ReactNode, type: string): Control[] {
  const found: Control[] = [];
  Children.forEach(tree, child => { if (!isValidElement(child)) return; const item = child as Control; if (item.type === type) found.push(item); found.push(...controls(item.props.children, type)); });
  return found;
}
const registration = contractRegistry.contracts.find(item => item.id === 'agent-registration')!;
const remote = contractRegistry.contracts.find(item => item.id === 'agent-remote-auth')!;
const fixture = (name: string): any => loadContractFixture(registration, name + '.json');
const scenario = fixture('owner-reconnect-after-installation-revoke');
const revoked = { ...scenario.steps[0].response.body[0], inboxId: 'inbox_example' };
const frozen = { ...scenario.steps[1].response.body[0], inboxId: 'inbox_frozen' };
const view = (loadContractFixture(remote, 'consent-view.json') as any).response.body;
const render = (props: ConsentTargetFormProps) => { hooks.cursor = 0; return ConsentTargetForm(props); };
beforeEach(() => { hooks.values = []; hooks.cursor = 0; });

it('keeps a receive-only existing grant narrow until the owner explicitly selects requested sending', async () => {
  const agent = { ...revoked, permissions: ['receive_agent_messages'] };
  const client = { installations: vi.fn().mockResolvedValue({ agentId: agent.id, installations: [] }) } as unknown as OnboardingApi;
  const controller = new ClaimController(client); const onApprove = vi.fn().mockResolvedValue(true);
  const props: ConsentTargetFormProps = { workspaces: [], agents: [agent], requested: ['receive_agent_messages', 'send_agent_messages'], grantable: ['receive_agent_messages', 'send_agent_messages'], disabled: false, onApprove, client, controller };
  let tree = render(props);
  controls(tree, 'input').filter(input => input.props.name === 'oauth-target')[1].props.onChange!({ target: {} });
  tree = render(props); controls(tree, 'select')[0].props.onChange!({ target: { value: agent.id } });
  await Promise.resolve(); await Promise.resolve();
  tree = render(props);
  const sendLabel = controls(tree, 'label').find(label => Children.toArray(label.props.children).includes('send agent messages'))!;
  const send = controls(sendLabel, 'input')[0];
  expect(send.props.checked).toBe(false); expect(send.props.disabled).toBe(false);
  expect(onApprove).not.toHaveBeenCalled();
  send.props.onChange!({ target: { checked: true } });
  tree = render(props);
  controls(tree, 'input').find(input => input.props.type === 'checkbox' && !input.props.disabled && input.props.checked === false)!.props.onChange!({ target: { checked: true } });
  tree = render(props); controls(tree, 'form')[0].props.onSubmit!({ preventDefault() {} });
  expect(onApprove).toHaveBeenCalledExactlyOnceWith({ target: { kind: 'existing_agent', agentId: agent.id, replacesInstallationId: null }, grantedPermissions: ['receive_agent_messages', 'send_agent_messages'], policyProfile: 'default' });
});

it('submits the revoked existing identity only after reviewing installations and confirming replacement', async () => {
  const client = { installations: vi.fn().mockResolvedValue({ agentId: revoked.id, installations: [] }) } as unknown as OnboardingApi;
  const controller = new ClaimController(client); const onApprove = vi.fn().mockResolvedValue(true);
  const props: ConsentTargetFormProps = { workspaces: [], agents: [revoked, frozen], requested: view.requestedPermissions, grantable: view.grantablePermissions, disabled: false, onApprove, client, controller };
  let tree = render(props);
  controls(tree, 'input').filter(input => input.props.name === 'oauth-target')[1].props.onChange!({ target: {} });
  tree = render(props); const select = controls(tree, 'select')[0];
  expect(controls(select, 'option').map(option => option.props.value)).toEqual(['', revoked.id]);
  select.props.onChange!({ target: { value: revoked.id } });
  await Promise.resolve(); await Promise.resolve();
  tree = render(props); controls(tree, 'form')[0].props.onSubmit!({ preventDefault() {} }); expect(onApprove).not.toHaveBeenCalled();
  const confirmation = controls(tree, 'input').find(input => input.props.type === 'checkbox' && !input.props.disabled)!;
  confirmation.props.onChange!({ target: { checked: true } });
  tree = render(props); controls(tree, 'form')[0].props.onSubmit!({ preventDefault() {} });
  expect(onApprove).toHaveBeenCalledExactlyOnceWith({ target: { kind: 'existing_agent', agentId: revoked.id, replacesInstallationId: null }, grantedPermissions: expect.arrayContaining(['receive_agent_messages']), policyProfile: 'default' });
  expect(JSON.stringify(onApprove.mock.calls)).not.toMatch(/verificationCode|bootstrapToken|envoi_agent_access_/);
});

it('selects the newest active installation and refuses submission when the form becomes disabled', async () => {
  const installation: any = fixture('owner-installations').response.body.installations.find((item: any) => item.status === 'active');
  const items = [{ ...installation, id: 'installation_older', activatedAt: '2026-01-01T00:00:00.000Z' }, { ...installation, id: 'installation_newer', activatedAt: '2026-02-01T00:00:00.000Z' }];
  const client = { installations: vi.fn().mockResolvedValue({ agentId: revoked.id, installations: items }) } as unknown as OnboardingApi;
  const controller = new ClaimController(client); const onApprove = vi.fn().mockResolvedValue(true);
  const props: ConsentTargetFormProps = { workspaces: [], agents: [revoked], requested: view.requestedPermissions, grantable: view.grantablePermissions, disabled: false, onApprove, client, controller };
  let tree = render(props); controls(tree, 'input').filter(input => input.props.name === 'oauth-target')[1].props.onChange!({ target: {} });
  tree = render(props); controls(tree, 'select')[0].props.onChange!({ target: { value: revoked.id } }); await Promise.resolve(); await Promise.resolve();
  tree = render(props); controls(tree, 'input').find(input => input.props.type === 'checkbox' && !input.props.disabled)!.props.onChange!({ target: { checked: true } });
  tree = render({ ...props, disabled: true }); controls(tree, 'form')[0].props.onSubmit!({ preventDefault() {} }); expect(onApprove).not.toHaveBeenCalled();
  tree = render(props); controls(tree, 'form')[0].props.onSubmit!({ preventDefault() {} });
  expect(onApprove.mock.calls[0][0].target).toEqual({ kind: 'existing_agent', agentId: revoked.id, replacesInstallationId: 'installation_newer' });
});
