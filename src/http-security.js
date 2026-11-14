import './envoi-environment-bootstrap.js';
import crypto from 'node:crypto';
import net from 'node:net';

function normalizedIp(value) {
  const candidate = String(value || '').split(',')[0].trim().replace(/^::ffff:/, '');
  return net.isIP(candidate) ? candidate : '';
}

export function clientIp(req, trustedProxy = process.env.ENVOI_TRUSTED_PROXY) {
  if (trustedProxy === 'cloudflare') {
    const forwarded = normalizedIp(req.headers?.['x-forwarded-for']);
    if (forwarded) return forwarded;
  }
  return normalizedIp(req.socket?.remoteAddress) || 'unknown';
}

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const PUBLIC_ERROR_FIELDS = ['retryAfterSeconds', 'caseId', 'reason'];

// Echo a client request ID only when it is a plain token; never reflect arbitrary text.
export function requestIdFrom(value) {
  const candidate = String(value || '');
  return REQUEST_ID.test(candidate) ? candidate : crypto.randomUUID();
}

// a3-pause-auth v1 envelope: clients branch on code; error repeats it for older readers.
export function errorBody(code, message, requestId = crypto.randomUUID(), fields = {}) {
  const extra = Object.fromEntries(PUBLIC_ERROR_FIELDS.filter(key => fields?.[key] !== undefined).map(key => [key, fields[key]]));
  return { code, error: code, message, requestId, ...extra };
}

export function publicHttpError(error, requestId = crypto.randomUUID()) {
  const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  if (status === 503 && error?.code === 'auth_unavailable') {
    return { status, body: errorBody('AUTH_UNAVAILABLE', 'Your session could not be checked right now. Please try again.', requestId) };
  }
  if (status === 503 && error?.code === 'NEAR_PAYMENT_CANCELLATION_UNAVAILABLE') {
    return { status, body: errorBody(error.code, 'NEAR payment cancellation could not be confirmed. Please try again.', requestId) };
  }
  if (status >= 500) return { status, body: errorBody('INTERNAL_SERVER_ERROR', 'An internal error occurred', requestId) };
  return { status, body: errorBody(error?.code || 'REQUEST_FAILED', String(error?.message || 'Request failed'), requestId, error?.publicFields) };
}
