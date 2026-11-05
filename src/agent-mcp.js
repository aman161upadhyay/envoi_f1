import crypto from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import { remoteAuthScopes } from './agent-remote-auth.js';

// The handshake-era Streamable HTTP protocol permits stateless JSON responses.
// No MCP session is issued; the active agent credential is checked on every call.
const supportedVersions = new Set(['2025-03-26', '2025-06-18', '2025-11-25']);
const currentVersion = '2025-11-25';
const identifier = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' };
const idempotencyKey = { type: 'string', minLength: 1, maxLength: 200, pattern: '^[^\\x00-\\x1f\\x7f]+$' };
const address = { type: 'string', minLength: 3, maxLength: 254, pattern: '^[^\\s<>@]+@[^\\s<>@]+\\.[^\\s<>@]+$' };
const text = { type: 'string', minLength: 1, maxLength: 60000 };
const empty = { type: 'object', additionalProperties: false };
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const sendFields = {
  recipientAddress: address,
  text,
  idempotencyKey,
  intent: { type: 'string', enum: ['request', 'offer', 'counteroffer', 'accept', 'reject', 'clarify', 'commit', 'cancel', 'status', 'receipt', 'message'] }
};
const structuredValue = { type: 'object', minProperties: 1, maxProperties: 32 };

