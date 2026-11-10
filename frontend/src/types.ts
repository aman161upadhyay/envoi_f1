export type CaseState =
  | 'new' | 'classifying' | 'inProgress' | 'waitingForExternalParty' | 'waitingForHuman'
  | 'tentativeHold' | 'authorized' | 'executing' | 'sent' | 'received' | 'accepted'
  | 'completed' | 'failed' | 'unknownExternalResult' | 'expired' | 'paused' | 'revoked' | 'disputed';

export type CollaborationMode = 'scheduling' | 'negotiation' | 'collaboration' | 'knowledgeSharing' | 'artifactCreation';
export type CaseBucket = 'needsMe' | 'activeWork' | 'waiting' | 'completed';
export type StateTone = 'neutral' | 'attention' | 'waiting' | 'success' | 'danger' | 'unknown' | 'tentative';
export type DeliveryState = 'queued' | 'retrying' | 'delivered' | 'acknowledged' | 'processed' | 'deadLettered' | 'received' | 'held' | 'cancelled';
export type EmailDeliveryState = 'accepted' | 'delivered' | 'delivery_delayed' | 'bounced' | 'complained' | 'failed' | 'suppressed' | 'received';

export type EventType = 'message' | 'decision' | 'policyEvaluation' | 'toolAction' | 'humanAction' | 'stateChange' | 'error' | 'receipt';
export type HumanActionKey = 'approveOnce' | 'decline' | 'editProposal' | 'pause' | 'resume' | 'revoke' | 'takeOver';

export interface AuthConfig {
  provider: 'local' | 'workos';
  hosted: boolean;
  inviteOnly?: boolean;
  phoneVerification?: boolean;
  totp?: boolean;
  signInPath?: string;
  signUpPath?: string;
  csrfCookieName?: string;
}

export interface Human {
  id: string;
  displayName: string;
  email?: string;
  phoneNumber?: string;
  mfaSetupRequired?: boolean;
  auth?: { provider: string; assurance: string };
}

export interface Organization { id: string; name: string; slug: string; status: string }
export interface Inbox { id: string; organizationId: string; name: string; ownerAgentId: string | null; ownerHumanId: string; parentInboxId?: string | null; kind?: 'workspace' | 'agent'; status: string; createdAt: string; historyDeleted?: boolean; removedAgent?: { id: string; name?: string } }

export interface AgentPresence {
  lastSeenAt: string | null;
  lastSuccessfulRefreshAt: string | null;
  lastWorkClaimAt: string | null;
  lastProcessedAt: string | null;
}

export interface AgentConnection {
  // An open string accepts future server states; consumers show Status unknown.
  state: string;
  asOf: string;
  recentWindowSeconds: number;
  seenAt: string | null;
  credentialExpiresAt: string | null;
  presence: AgentPresence;
}

export interface Agent {
  id: string;
  name: string;
  address: string;
  platformAddress?: string;
  publicEmailAddress?: string | null;
  identity?: { address?: string; externalAddress?: string | null; externalTransportStatus?: string };
  principalHumanId: string;
  status: string;
  onboardingStatus: string;
  permissions: string[];
  capabilities?: string[];
  approvedAt?: string;
  paused?: boolean;
  resumedAt?: string;
  credentialRevoked?: boolean;
  connection?: AgentConnection;
}

export interface ParticipantIdentity {
  id: string;
  type: 'human' | 'internalAgent' | 'externalAgent' | 'organization' | 'connectedService';
  displayName: string;
  orgRef?: string | null;
  organizationId?: string | null;
  inboxId?: string | null;
  accessState?: 'active' | 'pending' | 'approved' | 'blocked' | 'revoked' | 'unavailable';
  address?: string | null;
}

export interface PolicyEvaluation {
  id: string;
  requestedAction: string;
  actor: string;
  matchedPolicyId: string | null;
  decision: 'allow' | 'deny' | 'needsHuman';
  grantType: 'oneTime' | 'categoryBased' | 'ongoing';
  effectiveAt: string;
  expiresAt: string | null;
  reasonCode: string;
}

