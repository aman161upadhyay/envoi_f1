import { localAgentId, participantIds, resolveParticipant, timelineForCase } from './model';
import type { Asset, HumanView } from './types';

export interface FileFolder { id: string; label: string }

const otherFiles: FileFolder = { id: 'other', label: 'Other files' };

export function fileSourceView(asset: Asset, view: HumanView): HumanView {
  return view.sourceViews?.find(source => source.assets.some(item => item.id === asset.id)) || view;
}

export function fileFolderFor(asset: Asset, view: HumanView): FileFolder {
  const source = fileSourceView(asset, view);
  const workCase = source.caseQueue.find(item => item.id === asset.caseId) || view.caseQueue.find(item => item.id === asset.caseId);
  if (!workCase) return otherFiles;
  const localId = localAgentId(workCase, source);
  const counterpartId = participantIds(workCase, timelineForCase(workCase, source.messages)).find(id => {
    if (id === localId || id === workCase.principal) return false;
    const participant = resolveParticipant(workCase, id, source.agents, source.participantDirectory || view.participantDirectory, localId);
    return participant.type === 'externalAgent' || participant.type === 'internalAgent';
  });
  if (!counterpartId) return otherFiles;
  const participant = resolveParticipant(workCase, counterpartId, source.agents, source.participantDirectory || view.participantDirectory, localId);
  const displayName = participant.displayName.trim();
  const label = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(displayName) ? displayName.split('@')[0] : displayName;
  return { id: `agent:${counterpartId}`, label: label || 'Unknown agent' };
}
