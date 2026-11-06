'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import {
  Activity, AlertCircle, Archive, ArrowLeft, ArrowLeftRight, ArrowRight, Bot, CalendarDays, Check, CheckCircle2, ChevronDown,
  ChevronRight, CircleDashed, Clock3, Command, Copy, Database, Download, FileCheck2, FileText, Gauge, Inbox,
  KeyRound, LayoutGrid, Link2, List, ListFilter, Menu, MoreHorizontal, PanelRightClose, PanelRightOpen,
  Folder, Hand, LogOut, Pause, Play, PlugZap, Plus, ReceiptText, RefreshCw, Search, ShieldCheck, Sparkles, Trash2,
  UserRound, UsersRound, X, XCircle, Zap
} from 'lucide-react';
import { ACCOUNT_CHANGED_EVENT, ApiError, SESSION_EXPIRED_EVENT, api, setExpectedHuman } from './api';
import { prepareCaseAssetDownload } from './case-files';
import { fileFolderFor, fileSourceView } from './file-folders';
import LandingPage from './LandingPage';
import { ConnectPage, ConnectionActions } from './onboarding/ConnectPage';
import { agentCatalog, productAsset } from './onboarding/agent-catalog';
import { canReconnectAgent } from './onboarding/types';
import { ClaimPage } from './onboarding/ClaimPage';
import { AuthorizeAgentPage } from './onboarding/AuthorizeAgentPage';
import { authorizationHandle, authorizationSignInPath } from './onboarding/consent-state';
import { OwnerClaims } from './onboarding/OwnerClaims';
import { AgentInstallations } from './onboarding/AgentInstallations';
import { DotsPermissionRecovery, DotsSetupGuide } from './onboarding/DotsSetupGuide';
import { PhaseDTrustControls } from './PhaseDTrustControls';
import { MonadPermissionPanel } from './MonadPermissionPanel';
import { claimSignInPath } from './onboarding/connect-state';
import { CsrfReloadBoundary, createHumanStreamRecovery } from './browser-session-recovery';
import { captureAnalyticsEvent } from './analytics';
import { AgentRemovalDialogContent } from './AgentRemovalDialog';
import { canonicalDecisionPolicy, canSubmitCaseDecision, caseActionPayload } from './case-decisions';
import { CreateInboxFolderContent, MoveInboxCaseContent } from './InboxFolderDialogs';
import { applyInboxPreference, filterInboxCases, readAcknowledgementForCase } from './inbox-preferences';
import { AGENT_PERMISSION_OPTIONS, DEFAULT_AGENT_PERMISSIONS, selectedAgentPermissions } from './agent-permissions';
import { previewRequested } from './preview';
import { agentLabel, connectionLabel } from './agent-presence';
import { mergeHistory, olderCursors } from './history';
import { createEventCursorStore, PROGRESS_ONLY_EVENTS, subscribeReplayRecovery, WORKSPACE_EVENT_TYPES } from './event-replay';
import { applyOrderedViewResponse, applyOrderedViewResponses, createRefreshCoordinator, createViewResponseOrder } from './workspace-refresh';
import { QUIET_VALIDATION_TIMEOUT_MS, SESSION_VALIDATION_TIMEOUT_MS, cachedWorkspaceView, validateWorkspaceReturn, withReadDeadline, workspaceRequester } from './session-validation';
import { RUNTIME_OPTIONS, connectorDownloads, dotsRouteUnavailableNotice, dotsSetupSkillFile, isLoopbackOrigin, runtimeLabel, setupPrompt, setupSkillFile, suggestedAgentAddress, watchEnrollmentStatus, type EnrollmentResult, type EnrollmentStatus } from './quick-connect';
import type { ConnectorRuntime } from '../../sdk/typescript/src/quick-connect';
import { SESSION_ENDED_NOTICE, SessionRequestCancelled, hasRememberedSession, invalidateSessionRequests, isCurrentSession, publishSessionEnd, publishSessionIdentity, rememberSessionStatus, ridesOutTabSwitch, sessionEndedNotice, sessionGeneration, watchSessionLifecycle } from './session-lifecycle';
import {
  STATE_META, assetDisplayName, assetStateMeta, auditSummary, canDownloadAsset, caseCounts, caseLabel, caseState, casesForSection, caseTone, decisionPolicy,
  caseSourceView, caseSubject, localAgentId, eventSummary, exchangeParties, filterAssets, humanize, isExchangeEvent, onboardingSteps, participantIds, resolveParticipant,
  sectionForCase, stateLabel, timelineForCase
} from './model';
import type {
  Agent, AgentConnectionInvitation, ApprovedEmailContact, Asset, AuthConfig, CaseEvent, CaseState, EmailTransportStatus, EvidenceItem, Human, HumanActionKey,
  HumanView, Inbox as Workspace, InboxPreference, NavSection, Organization, PolicyEvaluation, ProposalOption, WorkCase
} from './types';

const WORKSPACE_KEY = 'envoi.workspace';
const caseSections: NavSection[] = ['inbox', 'needsMe', 'active', 'waiting', 'completed'];

type BootState = 'loading' | 'signedOut' | 'setup' | 'ready' | 'error';

const previewHuman: Human = { id: 'human_preview', displayName: 'Rachel' };
const previewWorkspace: Workspace = { id: 'inbox_preview', organizationId: 'org_preview', name: 'Rachel’s agent studio', ownerAgentId: 'agent_milo', ownerHumanId: previewHuman.id, status: 'active', createdAt: '2026-09-01T14:00:00.000Z' };
const previewAgents: Agent[] = [
  { id: 'agent_milo', name: 'Milo', address: 'milo@agents.envoi-agents.com', principalHumanId: previewHuman.id, status: 'active', onboardingStatus: 'approved', permissions: ['send_agent_messages', 'receive_agent_messages', 'execute_cases'] }
];
export const previewView: HumanView = {
  folders: [{ id: 'folder_preview', name: 'Launch' }],
  inbox: previewWorkspace,
  mode: 'human-observer',
  canManageInbox: true,
  capabilities: ['observe_agent_communications', 'receive_agent_messages', 'reply_to_approved_agents', 'review_assets'],
  summary: { agents: 1, cases: 4, messages: 0, assets: 2, needsMe: 1 },
  navigation: { needsMe: 1, activeWork: 1, waiting: 1, completed: 1 },
  agents: previewAgents,
  invitations: [],
  participantDirectory: {
    human_preview: { id: 'human_preview', type: 'human', displayName: 'Rachel', accessState: 'active' },
    agent_milo: { id: 'agent_milo', type: 'internalAgent', displayName: 'Milo', address: 'milo@agents.envoi-agents.com', accessState: 'active' },
    agent_luma: { id: 'agent_luma', type: 'externalAgent', displayName: 'Luma Events agent', address: 'hello@luma.events', accessState: 'active' },
    agent_jordan: { id: 'agent_jordan', type: 'externalAgent', displayName: 'Jordan’s scheduling agent', address: 'calendar@jordan.ai', accessState: 'active' },
    agent_atlas: { id: 'agent_atlas', type: 'externalAgent', displayName: 'Atlas Research agent', address: 'research@atlas.team', accessState: 'active' }
  },
  cases: [
    {
      id: 'conversation_dinner_deposit', schemaVersion: '1.0', objective: 'Finalize the Design Week dinner venue', state: 'waitingForHuman', principal: previewHuman.id, actingAgent: 'agent_milo', participants: ['agent_milo', 'agent_luma'], constraints: { budget: '$2,400', guests: 18 }, authorityRefs: [], evidence: [], receipt: null,
      proposals: [{ id: 'proposal_dinner', kind: 'negotiation', status: 'countered', expiresAt: '2026-09-28T18:00:00.000Z', createdAt: '2026-09-27T13:15:00.000Z', options: [{ id: 'option_original', value: { title: '$2,650 with private room' }, sourceConfidence: 'enteredForCase', expired: true, outOfPolicyFlags: [] }, { id: 'option_counter', value: { title: '$2,350 with deposit due today' }, sourceConfidence: 'enteredForCase', expired: false, outOfPolicyFlags: ['paymentRequiresApproval'] }] }],
      policyEvaluations: [{ id: 'policy_deposit', requestedAction: 'payments.sendDeposit', actor: 'agent_milo', matchedPolicyId: 'permission:payments', decision: 'needsHuman', grantType: 'oneTime', effectiveAt: '2026-09-27T15:42:00.000Z', expiresAt: '2026-09-28T18:00:00.000Z', reasonCode: 'paymentRequiresApproval' }],
      events: [
        { id: 'evt_dinner_owner', type: 'message', actor: previewHuman.id, createdAt: '2026-09-27T13:12:00.000Z', payload: { messageType: 'instruction', text: 'Keep the venue within $2,400. Ask me before paying a deposit.', senderType: 'human', senderHumanId: previewHuman.id, recipientAgentId: 'agent_milo', deliveryState: 'delivered' }, linkedPolicyEvaluation: null, precedingEventRef: null },
        { id: 'evt_dinner_1', type: 'message', actor: 'agent_milo', createdAt: '2026-09-27T13:15:00.000Z', payload: { messageType: 'proposal', text: 'I asked Luma to bring the venue within your $2,400 budget.', senderAgentId: 'agent_milo', recipientAgentId: 'agent_luma', deliveryState: 'delivered', proposalId: 'proposal_dinner', status: 'open' }, linkedPolicyEvaluation: null, precedingEventRef: null },
        { id: 'evt_dinner_2', type: 'message', actor: 'agent_luma', createdAt: '2026-09-27T15:36:00.000Z', payload: { messageType: 'counterproposal', text: 'Luma can do $2,350 if the deposit is paid today.', senderAgentId: 'agent_luma', recipientAgentId: 'agent_milo', deliveryState: 'received', proposalId: 'proposal_dinner', status: 'countered' }, linkedPolicyEvaluation: null, precedingEventRef: 'evt_dinner_1' },
        { id: 'evt_dinner_3', type: 'policyEvaluation', actor: 'agent_milo', createdAt: '2026-09-27T15:42:00.000Z', payload: { requestedAction: 'payments.sendDeposit', decision: 'needsHuman' }, linkedPolicyEvaluation: 'policy_deposit', precedingEventRef: 'evt_dinner_2' }
      ], createdAt: '2026-09-27T13:10:00.000Z', updatedAt: '2026-09-27T15:42:00.000Z'
    },
    {
      id: 'conversation_planning_call', schemaVersion: '1.0', objective: 'Find a time for the product planning call', state: 'waitingForExternalParty', principal: previewHuman.id, actingAgent: 'agent_milo', participants: ['agent_milo', 'agent_jordan'], constraints: { duration: '45 minutes', timezone: 'America/Toronto' }, authorityRefs: [], evidence: [], receipt: null, policyEvaluations: [],
      proposals: [{ id: 'proposal_planning', kind: 'schedule', status: 'open', expiresAt: '2026-09-29T16:00:00.000Z', createdAt: '2026-09-27T14:00:00.000Z', options: [{ id: 'option_tuesday', value: { start: '2026-09-29T15:00:00.000Z', end: '2026-09-29T15:45:00.000Z', timezone: 'America/Toronto' }, sourceConfidence: 'fromVerifiedProfile', expired: false, outOfPolicyFlags: [] }] }],
      events: [{ id: 'evt_planning_1', type: 'message', actor: 'agent_milo', createdAt: '2026-09-27T14:05:00.000Z', payload: { messageType: 'proposal', text: 'I sent Tuesday at 11:00 AM as the best overlap across both calendars.', senderAgentId: 'agent_milo', recipientAgentId: 'agent_jordan', deliveryState: 'delivered', proposalId: 'proposal_planning', status: 'open' }, linkedPolicyEvaluation: null, precedingEventRef: null }],
      createdAt: '2026-09-27T13:50:00.000Z', updatedAt: '2026-09-27T14:05:00.000Z'
    },
    {
      id: 'conversation_research_brief', schemaVersion: '1.0', objective: 'Share the Q4 research brief with the launch team', state: 'inProgress', principal: previewHuman.id, actingAgent: 'agent_milo', participants: ['agent_milo', 'agent_atlas'], constraints: { audience: 'Launch team' }, authorityRefs: [], policyEvaluations: [], receipt: null,
      evidence: [{ id: 'evidence_brief', kind: 'document', title: 'Q4 customer research brief', provenance: 'extractedFromDocument', url: null }], proposals: [{ id: 'proposal_brief', kind: 'document', status: 'open', expiresAt: null, createdAt: '2026-09-27T12:00:00.000Z', options: [{ id: 'option_brief', value: { title: 'Share research brief and three key takeaways' }, sourceConfidence: 'extractedFromDocument', expired: false, outOfPolicyFlags: [] }] }],
      events: [{ id: 'evt_brief_1', type: 'message', actor: 'agent_atlas', createdAt: '2026-09-27T12:24:00.000Z', payload: { messageType: 'message', text: 'Atlas added the latest interview synthesis and source notes.', senderAgentId: 'agent_atlas', recipientAgentId: 'agent_milo', deliveryState: 'received' }, linkedPolicyEvaluation: null, precedingEventRef: null }],
      createdAt: '2026-09-27T11:40:00.000Z', updatedAt: '2026-09-27T12:24:00.000Z'
    },
    {
      id: 'conversation_studio_booking', schemaVersion: '1.0', objective: 'Book the podcast studio for launch week', state: 'completed', principal: previewHuman.id, actingAgent: 'agent_milo', participants: ['agent_milo', 'agent_luma'], constraints: {}, authorityRefs: [], evidence: [], proposals: [], policyEvaluations: [], events: [],
      receipt: { id: 'receipt_studio', result: 'Studio booked for October 6 at 2:00 PM', authorityBasis: 'calendar.booking', humanApprovalStatus: 'notRequired', createdAt: '2026-09-26T19:10:00.000Z' }, createdAt: '2026-09-26T18:30:00.000Z', updatedAt: '2026-09-26T19:10:00.000Z'
    }
  ],
  caseQueue: [], messages: [], assets: [
    { id: 'asset_brief', workspaceId: previewWorkspace.id, caseId: 'conversation_research_brief', filename: 'Q4-customer-research.pdf', mimeType: 'application/pdf', size: 842_112, createdByAgentId: 'agent_atlas', state: 'clean', createdAt: '2026-09-27T12:22:00.000Z', scannedAt: '2026-09-27T12:23:00.000Z', scan: { status: 'clean', engine: 'Envoi Guard' } },
    { id: 'asset_sources', workspaceId: previewWorkspace.id, caseId: 'conversation_research_brief', filename: 'interview-source-notes.csv', mimeType: 'text/csv', size: 93_408, createdByAgentId: 'agent_atlas', state: 'scanning', createdAt: '2026-09-27T12:24:00.000Z', scannedAt: null, scan: null }
  ], calendarProviders: {
    google: { id: 'google', label: 'Google Calendar', configured: false },
    outlook: { id: 'outlook', label: 'Outlook Calendar', configured: false }
  }, calendarConnectors: [], deliveryReceipts: [], recentEvents: []
};

previewView.caseQueue = previewView.cases.map(workCase => {
  const state = caseState(workCase);
  const section = sectionForCase(workCase);
  const bucket = section === 'active' ? 'activeWork' : section === 'needsMe' || section === 'waiting' || section === 'completed' ? section : 'activeWork';
  const collaborationMode = workCase.proposals?.[0]?.kind === 'schedule' ? 'scheduling' : workCase.proposals?.[0]?.kind === 'negotiation' ? 'negotiation' : workCase.proposals?.[0]?.kind === 'document' ? 'artifactCreation' : 'collaboration';
  const policy = decisionPolicy(workCase);
  const inboxPreference = { folderId: null, read: bucket !== 'needsMe', archived: section === 'completed', readThrough: bucket === 'needsMe' ? null : '0'.repeat(64), revision: '0'.repeat(64) };
return { ...workCase, inboxPreference, collaborationMode, stateLabel: STATE_META[state].label, stateTone: STATE_META[state].tone, bucket, needsAttention: bucket === 'needsMe', nextActor: STATE_META[state].description, contextualDetail: STATE_META[state].description, decision: bucket === 'needsMe' ? { question: policy ? `${humanize(policy.requestedAction)} needs your approval.` : 'Your agents need your judgment before they continue.', policyEvaluationId: policy?.id || null, requestedAction: policy?.requestedAction || null, grantType: policy?.grantType || null, expiresAt: policy?.expiresAt || null, availableActions: state === 'waitingForHuman' || state === 'tentativeHold' ? ['approveOnce', 'editProposal', 'decline', 'takeOver'] : ['takeOver', 'pause'] } : null };
});
export default function App() {
  return <CsrfReloadBoundary>{typeof window !== 'undefined' && window.location.pathname === '/connect' ? <ConnectPage /> : <WorkspaceApp />}</CsrfReloadBoundary>;
}

