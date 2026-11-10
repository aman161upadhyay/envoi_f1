import crypto from 'node:crypto';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { unsafeNameCharacters } from './agent-registration-codes.js';

// agent-remote-auth v1 (revision 2): discovery, clients and the authorization request (task RA-A1).
// Envoi is both the authorization server and the resource server. Consent, the token endpoint and
// /mcp enforcement live elsewhere; this module only builds documents and checks requests, and writes
// nothing to storage.

export const remoteAuthLimits = Object.freeze({
  authorizationRequestTtlSeconds: 600,
  authorizationRequestHandleMaxLength: 2048,
  stateMaxLength: 512,
  clientMetadata: Object.freeze({ urlMaxLength: 2048, fetchTimeoutMs: 5000, maxBodyBytes: 5120, cacheSeconds: { min: 300, max: 86_400, noStore: 300 }, redirectUrisMax: 10 }),
  metadataCacheControl: 'public, max-age=300'
});

// x-scopes, in table order. envoi.agent is required in every request and grant.
export const remoteAuthScopes = Object.freeze([
  Object.freeze({ scope: 'envoi.agent', permission: 'receive_agent_messages' }),
  Object.freeze({ scope: 'envoi.send', permission: 'send_agent_messages' }),
  Object.freeze({ scope: 'envoi.files', permission: 'create_assets' }),
  Object.freeze({ scope: 'envoi.cases', permission: 'execute_cases' })
]);
export const defaultScope = 'envoi.agent envoi.send';
export const bootstrapGrantType = 'urn:envoi:params:oauth:grant-type:bootstrap_code';

// x-oauth-errors: fixed descriptions; never a token and never which check failed.
export const oauthErrorDescriptions = Object.freeze({
  invalid_request: 'The request is missing a parameter, repeats one, or has a malformed one.',
  invalid_client: 'Client authentication failed.',
  invalid_grant: 'The authorization grant is invalid, expired, already used or revoked.',
  unauthorized_client: 'This client may not use this grant or token.',
  unsupported_grant_type: 'The grant type is not supported.',
  unsupported_response_type: 'Only response_type=code is supported.',
  invalid_scope: 'The requested scope is invalid.',
  invalid_target: 'The resource must be this server\'s MCP endpoint.',
  access_denied: 'The owner denied the request.',
  temporarily_unavailable: 'Too many requests. Retry after the indicated delay.'
});

export const remoteAuthEnabled = flags => Boolean(flags.remoteMcpOAuth || flags.providerConnectors);
// x-endpoints `flags`: the bootstrap-code endpoint is served only by ENVOI_PROVIDER_CONNECTORS (§8); every other endpoint by
// either route flag. An endpoint no flag serves is 404 FEATURE_DISABLED (§1 "Flag off").
export const remoteAuthEndpointServed = (pathname, flags) => (pathname === '/api/oauth/bootstrap-codes' ? Boolean(flags.providerConnectors) : remoteAuthEnabled(flags));
const routeFlagOn = (flags, route) => (route === 'remote_mcp_oauth' ? Boolean(flags.remoteMcpOAuth) : route === 'provider_connector' ? Boolean(flags.providerConnectors) : false);

// §2: every URL is built from ENVOI_PUBLIC_URL's origin, never from the Host header.
export function remoteAuthOrigin(publicUrl) {
  try { return publicUrl ? new URL(publicUrl).origin : null; } catch { return null; }
}
export const resourceFor = origin => `${origin}/mcp`;

// §2.1. The path form and the root form return the identical body.
export function protectedResourceMetadata(origin) {
  return {
    resource: resourceFor(origin),
    authorization_servers: [origin],
    scopes_supported: remoteAuthScopes.map(entry => entry.scope),
    bearer_methods_supported: ['header'],
    resource_name: 'Envoi',
    resource_documentation: `${origin}/connect`
  };
}

