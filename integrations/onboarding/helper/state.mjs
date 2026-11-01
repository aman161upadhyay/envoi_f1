import { randomUUID } from 'node:crypto';
import { loadContract, safeOutput, failureOutput } from './output.mjs';
import { createTransport, offered, ProtocolError, validateOrigin } from './transport.mjs';
import { nativeConfirmation } from './confirmation.mjs';
import { PrivateStore } from './store.mjs';

const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const statuses = ['pending_claim', 'approved', 'activated', 'rejected', 'expired', 'withdrawn'];
const sleepDefault = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Public helper policy for coded connector failures; never project raw diagnostics. */
export function connectionFailure(contract, error) {
  const code = error?.code;
  if (error?.state === 'REVOKED' || ['CREDENTIAL_REVOKED', 'REFRESH_REPLAY', 'ACTIVATION_REPLAY'].includes(code)) {
    const guidance = code === 'REFRESH_REPLAY' || error?.reason === 'refresh_replay' ? 'owner_reenroll'
      : error?.reason === 'replaced' ? 'replaced_by_reconnect' : 'owner_reconnect';
    return safeOutput(contract, { schemaVersion: '1', state: 'revoked', guidance,
      nextAction: 'Access for this installation ended. Ask the owner to review it before reconnecting this identity.' });
  }
  if (error?.state === 'NEEDS_RECONNECT' || ['CREDENTIAL_EXPIRED', 'REFRESH_TOKEN_INVALID', 'REFRESH_RECOVERY_EXPIRED', 'ROTATION_ID_REQUIRED', 'ACTIVATION_RECOVERY_EXPIRED'].includes(code)) {
    return safeOutput(contract, { schemaVersion: '1', state: 'needs_reconnect',
      guidance: code === 'ROTATION_ID_REQUIRED' ? 'update_connector' : 'owner_reconnect',
      nextAction: 'Ask the owner to reconnect this existing identity using the reviewed helper.' });
  }
  if (['NETWORK_ERROR', 'TIMEOUT', 'INTERNAL_SERVER_ERROR', 'AUTH_UNAVAILABLE'].includes(code)) {
    return failureOutput(contract, 'degraded', 'service_unavailable');
  }
  return null;
}

