import { expect, it } from 'vitest';
import { fileFolderFor, fileSourceView } from '../src/file-folders';
import type { Asset, HumanView, WorkCase } from '../src/types';

const asset = (caseId: string | null): Asset => ({
  id: `asset_${caseId || 'other'}`, caseId, filename: 'report.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  size: 100, createdByAgentId: 'agent_delta', state: 'clean', createdAt: '2026-11-05T12:00:00Z'
});

it('keeps a shared file tied to its source agent inbox in the combined Files view', () => {
  const pdf = { ...asset('case_adam'), id: 'asset_pdf', filename: 'review.pdf', mimeType: 'application/pdf' };
  const workCase = { id: 'case_adam', principal: 'human_rachel', actingAgent: 'agent_delta', participants: ['agent_delta', 'agent_adam'], createdAt: '2026-11-05T12:00:00Z' } as WorkCase;
  const child = {
    inbox: { id: 'inbox_delta', ownerAgentId: 'agent_delta' }, assets: [pdf], caseQueue: [workCase], messages: [], agents: [],
    participantDirectory: { agent_adam: { id: 'agent_adam', type: 'externalAgent', displayName: 'Adam' } }
  } as unknown as HumanView;
  const combined = { inbox: { id: 'inbox_root', ownerAgentId: null }, assets: [pdf], caseQueue: [workCase], messages: [], agents: [], sourceViews: [child] } as unknown as HumanView;
  expect(fileSourceView(pdf, combined).inbox.id).toBe('inbox_delta');
  expect(fileFolderFor(pdf, combined)).toEqual({ id: 'agent:agent_adam', label: 'Adam' });
});

it('groups case files by the counterpart agent and uses a short folder label', () => {
  const cases = [
    { id: 'case_adam', principal: 'human_rachel', actingAgent: 'agent_delta', participants: ['agent_delta', 'agent_adam'], createdAt: '2026-11-05T12:00:00Z' },
    { id: 'case_potato', principal: 'human_rachel', actingAgent: 'agent_delta', participants: ['agent_delta', 'agent_potato'], createdAt: '2026-11-05T12:00:00Z' }
  ] as WorkCase[];
  const view = {
    inbox: { ownerAgentId: 'agent_delta' }, caseQueue: cases, messages: [], agents: [],
    participantDirectory: {
      agent_adam: { id: 'agent_adam', type: 'externalAgent', displayName: 'Adam' },
      agent_potato: { id: 'agent_potato', type: 'externalAgent', displayName: 'potato@agents.envoi-agents.com' }
    }
  } as unknown as HumanView;
  expect(fileFolderFor(asset('case_adam'), view)).toEqual({ id: 'agent:agent_adam', label: 'Adam' });
  expect(fileFolderFor(asset('case_potato'), view)).toEqual({ id: 'agent:agent_potato', label: 'potato' });
  expect(fileFolderFor(asset(null), view)).toEqual({ id: 'other', label: 'Other files' });
});