export const agentMcpTools = Object.freeze([
  { name: 'envoi_agent_info', description: 'Return the authenticated agent address and permissions. The agent and inbox are selected from the bearer credential.', inputSchema: empty, permission: null },
  { name: 'envoi_list_cases', description: 'List cases in this agent’s own inbox.', inputSchema: schema({ limit: { type: 'integer', minimum: 1, maximum: 100 }, before: { type: 'string', minLength: 1, maxLength: 256 } }), permission: 'read' },
  { name: 'envoi_read_case', description: 'Read one case in this agent’s own inbox.', inputSchema: schema({ caseId: identifier }, ['caseId']), permission: 'read' },
  { name: 'envoi_list_messages', description: 'List messages in this agent’s own inbox, optionally for a case.', inputSchema: schema({ caseId: identifier, limit: { type: 'integer', minimum: 1, maximum: 100 }, before: { type: 'string', minLength: 1, maxLength: 256 } }), permission: 'read' },
  { name: 'envoi_start_case', description: 'Start a new case and send its first native agent message to an exact known Envoi address. Retries with the same idempotency key reuse the same case.', inputSchema: schema(sendFields, ['recipientAddress', 'text', 'idempotencyKey']), permission: 'send_agent_messages' },
  { name: 'envoi_send_message', description: 'Send a native agent message in an existing case to an exact known Envoi address.', inputSchema: schema({ ...sendFields, caseId: identifier }, ['recipientAddress', 'text', 'caseId', 'idempotencyKey']), permission: 'send_agent_messages' },
  { name: 'envoi_send_proposal', description: 'Send a structured, agent-authored proposal in an existing shared case. This is a native collaboration message, not a server-attested approval.', inputSchema: schema({ recipientAddress: address, caseId: identifier, text, proposal: structuredValue, idempotencyKey }, ['recipientAddress', 'caseId', 'text', 'proposal', 'idempotencyKey']), permission: 'send_agent_messages' },
  { name: 'envoi_send_decision', description: 'Send a structured, agent-authored accept, reject, counteroffer, or clarification message in an existing shared case. This does not execute an external action.', inputSchema: schema({ recipientAddress: address, caseId: identifier, text, decision: { type: 'string', enum: ['accept', 'reject', 'counteroffer', 'clarify'] }, proposalMessageId: identifier, details: structuredValue, idempotencyKey }, ['recipientAddress', 'caseId', 'text', 'decision', 'idempotencyKey']), permission: 'send_agent_messages' },
  { name: 'envoi_send_completion', description: 'Send a typed completion in an existing shared case. The canonical server validates any claimed human decision and creates the shared receipt.', inputSchema: schema({ recipientAddress: address, caseId: identifier, text, result: text, authorityBasis: identifier, evidenceRefs: { type: 'array', items: identifier, maxItems: 32 }, idempotencyKey }, ['recipientAddress', 'caseId', 'text', 'result', 'idempotencyKey']), permission: 'send_agent_messages' },
  { name: 'envoi_claim_work', description: 'Claim one incoming message under a fenced lease. An empty work field means no work is available.', inputSchema: empty, permission: 'receive_agent_messages' },
  { name: 'envoi_renew_work', description: 'Extend the current work lease; requires its opaque fence token.', inputSchema: schema({ workId: identifier, leaseToken: { type: 'string', minLength: 1, maxLength: 256 } }, ['workId', 'leaseToken']), permission: 'receive_agent_messages' },
  { name: 'envoi_acknowledge_work', description: 'Record admission of claimed work using a fenced lease and idempotency key.', inputSchema: schema({ workId: identifier, leaseToken: { type: 'string', minLength: 1, maxLength: 256 }, idempotencyKey }, ['workId', 'leaseToken', 'idempotencyKey']), permission: 'receive_agent_messages' },
  { name: 'envoi_complete_work', description: 'Record successful processing of claimed work using a fenced lease and idempotency key.', inputSchema: schema({ workId: identifier, leaseToken: { type: 'string', minLength: 1, maxLength: 256 }, idempotencyKey }, ['workId', 'leaseToken', 'idempotencyKey']), permission: 'receive_agent_messages' },
  { name: 'envoi_fail_work', description: 'Record failed processing of claimed work; retryable failures use bounded server backoff.', inputSchema: schema({ workId: identifier, leaseToken: { type: 'string', minLength: 1, maxLength: 256 }, retryable: { type: 'boolean' }, reasonCode: { type: 'string', maxLength: 120 } }, ['workId', 'leaseToken', 'retryable']), permission: 'receive_agent_messages' },
  { name: 'envoi_list_assets', description: 'List grant-filtered asset metadata in this agent’s own inbox, optionally for one case. No binary content is returned.', inputSchema: schema({ caseId: identifier }), permission: 'read' },
  { name: 'envoi_begin_asset_upload', description: 'Reserve a quarantined asset and return a short-lived signed binary PUT URL. Upload bytes directly to that URL, then complete the asset. Reuse the idempotency key for a retry.', inputSchema: schema({ filename: { type: 'string', minLength: 1, maxLength: 255 }, mimeType: { type: 'string', minLength: 1, maxLength: 128 }, size: { type: 'integer', minimum: 1, maximum: 26214400 }, checksumSha256: { type: 'string', pattern: '^[A-Za-z0-9+/]{43}=$' }, caseId: identifier, idempotencyKey }, ['filename', 'mimeType', 'size', 'checksumSha256', 'idempotencyKey']), permission: 'create_assets' },
  { name: 'envoi_complete_asset_upload', description: 'Verify an uploaded asset and run the configured malware scan. Only a clean result can be downloaded.', inputSchema: schema({ assetId: identifier }, ['assetId']), permission: 'create_assets' },
  { name: 'envoi_asset_download', description: 'Return a short-lived signed download URL for a clean asset in this agent’s own inbox.', inputSchema: schema({ assetId: identifier }, ['assetId']), permission: 'read' },
  { name: 'envoi_grant_asset', description: 'Grant an uploaded case asset to the exact counterparty agent. The REST server validates creator, case, tenant, block and recipient scope; a signed URL is not a grant.', inputSchema: schema({ assetId: identifier, caseId: identifier, recipientAgentId: identifier, idempotencyKey }, ['assetId', 'caseId', 'recipientAgentId', 'idempotencyKey']), permission: 'create_assets' }
]);

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validators = new Map(agentMcpTools.map(tool => [tool.name, ajv.compile(tool.inputSchema)]));
export const messageAccessTool = Object.freeze({
  name: 'envoi_request_message_access',
  title: 'Enable Envoi messaging',
  description: 'Use when the owner asks to enable two-way native Envoi messages or recover missing Send permission. Checks this existing connection and requests owner-approved OAuth reauthorization if needed. Does not send messages, create an agent or grant access itself.',
  inputSchema: empty,
  permission: null
});
export function messageAccessResult(identity, origin, maximumPermissions) {
  const info = { address: identity.agent.address, permissions: identity.agent.permissions || [] };
  const result = (state, text, isError) => ({ content: [{ type: 'text', text }], structuredContent: { state, ...info }, isError });
  if (info.permissions.includes('send_agent_messages')) return result('ready', JSON.stringify({ state: 'ready', ...info }), false);
  if (!maximumPermissions.includes('send_agent_messages')) return result('policy_blocked', 'Organization policy does not allow Send agent messages. Ask the workspace owner to review the policy.', true);
  const description = 'Reconnect this existing Envoi agent and approve Receive and Send agent messages.';
  const challenge = `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", error="insufficient_scope", error_description="${description}", scope="envoi.agent envoi.send"`;
  return { ...result('permission_required', description, true), _meta: { 'mcp/www_authenticate': [challenge] } };
}
const agentToolNames = new Set([...agentMcpTools, messageAccessTool].map(tool => tool.name));
const irreversibleTools = new Set(['envoi_complete_work', 'envoi_fail_work', 'envoi_complete_asset_upload', 'envoi_grant_asset']);
const externalTools = new Set(['envoi_grant_asset']);
const publicTool = (tool, identity) => {
  const { name, description, inputSchema } = tool;
  const result = { name, description, inputSchema };
  for (const key of ['title', 'outputSchema', 'annotations', 'securitySchemes', '_meta']) if (tool[key] !== undefined) result[key] = tool[key];
  if (!agentToolNames.has(name)) return result;
  const readOnly = tool.permission === null || tool.permission === 'read';
  const sending = tool.permission === 'send_agent_messages';
  result.annotations = { readOnlyHint: readOnly, destructiveHint: !readOnly && (sending || irreversibleTools.has(name)), openWorldHint: sending || externalTools.has(name) };
  if (identity.oauth) {
    const needed = name === messageAccessTool.name ? 'envoi.send' : remoteAuthScopes.find(entry => entry.permission === tool.permission)?.scope;
    const scopes = [...new Set(['envoi.agent', ...(needed ? [needed] : [])])];
    result.securitySchemes = [{ type: 'oauth2', scopes }];
    result._meta = { ...(result._meta || {}), securitySchemes: result.securitySchemes };
  }
  return result;
};
const hasPermission = (identity, permission) => permission === null || (permission === 'read'
  ? identity.agent.permissions?.some(value => value === 'send_agent_messages' || value === 'receive_agent_messages')
  : identity.agent.permissions?.includes(permission));