function WorkspaceApp() {
  const isPreview = typeof window !== 'undefined' && previewRequested(window.location.search, import.meta.env.DEV);
  const isLandingPreview = import.meta.env.DEV && typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('landing-preview');
  const [boot, setBoot] = useState<BootState>('loading');
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [human, setHuman] = useState<Human | null>(null);
  const humanRef = useRef(human);
  humanRef.current = human;
  const loadAccountRef = useRef<() => Promise<void>>(async () => undefined);
  const revalidateAccountRef = useRef<(quiet?: boolean) => Promise<void>>(async () => undefined);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [view, setView] = useState<HumanView | null>(null);
  // Only reuse views authorized for this human in the current browser session.
  // A fresh server read still checks access and replaces each reused snapshot.
  const workspaceViewCache = useRef<Record<string, HumanView>>({});
  const rootPrefetch = useRef<AbortController | null>(null);
  // Child snapshots stay available across workspace switches within one
  // authenticated session. AppShell unmounts while the selected view reloads.
  const childViewCache = useRef<Record<string, HumanView>>({});
  const [requestedSection, setRequestedSection] = useState<NavSection>('inbox');
  const [error, setError] = useState('');
  const [authNotice, setAuthNotice] = useState(() => new URLSearchParams(window.location.search).has('auth_error')
    ? 'Sign-in could not be completed. Please try again.'
    : sessionEndedNotice());
  const [syncNotice, setSyncNotice] = useState('');
  const [historyBusy, setHistoryBusy] = useState(false);
  const [sessionCheck, setSessionCheck] = useState<'checking' | 'error' | null>(null);
  const sessionCheckRef = useRef(sessionCheck);
  sessionCheckRef.current = sessionCheck;
  const bootRef = useRef(boot);
  bootRef.current = boot;
  const recordedAppOpen = useRef(false);
  useEffect(() => {
    if (boot === 'ready' && !isPreview && !recordedAppOpen.current) {
      recordedAppOpen.current = true;
      captureAnalyticsEvent('beta_app_opened');
    } else if (boot === 'signedOut') {
      recordedAppOpen.current = false;
    }
  }, [boot, isPreview]);
  const activeWorkspace = useRef<string | null>(null);
  const hadAuthenticatedSession = useRef(false);
  const stopLiveUpdates = useRef<(() => void) | null>(null);
  const signingOut = useRef(false);
  const endedElsewhere = useRef(false);
  const loadRodeOutTabSwitch = useRef(false);
  const validation = useRef<AbortController | null>(null);
  const viewRequests = useRef(new AbortController());
  const viewOrder = useRef(createViewResponseOrder());
  const eventCursors = useRef(createEventCursorStore());
  const quietReads = useRef<{ workspaceId: string; generation: number; coordinator: ReturnType<typeof createRefreshCoordinator<HumanView>> } | null>(null);

  const cancelWorkspaceReads = useCallback(() => {
    quietReads.current?.coordinator.cancel();
    quietReads.current = null;
    viewRequests.current.abort(new SessionRequestCancelled());
    viewRequests.current = new AbortController();
    viewOrder.current.reset();
  }, []);

  const clearPrivateState = useCallback(() => {
    validation.current?.abort(new SessionRequestCancelled());
    validation.current = null;
    cancelWorkspaceReads();
    eventCursors.current.clear();
    invalidateSessionRequests();
    stopLiveUpdates.current?.();
    stopLiveUpdates.current = null;
    activeWorkspace.current = null;
    humanRef.current = null;
    setHuman(null);
    setOrganizations([]);
    setWorkspaces([]);
    setWorkspace(null);
    setView(null);
    rootPrefetch.current?.abort();
    rootPrefetch.current = null;
    workspaceViewCache.current = {};
    childViewCache.current = {};
    setError('');
    setRequestedSection('inbox');
    setSyncNotice('');
    setHistoryBusy(false);
    sessionCheckRef.current = null;
    setSessionCheck(null);
  }, [cancelWorkspaceReads]);

  const endSession = useCallback((broadcast = true) => {
    clearPrivateState();
    if (hadAuthenticatedSession.current || hasRememberedSession()) {
      rememberSessionStatus('ended');
      setAuthNotice(SESSION_ENDED_NOTICE);
    }
    hadAuthenticatedSession.current = false;
    try { localStorage.removeItem(WORKSPACE_KEY); } catch { /* Optional preference storage. */ }
    setBoot('signedOut');
    if (broadcast) publishSessionEnd();
  }, [clearPrivateState]);

  // A single failed request does not prove the browser session has ended.
  // Check the account in the background while keeping the inbox mounted;
  // only a confirmed 401 may replace it with the sign-in screen.
  const expireSession = useCallback(() => {
    if (bootRef.current === 'ready' && hadAuthenticatedSession.current) void revalidateAccountRef.current(true);
  }, []);

  const loseWorkspaceAccess = useCallback((workspaceId: string) => {
    if (activeWorkspace.current !== workspaceId) return;
    clearPrivateState();
    setError('Your access to this workspace changed. Refresh your account to continue.');
    setBoot('error');
  }, [clearPrivateState]);

  const checkViewIdentity = useCallback((next: HumanView, workspaceId: string) => {
    const actor = workspaceRequester(next, workspaceId);
    if (actor && (actor.id !== humanRef.current?.id || actor.auth.assurance === 'phone')) {
      // Cookie/account changes can happen during ordinary polling as well as a
      // focus check. Clear the former account before applying its replacement.
      void loadAccountRef.current();
      throw new SessionRequestCancelled();
    }
  }, []);

  const loadView = useCallback(async (workspaceId: string, quiet = false) => {
    const generation = sessionGeneration();
    if (!quiet) activeWorkspace.current = workspaceId;
    if (activeWorkspace.current !== workspaceId) throw new SessionRequestCancelled();
    const ticket = viewOrder.current.begin();
    if (!quiet) setView(cachedWorkspaceView(workspaceViewCache.current, workspaceId, humanRef.current?.id || ''));
    try {
      const next = await api.humanView(workspaceId, undefined, viewRequests.current.signal);
      if (!isCurrentSession(generation) || !viewOrder.current.isCurrent(ticket) || activeWorkspace.current !== workspaceId) throw new SessionRequestCancelled();
      checkViewIdentity(next, workspaceId);
      workspaceViewCache.current[workspaceId] = next;
      setView(current => {
        if (!isCurrentSession(generation) || activeWorkspace.current !== workspaceId) return current;
        return applyOrderedViewResponse<HumanView | null>(current, next, viewOrder.current, ticket, (previous, incoming, stale) => incoming ? quiet ? mergeHistory(previous, incoming, undefined, stale) : incoming : previous);
      });
      return next;
    } catch (caught) {
      if (isCurrentSession(generation) && viewOrder.current.isCurrent(ticket) && caught instanceof ApiError && caught.status === 403) loseWorkspaceAccess(workspaceId);
      if (isCurrentSession(generation) && viewOrder.current.isCurrent(ticket) && caught instanceof ApiError && caught.status === 401) {
        delete workspaceViewCache.current[workspaceId];
        setView(null);
        expireSession();
      }
      throw caught;
    }
  }, [checkViewIdentity, expireSession, loseWorkspaceAccess]);

  const quietRefresh = useCallback((workspaceId: string) => {
    const generation = sessionGeneration();
    if (!quietReads.current || quietReads.current.workspaceId !== workspaceId || quietReads.current.generation !== generation) {
      quietReads.current?.coordinator.cancel();
      quietReads.current = {
        workspaceId, generation,
        coordinator: createRefreshCoordinator(() => loadView(workspaceId, true), () => isCurrentSession(generation) && activeWorkspace.current === workspaceId && !sessionCheckRef.current)
      };
    }
    return quietReads.current.coordinator.refresh();
  }, [loadView]);

  const loadWorkspaceDirectory = useCallback(async (signal?: AbortSignal) => {
    const generation = sessionGeneration();
    const nextOrganizations = await api.organizations(signal);
    if (!isCurrentSession(generation)) throw new SessionRequestCancelled();
    const workspaceGroups = await Promise.all(nextOrganizations.map(item => api.workspaces(item.id, signal)));
    if (!isCurrentSession(generation)) throw new SessionRequestCancelled();
    const nextWorkspaces = workspaceGroups.flat();
    setOrganizations(nextOrganizations);
    setWorkspaces(nextWorkspaces);
    return nextWorkspaces;
  }, []);

  async function loadOlder() {
    const generation = sessionGeneration();
    if (!view || historyBusy) return;
    const workspaceId = view.inbox.id;
    const cursors = olderCursors(view);
    if (!Object.keys(cursors).length) return;
    setHistoryBusy(true);
    const ticket = viewOrder.current.begin();
    try {
      const next = await api.humanView(workspaceId, cursors, viewRequests.current.signal);
      if (isCurrentSession(generation) && viewOrder.current.isCurrent(ticket) && activeWorkspace.current === workspaceId) {
        checkViewIdentity(next, workspaceId);
        setView(current => {
          if (!isCurrentSession(generation) || activeWorkspace.current !== workspaceId) return current;
          return applyOrderedViewResponse<HumanView | null>(current, next, viewOrder.current, ticket, (previous, incoming, stale) => previous && incoming ? mergeHistory(previous, incoming, cursors, stale) : previous);
        });
      }
    } catch (caught) {
      if (!isCurrentSession(generation) || !viewOrder.current.isCurrent(ticket)) return;
      if (caught instanceof ApiError && caught.status === 403) loseWorkspaceAccess(workspaceId);
      else setSyncNotice(errorMessage(caught));
    }
    finally { if (isCurrentSession(generation) && viewOrder.current.isCurrent(ticket)) setHistoryBusy(false); }
  }

  const loadAccount = useCallback(async () => {
    if (signingOut.current || endedElsewhere.current) return;
    clearPrivateState();
    const generation = sessionGeneration();
    try {
      setBoot('loading');
      setError('');
      const nextConfig = await api.authConfig();
      if (!isCurrentSession(generation)) return;
      setConfig(nextConfig);
      const nextHuman = await api.me(undefined, false);
      if (!isCurrentSession(generation)) return;
      humanRef.current = nextHuman;
      setHuman(nextHuman);
      if (nextHuman.auth?.assurance === 'phone') {
        if (typeof nextHuman.mfaSetupRequired !== 'boolean') throw new Error('Authentication service needs an update before sign in can continue.');
        setBoot('signedOut');
        return;
      }
      hadAuthenticatedSession.current = true;
      publishSessionIdentity(nextHuman.id);
      const nextWorkspaces = await loadWorkspaceDirectory();
      if (!isCurrentSession(generation)) return;
      const savedId = localStorage.getItem(WORKSPACE_KEY);
      const selected = nextWorkspaces.find(item => item.id === savedId) || nextWorkspaces[0] || null;
      if (!selected) {
        setWorkspace(null);
        rememberSessionStatus('active');
        setAuthNotice('');
        setBoot('setup');
        return;
      }
      setWorkspace(selected);
      localStorage.setItem(WORKSPACE_KEY, selected.id);
      await loadView(selected.id);
      if (!isCurrentSession(generation)) return;
      rememberSessionStatus('active');
      setAuthNotice('');
      setBoot('ready');
    } catch (caught) {
      if (!isCurrentSession(generation)) return;
      const nextConfig = config || await api.authConfig().catch(() => null);
      if (!isCurrentSession(generation)) return;
      if (nextConfig) setConfig(nextConfig);
      if (caught instanceof ApiError && caught.status === 401) {
        endSession();
      } else {
        setError(caught instanceof Error ? caught.message.replace(/\bEnvoi\b/gi, 'Envoi') : 'Envoi could not load your workspace.');
        setBoot('error');
      }
    }
  }, [clearPrivateState, config, endSession, loadView, loadWorkspaceDirectory]);

  loadAccountRef.current = loadAccount;

  useEffect(() => {
    const parentId = workspace?.kind === 'agent' ? workspace.parentInboxId : null;
    if (boot !== 'ready' || !parentId || !human || workspaceViewCache.current[parentId] || rootPrefetch.current) return;
    const generation = sessionGeneration();
    const controller = new AbortController();
    rootPrefetch.current = controller;
    void api.humanView(parentId, undefined, controller.signal).then(next => {
      if (isCurrentSession(generation) && cachedWorkspaceView({ [parentId]: next }, parentId, human.id)) {
        workspaceViewCache.current[parentId] = next;
      }
    }).catch(() => {}).finally(() => {
      if (rootPrefetch.current === controller) rootPrefetch.current = null;
    });
  }, [boot, human?.id, workspace?.id, workspace?.kind, workspace?.parentInboxId]);

  const revalidateAccount = useCallback(async (quiet = false) => {
    if (signingOut.current || endedElsewhere.current) return;
    // A background check never takes over the screen or reloads the account just to retry.
    if (quiet && (boot !== 'ready' || !human || !workspace)) return;
    if (boot !== 'ready' || !human || !workspace) { await loadAccount(); return; }
    if (validation.current && !validation.current.signal.aborted) return;
    const generation = sessionGeneration();
    const controller = new AbortController();
    validation.current = controller;
    const ticket = viewOrder.current.begin();
    if (!quiet) {
      sessionCheckRef.current = 'checking';
      setSessionCheck('checking');
      setError('');
    }
    try {
      const result = await withReadDeadline(controller, signal => validateWorkspaceReturn(human.id, workspace.id, config?.provider || '', signal, {
        snapshot: signal => api.sessionView(workspace.id, signal),
        identity: signal => api.me(signal, false),
        directory: loadWorkspaceDirectory,
        legacyView: signal => api.humanView(workspace.id, undefined, signal)
      }), quiet ? QUIET_VALIDATION_TIMEOUT_MS : SESSION_VALIDATION_TIMEOUT_MS);
      if (!isCurrentSession(generation) || validation.current !== controller || !viewOrder.current.isCurrent(ticket)) return;
      controller.signal.throwIfAborted();
      if (result.kind === 'account') {
        validation.current = null;
        await loadAccount();
        return;
      }
      if (result.kind === 'denied') { loseWorkspaceAccess(workspace.id); return; }
      const stale = viewOrder.current.accept(ticket);
      setView(current => mergeHistory(current, result.view, undefined, stale));
      setHuman(result.human || { ...human, auth: result.requester?.auth || human.auth });
      rememberSessionStatus('active');
      setAuthNotice('');
      sessionCheckRef.current = null;
      setSessionCheck(null);
      // Directory enumeration is metadata work once the authorized snapshot has
      // validated this account and workspace. Keep it off the blocking path.
      if (!result.directoryLoaded) {
        void loadWorkspaceDirectory(viewRequests.current.signal).then(items => {
          if (isCurrentSession(generation) && activeWorkspace.current === workspace.id && !items.some(item => item.id === workspace.id)) loseWorkspaceAccess(workspace.id);
        }).catch(() => {
          if (isCurrentSession(generation) && activeWorkspace.current === workspace.id) setSyncNotice('Your workspace list could not be refreshed. Try refreshing the workspace.');
        });
      }
    } catch (caught) {
      if (!isCurrentSession(generation) || validation.current !== controller) return;
      if (caught instanceof ApiError && caught.status === 401) endSession();
      else if (quiet) setSyncNotice('We could not confirm your session after you returned. Your workspace will keep retrying.');
      else {
        setError(errorMessage(caught));
        sessionCheckRef.current = 'error';
        setSessionCheck('error');
      }
    } finally { if (validation.current === controller) validation.current = null; }
  }, [boot, config, endSession, human, loadAccount, loadWorkspaceDirectory, loseWorkspaceAccess, workspace]);
  revalidateAccountRef.current = revalidateAccount;

  useEffect(() => { if (!isPreview && !isLandingPreview) void loadAccount(); }, [isPreview, isLandingPreview]);

  useEffect(() => {
    if (isPreview || isLandingPreview) return;
    window.addEventListener(SESSION_EXPIRED_EVENT, expireSession);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, expireSession);
  }, [expireSession, isPreview, isLandingPreview]);

  useEffect(() => {
    if (isPreview || isLandingPreview) return;
    const reload = () => { if (!signingOut.current && !endedElsewhere.current && bootRef.current !== 'signedOut') void loadAccountRef.current(); };
    window.addEventListener(ACCOUNT_CHANGED_EVENT, reload);
    return () => window.removeEventListener(ACCOUNT_CHANGED_EVENT, reload);
  }, [isPreview, isLandingPreview]);

  useEffect(() => { setExpectedHuman(human?.id ?? null); }, [human?.id]);

  useEffect(() => {
    if (isPreview) return;
    return watchSessionLifecycle(window, document, {
      isActive: () => hadAuthenticatedSession.current && !signingOut.current && !endedElsewhere.current && bootRef.current !== 'signedOut',
      suspend: reason => {
        if (ridesOutTabSwitch(reason, bootRef.current)) { loadRodeOutTabSwitch.current = true; return; }
        loadRodeOutTabSwitch.current = false;
        // History snapshots discard private state. Ordinary tab switches keep
        // drafts mounted but hidden and inert until authorization is checked.
        flushSync(() => {
          if (reason === 'history' || bootRef.current !== 'ready') { clearPrivateState(); setBoot('loading'); }
          else {
            validation.current?.abort(new SessionRequestCancelled());
            validation.current = null;
            cancelWorkspaceReads();
            invalidateSessionRequests();
            stopLiveUpdates.current?.();
            stopLiveUpdates.current = null;
            setHistoryBusy(false);
            sessionCheckRef.current = 'checking';
            setSessionCheck('checking');
          }
        });
      },
      resume: reason => {
        if (reason === 'tab' && loadRodeOutTabSwitch.current) { loadRodeOutTabSwitch.current = false; return; }
        if (reason === 'quiet') { void revalidateAccountRef.current(true); return; }
        if (reason === 'history') void loadAccountRef.current(); else void revalidateAccountRef.current();
      },
      identityAnnounced: humanId => {
        const current = humanRef.current;
        if (signingOut.current || endedElsewhere.current || bootRef.current === 'signedOut' || !current || current.id === humanId) return;
        void loadAccountRef.current();
      },
      endedElsewhere: () => {
        if (bootRef.current === 'signedOut') return;
        endedElsewhere.current = true;
        flushSync(() => endSession(false));
      }
    });
  }, [cancelWorkspaceReads, clearPrivateState, endSession, isPreview]);

  useEffect(() => {
    if (boot !== 'ready' || sessionCheck || !workspace || !config || !human) return;
    const generation = sessionGeneration();
    let stopped = false;
    const current = () => !stopped && isCurrentSession(generation) && activeWorkspace.current === workspace.id && !sessionCheckRef.current;
    const cursor = eventCursors.current.scope(human.id, workspace.id, current);
    const refresh = () => {
      if (!current()) return;
      void quietRefresh(workspace.id).then(() => {
        if (current()) setSyncNotice('');
      }).catch(caught => {
        if (current() && !(caught instanceof ApiError && caught.status === 401)) setSyncNotice('Live updates are temporarily paused. Your workspace will keep retrying.');
      });
    };
    const stream = new EventSource(cursor.url());
    const stopReplayRecovery = subscribeReplayRecovery(stream, refresh, message => { if (current()) setSyncNotice(message); });
    const dataEvent = (event: Event) => {
      if (!current()) return;
      cursor.record(event);
      if (!PROGRESS_ONLY_EVENTS.has(event.type)) refresh();
    };
    const refreshDirectory = () => { if (current()) void loadWorkspaceDirectory(viewRequests.current.signal).catch(() => { if (current()) setSyncNotice('A new agent inbox may be available. Refresh the page to see it.'); }); };
    stream.onopen = () => { if (current()) setSyncNotice(''); };
    stream.onmessage = dataEvent;
    WORKSPACE_EVENT_TYPES.forEach(type => stream.addEventListener(type, dataEvent));
    stream.addEventListener('agent.inbox_created', refreshDirectory);
    stream.addEventListener('agent.removed', refreshDirectory);
    stream.addEventListener('ready', event => { if (current()) { if (cursor.record(event, true)) refresh(); setSyncNotice(''); } });
    const terminate = () => { if (current()) expireSession(); };
    stream.addEventListener('session.expired', terminate);
    stream.addEventListener('session.revoked', terminate);
    stream.addEventListener('session.recheck', () => { if (current()) void api.me().catch(() => undefined); });
    const recoverStream = createHumanStreamRecovery({
      isCurrent: current,
      checkSession: () => api.me(undefined, false),
      onExpired: () => window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT)),
      onUnavailable: () => setSyncNotice('Live updates are reconnecting. You can refresh now or keep working.')
    });
    stream.onerror = () => { void recoverStream(); };
    const interval = window.setInterval(refresh, 30_000);
    const stop = () => { stopped = true; window.clearInterval(interval); stopReplayRecovery(); WORKSPACE_EVENT_TYPES.forEach(type => stream.removeEventListener(type, dataEvent)); stream.removeEventListener('agent.inbox_created', refreshDirectory); stream.close(); };
    stopLiveUpdates.current = stop;
    return () => { stop(); if (stopLiveUpdates.current === stop) stopLiveUpdates.current = null; };
  }, [boot, config, expireSession, human?.id, quietRefresh, loadWorkspaceDirectory, sessionCheck, workspace]);

  async function selectWorkspace(next: Workspace) {
    cancelWorkspaceReads();
    setHistoryBusy(false);
    setWorkspace(next);
    localStorage.setItem(WORKSPACE_KEY, next.id);
    await loadView(next.id);
  }

  async function createWorkspace(name: string) {
    const generation = sessionGeneration();
    const created = await api.createWorkspace(name, organizations[0]?.id);
    if (!isCurrentSession(generation)) return;
    setWorkspaces(current => [...current, created]);
    setWorkspace(created);
    localStorage.setItem(WORKSPACE_KEY, created.id);
    await loadView(created.id);
    if (!isCurrentSession(generation)) return;
    setBoot('ready');
  }

  async function logout() {
    signingOut.current = true;
    flushSync(() => { endSession(); setBoot('loading'); });
    try {
      const result = await api.logout();
      window.location.replace(result.logoutUrl || '/');
    } catch (caught) {
      // Do not expose the old workspace or permit revalidation while logout
      // has not been confirmed by the server. The user can retry the POST.
      setError(`Sign out could not be completed. ${errorMessage(caught)}`);
      setBoot('error');
    }
  }

  const renderedGeneration = sessionGeneration();
  const checkRenderedSession = () => { if (!isCurrentSession(renderedGeneration) || sessionCheckRef.current) throw new SessionRequestCancelled(); };
  if (isLandingPreview) return <LandingPage signInPath={`${import.meta.env.VITE_PUBLIC_URL || 'https://www.envoi-agents.com'}/api/auth/workos/sign-in`} />;
  if (isPreview) return <AppShell config={{ provider: 'local', hosted: false }} human={previewHuman} organizations={[]} workspaces={[previewWorkspace]} workspace={previewWorkspace} view={previewView} onSelectWorkspace={async () => undefined} onRefresh={async () => previewView} onLogout={async () => undefined} syncNotice="" />;
  if (boot === 'loading') return <LoadingScreen checking={hadAuthenticatedSession.current || signingOut.current} onLogout={hadAuthenticatedSession.current && !signingOut.current ? () => { void logout(); } : undefined} />;
  if (boot === 'signedOut' && config) {
    if (config.provider === 'workos') {
      if (window.location.pathname === '/app') return authNotice
        ? <AuthScreen config={config} notice={authNotice} onAuthenticated={async () => { endedElsewhere.current = false; await loadAccount(); }} />
        : <PublicSiteRedirect />;
      return <LandingPage signInPath={window.location.pathname === '/authorize-agent' ? authorizationSignInPath(config.signInPath || '/api/auth/workos/sign-in', window.location.search) : window.location.pathname === '/claim' ? claimSignInPath(config.signInPath || '/api/auth/workos/sign-in') : config.signInPath || '/api/auth/workos/sign-in'} notice={authNotice} />;
    }
    return <AuthScreen config={config} notice={authNotice} resumePhoneSession={human?.auth?.assurance === 'phone' ? human.mfaSetupRequired : undefined} onAuthenticated={async () => { endedElsewhere.current = false; await loadAccount(); }} />;
  }
  if (boot === 'setup' && human) return <><SignOutControl onLogout={() => { void logout(); }} /><WorkspaceSetup human={human} onCreate={async name => { checkRenderedSession(); await createWorkspace(name); }} /></>;
  if (boot === 'error') return <FailureScreen message={error} title={signingOut.current ? 'Sign out incomplete' : undefined} retryLabel={signingOut.current ? 'Retry sign out' : undefined} onRetry={signingOut.current ? logout : loadAccount} onLogout={signingOut.current || hadAuthenticatedSession.current ? () => { void logout(); } : undefined} />;
  if (!human || !workspace || !view || !config) return <LoadingScreen />;

  return (
    <>
    <div hidden={Boolean(sessionCheck)} inert={Boolean(sessionCheck)} aria-hidden={Boolean(sessionCheck)}>
    <AppShell
      config={config}
      human={human}
      organizations={organizations}
      workspaces={workspaces}
      workspace={workspace}
      view={view}
      syncNotice={syncNotice}
      onLoadOlder={async () => { checkRenderedSession(); await loadOlder(); }}
      historyBusy={historyBusy}
      claimRoute={['/claim', '/authorize-agent'].includes(window.location.pathname)}
      initialSection={requestedSection}
      initialChildViews={childViewCache.current}
      onChildViewsChange={next => {
        if (isCurrentSession(renderedGeneration) && humanRef.current?.id === human.id) {
          const verified = Object.fromEntries(Object.entries(next).filter(([inboxId, child]) =>
            child.inbox.id === inboxId && child.requester?.id === human.id && child.requester.auth.assurance !== 'phone'));
          childViewCache.current = { ...childViewCache.current, ...verified };
          workspaceViewCache.current = { ...workspaceViewCache.current, ...verified };
        }
      }}
      onSelectWorkspace={async (next, nextSection = 'inbox') => { checkRenderedSession(); setRequestedSection(nextSection); await selectWorkspace(next); }}
      onPreferenceUpdated={(inboxId, caseId, preference) => {
        checkRenderedSession();
        if (activeWorkspace.current !== inboxId) return;
        viewOrder.current.reset();
        setView(current => current ? applyInboxPreference(current, caseId, preference) : current);
      }}
      onRefresh={async () => { checkRenderedSession(); await Promise.all([quietRefresh(workspace.id), loadWorkspaceDirectory()]); }}
      onLogout={async () => { checkRenderedSession(); await logout(); }}
    />
    </div>
    {sessionCheck === 'checking' && <LoadingScreen checking onLogout={() => { void logout(); }} />}
    {sessionCheck === 'error' && <FailureScreen message={error} onRetry={() => { void revalidateAccount(); }} onLogout={() => { void logout(); }} />}
    </>
  );
}

export function SignOutControl({ onLogout }: { onLogout: () => void }) {
  return <div className="account-actions"><button type="button" className="button secondary compact" onClick={onLogout}><LogOut size={16} aria-hidden="true" />Sign out</button></div>;
}

function PublicSiteRedirect() {
  useEffect(() => { window.location.replace('/'); }, []);
  return <LoadingScreen />;
}

export function LoadingScreen({ checking = false, onLogout }: { checking?: boolean; onLogout?: () => void }) {
  return (
    <main className="center-screen product-loading" aria-live="polite">
      <div className="brand-lockup"><BrandMark /><span>Envoi</span></div>
      <div className="decision-loader" aria-hidden="true"><span /><span /><span /></div>
      <p>{checking ? 'Checking your session…' : 'Loading your delegated work…'}</p>
      {onLogout && <SignOutControl onLogout={onLogout} />}
    </main>
  );
}

export function FailureScreen({ message, onRetry, onLogout, title = 'Workspace unavailable', retryLabel = 'Retry loading' }: { message: string; onRetry: () => void; onLogout?: () => void; title?: string; retryLabel?: string }) {
  return (
    <main className="center-screen">
      <AlertCircle size={28} aria-hidden="true" />
      <h1>{title}</h1>
      <p>{message}</p>
      <button className="button primary" onClick={onRetry}><RefreshCw size={16} />{retryLabel}</button>
      {onLogout && <SignOutControl onLogout={onLogout} />}
    </main>
  );
}

function AuthScreen({ config, notice, resumePhoneSession, onAuthenticated }: { config: AuthConfig; notice?: string; resumePhoneSession?: boolean; onAuthenticated: () => Promise<void> }) {
  const [step, setStep] = useState<'phone' | 'code' | 'totp'>(resumePhoneSession === undefined ? 'phone' : 'totp');
  const [challengeId, setChallengeId] = useState('');
  const [developmentCode, setDevelopmentCode] = useState('');
  const [totp, setTotp] = useState<{ secret: string; otpauthUri: string; developmentCode?: string } | null>(null);
  const [totpSetupRequired, setTotpSetupRequired] = useState(resumePhoneSession === true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submitPhone(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    const form = new FormData(event.currentTarget);
    try {
      const started = await api.phoneStart(String(form.get('phoneNumber')), String(form.get('displayName')));
      setChallengeId(started.challengeId); setDevelopmentCode(started.developmentCode || ''); setStep('code');
    } catch (caught) { setError(errorMessage(caught)); } finally { setBusy(false); }
  }

  async function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    const form = new FormData(event.currentTarget);
    try {
      const verified = await api.phoneVerify(challengeId, String(form.get('code')));
      if (typeof verified.mfaSetupRequired !== 'boolean') throw new Error('Authentication service needs an update. Please try again after it restarts.');
      setTotpSetupRequired(verified.mfaSetupRequired);
      setStep('totp');
      if (verified.mfaSetupRequired) setTotp(await api.totpSetup());
      else setTotp(null);
    } catch (caught) { setError(errorMessage(caught)); } finally { setBusy(false); }
  }

  async function retryTotpSetup() {
    setBusy(true); setError('');
    try { setTotp(await api.totpSetup()); }
    catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(false); }
  }

  async function submitTotp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    const form = new FormData(event.currentTarget);
    try { await api.totpVerify(String(form.get('code'))); await onAuthenticated(); }
    catch (caught) { setError(errorMessage(caught)); setBusy(false); }
  }

  return (
    <main className="auth-page">
      <section className="auth-intro">
        <div className="brand-lockup inverse"><BrandMark /><span>Envoi</span></div>
        <div className="auth-message">
          <p className="eyebrow">Delegation you can trust</p>
          <h1>Your agent moves work forward.<br />You keep the final word.</h1>
        <p>A calm, familiar inbox for the conversations your agents are having, the work they are moving forward, and the moments that genuinely need you.</p>
        </div>
        <div className="trust-note"><ShieldCheck size={18} /><span>Every consequential action carries its authority and receipt.</span></div>
      </section>
      <section className="auth-panel">
        <div className="auth-card">
          {notice && <InlineNotice title="Sign in again" body={notice} tone="attention" />}
          {config.provider === 'workos' ? (
            <>
              <p className="eyebrow">Secure workspace</p><h2>Continue to Envoi</h2>
              <p className="supporting">{config.inviteOnly ? 'Accept your invitation, then sign in securely with WorkOS.' : 'Sign in with WorkOS, or create your Envoi account.'}</p>
              <a className="button primary wide" href={config.signInPath || '/api/auth/workos/sign-in'}>Sign in securely</a>
              {!config.inviteOnly && <a className="button secondary wide" href={config.signUpPath || '/api/auth/workos/sign-up'}>Create an account</a>}
            </>
          ) : step === 'phone' ? (
            <form onSubmit={submitPhone}>
              <p className="eyebrow">Local development access</p><h2>Verify your identity</h2>
              <p className="supporting">Phone verification and an authenticator protect workspace and enrollment changes.</p>
              <Field label="Your name" name="displayName" autoComplete="name" placeholder="Rachel Gonsalves" required />
              <Field label="Phone number" name="phoneNumber" type="tel" autoComplete="tel" placeholder="+1 416 555 0123" required />
              <FormError message={error} />
              <button className="button primary wide" disabled={busy}>{busy ? 'Sending code…' : 'Send verification code'}</button>
            </form>
          ) : step === 'code' ? (
            <form onSubmit={submitCode}>
              <p className="eyebrow">Phone verification</p><h2>Enter the one-time code</h2>
              <p className="supporting">The code expires shortly and can only be used once.</p>
              {developmentCode && <InlineNotice title="Development code" body={developmentCode} tone="unknown" />}
              <Field label="Verification code" name="code" inputMode="numeric" autoComplete="one-time-code" required />
              <FormError message={error} />
              <button className="button primary wide" disabled={busy}>{busy ? 'Verifying…' : 'Verify phone'}</button>
              <button type="button" className="button quiet wide" disabled={busy} onClick={() => { setStep('phone'); setChallengeId(''); setDevelopmentCode(''); setError(''); }}>Start again</button>
            </form>
          ) : (
            <form onSubmit={submitTotp}>
              <p className="eyebrow">Authenticator required</p><h2>{totpSetupRequired ? 'Protect consequential actions' : 'Verify your authenticator'}</h2>
              <p className="supporting">{totpSetupRequired ? totp ? 'Add this secret to your authenticator, then enter the current code.' : 'Continue setup to see your authenticator secret.' : 'Enter the current code from the authenticator you already set up.'}</p>
              {totpSetupRequired && totp && <div className="secret-block"><KeyRound size={18} /><code>{totp.secret}</code><CopyButton value={totp.secret} label="Copy authenticator secret" /></div>}
              {totp?.developmentCode && <InlineNotice title="Current development code" body={totp.developmentCode} tone="unknown" />}
              {(!totpSetupRequired || totp) && <Field label="Authenticator code" name="code" inputMode="numeric" autoComplete="one-time-code" required />}
              <FormError message={error} />
              {totpSetupRequired && !totp ? <button type="button" className="button primary wide" disabled={busy} onClick={() => void retryTotpSetup()}>{busy ? 'Preparing authenticator…' : 'Retry authenticator setup'}</button> : <button className="button primary wide" disabled={busy}>{busy ? 'Securing workspace…' : 'Finish secure sign in'}</button>}
            </form>
          )}
        </div>
      </section>
    </main>
  );
}