export async function createHelper(options) {
  const contract = await loadContract(options.contract);
  const limits = contract['x-limits'];
  const origin = validateOrigin(options.origin);
  const runtime = options.runtime;
  const route = options.connectionRoute ?? 'local_helper';
  const validPermissions = value => Array.isArray(value) && value.length > 0 && value.length <= 4
    && new Set(value).size === value.length && value.includes('receive_agent_messages')
    && value.every(permission => typeof permission === 'string' && Object.hasOwn(contract['x-permission-labels'], permission));
  if (options.requestedPermissions !== undefined && !validPermissions(options.requestedPermissions)) throw new Error('PERMISSIONS_REQUIRED');
  const requestedPermissions = [...(options.requestedPermissions ?? ['send_agent_messages', 'receive_agent_messages'])];
  const permissionMetadata = state => state?.requestedPermissions === undefined ? {} : { requestedPermissions: [...state.requestedPermissions] };
  if (!['local_helper', 'authenticated_rest'].includes(route)) throw new Error('ROUTE_REQUIRED');
  if (!runtime || (route === 'local_helper' ? !['hermes', 'openclaw'].includes(runtime.type) : !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(runtime.type))
    || typeof runtime.version !== 'string' || (route === 'local_helper'
      ? !runtime.version || runtime.version.length > 80
      : !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/.test(runtime.version))) throw new Error('RUNTIME_REQUIRED');
  if (route === 'authenticated_rest' && (!options.helper || typeof options.helper.name !== 'string'
    || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(options.helper.name)
    || typeof options.helper.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/.test(options.helper.version)
    || Object.keys(options.helper).some(key => !['name', 'version'].includes(key)))) throw new Error('HELPER_METADATA_REQUIRED');
  const capabilities = options.deliveryCapabilities ?? (route === 'local_helper'
    ? { persistentProcess: true, outboundHttps: true, sse: true, webhook: false, scheduledPolling: false, a2a: false }
    : null);
  if (route === 'authenticated_rest' && (!capabilities || capabilities.persistentProcess !== true || capabilities.outboundHttps !== true || capabilities.sse !== true
    || capabilities.webhook !== false || capabilities.scheduledPolling !== false || capabilities.a2a !== false)) throw new Error('DELIVERY_CAPABILITIES_REQUIRED');
  const store = options.store ?? await new PrivateStore(options.directory).init();
  const request = options.request ?? createTransport(origin, options.fetch);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepDefault;
  const confirm = options.confirm ?? nativeConfirmation;
  const project = (values, state) => safeOutput(contract, { schemaVersion: '1', ...values }, [state?.bootstrapToken, state?.activationId]);
  const save = value => store.write('helper-state.json', value);
  const base = { version: 1, origin, runtime, connectionRoute: route };
  function ensureState(state) {
    if (!state || state.version !== 1 || state.origin !== origin || state.runtime?.type !== runtime.type
      || (state.connectionRoute ?? 'local_helper') !== route
      || !['pending', 'confirming', 'activating', 'completed', 'ended', 'cooldown'].includes(state.phase)) throw new Error('STATE_INVALID');
    if (state.requestedPermissions !== undefined && !validPermissions(state.requestedPermissions)) throw new Error('STATE_INVALID');
    if (['pending', 'confirming', 'activating'].includes(state.phase)
      && (!identifier(state.registrationId) || typeof state.bootstrapToken !== 'string' || !state.bootstrapToken.startsWith('envoi_reg_') || !validDate(state.expiresAt))) throw new Error('STATE_INVALID');
    if (state.phase === 'activating' && (!identifier(state.activationId) || !validDate(state.attemptStartedAt)
      || state.activationRequest?.activationId !== state.activationId || state.activationRequest?.registrationId !== state.registrationId
      || state.activationRequest?.deliveryMode !== 'envoi_link' || Object.keys(state.activationRequest).length !== 3)) throw new Error('STATE_INVALID');
    return state;
  }
  function pendingOutput(state, showCode) {
    const unexpired = now() < Date.parse(state.expiresAt);
    return project({ state: unexpired ? 'pending_approval' : 'registration_ended', registrationStatus: unexpired ? 'pending_claim' : 'expired',
      ...(showCode && unexpired ? { claimUrl: state.claim.url, verificationCode: state.claim.verificationCode,
        expiresInSeconds: Math.max(0, Math.floor((Date.parse(state.expiresAt) - now()) / 1000)) } : {}),
      nextAction: unexpired ? 'Open the claim URL and type the code in Envoi. After approval, run resume to confirm locally.' : 'This setup expired. Ask the human before starting a new registration.' }, state);
  }
  function approvalOutput(body, state) {
    if (!body.agent || !['new_agent', 'existing_agent'].includes(body.target) || !validDate(body.activationExpiresAt)
      || typeof body.workspaceName !== 'string' || !/^[^@\s]\*\*\*@[^@\s]+$/.test(body.approverEmailHint)
      || !Array.isArray(body.effectivePermissions) || !body.effectivePermissions.includes('receive_agent_messages')
      || body.effectivePermissions.some(permission => !contract['x-permission-labels'][permission])
      || typeof body.agent.name !== 'string' || typeof body.agent.address !== 'string') throw new ProtocolError('INVALID_RESPONSE');
    return project({ state: 'confirm_approval', registrationStatus: 'approved', workspaceName: body.workspaceName,
      approverEmailHint: body.approverEmailHint, agentName: body.agent.name, agentAddress: body.agent.address,
      permissionSummary: body.effectivePermissions.map(permission => contract['x-permission-labels'][permission]),
      nextAction: 'Confirm the approver, workspace, agent and permissions in the private host prompt. Never answer for the human.' }, state);
  }
  async function end(state, status, guidance) {
    await save({ ...base, ...permissionMetadata(state), phase: 'ended', status, guidance });
    return project({ state: status === 'revoked' ? 'revoked' : status === 'needs_reconnect' ? 'needs_reconnect' : 'registration_ended', guidance,
      ...(statuses.includes(status) ? { registrationStatus: status } : {}), nextAction: guidance === 'check_owner_agents'
        ? 'Ask the owner whether the agent appears in Envoi. Reconnect it if it does; register again only if the owner confirms it does not.'
        : 'Ask the owner to review this setup before reconnecting or starting another registration.' }, state);
  }
  async function protocolFailure(error, state, unresolved = false) {
    const connection = connectionFailure(contract, error);
    if (connection) return connection.state === 'degraded' ? connection : end(state, connection.state, connection.guidance);
    const row = contract['x-codes'][error.code]?.bySurface?.helper;
    const guidance = row?.guidanceByHelperState?.[unresolved ? 'activation_unresolved' : ''] ?? row?.guidanceByReason?.[error.reason] ?? row?.guidance;
    if (error.code === 'REGISTRATION_TOKEN_INVALID') return end(state, 'invalid', unresolved ? 'check_owner_agents' : 'register_again');
    if (error.code === 'REGISTRATION_ENDED') return end(state, error.reason ?? 'withdrawn', guidance ?? 'approval_ended');
    if (row?.lifecycle === 'REGISTRATION_ENDED') return end(state, 'ended', guidance);
    if (row?.lifecycle === 'PENDING_CLAIM') return project({ state: 'pending_approval', registrationStatus: 'pending_claim', guidance, nextAction: 'Wait for the owner to approve this saved registration.' }, state);
    if (row?.retry === 'after_retry_after') {
      await save({ ...(state ?? { ...base, phase: 'cooldown' }), retryAt: now() + error.retryAfterSeconds * 1000 });
      return failureOutput(contract, 'degraded', guidance);
    }
    if (!error.status || error.status >= 500) return failureOutput(contract, 'degraded', 'service_unavailable');
    return failureOutput(contract, 'needs_help', guidance ?? 'update_helper');
  }
  function validActivation(body) {
    if (!identifier(body.agent?.id) || !identifier(body.inboxId) || !identifier(body.installation?.id)
      || body.installation.connectionRoute !== route || body.installation.deliveryMode !== 'envoi_link'
      || (route === 'authenticated_rest' && (body.installation.runtime?.type !== runtime.type || body.installation.runtime.version !== runtime.version))
      || body.installation.status !== 'active' || body.installation.agentId !== body.agent.id || body.installation.legacy !== false || !['active', 'paused'].includes(body.agent.status)
      || typeof body.agent.address !== 'string' || typeof body.agent.name !== 'string'
      || !body.agentApiToken?.startsWith('envoi_agent_access_') || !body.agentRefreshToken?.startsWith('envoi_agent_refresh_')
      || !validDate(body.agentTokenExpiresAt) || !validDate(body.agentRefreshTokenExpiresAt) || body.tokenType !== 'Bearer'
      || !Array.isArray(body.effectivePermissions) || !body.effectivePermissions.includes('receive_agent_messages')) throw new ProtocolError('INVALID_RESPONSE');
    // Validate every possible public projection before persisting or prompting.
    project({ agentName: body.agent.name, agentAddress: body.agent.address }, { bootstrapToken: body.agentApiToken, activationId: body.agentRefreshToken });
    return body;
  }
  async function finishSession(session) {
    const marker = session?._onboarding;
    if (!marker || marker.origin !== origin || marker.runtime?.type !== runtime.type || !identifier(marker.completionId) || !marker.agent || !marker.installation
      || session.agentId !== marker.agent.id || session.address !== marker.agent.address) throw new Error('STATE_INVALID');
    const activation = validActivation({ ...marker, ...session, agent: marker.agent, installation: marker.installation });
    if (typeof options.adopt !== 'function') return failureOutput(contract, 'needs_help', 'update_helper');
    const requestMetadata = permissionMetadata(await store.read('helper-state.json'));
    // No bootstrap or raw response ever crosses a subprocess/model boundary.
    await options.adopt(activation, { origin, runtime, stateDirectory: store.directory ?? options.directory, completionId: marker.completionId });
    await save({ ...base, ...requestMetadata, phase: 'completed', completionId: marker.completionId });
    return authenticatedStatus(await store.read('session.json') ?? session);
  }
  async function authenticatedStatus(session) {
    if (!session?.agentApiToken) throw new Error('STATE_INVALID');
    const status = options.operationalStatus
      ? await options.operationalStatus({ origin, runtime, stateDirectory: store.directory ?? options.directory, completionId: session._onboarding?.completionId })
      : await request('GET', '/api/agent/status', { token: session.agentApiToken });
    if (!['active', 'paused'].includes(status.state) || status.agent?.status !== status.state || status.agent?.id !== session.agentId || status.agent?.address !== session.address
      || status.installation?.connectionRoute !== route || status.installation.deliveryMode !== 'envoi_link'
      || status.installation.id !== session._onboarding?.installation?.id) throw new ProtocolError('INVALID_RESPONSE');
    return project({ state: status.state === 'paused' ? 'paused' : 'connected', reachability: 'not_verified_closed_app',
      agentAddress: status.agent.address, agentStatus: status.agent.status, connectionRoute: route, deliveryMode: 'envoi_link',
      nextAction: status.state === 'paused' ? 'Paused. Wait for the owner to resume this existing agent.' : 'Connected while this host runs. Closed-app wake has not been tested.' });
  }
  async function activate(state) {
    const deadline = Date.parse(state.attemptStartedAt) + limits.activationRecoverySeconds * 1000 - 1000;
    // Five attempts per invocation, persisted total of five across restarts.
    while ((state.attempts ?? 0) < 5 && now() < deadline) {
      if (state.retryAt > now()) {
        if (state.retryAt >= deadline) break;
        await sleep(state.retryAt - now());
      }
      if (now() >= deadline) break;
      state = { ...state, attempts: (state.attempts ?? 0) + 1 };
      await save(state);
      let body;
      try { body = validActivation(await request('POST', '/api/agent-installations/activate', { token: state.bootstrapToken, body: state.activationRequest })); }
      catch (error) {
        if (!(error instanceof ProtocolError)) throw error;
        if (error.status >= 400 && error.status < 500) {
          // These definitive activation outcomes resolve this attempt. Retain
          // bootstrap only when the contract says the approval remains live.
          if (['ACTIVATION_INVALID', 'ACTIVATION_ID_REQUIRED', 'DELIVERY_MODE_NOT_AVAILABLE', 'REGISTRATION_PENDING'].includes(error.code)) {
            const { activationId, activationRequest, attemptStartedAt, attempts, retryAt, ...resolved } = state;
            await save({ ...resolved, phase: 'pending' });
          }
          return protocolFailure(error, state, true);
        }
        if (error.code === 'INVALID_RESPONSE') return failureOutput(contract);
        const ceiling = Math.min(16_000, 500 * 2 ** state.attempts);
        state = { ...state, retryAt: now() + Math.round(ceiling / 2 + ceiling / 2 * (options.random ?? Math.random)()) };
        await save(state);
        continue;
      }
      const session = { agentId: body.agent.id, inboxId: body.inboxId, address: body.agent.address, cursor: null,
        agentApiToken: body.agentApiToken, agentRefreshToken: body.agentRefreshToken, agentTokenExpiresAt: body.agentTokenExpiresAt,
        agentRefreshTokenExpiresAt: body.agentRefreshTokenExpiresAt, tokenType: body.tokenType,
        _onboarding: { ...(state.previousCompletionId ? Object.fromEntries(['previousCompletionId', 'previousInstallationId', 'previousAgentId', 'previousInboxId', 'previousAddress'].map(key => [key, state[key]])) : {}), completionId: state.activationId, origin, runtime, agent: body.agent, installation: body.installation, effectivePermissions: body.effectivePermissions } };
      await store.write('session.json', session);
      await options.fault?.('credentials_committed');
      return finishSession(session);
    }
    // One reconciliation read before giving up. Do not call creation here.
    let status;
    try { status = await request('GET', `/api/agent-registrations/${state.registrationId}`, { token: state.bootstrapToken }); }
    catch (error) { return protocolFailure(error, state, true); }
    if (status.status === 'activated') return end(state, 'needs_reconnect', 'owner_reconnect');
    if (status.status === 'approved' || status.status === 'pending_claim') {
      const { activationId, activationRequest, attemptStartedAt, attempts, retryAt, ...resolved } = state;
      await save({ ...resolved, phase: 'pending', nextPollAt: now() + limits.pollAfterSeconds * 1000 });
      return failureOutput(contract, 'degraded', 'service_unavailable');
    }
    if (['rejected', 'expired', 'withdrawn'].includes(status.status)) return end(state, status.status, status.status === 'withdrawn' ? 'approval_ended' : status.status === 'rejected' ? 'owner_rejected' : 'register_again');
    throw new ProtocolError('INVALID_RESPONSE');
  }
  async function advance(state, allowActivation, showCode) {
    if (state.phase === 'ended') return project({ state: state.status === 'needs_reconnect' ? 'needs_reconnect' : state.status === 'revoked' ? 'revoked' : 'registration_ended', guidance: state.guidance,
      nextAction: 'Ask the owner to review this setup. A new registration requires an explicit fresh request.' });
    if (state.retryAt > now() && state.phase !== 'activating') return failureOutput(contract, 'degraded', 'service_busy');
    if (state.phase === 'activating') return allowActivation ? activate(state) : project({ state: 'degraded', nextAction: 'An activation outcome is unresolved. Run resume to recover the same saved request.' });
    if (state.nextPollAt > now() && state.phase === 'pending') return pendingOutput(state, showCode);
    state = { ...state, nextPollAt: now() + limits.pollAfterSeconds * 1000 };
    await save(state);
    const body = await request('GET', `/api/agent-registrations/${state.registrationId}`, { token: state.bootstrapToken });
    if (body.registrationId !== state.registrationId || !statuses.includes(body.status)) throw new ProtocolError('INVALID_RESPONSE');
    if (['expired', 'rejected', 'withdrawn'].includes(body.status)) return end(state, body.status, body.status === 'withdrawn' ? 'approval_ended' : body.status === 'rejected' ? 'owner_rejected' : 'register_again');
    if (body.status === 'pending_claim') {
      if (!validDate(body.expiresAt) || !Number.isFinite(body.pollAfterSeconds) || body.pollAfterSeconds < limits.pollMinIntervalSeconds) throw new ProtocolError('INVALID_RESPONSE');
      state = { ...state, phase: 'pending', expiresAt: body.expiresAt, nextPollAt: now() + body.pollAfterSeconds * 1000 }; await save(state);
      return pendingOutput(state, showCode);
    }
    if (body.status === 'activated') return end(state, 'needs_reconnect', 'owner_reconnect');
    const visible = approvalOutput(body, state);
    await save({ ...state, phase: 'confirming' });
    if (!allowActivation) return visible;
    if (now() >= Date.parse(body.activationExpiresAt)) return end(state, 'expired', 'register_again');
    const answer = await confirm({ ...visible, activationExpiresAt: body.activationExpiresAt }, { now });
    if (answer === null || answer === undefined) return visible;
    if (answer !== true || now() >= Date.parse(body.activationExpiresAt)) return end(state, 'expired', 'register_again');
    const activationId = (options.randomId ?? randomUUID)();
    state = { ...state, phase: 'activating', activationId, activationRequest: { registrationId: state.registrationId, activationId, deliveryMode: 'envoi_link' },
      attemptStartedAt: new Date(now()).toISOString(), attempts: 0 };
    await save(state);
    await options.fault?.('activation_saved');
    return activate(state);
  }
  async function run(command, { showCode = false, fresh = false } = {}) {
    return store.lock(async () => {
      let state;
      try {
        state = await store.read('helper-state.json');
        if (state) ensureState(state);
        // Explicit selection cannot rewrite a pending or completed request. Old
        // saved setups remain resumable without a new permission-selection flag.
        if (command === 'connect' && options.requestedPermissions !== undefined && state
          && state.phase !== 'cooldown' && !(state.phase === 'ended' && fresh)
          && (!state.requestedPermissions || state.requestedPermissions.length !== requestedPermissions.length
            || requestedPermissions.some(permission => !state.requestedPermissions.includes(permission)))) {
          return project({ state: 'needs_help', nextAction: 'The requested permissions differ from this saved setup. Resume it unchanged, or ask the owner to review a new registration.' }, state);
        }
        const session = await store.read('session.json');
        let previousCompletionId, previousBinding;
        if (command === 'doctor') return project({ state: session?._onboarding ? 'needs_help' : state?.phase === 'pending' ? 'pending_approval' : 'needs_help',
          nextAction: 'Private storage is readable. Run status for authenticated status or resume for saved setup recovery.' });
        if (state?.phase === 'cooldown') {
          if (state.retryAt > now()) return failureOutput(contract, 'degraded', 'service_busy');
          state = null;
        }
        if (state?.phase === 'ended' && session) {
          if (command === 'connect' && fresh) { previousCompletionId = session._onboarding?.completionId; previousBinding = { previousCompletionId, previousInstallationId: session._onboarding?.installation?.id, previousAgentId: session.agentId, previousInboxId: session.inboxId, previousAddress: session.address }; state = null; }
          else return await advance(state, false, false);
        }
        const priorEndedSession = !!session && !!state?.previousCompletionId && state.previousCompletionId === session._onboarding?.completionId
          && ['pending', 'confirming', 'activating'].includes(state.phase);
        if (session && !previousCompletionId && !priorEndedSession) {
          if (!session._onboarding || !state || (state.phase === 'completed' && state.completionId !== session._onboarding.completionId)
            || (state.phase === 'activating' && state.activationId !== session._onboarding.completionId)) throw new Error('STATE_INVALID');
          return await (state.phase === 'completed' || command === 'status' ? authenticatedStatus(session) : finishSession(session));
        }
        if (state?.phase === 'completed') throw new Error('STATE_INVALID');
        if (state?.phase === 'ended' && command === 'connect' && fresh) state = null;
        if (!state) {
          if (command !== 'connect') return failureOutput(contract, 'needs_help', 'register_again');
          if (typeof options.adopt !== 'function') return failureOutput(contract, 'needs_help', 'update_helper');
          if (!offered(await request('GET', '/api/onboarding/routes'), route)) return project({ state: 'needs_help', guidance: 'route_unavailable', nextAction: 'This server does not currently offer the requested connection route.' });
          await options.preflight?.({ origin, runtime, stateDirectory: store.directory ?? options.directory });
          const permissions = requestedPermissions;
          const body = await request('POST', '/api/agent-registrations', { body: {
            requestedName: options.requestedName ?? 'Envoi agent', requestedPermissions: permissions, connectionRoute: route, runtime,
            deliveryCapabilities: capabilities,
            helper: options.helper ?? { name: 'envoi-link', version: '1.0.0' } } });
          if (!identifier(body.registrationId) || body.status !== 'pending_claim' || typeof body.bootstrapToken !== 'string' || !body.bootstrapToken.startsWith('envoi_reg_')
            || body.claim?.url !== `${origin}/claim` || !/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(body.claim?.verificationCode)
            || !validDate(body.expiresAt) || body.claim.expiresAt !== body.expiresAt || !Number.isFinite(body.pollAfterSeconds) || body.pollAfterSeconds < limits.pollMinIntervalSeconds) throw new ProtocolError('INVALID_RESPONSE');
          state = { ...base, phase: 'pending', requestedPermissions: [...permissions], ...(previousCompletionId ? previousBinding : {}), registrationId: body.registrationId, bootstrapToken: body.bootstrapToken, claim: body.claim,
            expiresAt: body.expiresAt, nextPollAt: now() + body.pollAfterSeconds * 1000 };
          await save(state);
          return pendingOutput(state, true);
        }
        return await advance(state, ['connect', 'resume'].includes(command), showCode);
      } catch (error) {
        if (error instanceof ProtocolError || typeof error?.code === 'string' && ['CREDENTIAL_REVOKED', 'CREDENTIAL_EXPIRED', 'REFRESH_REPLAY', 'REFRESH_TOKEN_INVALID', 'REFRESH_RECOVERY_EXPIRED', 'ROTATION_ID_REQUIRED', 'ACTIVATION_REPLAY', 'ACTIVATION_RECOVERY_EXPIRED', 'NETWORK_ERROR', 'TIMEOUT', 'INTERNAL_SERVER_ERROR', 'AUTH_UNAVAILABLE'].includes(error.code)) return await protocolFailure(error, state, state?.phase === 'activating');
        // Project only static, allow-listed guidance, never an adapter/provider body.
        if (runtime.type === 'hermes' && error?.code === 'TOOLS_NOT_READY') return project({ state: 'needs_help',
          nextAction: 'Hermes did not invoke the Envoi identity tool before the recovery deadline. Keep the Gateway running, check its MCP/provider diagnostics, then resume this saved connection. Do not register again.' }, state);
        // Filesystem, prompt and adapter failures preserve the private journal.
        return failureOutput(contract);
      }
    }, { allowConnector: command === 'status' || command === 'doctor' });
  }
  return { connect: args => run('connect', args), resume: args => run('resume', args), status: args => run('status', args), doctor: args => run('doctor', args) };
}