const scopedReadTools = new Set(['envoi_agent_info', 'envoi_read_case', 'envoi_list_messages']);
const toolAvailable = (identity, tool) => hasPermission(identity, tool.permission)
  && (!identity.mcpScope || (scopedReadTools.has(tool.name)
    && (tool.name === 'envoi_agent_info' || Boolean(identity.mcpScope.caseId))));
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const sendJson = (res, status, payload) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
};
const toolResult = (value, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], isError });
const query = args => {
  const params = new URLSearchParams();
  if (args.caseId) params.set('caseId', args.caseId);
  if (args.limit) params.set('limit', String(args.limit));
  if (args.before) params.set('before', args.before);
  return params.size ? `?${params}` : '';
};

async function invokeTool(name, args, identity, callRest) {
  const base = `/api/inboxes/${identity.inboxId}`;
  if (name === 'envoi_agent_info') return {
    agentId: identity.agent.id, inboxId: identity.inboxId, address: identity.agent.address,
    permissions: identity.mcpScope ? ['mcp_read'] : identity.agent.permissions,
    ...(identity.mcpScope ? { caseId: identity.mcpScope.caseId } : {})
  };
  if (name === 'envoi_list_cases') return callRest('GET', `${base}/cases${query(args)}`);
  if (name === 'envoi_read_case') return callRest('GET', `${base}/cases/${args.caseId}`);
  if (name === 'envoi_list_messages') return callRest('GET', `${base}/messages${query(args)}`);
  if (name === 'envoi_list_assets') return callRest('GET', `${base}/assets${query(args)}`);
  if (name === 'envoi_begin_asset_upload') {
    const { idempotencyKey: key, ...metadata } = args;
    return callRest('POST', `${base}/asset-uploads`, metadata, key);
  }
  if (name === 'envoi_complete_asset_upload') return callRest('POST', `${base}/assets/${args.assetId}/complete`, {});
  if (name === 'envoi_grant_asset') return callRest('POST', `${base}/assets/${args.assetId}/grants`, { caseId: args.caseId, recipientAgentId: args.recipientAgentId }, args.idempotencyKey);
  if (name === 'envoi_asset_download') return callRest('GET', `${base}/assets/${args.assetId}/download`);
  if (['envoi_start_case', 'envoi_send_message', 'envoi_send_proposal', 'envoi_send_decision', 'envoi_send_completion'].includes(name)) {
    const caseId = name === 'envoi_start_case'
      ? `case_${crypto.createHash('sha256').update(`${identity.agent.id}:${args.idempotencyKey}`).digest('hex').slice(0, 32)}`
      : args.caseId;
    const isProposal = name === 'envoi_send_proposal';
    const isDecision = name === 'envoi_send_decision';
    const isCompletion = name === 'envoi_send_completion';
    const isCounterproposal = isDecision && args.decision === 'counteroffer';
    const { status, payload } = await callRest('POST', `${base}/messages`, {
      senderAgentId: identity.agent.id,
      recipientEmail: args.recipientAddress,
      text: args.text,
      intent: name === 'envoi_start_case' ? args.intent || 'request' : isProposal ? 'offer' : isDecision ? args.decision : isCompletion ? 'receipt' : args.intent || 'message',
      caseId,
      ...(name === 'envoi_start_case' ? { type: 'request' } : {}),
      ...(isProposal ? { type: 'proposal', payload: { proposal: args.proposal } } : {}),
      ...(isCounterproposal ? { type: 'counterproposal', payload: { counterproposal: { ...(args.details || {}), proposalMessageId: args.proposalMessageId || null } } } : {}),
      ...(isDecision && !isCounterproposal ? { type: 'decision', payload: { decision: { kind: args.decision, proposalMessageId: args.proposalMessageId || null, details: args.details || null } } } : {}),
      ...(isCompletion ? { type: 'completion', payload: { completion: { result: args.result, authorityBasis: args.authorityBasis || null, evidenceRefs: args.evidenceRefs || [] } } } : {})
    }, args.idempotencyKey);
    return { status, payload: { ...payload, caseId: payload?.caseId || caseId } };
  }
  if (name === 'envoi_claim_work') return callRest('POST', '/api/agent/work/claim', {});
  const action = {
    envoi_renew_work: 'renew',
    envoi_acknowledge_work: 'acknowledge',
    envoi_complete_work: 'complete',
    envoi_fail_work: 'fail'
  }[name];
  return callRest('POST', `/api/agent/work/${args.workId}/${action}`, {
    leaseToken: args.leaseToken,
    ...(action === 'fail' ? { retryable: args.retryable, reasonCode: args.reasonCode } : {})
  }, args.idempotencyKey);
}