function WorkspaceSetup({ human, onCreate }: { human: Human; onCreate: (name: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  return (
    <main className="setup-page">
      <div className="brand-lockup"><BrandMark /><span>Envoi</span></div>
      <section className="setup-card">
        <p className="eyebrow">Workspace setup</p>
        <h1>Give delegated work a clear home.</h1>
        <p>Welcome, {human.displayName}. Create the workspace where your agents will operate under your authority.</p>
        <form onSubmit={async event => {
          event.preventDefault(); setBusy(true); setError('');
          try { await onCreate(String(new FormData(event.currentTarget).get('name'))); }
          catch (caught) { setError(errorMessage(caught)); setBusy(false); }
        }}>
          <Field label="Workspace name" name="name" placeholder="Name your workspace" required />
          <FormError message={error} />
          <button className="button primary" disabled={busy}>{busy ? 'Creating workspace…' : 'Create workspace'}</button>
        </form>
      </section>
    </main>
  );
}

interface ShellProps {
  config: AuthConfig; human: Human; organizations: Organization[]; workspaces: Workspace[];
  workspace: Workspace; view: HumanView; onSelectWorkspace: (workspace: Workspace, section?: NavSection) => Promise<void>;
  initialSection?: NavSection;
  initialChildViews?: Record<string, HumanView>;
  onChildViewsChange?: (views: Record<string, HumanView>) => void;
  claimRoute?: boolean;
  onPreferenceUpdated?: (inboxId: string, caseId: string, preference: InboxPreference) => void;
  onRefresh: () => Promise<unknown>; onLogout: () => Promise<void>; syncNotice: string;
  onLoadOlder?: () => Promise<void>; historyBusy?: boolean;
}

type AgentEntry = { agent: Agent; inbox: Workspace; view: HumanView };

export function AppShell(props: ShellProps) {
  const { human, workspaces, workspace, view, onSelectWorkspace, onRefresh, onLogout, syncNotice } = props;
  const canManageInbox = view.canManageInbox === true;
  const authorizationRoute = typeof window !== 'undefined' && window.location.pathname === '/authorize-agent';
  const [section, setSection] = useState<NavSection>(props.initialSection || 'inbox');
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [expandedAgents, setExpandedAgents] = useState<string[]>([]);
  const [toast, setToast] = useState('');
  const [childViews, setChildViews] = useState<Record<string, HumanView>>(() => props.initialChildViews || {});
  const [childViewFailures, setChildViewFailures] = useState<string[]>([]);
  const childResponseOrders = useRef(new Map<string, ReturnType<typeof createViewResponseOrder>>());
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectResult, setConnectResult] = useState<EnrollmentResult | null>(null);
  const [folderMenuId, setFolderMenuId] = useState<string | null>(null);
  const [folderToDelete, setFolderToDelete] = useState<{ id: string; name: string } | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderError, setFolderError] = useState('');
  const rootWorkspace = workspaces.find(item => item.id === (workspace.parentInboxId || workspace.id)) || workspace;
  const agentInboxes = workspaces.filter(item => item.kind === 'agent' && item.parentInboxId === rootWorkspace.id);
  const agentInboxKey = agentInboxes.map(item => item.id).sort().join(',');
  const agentEntries: AgentEntry[] = agentInboxes.flatMap(inbox => (childViews[inbox.id] || (workspace.id === inbox.id ? view : null))?.agents.filter(agent => agent.id === inbox.ownerAgentId).map(agent => ({ agent, inbox, view: childViews[inbox.id] || view })) || []);
  if (workspace.id === rootWorkspace.id) {
    for (const agent of view.agents) if (!agentEntries.some(entry => entry.agent.id === agent.id)) agentEntries.push({ agent, inbox: workspace, view });
  }
  // Directory membership already authorizes the inbox metadata. Keep its
  // navigation entry visible while that inbox's heavier human-view is pending
  // or a transient refresh fails; selecting it still requires a fresh view.
  const agentNavEntries = [
    ...agentInboxes.filter(inbox => inbox.status !== 'removed').map(inbox => {
      const entry = agentEntries.find(item => item.inbox.id === inbox.id);
      return {
        id: inbox.ownerAgentId || inbox.id,
        name: entry?.agent.name || inbox.removedAgent?.name || inbox.name.replace(/ inbox$/i, ''),
        inbox,
        onboardingStatus: entry?.agent.onboardingStatus || (inbox.status === 'pending_approval' ? 'pending_approval' : 'approved')
      };
    }),
    ...agentEntries.filter(entry => entry.inbox.id === rootWorkspace.id && !agentInboxes.some(inbox => inbox.ownerAgentId === entry.agent.id)).map(({ agent, inbox }) => ({
      id: agent.id, name: agent.name, inbox, onboardingStatus: agent.onboardingStatus
    }))
  ];
  const aggregateViews = [view, ...[rootWorkspace, ...agentInboxes].filter(inbox => inbox.id !== workspace.id).map(inbox => childViews[inbox.id]).filter((item): item is HumanView => Boolean(item))];
  const queueView: HumanView = workspace.id === rootWorkspace.id ? {
    ...view,
    sourceViews: aggregateViews,
    agents: agentEntries.map(entry => entry.agent),
    caseQueue: aggregateViews.flatMap(item => item.caseQueue),
    messages: aggregateViews.flatMap(item => item.messages),
    assets: aggregateViews.flatMap(item => item.assets),
    participantDirectory: Object.assign({}, ...aggregateViews.map(item => item.participantDirectory || {}))
  } : view;
  const counts = caseCounts({ ...queueView, caseQueue: filterInboxCases(queueView.caseQueue) });
  const caseSources = aggregateViews.flatMap(item => item.caseQueue.map(workCase => ({ workCase, sourceView: item, key: `${item.inbox.id}:${workCase.id}` })));
  const inboxCases = filterInboxCases(queueView.caseQueue, { view: section === 'completed' ? 'done' : 'main', ...(selectedFolderId ? { folderId: selectedFolderId } : {}) });
  const missingAgentViews = agentInboxes.filter(inbox => inbox.status !== 'removed' && !childViews[inbox.id]);
  const doneLoadStatus = section === 'completed' && workspace.id === rootWorkspace.id && missingAgentViews.length
    ? missingAgentViews.some(inbox => childViewFailures.includes(inbox.id)) ? 'error' : 'loading' : undefined;
  const sectionCases = section === 'completed' ? inboxCases : casesForSection(inboxCases, section, queueView.assets);
  const visibleCaseEntries = sectionCases.flatMap(item => {
    const source = caseSources.find(entry => entry.workCase === item);
    return source ? [source] : [];
  });
  const visibleCases = visibleCaseEntries.map(entry => entry.workCase);
  const selectedCaseEntry = visibleCaseEntries.find(item => item.key === selectedCaseId) || null;
  const selectedCase = selectedCaseEntry?.workCase || null;
  const selectedCaseView = selectedCaseEntry?.sourceView || view;
  const currentAgent = workspace.kind === 'agent' ? view.agents.find(item => item.id === workspace.ownerAgentId) || null : null;

  useEffect(() => { document.documentElement.dataset.theme = 'light'; localStorage.removeItem('envoi.theme'); }, []);
  useEffect(() => { props.onChildViewsChange?.(childViews); }, [childViews, props.onChildViewsChange]);
  useEffect(() => {
    if (rootWorkspace.id === previewWorkspace.id) return;
    let cancelled = false;
    // The selected root view is already loaded. Only child inboxes contribute
    // cases to the All inboxes and Done aggregates.
    const inboxes = agentInboxes.filter(inbox => inbox.status !== 'removed');
    let loading = false;
    async function refreshChildren() {
      if (loading) return;
      loading = true;
      try {
        await Promise.all(inboxes.map(async inbox => {
          const order = childResponseOrder(inbox.id);
          const ticket = order.begin();
          try {
            const refreshed = await api.humanView(inbox.id);
            // Publish each inbox as it arrives. One slow agent must not leave
            // every completed conversation hidden behind the slowest read.
            if (!cancelled) {
              setChildViews(current => cancelled ? current : applyOrderedViewResponses(current, [{ key: inbox.id, value: refreshed, order, ticket }]));
              setChildViewFailures(current => current.filter(id => id !== inbox.id));
            }
          }
          catch { if (!cancelled) setChildViewFailures(current => current.includes(inbox.id) ? current : [...current, inbox.id]); }
        }));
      } finally { loading = false; }
    }
    void refreshChildren();
    const timer = window.setInterval(() => void refreshChildren(), 30_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [rootWorkspace.id, agentInboxKey]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
      if (!editing && event.key === '/') { event.preventDefault(); document.querySelector<HTMLInputElement>('.queue-search input')?.focus(); }
      if (event.key === 'Escape') { setNavOpen(false); setFolderMenuId(null); }
    };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, []);
  useEffect(() => {
    if (!folderMenuId) return;
    document.querySelector<HTMLButtonElement>('.folder-context-menu button')?.focus({ preventScroll: true });
    const closeMenu = (event: PointerEvent) => {
      if (!(event.target as Element).closest('.folder-nav-row')) setFolderMenuId(null);
    };
    document.addEventListener('pointerdown', closeMenu);
    return () => document.removeEventListener('pointerdown', closeMenu);
  }, [folderMenuId]);
  useEffect(() => { if (toast) { const timer = window.setTimeout(() => setToast(''), 4200); return () => window.clearTimeout(timer); } }, [toast]);

  function chooseSection(next: NavSection) {
    setSelectedFolderId(null);
    setFolderMenuId(null);
    setSection(next); setSelectedCaseId(null); setNavOpen(false);
  }
  function openConnect() {
    if (!canManageInbox) return;
    setNavOpen(false);
    setConnectResult(null);
    setConnectOpen(true);
  }
  function chooseInbox(next: Workspace, nextSection: NavSection = 'inbox') {
    chooseSection(nextSection);
    if (next.id !== workspace.id) void onSelectWorkspace(next, nextSection).catch(caught => setToast(errorMessage(caught)));
  }
  async function refreshSelectedCase() {
    if (selectedCaseView.inbox.id === workspace.id) { await onRefresh(); return; }
    await refreshAgentInbox(selectedCaseView.inbox.id);
  }
  async function refreshAgentInbox(inboxId: string) {
    const order = childResponseOrder(inboxId);
    const ticket = order.begin();
    const refreshed = await api.humanView(inboxId);
    setChildViews(current => applyOrderedViewResponses(current, [{ key: inboxId, value: refreshed, order, ticket }]));
    setChildViewFailures(current => current.filter(id => id !== inboxId));
  }
  function childResponseOrder(inboxId: string) {
    let order = childResponseOrders.current.get(inboxId);
    if (!order) { order = createViewResponseOrder(); childResponseOrders.current.set(inboxId, order); }
    return order;
  }
  function preferenceUpdated(inboxId: string, caseId: string, preference: InboxPreference) {
    childResponseOrder(inboxId).reset();
    setChildViews(current => current[inboxId] ? { ...current, [inboxId]: applyInboxPreference(current[inboxId], caseId, preference) } : current);
    props.onPreferenceUpdated?.(inboxId, caseId, preference);
  }
  async function refreshInboxPreferences() {
    await onRefresh();
    await Promise.all(agentInboxes.map(inbox => refreshAgentInbox(inbox.id)));
  }
  async function createFolder(name: string) {
    setFolderBusy(true); setFolderError('');
    try {
      if (workspace.id === previewWorkspace.id) throw new Error('Folder changes are unavailable in the design preview. Sign in to save changes.');
      await api.createInboxFolder(workspace.id, name);
      await refreshInboxPreferences(); setFolderDialogOpen(false); setToast('Folder created');
    } catch (caught) { setFolderError(errorMessage(caught)); }
    finally { setFolderBusy(false); }
  }
  async function deleteFolder() {
    if (!folderToDelete) return;
    setFolderBusy(true); setFolderError('');
    try {
      if (workspace.id === previewWorkspace.id) throw new Error('Folder changes are unavailable in the design preview. Sign in to save changes.');
      await api.deleteInboxFolder(workspace.id, folderToDelete.id);
      if (selectedFolderId === folderToDelete.id) setSelectedFolderId(null);
      setFolderToDelete(null);
      try { await refreshInboxPreferences(); setToast('Folder deleted'); }
      catch { setToast('Folder deleted. Refresh to update the list.'); }
    } catch (caught) { setFolderError(errorMessage(caught)); }
    finally { setFolderBusy(false); }
  }
  function openCase(item: WorkCase) {
    const source = caseSources.find(entry => entry.workCase === item);
    if (!source) return;
    setSelectedCaseId(source.key);
    const patch = readAcknowledgementForCase(item);
    if (patch && !item.inboxPreference?.read && source.sourceView.inbox.id !== previewWorkspace.id) {
      void api.updateInboxPreference(source.sourceView.inbox.id, item.id, patch)
        .then(result => {
          preferenceUpdated(source.sourceView.inbox.id, item.id, result.inboxPreference);
          return source.sourceView.inbox.id === workspace.id ? onRefresh() : refreshAgentInbox(source.sourceView.inbox.id);
        })
        .catch(caught => setToast(errorMessage(caught)));
    }
  }
  function openCaseFromUtility(item: WorkCase) {
    const source = caseSources.find(entry => entry.workCase.id === item.id && entry.sourceView.inbox.id === view.inbox.id)
      || caseSources.find(entry => entry.workCase.id === item.id);
    if (!source) { setToast('Load the conversation’s history before opening it.'); return; }
    chooseSection(source.workCase.inboxPreference?.archived ? 'completed' : 'inbox');
    openCase(source.workCase);
  }
  function toggleAgent(agentId: string) {
    setExpandedAgents(current => current.includes(agentId) ? current.filter(id => id !== agentId) : [...current, agentId]);
  }

  const utilitySection = !caseSections.includes(section);

  return (
    <div className="app-shell">
      <SignOutControl onLogout={() => { void onLogout(); }} />
      <a className="skip-link" href="#main-content">Skip to content</a>
      {navOpen && <button className="nav-scrim" aria-label="Close navigation" onClick={() => setNavOpen(false)} />}
      <aside className={`primary-nav ${navOpen ? 'is-open' : ''}`} aria-label="Primary">
        <div className="nav-brand"><div className="brand-lockup"><BrandMark /><span>envoi</span></div><button className="icon-button mobile-only" aria-label="Close navigation" onClick={() => setNavOpen(false)}><X size={18} /></button></div>
        <nav className="nav-list">
          <div className="nav-section-heading nav-section-title"><span>Inbox</span></div>
          <NavItem section="inbox" label="All inboxes" icon={<Inbox />} count={counts.inbox} active={workspace.id === rootWorkspace.id && section === 'inbox'} onClick={() => chooseInbox(rootWorkspace)} />
          <NavItem section="needsMe" label="Needs you" icon={<Hand />} count={counts.needsMe} active={workspace.id === rootWorkspace.id && section === 'needsMe'} onClick={() => chooseInbox(rootWorkspace, 'needsMe')} attention />
          <NavItem section="completed" label="Done" icon={<Check />} active={workspace.id === rootWorkspace.id && section === 'completed'} onClick={() => chooseInbox(rootWorkspace, 'completed')} />
          <div className="nav-section-heading"><span>Agents</span><button aria-label="Add agent" disabled={!canManageInbox} onClick={openConnect}><Plus size={15} /></button></div>
          {agentNavEntries.map(({ id, name, inbox, onboardingStatus }, index) => {
            const expanded = expandedAgents.includes(id);
            const color = AGENT_COLORS[index % AGENT_COLORS.length];
            return <div key={id}><div className="agent-nav-row"><button className="nav-item" aria-current={workspace.id === inbox.id ? 'page' : undefined} onClick={() => chooseInbox(inbox)}><span className="agent-dot" style={{ '--agent-color': color } as React.CSSProperties}>{initials(name)}</span><span>{name}</span>{onboardingStatus !== 'approved' && <span className="nav-count">Setup</span>}</button><button className="icon-button" aria-label={`${expanded ? 'Collapse' : 'Expand'} ${name}`} aria-expanded={expanded} onClick={() => toggleAgent(id)}><ChevronDown size={14} /></button></div>{expanded && <div className="agent-subnav"><NavItem section="inbox" label="Inbox" icon={<Inbox />} active={workspace.id === inbox.id && section === 'inbox'} onClick={() => chooseInbox(inbox)} /><NavItem section="needsMe" label="Needs you" icon={<Hand />} active={workspace.id === inbox.id && section === 'needsMe'} onClick={() => chooseInbox(inbox, 'needsMe')} /><NavItem section="completed" label="Done" icon={<Check />} active={workspace.id === inbox.id && section === 'completed'} onClick={() => chooseInbox(inbox, 'completed')} /></div>}</div>;
          })}
          {agentInboxes.some(inbox => inbox.status === 'removed') && <div className="nav-section-heading"><span>Archived agents</span></div>}
          {agentInboxes.filter(inbox => inbox.status === 'removed').map(inbox => <button key={inbox.id} className="nav-item" onClick={() => chooseInbox(inbox)}><Archive size={16} /><span>{inbox.removedAgent?.name || inbox.name}</span></button>)}
          <div className="nav-section-heading"><span>Folders</span><button aria-label="Create folder" disabled={!view.folders} onClick={() => { setFolderError(''); setFolderDialogOpen(true); }}><Plus size={15} /></button></div>
          {view.folders?.map(folder => <div key={folder.id} className="folder-nav-row" onContextMenu={event => { event.preventDefault(); setFolderMenuId(folder.id); }}>
            <button className="nav-item" aria-current={selectedFolderId === folder.id ? 'page' : undefined} onClick={() => { chooseSection('inbox'); setSelectedFolderId(folder.id); }}><Folder size={16} /><span>{folder.name}</span></button>
            <button className="folder-menu-trigger icon-button" aria-label={`More options for ${folder.name}`} aria-haspopup="menu" aria-expanded={folderMenuId === folder.id} onClick={() => setFolderMenuId(current => current === folder.id ? null : folder.id)}><MoreHorizontal size={16} /></button>
            {folderMenuId === folder.id && <div className="folder-context-menu" role="menu" aria-label={`${folder.name} options`}><button role="menuitem" onClick={() => { setFolderMenuId(null); setFolderError(''); setFolderToDelete(folder); }}><Trash2 size={16} />Delete folder</button></div>}
          </div>)}
          <div className="nav-spacer" />
          <div className="nav-section-heading nav-section-title"><span>Workspace</span></div>
          <NavItem section="documents" label="Files" icon={<FileText />} active={section === 'documents'} onClick={chooseSection} />
          <NavItem section="integrations" label="Manage agents" icon={<UsersRound />} active={section === 'integrations'} onClick={chooseSection} />
          <NavItem section="policies" label="Permissions" icon={<ShieldCheck />} active={section === 'policies'} onClick={chooseSection} />
          <NavItem section="activity" label="Activity" icon={<Activity />} active={section === 'activity'} onClick={chooseSection} />
        </nav>
        <div className="nav-footer">
          <div className="principal-card"><span className="counterparty-avatar" style={{ '--avatar-color': 'var(--ink2)' } as React.CSSProperties}>{initials(human.displayName)}</span><div><strong>{human.displayName}</strong><small>{human.email || ''}</small></div></div>
        </div>
      </aside>

      <section className={`application ${utilitySection || props.claimRoute ? 'utility-layout' : ''} ${syncNotice ? 'has-sync-notice' : ''}`}>
        {syncNotice && <div className="sync-notice" role="status"><AlertCircle size={16} /><span>{syncNotice}</span></div>}

        {props.claimRoute ? <main id="main-content" className="utility-content"><ClaimWorkspace key={human.id} humanId={human.id} authorizationSearch={authorizationRoute ? window.location.search : undefined} workspaces={workspaces.filter(item => item.kind !== 'agent' && (!authorizationRoute || (item.id === workspace.id ? view.canManageInbox : childViews[item.id]?.canManageInbox)))} entries={agentEntries} onRefresh={onRefresh} onSelectAgent={async (agentId, address) => { const inbox = workspaces.find(item => item.kind === 'agent' && (item.ownerAgentId === agentId || agentEntries.some(entry => entry.agent.address === address && entry.agent.id === item.ownerAgentId))); if (inbox) { await onSelectWorkspace(inbox, 'integrations'); window.location.assign('/app'); } }} /></main> : utilitySection ? (
          <main id="main-content" className="utility-content">
            <button className="icon-button mobile-only utility-menu" aria-label="Open navigation" onClick={() => setNavOpen(true)}><Menu size={18} /></button>
{section === 'documents' && <SharedFilesPage view={view} notify={setToast} onOpenCase={openCaseFromUtility} />}
{section === 'policies' && <PoliciesPage entries={agentEntries} onConnect={openConnect} onRefresh={refreshAgentInbox} notify={setToast} />}
            {section === 'integrations' && <IntegrationsPage view={view} workspace={rootWorkspace} entries={agentEntries} humanId={human.id} canManageInbox={canManageInbox} onConnect={openConnect} onSelectWorkspace={onSelectWorkspace} onPermissions={() => chooseSection('policies')} onRefresh={onRefresh} onRefreshAgent={refreshAgentInbox} notify={setToast} />}
            {section === 'activity' && <ActivityPage view={view} onOpenCase={openCaseFromUtility} />}
          </main>
        ) : (
          <div className={`case-layout ${selectedCase ? 'inbox-detail-view show-detail' : 'inbox-list-view'}`}>
{!selectedCase && <CaseQueue section={section} folderName={view.folders?.find(folder => folder.id === selectedFolderId)?.name} cases={visibleCases} view={queueView} currentAgent={currentAgent} selectedId={selectedCaseEntry?.key || null} caseKey={item => caseSources.find(source => source.workCase === item)?.key || item.id} onOpenNav={() => setNavOpen(true)} onConnect={openConnect} onLoadOlder={props.onLoadOlder} historyBusy={props.historyBusy} onSelect={openCase} conversationsStatus={doneLoadStatus} onRetryConversations={() => { for (const inbox of missingAgentViews) void refreshAgentInbox(inbox.id).catch(() => setChildViewFailures(current => current.includes(inbox.id) ? current : [...current, inbox.id])); }} />}
            {selectedCase && <main id="main-content" className="case-main">
<CaseWorkspace key={`${selectedCaseView.inbox.id}:${selectedCase.id}`} workCase={selectedCase} view={selectedCaseView} canManageInbox={selectedCaseView.canManageInbox} railOpen={railOpen} onRailToggle={() => setRailOpen(value => !value)} onBack={() => { setSelectedCaseId(null); }} onRefresh={refreshSelectedCase} onPreferencesChanged={async preference => { preferenceUpdated(selectedCaseView.inbox.id, selectedCase.id, preference); setSelectedCaseId(null); await refreshSelectedCase().catch(caught => setToast(errorMessage(caught))); }} notify={setToast} />
            </main>}
          </div>
        )}
      </section>
      <div className="sr-live" aria-live="polite">{toast}</div>
      {toast && <div className="toast"><Check size={16} />{toast}</div>}
      {folderDialogOpen && <Modal title="Create folder" dismissible={!folderBusy} onClose={() => setFolderDialogOpen(false)}><CreateInboxFolderContent busy={folderBusy} error={folderError} onClose={() => setFolderDialogOpen(false)} onCreate={name => void createFolder(name)} /></Modal>}
      {folderToDelete && <Modal title="Delete folder?" dismissible={!folderBusy} onClose={() => setFolderToDelete(null)}><p className="dialog-copy">Delete “{folderToDelete.name}”? Conversations in this folder will stay in All inboxes.</p><FormError message={folderError} /><div className="dialog-actions"><button className="button secondary" disabled={folderBusy} onClick={() => setFolderToDelete(null)}>Cancel</button><button className="button destructive" disabled={folderBusy} onClick={() => void deleteFolder()}>{folderBusy ? 'Deleting…' : 'Delete folder'}</button></div></Modal>}
      {connectOpen && <EnrollmentDialog workspace={rootWorkspace} agentDomain={queueView.publicEmailTransport?.internalAgentDomain || 'envoi-agents.com'} result={connectResult} setResult={setConnectResult} onRefresh={onRefresh} onClose={() => { setConnectOpen(false); setConnectResult(null); }} />}
    </div>
  );
}

function ClaimWorkspace({ humanId, workspaces, entries, onRefresh, onSelectAgent, authorizationSearch }: { authorizationSearch?: string; humanId: string; workspaces: Workspace[]; entries: AgentEntry[]; onRefresh: () => Promise<unknown>; onSelectAgent: (agentId: string, address?: string) => Promise<void> }) {
  const [revision, setRevision] = useState(0);
  return <>{authorizationSearch !== undefined ? <AuthorizeAgentPage humanId={humanId} handle={authorizationHandle(authorizationSearch)} workspaces={workspaces} agents={entries.filter(entry => entry.inbox.kind === 'agent' && entry.view.canManageInbox).map(entry => ({ ...entry.agent, inboxId: entry.inbox.id }))} /> : <ClaimPage humanId={humanId} workspaces={workspaces} agents={entries.filter(entry => entry.inbox.kind === 'agent').map(entry => ({ ...entry.agent, inboxId: entry.inbox.id }))} onComplete={async () => { setRevision(value => value + 1); await onRefresh(); }} onBack={() => window.location.assign('/app')} />}<OwnerClaims key={`${humanId}:${revision}`} humanId={humanId} onSelectAgent={(agentId, address) => { void onSelectAgent(agentId, address); }} /></>;
}

const AGENT_COLORS = ['var(--accent)', 'var(--agent-purple)', 'var(--green)', 'var(--orange)', 'var(--agent-teal)', 'var(--red)', 'var(--ink2)'];
function initials(value: string) { return value.trim().split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase() || '').join('') || '?'; }