// §2.2. No registration_endpoint (no DCR) and no jwks_uri (tokens are opaque).
export function authorizationServerMetadata(origin, flags) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token', ...(flags.providerConnectors ? [bootstrapGrantType] : [])],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_basic'],
    scopes_supported: remoteAuthScopes.map(entry => entry.scope),
    client_id_metadata_document_supported: Boolean(flags.remoteMcpOAuth),
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${origin}/connect`
  };
}

// §3.3, x-redirect-rules. Returns null for an acceptable redirect URI, otherwise a reason.
export function redirectUriRejection(value) {
  if (typeof value !== 'string' || !value || value.length > 2048) return 'invalid';
  let url;
  try { url = new URL(value); } catch { return 'invalid'; }
  if (url.username || url.password) return 'userinfo';
  if (value.includes('#')) return 'fragment';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol === 'https:') return net.isIP(host) ? 'address_literal' : host ? null : 'invalid';
  if (url.protocol === 'http:') return ['127.0.0.1', '::1'].includes(host) ? null : 'not_loopback';
  return 'scheme';
}
// The authority of an http loopback URI, with its port removed. Everything else is compared as typed.
const loopbackWithoutPort = value => {
  const match = /^http:\/\/(127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?=[/?]|$)/.exec(value);
  return match ? `http://${match[1]}${value.slice(match[0].length)}` : null;
};
// Exact string match, except that the port of an http loopback URI is ignored.
export function redirectMatches(registered, requested) {
  if (typeof requested !== 'string' || redirectUriRejection(requested)) return false;
  if (registered.includes(requested)) return true;
  const target = loopbackWithoutPort(requested);
  return target !== null && registered.some(entry => loopbackWithoutPort(entry) === target);
}

const validDisplayName = value => typeof value === 'string' && value.length >= 1 && value.length <= 80 && !unsafeNameCharacters.test(value) && value.trim() === value && value.trim().length > 0;
const httpsUrl = value => { try { return new URL(value).protocol === 'https:'; } catch { return false; } };

// §3.2: ENVOI_OAUTH_CLIENTS, a JSON array. Startup fails closed on an invalid entry.
export function parsePreRegisteredClients(raw) {
  const clients = new Map();
  if (raw === undefined || raw === '') return clients;
  let entries;
  try { entries = JSON.parse(raw); } catch { throw new Error('ENVOI_OAUTH_CLIENTS must be a JSON array'); }
  if (!Array.isArray(entries)) throw new Error('ENVOI_OAUTH_CLIENTS must be a JSON array');
  const fields = ['clientId', 'clientName', 'connectionRoute', 'redirectUris', 'tokenEndpointAuthMethod', 'clientSecretSha256', 'bootstrapCode', 'provider', 'wakeOrigins'];
  for (const [index, entry] of entries.entries()) {
    const fail = reason => { throw new Error(`ENVOI_OAUTH_CLIENTS[${index}]: ${reason}`); };
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('must be an object');
    if (Object.keys(entry).some(key => !fields.includes(key))) fail('has an unknown field');
    if (typeof entry.clientId !== 'string' || !/^client_[a-z0-9-]{3,40}$/.test(entry.clientId)) fail('clientId must be client_ plus 3-40 of [a-z0-9-]');
    if (clients.has(entry.clientId)) fail('clientId is duplicated');
    if (!validDisplayName(entry.clientName)) fail('clientName is not a safe display name');
    if (!['provider_connector', 'remote_mcp_oauth'].includes(entry.connectionRoute)) fail('connectionRoute must be provider_connector or remote_mcp_oauth');
    if (!Array.isArray(entry.redirectUris) || entry.redirectUris.length > remoteAuthLimits.clientMetadata.redirectUrisMax
      || new Set(entry.redirectUris).size !== entry.redirectUris.length || entry.redirectUris.some(uri => redirectUriRejection(uri))) fail('redirectUris are invalid');
    if (!['none', 'client_secret_basic'].includes(entry.tokenEndpointAuthMethod)) fail('tokenEndpointAuthMethod must be none or client_secret_basic');
    const secret = entry.tokenEndpointAuthMethod === 'client_secret_basic';
    if (secret !== (typeof entry.clientSecretSha256 === 'string')) fail('clientSecretSha256 is required exactly for client_secret_basic');
    if (secret && !/^[0-9a-f]{64}$/.test(entry.clientSecretSha256)) fail('clientSecretSha256 must be lowercase hex SHA-256');
    if (typeof entry.bootstrapCode !== 'boolean') fail('bootstrapCode must be a boolean');
    if (entry.bootstrapCode && (!secret || entry.connectionRoute !== 'provider_connector')) fail('bootstrapCode needs client_secret_basic and provider_connector');
    if (!entry.bootstrapCode && entry.redirectUris.length === 0) fail('redirectUris may be empty only for a bootstrap-only client');
    if (typeof entry.provider !== 'string' || entry.provider.length < 1 || entry.provider.length > 40 || unsafeNameCharacters.test(entry.provider)) fail('provider must be a short label');
    if (entry.wakeOrigins !== undefined) {
      if (entry.connectionRoute !== 'provider_connector' || !Array.isArray(entry.wakeOrigins) || entry.wakeOrigins.length > 3
        || new Set(entry.wakeOrigins).size !== entry.wakeOrigins.length || entry.wakeOrigins.some(origin => {
          if (typeof origin !== 'string') return true;
          try {
            const url = new URL(origin);
            return url.protocol !== 'https:' || url.origin !== origin || url.username || url.password || url.port
              || !url.hostname || net.isIP(url.hostname.replace(/^\[|\]$/g, '')) || url.hostname.includes('*');
          } catch { return true; }
        })) fail('wakeOrigins must be at most three unique exact HTTPS origins for a provider_connector');
    }
    clients.set(entry.clientId, Object.freeze({ ...entry, ...(entry.wakeOrigins ? { wakeOrigins: Object.freeze([...entry.wakeOrigins]) } : {}), redirectUris: Object.freeze([...entry.redirectUris]), registration: 'pre_registered' }));
  }
  return clients;
}

