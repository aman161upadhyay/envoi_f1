import { readFileSync } from 'node:fs';
import path from 'node:path';
import { valueDigest } from './policy-engine.js';
import { projectCaseSnapshot, projectCaseAsset } from './case-tools-projection.js';

// Canonical schemas are consumed verbatim, including closed argument objects.
export const caseToolsContract = JSON.parse(readFileSync(new URL('../test/contract-fixtures/case-tools/schemas.json', import.meta.url)));
export const caseToolError = code => Object.assign(new Error(caseToolsContract['x-tool-errors'][code]?.message || code), { toolCode: code });
const requireValue = value => { if (!value) throw caseToolError('REF_NOT_FOUND'); return value; };
const byTime = (a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id));
const success = (tool, result) => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, tool, result }) }], isError: false });
const failure = (tool, code) => {
  const row = caseToolsContract['x-tool-errors'][code];
  return { content: [{ type: 'text', text: JSON.stringify({ ok: false, tool, code, message: row.message, retryable: row.retryable }) }], isError: true };
};

// case-tools v1 §12.5: the refusals the policy binding check and proposal acceptance give, by their
// exact server messages. Anything else is not an authority outcome: a fault stays an HTTP 500 and a
// session end its 401 (§2), and a participant change while taking the locks is TOOL_BUSY.
const authorityRefusals = new Map([
  ['A current server-issued policy evaluation for this agent and case is required', 'AUTHORITY_DENIED'],
  ['Policy decision failed integrity verification', 'AUTHORITY_DENIED'],
  ['This action requires human approval', 'AUTHORITY_PENDING'],
  ['Policy decision expired before execution', 'AUTHORITY_EXPIRED'],
  ['Policy decision does not authorize this action', 'AUTHORITY_CHANGED'],
  ['Policy decision does not authorize this proposal option', 'AUTHORITY_CHANGED'],
  ['Action authority binding changed after policy evaluation', 'AUTHORITY_CHANGED'],
  ['Proposal changed after policy evaluation', 'AUTHORITY_CHANGED'],
  ['Action is earlier than its authorized execution window', 'AUTHORITY_CHANGED'],
  ['Action is later than its authorized execution window', 'AUTHORITY_CHANGED'],
  ['Current policy requires a new human approval', 'AUTHORITY_CHANGED'],
  ['This one-time policy evaluation has already been consumed', 'AUTHORITY_CHANGED'],
  ['Proposal not found', 'AUTHORITY_CHANGED'],
  ['Proposal option is missing or expired', 'OPTION_NOT_LIVE'],
  ['Case participants changed while acquiring the mutation lock; retry', 'TOOL_BUSY']
]);
const authorityRefusalPrefixes = [
  ['Policy denied this action: ', 'AUTHORITY_DENIED'],
  ['Current policy denied this action: ', 'AUTHORITY_DENIED'],
  ['Proposal cannot be accepted from ', 'PROPOSAL_NOT_AWAITING']
];
export function authorityToolError(error) {
  if (error?.toolCode) return error;
  if (![403, 404, 409].includes(error?.statusCode) || error.code) return null;
  const message = String(error.message || '');
  const code = authorityRefusals.get(message) || authorityRefusalPrefixes.find(([prefix]) => message.startsWith(prefix))?.[1];
  return code ? caseToolError(code) : null;
}