function WorkspacePicker({ workspaces, workspace, onChange }: { workspaces: Workspace[]; workspace: Workspace; onChange: (workspace: Workspace) => Promise<void> }) {
  return (
    <label className="workspace-picker"><span className="sr-only">Current workspace</span><Gauge size={16} /><select value={workspace.id} onChange={event => { const next = workspaces.find(item => item.id === event.target.value); if (next) void onChange(next); }}>{workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><ChevronDown size={14} aria-hidden="true" /></label>
  );
}

function NavItem({ section, label, icon, count, active, attention, onClick }: { section: NavSection; label: string; icon: ReactNode; count?: number; active: boolean; attention?: boolean; onClick: (section: NavSection) => void }) {
  return <button className={`nav-item ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} onClick={() => onClick(section)}><span className="nav-icon">{icon}</span><span>{label}</span>{Boolean(count) && <span className={`nav-count ${attention ? 'attention' : ''}`} aria-label={`${count} items`}>{count! > 9 ? '9+' : count}</span>}</button>;
}

function CaseQueue({ section, folderName, cases, view, currentAgent, selectedId, caseKey, onOpenNav, onConnect, onLoadOlder, historyBusy, onSelect, conversationsStatus, onRetryConversations }: { section: NavSection; folderName?: string; cases: WorkCase[]; view: HumanView; currentAgent: Agent | null; selectedId: string | null; caseKey: (workCase: WorkCase) => string; onOpenNav: () => void; onConnect: () => void; onLoadOlder?: () => Promise<void>; historyBusy?: boolean; onSelect: (workCase: WorkCase) => void; conversationsStatus?: 'loading' | 'error'; onRetryConversations?: () => void }) {
  const [query, setQuery] = useState('');
  const loadMarker = useRef<HTMLDivElement>(null);
  const hasMore = Boolean(Object.keys(olderCursors(view)).length);
  useEffect(() => {
    if (!hasMore || !onLoadOlder || historyBusy || !loadMarker.current) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) void onLoadOlder(); }, { root: loadMarker.current.parentElement, rootMargin: '120px' });
    observer.observe(loadMarker.current);
    return () => observer.disconnect();
  }, [hasMore, historyBusy, onLoadOlder]);
  const filtered = cases.filter(item => {
    const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const source = caseSourceView(item, view);
    const agent = source.agents.find(value => value.id === localAgentId(item, source));
    const searchable = `${caseSubject(item, source.messages)} ${item.objective || item.id} ${conversationPreview(item)} ${conversationTags(item).join(' ')} ${agent?.name || ''}`.toLowerCase();
    return words.every(word => {
      if (word.startsWith('agent:')) return (agent?.name || '').toLowerCase().includes(word.slice(6));
      if (word.startsWith('status:')) return caseLabel(item).toLowerCase().includes(word.slice(7));
      if (word.startsWith('type:')) return timelineForCase(item, view.messages).some(event => String(event.payload.messageType || event.type).toLowerCase().includes(word.slice(5)));
      if (word.startsWith('folder:')) return (view.folders?.find(folder => folder.id === item.inboxPreference?.folderId)?.name || '').toLowerCase().includes(word.slice(7));
      return searchable.includes(word);
    });
  }).sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
  return (
    <aside id="main-content" className="case-queue" aria-label={`${section === 'needsMe' ? 'Needs you' : section === 'completed' ? 'Done' : 'Inbox'} cases`}>
      <div className="queue-header"><div className="queue-context">{currentAgent ? <><span className="agent-dot" style={{ '--agent-color': AGENT_COLORS[Math.max(0, view.agents.indexOf(currentAgent)) % AGENT_COLORS.length] } as React.CSSProperties}>{initials(currentAgent.name)}</span><span title={currentAgent.address}>{currentAgent.name} · {currentAgent.address}</span></> : <span>All agents</span>}</div><div className="queue-title-row"><button className="icon-button mobile-only queue-menu" aria-label="Open navigation" onClick={onOpenNav}><Menu size={18} /></button><h1>{folderName || (section === 'needsMe' ? 'Needs you' : section === 'completed' ? 'Done' : 'All inboxes')}</h1></div></div>
      <label className="queue-search"><Search size={15} /><span className="sr-only">Search cases</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search" /><kbd>/</kbd></label>
      <div className="case-list" role="listbox" aria-label="Conversations">
        {filtered.map(item => <CaseRow key={caseKey(item)} workCase={item} view={caseSourceView(item, view)} showOwner={!currentAgent} selected={selectedId === caseKey(item)} onSelect={onSelect} />)}
        {!filtered.length && !query && conversationsStatus && <div className="empty-list inbox-empty" role="status"><span className="empty-icon"><Inbox size={25} /></span><strong>{conversationsStatus === 'loading' ? 'Loading agent conversations…' : 'Some conversations could not load'}</strong><span>{conversationsStatus === 'loading' ? 'Your agents’ Done conversations will appear shortly.' : 'Try loading the missing agent inboxes again.'}</span>{conversationsStatus === 'error' && <button className="button secondary" onClick={onRetryConversations}>Retry</button>}</div>}
        {!filtered.length && (query || !conversationsStatus) && <div className="empty-list inbox-empty"><span className="empty-icon"><Inbox size={25} /></span><strong>{query ? 'No conversations found' : 'No conversations yet'}</strong><span>{query ? 'Try a different search.' : 'Conversations between your agents and other agents will appear here.'}</span>{!query && !view.agents.length && <button className="button secondary" onClick={onConnect}>Connect an agent</button>}</div>}
        {hasMore && <div ref={loadMarker} aria-hidden="true" />}
      </div>
    </aside>
  );
}

export function CaseRow({ workCase, view, showOwner, selected, onSelect }: { workCase: WorkCase; view: HumanView; showOwner: boolean; selected: boolean; onSelect: (workCase: WorkCase) => void }) {
  view = caseSourceView(workCase, view);
  const updated = workCase.updatedAt || workCase.createdAt;
  const events = timelineForCase(workCase, view.messages);
  const counterpartId = participantIds(workCase, events).find(id => id !== localAgentId(workCase, view) && id !== workCase.principal);
  const counterparty = resolveParticipant(workCase, counterpartId, view.agents, view.participantDirectory, localAgentId(workCase, view));
  const owner = view.agents.find(item => item.id === localAgentId(workCase, view));
  const today = new Date(updated).toDateString() === new Date().toDateString();
  const counterpartyColor = AGENT_COLORS[Math.abs(Array.from(counterparty.id).reduce((sum, char) => sum + char.charCodeAt(0), 0)) % AGENT_COLORS.length];
  const ownerColor = AGENT_COLORS[Math.max(0, view.agents.findIndex(item => item.id === owner?.id)) % AGENT_COLORS.length];
  return (
<button role="option" aria-selected={selected} className={`case-row inbox-message-row ${selected ? 'selected' : ''} ${(workCase.inboxPreference ? !workCase.inboxPreference.read : workCase.needsAttention) ? 'is-unread' : ''} ${caseState(workCase) === 'completed' ? 'is-done' : ''}`} onClick={() => onSelect(workCase)}>
      <span className="counterparty-avatar" style={{ '--avatar-color': counterpartyColor } as React.CSSProperties}>{initials(counterparty.displayName)}{showOwner && owner && <span className="owner-badge" style={{ '--owner-color': ownerColor } as React.CSSProperties} title={owner.name}>{initials(owner.name)[0]}</span>}</span>
      <span className="case-row-copy"><span className="thread-sender">{counterparty.displayName}</span><span className="thread-summary"><strong>{caseSubject(workCase, view.messages)}</strong><small className="case-preview"> — {conversationPreview(workCase)}</small></span></span>
      <span className="case-row-meta">{workCase.needsAttention && <span className="case-chip">Needs you</span>}<time dateTime={updated}>{today ? formatTime(updated) : formatDate(updated)}</time></span>
    </button>
  );
}

export function CaseWorkspace({ workCase, view, canManageInbox, railOpen, onRailToggle, onBack, onRefresh, onPreferencesChanged, notify }: { workCase: WorkCase; view: HumanView; canManageInbox: boolean; railOpen: boolean; onRailToggle: () => void; onBack: () => void; onRefresh: () => Promise<unknown>; onPreferencesChanged: (preference: InboxPreference) => Promise<unknown>; notify: (message: string) => void }) {
  view = caseSourceView(workCase, view);
  const state = caseState(workCase);
  const events = timelineForCase(workCase, view.messages);
  const policy = canonicalDecisionPolicy(workCase);
  const [drawer, setDrawer] = useState<{ type: 'policy' | 'evidence'; item?: PolicyEvaluation | EvidenceItem } | null>(null);
  const [confirm, setConfirm] = useState<HumanActionKey | null>(null);
  const [busy, setBusy] = useState<HumanActionKey | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [preferenceBusy, setPreferenceBusy] = useState(false);
  const [preferenceError, setPreferenceError] = useState('');
  const [instruction, setInstruction] = useState('');
  const [instructionBusy, setInstructionBusy] = useState(false);
  const [instructionError, setInstructionError] = useState('');
  const instructionRequest = useRef<{ text: string; key: string } | null>(null);
  const local = resolveParticipant(workCase, localAgentId(workCase, view), view.agents, view.participantDirectory, localAgentId(workCase, view));
  const counterpartyId = participantIds(workCase, events).find(id => id !== localAgentId(workCase, view) && id !== workCase.principal);
  const counterparty = resolveParticipant(workCase, counterpartyId, view.agents, view.participantDirectory, localAgentId(workCase, view));

  async function act(actionKey: HumanActionKey) {
    setBusy(actionKey);
    try {
      await api.action(view.inbox.id, workCase.id, actionKey, caseActionPayload(workCase, actionKey));
      notify(actionPastTense(actionKey)); await onRefresh(); setConfirm(null);
    } catch (caught) { notify(errorMessage(caught)); } finally { setBusy(null); }
  }

  const hasOpenDecision = Boolean(workCase.schemaVersion) && !['completed', 'expired', 'revoked'].includes(state);
  const canAct = canManageInbox && hasOpenDecision;
  const canOrganize = Boolean(workCase.inboxPreference && view.folders);
  const ownAgent = view.agents.find(agent => agent.id === localAgentId(workCase, view));
  const canInstruct = canAct && state !== 'paused' && ownAgent?.status === 'active' && ownAgent.onboardingStatus === 'approved' && !ownAgent.credentialRevoked && !ownAgent.paused && ownAgent.permissions.includes('receive_agent_messages');
  async function updatePreference(patch: { archive?: boolean; folderId?: string | null }) {
    setPreferenceBusy(true); setPreferenceError('');
    try {
      if (view.inbox.id === previewWorkspace.id) throw new Error('Conversation changes are unavailable in the design preview. Sign in to save changes.');
      const result = await api.updateInboxPreference(view.inbox.id, workCase.id, patch);
      await onPreferencesChanged(result.inboxPreference);
      notify(patch.archive === undefined ? 'Folder updated' : patch.archive ? 'Moved to Done' : 'Moved to inbox');
    } catch (caught) { setPreferenceError(errorMessage(caught)); }
    finally { setPreferenceBusy(false); }
  }
  async function sendInstruction(event: FormEvent) {
    event.preventDefault();
    const text = instruction.trim();
    if (!text || instructionBusy || !canInstruct) return;
    if (instructionRequest.current?.text !== text) instructionRequest.current = { text, key: `human-instruction-${crypto.randomUUID()}` };
    setInstructionBusy(true); setInstructionError('');
    try {
      if (view.inbox.id === previewWorkspace.id) throw new Error('Instructions are unavailable in the design preview. Sign in to send instructions.');
      await api.sendInstruction(view.inbox.id, workCase.id, text, instructionRequest.current.key);
      setInstruction(''); instructionRequest.current = null;
      notify('Instruction queued for your agent'); await onRefresh();
    } catch (caught) { setInstructionError(errorMessage(caught)); }
    finally { setInstructionBusy(false); }
  }
  return (
    <div className={`envoi-thread ${railOpen ? 'details-open' : ''}`}>
      <div className="thread-body">
        <div className="thread-toolbar">
          <button className="thread-tool" aria-label="Back to list" onClick={onBack}><ArrowLeft size={16} /></button>
          <button className="thread-tool" disabled={!canOrganize || preferenceBusy} onClick={() => void updatePreference({ archive: !workCase.inboxPreference?.archived })}><Check size={16} />{workCase.inboxPreference?.archived ? 'Move to inbox' : 'Done'}</button>
          <button className="thread-tool" disabled={!canOrganize || preferenceBusy} onClick={() => { setPreferenceError(''); setMoveOpen(true); }}><Folder size={16} />Move</button>
          <button className="thread-tool" aria-label={canAct ? state === 'paused' ? 'Resume conversation' : 'Pause conversation' : state === 'paused' ? 'Resume' : 'Pause'} disabled={!canAct || Boolean(busy)} onClick={() => state === 'paused' ? void act('resume') : setConfirm('pause')}><Pause size={16} />{canAct ? state === 'paused' ? 'Resume conversation' : 'Pause conversation' : state === 'paused' ? 'Resume' : 'Pause'}</button>
          <button className="thread-tool thread-tool-right" aria-pressed={railOpen} onClick={onRailToggle}><PanelRightOpen size={16} />Details</button>
          <div className="thread-more-wrap"><button className="thread-tool icon-only" aria-label="More case actions" aria-expanded={moreOpen} onClick={() => setMoreOpen(value => !value)}><MoreHorizontal size={17} /></button>{moreOpen && <div className="thread-more" role="menu">{canAct && <button role="menuitem" onClick={() => { setMoreOpen(false); if (state === 'paused') void act('resume'); else setConfirm('pause'); }}>{state === 'paused' ? 'Resume conversation' : 'Pause conversation'}</button>}<button role="menuitem" disabled title="Take over needs server support">Take over case</button><button role="menuitem" onClick={() => { setMoreOpen(false); void navigator.clipboard.writeText(workCase.id).then(() => notify('Copied')).catch(() => notify('Copy failed')); }}>Copy case ID</button>{canAct && <button role="menuitem" className="danger" onClick={() => { setMoreOpen(false); setConfirm('revoke'); }}>Revoke case authority</button>}</div>}</div>
        </div>
        <div className="thread-scroll"><div className="thread-inner">
          <h1 className="thread-subject">{caseSubject(workCase, view.messages)}</h1>
          <div className="thread-meta"><StatusBadge workCase={workCase} /><button className="add-folder" disabled={!canOrganize || preferenceBusy} onClick={() => { setPreferenceError(''); setMoveOpen(true); }}><Folder size={13} />{view.folders?.find(folder => folder.id === workCase.inboxPreference?.folderId)?.name || 'Folder'}</button></div>
          <div className="participant-duo">
            <ParticipantCard participant={local} label={local.relationship === 'localAgent' ? 'Your agent' : 'Local identity unavailable'} />
            <ArrowLeftRight size={18} className="participant-swap" aria-hidden="true" />
            <ParticipantCard participant={counterparty} label={`Agent for ${counterparty.orgRef || 'another organization'}`} nativeControl={Boolean(localAgentId(workCase, view)) && canManageInbox && counterparty.type === 'externalAgent' ? { inboxId: view.inbox.id, onRefresh, notify } : undefined} />
          </div>
          {workCase.decision && hasOpenDecision && <DecisionCard workCase={workCase} view={view} events={events} policy={policy} canManageInbox={canManageInbox} busy={busy} onAction={key => key === 'decline' ? setConfirm(key) : void act(key)} onPolicy={() => policy && setDrawer({ type: 'policy', item: policy })} />}
          {state === 'unknownExternalResult' && <InlineNotice title="Result unknown" body="The external service did not confirm the result. Do not retry with a new key." tone="unknown" />}
          {state === 'revoked' && <InlineNotice title="Authority revoked" body="New agent work for this case is blocked." tone="danger" />}
          <div className="conversation" aria-label="Conversation">{events.length ? events.map((event, index) => <ConversationEntry key={event.id} event={event} previous={events[index - 1]} workCase={workCase} view={view} />) : <div className="empty-list"><Inbox size={20} /><strong>No messages yet</strong></div>}</div>
          {workCase.receipt && <ReceiptCard workCase={workCase} />}
        </div></div>
        <div className="thread-composer"><form className="composer-box" onSubmit={event => void sendInstruction(event)}><input aria-label={local.relationship === 'localAgent' ? `Instructions for ${local.displayName}` : 'Instructions unavailable: local identity unknown'} value={instruction} onChange={event => setInstruction(event.target.value)} maxLength={15000} placeholder={canInstruct ? 'Send an instruction to your agent' : 'Instructions require an active agent and conversation'} disabled={!canInstruct || instructionBusy} /><button aria-label="Send instruction" disabled={!canInstruct || instructionBusy || !instruction.trim()}><ArrowRight size={16} /></button></form><FormError message={instructionError || preferenceError} /></div>
      </div>
      {moveOpen && <Modal title="Move conversation" dismissible={!preferenceBusy} onClose={() => setMoveOpen(false)}><MoveInboxCaseContent folders={view.folders || []} currentFolderId={workCase.inboxPreference?.folderId || null} busy={preferenceBusy} error={preferenceError} onClose={() => setMoveOpen(false)} onMove={folderId => void updatePreference({ folderId })} /></Modal>}
      {railOpen && <aside className="case-details" aria-label="Case details"><div className="details-heading"><strong>Details</strong><button className="icon-button" aria-label="Close details" onClick={onRailToggle}><X size={16} /></button></div><h2>{ownAgent ? `${local.displayName} can` : 'Local permissions unavailable'}</h2>{ownAgent?.permissions.map(permission => <div className="details-row" key={permission}><Check size={14} />{humanize(permission)}</div>) || <p>No permissions listed</p>}{ownAgent && <><h2>{local.displayName} asks you before</h2><p>Actions outside its permissions</p></>}<h2>Files</h2>{view.assets.filter(item => item.caseId === workCase.id).map(asset => <AssetRow key={asset.id} asset={asset} inboxId={view.inbox.id} notify={notify} />)}<h2>Case</h2><dl><dt>Deadline</dt><dd>{workCase.deadline ? formatDate(workCase.deadline) : 'None'}</dd><dt>ID</dt><dd className="case-id">{workCase.id}</dd></dl></aside>}
      {drawer && <DetailDrawer drawer={drawer} onClose={() => setDrawer(null)} />}
      {confirm && canAct && <ConfirmDialog action={confirm} busy={busy === confirm} onCancel={() => setConfirm(null)} onConfirm={() => void act(confirm)} />}
    </div>
  );
}

export function ConversationEntry({ event, previous, workCase, view }: { event: CaseEvent; previous?: CaseEvent; workCase: WorkCase; view: HumanView }) {
  view = caseSourceView(workCase, view);
  const ownHuman = Boolean(event.payload.senderHumanId && event.payload.senderHumanId === view.requester?.id);
  const ownerInstruction = String(event.payload.messageType || '').toLowerCase() === 'instruction' && Boolean(event.payload.senderHumanId || event.payload.senderType === 'human');
  const senderId = event.payload.senderAgentId || event.payload.senderHumanId || event.actor;
  const mine = Boolean(localAgentId(workCase, view) && senderId === localAgentId(workCase, view)) || ownHuman;
  const participant = resolveParticipant(workCase, event.payload.senderAgentId || event.payload.senderHumanId || event.actor, view.agents, view.participantDirectory, localAgentId(workCase, view));
  const date = new Date(event.createdAt);
  const priorDate = previous ? new Date(previous.createdAt) : null;
  const showDay = !priorDate || date.toDateString() !== priorDate.toDateString();
  const delivery = String(event.payload.deliveryState || 'unknown');
  const deliveryLabel = delivery === 'delivered' ? 'Delivered' : ['acknowledged', 'processed'].includes(delivery) ? 'Read' : ['queued', 'retrying', 'deadLettered'].includes(delivery) ? 'Not sent' : 'Unknown';
  const color = AGENT_COLORS[Math.abs(Array.from(participant.id).reduce((sum, char) => sum + char.charCodeAt(0), 0)) % AGENT_COLORS.length];
return <>{showDay && <div className="conversation-day">{date.toDateString() === new Date().toDateString() ? 'Today' : formatDate(event.createdAt)}</div>}{isExchangeEvent(event) ? <div className={`conversation-message ${mine ? 'mine' : 'theirs'}${ownerInstruction ? ' owner-instruction' : ''}`}><span className="counterparty-avatar" style={{ '--avatar-color': color } as React.CSSProperties}>{ownerInstruction ? <UserRound size={15} aria-hidden="true" /> : initials(participant.displayName)}</span><div className="message-content"><div className="message-meta"><strong>{ownHuman ? 'You' : participant.displayName}</strong><span>{ownerInstruction ? 'Owner instruction' : exchangeEventLabel(event)}</span><time dateTime={event.createdAt}>{formatTime(event.createdAt)}</time></div><div className="message-bubble">{ownerInstruction && event.payload.text ? String(event.payload.text) : eventSummary(event)}</div>{mine && <div className={`message-delivery ${deliveryLabel === 'Not sent' || deliveryLabel === 'Unknown' ? 'warning' : ''}`}>{deliveryLabel}</div>}</div></div> : <div className="conversation-event"><Sparkles size={13} /><span>{eventSummary(event)}</span></div>}</>;
}

function NegotiationParticipants({ workCase, view, events, canManageInbox, onRefresh, notify }: { workCase: WorkCase; view: HumanView; events: CaseEvent[]; canManageInbox: boolean; onRefresh: () => Promise<unknown>; notify: (message: string) => void }) {
  const local = resolveParticipant(workCase, localAgentId(workCase, view), view.agents, view.participantDirectory, localAgentId(workCase, view));
  const counterpartIds = participantIds(workCase, events).filter(id => id !== localAgentId(workCase, view) && id !== workCase.principal);
  const counterparties = counterpartIds.length
    ? counterpartIds.map(id => resolveParticipant(workCase, id, view.agents, view.participantDirectory, localAgentId(workCase, view)))
    : [resolveParticipant(workCase, undefined, view.agents, view.participantDirectory, localAgentId(workCase, view))];
  return (
    <section className="participant-strip" aria-labelledby="participants-title">
      <div className="participant-strip-heading"><div><p className="eyebrow">Agent negotiation</p><h2 id="participants-title">Participants in this exchange</h2></div><span><ArrowLeftRight size={14} />Two-way exchange</span></div>
      <div className="participant-flow">
        <ParticipantCard participant={local} label={local.relationship === 'localAgent' ? 'Your agent' : 'Local identity unavailable'} />
        <div className="participant-connector" aria-hidden="true"><ArrowRight size={17} /><span>Negotiating with</span></div>
        <div className="counterparty-stack">{counterparties.map(participant => <ParticipantCard key={participant.id} participant={participant} label={participant.relationship === 'unknown' ? 'Identity unavailable' : 'Counterparty'} nativeControl={Boolean(localAgentId(workCase, view)) && canManageInbox && participant.type === 'externalAgent' ? { inboxId: view.inbox.id, onRefresh, notify } : undefined} />)}</div>
      </div>
    </section>
  );
}

export function ParticipantCard({ participant, label, nativeControl }: { participant: ReturnType<typeof resolveParticipant>; label: string; nativeControl?: { inboxId: string; onRefresh: () => Promise<unknown>; notify: (message: string) => void } }) {
  const mine = participant.relationship === 'localAgent';
  const color = AGENT_COLORS[Math.abs(Array.from(participant.id).reduce((sum, char) => sum + char.charCodeAt(0), 0)) % AGENT_COLORS.length];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function toggleBlocked() {
    if (!nativeControl) return;
    const blocked = participant.accessState !== 'blocked';
    setBusy(true); setError('');
    try {
      await api.setNativeContactBlocked(nativeControl.inboxId, participant.id, blocked);
      nativeControl.notify(blocked ? 'Counterparty blocked' : 'Counterparty unblocked');
      await nativeControl.onRefresh();
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(false); }
  }
  return (
    <div className={`participant-card ${mine ? 'mine' : ''}`}>
      <span className="counterparty-avatar" style={{ '--avatar-color': color } as React.CSSProperties}>{initials(participant.displayName)}</span>
      <span className="participant-copy"><small>{label}</small><strong>{participant.displayName}</strong><span className="participant-address" title={participant.address || 'Address unavailable'}>{participant.address || 'Address unavailable'}</span>{participant.accessState === 'blocked' && <span className="participant-access">Blocked</span>}</span>
      {nativeControl && <button type="button" className="participant-block" disabled={busy} onClick={() => void toggleBlocked()}>{busy ? 'Saving' : participant.accessState === 'blocked' ? 'Unblock agent' : 'Block agent'}</button>}
      {error && <span role="alert">{error}</span>}
    </div>
  );
}

export function DecisionCard({ workCase, view, events, policy, canManageInbox, busy, onAction, onPolicy }: { workCase: WorkCase; view: HumanView; events: CaseEvent[]; policy?: PolicyEvaluation; canManageInbox: boolean; busy: HumanActionKey | null; onAction: (key: HumanActionKey) => void; onPolicy: () => void }) {
  const proposal = workCase.proposals?.find(item => ['open', 'countered'].includes(item.status));
  const option = proposal?.options.find(item => !item.expired);
  const parties = proposal ? proposalParties(workCase, proposal.id, events, view) : null;
  const optionParty = proposal?.status === 'countered' ? parties?.counterparty : parties?.originator;
  const expired = Boolean(workCase.decision?.expiresAt && Date.parse(workCase.decision.expiresAt) <= Date.now());
  return (
    <section className="decision-card" aria-label="Needs your decision">
      <div className="decision-label"><Hand size={14} />{expired ? 'Expired' : 'Needs your decision'}</div>
      {!canManageInbox && <p className="decision-review-label">Workspace administrator review</p>}
      <h2>{decisionQuestion(workCase, option)}</h2>
      {option && <ProposalOptionView option={option} expiresAt={proposal?.expiresAt || null} stageLabel={proposal?.status === 'countered' ? 'Counteroffer' : 'Offer'} partyLabel={optionParty?.displayName} />}
      {policy && <button className="decision-policy" onClick={onPolicy}>{humanize(policy.reasonCode)} · {humanize(policy.matchedPolicyId || 'Human approval')}</button>}
      {canManageInbox && <div className="decision-actions"><button className="button primary" disabled={Boolean(busy) || !canSubmitCaseDecision(workCase, 'approveOnce')} onClick={() => onAction('approveOnce')}>Approve Once</button><button className="button secondary" disabled title="Changing a proposal needs instruction support">Change</button><button className="button secondary" disabled={Boolean(busy) || !canSubmitCaseDecision(workCase, 'decline')} onClick={() => onAction('decline')}>Decline</button><button className="button quiet" disabled title="Policy editing needs server support">Always allow this</button></div>}
    </section>
  );
}

function ProposalOptionView({ option, expiresAt, stageLabel, partyLabel, muted = false }: { option: ProposalOption; expiresAt: string | null; stageLabel?: string; partyLabel?: string; muted?: boolean }) {
  const start = typeof option.value.start === 'string' ? option.value.start : null;
  const end = typeof option.value.end === 'string' ? option.value.end : null;
  const timezone = String(option.value.timezone || 'UTC');
  const terms = Object.entries(option.value).filter(([key]) => !['title', 'start', 'end', 'timezone'].includes(key));
  return (
    <div className={`proposal-option ${muted ? 'is-superseded' : ''}`}><CalendarDays size={18} /><div>{stageLabel && <span className="proposal-party">{stageLabel}{partyLabel ? ` · ${partyLabel}` : ''}</span>}<strong>{start ? `${formatDate(start)} · ${formatTime(start)}${end ? `–${formatTime(end)}` : ''}` : humanize(option.value.title || 'Proposed option')}</strong>{start && <span>{timezone} · {provenanceLabel(option.sourceConfidence)}</span>}{!start && <span>{provenanceLabel(option.sourceConfidence)}</span>}{terms.length > 0 && <dl className="proposal-terms">{terms.map(([key, value]) => <div key={key}><dt>{humanize(key)}</dt><dd>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd></div>)}</dl>}{expiresAt && !muted && <small>Tentative hold expires {formatAbsolute(expiresAt)}</small>}{muted && <small>Superseded by a counteroffer</small>}</div>{option.outOfPolicyFlags?.map(flag => <span key={flag} className="risk-label"><AlertCircle size={12} />{humanize(flag)}</span>)}</div>
  );
}

export function ProposalHistory({ workCase, view, events }: { workCase: WorkCase; view: HumanView; events: CaseEvent[] }) {
  if (!workCase.proposals?.length) return null;
  return (
    <section className="proposal-history" aria-labelledby="proposal-history-title">
      <div className="section-heading"><div><p className="eyebrow">Negotiation record</p><h2 id="proposal-history-title">Offers and counteroffers</h2></div><span>{workCase.proposals.length} {workCase.proposals.length === 1 ? 'proposal' : 'proposals'}</span></div>
      <div className="proposal-history-list">{workCase.proposals.map(proposal => {
        const parties = proposalParties(workCase, proposal.id, events, view);
        return <article key={proposal.id} className="proposal-history-item"><header><div><strong>{humanize(proposal.kind)} proposal</strong><code>{proposal.id}</code></div><StatusText value={proposal.status} /></header><div className="proposal-history-options">{proposal.options.map(option => {
          const isCounteroffer = proposal.status === 'countered' && !option.expired;
          return <ProposalOptionView key={option.id} option={option} expiresAt={proposal.expiresAt} stageLabel={isCounteroffer ? 'Counteroffer' : 'Offer'} partyLabel={(isCounteroffer ? parties.counterparty : parties.originator).displayName} muted={option.expired} />;
        })}</div></article>;
      })}</div>
    </section>
  );
}

function proposalParties(workCase: WorkCase, proposalId: string, events: CaseEvent[], view: HumanView) {
  const proposalEvents = events.filter(event => event.payload.proposalId === proposalId);
  const originEvent = proposalEvents.find(event => String(event.payload.status || '').toLowerCase() !== 'countered');
  const counterEvent = proposalEvents.slice().reverse().find(event => String(event.payload.messageType || event.payload.status || '').toLowerCase().includes('counter'));
  const originator = resolveParticipant(workCase, originEvent?.actor || workCase.actingAgent, view.agents, view.participantDirectory, localAgentId(workCase, view));
  const candidateId = participantIds(workCase, events).find(id => id !== workCase.actingAgent && id !== workCase.principal);
  const counterExchange = counterEvent ? exchangeParties(workCase, counterEvent, view.agents, view.participantDirectory, localAgentId(workCase, view)) : null;
  const counterparty = counterExchange
    ? counterExchange.sender.id === workCase.actingAgent ? counterExchange.recipient : counterExchange.sender
    : resolveParticipant(workCase, candidateId, view.agents, view.participantDirectory, localAgentId(workCase, view));
  return { originator, counterparty };
}

function TimelineEvent({ event, last, view, workCase, onPolicy }: { event: CaseEvent; last: boolean; view: HumanView; workCase: WorkCase; onPolicy: (policy: PolicyEvaluation) => void }) {
  const participant = resolveParticipant(workCase, event.actor, view.agents, view.participantDirectory, localAgentId(workCase, view));
  const policy = workCase.policyEvaluations?.find(item => item.id === event.linkedPolicyEvaluation);
  const actor = event.actor ? participant.displayName : 'Envoi system';
  const actorIsAgent = participant.type === 'internalAgent' || participant.type === 'externalAgent';
  const tone = event.type === 'error' ? 'unknown' : event.type === 'receipt' ? 'success' : event.type === 'decision' ? 'attention' : 'neutral';
  return (
    <li className={`timeline-event tone-${tone}`} tabIndex={0}>
      <div className="timeline-rail"><span className={`event-node type-${event.type}`}><EventIcon type={event.type} /></span>{!last && <span className="rail-line" />}</div>
      <div className="event-body">{isExchangeEvent(event)
        ? <ExchangeLedgerEvent event={event} view={view} workCase={workCase} />
        : <><div className="event-meta"><span className={`identity-label ${actorIsAgent ? 'agent' : 'system'}`}>{actorIsAgent ? <Bot size={13} /> : <Database size={13} />}{actor}<small>{participantRole(participant)}</small></span><time dateTime={event.createdAt}>{formatAbsolute(event.createdAt)}</time></div><p>{eventSummary(event)}</p></>}
        {policy && <button className="authority-link compact" onClick={() => onPolicy(policy)}><AuthoritySeal decision={policy.decision} /><span>Linked policy record: {humanize(policy.matchedPolicyId || policy.reasonCode)}</span></button>}
      </div>
    </li>
  );
}

export function ExchangeLedgerEvent({ event, view, workCase }: { event: CaseEvent; view: HumanView; workCase: WorkCase }) {
  const exchange = exchangeParties(workCase, event, view.agents, view.participantDirectory, localAgentId(workCase, view));
  const label = exchangeEventLabel(event);
  return (
    <article className="exchange-ledger" aria-label={`${label} from ${exchange.sender.displayName} to ${exchange.recipient.displayName}`}>
      <header className="exchange-ledger-meta"><span className="exchange-kind">{label}</span><span className={`exchange-direction direction-${exchange.direction}`}>{exchange.direction === 'outbound' ? 'Outbound' : exchange.direction === 'inbound' ? 'Inbound' : 'Party to party'}</span><time dateTime={event.createdAt}>{formatAbsolute(event.createdAt)}</time></header>
      <div className="exchange-route">
        <ExchangeParty participant={exchange.sender} role="From" />
        <span className="exchange-arrow" aria-hidden="true"><ArrowRight size={18} /></span>
        <ExchangeParty participant={exchange.recipient} role="To" />
      </div>
      {event.payload.subject && <strong className="email-subject">Subject: {String(event.payload.subject)}</strong>}
      <p>{eventSummary(event)}</p>
      {event.payload.deliveryState && <span className="delivery-state">{event.payload.deliveryState === 'deadLettered' ? <AlertCircle size={13} /> : ['queued', 'retrying'].includes(event.payload.deliveryState) ? <Clock3 size={13} /> : <CheckCircle2 size={13} />}{humanize(event.payload.deliveryState)}</span>}
    </article>
  );
}

function ExchangeParty({ participant, role }: { participant: ReturnType<typeof resolveParticipant>; role: 'From' | 'To' }) {
  const isAgent = participant.type === 'internalAgent' || participant.type === 'externalAgent';
  return <div className="exchange-party"><span className="exchange-party-role">{role}</span><span className={`identity-mark ${isAgent ? 'agent' : 'human'}`}>{isAgent ? <Bot size={14} /> : <UserRound size={14} />}</span><span><strong>{participant.displayName}</strong><small>{participantRole(participant)}</small></span></div>;
}

function exchangeEventLabel(event: CaseEvent) {
  const messageType = String(event.payload.messageType || '').toLowerCase();
  if (messageType === 'email') return event.payload.senderEmail ? 'Email reply' : 'Email';
  if (messageType === 'proposal' || (event.payload.proposalId && event.payload.status === 'open')) return 'Offer';
  if (messageType === 'counterproposal' || String(event.payload.status || '').toLowerCase() === 'countered') return 'Counteroffer';
  if (messageType === 'request') return 'Request';
  if (messageType === 'acceptance') return 'Acceptance';
  if (messageType === 'rejection') return 'Rejection';
  if (messageType === 'decision') return `Decision: ${humanize(event.payload.data?.decision?.kind || 'recorded')}`;
  if (messageType === 'completion') return 'Completion';
  return 'Message';
}

function participantRole(participant: ReturnType<typeof resolveParticipant>) {
  if (participant.relationship === 'localAgent') return 'Your agent';
  if (participant.relationship === 'principal') return 'Human principal';
  if (participant.relationship === 'unknown') return 'Unknown external agent';
  if (participant.type === 'externalAgent') return 'Counterparty agent';
  if (participant.type === 'internalAgent') return 'Internal agent';
  return humanize(participant.type);
}

function ContextRail({ workCase, view, onPolicy, onEvidence, notify }: { workCase: WorkCase; view: HumanView; onPolicy: (item: PolicyEvaluation) => void; onEvidence: (item: EvidenceItem) => void; notify: (message: string) => void }) {
  const participants = participantIds(workCase, timelineForCase(workCase, view.messages));
  const assets = view.assets.filter(item => item.caseId === workCase.id);
  const deliveries = view.deliveryReceipts.filter(item => timelineForCase(workCase, view.messages).some(event => event.payload.messageId === item.messageId));
  return (
    <aside className="context-rail" aria-label="Conversation details">
      <RailSection title="Recorded policy evaluations" icon={<ShieldCheck size={16} />}>
        {workCase.policyEvaluations?.length ? workCase.policyEvaluations.map(item => <button key={item.id} className="rail-row interactive" onClick={() => onPolicy(item)}><AuthoritySeal decision={item.decision} /><span><strong>{humanize(item.requestedAction)}</strong><small>{humanize(item.grantType)} · {humanize(item.decision)}</small></span><ChevronDown size={14} /></button>) : <RailEmpty>No special permission has been requested.</RailEmpty>}
      </RailSection>
      <RailSection title="Evidence" icon={<FileCheck2 size={16} />}>
        {workCase.evidence?.map(item => <button key={item.id} className="rail-row interactive" onClick={() => onEvidence(item)}><FileText size={17} /><span><strong>{item.title}</strong><small>{provenanceLabel(item.provenance)}</small></span></button>)}
        {assets.map(item => <AssetRow key={item.id} asset={item} inboxId={view.inbox.id} notify={notify} />)}
        {!workCase.evidence?.length && !assets.length && <RailEmpty>No evidence has been attached.</RailEmpty>}
      </RailSection>
      <RailSection title="Delivery receipts" icon={<ReceiptText size={16} />}>
        {deliveries.length ? deliveries.map(item => <div key={item.id} className="rail-row"><CheckCircle2 size={17} /><span><strong>{item.transport === 'email' || item.type === 'email' ? `Email ${humanize(item.state).toLowerCase()}` : humanize(item.state)}</strong><small>{item.recipientEmail || item.senderEmail || item.recipientAgentId || item.messageId} · {formatAbsolute(item.createdAt)}</small></span></div>) : <RailEmpty>No delivery receipt has been recorded.</RailEmpty>}
      </RailSection>
      <RailSection title="Participants" icon={<UsersRound size={16} />}>
        {participants.length ? participants.map(id => { const participant = resolveParticipant(workCase, id, view.agents, view.participantDirectory, localAgentId(workCase, view)); const isAgent = participant.type === 'internalAgent' || participant.type === 'externalAgent'; return <div key={id} className="rail-row"><span className={`identity-mark ${isAgent ? 'agent' : 'human'}`}>{isAgent ? <Bot size={14} /> : <UserRound size={14} />}</span><span><strong>{participant.displayName}</strong><small>{participantRole(participant)}</small></span></div>; }) : <RailEmpty>No additional participants are recorded.</RailEmpty>}
      </RailSection>
      <RailSection title="Constraints" icon={<ListFilter size={16} />}>
        {Object.keys(workCase.constraints || {}).length ? Object.entries(workCase.constraints || {}).map(([key, value]) => <div className="constraint-row" key={key}><span>{humanize(key)}</span><strong>{String(value)}</strong></div>) : <RailEmpty>No structured constraints are recorded.</RailEmpty>}
      </RailSection>
    </aside>
  );
}

export function AssetRow({ asset, inboxId, notify }: { asset: Asset; inboxId: string; notify: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const state = assetStateMeta(asset);
  const downloadable = canDownloadAsset(asset);
  async function download() {
    setBusy(true);
    try {
      const { url, filename } = await prepareCaseAssetDownload(inboxId, asset);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.rel = 'noopener';
      link.referrerPolicy = 'no-referrer';
      document.body.appendChild(link);
      link.click();
      link.remove();
      notify(`Downloading ${assetDisplayName(asset)}.`);
    } catch (caught) {
      notify(assetDownloadError(caught));
    } finally {
      setBusy(false);
    }
  }
  return <div className={`asset-row tone-${state.tone}`}><div className="asset-row-heading"><FileText size={17} /><span><strong>{assetDisplayName(asset)}</strong><small>{asset.mimeType} · {formatBytes(asset.size)}</small></span></div><span className="asset-state"><StatusGlyph state={downloadable ? 'completed' : state.tone === 'danger' ? 'failed' : state.tone === 'unknown' ? 'unknownExternalResult' : 'waitingForExternalParty'} />{state.label}</span><p>{state.description}</p>{downloadable && <button className="button tertiary compact" disabled={busy} onClick={() => void download()}><Download size={14} />{busy ? 'Preparing…' : 'Download file'}</button>}</div>;
}

function RailSection({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) { return <section className="rail-section"><h3>{icon}{title}</h3>{children}</section>; }
function RailEmpty({ children }: { children: ReactNode }) { return <p className="rail-empty">{children}</p>; }

export function ReceiptCard({ workCase }: { workCase: WorkCase }) {
  const receipt = workCase.receipt;
  if (!receipt || typeof receipt.result !== 'string' || !receipt.result.trim()) return null;
  function exportReceipt() {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ caseId: workCase.id, receipt }, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `envoi-receipt-${workCase.id}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
  return (
    <section className="receipt-card"><div className="receipt-header"><ShieldCheck size={18} /><h2>Receipt</h2><button className="button secondary" onClick={exportReceipt}><Download size={14} />Export</button></div><div className="receipt-grid"><div><span>Outcome</span><strong>{receipt.result}</strong></div><div><span>Confirmation</span><strong>{receipt.externalIds && Object.keys(receipt.externalIds).length ? 'External ID recorded' : 'Not recorded'}</strong></div><div><span>Authority</span><strong>{humanize(receipt.authorityBasis)}</strong></div><div><span>Human approval</span><strong>{humanize(receipt.humanApprovalStatus)}</strong></div><div><span>Completed</span><strong>{formatAbsolute(receipt.createdAt || workCase.updatedAt || workCase.createdAt)}</strong></div>{receipt.counterparties?.length ? <div><span>Counterparties</span><strong>{receipt.counterparties.join(', ')}</strong></div> : null}{receipt.evidenceRefs?.length ? <div><span>Documents</span><strong>{receipt.evidenceRefs.join(', ')}</strong></div> : null}{Object.entries(receipt.externalIds || {}).map(([key, value]) => <div key={key}><span>{humanize(key)}</span><code>{String(value)}</code></div>)}</div></section>
  );
}

function SharedFilesPage({ view, notify, onOpenCase }: { view: HumanView; notify: (message: string) => void; onOpenCase: (workCase: WorkCase) => void }) {
  const [query, setQuery] = useState('');
  const [direction, setDirection] = useState<'all' | 'received' | 'sent'>('all');
  const [kind, setKind] = useState('');
  const [layout, setLayout] = useState<'list' | 'grid'>('list');
  const [folder, setFolder] = useState('');
  const sourceFor = (asset: Asset) => fileSourceView(asset, view);
  const caseFor = (asset: Asset) => sourceFor(asset).caseQueue.find(item => item.id === asset.caseId) || view.caseQueue.find(item => item.id === asset.caseId);
  const folderFor = (asset: Asset) => fileFolderFor(asset, view);
  const folders = [...new Map(view.assets.map(asset => {
    const fileFolder = folderFor(asset);
    return [fileFolder.id, fileFolder] as const;
  })).values()].sort((left, right) => left.label.localeCompare(right.label));
  const selectedFolder = folders.find(item => item.id === folder);
  const kinds = [{ label: 'PDFs', match: 'pdf' }, { label: 'Documents', match: 'document' }, { label: 'Spreadsheets', match: 'sheet' }, { label: 'Images', match: 'image/' }, { label: 'Archives', match: 'zip' }];
  const files = view.assets.filter(asset => {
    const workCase = caseFor(asset);
    const source = sourceFor(asset);
    const localId = workCase ? localAgentId(workCase, source) : source.inbox.ownerAgentId;
    const owner = Boolean(localId && asset.createdByAgentId === localId);
    return (!folder || folderFor(asset).id === folder) && (!query || `${assetDisplayName(asset)} ${caseFor(asset)?.objective || ''} ${folderFor(asset).label}`.toLowerCase().includes(query.toLowerCase())) && (direction === 'all' || Boolean(localId) && (direction === 'sent') === owner) && (!kind || `${asset.mimeType} ${assetDisplayName(asset)}`.toLowerCase().includes(kind));
  }).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return <div className="files-page">
    <div className="files-heading"><div><h1>Files</h1><p>Files shared in your agents’ conversations.</p></div>{view.assets.length > 0 && <div className="files-search"><Search size={16} /><input aria-label="Search files" placeholder="Search files" value={query} onChange={event => setQuery(event.target.value)} /></div>}</div>
    {view.assets.length > 0 && <><div className="files-toolbar"><div className="files-segment" aria-label="File direction">{([['all','All'],['received','Received'],['sent','Sent by my agents']] as const).map(([value,label]) => <button key={value} aria-pressed={direction === value} onClick={() => setDirection(value)}>{label}</button>)}</div><div className="files-types">{kinds.map(item => <button key={item.label} aria-pressed={kind === item.match} onClick={() => setKind(current => current === item.match ? '' : item.match)}>{item.label}</button>)}</div><div className="files-segment layout-toggle"><button aria-label="List view" aria-pressed={layout === 'list'} onClick={() => setLayout('list')}><List size={16} /></button><button aria-label="Grid view" aria-pressed={layout === 'grid'} onClick={() => setLayout('grid')}><LayoutGrid size={16} /></button></div></div>
    {folder && <div className="files-breadcrumb"><button onClick={() => setFolder('')}>Files</button><ChevronRight size={16} /><span>{selectedFolder?.label || 'Other files'}</span></div>}</>}
    {!folder && folders.length > 0 && <section className="files-folders"><h2>Folders</h2><div className="folder-grid">{folders.map((item, index) => <button key={item.id} onClick={() => setFolder(item.id)}><Folder size={22} fill={AGENT_COLORS[index % AGENT_COLORS.length]} color={AGENT_COLORS[index % AGENT_COLORS.length]} /><span>{item.label}</span><small>{view.assets.filter(asset => folderFor(asset).id === item.id).length}</small></button>)}</div></section>}
    <section className="recent-files">{view.assets.length > 0 && <h2>{selectedFolder?.label || 'Recent files'}</h2>}{files.length ? <div className={`file-items ${layout}`}><div className="file-columns"><span>Name</span><span>Case</span><span>From</span><span>Modified</span><span>Size</span><span>Status</span></div>{files.map(asset => <FileItem key={asset.id} asset={asset} workCase={caseFor(asset)} creator={sourceFor(asset).agents.find(agent => agent.id === asset.createdByAgentId)} inboxId={sourceFor(asset).inbox.id} notify={notify} onOpenCase={onOpenCase} />)}</div> : <div className="files-empty"><span className="empty-icon"><FileText size={25} /></span><strong>{view.assets.length ? 'No matching files' : 'No files yet'}</strong><span>{view.assets.length ? 'Try another search or filter.' : 'Files shared in conversations will appear here.'}</span></div>}</section>
  </div>;
}

export function FileItem({ asset, workCase, creator, inboxId, notify, onOpenCase }: { asset: Asset; workCase?: WorkCase; creator?: Agent; inboxId: string; notify: (message: string) => void; onOpenCase: (workCase: WorkCase) => void }) {
  const safe = canDownloadAsset(asset);
  const status = assetStateMeta(asset);
  async function download() {
    try {
      const { url, filename } = await prepareCaseAssetDownload(inboxId, asset);
      const link = document.createElement('a'); link.href = url; link.download = filename; link.rel = 'noopener'; link.referrerPolicy = 'no-referrer'; document.body.appendChild(link); link.click(); link.remove();
      notify('Downloading');
    } catch (caught) { notify(assetDownloadError(caught)); }
  }
  return <div className="file-item"><div className="file-name"><span className="file-type"><FileText size={16} /></span><div><strong>{assetDisplayName(asset)}</strong><small>{formatDate(asset.createdAt)}</small></div></div><div>{workCase ? <button className="file-case-link" onClick={() => onOpenCase(workCase)}>{caseSubject(workCase)}</button> : 'No case'}</div><div>{creator?.name || 'Other agent'}</div><time dateTime={asset.createdAt}>{formatDate(asset.createdAt)}</time><div>{formatBytes(asset.size)}</div><div className={`file-scan ${safe ? 'safe' : status.tone}`} title={status.description}>{safe ? <ShieldCheck size={14} /> : <Clock3 size={14} />}{status.label}</div>{safe && <button className="file-download" aria-label={`Download ${assetDisplayName(asset)}`} onClick={() => void download()}><Download size={15} /></button>}</div>;
}

const PLANNED_ACTION_GATES = ['Calendar availability', 'Hold times', 'Submit forms', 'Spend money'];

export function PoliciesPage({ entries, onConnect, onRefresh, notify }: { entries: AgentEntry[]; onConnect: () => void; onRefresh: (inboxId: string) => Promise<void>; notify: (message: string) => void }) {
  const [editing, setEditing] = useState<AgentEntry | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reconsentRequired, setReconsentRequired] = useState(false);
  function openEditor(entry: AgentEntry) {
    setEditing(entry);
    setSelected(entry.agent.permissions);
    setError(''); setReconsentRequired(false);
  }
  async function save() {
    if (!editing || reconsentRequired) return;
    setBusy(true); setError('');
    try {
      const hidden = editing.agent.permissions.filter(permission => !AGENT_PERMISSION_OPTIONS.some(option => option.id === permission));
      await api.updateAgentPermissions(editing.inbox.id, editing.agent.id, [...selectedAgentPermissions(selected), ...hidden], editing.agent.permissions);
      const inboxId = editing.inbox.id;
      setEditing(null);
      notify(`${editing.agent.name}’s permissions updated.`);
      try { await onRefresh(inboxId); }
      catch { notify('Permissions saved. Refresh to see the latest access.'); }
    } catch (caught) { setError(errorMessage(caught)); setReconsentRequired(caught instanceof ApiError && caught.code === 'OAUTH_RECONSENT_REQUIRED'); }
    finally { setBusy(false); }
  }
  return <PageFrame eyebrow="" title="Permissions" description="Review and update what each agent can do.">
    <DotsPermissionRecovery agents={entries.filter(entry => entry.view.canManageInbox).map(entry => entry.agent)} />
    {entries.length === 0 ? <PageEmpty icon={<ShieldCheck />} title="No agents yet" body="Connect an agent to see its permissions." action={<button className="button secondary" onClick={onConnect}>Connect an agent</button>} /> : <><div className="permission-editor-actions">{entries.filter(entry => entry.view.canManageInbox && entry.agent.onboardingStatus === 'approved' && ['active', 'paused'].includes(entry.agent.status)).map(entry => <button key={entry.agent.id} type="button" className="button secondary compact" onClick={() => openEditor(entry)}>Edit {entry.agent.name}’s permissions</button>)}</div><div className="permission-table" role="table" aria-label="Agent permissions" style={{ '--agent-columns': Math.max(1, entries.length) } as React.CSSProperties}>
      <div className="permission-table-head" role="row"><span role="columnheader">Action</span>{entries.map(({ agent }) => <span role="columnheader" key={agent.id}>{agent.name}</span>)}</div>
      {AGENT_PERMISSION_OPTIONS.map(option => <div className="permission-table-row" role="row" key={option.id}><div role="cell"><strong>{option.label}</strong><small>{option.description}</small></div>{entries.map(entry => {
        const { agent } = entry;
        const enabled = agent.permissions.includes(option.id);
        return <div role="cell" key={agent.id} data-agent={agent.name}><span className={`permission-pill ${enabled ? 'allowed' : 'off'}`} aria-label={`${option.label} for ${agent.name}: ${option.required ? 'Always on' : enabled ? 'Allowed' : 'Off'}`}>{option.required ? 'Always on' : enabled ? 'Allowed' : 'Off'}</span></div>;
      })}</div>)}
      {PLANNED_ACTION_GATES.map(label => <div className="permission-table-row" role="row" key={label}><div role="cell"><strong>{label}</strong><small>Permission gating is not available yet. Execution is disabled.</small></div>{entries.map(({ agent }) => <div role="cell" key={agent.id} data-agent={agent.name}><span className="permission-pill off" aria-label={`${label} unavailable for ${agent.name}`}>Unavailable</span></div>)}</div>)}
    </div>
    <MonadPermissionPanel agents={entries.filter(entry => entry.view.canManageInbox).map(({ agent, inbox }) => ({ id: agent.id, name: agent.name, inboxId: inbox.id }))} /></>}
    {editing && <Modal title={`Edit ${editing.agent.name}’s permissions`} onClose={() => setEditing(null)} dismissible={!busy}>
      <p>Changes apply to future agent actions. Earlier activity stays in the record.</p>
      <AgentPermissionPicker selected={selected} onChange={value => { setSelected(value); setError(''); setReconsentRequired(false); }} />
      <FormError message={error} />
      {reconsentRequired && <><p>Approve the missing access in your Dot using the message access prompt below. Saving these same choices again cannot expand OAuth access. After approval, close this editor and refresh permissions.</p><DotsSetupGuide origin={window.location.origin} name={editing.agent.name} address={editing.agent.address} reconnect /></>}
      <div className="dialog-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => setEditing(null)}>Cancel</button><button type="button" className="button primary" disabled={busy || reconsentRequired} onClick={() => void save()}>{busy ? 'Saving…' : 'Save permissions'}</button></div>
    </Modal>}
  </PageFrame>;
}

function IntegrationsPage({ entries, humanId, canManageInbox, onConnect, onSelectWorkspace, onPermissions, onRefresh, onRefreshAgent, notify }: { view: HumanView; workspace: Workspace; entries: AgentEntry[]; humanId: string; canManageInbox: boolean; onConnect: () => void; onSelectWorkspace: (workspace: Workspace) => Promise<void>; onPermissions: () => void; onRefresh: () => Promise<unknown>; onRefreshAgent: (inboxId: string) => Promise<void>; notify: (message: string) => void }) {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'setup' | 'paused'>('all');
  const visibleEntries = entries.filter(({ agent }) => {
    const matchesQuery = `${agent.name} ${agent.address} ${agent.platformAddress || ''}`.toLowerCase().includes(query.trim().toLowerCase());
    const matchesStatus = statusFilter === 'all' || (statusFilter === 'paused' ? agent.paused : statusFilter === 'setup' ? agent.onboardingStatus !== 'approved' : agent.onboardingStatus === 'approved' && !agent.paused && agent.status !== 'revoked');
    return matchesQuery && matchesStatus;
  });
  return <div className="agents-page"><div className="agents-heading"><div><p className="eyebrow">YOUR WORKSPACE</p><h1>Manage agents</h1><p>Connect an agent, review its access, and see its work in one place.</p></div></div>
    <section className="agents-onboard-hero"><div><p className="eyebrow">GET STARTED</p><h2>Bring your agents together.</h2><p>Each agent gets its own Envoi address and a secure workspace. Choose a platform to start setup.</p>{canManageInbox && <ConnectionActions onConnect={onConnect} />}</div><div className="agents-hero-logos" aria-hidden="true">{agentCatalog.slice(0, 6).map(item => <span key={item.id}><img src={item.logo} alt="" width="42" height="42" /></span>)}</div></section>
    {entries.length ? <section className="agents-list-section" aria-label="Connected agents"><div className="agents-list-topline"><div><h2>Your agent team</h2><p>{entries.length} {entries.length === 1 ? 'agent' : 'agents'} in this workspace</p></div></div><div className="agents-toolbar"><label className="agents-search"><Search size={17} aria-hidden="true" /><span className="sr-only">Search agents</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search agents" /></label><label className="agents-filter"><span className="sr-only">Filter agents by status</span><ListFilter size={17} aria-hidden="true" /><select value={statusFilter} onChange={event => setStatusFilter(event.target.value as typeof statusFilter)}><option value="all">All statuses</option><option value="active">Active</option><option value="setup">Needs setup</option><option value="paused">Paused</option></select></label></div><div className="agents-table-head" aria-hidden="true"><span>Agent</span><span>Work</span><span>Status & access</span><span>Actions</span></div>{visibleEntries.length ? <div className="integration-grid">{visibleEntries.map(({ agent, inbox, view: agentView }, index) => <AgentCard key={agent.id} agent={agent} workspace={inbox} humanId={humanId} canManageInbox={agentView.canManageInbox} emailTransport={null} onRefresh={async () => { await onRefreshAgent(inbox.id); await onRefresh(); }} notify={notify} color={AGENT_COLORS[index % AGENT_COLORS.length]} cases={agentView.caseQueue} onPermissions={onPermissions} onOpenInbox={() => void onSelectWorkspace(inbox)} />)}</div> : <div className="agents-filter-empty"><p>No agents match these filters.</p><button className="button secondary" onClick={() => { setQuery(''); setStatusFilter('all'); }}>Clear filters</button></div>}</section> : <div className="agents-empty"><span className="agents-empty-icon"><Bot size={24} aria-hidden="true" /></span><div><h2>No agents connected yet</h2><p>Use the connection options above to begin. Your connected agents and their inboxes will appear here.</p></div></div>}
    {canManageInbox && <div className="agents-secondary"><OwnerClaims key={humanId} humanId={humanId} onSelectAgent={(agentId, address) => { const entry = entries.find(item => item.inbox.kind === 'agent' && (item.agent.id === agentId || item.agent.address === address)); if (entry) void onSelectWorkspace(entry.inbox); }} /></div>}
  </div>;
}

function SafeguardCard({ icon, title, status, body }: { icon: ReactNode; title: string; status: string; body: string }) {
  return <article className="safeguard-card"><span className="safeguard-icon">{icon}</span><div><header><strong>{title}</strong><span>{status}</span></header><p>{body}</p></div></article>;
}

export function ConnectionInvitations({ invitations, error, workspace, canManageInbox, onReload, onRefresh, notify }: { invitations: AgentConnectionInvitation[]; error: string; workspace: Workspace; canManageInbox: boolean; onReload: () => Promise<void>; onRefresh: () => Promise<unknown>; notify: (message: string) => void }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');

  async function decide(invitationId: string, decision: 'accept' | 'decline') {
    setBusyId(invitationId);
    setActionError('');
    try {
      if (decision === 'accept') await api.acceptInvitation(workspace.id, invitationId);
      else await api.declineInvitation(workspace.id, invitationId);
      notify(decision === 'accept' ? 'Agent connection accepted. The conversation is now active.' : 'Agent connection declined. No messages were delivered.');
      await onRefresh();
      await onReload();
    } catch (caught) {
      const message = errorMessage(caught);
      setActionError(message);
      notify(message);
    } finally {
      setBusyId(null);
    }
  }

  const actionableCount = invitations.filter(item => canManageInbox && item.state === 'pending' && item.actionable === true).length;
  return <section className="connection-invitations" aria-labelledby="invitations-title" aria-live="polite"><div className="section-heading"><div><p className="eyebrow">Discovery layer</p><h2 id="invitations-title">Connection invitations</h2></div><span>{actionableCount} need review</span></div>{error || actionError ? <div className="recoverable-state"><InlineNotice title="Invitation feed unavailable" body={actionError || error} tone="unknown" /><button type="button" className="button secondary compact" onClick={() => void onReload()}>Try again</button></div> : invitations.length ? <div className="invitation-list">{invitations.map(item => {
    const busy = busyId === item.id;
    const incoming = item.direction === 'incoming';
    const counterpartAddress = incoming ? item.fromAddress : item.toAddress;
    return <article key={item.id}><span className="identity-mark agent"><Bot size={15} /></span><div><strong>{counterpartAddress}</strong><code>{incoming ? `To ${item.toAddress}` : `From ${item.fromAddress}`}</code><small>{incoming ? 'Received' : 'Sent'} {formatAbsolute(item.createdAt)} · exact address match</small></div>{canManageInbox && item.state === 'pending' && item.actionable === true ? <div className="invitation-decision-actions"><button type="button" className="button secondary compact" disabled={busy} aria-label={`Decline connection invitation from ${item.fromAddress}`} onClick={() => void decide(item.id, 'decline')}>{busy ? 'Working…' : 'Decline'}</button><button type="button" className="button primary compact" disabled={busy} aria-label={`Accept connection invitation from ${item.fromAddress}`} onClick={() => void decide(item.id, 'accept')}>{busy ? 'Working…' : 'Accept'}</button></div> : item.state === 'pending' && item.direction === 'outgoing' ? <div className="invitation-pending-status"><StatusText value="pending" /><small>Awaiting recipient approval</small></div> : <StatusText value={item.state} />}</article>;
  })}</div> : <div className="compact-empty"><CheckCircle2 size={18} /><span><strong>No incoming invitations</strong><small>Share your agent’s exact platform address. First-contact requests appear here before any message is delivered.</small></span></div>}</section>;
}

function ApprovedContacts({ emailTransport, error, workspace, canManageInbox, onReload, notify }: { emailTransport: EmailTransportStatus | null; error: string; workspace: Workspace; canManageInbox: boolean; onReload: () => Promise<void>; notify: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const canManage = canManageInbox && Boolean(emailTransport?.ready);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusyId('new'); setActionError('');
    try {
      await api.approveExternalContact(workspace.id, { email: String(data.get('email') || ''), displayName: String(data.get('displayName') || ''), direction: String(data.get('direction') || 'both') as ApprovedEmailContact['direction'] });
      form.reset(); setOpen(false); notify('External contact approved for the selected email direction.'); await onReload();
    } catch (caught) { const message = errorMessage(caught); setActionError(message); notify(message); }
    finally { setBusyId(null); }
  }
  async function setBlocked(contact: ApprovedEmailContact, blocked: boolean) {
    setBusyId(contact.id); setActionError('');
    try { await api.setExternalContactBlocked(workspace.id, contact.id, blocked); notify(blocked ? 'External contact blocked.' : 'External contact restored.'); await onReload(); }
    catch (caught) { const message = errorMessage(caught); setActionError(message); notify(message); }
    finally { setBusyId(null); }
  }
  return <section className="approved-contacts" aria-labelledby="approved-contacts-title"><div className="section-heading"><div><p className="eyebrow">Public email boundary</p><h2 id="approved-contacts-title">Approved contacts</h2></div><div className="section-actions"><span>Agent-owned sending</span>{canManage && <button type="button" className="button tertiary compact" onClick={() => setOpen(current => !current)}>{open ? 'Cancel' : 'Approve contact'}</button>}</div></div>{open && canManage && <form className="contact-approval-form" onSubmit={submit}><Field label="Contact name" name="displayName" placeholder="Jordan Lee" required /><Field label="Email address" name="email" type="email" autoComplete="email" placeholder="jordan@example.com" required /><label className="field"><span>Email direction</span><select name="direction" defaultValue="both"><option value="both">Send and receive</option><option value="outbound">Send only</option><option value="inbound">Receive only</option></select></label><button className="button primary" disabled={busyId === 'new'}>{busyId === 'new' ? 'Approving…' : 'Approve exact email'}</button></form>}{actionError && <InlineNotice title="Contact update failed" body={actionError} tone="unknown" />}{error ? <div className="recoverable-state"><InlineNotice title="Contact state unavailable" body={error} tone="unknown" /><button type="button" className="button secondary compact" onClick={() => void onReload()}>Try again</button></div> : !emailTransport ? <div className="compact-empty muted"><CircleDashed size={18} /><span><strong>Checking public email readiness</strong><small>No external action is enabled until configuration and contact state are confirmed.</small></span></div> : emailTransport.contacts.length ? <div className="contact-list">{emailTransport.contacts.map(contact => { const state = contact.blocked ? 'blocked' : contact.approved ? 'approved' : 'pending'; return <article key={contact.id}><span className="identity-mark human"><UserRound size={15} /></span><div><strong>{contact.displayName}</strong><code>{contact.email}</code><small>{humanize(contact.direction)} email · updated {formatAbsolute(contact.updatedAt)}</small></div><div className="contact-actions"><StatusText value={state} />{canManageInbox && <button type="button" className="button quiet compact" disabled={busyId === contact.id} onClick={() => void setBlocked(contact, !contact.blocked)}>{busyId === contact.id ? 'Saving…' : contact.blocked ? 'Unblock' : 'Block'}</button>}</div></article>; })}</div> : <div className="compact-empty"><ShieldCheck size={18} /><span><strong>No approved public contacts</strong><small>Agents cannot send arbitrary external email. Approve an exact address before enabling contact.</small></span></div>}</section>;
}

export function AgentCard({ agent, workspace, humanId, canManageInbox, emailTransport, onRefresh, notify, color = 'var(--accent)', cases = [], onOpenInbox, onPermissions }: { agent: Agent; workspace: Workspace; humanId: string; canManageInbox: boolean; emailTransport: EmailTransportStatus | null; onRefresh: () => Promise<unknown>; notify: (message: string) => void; color?: string; cases?: WorkCase[]; onOpenInbox?: () => void; onPermissions?: () => void }) {
  const pending = agent.onboardingStatus === 'pending_approval';
  const frozen = agent.status === 'revoked' || agent.onboardingStatus === 'revoked';
  const canApproveAgent = canManageInbox || (agent.principalHumanId || workspace.ownerHumanId) === humanId;
  const [credential, setCredential] = useState('');
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [approvalError, setApprovalError] = useState('');
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [removalOpen, setRemovalOpen] = useState(false);
  const [removalBusy, setRemovalBusy] = useState(false);
  const [removalError, setRemovalError] = useState('');
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeError, setRevokeError] = useState('');
  const [revokeResult, setRevokeResult] = useState<{ revokedAt: string; credentialFamilyCount: number } | null>(null);
  const [reconnectOpen, setReconnectOpen] = useState(false);
  const [reconnectResult, setReconnectResult] = useState<EnrollmentResult | null>(null);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [pauseError, setPauseError] = useState('');
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>(DEFAULT_AGENT_PERMISSIONS);
  const [showSteps, setShowSteps] = useState(false);
  const transportAgent = emailTransport?.agents.find(item => item.agentId === agent.id);
  const platformAddress = agent.platformAddress || transportAgent?.platformAddress || transportAgent?.internalAddress || agent.address;
  const publicEmailAddress = agent.publicEmailAddress || agent.identity?.externalAddress || transportAgent?.publicEmailAddress || transportAgent?.externalAddress || null;
  const approvedAccess = !frozen && agent.onboardingStatus === 'approved';
  const agentCases = cases.filter(item => participantIds(item).includes(agent.id));
  const setupSteps = [
    ['Create workspace', true], ['Create agent identity', true], ['Redeem one-time token', agent.onboardingStatus !== 'pending'],
    ['Approve access', agent.onboardingStatus === 'approved'], ['Observe a work-loop check-in', Boolean(agent.connection?.presence.lastWorkClaimAt)],
    ['First exchange with another agent', agentCases.length > 0], ['First completed case', agentCases.some(item => caseState(item) === 'completed')]
  ] as const;
  const completedSteps = setupSteps.filter(([, complete]) => complete).length;
  async function approve() {
    setApprovalBusy(true);
    setApprovalError('');
    try {
      const result = await api.approveAgent(workspace.id, agent.id, selectedAgentPermissions(selectedPermissions));
      if (result.agentApiToken) setCredential(result.agentApiToken);
      notify('Agent approved with the selected permissions.');
      setApprovalOpen(false);
      await onRefresh();
    } catch (caught) { setApprovalError(errorMessage(caught)); }
    finally { setApprovalBusy(false); }
  }
  async function removeAgent(deleteHistory: boolean, removalConfirmation: string) {
    setRemovalBusy(true); setRemovalError('');
    try {
      await api.removeAgent(workspace.id, agent.id, deleteHistory, removalConfirmation);
      setCredential(''); setRemovalOpen(false);
      notify(deleteHistory ? 'Agent removed. Your history is deleted; owned files are queued for secure deletion.' : 'Agent removed. Its history is now read-only.');
      await onRefresh();
    } catch (caught) { setRemovalError(errorMessage(caught)); }
    finally { setRemovalBusy(false); }
  }
  async function revokeCredentials() {
    setRevokeBusy(true);
    setRevokeError('');
    try {
      const result = await api.revokeAgentCredentials(workspace.id, agent.id);
      setCredential('');
      setRevokeResult(result);
      setRevokeOpen(false);
      notify(`${agent.name} is frozen. Re-onboard to restore access.`);
      try { await onRefresh(); }
      catch { notify(`Credentials revoked for ${agent.name}. Refresh the workspace to see the latest audit event.`); }
    } catch (caught) { setRevokeError(errorMessage(caught)); }
    finally { setRevokeBusy(false); }
  }
  async function setPaused(paused: boolean) {
    setPauseBusy(true);
    setPauseError('');
    try {
      await api.setAgentPaused(workspace.id, agent.id, paused);
      notify(`${agent.name} ${paused ? 'paused' : 'resumed'}.`);
      await onRefresh();
    } catch (caught) { setPauseError(errorMessage(caught)); }
    finally { setPauseBusy(false); }
  }
  return <article className="integration-card">
    <div className="integration-heading"><span className="agent-card-avatar" style={{ background: color }}>{initials(agent.name)}</span><div><h2>{agent.name}</h2><span className="verified-address" title={platformAddress}>{platformAddress}<CopyButton value={platformAddress} label={`Copy ${agent.name} address`} /></span></div></div>
    {approvedAccess ? <><div className="agent-stats"><div><strong>{agentCases.filter(item => caseState(item) !== 'completed').length}</strong><span>Open cases</span></div><div><strong>{agentCases.filter(item => item.needsAttention).length}</strong><span>Need you</span></div></div><div className="agent-status-access"><span className="agent-presence">{agentLabel(agent)} · {connectionLabel(agent.connection)}</span><div className="capability-list">{agent.permissions.slice(0,4).map(item => <span key={item}>{humanize(item)}</span>)}</div></div></> : <div className="agent-setup"><span className="agent-presence">{agentLabel(agent)} · {connectionLabel(agent.connection)}</span><strong>Step {Math.min(7,completedSteps + 1)} of 7: {setupSteps[Math.min(6, completedSteps)][0]}</strong>{frozen && <span>No permissions active</span>}<div className="agent-progress" role="progressbar" aria-valuenow={completedSteps} aria-valuemin={0} aria-valuemax={7}><span style={{ width: `${completedSteps / 7 * 100}%` }} /></div>{pending && canApproveAgent ? <button className="button secondary" onClick={() => setApprovalOpen(true)}>Review agent access</button> : !pending && agent.status !== 'revoked' && canManageInbox ? <button className="button secondary" onClick={() => { setReconnectResult(null); setReconnectOpen(true); }}>Connect runtime</button> : null}<button className="agent-steps-toggle" aria-expanded={showSteps} onClick={() => setShowSteps(value => !value)}>{showSteps ? 'Hide steps' : 'Show all steps'}</button>{showSteps && <ol className="agent-steps">{setupSteps.map(([name, complete]) => <li key={name}>{complete ? <Check size={13} /> : <span className="step-empty" />}{name}</li>)}</ol>}</div>}
    <div className="agent-card-actions"><button className="button secondary" onClick={onOpenInbox} disabled={!onOpenInbox}>Open inbox</button><button className="button secondary" onClick={onPermissions} disabled={!onPermissions}>Permissions</button>{canManageInbox && <button type="button" className="button tertiary agent-remove-action" onClick={() => { setRemovalError(''); setRemovalOpen(true); }}>Remove agent</button>}</div>
    {revokeResult && frozen && <InlineNotice title="Agent frozen" body={`${revokeResult.credentialFamilyCount} credential ${revokeResult.credentialFamilyCount === 1 ? 'family was' : 'families were'} revoked at ${formatAbsolute(revokeResult.revokedAt)}. Re-onboarding requires a new human-approved token. The agent identity and conversation history remain visible.`} tone="attention" />}
    {credential && <div className="credential-once"><InlineNotice title="Copy this credential now" body="It is shown once. Store it only in the agent runtime’s secret manager." tone="attention" /><div className="copy-field"><input readOnly value={credential} aria-label="Agent API credential" /><CopyButton value={credential} label="Copy agent API credential" /></div></div>}
    {pauseError && <InlineNotice title="Agent control failed" body={pauseError} tone="unknown" />}
    {canManageInbox && <details className="agent-more"><summary>Advanced</summary><div>{pending && canApproveAgent && <button onClick={() => setApprovalOpen(true)}>Approve access</button>}{!frozen && agent.onboardingStatus === 'approved' && ['active', 'paused'].includes(agent.status) && <button disabled={pauseBusy} onClick={() => void setPaused(!agent.paused)}>{agent.paused ? 'Resume agent' : 'Pause agent'}</button>}{!frozen && agent.onboardingStatus === 'approved' && <button onClick={() => { setReconnectResult(null); setReconnectOpen(true); }}>Reconnect runtime</button>}{frozen && <button onClick={() => { setReconnectResult(null); setReconnectOpen(true); }}>Re-onboard agent</button>}{!frozen && agent.onboardingStatus === 'approved' && <button className="danger" onClick={() => { setRevokeError(''); setRevokeOpen(true); }}>Revoke agent access</button>}{publicEmailAddress && <span>{publicEmailAddress}</span>}</div>{workspace.kind === 'agent' && workspace.ownerAgentId === agent.id && approvedAccess && <PhaseDTrustControls inboxId={workspace.id} actorAgentId={agent.id} />}</details>}
    {removalOpen && canManageInbox && <Modal title={`Remove ${agent.name}?`} onClose={() => setRemovalOpen(false)} dismissible={!removalBusy}>
      <AgentRemovalDialogContent agentName={agent.name} busy={removalBusy} error={removalError} onClose={() => setRemovalOpen(false)} onConfirm={(deleteHistory, confirmation) => void removeAgent(deleteHistory, confirmation)} />
    </Modal>}
    {approvalOpen && canApproveAgent && <Modal title={`Approve ${agent.name}`} onClose={() => setApprovalOpen(false)}>
      <p>Choose what this agent may do. You can grant file sharing and task execution only if needed.</p>
      <AgentPermissionPicker selected={selectedPermissions} onChange={setSelectedPermissions} />
      <FormError message={approvalError} />
      <div className="dialog-actions"><button type="button" className="button secondary" onClick={() => setApprovalOpen(false)}>Cancel</button><button className="button primary" disabled={approvalBusy} onClick={() => void approve()}>{approvalBusy ? 'Approving…' : 'Approve with selected access'}</button></div>
    </Modal>}
    {revokeOpen && canManageInbox && <Modal title={`Freeze ${agent.name}?`} onClose={() => setRevokeOpen(false)} dismissible={!revokeBusy}>
      <p className="dialog-copy">This immediately revokes the agent's credentials, removes its permissions and disconnects its live stream. Only a new human-approved onboarding can restore access. Its identity and history remain visible.</p>
      <FormError message={revokeError} />
      <div className="dialog-actions"><button className="button secondary" disabled={revokeBusy} onClick={() => setRevokeOpen(false)}>Keep access</button><button className="button destructive" disabled={revokeBusy} onClick={() => void revokeCredentials()}>{revokeBusy ? 'Freezing…' : 'Freeze agent'}</button></div>
    </Modal>}
    {workspace.kind === 'agent' && workspace.ownerAgentId === agent.id && (agent.onboardingStatus === 'approved' || frozen) && <AgentInstallations key={`${humanId}:${agent.id}`} humanId={humanId} inboxId={workspace.id} agent={agent} canManage={canManageInbox} onReconnect={() => { setReconnectResult(null); setReconnectOpen(true); }} onRefresh={async () => { await onRefresh(); }} />}
    {reconnectOpen && canManageInbox && <EnrollmentDialog workspace={workspace} reconnectAgent={agent} result={reconnectResult} setResult={setReconnectResult} onRefresh={onRefresh} onClose={() => { setReconnectOpen(false); setReconnectResult(null); }} />}
  </article>;
}

const reservedAgentAddresses = new Set(['admin', 'administrator', 'agents', 'abuse', 'billing', 'contact', 'help', 'info', 'mail', 'noreply', 'no-reply', 'postmaster', 'root', 'security', 'support', 'system']);
const validAgentLocalPart = (value: string) => value.length >= 3 && value.length <= 32 && /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value) && !reservedAgentAddresses.has(value);