// §3.1, x-client-metadata-checks, in order. Rules that need no lookup; the http-wake destination
// module then applies its name and address rules (§4.1, §4.2 there).
export function clientIdUrlRejection(clientId, origin) {
  if (typeof clientId !== 'string' || clientId.length > remoteAuthLimits.clientMetadata.urlMaxLength) return 'url_too_long';
  let url;
  try { url = new URL(clientId); } catch { return 'url_invalid'; }
  if (url.protocol !== 'https:') return 'scheme_not_https';
  if (url.username || url.password) return 'userinfo_present';
  if (url.port && url.port !== '443') return 'port_not_allowed';
  if (!url.pathname || url.pathname === '/') return 'path_missing';
  if (clientId.includes('?')) return 'query_present';
  if (clientId.includes('#')) return 'fragment_present';
  if (origin && url.origin === origin) return 'self_origin';
  return null;
}

// agent-remote-auth-cimd v1: CIMD clients remain public. A modern list is
// authoritative for capability; the singular member is only a legacy preference.
function supportsPublicClientAuthentication(document) {
  const method = value => typeof value === 'string' && value.length >= 1 && value.length <= 128
    && !/[^\x21-\x7e]/.test(value);
  const preferencePresent = Object.hasOwn(document, 'token_endpoint_auth_method');
  if (preferencePresent && !method(document.token_endpoint_auth_method)) return false;
  if (!Object.hasOwn(document, 'token_endpoint_auth_methods_supported')) {
    return !preferencePresent || document.token_endpoint_auth_method === 'none';
  }
  const methods = document.token_endpoint_auth_methods_supported;
  return Array.isArray(methods) && methods.length >= 1 && methods.length <= 16
    && Array.from(methods).every(method) && new Set(methods).size === methods.length && methods.includes('none');
}

// §3.1: the document. Returns null when valid, otherwise the x-client-metadata-checks reason.
export function clientMetadataRejection(document, clientId) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return 'not_json';
  if (document.client_id !== clientId) return 'client_id_mismatch';
  if (!validDisplayName(document.client_name)) return 'client_name_invalid';
  const uris = document.redirect_uris;
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > remoteAuthLimits.clientMetadata.redirectUrisMax || uris.some(uri => redirectUriRejection(uri))) return 'redirect_uris_invalid';
  if (!supportsPublicClientAuthentication(document)) return 'auth_method_not_none';
  // Client capabilities may exceed the server's supported grants. This does not
  // enable those grants at /oauth/token; that endpoint's allowlist stays separate.
  const grants = document.grant_types;
  if (grants !== undefined && (!Array.isArray(grants) || grants.length < 1 || grants.length > 16
    || !grants.includes('authorization_code') || new Set(grants).size !== grants.length
    || !Array.from(grants).every(grant => typeof grant === 'string' && grant.length >= 1 && grant.length <= 256 && /^[!-~]+$/.test(grant)))) return 'grant_types_invalid';
  const responses = document.response_types;
  if (responses !== undefined && (!Array.isArray(responses) || responses.length !== 1 || responses[0] !== 'code')) return 'response_types_invalid';
  for (const field of ['client_uri', 'logo_uri']) if (document[field] !== undefined && !httpsUrl(document[field])) return 'not_json';
  return null;
}