export interface ProposalOption {
  id: string;
  value: Record<string, unknown>;
  sourceConfidence: 'fromVerifiedProfile' | 'enteredForCase' | 'extractedFromDocument';
  expired: boolean;
  outOfPolicyFlags?: string[];
}

export interface Proposal {
  id: string;
  kind: 'schedule' | 'form' | 'negotiation' | 'document' | 'cancellation';
  options: ProposalOption[];
  status: 'open' | 'countered' | 'accepted' | 'expired' | 'withdrawn';
  acceptedOptionId?: string | null;
  expiresAt: string | null;
  createdAt?: string;
}

export interface CaseEvent {
  id: string;
  type: EventType;
  actor: string;
  createdAt: string;
  payload: Record<string, any>;
  linkedPolicyEvaluation: string | null;
  precedingEventRef: string | null;
  summary?: string;
}

export interface EvidenceItem {
  id: string;
  kind: 'document' | 'calendarReference' | 'confirmationId' | 'externalLink';
  title: string;
  provenance: 'fromVerifiedProfile' | 'enteredForCase' | 'extractedFromDocument';
  url?: string | null;
}

export interface Receipt {
  id: string;
  result: string;
  counterparties?: string[];
  externalIds?: Record<string, unknown>;
  authorityBasis: string;
  humanApprovalStatus: 'approved' | 'notRequired' | 'pending';
  evidenceRefs?: string[];
  createdAt?: string;
}

export interface InboxFolder { id: string; name: string }
export interface InboxPreference { folderId: string | null; read: boolean; archived: boolean; readThrough: string | null; revision: string }

export interface WorkCase {
  caseMode?: 'group';
  members?: Array<{ agentId: string; address: string }>;
  assignments?: Array<{ messageId: string; agentId: string; status: string }>;
  inboxPreference?: InboxPreference;
  id: string;
  schemaVersion?: string;
  objective?: string;
  collaborationMode?: CollaborationMode;
  state?: CaseState;
  stateLabel?: string;
  stateTone?: StateTone;
  bucket?: CaseBucket;
  needsAttention?: boolean;
  nextActor?: string;
  contextualDetail?: string;
  decision?: {
    question: string;
    policyEvaluationId: string | null;
    requestedAction: string | null;
    grantType: string | null;
    expiresAt: string | null;
    availableActions: HumanActionKey[];
  } | null;
  timeline?: Array<{
    id: string;
    type: EventType;
    actorId: string;
    createdAt: string;
    summary: string;
    policyEvaluationId: string | null;
    payload: Record<string, any>;
  }>;
  authority?: Array<{
    id: string;
    requestedAction: string;
    actorId: string;
    policyId: string | null;
    decision: PolicyEvaluation['decision'];
    grantType: PolicyEvaluation['grantType'];
    effectiveAt: string;
    expiresAt: string | null;
    reasonCode: string;
  }>;
  status?: string;
  principal?: string;
  actingAgent?: string;
  participants?: string[];
  participantDirectory?: Record<string, ParticipantIdentity> | ParticipantIdentity[];
  participantAgentIds?: string[];
  participantHumanIds?: string[];
  constraints?: Record<string, unknown>;
  deadline?: string | null;
  authorityRefs?: string[];
  events?: CaseEvent[];
  evidence?: EvidenceItem[];
  proposals?: Proposal[];
  policyEvaluations?: PolicyEvaluation[];
  receipt?: Receipt | null;
  createdAt: string;
  updatedAt?: string;
}

export interface Message {
  id: string;
  caseId: string;
  senderType: 'agent' | 'human';
  senderAgentId?: string;
  senderHumanId?: string;
  recipientAgentId?: string;
  type: string;
  text: string;
  payload?: Record<string, unknown> | null;
  createdAt: string;
  status: DeliveryState | string;
  updatedAt?: string;
  deliveryAttempts?: number;
  lastDeliveryError?: string | null;
}

