// A2A v1.0.1 REST subset. These functions only validate and project canonical
// Envoi records; the HTTP edge must persist a native message and Case first.
const states = Object.freeze({
  new: 'TASK_STATE_SUBMITTED',
  classifying: 'TASK_STATE_WORKING',
  inProgress: 'TASK_STATE_WORKING',
  waitingForExternalParty: 'TASK_STATE_WORKING',
  waitingForHuman: 'TASK_STATE_INPUT_REQUIRED',
  tentativeHold: 'TASK_STATE_WORKING',
  authorized: 'TASK_STATE_WORKING',
  executing: 'TASK_STATE_WORKING',
  sent: 'TASK_STATE_WORKING',
  received: 'TASK_STATE_WORKING',
  accepted: 'TASK_STATE_WORKING',
  paused: 'TASK_STATE_INPUT_REQUIRED',
  completed: 'TASK_STATE_COMPLETED',
  failed: 'TASK_STATE_FAILED',
  unknownExternalResult: 'TASK_STATE_FAILED',
  expired: 'TASK_STATE_FAILED',
  revoked: 'TASK_STATE_CANCELED',
  disputed: 'TASK_STATE_INPUT_REQUIRED'
});

export function parseA2ATextMessage(input) {
  const message = input?.message;
  if (!message || message.role !== 'ROLE_USER' || typeof message.messageId !== 'string' || message.messageId.length < 1 || message.messageId.length > 200 || !Array.isArray(message.parts) || message.parts.length !== 1 || typeof message.parts[0]?.text !== 'string') {
    throw Object.assign(new Error('Only one user text part is supported'), { statusCode: 400 });
  }
  const text = message.parts[0].text.trim();
  if (!text || text.length > 100_000) throw Object.assign(new Error('Text must contain 1–100000 characters'), { statusCode: 400 });
  if (input.configuration?.returnImmediately !== true) throw Object.assign(new Error('This gateway requires returnImmediately=true'), { statusCode: 400 });
  if (message.contextId || message.taskId || input.configuration?.pushNotificationConfig) throw Object.assign(new Error('Continuations and push are not supported'), { statusCode: 400 });
  return { messageId: message.messageId, text };
}

export function projectA2ATask(caseRecord, { contextId = null, artifacts = [] } = {}) {
  if (!caseRecord?.schemaVersion || !caseRecord.id || !states[caseRecord.state]) throw new TypeError('A persisted Envoi Case is required');
  if (!Array.isArray(artifacts) || artifacts.some(asset => {
    if (!asset?.id) return true;
    try { const url = new URL(asset.authorizedUrl); return url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)); }
    catch { return true; }
  })) throw new TypeError('Artifacts require authorized HTTPS Asset URLs');
  return {
    id: caseRecord.id,
    contextId: contextId || caseRecord.id,
    status: { state: states[caseRecord.state], timestamp: caseRecord.updatedAt },
    artifacts: artifacts.map(asset => ({ artifactId: asset.id, name: asset.name || asset.id, parts: [{ url: asset.authorizedUrl }] }))
  };
}

export function a2aAgentCard({ name, description, url, version = '1.0.0' }) {
  let endpoint;
  try { endpoint = new URL(url); } catch { throw new TypeError('A2A card URL is invalid'); }
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(endpoint.hostname))) throw new TypeError('A2A card URL must be HTTPS');
  return {
    name, description, version,
    supportedInterfaces: [{ url, protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }],
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    securitySchemes: { envoiBearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
    securityRequirements: [{ schemes: { envoiBearer: { list: [] } } }],
    defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'],
    skills: [{ id: 'envoi-message', name: 'Envoi messaging', description: 'Send a text message as a canonical Envoi Case', tags: ['messaging'], inputModes: ['text/plain'], outputModes: ['text/plain'] }]
  };
}