// §3.1 caching: max-age clamped to 300-86,400 s; no-store and a missing max-age count as 300 s.
export function clientMetadataCacheSeconds(cacheControl) {
  const { min, max, noStore } = remoteAuthLimits.clientMetadata.cacheSeconds;
  const value = String(cacheControl || '').toLowerCase();
  if (/(?:^|,)\s*no-store\s*(?:,|$)/.test(value)) return noStore;
  const match = value.match(/(?:^|,)\s*max-age\s*=\s*(\d+)\s*(?:,|$)/);
  return match ? Math.min(max, Math.max(min, Number(match[1]))) : min;
}

// A pinned GET with the http-wake destination rules: resolved addresses only, no redirects, a 5 s
// deadline for the whole fetch and a 5,120-byte body limit. No cookies and no credentials are sent.
// The deadline starts before destination resolution, so slow DNS or self-address checks count
// towards it (§3.1 fetchTimeoutSeconds); a resolution that finishes after it is ignored.
export function createClientMetadataFetch({ destination, request = https.request, limits = remoteAuthLimits.clientMetadata } = {}) {
  return clientId => new Promise(resolve => {
    let done = false, req;
    const finish = result => { if (done) return; done = true; clearTimeout(timer); req?.destroy(); resolve(result); };
    const timer = setTimeout(() => finish({ rejection: 'fetch_failed' }), limits.fetchTimeoutMs);
    Promise.resolve().then(() => destination.resolve(clientId)).then(resolved => {
      if (done) return;
      const target = new URL(resolved.url);
      try {
        req = request(target, {
          method: 'GET', headers: { accept: 'application/json' }, agent: false, servername: target.hostname, ca: tls.rootCertificates, minVersion: 'TLSv1.2', rejectUnauthorized: true, autoSelectFamily: false,
          lookup: (_host, options, callback) => options?.all ? callback(null, resolved.addresses.map(address => ({ address, family: net.isIP(address) }))) : callback(null, resolved.addresses[0], net.isIP(resolved.addresses[0]))
        }, response => {
          if (response.statusCode !== 200) return finish({ rejection: 'fetch_failed' });
          if (!/^application\/json\s*(?:;|$)/i.test(String(response.headers['content-type'] || ''))) return finish({ rejection: 'not_json' });
          const chunks = [];
          let bytes = 0;
          response.on('data', chunk => {
            bytes += chunk.length;
            if (bytes > limits.maxBodyBytes) return finish({ rejection: 'body_too_large' });
            chunks.push(chunk);
          });
          response.on('end', () => {
            let document;
            try { document = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return finish({ rejection: 'not_json' }); }
            finish({ document, cacheControl: response.headers['cache-control'] });
          });
          response.on('error', () => finish({ rejection: 'fetch_failed' }));
        });
        req.on('error', () => finish({ rejection: 'fetch_failed' }));
        req.end();
      } catch { finish({ rejection: 'fetch_failed' }); }
    }, error => finish({ rejection: error?.reason === 'address_not_allowed' ? 'http_wake_address_rules' : 'http_wake_name_rules' }));
  });
}