export type AssetState = 'quarantine' | 'quarantined' | 'scanning' | 'clean' | 'infected' | 'error';
export interface Asset {
  id: string;
  workspaceId?: string;
  caseId: string | null;
  filename?: string;
  name?: string;
  mimeType: string;
  size: number;
  checksumSha256?: string;
  createdByAgentId: string | null;
  state?: AssetState;
  createdAt: string;
  scannedAt?: string | null;
  scan?: { status: 'clean' | 'infected' | 'error'; engine?: string | null; signature?: string | null; message?: string } | null;
}
export interface AuditEvent { id: string; type: string; createdAt: string; [key: string]: unknown }
export interface DeliveryReceipt { id: string; type: 'delivery' | 'email'; transport?: 'native' | 'email'; messageId: string; senderAgentId?: string; recipientAgentId?: string; senderEmail?: string; recipientEmail?: string; state: DeliveryState | EmailDeliveryState; provider?: string; providerMessageId?: string; attempt?: number; error?: string; createdAt: string }
export interface AgentConnectionInvitation {
  id: string;
  fromAddress: string;
  toAddress: string;
  senderAgentId: string;
  recipientAgentId: string;
  direction: 'incoming' | 'outgoing';
  actionable: boolean;
  state: 'pending' | 'accepted' | 'declined' | 'superseded';
  conversationId?: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface AgentConnectionInvitationDecision {
  invitation: AgentConnectionInvitation;
  message?: Message;
}
export interface EmailTransportAgent {
  agentId: string;
  platformAddress?: string;
  publicEmailAddress?: string | null;
  internalAddress?: string;
  externalAddress?: string | null;
  permitted: boolean;
}
export interface ApprovedEmailContact { id: string; email: string; displayName: string; direction: 'inbound' | 'outbound' | 'both'; approved: boolean; blocked: boolean; blockedReason?: string | null; updatedAt: string }
export interface EmailTransportStatus { provider: string; ready: boolean; publicDomain: string | null; domainVerified: boolean; reason: string | null; internalAgentDomain: string; agents: EmailTransportAgent[]; contacts: ApprovedEmailContact[] }
export interface CalendarProvider { id: 'google' | 'outlook'; label: string; configured: boolean }
export interface CalendarConnector { id: string; provider: CalendarProvider['id']; label: string; status: 'connected' | 'disconnected'; accountLabel: string | null; scopes: string[]; expiresAt: string | null; refreshTokenPresent: boolean; connectedByHumanId: string; connectedAt: string; updatedAt: string; disconnectedAt?: string }

export type HistoryCollection = 'cases' | 'messages' | 'assets' | 'recentEvents' | 'deliveryReceipts' | 'invitations' | 'contacts';
export type HistoryMetadata = Partial<Record<HistoryCollection, { total: number; hasMore: boolean; nextCursor: string | null }>>;
export interface WorkspaceRequester { id: string; auth: { provider: string; assurance: string } }
export interface HumanView {
  sourceViews?: HumanView[];
  folders?: InboxFolder[];
  requester?: WorkspaceRequester;
  history?: HistoryMetadata;
  inbox: Inbox;
  mode: 'human-observer';
  canManageInbox: boolean;
  capabilities: string[];
  summary: { agents: number; cases: number; messages: number; assets: number; needsMe: number };
  navigation: { needsMe: number; activeWork: number; waiting: number; completed: number };
  participantDirectory?: Record<string, ParticipantIdentity> | ParticipantIdentity[];
  agents: Agent[];
  caseQueue: WorkCase[];
  cases: WorkCase[];
  messages: Message[];
  assets: Asset[];
  calendarProviders: Record<CalendarProvider['id'], CalendarProvider>;
  calendarConnectors: CalendarConnector[];
  deliveryReceipts: DeliveryReceipt[];
  invitations: AgentConnectionInvitation[];
  contacts?: ApprovedEmailContact[];
  publicEmailTransport?: EmailTransportStatus;
  recentEvents: AuditEvent[];
}

export type NavSection = 'inbox' | 'needsMe' | 'active' | 'waiting' | 'scheduled' | 'documents' | 'completed' | 'policies' | 'integrations' | 'activity';