// case-session v1 §3.1: the work message written when a person resolves an agent's request, or
// when the request expires. An expiry has no person, so it is sent by `system` and names nobody.
const decisionLabels = { approved: 'Approved', declined: 'Declined', expired: 'Expired' };
export function humanDecisionWorkMessage({ id, request, outcome, humanId = null, requestedAction, at }) {
  if (!decisionLabels[outcome]) throw new TypeError('Unknown human decision outcome');
  if (!['proposal.accept', 'case.complete'].includes(requestedAction)) throw new TypeError('A human decision resolves proposal.accept or case.complete');
  const person = outcome === 'expired' ? null : humanId;
  if (outcome !== 'expired' && !person) throw new TypeError('An approval or decline names the person who made it');
  return {
    id, kind: 'humanDecision', type: 'humanDecision', inboxId: request.inboxId, caseId: request.caseId,
    senderType: person ? 'human' : 'system', ...(person ? { senderHumanId: person, from: { humanId: person } } : {}),
    recipientInboxId: request.inboxId, recipientAgentId: request.agentId,
    counterpartyAgentId: request.counterpartyAgentId, counterpartyInboxId: request.counterpartyInboxId, counterpartyAddress: request.counterpartyAddress,
    requestId: request.id, policyEvaluationId: request.policyEvaluationId, action: requestedAction, outcome,
    text: `${decisionLabels[outcome]}: ${requestedAction === 'proposal.accept' ? 'accept the requested option.' : 'the requested case outcome.'}`,
    status: 'delivered', createdAt: at, deliveredAt: at, updatedAt: at
  };
}