export function EnrollmentDialog({ workspace, agentDomain = 'envoi-agents.com', result, setResult, onClose, onRefresh, reconnectAgent }: { workspace: Workspace; agentDomain?: string; result: EnrollmentResult | null; setResult: (value: EnrollmentResult | null) => void; onClose: () => void; onRefresh?: () => Promise<unknown>; reconnectAgent?: Agent & { runtime?: ConnectorRuntime } }) {
  const reenroll = reconnectAgent?.status === 'revoked' || reconnectAgent?.credentialRevoked === true;
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [runtime, setRuntime] = useState<ConnectorRuntime>(reconnectAgent?.runtime || 'openclaw');
  const [dotsSelected, setDotsSelected] = useState(false);
  const [dotsGuideOpen, setDotsGuideOpen] = useState(false);
  const [dotsRoute, setDotsRoute] = useState<'checking' | 'available' | 'unavailable' | 'unknown'>('checking');
  const addressEdited = useRef(false);
  const [status, setStatus] = useState<EnrollmentStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [pollingAttempt, setPollingAttempt] = useState(0);
  const [copied, setCopied] = useState(false);
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>(DEFAULT_AGENT_PERMISSIONS);
  const [step, setStep] = useState<0 | 1>(0);
  const [localPartInput, setLocalPartInput] = useState('');
  const [availability, setAvailability] = useState<'idle' | 'checking' | 'available' | 'taken' | 'error'>('idle');
  const localPart = localPartInput.trim().toLowerCase();
  const handoff = result?.quickConnect;
  const chosenAddress = handoff?.address || (result?.agentProfile?.localPart ? `${result.agentProfile.localPart}@${agentDomain}` : '');
  const prompt = handoff ? setupPrompt(handoff) : '';
  const downloads = handoff ? connectorDownloads(handoff) : null;
  const phase = status?.phase || 'waiting';
  const terminal = ['ready', 'expired', 'revoked', 'error'].includes(phase);
  const tokenExpired = result ? Date.parse(result.expiresAt) <= Date.now() : false;
  const canUseHandoff = !terminal && !tokenExpired && phase === 'waiting';
  useEffect(() => {
    setStatus(null); setStatusError(''); setCopied(false);
    if (!result?.enrollmentId) return;
    let previousPhase = 'waiting';
    return watchEnrollmentStatus({
      enrollmentId: result.enrollmentId,
      expiresAt: result.expiresAt,
      request: signal => api.enrollmentStatus(workspace.id, result.enrollmentId!, signal),
      onStatus: next => {
        setStatus(next); setStatusError('');
        if (next.phase !== previousPhase && ['enrolled', 'ready'].includes(next.phase)) void refresh.current?.().catch(() => {});
        previousPhase = next.phase;
      },
      onError: setStatusError,
      onTimeout: () => setStatusError('Automatic progress checks stopped. Check your agent’s setup report, or check status again. Do not create another token if this one was already redeemed.')
    });
  }, [result, workspace.id, pollingAttempt]);
  const envoiOrigin = typeof window === 'undefined' ? '' : window.location.origin;
  const dotsOrigin = envoiOrigin && isLoopbackOrigin(envoiOrigin) ? 'https://www.envoi-agents.com' : envoiOrigin;
  const dotsName = reconnectAgent?.name || name.trim();
  const requestedAddress = reconnectAgent?.address || `${localPart}@${agentDomain}`;
  const dotsReconnectAllowed = !reconnectAgent || canReconnectAgent(reconnectAgent);
  useEffect(() => {
    if (!dotsSelected) return;
    if (workspace.id === previewWorkspace.id) { setDotsRoute('unknown'); return; }
    const stop = new AbortController();
    setDotsRoute('checking');
    void fetch('/api/onboarding/routes', { credentials: 'omit', redirect: 'error', signal: stop.signal })
      .then(response => response.ok ? response.json() : Promise.reject(new Error('Route status unavailable')))
      .then(value => { if (!stop.signal.aborted) setDotsRoute(value?.registrationEnabled && value?.installationsEnabled && value?.routes?.some((route: { connectionRoute?: string; available?: boolean }) => route.connectionRoute === 'remote_mcp_oauth' && route.available) && value?.deliveryModes?.some((mode: { deliveryMode?: string; available?: boolean }) => mode.deliveryMode === 'on_demand' && mode.available) ? 'available' : 'unavailable'); })
      .catch(() => { if (!stop.signal.aborted) setDotsRoute('unknown'); });
    return () => stop.abort();
  }, [dotsSelected, workspace.id]);
  const selectedRuntime = handoff?.runtime || runtime;
  const label = runtimeLabel(selectedRuntime);
  const prepareCommand = `node envoi-connector.mjs prepare --runtime ${runtime} --api-url ${envoiOrigin || '<Envoi origin>'}${runtime === 'hermes' ? ' --prepare-runtime' : ''}`;
  const setupCommand = `node envoi-connector.mjs setup --handoff envoi-setup.json${selectedRuntime === 'hermes' ? ' --prepare-runtime' : ''}`;
  useEffect(() => {
    if (result || reconnectAgent || !validAgentLocalPart(localPart)) { setAvailability('idle'); return; }
    if (workspace.id === previewWorkspace.id) { setAvailability('available'); return; }
    let cancelled = false;
    setAvailability('checking');
    const timer = setTimeout(() => {
      void api.agentAddressAvailability(workspace.id, localPart)
        .then(response => { if (!cancelled) setAvailability(response.available ? 'available' : 'taken'); })
        .catch(() => { if (!cancelled) setAvailability('error'); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [workspace.id, localPart, result, reconnectAgent]);
  async function copyPrompt() {
    try { await navigator.clipboard.writeText(prompt); setCopied(true); setError(''); }
    catch { setError('Clipboard access was unavailable. Expand “View setup prompt” and select the text to copy it, or use the terminal fallback.'); }
  }
  function downloadHandoff() {
    if (!handoff) return;
    try {
      const url = URL.createObjectURL(new Blob([JSON.stringify(handoff, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = 'envoi-setup.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch { setError('The setup file could not be downloaded. Save the setup JSON privately on your runtime host.'); }
  }
  function downloadAgentSkill() {
    if (!handoff || !canUseHandoff) return;
    try {
      const skill = setupSkillFile(handoff);
      const url = URL.createObjectURL(new Blob([skill], { type: 'text/markdown' }));
      const link = document.createElement('a'); link.href = url; link.download = 'SKILL.md'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch { setError('The skill file could not be downloaded. Copy the setup prompt instead.'); }
  }
  return <Modal title={dotsGuideOpen ? reconnectAgent ? 'Reconnect with Dots' : 'Connect Dots' : result ? 'Agent ready to connect' : reconnectAgent ? `${reenroll ? 'Re-onboard' : 'Reconnect'} ${reconnectAgent.name}` : 'Connect an agent'} onClose={onClose}>
    <div className="enroll-steps" aria-label="Enrollment steps">{['Agent type', 'Email address', 'Setup instructions'].map((stepName, index) => { const current = result || dotsGuideOpen ? 2 : step; return <span key={stepName} className={current === index ? 'current' : current > index ? 'complete' : ''}>{index + 1}<b>{stepName}</b></span>; })}</div>
    {dotsGuideOpen ? <section className="quick-connect dots-setup-guide">
      <p className="dialog-copy">{reconnectAgent ? 'Your Dots reconnect instructions are ready. Select this existing agent and review its installations when you approve the OAuth request.' : 'Your Dots setup is ready. Envoi confirms the address and permissions when you approve the OAuth request.'}</p>
      {dotsRoute === 'unavailable' && <InlineNotice title="Dots connection is off here" body={dotsRouteUnavailableNotice} tone="attention" />}
      <label className="field"><span>{reconnectAgent ? 'Existing agent email address' : 'Requested agent email address'}</span><input readOnly value={requestedAddress} /><small>{reconnectAgent ? 'Keep this identity when you choose Reconnect an existing agent during Envoi approval.' : 'This address is not reserved yet. Confirm it during Envoi approval.'}</small></label>
      <DotsSetupGuide origin={dotsOrigin} name={dotsName} address={requestedAddress} reconnect={Boolean(reconnectAgent)} />
      <button className="button secondary" type="button" onClick={() => { try { const file = dotsSetupSkillFile(dotsOrigin, dotsName, requestedAddress, Boolean(reconnectAgent)); const url = URL.createObjectURL(new Blob([file], { type: 'text/markdown' })); const link = document.createElement('a'); link.href = url; link.download = 'SKILL.md'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1_000); } catch { setError('The skill file could not be downloaded. Copy the prompt instead.'); } }}><Download size={16} />Download agent skill file</button>
      <FormError message={error} /><div className="dialog-actions"><button className="button secondary" type="button" onClick={onClose}>Close</button></div>
    </section> : result ? <>
      {handoff ? <>
        <p className="dialog-copy">Run the setup instructions where {label} is installed. The connector detects local settings and keeps runtime and provider credentials on that host. You can give the prompt to an agent with terminal access, or use the private setup file.</p>
        <InlineNotice title="One private setup handoff" body={`Give this prompt only to your trusted agent. Its one-use token expires ${formatAbsolute(result.expiresAt)}. Copy or download before closing; it cannot be recovered.`} tone="attention" />
      </> : <InlineNotice title="Copy before closing" body="This one-use token cannot be recovered. Give it to one trusted agent bridge; do not redeem it in the browser or a separate shell first." tone="attention" />}
      {chosenAddress && <label className="field"><span>Agent email address</span><div className="copy-field"><input readOnly value={chosenAddress} aria-label="Agent email address" /><CopyButton value={chosenAddress} label="Copy agent email address" /></div><small>This address becomes active when the agent completes setup. It cannot be renamed during beta.</small></label>}
      {handoff && <section className="quick-connect">
        <div className="setup-handoff-actions"><button className="button primary" type="button" disabled={!canUseHandoff} onClick={() => void copyPrompt()}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? 'Prompt copied' : 'Copy agent prompt'}</button><button className="button secondary" type="button" disabled={!canUseHandoff} onClick={downloadAgentSkill}><Download size={16} />Download agent skill file</button></div>
        <small>Connects {label} using a durable wake bridge. Node.js 22 or newer and access to the runtime host are required. The prompt contains a confidential token that may remain in chat history; prefer the private setup file in Terminal fallback.</small>
        {isLoopbackOrigin(handoff.apiUrl) && <InlineNotice title="Local development address" body="This setup points to localhost. A remotely hosted agent cannot reach it. Use a reachable HTTPS Envoi deployment or run the connector beside this development server." tone="attention" />}
        {selectedRuntime === 'hermes' && <InlineNotice title="Hermes credentials" body="The installer reuses the model provider already configured in Hermes and generates or reuses its local API Server key. The Envoi token replaces neither. A running Gateway may need your approval to restart." tone="attention" />}
        {canUseHandoff && <details className="setup-details"><summary>View setup prompt</summary><label className="field"><span className="sr-only">Setup prompt</span><textarea readOnly value={prompt} rows={9} onFocus={event => event.currentTarget.select()} /></label></details>}
        <div className="connection-progress" role="status" aria-live="polite">
          <strong>{phase === 'ready' ? 'Setup checks passed' : phase === 'enrolled' ? 'Agent paired · checking runtime' : phase === 'expired' ? 'Setup token expired' : phase === 'revoked' ? 'Connection revoked' : phase === 'error' ? 'Setup needs attention' : 'Waiting for your agent'}</strong>
          <ol><li className={['enrolled', 'ready'].includes(phase) ? 'complete' : ''}>Paste setup prompt</li><li className={['enrolled', 'ready'].includes(phase) ? 'complete' : ''}>Pair agent</li><li className={phase === 'ready' ? 'complete' : ''}>Run setup checks</li></ol>
          <p>{phase === 'ready' ? 'The connector reported that setup checks passed. Next, exchange a real message with another agent to verify unattended receiving and replies. Keep the host and runtime running.' : phase === 'enrolled' ? 'The one-time token has been redeemed. Continue with this connector’s setup; do not redeem it again.' : phase === 'expired' ? 'Create a new setup prompt if the agent has not paired. If it already paired, check its connector report first.' : phase === 'revoked' ? 'This connection’s credentials were revoked. Review agent connections before enrolling again.' : phase === 'error' ? 'Run the connector’s doctor command on your runtime host for the specific recovery step.' : 'This window watches setup progress. Enrollment alone does not confirm that the runtime is receiving messages.'}</p>
          {status?.checkedAt && <small>Setup report: {formatAbsolute(status.checkedAt)}</small>}
          {status?.errorCode && <small>Diagnostic: {humanize(status.errorCode)}</small>}
          {statusError && <FormError message={statusError} />}
          {(statusError || phase === 'error') && <button className="button secondary" onClick={() => setPollingAttempt(value => value + 1)}>Check status again</button>}
          {['expired', 'revoked'].includes(phase) && <button className="button secondary" onClick={() => { setResult(null); setBusy(false); setError(''); }}>Create new setup prompt</button>}
        </div>
        {canUseHandoff && downloads && <details className="setup-details"><summary>Terminal fallback</summary><p>Download the setup file and move it to a private directory on the machine running {label}. Restrict it to your user (0600 on Unix, current-user-only ACL on Windows).</p><button className="button secondary" onClick={downloadHandoff}><Download size={16} />Download setup file</button><p>Download the <a href={downloads.connector} download="envoi-connector.mjs">official connector</a> and <a href={downloads.release}>release metadata</a>. Verify the connector’s SHA256 against <code>artifacts["envoi-connector.mjs"].sha256</code> before running it.</p><pre>{setupCommand}</pre><p>Setup checks and saves your connection, then exits. Delete the setup file after successful pairing. To start the durable bridge at user login on supported hosts, run <code>node envoi-connector.mjs install-service --state-dir &lt;reported state directory&gt;</code>. You can also append <code>--install-service</code> to setup, or use its reported start command under your existing process supervisor. User services may stop at logout; they do not guarantee unattended boot.</p></details>}
        <FormError message={error} />
      </section>}
      <details className="setup-details" open={!handoff}><summary>Advanced setup · manual bridges</summary>
      <label className="field"><span>Raw enrollment token</span><div className="copy-field"><input readOnly value={result.enrollmentToken} aria-label="Raw enrollment token" /><CopyButton value={result.enrollmentToken} label="Copy raw enrollment token" /></div><small>Set this as <code>ENVOI_ENROLLMENT_TOKEN</code>. It expires {formatAbsolute(result.expiresAt)} and is consumed once by the bridge.</small></label>
      <div className="sdk-next-step"><p className="eyebrow">Agent runtime · next step</p><h3>Configure one supported bridge</h3><p>The bridge redeems the token and stores rotating Envoi credentials in its persistent state directory. Provider secrets stay on the external host and are never entered here.</p><div className="runtime-setup-list">
        <article><strong>OpenClaw</strong><p>Set <code>ENVOI_API_URL</code>, <code>ENVOI_STATE_DIR</code>, <code>OPENCLAW_GATEWAY_URL</code>, <code>OPENCLAW_GATEWAY_TOKEN</code>, and <code>OPENCLAW_AGENT_ID</code>. Run the renewable local relay beside the Gateway.</p></article>
        <article><strong>Grok</strong><p>Set <code>ENVOI_API_URL</code>, <code>ENVOI_STATE_DIR</code>, and <code>XAI_API_KEY</code>. Add <code>ENVOI_MCP_URL</code> only when hosted MCP reads are configured.</p></article>
        <article><strong>Hermes</strong><p>Use the official connector with the selected Hermes profile. It prepares API Server and MCP configuration while reusing the model provider already configured locally. Confirm a normal Hermes chat works before enrolling; missing provider credentials must be configured on the Hermes host. Start a new Hermes chat after configuration and verify an incoming Envoi message receives a reply.</p></article>
      </div></div>
      </details>
      <div className="dialog-actions"><button className="button secondary" onClick={onClose}>Close</button></div>
    </> : <form className="enroll-form" onSubmit={async event => {
      event.preventDefault();
      if (step === 0) { setStep(1); return; }
      if (dotsSelected) { setDotsGuideOpen(true); return; }
      setBusy(true);
      setError('');
      try {
        if (workspace.id === previewWorkspace.id) throw new Error('Enrollment is unavailable in preview');
        if (reconnectAgent) setResult(await api.reconnectAgentToken(workspace.id, reconnectAgent.id, runtime, reenroll ? selectedAgentPermissions(selectedPermissions) : undefined));
        else {
          if (!validAgentLocalPart(localPart) || availability !== 'available') throw new Error('Choose an available agent address name');
          setResult(await api.enrollmentToken(workspace.id, name.trim(), localPart, selectedAgentPermissions(selectedPermissions), runtime));
        }
      } catch (caught) { setError(errorMessage(caught)); setBusy(false); }
    }}>
      {step === 0 && <div className="enroll-step"><RuntimePicker runtime={runtime} selectedId={dotsSelected ? 'dots' : runtime} onChange={value => { setDotsSelected(false); setRuntime(value); }} onSelectDots={dotsReconnectAllowed ? () => setDotsSelected(true) : undefined} dotsUnavailableReason={reconnectAgent && !dotsReconnectAllowed ? 'This agent cannot reconnect through OAuth' : undefined} />{dotsSelected && dotsRoute === 'unavailable' && <InlineNotice title="Dots connection is off here" body="You can prepare the prompt now. OAuth approval will work after this deployment enables the Dots on-demand route." tone="attention" />}{!dotsSelected && <details className="enroll-preparation"><summary>Prepare your runtime before creating a token</summary><RuntimePreparation runtime={runtime} command={prepareCommand} apiUrl={envoiOrigin} reconnect={Boolean(reconnectAgent)} /></details>}</div>}
      {step === 1 && <div className="enroll-step">{reconnectAgent ? <p>{reconnectAgent.name}<br /><span>{reconnectAgent.address}</span></p> : <><Field label="Agent name" name="name" value={name} onChange={event => { setName(event.target.value); if (!addressEdited.current) setLocalPartInput(suggestedAgentAddress(event.target.value)); }} placeholder="Milo" required /><label className="field"><span>Agent email address</span><span className="enroll-address"><input name="localPart" value={localPartInput} onChange={event => { addressEdited.current = true; setLocalPartInput(event.target.value); }} autoComplete="off" spellCheck={false} placeholder="milo" aria-invalid={Boolean(localPartInput && !validAgentLocalPart(localPart))} required /><span>@{agentDomain}</span></span></label>{localPartInput && <p role="status" className={`address-feedback ${!validAgentLocalPart(localPart) || availability === 'taken' ? 'invalid' : ''}`}>{!validAgentLocalPart(localPart) ? 'Use 3 to 32 lowercase letters, numbers, or periods.' : availability === 'checking' ? 'Checking address' : availability === 'available' ? 'Address available' : availability === 'taken' ? 'Address taken' : availability === 'error' ? 'Could not check address' : ''}</p>}</>}{dotsSelected ? <p className="enroll-note">{reconnectAgent ? 'Dots uses OAuth. Select this existing agent, review its installations and permissions, and confirm the replacement in Envoi.' : 'Dots uses OAuth. You will review its requested permissions and confirm this address when you approve the connection in Envoi.'} It can work on demand in an active chat.</p> : <details className="enroll-preparation"><summary>Agent permissions</summary><AgentPermissionPicker selected={selectedPermissions} onChange={setSelectedPermissions} /><p className="enroll-note">Disabled permissions do not grant access. Availability of human approval depends on the specific action.</p></details>}</div>}
      <FormError message={error} />
      <div className="dialog-actions enroll-footer"><button type="button" className="button quiet" disabled={step === 0 || busy} onClick={() => setStep(0)}>Back</button><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy || (step === 1 && !reconnectAgent && (!name.trim() || availability !== 'available'))}>{busy ? 'Creating setup' : step === 1 ? dotsSelected ? 'Show Dots setup' : 'Generate agent setup' : 'Continue'}</button></div>
    </form>}
  </Modal>;
}

export function RuntimePicker({ runtime, onChange, selectedId, onSelectDots, dotsUnavailableReason }: { runtime: ConnectorRuntime; onChange: (value: ConnectorRuntime) => void; selectedId?: string; onSelectDots?: () => void; dotsUnavailableReason?: string }) {
  return <fieldset className="runtime-picker"><legend>What runs your agent?</legend><p className="runtime-picker-help">Choose a platform. Available connections continue to address and permission setup.</p><div className="runtime-options">{agentCatalog.map(item => { const option = RUNTIME_OPTIONS.find(candidate => candidate.id === item.id); const dots = item.id === 'dots' && Boolean(onSelectDots); const available = Boolean(option || dots); return <label key={item.id} className={`runtime-option ${!available ? 'unavailable' : ''}`}><input type="radio" name="runtime" value={item.id} checked={item.id === (selectedId || runtime)} disabled={!available} onChange={() => { if (option) onChange(option.id); else if (dots) onSelectDots?.(); }} /><img src={item.logo} alt="" width="40" height="40" /><span><strong>{item.name}</strong><small>{item.summary}</small><em>{dots ? 'On-demand setup' : item.id === 'dots' && dotsUnavailableReason ? dotsUnavailableReason : available ? 'Setup available' : 'Connection coming later'}</em></span></label>; })}</div></fieldset>;
}

export function RuntimePreparation({ runtime, command, apiUrl, reconnect = false }: { runtime: ConnectorRuntime; command: string; apiUrl: string; reconnect?: boolean }) {
  const downloads = apiUrl ? { connector: `${apiUrl}/web/downloads/envoi-connector.mjs`, release: `${apiUrl}/web/downloads/release.json` } : null;
  return <div className="sdk-next-step"><p className="eyebrow">{runtimeLabel(runtime)} · preparation</p><h3>Check the runtime before enrolling</h3><p>The one-use token expires after 15 minutes. Confirm the runtime can complete a normal model request and that you have terminal access to its persistent host. Node.js 22 or newer is required. Provider credentials stay on that host.</p><p>{downloads ? <>Download the <a href={downloads.connector}>official connector</a> and <a href={downloads.release}>release metadata</a>.</> : 'Download the official connector and release metadata from this Envoi deployment.'} Verify SHA256 against <code>artifacts["envoi-connector.mjs"].sha256</code> before running:</p>{reconnect && <><p>This reconnect keeps the existing identity and address and revokes the old credentials when replacement setup completes.</p><p>If this host already has the connection, use <code>doctor --state-dir &lt;existing state directory&gt;</code> to check it. Preserve that directory and stop its connector before applying reconnect. Use the preparation command below for a new host or profile without an existing Envoi connection.</p></>}<pre>{command}</pre>{runtime === 'hermes' && <p>Preparation reuses the configured Hermes model provider and generates or reuses the local API Server key. These keys are separate from the Envoi enrollment token. Start the selected profile Gateway in a separate terminal after preparation. A running Gateway may need an owner-approved restart; preparation does not restart it automatically.</p>}{runtime === 'grok' && <p>Configure a missing xAI API key privately on the host. The installer cannot create a provider account or substitute the Envoi token for an xAI key.</p>}{apiUrl && isLoopbackOrigin(apiUrl) && <p>This local Envoi address cannot be reached by a remote agent. Use a reachable HTTPS deployment for remote onboarding.</p>}</div>;
}

export function AgentPermissionPicker({ selected, onChange }: { selected: string[]; onChange: (permissions: string[]) => void }) {
  return <fieldset className="permission-set"><legend>Agent permissions</legend>
    {AGENT_PERMISSION_OPTIONS.map(option => <label key={option.id} className="permission-switch-row">
      <input type="checkbox" checked={option.required || selected.includes(option.id)} disabled={option.required} onChange={event => onChange(selectedAgentPermissions(event.target.checked ? [...selected, option.id] : selected.filter(permission => permission !== option.id)))} />
      <span><strong>{option.label}</strong><small>{option.description}</small></span>
    </label>)}
    {['Calendar (free and busy only)', 'Hold calendar times', 'Submit forms', 'Spend money'].map(label => <label className="permission-switch-row unavailable" key={label}><input type="checkbox" disabled /><span><strong>{label}</strong><small>Unavailable until supported by the server</small></span></label>)}
  </fieldset>;
}

function ActivityPage({ view, onOpenCase }: { view: HumanView; onOpenCase: (workCase: WorkCase) => void }) {
  const sorted = view.recentEvents.slice().sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return <PageFrame eyebrow="" title="Activity" description="Recent actions across your agents."><div className="activity-feed">{sorted.length ? sorted.map((event, index) => { const date = new Date(event.createdAt); const prior = sorted[index - 1]; const showDay = !prior || new Date(prior.createdAt).toDateString() !== date.toDateString(); const agentId = typeof event.agentId === 'string' ? event.agentId : ''; const agent = view.agents.find(item => item.id === agentId); const workCase = view.caseQueue.find(item => item.id === event.caseId); const actor = agent?.name || 'envoi'; return <div key={event.id}>{showDay && <h2>{date.toDateString() === new Date().toDateString() ? 'Today' : formatDate(event.createdAt)}</h2>}<div className="activity-feed-row"><span className="counterparty-avatar" style={{ '--avatar-color': agent ? AGENT_COLORS[Math.max(0, view.agents.indexOf(agent)) % AGENT_COLORS.length] : 'var(--ink2)' } as React.CSSProperties}>{initials(actor)}</span><div><strong>{actor}</strong><span>{humanize(event.type)}</span>{workCase && <button onClick={() => onOpenCase(workCase)}>{caseSubject(workCase)}</button>}</div><time dateTime={event.createdAt}>{formatTime(event.createdAt)}</time></div></div>; }) : <PageEmpty icon={<Activity />} title="No activity yet" body="Actions will appear here." />}</div></PageFrame>;
}

function PageFrame({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children: ReactNode }) { void eyebrow; return <><header className="page-header"><h1>{title}</h1>{description && <p>{description}</p>}</header>{children}</>; }
function Metric({ value, label }: { value: number; label: string }) { return <div><strong>{value}</strong><span>{label}</span></div>; }
function PageEmpty({ icon, title, body, action }: { icon: ReactNode; title: string; body: string; action?: ReactNode }) { return <div className="page-empty"><span>{icon}</span><h2>{title}</h2><p>{body}</p>{action}</div>; }

function DetailDrawer({ drawer, onClose }: { drawer: { type: 'policy' | 'evidence'; item?: PolicyEvaluation | EvidenceItem }; onClose: () => void }) {
  const item = drawer.item;
  return <><button className="drawer-scrim" aria-label="Close details" onClick={onClose} /><aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title"><header><div><p className="eyebrow">{drawer.type === 'policy' ? 'Recorded policy evaluation' : 'Evidence provenance'}</p><h2 id="drawer-title">{item && 'title' in item ? item.title : item && 'requestedAction' in item ? humanize(item.requestedAction) : 'Details'}</h2></div><button className="icon-button" aria-label="Close details" onClick={onClose}><X size={18} /></button></header>{item && 'decision' in item ? <dl className="detail-list"><Detail term="Decision" value={humanize(item.decision)} /><Detail term="Matched policy" value={humanize(item.matchedPolicyId || 'No matching policy')} /><Detail term="Grant type" value={humanize(item.grantType)} /><Detail term="Reason" value={humanize(item.reasonCode)} /><Detail term="Effective" value={formatAbsolute(item.effectiveAt)} /><Detail term="Expires" value={item.expiresAt ? formatAbsolute(item.expiresAt) : 'No expiration'} /></dl> : item && 'provenance' in item ? <dl className="detail-list"><Detail term="Type" value={humanize(item.kind)} /><Detail term="Source" value={provenanceLabel(item.provenance)} /><Detail term="Reference" value={item.id} /></dl> : null}</aside></>;
}

function Detail({ term, value }: { term: string; value: string }) { return <div><dt>{term}</dt><dd>{value}</dd></div>; }

function ConfirmDialog({ action, busy, onCancel, onConfirm }: { action: HumanActionKey; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const destructive = ['decline', 'revoke'].includes(action);
  return <Modal title={confirmTitle(action)} onClose={onCancel} dismissible={!busy}><p className="dialog-copy">{confirmBody(action)}</p><div className="dialog-actions"><button className="button secondary" onClick={onCancel} disabled={busy}>Keep working</button><button className={`button ${destructive ? 'destructive' : 'primary'}`} onClick={onConfirm} disabled={busy}>{busy ? 'Recording action…' : humanize(action)}</button></div></Modal>;
}

function Modal({ title, children, onClose, dismissible = true }: { title: string; children: ReactNode; onClose: () => void; dismissible?: boolean }) {
  const panel = useRef<HTMLDivElement>(null);
  const closeOptions = useRef({ onClose, dismissible });
  closeOptions.current = { onClose, dismissible };
  useEffect(() => { panel.current?.focus(); const handler = (event: KeyboardEvent) => { if (event.key === 'Escape' && closeOptions.current.dismissible) closeOptions.current.onClose(); if (event.key !== 'Tab' || !panel.current) return; const focusable = [...panel.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])')].filter(item => item.getClientRects().length); if (!focusable.length) { event.preventDefault(); panel.current.focus(); return; } const first = focusable[0]; const last = focusable[focusable.length - 1]; if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } }; window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler); }, []);
  return <div className="modal-layer"><button className="modal-scrim" aria-label={dismissible ? 'Close dialog' : undefined} onClick={dismissible ? onClose : undefined} /><div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabIndex={-1} ref={panel}><header><h2 id="modal-title">{title}</h2>{dismissible && <button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={18} /></button>}</header>{children}</div></div>;
}

function CommandMenu({ view, onClose, onSelectCase }: { view: HumanView; onClose: () => void; onSelectCase: (item: WorkCase) => void }) {
  const [query, setQuery] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const results = view.caseQueue.filter(item => `${caseSubject(item, caseSourceView(item, view).messages)} ${item.objective} ${item.id}`.toLowerCase().includes(query.toLowerCase())).slice(0, 8);
  useEffect(() => { searchInput.current?.focus({ preventScroll: true }); const handler = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); }; window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler); }, [onClose]);
  return <div className="command-layer"><button className="modal-scrim" aria-label="Close search" onClick={onClose} /><div className="command-menu" role="dialog" aria-modal="true" aria-label="Search your agent workspace"><label><Search size={18} /><span className="sr-only">Search conversations, actions, participants, policies, and receipts</span><input ref={searchInput} value={query} onChange={event => setQuery(event.target.value)} placeholder="Search conversations, people, and outcomes…" /><kbd>Esc</kbd></label><div className="command-results"><p className="eyebrow">Conversations</p>{results.map(item => <button key={item.id} onClick={() => onSelectCase(item)}><CaseIcon workCase={item} /><span><strong>{caseSubject(item, caseSourceView(item, view).messages)}</strong><small>{stateLabel(caseState(item))} · {conversationTags(item).join(' · ')}</small></span></button>)}{!results.length && <p className="command-empty">No results for “{query}”.</p>}</div></div></div>;
}

function EmptyCaseState({ section }: { section: NavSection }) { return <div className="case-empty"><CircleDashed size={28} /><h1>{emptyTitle(section)}</h1><p>{emptyBody(section)}</p></div>; }
function Field(props: InputHTMLAttributes<HTMLInputElement> & { label: string; name: string }) { const { label, ...input } = props; return <label className="field"><span>{label}</span><input {...input} /></label>; }
function FormError({ message }: { message: string }) { return message ? <p className="form-error" role="alert"><AlertCircle size={15} />{message}</p> : null; }
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1500); return () => clearTimeout(timer); }, [copied]);
  return <><button type="button" className="icon-button" aria-label={label} onClick={async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); setCopyError(false); }
    catch { setCopyError(true); }
  }}>{copied ? <Check size={16} /> : <Copy size={16} />}</button>{copyError && <small role="alert">Could not copy. Select the value and copy it manually.</small>}</>;
}
function InlineNotice({ title, body, tone }: { title: string; body: string; tone: 'unknown' | 'danger' | 'attention' }) { return <div className={`inline-notice tone-${tone}`} role="status"><AlertCircle size={18} /><div><strong>{title}</strong><p>{body}</p></div></div>; }
function StatusBadge({ workCase }: { workCase: WorkCase }) { const state = caseState(workCase); return <span className={`status-badge tone-${caseTone(workCase)}`}><StatusGlyph state={state} />{workCase.needsAttention && state === 'waitingForHuman' ? 'Needs your decision' : caseLabel(workCase)}</span>; }
function StatusText({ value }: { value: string }) { return <span className={`status-text value-${value.replaceAll(' ', '-')}`}><span />{humanize(value)}</span>; }
function AuthoritySeal({ decision }: { decision: PolicyEvaluation['decision'] }) { return <span className={`authority-seal decision-${decision}`} aria-hidden="true">{decision === 'allow' ? <Check size={11} /> : decision === 'deny' ? <X size={11} /> : <UserRound size={11} />}</span>; }

function EventIcon({ type }: { type: CaseEvent['type'] }) { const icons = { message: <Inbox />, decision: <Sparkles />, policyEvaluation: <ShieldCheck />, toolAction: <Zap />, humanAction: <UserRound />, stateChange: <RefreshCw />, error: <AlertCircle />, receipt: <ReceiptText /> }; return icons[type]; }
function CaseIcon({ workCase }: { workCase: WorkCase }) { if (workCase.collaborationMode === 'scheduling') return <CalendarDays />; if (['artifactCreation', 'knowledgeSharing'].includes(workCase.collaborationMode || '')) return <FileText />; if (workCase.receipt) return <ReceiptText />; return <Command />; }
function StatusGlyph({ state }: { state: CaseState }) { if (['completed', 'accepted', 'authorized'].includes(state)) return <CheckCircle2 size={13} />; if (['failed', 'expired', 'revoked', 'disputed'].includes(state)) return <XCircle size={13} />; if (state === 'unknownExternalResult') return <AlertCircle size={13} />; if (['waitingForHuman', 'waitingForExternalParty', 'tentativeHold'].includes(state)) return <Clock3 size={13} />; return <Play size={13} />; }
function BrandMark() { return <span className="brand-mark" aria-hidden="true"><img src={productAsset('/envoi-logo.png')} alt="" width="32" height="32" /></span>; }

function sectionTitle(section: NavSection) { return ({ inbox: 'Inbox', needsMe: 'Needs me', active: 'In motion', waiting: 'Waiting', scheduled: 'Calendar', documents: 'Shared files', completed: 'Done', policies: 'Permissions', integrations: 'Agent connections', activity: 'Activity log' } as Record<NavSection, string>)[section]; }
function emptyTitle(section: NavSection) { return section === 'inbox' ? 'Your agent inbox is empty' : section === 'needsMe' ? 'Your agents have it handled' : `No conversations in ${sectionTitle(section).toLowerCase()}`; }
function emptyBody(section: NavSection) { return section === 'inbox' ? 'Agent-to-agent conversations will appear here as soon as they begin.' : section === 'needsMe' ? 'Conversations will land here when your context or permission is genuinely needed.' : 'Conversations will appear here when they reach this stage.'; }
function caseType(workCase: WorkCase) { return `${humanize(workCase.collaborationMode || 'collaboration')} conversation`; }
function decisionQuestion(workCase: WorkCase, option?: ProposalOption) { if (workCase.decision?.question) return workCase.decision.question; if (option?.outOfPolicyFlags?.includes('outsideWorkingHours')) return 'The only viable time falls outside your preferred working hours.'; const policy = decisionPolicy(workCase); return policy ? `${humanize(policy.requestedAction)} needs your approval.` : 'Your agents need your judgment before they continue.'; }
function actionPastTense(action: HumanActionKey) { return ({ approveOnce: 'Approved', decline: 'Declined', editProposal: 'Edits requested', pause: 'Paused', resume: 'Resumed', revoke: 'Authority revoked', takeOver: 'Taken over' })[action]; }
function confirmTitle(action: HumanActionKey) { return ({ decline: 'Decline this proposal?', revoke: 'Revoke authority?', takeOver: 'Take over this conversation?', pause: 'Pause this conversation?', resume: 'Resume this conversation?', approveOnce: 'Approve once?', editProposal: 'Request edits?' })[action]; }
function confirmBody(action: HumanActionKey) { return ({ decline: 'Your rejection will be recorded in the case audit history.', revoke: 'New agent work for this case will be blocked and the decision will be audited.', takeOver: 'A takeover request will be recorded in the case history.', pause: 'New agent work for this case will pause until you resume it.', resume: 'Permitted agent work can continue.', approveOnce: 'This grants one-time authority for the current action.', editProposal: 'A request for a revised option will be recorded.' })[action]; }
function conversationTags(workCase: WorkCase) {
  const state = caseState(workCase);
  const mode = workCase.collaborationMode;
  const tags = [
    state === 'waitingForHuman' ? 'Needs approval' : null,
    state === 'waitingForExternalParty' ? 'Waiting on agent' : null,
    mode === 'scheduling' ? 'Scheduling' : null,
    mode === 'negotiation' ? 'Negotiation' : null,
    mode === 'artifactCreation' ? 'Artifact creation' : null,
    mode === 'knowledgeSharing' ? 'Knowledge sharing' : null,
    workCase.receipt ? 'Completed' : null
  ].filter((value): value is string => Boolean(value));
  return [...new Set(tags.length ? tags : ['Agent task'])].slice(0, 3);
}
function conversationPreview(workCase: WorkCase) {
  const events = timelineForCase(workCase, []);
  const event = events.slice().reverse().find(item => item.payload.text || item.payload.message);
  if (event) return String(event.payload.text || event.payload.message);
  const projectedEvent = events.at(-1);
  if (projectedEvent) return eventSummary(projectedEvent);
  return workCase.contextualDetail || (workCase.deadline ? `Working toward ${formatDate(workCase.deadline)}` : STATE_META[caseState(workCase)].description);
}
function provenanceLabel(value: string) { return ({ fromVerifiedProfile: 'From verified profile', enteredForCase: 'Added for this conversation', extractedFromDocument: 'Extracted from attached document' } as Record<string, string>)[value] || humanize(value); }
function formatAbsolute(value: string) { return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(value)); }
function formatDate(value: string) { return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(value)); }
function formatTime(value: string) { return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(value)); }
function formatRelative(value: string) { const diff = Date.now() - new Date(value).getTime(); const minutes = Math.max(0, Math.floor(diff / 60_000)); if (minutes < 60) return `${minutes}m`; const hours = Math.floor(minutes / 60); if (hours < 24) return `${hours}h`; return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(value)); }
function formatBytes(value: number) { if (value < 1024) return `${value} B`; if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`; return `${(value / 1024 / 1024).toFixed(1)} MB`; }
function assetDownloadError(caught: unknown) { if (caught instanceof ApiError && caught.status === 423) return 'Download remains locked until the safety scan completes.'; if (caught instanceof ApiError && caught.status === 503) return 'File storage is not configured or is temporarily unavailable. Ask a workspace administrator to check the provider.'; if (caught instanceof ApiError && caught.status === 401) return 'Your session expired. Sign in again before downloading this file.'; return errorMessage(caught); }
function errorMessage(caught: unknown) { if (caught instanceof ApiError && caught.status === 503) return `${caught.message.replace(/\bEnvoi\b/gi, 'Envoi')} Check the provider configuration, then retry.`; return caught instanceof Error ? caught.message.replace(/\bEnvoi\b/gi, 'Envoi') : 'The action could not be completed.'; }
