import { nearAiScreen, checkIds } from '../frontend/guard-demo/adapters/nearai/screen.mjs';
import { valueDigest } from './policy-engine.js';

export function screeningTraceDetails({ outcome, receiptDigest, provider, checks }) {
  return { outcome, receiptDigest, ...(provider === 'near-ai-cloud' && Array.isArray(checks) && {
    attestation: { source: provider, checks: checkIds.map(id => ({
      id, passed: checks.some(check => check.id === id && check.status === 'passed')
    })) }
  }) };
}

export function createNativePrivateScreening({ enabled, apiKey, model } = {}) {
  if (!enabled) return null;
  const provider = nearAiScreen({ apiKey, model, checkTimeoutMs: 40_000 });
  return async (message, { allowRedaction = false } = {}) => {
    const simple = message.type === 'message' && message.intent === 'message'
      && !message.payload && !message.proposal && !message.unverifiedAuthorityClaim && !message.unverifiedSignatureClaim
      && !message.taskId && !message.correlationId && !message.causationId && !message.traceparent && !message.artifactRefs?.length
      && message.content?.length === 1 && message.content[0]?.type === 'text'
      && Object.keys(message.content[0]).length === 2 && message.content[0].text === message.text;
    // Review the whole normalized message for a structured send. This includes content that is
    // visible through protocol, case, or delivery projections but absent from the text field.
    const text = simple ? message.text : JSON.stringify({
      text: message.text, content: message.content, payload: message.payload, proposal: message.proposal,
      authorityClaim: message.unverifiedAuthorityClaim, signatureClaim: message.unverifiedSignatureClaim,
      taskId: message.taskId, correlationId: message.correlationId, causationId: message.causationId,
      traceparent: message.traceparent, artifactRefs: message.artifactRefs
    });
    let result;
    try {
      if (Buffer.byteLength(text, 'utf8') > 65_536) {
        throw screeningError(413, 'PRIVATE_SCREENING_INPUT_LIMIT', 'The message exceeds the private screening size limit.');
      }
      result = await provider.check({ text });
      if (result.held || !result.evidence || result.evidence.provider !== 'near-ai-cloud'
        || checkIds.some(id => result.checks?.find(check => check.id === id)?.status !== 'passed')
        || typeof result.flagged !== 'boolean'
        || (result.flagged && (typeof result.quote !== 'string' || !result.quote || !text.includes(result.quote)))) {
        throw new Error('Attestation failed');
      }
    } catch (error) {
      // Provider and verifier errors can contain excerpts. Keep them out of public failures.
      if (error.code === 'PRIVATE_SCREENING_INPUT_LIMIT') throw error;
      throw screeningError(503, 'PRIVATE_SCREENING_UNAVAILABLE', 'The message could not be privately verified.');
    }
    if (result.flagged && (!simple || !allowRedaction)) {
      throw screeningError(422, 'PRIVATE_SCREENING_BLOCKED', 'Private screening blocked this message.');
    }
    const summary = {
      provider: 'near-ai-cloud',
      outcome: result.flagged ? 'redacted' : 'clean',
      checks: checkIds.map(id => ({ id, status: 'passed' })),
      receiptDigest: valueDigest(result.evidence)
    };
    if (!result.flagged) return { message: { ...message, privateScreening: summary }, evidence: result.evidence };
    const marker = '[removed by private screening]';
    const redactedText = message.text.split(result.quote).join(marker.includes(result.quote) ? '' : marker);
    if (redactedText.includes(result.quote)) {
      throw screeningError(422, 'PRIVATE_SCREENING_BLOCKED', 'Private screening blocked this message.');
    }
    return {
      message: { ...message, text: redactedText, content: [{ type: 'text', text: redactedText }], privateScreening: summary },
      evidence: result.evidence
    };
  };
}

function screeningError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}