// The host supplies existing in-process services. withSession must hold the settlement
// locks, rederive live authority, and roll back all staged effects on any exception.
export function createCaseTools({ store, codec, withSession, load, send, evaluate, authorize, requestHuman, share, readContent, complete }) {
  const refs = (ctx, kind, id) => codec.ref(ctx.session, kind, id);
  const resolve = (ctx, kind, reference, candidates) => requireValue(codec.resolve(ctx.session, kind, reference, candidates));
  const snapshot = (ctx, args = {}) => projectCaseSnapshot({ ...ctx, codec, allowedTools: ctx.effectiveTools, now: store.now() }, args);
  const currentProposal = ctx => {
    const shown = snapshot(ctx).proposal;
    return shown ? resolve(ctx, 'p', shown.ref, ctx.caseRecord.proposals) : null;
  };
  const assertAwaiting = (ctx, proposal) => {
    const shown = snapshot(ctx).proposal;
    if (!shown || shown.ref !== refs(ctx, 'p', proposal.id) || shown.lastActor !== 'other_agent') throw caseToolError('PROPOSAL_NOT_AWAITING');
  };
  const option = (ctx, proposal, reference) => {
    const value = resolve(ctx, 'o', reference, ctx.caseRecord.proposals.flatMap(p => p.options));
    if (!proposal.options.some(o => o.id === value.id && !o.expired) || proposal.expiresAt && proposal.expiresAt <= store.now()) throw caseToolError('OPTION_NOT_LIVE');
    return value;
  };
  const groupReplyTarget = (ctx, reference) => reference
    ? resolve(ctx, 'm', reference, ctx.messages)
    : requireValue(ctx.messages.find(message => message.id === ctx.workMessage.groupCase.messageId));
  const methods = {
    envoi_case_snapshot: async (ctx, args) => snapshot(ctx, args),
    envoi_case_reply: async (ctx, args, id) => {
      let target;
      if (ctx.session.workKind === 'human_instruction') {
        if (args.inReplyTo) throw caseToolError('NOT_SUPPORTED_FOR_WORK');
        if (args.intent !== 'message') throw caseToolError('NOT_SUPPORTED_FOR_WORK');
        target = ctx.workMessage;
      } else if (ctx.workMessage.groupCase) {
        target = groupReplyTarget(ctx, args.inReplyTo);
      } else {
        target = args.inReplyTo ? resolve(ctx, 'm', args.inReplyTo, ctx.messages) : ctx.session.workKind === 'human_decision'
          ? requireValue(ctx.messages.filter(m => m.senderAgentId === ctx.session.counterpartyAgentId && m.senderType === 'agent').sort(byTime).at(-1)) : ctx.workMessage;
        if (target.senderAgentId !== ctx.session.counterpartyAgentId || target.kind === 'humanInstruction' || target.kind === 'humanInstructionReply' || target.kind === 'humanDecision') throw caseToolError('REF_NOT_FOUND');
      }
      const message = await send(ctx, { id, type: 'message', intent: args.intent, text: args.text, inReplyTo: target.id,
        ...(args.assigneeAgentIds?.length ? { assigneeAgentIds: args.assigneeAgentIds } : {}) });
      const group = Boolean(ctx.workMessage.groupCase);
      return { messageRef: refs(ctx, 'm', message.id), status: group || ctx.session.workKind === 'human_instruction' ? 'delivered' : 'queued',
        recipient: group ? { kind: 'group' } : ctx.session.counterparty, inReplyTo: refs(ctx, 'm', target.id), createdAt: message.createdAt, replayed: false };
    },
    envoi_case_propose: async (ctx, args, id) => {
      if (currentProposal(ctx)) throw caseToolError('PROPOSAL_EXISTS');
      const message = await send(ctx, { id, type: 'proposal', intent: 'offer', text: args.text, payload: { proposal: args.terms } });
      return { messageRef: refs(ctx, 'm', id), proposalRef: refs(ctx, 'p', `proposal_${id}`), optionRef: refs(ctx, 'o', `option_${id}`), status: 'queued', recipient: ctx.session.counterparty, replayed: false };
    },
    envoi_authority_check: async (ctx, args, id) => {
      let proposal = null, selected = null;
      if (args.action === 'accept_proposal') {
        proposal = resolve(ctx, 'p', args.proposalRef, ctx.caseRecord.proposals);
        assertAwaiting(ctx, proposal);
        selected = option(ctx, proposal, args.optionRef);
      }
      const record = await evaluate(ctx, args.action, proposal, selected, args.result, id);
      return { action: args.action, authorityRef: refs(ctx, 'g', record.id), decision: record.decision, humanApproval: record.decision === 'needsHuman' ? 'pending' : 'not_required', expiresAt: record.expiresAt, proposalRef: proposal ? refs(ctx, 'p', proposal.id) : null, optionRef: selected ? refs(ctx, 'o', selected.id) : null, replayed: false };
    },
    envoi_request_human: async (ctx, args, id) => {
      const authority = resolve(ctx, 'g', args.authorityRef, ctx.policyEvaluations);
      if (authority.expiresAt <= store.now()) throw caseToolError('AUTHORITY_EXPIRED');
      if (authority.decision !== 'needsHuman' || authority.humanApproval === 'approved' || ctx.humanRequests.some(r => r.status === 'pending' || r.policyEvaluationId === authority.id)) throw caseToolError('AUTHORITY_NOT_PENDING');
      const request = await requestHuman(ctx, authority, args.question, id);
      return { requestRef: refs(ctx, 'q', request.id), status: 'pending', authorityRef: refs(ctx, 'g', authority.id), endTurn: true, replayed: false };
    },
    envoi_case_decide: async (ctx, args, id) => {
      const proposal = resolve(ctx, 'p', args.proposalRef, ctx.caseRecord.proposals);
      assertAwaiting(ctx, proposal);
      let selected = null;
      if (args.decision === 'accept') {
        selected = option(ctx, proposal, args.optionRef);
        const authority = resolve(ctx, 'g', args.authorityRef, ctx.policyEvaluations);
        await authorize(ctx, authority, 'proposal.accept', { proposalId: proposal.id, optionId: selected.id }, proposal, selected, id);
      }
      const proposalMessageId = proposal.id.slice('proposal_'.length);
      await send(ctx, { id, type: args.decision === 'counter' ? 'counterproposal' : 'decision', intent: args.decision === 'counter' ? 'counteroffer' : args.decision, text: args.text,
        payload: { ...(args.decision === 'counter' ? { counterproposal: args.terms } : {}), decision: { kind: args.decision === 'counter' ? 'counteroffer' : args.decision, proposalMessageId } } });
      const value = await load(ctx.session);
      return { decision: args.decision, messageRef: refs(ctx, 'm', id), proposalRef: refs(ctx, 'p', proposal.id), optionRef: args.decision === 'counter' ? refs(ctx, 'o', `option_${id}`) : selected ? refs(ctx, 'o', selected.id) : null,
        proposalStatus: { counter: 'countered', reject: 'withdrawn', accept: 'accepted' }[args.decision], caseStatus: value.caseRecord.state, recipient: ctx.session.counterparty, replayed: false };
    },
    envoi_case_list_assets: async (ctx, args) => {
      const project = asset => ({ ...projectCaseAsset(asset, { codec, session: ctx.session }), checksumSha256: asset.checksumSha256 });
      if (args.assetRef) {
        const asset = resolve(ctx, 'a', args.assetRef, ctx.assets);
        let content = null, contentUnavailable = null;
        if (args.includeContent) {
          if (asset.state !== 'clean') throw caseToolError('ASSET_NOT_CLEAN');
          if (asset.size > 32768) contentUnavailable = 'too_large';
          else if (!caseToolsContract['x-limits'].inlineContentTypes.includes(asset.mimeType)) contentUnavailable = 'binary';
          else content = { encoding: 'utf-8', text: await readContent(ctx, asset) };
        }
        return { asset: project(asset), content, contentUnavailable };
      }
      const before = args.before ? codec.openCursor(ctx.session, args.before, store.now(), 'assets') : null;
      const values = [...ctx.assets].sort(byTime).reverse().filter(a => !before || byTime(a, before) < 0);
      const selected = values.slice(0, args.limit ?? 20), hasMore = values.length > selected.length;
      return { assets: selected.map(project), hasMore, nextCursor: hasMore ? codec.sealCursor(ctx.session, selected.at(-1), store.now(), 'assets') : null };
    },
    envoi_case_share_asset: async (ctx, args) => {
      const asset = resolve(ctx, 'a', args.assetRef, ctx.assets);
      if (asset.createdByAgentId !== ctx.agent.id || asset.workspaceId !== ctx.session.inboxId) throw caseToolError('ASSET_NOT_SHAREABLE');
      if (asset.state !== 'clean') throw caseToolError('ASSET_NOT_CLEAN');
      return { assetRef: args.assetRef, recipient: ctx.session.counterparty, alreadyShared: await share(ctx, asset), replayed: false };
    },
    envoi_case_complete: async (ctx, args, id) => {
      const evidence = (args.evidenceRefs ?? []).map(ref => resolve(ctx, 'a', ref, ctx.assets));
      if (evidence.some(asset => !asset.shared && asset.createdByAgentId !== ctx.session.counterpartyAgentId)) throw caseToolError('EVIDENCE_NOT_SHARED');
      const authority = args.authorityRef ? resolve(ctx, 'g', args.authorityRef, ctx.policyEvaluations) : null;
      const result = await complete(ctx, args.result, authority, evidence, id);
      return { receiptRef: refs(ctx, 'r', `receipt_${id}`), messageRef: refs(ctx, 'm', id), humanApproval: result.humanApproval, caseStatus: 'completed', recipient: ctx.session.counterparty, evidenceRefs: args.evidenceRefs ?? [], replayed: false };
    }
  };
  return new Map(caseToolsContract['x-tools'].map(tool => [tool.name, { description: tool.description, inputSchema: tool.inputSchema,
    async run(input, scope) {
      try {
        return await withSession({ ...scope, toolName: tool.name }, async ctx => {
          const args = { ...input };
          if (tool.name === 'envoi_case_reply') {
            args.intent ??= 'message';
            if (args.assigneeAgentIds) {
              if (!ctx.workMessage.groupCase) throw caseToolError('NOT_SUPPORTED_FOR_WORK');
              if (args.assigneeAgentIds.some(agentId => agentId === ctx.agent.id || !ctx.workMessage.groupCase.memberAgentIds.includes(agentId))) {
                throw caseToolError('REF_NOT_FOUND');
              }
              args.assigneeAgentIds = [...args.assigneeAgentIds].sort();
            }
            // Resolve defaults before the digest, across sessions/reclaims.
            if (ctx.session.workKind !== 'human_instruction' && !args.inReplyTo) {
              const target = ctx.workMessage.groupCase ? groupReplyTarget(ctx) : ctx.session.workKind === 'human_decision'
                ? ctx.messages.filter(m => m.senderAgentId === ctx.session.counterpartyAgentId).sort(byTime).at(-1) : ctx.workMessage;
              if (target) args.inReplyTo = refs(ctx, 'm', target.id);
            }
          }
          if (args.terms && Buffer.byteLength(JSON.stringify(args.terms)) > 1024) throw Object.assign(new Error('Invalid tool arguments'), { statusCode: 400, invalidToolArguments: true });
          if (!['envoi_case_share_asset', 'envoi_case_complete'].includes(tool.name)) {
            if (args.inReplyTo) {
              if (ctx.session.workKind === 'human_instruction') throw caseToolError('NOT_SUPPORTED_FOR_WORK');
              const target = resolve(ctx, 'm', args.inReplyTo, ctx.messages);
              if ((!ctx.workMessage.groupCase && target.senderAgentId !== ctx.session.counterpartyAgentId) || target.kind) throw caseToolError('REF_NOT_FOUND');
            }
            if (args.proposalRef) resolve(ctx, 'p', args.proposalRef, ctx.caseRecord.proposals);
            if (args.optionRef) resolve(ctx, 'o', args.optionRef, ctx.caseRecord.proposals.flatMap(p => p.options));
            if (args.authorityRef) resolve(ctx, 'g', args.authorityRef, ctx.policyEvaluations);
            if (args.assetRef) resolve(ctx, 'a', args.assetRef, ctx.assets);
            if (tool.name === 'envoi_case_reply' && ctx.session.workKind === 'human_instruction' && args.intent !== 'message') throw caseToolError('NOT_SUPPORTED_FOR_WORK');
          }
          const keyPath = tool.writes ? path.join('inboxes', ctx.session.inboxId, 'case-tool-idempotency', valueDigest([ctx.agent.id, ctx.session.workId, tool.name, args.idempotencyKey]) + '.json') : null;
          const { idempotencyKey: _key, ...canonical } = args;
          const digest = valueDigest(canonical), prior = keyPath ? await store.getJson(keyPath) : null;
          if (prior) {
            if (prior.digest !== digest) throw caseToolError('IDEMPOTENCY_CONFLICT');
            return success(tool.name, { ...prior.result, replayed: true });
          }
          if (tool.writes && ['completed', 'failed', 'expired'].includes(ctx.caseRecord.state)) throw caseToolError('CASE_CLOSED');
          const id = `msg_tool_${valueDigest([ctx.agent.id, ctx.session.workId, tool.name, args.idempotencyKey]).slice(0, 40)}`;
          const result = await methods[tool.name](ctx, args, id);
          if (tool.writes) {
            await store.putJson(keyPath, { digest, result, createdAt: store.now() });
            await ctx.writeAudit('agent.case_tool_used', { agentId: ctx.agent.id, caseId: ctx.session.caseId, workId: ctx.session.workId, tool: tool.name, idempotencyKeyHash: valueDigest(args.idempotencyKey) });
          }
          const response = success(tool.name, result);
          if (Buffer.byteLength(response.content[0].text) > 65536) throw new Error('Case tool result exceeds canonical limit');
          return response;
        });
      } catch (error) {
        const code = error.toolCode || (error.code === 'CURSOR_INVALID' ? error.code : null);
        if (code && caseToolsContract['x-tool-errors'][code]) return failure(tool.name, code);
        if (error.code === '55P03' || error.code === 'LOCK_TIMEOUT') return failure(tool.name, 'TOOL_BUSY');
        throw error;
      }
    }
  }]));
}