// §3: resolves a client_id to a client, or to null for an unknown or invalid client. Metadata documents
// are cached per exact client_id; a failed fetch is never cached.
export function createClientResolver({ origin, flags, preRegistered = new Map(), fetchClientMetadata, now = () => Date.now(), cacheLimit = 1000, observe = record => console.warn(JSON.stringify(record)) }) {
  const cache = new Map();
  const fetchReasons = new Set(['fetch_failed', 'not_json', 'body_too_large', 'http_wake_address_rules', 'http_wake_name_rules']);
  const reject = (clientId, stage, reason) => {
    try { observe({ event: 'envoi.oauth_client_rejected', stage, reason,
      clientIdHash: typeof clientId === 'string' ? crypto.createHash('sha256').update(clientId).digest('hex') : null }); } catch { /* Diagnostics cannot alter authorization. */ }
    return null;
  };
  return async clientId => {
    if (typeof clientId !== 'string' || !clientId) return reject(clientId, 'client_id', 'client_id_invalid');
    if (/^client_/.test(clientId)) {
      const client = preRegistered.get(clientId);
      return client && routeFlagOn(flags, client.connectionRoute) ? client : reject(clientId, 'client_id', 'client_unavailable');
    }
    if (!flags.remoteMcpOAuth || clientIdUrlRejection(clientId, origin)) return reject(clientId, 'client_id', 'client_id_invalid');
    const cached = cache.get(clientId);
    if (cached && cached.expiresAt > now()) return cached.client;
    cache.delete(clientId);
    const fetched = await fetchClientMetadata(clientId);
    if (!fetched || fetched.rejection) return reject(clientId, 'fetch', fetchReasons.has(fetched?.rejection) ? fetched.rejection : 'fetch_failed');
    const rejection = clientMetadataRejection(fetched.document, clientId);
    if (rejection) return reject(clientId, 'metadata', rejection);
    const document = fetched.document;
    const client = Object.freeze({
      clientId, clientName: document.client_name, connectionRoute: 'remote_mcp_oauth', redirectUris: Object.freeze([...document.redirect_uris]),
      tokenEndpointAuthMethod: 'none', bootstrapCode: false, registration: 'metadata_document'
    });
    if (cache.size >= cacheLimit) cache.delete(cache.keys().next().value);
    cache.set(clientId, { client, expiresAt: now() + clientMetadataCacheSeconds(fetched.cacheControl) * 1000 });
    return client;
  };
}

// §4.2: the authorization request handle. Integrity-protected and encrypted under a key derived from
// ENVOI_DATA_ENCRYPTION_KEY, so it can be neither edited nor read, and it expires after 600 s. It is
// not a credential and nothing about it is stored.
const handleInfo = 'envoi-oauth-authorization-request-v1';
const handlePrefix = 'v1.';
export function createAuthorizationRequestSealer({ keyMaterial, now = () => Date.now(), ttlSeconds = remoteAuthLimits.authorizationRequestTtlSeconds }) {
  const key = Buffer.from(crypto.hkdfSync('sha256', keyMaterial, Buffer.alloc(0), Buffer.from(handleInfo), 32));
  return {
    seal(request) {
      const issuedAt = Math.floor(now() / 1000);
      const plaintext = zlib.deflateRawSync(Buffer.from(JSON.stringify({ ...request, iat: issuedAt, exp: issuedAt + ttlSeconds })));
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(handleInfo));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return `${handlePrefix}${Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64url')}`;
    },
    // null for a malformed, tampered or expired handle: callers answer every case identically. allowExpired reads an
    // expired handle's contents, for a handle this human already decided (agent-remote-auth §5.1 "Retention").
    open(handle, { allowExpired = false } = {}) {
      if (typeof handle !== 'string' || !handle.startsWith(handlePrefix) || handle.length > remoteAuthLimits.authorizationRequestHandleMaxLength) return null;
      const body = handle.slice(handlePrefix.length);
      if (!/^[A-Za-z0-9_-]+$/.test(body)) return null;
      const raw = Buffer.from(body, 'base64url');
      if (raw.length < 12 + 16 + 1) return null;
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
        decipher.setAAD(Buffer.from(handleInfo));
        decipher.setAuthTag(raw.subarray(raw.length - 16));
        const plaintext = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]);
        const request = JSON.parse(zlib.inflateRawSync(plaintext, { maxOutputLength: 16_384 }).toString('utf8'));
        return Number.isInteger(request.exp) && (allowExpired || request.exp * 1000 > now()) ? request : null;
      } catch { return null; }
    }
  };
}