// The transport rules every /mcp request follows (docs/agent-mcp-remote.md): method, Accept,
// Content-Type, size, the JSON-RPC envelope, notifications, initialize and the protocol version.
// Resolves to { request } for a request still to answer, or to undefined once it has responded.
export async function readMcpRequest(req, res, { maxRequestBytes = 64 * 1024, allowEventsVersion = false, eventsAvailable = false, recognizeEventMethods = false } = {}) {
  if (req.method === 'GET' || req.method === 'DELETE') {
    res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' });
    res.end();
    return undefined;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' });
    res.end();
    return undefined;
  }
  const accept = String(req.headers.accept || '').toLowerCase();
  if (!accept.includes('application/json') || !accept.includes('text/event-stream')) return sendJson(res, 406, rpcError(null, -32600, 'Accept must include application/json and text/event-stream'));
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return sendJson(res, 415, rpcError(null, -32600, 'Content-Type must be application/json'));
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxRequestBytes) return sendJson(res, 413, rpcError(null, -32600, 'MCP request is too large'));
    chunks.push(chunk);
  }
  let request;
  try { request = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return sendJson(res, 400, rpcError(null, -32700, 'Invalid JSON')); }
  if (!request || Array.isArray(request) || typeof request !== 'object' || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    return sendJson(res, 400, rpcError(null, -32600, 'A single JSON-RPC request or notification is required'));
  }
  const id = request.id;
  if (id !== undefined && !(typeof id === 'string' || typeof id === 'number') || id === null) return sendJson(res, 400, rpcError(null, -32600, 'Invalid JSON-RPC id'));
  if (request.method === 'notifications/initialized' && id === undefined) {
    res.writeHead(202, { 'cache-control': 'no-store' });
    res.end();
    return undefined;
  }
  if (id === undefined) return sendJson(res, 400, rpcError(null, -32600, 'Unsupported notification'));
  if (request.method === 'initialize') {
    if (typeof request.params?.protocolVersion !== 'string' || !request.params?.clientInfo || !request.params?.capabilities) {
      return sendJson(res, 200, rpcError(id, -32602, 'Invalid initialize parameters'));
    }
    const protocolVersion = allowEventsVersion && request.params.protocolVersion === '2026-07-28' ? '2026-07-28' : supportedVersions.has(request.params.protocolVersion) ? request.params.protocolVersion : currentVersion;
    return sendJson(res, 200, rpcResult(id, { protocolVersion, capabilities: { tools: { listChanged: false }, ...(eventsAvailable && protocolVersion === '2026-07-28' ? { events: {} } : {}) }, serverInfo: { name: 'envoi', version: '0.1.0' } }));
  }
  const version = req.headers['mcp-protocol-version'];
  const eventMethod = request.method === 'server/discover' || request.method.startsWith('events/');
  // An unavailable extension is a missing protocol method. Let the method dispatcher give
  // that answer even when its protocol header is newer than the enabled tool protocol.
  const recognizeUnavailableEvent = recognizeEventMethods && eventMethod && version === '2026-07-28';
  if (version && !supportedVersions.has(String(version)) && !(allowEventsVersion && version === '2026-07-28') && !recognizeUnavailableEvent) return sendJson(res, 400, rpcError(id, -32600, 'Unsupported MCP protocol version'));
  return { request };
}

