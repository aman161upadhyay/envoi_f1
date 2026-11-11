// Centralized named data events. Unknown types remain recoverable through the
// ready checkpoint and periodic snapshots; auth/control events are separate.
export const WORKSPACE_EVENT_TYPES = [
  'inbox.created', 'agent.created', 'agent.account_created', 'agent.enrolled', 'agent.onboarded',
  'agent.inbox_created', 'agent.enrollment_token_created', 'agent.enrollment_redeemed',
  'agent.onboarding_approved', 'agent.onboarding_rejected', 'agent.permissions_updated', 'agent.credentials_revoked', 'agent.removed',
  'agent.revocation_reconciled', 'agent.reenroll_token_created', 'agent.reconnect_token_created',
  'agent.connection_setup_checked', 'agent.mcp_read_token_issued', 'agent.work_claimed', 'agent.work_failed', 'agent.work_deferred',
  'agent.paused', 'agent.resumed', 'agent.refresh_replay_detected', 'agent.refresh_recovered', 'work.available',
  'agent.installation_revoked', 'agent.installation_activated', 'agent.activation_replay_detected',
  'agent.registration_approved', 'agent.registration_withdrawn',
  'case_session.ended', 'agent.case_session_created', 'agent.case_session_ended',
  'agent.gateway_pairing_created', 'agent.gateway_session_created', 'agent.gateway_session_ended',
  'agent.gateway_notification_acknowledged', 'agent.poll_policy_changed',
  'agent.gateway_scope_changed', 'agent.gateway_work_released', 'agent.gateway_work_replied',
  'case.created', 'case.event_appended', 'case.action_recorded', 'case.completed',
  'case.human_decision_requested', 'case.human_decision_resolved',
  'group.case_created', 'group.message_posted', 'group.assignment_updated',
  'agent.case_tool_used',
  'agent.wake_subscription_created', 'agent.wake_subscription_activated', 'agent.wake_subscription_ended',
  'agent.wake_target_secret_set', 'agent.wake_target_attention',
  'policy.evaluated', 'policy.re_evaluated', 'proposal.created', 'proposal.countered', 'proposal.accept_attempted',
  'message.queued', 'message.retry_scheduled', 'message.dead_lettered', 'message.dead_letter_requeued',
  'message.failed', 'message.delivered', 'message.acknowledged', 'message.processed', 'message.created',
  'message.cancelled',
  'human.instruction_created', 'agent.instruction_replied',
  'email.queued', 'asset.created', 'asset.granted', 'asset.upload_started',
  'asset.scan_clean', 'asset.scan_infected', 'asset.scan_error',
  'contact.blocked', 'contact.unblocked', 'contact.approved',
  'discovery_invitation.issued', 'discovery_invitation.revoked',
  'relationship.granted', 'relationship.revoked',
  'calendar.connected', 'calendar.connection_started', 'calendar.disconnected',
  'invitation.accepted', 'invitation.declined'
] as const;
export const PROGRESS_ONLY_EVENTS = new Set<string>(['agent.mcp_read_token_issued', 'agent.work_claimed', 'agent.work_failed', 'agent.connection_setup_checked', 'agent.refresh_recovered', 'work.available']);

function validCursor(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\r\n\0]/.test(value);
}

export function createEventCursorStore() {
  const cursors = new Map<string, string>();
  let epoch = 0;
  return {
    clear: () => { epoch++; cursors.clear(); },
    scope: (accountId: string, workspaceId: string, isCurrent: () => boolean) => {
      const scopeEpoch = epoch;
      const key = JSON.stringify([accountId, workspaceId]);
      const current = () => scopeEpoch === epoch && isCurrent();
      const record = (event: Event, checkpoint = false) => {
        if (!current()) return false;
        const message = event as MessageEvent;
        let cursor: unknown = message.lastEventId;
        if (checkpoint) {
          let payload: { inboxId?: string; cursor?: unknown };
          try { payload = JSON.parse(message.data); } catch { return false; }
          if (!payload || payload.inboxId !== workspaceId) return false;
          if (!validCursor(cursor)) cursor = payload.cursor;
        }
        if (!validCursor(cursor) || cursor <= (cursors.get(key) || '')) return false;
        cursors.set(key, cursor);
        // Bounded, in-memory progress; eviction only causes harmless replay.
        if (cursors.size > 64) cursors.delete(cursors.keys().next().value!);
        return true;
      };
      return {
        record,
        url: () => {
          const cursor = current() ? cursors.get(key) : undefined;
          return `/api/inboxes/${encodeURIComponent(workspaceId)}/events${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`;
        }
      };
    }
  };
}

// Keep this EventSource instance alive: the browser carries Last-Event-ID when
// the server closes a bounded replay response and automatically reconnects.
export function subscribeReplayRecovery(stream: Pick<EventSource, 'addEventListener' | 'removeEventListener'>, refresh: () => void, notify: (message: string) => void) {
  const replayRequired = () => {
    notify('Catching up on workspace activity…');
    refresh();
  };
  stream.addEventListener('replay_required', replayRequired);
  return () => stream.removeEventListener('replay_required', replayRequired);
}
