import crypto from 'node:crypto';
import path from 'node:path';
import { assertSafeIdentifier } from './path-safety.js';

const prefix = 'envoi_inv1_';
const maxAgeMs = 24 * 60 * 60 * 1000;
const fields = ['id', 'issuerAgentId', 'issuerInboxId', 'recipientAgentId', 'recipientInboxId', 'issuedAt', 'expiresAt'];
const keyFor = material => crypto.hkdfSync('sha256', material, Buffer.alloc(0), Buffer.from('envoi-discovery-invitation-v1'), 32);
const signature = (encoded, material) => crypto.createHmac('sha256', keyFor(material)).update(encoded).digest('base64url');

export function discoveryInvitationPath(inboxId, id) {
  assertSafeIdentifier(inboxId, 'inboxId');
  assertSafeIdentifier(id, 'invitationId');
  return path.join('inboxes', inboxId, 'discovery-invitations', `${id}.json`);
}

function validPayload(value, nowMs) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some(field => !(field in value))) return false;
  try { for (const field of fields.slice(0, 5)) assertSafeIdentifier(value[field], field); } catch { return false; }
  const issued = Date.parse(value.issuedAt);
  const expires = Date.parse(value.expiresAt);
  return Number.isFinite(issued) && Number.isFinite(expires) && issued <= nowMs + 60_000 && expires > nowMs && expires > issued && expires - issued <= maxAgeMs;
}

export function signDiscoveryInvitation(payload, material) {
  if (!validPayload(payload, Date.parse(payload?.issuedAt))) throw new TypeError('Invalid discovery invitation');
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${prefix}${encoded}.${signature(encoded, material)}`;
}

export function verifyDiscoveryInvitation(token, material, now = new Date()) {
  if (typeof token !== 'string' || token.length > 2048 || !token.startsWith(prefix)) return null;
  const parts = token.slice(prefix.length).split('.');
  if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) return null;
  const expected = Buffer.from(signature(parts[0], material), 'base64url');
  const provided = Buffer.from(parts[1], 'base64url');
  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { return null; }
  return validPayload(payload, now.getTime()) ? payload : null;
}