export const mcpReply = { sendJson, rpcError, rpcResult, toolResult };

function wakeHttpError(error, res) {
  if (!Number.isInteger(error?.statusCode)) return error;
  const fields = { ...error.publicFields, ...(typeof error.reason === 'string' ? { reason: error.reason } : {}) };
  const supplied = Number(error.retryAfter ?? fields.retryAfterSeconds);
  if (error.statusCode === 429 || Number.isFinite(supplied) && supplied > 0) {
    const seconds = Number.isFinite(supplied) && supplied > 0 ? Math.min(3600, Math.max(1, Math.ceil(supplied))) : 1;
    fields.retryAfterSeconds = seconds;
    res.setHeader('retry-after', String(seconds));
  }
  error.publicFields = fields;
  return error;
}

export async function handleAgentMcp(req, res, { identity, callRest, maxRequestBytes = 64 * 1024, denyUnavailable = null, onPermissionDenied = null, wakeTools = null, providerEvents = null, eventsEnabled = false, requestMessageAccess = null }) {
  const eventAvailable = Boolean(providerEvents && await providerEvents.available(identity, '2026-07-28'));
  const read = await readMcpRequest(req, res, { maxRequestBytes, allowEventsVersion: eventsEnabled, eventsAvailable: eventAvailable, recognizeEventMethods: true });
  if (!read?.request) return;
  const { request } = read;
  const id = request.id;
  if (request.method === 'server/discover' || request.method.startsWith('events/')) {
    const version = req.headers['mcp-protocol-version'];
    if (!eventAvailable || version !== '2026-07-28') return sendJson(res, 200, rpcError(id, -32601, 'Method not found'));
    const method = { 'server/discover': 'discover', 'events/list': 'list', 'events/subscribe': 'subscribe', 'events/unsubscribe': 'unsubscribe' }[request.method];
    if (!method) return sendJson(res, 200, rpcError(id, -32601, 'Method not found'));
    try {
      const value = method === 'discover' ? await providerEvents.discover(identity, version) : await providerEvents[method](identity, request.params ?? {}, version);
      return sendJson(res, 200, rpcResult(id, value));
    } catch (error) {
      if (!error.rpcCode) throw wakeHttpError(error, res);
      return sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: error.rpcCode, message: error.rpcCode === -32015 ? 'CallbackEndpointError' : error.rpcCode === -32601 ? 'Method not found' : 'Invalid params', ...(error.reason ? { data: { reason: error.reason } } : {}) } });
    }
  }
  const wakeAvailable = Boolean(wakeTools && await wakeTools.available(identity));
  const messageAccessAvailable = Boolean(identity.oauth && !identity.mcpScope && requestMessageAccess);
  const offeredTools = [...agentMcpTools, ...(messageAccessAvailable ? [messageAccessTool] : []), ...(wakeAvailable ? wakeTools.tools : [])];
  if (request.method === 'ping') return sendJson(res, 200, rpcResult(id, {}));
  if (request.method === 'tools/list') {
    if (request.params?.cursor) return sendJson(res, 200, rpcError(id, -32602, 'Tool cursor is invalid'));
    return sendJson(res, 200, rpcResult(id, { tools: offeredTools.filter(tool => toolAvailable(identity, tool)).map(tool => publicTool(tool, identity)) }));
  }
  if (request.method !== 'tools/call') return sendJson(res, 200, rpcError(id, -32601, 'Method not found'));
  const name = request.params?.name;
  const tool = offeredTools.find(candidate => candidate.name === name);
  // A credential with its own scope (agent-remote-auth §9) is refused with a scope error, before the arguments are read.
  if (tool && !toolAvailable(identity, tool)) onPermissionDenied?.(tool);
  if (tool && !toolAvailable(identity, tool) && denyUnavailable) denyUnavailable(tool);
  if (!tool || !toolAvailable(identity, tool)) return sendJson(res, 200, rpcError(id, -32602, 'Tool not available to this agent'));
  const wakeTool = wakeAvailable && wakeTools.tools.some(candidate => candidate.name === name);
  const args = (wakeTool || name === messageAccessTool.name) && request.params?.arguments !== undefined ? request.params.arguments : request.params?.arguments ?? {};
  // Wake's approved contract reports argument refusal in the case-tools envelope.
  // The service validates its closed schema before reading any argument or doing work.
  if (!wakeTool && !(validators.get(name) || (tool && ajv.compile(tool.inputSchema)))(args)) return sendJson(res, 200, rpcError(id, -32602, 'Invalid tool arguments'));
  if (identity.mcpScope && name !== 'envoi_agent_info' && args.caseId !== identity.mcpScope.caseId) {
    onPermissionDenied?.(tool);
    return sendJson(res, 200, rpcError(id, -32602, 'Case is outside this MCP token scope'));
  }
  try {
    if (name === messageAccessTool.name) return sendJson(res, 200, rpcResult(id, await requestMessageAccess()));
    if (wakeTool) return sendJson(res, 200, rpcResult(id, await wakeTools.call(name, args, identity)));
    const response = await invokeTool(name, args, identity, callRest);
    if (response?.status && response.status >= 400) return sendJson(res, 200, rpcResult(id, toolResult({ status: response.status, ...response.payload }, true)));
    return sendJson(res, 200, rpcResult(id, toolResult(response)));
  } catch (error) {
    if ((wakeTool || name === messageAccessTool.name) && error.statusCode) throw wakeHttpError(error, res);
    return sendJson(res, 200, rpcResult(id, toolResult({ error: 'Tool temporarily unavailable' }, true)));
  }
}
