/** a3-pause-auth v1 schemas.json → x-codes; fixture tests prevent policy drift. */
export type ConnectorState = 'STARTING' | 'RUNNING' | 'DEGRADED' | 'PAUSED' | 'NEEDS_RECONNECT' | 'REVOKED' | 'STOPPED';
export interface ConnectorLifecycle {
  state: ConnectorState;
  /** Pause survives outages and process shutdown. Only an explicit resume clears it. */
  paused: boolean;
  changedAt: string;
  code?: string;
  reason?: string;
  guidance?: string;
  failures: number;
  retryAt?: string;
}
interface Policy { lifecycle: ConnectorState | 'UNCHANGED' | 'NOT_APPLICABLE'; retry: string; guidance: string; guidanceByReason?: Record<string,string> }
const policies: Record<string, Policy> = {
  "AGENT_PAUSED": {
    "lifecycle": "PAUSED",
    "retry": "after_resume",
    "guidance": "wait_for_resume"
  },
  "CREDENTIAL_REVOKED": {
    "lifecycle": "REVOKED",
    "retry": "none",
    "guidance": "owner_reenroll",
    "guidanceByReason": {
      "revoked": "owner_reenroll",
      "refresh_replay": "owner_reenroll",
      "replaced": "replaced_by_reconnect"
    }
  },
  "CREDENTIAL_EXPIRED": {
    "lifecycle": "NEEDS_RECONNECT",
    "retry": "none",
    "guidance": "owner_reconnect"
  },
  "ACCESS_TOKEN_EXPIRED": {
    "lifecycle": "UNCHANGED",
    "retry": "refresh_then_retry_once",
    "guidance": "none"
  },
  "AUTHENTICATION_REQUIRED": {
    "lifecycle": "UNCHANGED",
    "retry": "refresh_then_retry_once",
    "guidance": "none"
  },
  "ROTATION_ID_REQUIRED": {
    "lifecycle": "NEEDS_RECONNECT",
    "retry": "none",
    "guidance": "update_connector"
  },
  "REFRESH_TOKEN_INVALID": {
    "lifecycle": "NEEDS_RECONNECT",
    "retry": "none",
    "guidance": "owner_reconnect"
  },
  "REFRESH_REPLAY": {
    "lifecycle": "REVOKED",
    "retry": "none",
    "guidance": "owner_reenroll"
  },
  "REFRESH_RECOVERY_EXPIRED": {
    "lifecycle": "NEEDS_RECONNECT",
    "retry": "none",
    "guidance": "owner_reconnect"
  },
  "CASE_CONTROLLED": {
    "lifecycle": "UNCHANGED",
    "retry": "after_case_resume",
    "guidance": "case_paused"
  },
  "ACCOUNT_CHANGED": {
    "lifecycle": "NOT_APPLICABLE",
    "retry": "none",
    "guidance": "reload_browser"
  },
  "RATE_LIMITED": {
    "lifecycle": "DEGRADED",
    "retry": "after_retry_after",
    "guidance": "service_busy"
  },
  "INTERNAL_SERVER_ERROR": {
    "lifecycle": "DEGRADED",
    "retry": "backoff",
    "guidance": "service_unavailable"
  },
  "AUTH_UNAVAILABLE": {
    "lifecycle": "DEGRADED",
    "retry": "backoff",
    "guidance": "service_unavailable"
  }
};
export function lifecyclePolicy(error: { code?: string; reason?: string; status?: number } | null | undefined): Policy {
  const policy = error?.code ? policies[error.code] : undefined;
  if (policy) return { ...policy, guidance: policy.guidanceByReason?.[error?.reason ?? ''] ?? policy.guidance };
  // HTTP is only a fallback for unknown throttling and server outages; never an authentication policy.
  if (error?.status === 429) return { lifecycle: 'DEGRADED', retry: 'after_retry_after', guidance: 'service_busy' };
  if (error?.code === 'HANDLER_FAILED' || error?.code === 'NETWORK_ERROR' || error?.code === 'TIMEOUT' || (error?.status !== undefined && error.status >= 500 && error.status !== 501))
    return { lifecycle: 'DEGRADED', retry: 'backoff', guidance: 'service_unavailable' };
  return { lifecycle: 'UNCHANGED', retry: 'none', guidance: 'none' };
}
export function retryDelay(failures: number, random = Math.random(), retryAfterSeconds = 0): number {
  const ceiling = Math.min(30_000, 500 * 2 ** Math.min(Math.max(1, failures), 6));
  return Math.max(Math.round(ceiling / 2 + Math.max(0, Math.min(1, random)) * ceiling / 2), retryAfterSeconds * 1000);
}
export function guidanceText(guidance: string): string {
  const text: Record<string,string> = { wait_for_resume: 'Paused; wait for the owner to resume this agent',
    owner_reconnect: 'Ask the owner to reconnect this existing agent', owner_reenroll: 'Credential revoked; ask the owner to enroll explicitly',
    replaced_by_reconnect: 'This installation was replaced by a reconnect; stop using its credentials', update_connector: 'update your connector',
    service_busy: 'Envoi is busy; retry after the saved delay', service_unavailable: 'Envoi is unavailable; retry after the saved delay' };
  return text[guidance] ?? guidance;
}