const printableAscii = /^[\x20-\x7E]+$/;
// §4.1, x-authorize-checks. Returns one of:
// - { featureDisabled: true }               row 1 (the caller answers 404 FEATURE_DISABLED);
// - { location }                            a 302 to Envoi's own page, to the client with an error, or to consent.
// Nothing is written: an unauthenticated request cannot fill storage.
export function createAuthorizeRequestHandler({ origin, flags, resolveClient, sealer }) {
  const resource = resourceFor(origin);
  const envoiPage = error => ({ location: `${origin}/authorize-agent?error=${error}` });
  return async searchParams => {
    if (!remoteAuthEnabled(flags)) return { featureDisabled: true };
    const keys = [...searchParams.keys()];
    if (new Set(keys).size !== keys.length) return envoiPage('invalid_request');
    const get = name => searchParams.get(name);
    const client = await resolveClient(get('client_id'));
    if (!client) return envoiPage('invalid_client');
    const redirectUri = get('redirect_uri');
    if (!redirectMatches(client.redirectUris, redirectUri)) return envoiPage('invalid_redirect_uri');
    // From here every error goes to the checked redirect_uri (RFC 6749 §4.1.2.1, RFC 9207).
    const state = get('state');
    const stateValid = state === null || (state.length >= 1 && state.length <= remoteAuthLimits.stateMaxLength && printableAscii.test(state));
    const toClient = error => {
      const url = new URL(redirectUri);
      url.searchParams.append('error', error);
      url.searchParams.append('error_description', oauthErrorDescriptions[error]);
      if (state !== null && stateValid) url.searchParams.append('state', state);
      url.searchParams.append('iss', origin);
      return { location: url.href };
    };
    if (get('response_type') !== 'code') return toClient('unsupported_response_type');
    const challenge = get('code_challenge');
    if (!challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return toClient('invalid_request');
    if (get('code_challenge_method') !== 'S256') return toClient('invalid_request');
    if (get('resource') !== resource) return toClient('invalid_target');
    const scopeParam = get('scope');
    const requested = scopeParam === null ? defaultScope.split(' ') : scopeParam.split(' ');
    const known = remoteAuthScopes.map(entry => entry.scope);
    if (requested.some(scope => !known.includes(scope)) || new Set(requested).size !== requested.length || !requested.includes('envoi.agent')) return toClient('invalid_scope');
    if (!stateValid) return toClient('invalid_request');
    const handle = sealer.seal({
      clientId: client.clientId, connectionRoute: client.connectionRoute, redirectUri, codeChallenge: challenge,
      scopes: known.filter(scope => requested.includes(scope)), state, resource
    });
    // Check 11 (agent-remote-auth revision 3, kept in approved revision 4): measured on the encoded handle.
    // Refuse an oversized request rather than truncate a bound field or exceed the contracted length.
    if (handle.length > remoteAuthLimits.authorizationRequestHandleMaxLength) return toClient('invalid_request');
    return { location: `${origin}/authorize-agent?request=${handle}` };
  };
}

// agent-remote-auth §4.3: the permissions a scope set asks for, and the scope string for granted permissions, both in
// x-scopes order.
export const permissionsForScopes = scopes => remoteAuthScopes.filter(entry => scopes.includes(entry.scope)).map(entry => entry.permission);
export const scopeForPermissions = permissions => remoteAuthScopes.filter(entry => permissions.includes(entry.permission)).map(entry => entry.scope).join(' ');
// §4.3: an OAuth grant holds only permissions that have a scope (use_email_transport has none and cannot be granted).
export const oauthGrantablePermissions = permissions => permissions.filter(permission => remoteAuthScopes.some(entry => entry.permission === permission));

// agent-remote-auth §5.1: what the owner sees about the client. Never the handle's raw contents, and no logo or
// client_uri fetch.
export function consentClient(client, request) {
  const redirect = new URL(request.redirectUri);
  const loopbackRedirect = redirect.protocol === 'http:';
  const metadataDocument = !String(request.clientId).startsWith('client_');
  let clientIdHost = null;
  if (metadataDocument) { try { clientIdHost = new URL(request.clientId).hostname; } catch { clientIdHost = null; } }
  return {
    name: client?.clientName || clientIdHost || 'Unknown client',
    clientIdHost,
    redirectHost: loopbackRedirect ? redirect.host : redirect.hostname,
    loopbackRedirect,
    registration: metadataDocument ? 'metadata_document' : 'pre_registered',
    ...(metadataDocument ? {} : { provider: client?.provider || 'Unknown provider' })
  };
}

// The client redirect of an approval (code) or a denial (access_denied), with state and iss (RFC 9207).
export function consentRedirect(request, origin, params) {
  const url = new URL(request.redirectUri);
  for (const [key, value] of Object.entries(params)) url.searchParams.append(key, value);
  if (request.state !== null && request.state !== undefined) url.searchParams.append('state', request.state);
  url.searchParams.append('iss', origin);
  return url.href;
}
