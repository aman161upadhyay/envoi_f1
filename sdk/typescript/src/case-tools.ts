import Ajv, { type AnySchema, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import schema from './case-tools-schema.json';
import { CaseSessionChannel } from './case-session';
import { EnvoiError } from './index';
import { retryDelay } from './lifecycle';

export type CaseToolName = 'envoi_case_snapshot' | 'envoi_case_reply' | 'envoi_case_propose' | 'envoi_case_decide'
  | 'envoi_authority_check' | 'envoi_request_human' | 'envoi_case_list_assets' | 'envoi_case_share_asset' | 'envoi_case_complete';
export type CaseParty = { kind: 'agent'; address: string } | { kind: 'human' };
type Keyed = { idempotencyKey: string };
type Terms = Record<string, unknown>;
export interface CaseToolInputs {
  envoi_case_snapshot: { eventLimit?: number; eventsBefore?: string };
  envoi_case_reply: Keyed & { text: string; intent?: 'message' | 'clarify' | 'status'; inReplyTo?: string };
  envoi_case_propose: Keyed & { text: string; terms: Terms };
  envoi_case_decide: Keyed & { proposalRef: string; text: string } & (
    { decision: 'accept'; optionRef: string; authorityRef: string; terms?: never }
    | { decision: 'counter'; terms: Terms; optionRef?: never; authorityRef?: never }
    | { decision: 'reject'; terms?: never; optionRef?: never; authorityRef?: never });
  envoi_authority_check: Keyed & (
    { action: 'accept_proposal'; proposalRef: string; optionRef: string; result?: never }
    | { action: 'complete_case'; result: string; proposalRef?: never; optionRef?: never });
  envoi_request_human: Keyed & { authorityRef: string; question: string };
  envoi_case_list_assets: { limit?: number; before?: string; assetRef?: never; includeContent?: never }
    | { assetRef: string; includeContent?: boolean; limit?: never; before?: never };
  envoi_case_share_asset: Keyed & { assetRef: string };
  envoi_case_complete: Keyed & { result: string; authorityRef?: string; evidenceRefs?: string[] };
}
export interface CaseSnapshotAsset {
  ref: string; filename: string; size: number; shared: boolean;
  mimeType: string; scan: 'pending' | 'clean' | 'blocked'; origin: 'you' | 'other_agent';
}
export interface CaseAsset extends CaseSnapshotAsset { checksumSha256: string }
export interface CaseSnapshot {
  notice: string;
  case: { objective: string; collaborationMode: string; status: string; deadline: string | null; createdAt: string; updatedAt: string };
  you: { address: string };
  counterparty: CaseParty;
  requestedResponse?: { ref: string; from: 'other_agent' | 'your_human'; kind: string; intent: string | null; text: string; truncated: boolean; receivedAt: string };
  recentEvents: Array<{ ref: string; kind: string; actor: string; at: string; intent: string | null; text: string | null; truncated: boolean; deliveryStatus: string | null }>;
  page: { hasOlder: boolean; olderCursor: string | null };
  proposal: null | { ref: string; kind: string; status: string; lastActor: string; options: Array<{ ref: string; value: unknown; truncated: boolean }>; expiresAt: string | null };
  authority: { pendingHumanDecision: boolean; lastPolicyDecision: null | { authorityRef: string; action: string; decision: string; humanApproval: string; optionRef: string | null; expiresAt: string } };
  allowedActions: CaseToolName[];
  assets: CaseSnapshotAsset[];
  assetsHasMore: boolean;
  limits: { resultMaxBytes: number; fixedSectionsMaxBytes: number; requestedTextMaxBytes: number; eventTextMaxBytes: number; optionValueMaxBytes: number };
}
type Replayed = { replayed: boolean };
type DeliveredTo = { recipient: CaseParty };
export interface CaseToolResults {
  envoi_case_snapshot: CaseSnapshot;
  envoi_case_reply: Replayed & DeliveredTo & { messageRef: string; status: 'queued' | 'delivered'; inReplyTo: string | null; createdAt: string };
  envoi_case_propose: Replayed & DeliveredTo & { messageRef: string; proposalRef: string; optionRef: string; status: 'queued' };
  envoi_case_decide: Replayed & DeliveredTo & { decision: 'accept' | 'counter' | 'reject'; messageRef: string; proposalRef: string; optionRef: string | null; proposalStatus: string; caseStatus: string };
  envoi_authority_check: Replayed & { action: 'accept_proposal' | 'complete_case'; authorityRef: string; decision: 'allow' | 'deny' | 'needsHuman'; humanApproval: 'not_required' | 'pending' | 'approved'; expiresAt: string; proposalRef: string | null; optionRef: string | null };
  envoi_request_human: Replayed & { requestRef: string; status: 'pending'; authorityRef: string; endTurn: true };
  envoi_case_list_assets: { assets: CaseAsset[]; hasMore: boolean; nextCursor: string | null }
    | { asset: CaseAsset; content: { encoding: 'utf-8'; text: string } | null; contentUnavailable: 'binary' | 'too_large' | null };
  envoi_case_share_asset: Replayed & DeliveredTo & { assetRef: string; alreadyShared: boolean };
  envoi_case_complete: Replayed & DeliveredTo & { receiptRef: string; messageRef: string; humanApproval: 'approved' | 'not_required'; caseStatus: 'completed'; evidenceRefs: string[] };
}

const ajv = new Ajv({ strict: false, allErrors: false });
addFormats(ajv);
const compile = (value: object): ValidateFunction => ajv.compile({ ...schema.schema, ...value } as AnySchema);
const outerResult = compile({ $ref: '#/definitions/mcpToolCallResult' });
const rpcError = compile({ $ref: '#/definitions/jsonRpcError' });
const toolError = compile({ $ref: '#/definitions/toolErrorEnvelope' });
const tools = new Map(schema.tools.map(tool => [tool.name, {
  input: compile(tool.inputSchema), result: compile({ $ref: `#/definitions/${tool.resultSchema}` }), writes: tool.writes
}]));
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const serializedBytes = (value: unknown) => bytes(JSON.stringify(value));
const invalidResponse = () => new EnvoiError('Case tool returned an invalid response', undefined, 'CASE_TOOL_RESPONSE_INVALID');
const assetMetadataWithinLimits = (asset: CaseSnapshotAsset) => serializedBytes(asset.filename) <= 255 && serializedBytes(asset.mimeType) <= 128;

function snapshotWithinLimits(snapshot: CaseSnapshot): boolean {
  return serializedBytes(snapshot) <= snapshot.limits.resultMaxBytes
    && serializedBytes({ ...snapshot, recentEvents: [] }) <= snapshot.limits.fixedSectionsMaxBytes
    && serializedBytes(snapshot.case.objective) <= 2000
    && (!snapshot.requestedResponse || serializedBytes(snapshot.requestedResponse.text) <= snapshot.limits.requestedTextMaxBytes)
    && snapshot.recentEvents.every(event => event.text === null || serializedBytes(event.text) <= snapshot.limits.eventTextMaxBytes)
    && (!snapshot.proposal || snapshot.proposal.options.every(option => serializedBytes(option.value) <= snapshot.limits.optionValueMaxBytes))
    && snapshot.assets.every(assetMetadataWithinLimits);
}

function freeze<Value>(value: Value): Readonly<Value> {
  if (object(value) || Array.isArray(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export class CaseToolError extends EnvoiError {
  constructor(code: string, readonly retryable: boolean) {
    super('Case tool refused the operation', undefined, code);
  }
}

function waitForToolRetry(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export class CaseToolsClient {
  #channel: CaseSessionChannel;
  #sequence = 0;
  #initialized = false;
  #endRequired = false;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(channel: CaseSessionChannel) { this.#channel = channel; }

  get signal(): AbortSignal { return this.#channel.signal; }
  get endTurnRequired(): boolean { return this.#endRequired; }
  toJSON() { return { state: this.signal.aborted ? 'ended' : this.#endRequired ? 'awaiting_human' : 'scoped' }; }

  call<Name extends CaseToolName>(name: Name, input: CaseToolInputs[Name]): Promise<Readonly<CaseToolResults[Name]>> {
    const validation = tools.get(name);
    if (!validation || !validation.input(input)) return Promise.reject(new EnvoiError('Invalid case tool arguments', undefined, 'TOOL_ARGUMENTS_INVALID'));
    let saved: CaseToolInputs[Name];
    try { saved = JSON.parse(JSON.stringify(input)) as CaseToolInputs[Name]; }
    catch { return Promise.reject(new EnvoiError('Invalid case tool arguments', undefined, 'TOOL_ARGUMENTS_INVALID')); }
    if (!validation.input(saved)) return Promise.reject(new EnvoiError('Invalid case tool arguments', undefined, 'TOOL_ARGUMENTS_INVALID'));
    if ('terms' in saved && bytes(JSON.stringify(saved.terms)) > 1024) return Promise.reject(new EnvoiError('Case terms exceed the byte limit', undefined, 'TOOL_ARGUMENTS_INVALID'));
    const run = this.#tail.then(async () => {
      this.signal.throwIfAborted();
      if (this.#endRequired) throw new EnvoiError('End this turn and wait for the human decision', undefined, 'TURN_END_REQUIRED');
      if (!this.#initialized && (name !== 'envoi_case_snapshot' || Object.hasOwn(saved, 'eventsBefore'))) await this.#perform('envoi_case_snapshot', {});
      return this.#perform(name, saved);
    });
    this.#tail = run.catch(() => {});
    return run;
  }

  snapshot(input: CaseToolInputs['envoi_case_snapshot'] = {}) { return this.call('envoi_case_snapshot', input); }
  reply(input: CaseToolInputs['envoi_case_reply']) { return this.call('envoi_case_reply', input); }
  propose(input: CaseToolInputs['envoi_case_propose']) { return this.call('envoi_case_propose', input); }
  decide(input: CaseToolInputs['envoi_case_decide']) { return this.call('envoi_case_decide', input); }
  checkAuthority(input: CaseToolInputs['envoi_authority_check']) { return this.call('envoi_authority_check', input); }
  requestHuman(input: CaseToolInputs['envoi_request_human']) { return this.call('envoi_request_human', input); }
  listAssets(input: CaseToolInputs['envoi_case_list_assets'] = {}) { return this.call('envoi_case_list_assets', input); }
  shareAsset(input: CaseToolInputs['envoi_case_share_asset']) { return this.call('envoi_case_share_asset', input); }
  complete(input: CaseToolInputs['envoi_case_complete']) { return this.call('envoi_case_complete', input); }

  async #perform<Name extends CaseToolName>(name: Name, input: CaseToolInputs[Name]): Promise<Readonly<CaseToolResults[Name]>> {
    const id = ++this.#sequence;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: input } });
    let failures = 0;
    while (true) {
      try { return await this.#request(name, input, id, body); }
      catch (error) {
        if (!(error instanceof CaseToolError && error.code === 'TOOL_BUSY' && error.retryable) || ++failures > 3) throw error;
        await waitForToolRetry(retryDelay(failures), this.signal);
      }
    }
  }

  async #request<Name extends CaseToolName>(name: Name, input: CaseToolInputs[Name], id: number, body: string): Promise<Readonly<CaseToolResults[Name]>> {
    this.signal.throwIfAborted();
    const context = this.#channel.modelContext();
    if (!context.allowedTools.includes(name)) throw new EnvoiError('Tool is not in this case session', undefined, 'TOOL_NOT_IN_SESSION');
    const response = await this.#channel.forward(body);
    this.signal.throwIfAborted();
    let payload: unknown;
    try { payload = await response.json(); } catch { throw invalidResponse(); }
    if (rpcError(payload) && object(payload) && payload.id === id) {
      const error = payload.error as { data: { code: string } };
      throw new EnvoiError('Case tool request was refused', undefined, error.data.code);
    }
    if (!outerResult(payload) || !object(payload) || payload.id !== id || !object(payload.result)) throw invalidResponse();
    const result = payload.result;
    const content = result.content as Array<{ type: string; text: string }>;
    if (content.length !== 1 || content[0].type !== 'text' || bytes(content[0].text) > 65536) throw invalidResponse();
    let envelope: unknown;
    try { envelope = JSON.parse(content[0].text); } catch { throw invalidResponse(); }
    if (!object(envelope) || envelope.tool !== name || typeof envelope.ok !== 'boolean' || envelope.ok === result.isError) throw invalidResponse();
    if (!envelope.ok) {
      if (!toolError(envelope) || envelope.retryable !== (envelope.code === 'TOOL_BUSY')) throw invalidResponse();
      throw new CaseToolError(String(envelope.code), envelope.retryable === true);
    }
    if (Object.keys(envelope).sort().join(',') !== 'ok,result,tool' || !tools.get(name)!.result(envelope.result)) throw invalidResponse();
    const value = envelope.result as CaseToolResults[Name];
    if (name === 'envoi_case_snapshot') {
      const snapshot = value as CaseSnapshot;
      if (snapshot.you.address !== context.agentAddress || snapshot.counterparty.kind !== context.counterpartyKind
        || snapshot.counterparty.kind === 'agent' && snapshot.counterparty.address !== context.counterpartyAddress
        || snapshot.allowedActions.some(tool => !context.allowedTools.includes(tool))
        || Object.hasOwn(snapshot, 'requestedResponse') === Object.hasOwn(input, 'eventsBefore')
        || !snapshotWithinLimits(snapshot)) throw invalidResponse();
      if (!Object.hasOwn(input, 'eventsBefore')) this.#initialized = true;
    } else if (object(value) && 'recipient' in value) {
      const recipient = value.recipient;
      if (!object(recipient) || recipient.kind !== context.counterpartyKind || recipient.kind === 'agent' && recipient.address !== context.counterpartyAddress) throw invalidResponse();
    }
    if (name === 'envoi_authority_check') {
      const request = input as CaseToolInputs['envoi_authority_check'];
      const result = value as CaseToolResults['envoi_authority_check'];
      if (result.action !== request.action || result.proposalRef !== (request.proposalRef ?? null)
        || result.optionRef !== (request.optionRef ?? null)) throw invalidResponse();
    }
    if (name === 'envoi_case_list_assets') await this.#checkAsset(value as CaseToolResults['envoi_case_list_assets'], input as CaseToolInputs['envoi_case_list_assets']);
    this.signal.throwIfAborted();
    if (name === 'envoi_request_human') this.#endRequired = true;
    return freeze(value);
  }

  async #checkAsset(value: CaseToolResults['envoi_case_list_assets'], input: CaseToolInputs['envoi_case_list_assets']) {
    if (Object.hasOwn(input, 'assetRef') !== Object.hasOwn(value, 'asset')) throw invalidResponse();
    if (!('asset' in value)) {
      if (value.assets.length > (input.limit ?? 20) || !value.assets.every(assetMetadataWithinLimits)) throw invalidResponse();
      return;
    }
    if (value.asset.ref !== input.assetRef || !assetMetadataWithinLimits(value.asset)) throw invalidResponse();
    const includeContent = input.includeContent === true;
    const inline = ['text/plain', 'text/csv', 'text/markdown', 'application/json'].includes(value.asset.mimeType) && value.asset.size <= 32768;
    if (includeContent && value.asset.scan !== 'clean' || includeContent && inline && !value.content
      || !includeContent && (value.content || value.contentUnavailable !== null)) throw invalidResponse();
    if (!value.content) {
      if (includeContent && value.contentUnavailable !== (inline ? null : ['text/plain', 'text/csv', 'text/markdown', 'application/json'].includes(value.asset.mimeType) ? 'too_large' : 'binary')) throw invalidResponse();
      return;
    }
    if (value.asset.scan !== 'clean' || !['text/plain', 'text/csv', 'text/markdown', 'application/json'].includes(value.asset.mimeType)
      || bytes(value.content.text) > 32768 || bytes(value.content.text) !== value.asset.size || value.contentUnavailable !== null) throw invalidResponse();
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value.content.text));
    const checksum = btoa(Array.from(new Uint8Array(digest), byte => String.fromCharCode(byte)).join(''));
    if (checksum !== value.asset.checksumSha256) throw invalidResponse();
  }
}
