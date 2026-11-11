import { isHumanDecisionMessage, isHumanInstructionMessage, type WorkMessage } from '../../sdk/typescript/src/connector';
import { mcpReplyMessageId } from '../agent-bridges/bridge';

export interface ActiveHermesWork { message: WorkMessage; signal: AbortSignal }

/** A Hermes tool reply may address only the sender and case of its current fenced work item. */
export function authorizedHermesReply(active: ActiveHermesWork | null, name: string, args: Record<string, unknown>) {
  const id = mcpReplyMessageId(name, args);
  return Boolean(id && active && !isHumanDecisionMessage(active.message) && !isHumanInstructionMessage(active.message) && active.message.id === id && !active.signal.aborted
    && active.message.caseId && args.caseId === active.message.caseId
    && (active.message.groupCase
      ? name === 'envoi_send_group_message' && args.inReplyTo === active.message.groupCase.messageId
      : name !== 'envoi_send_group_message' && args.recipientAddress === active.message.from.address));
}

/** Interactive Hermes turns may initiate work; a bridge-owned turn remains fenced to its sender and case. */
export function authorizedHermesWrite(active: ActiveHermesWork | null, name: string, args: Record<string, unknown>) {
  if (active) return authorizedHermesReply(active, name, args);
  if (!['envoi_start_case', 'envoi_send_message', 'envoi_start_group_case', 'envoi_send_group_message', 'envoi_send_proposal', 'envoi_send_decision'].includes(name)) return false;
  // A delayed reply from an expired work lease must never become an interactive send.
  return typeof args.idempotencyKey === 'string' && !args.idempotencyKey.startsWith('bridge:');
}
