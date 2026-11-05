import './envoi-environment-bootstrap.js';
import crypto from 'node:crypto';
import path from 'node:path';
import { WorkOS } from '@workos-inc/node';

// Authorization must follow current provider membership, including demotions.
// Sealed-session role/permission claims can outlive a membership change.
export const providerMembershipCanManage = membership => membership?.status === 'active'
  && ['owner', 'admin'].includes(String(membership.role?.slug || '').toLowerCase());

export const membershipCanManage = (membership, provider = 'local') => membership?.status === 'active'
  && ['owner', 'admin'].includes(String(membership.role || '').toLowerCase())
  && (provider !== 'workos' || providerMembershipCanManage(membership.providerMembership));

const flowMinutes = Number(process.env.ENVOI_AUTH_FLOW_MINUTES || 10);
const sessionCookie = process.env.WORKOS_COOKIE_NAME || 'envoi_session';
const csrfCookie = process.env.ENVOI_CSRF_COOKIE_NAME || 'envoi_csrf';
// envoi-browser-names v1 §1.3: the pre-cutover names. The server only ever clears these; it never
// reads their values. Removed in N3, once no browser can still hold one.
export const retiredCookieNames = Object.freeze(['sinaloa_session', 'sinaloa_csrf', 'sinaloa_workos_flow']);
const requestHuman = Symbol('workos-request-human');
const requestSession = Symbol('workos-request-session');
const requestResponse = Symbol('workos-request-response');
const requestCookie = Symbol('workos-request-cookie');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const tokenClaims = accessToken => {
  try {
    const claims = JSON.parse(Buffer.from(String(accessToken).split('.')[1], 'base64url').toString());
    return { sessionId: typeof claims.sid === 'string' ? claims.sid : null, issuedAt: Number(claims.iat) * 1000, expiresAt: Number(claims.exp) * 1000 };
  } catch { return {}; }
};
const unavailable = () => Object.assign(new Error('Authentication is temporarily unavailable. Please try again.'), { statusCode: 503, code: 'auth_unavailable' });
export const safeReturnPath = value => {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return '/';
  try {
    let decoded = value;
    for (let index = 0; index < 2; index += 1) decoded = decodeURIComponent(decoded);
    if (!decoded.startsWith('/') || decoded.startsWith('//') || decoded.includes('\\')) return '/';
    const origin = 'https://envoi.invalid';
    const resolved = new URL(value, origin);
    return resolved.origin === origin ? `${resolved.pathname}${resolved.search}${resolved.hash}` : '/';
  } catch {
    return '/';
  }
};
const publicHuman = human => ({
  id: human.id,
  displayName: human.displayName,
  email: human.email,
  emailVerified: human.emailVerified,
  authProvider: human.authProvider,
  verifiedAt: human.verifiedAt,
  createdAt: human.createdAt
});

export function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(value => value.trim()).filter(Boolean).flatMap(value => {
    const separator = value.indexOf('=');
    if (separator < 0) return [[value, '']];
    try {
      return [[value.slice(0, separator), decodeURIComponent(value.slice(separator + 1))]];
    } catch {
      return [];
    }
  }));
}

const secureCookies = () => process.env.ENVOI_AUTH_MODE === 'production' || process.env.ENVOI_COOKIE_SECURE === 'true';
const sessionSameSite = () => {
  const configured = process.env.ENVOI_COOKIE_SAMESITE || 'Lax';
  return ['Lax', 'Strict', 'None'].includes(configured) ? configured : 'Lax';
};
const cookieDomain = () => (process.env.WORKOS_COOKIE_DOMAIN && /^[a-z0-9.-]+$/i.test(process.env.WORKOS_COOKIE_DOMAIN) ? process.env.WORKOS_COOKIE_DOMAIN : null);
const sessionMaxAge = () => Number(process.env.ENVOI_SESSION_HOURS || 24) * 3600;
// One place for each cookie's attributes, so a retired name is cleared exactly as it was set.
function cookieHeader(name, value, { path, httpOnly, sameSite, domain = null, maxAge }) {
  const attributes = [`${name}=${value}`, `Path=${path}`, ...(httpOnly ? ['HttpOnly'] : []), `SameSite=${sameSite}`];
  if (secureCookies()) attributes.push('Secure');
  if (domain) attributes.push(`Domain=${domain}`);
  attributes.push(`Max-Age=${maxAge}`);
  return attributes.join('; ');
}
const sessionAttributes = { path: '/', httpOnly: true };
const csrfAttributes = { path: '/', httpOnly: false, sameSite: 'Strict' };
const flowAttributes = { path: '/api/auth/workos', httpOnly: true, sameSite: 'Lax' };

// envoi-browser-names v1 §1.1: an override must not name a retired cookie (the clears would delete
// the live session) and the session and CSRF cookies must differ. Checked at startup in every mode.
export function assertBrowserCookieNames(names = { session: sessionCookie, csrf: csrfCookie }) {
  for (const [kind, name] of Object.entries(names)) {
    if (retiredCookieNames.includes(name)) throw new Error(`The ${kind} cookie name ${name} is retired; remove the override to use the Envoi name`);
  }
  if (names.session === names.csrf) throw new Error('The session and CSRF cookie names must differ');
}

export function authFlowCookieName() { return 'envoi_workos_flow'; }
export function authFlowCookieHeader(browserBinding, { clear = false } = {}) {
  return cookieHeader(authFlowCookieName(), clear ? '' : encodeURIComponent(browserBinding), { ...flowAttributes, maxAge: clear ? 0 : flowMinutes * 60 });
}
export function sessionCookieName() { return sessionCookie; }
export function csrfCookieName() { return csrfCookie; }
export function sessionCookieHeader(value, { clear = false } = {}) {
  return cookieHeader(sessionCookie, clear ? '' : encodeURIComponent(value), { ...sessionAttributes, sameSite: sessionSameSite(), domain: cookieDomain(), maxAge: clear ? 0 : sessionMaxAge() });
}

// envoi-browser-names v1 §1.3: Max-Age=0 for retired names, with each cookie's own Path. A Domain
// cookie and a host-only cookie are separate, so the session name is cleared in both forms.
export function retiredCookieClears(names = retiredCookieNames) {
  const clears = [];
  for (const name of names) {
    if (name === 'sinaloa_session') {
      clears.push(cookieHeader(name, '', { ...sessionAttributes, sameSite: sessionSameSite(), maxAge: 0 }));
      if (cookieDomain()) clears.push(cookieHeader(name, '', { ...sessionAttributes, sameSite: sessionSameSite(), domain: cookieDomain(), maxAge: 0 }));
    } else if (name === 'sinaloa_csrf') clears.push(cookieHeader(name, '', { ...csrfAttributes, maxAge: 0 }));
    else if (name === 'sinaloa_workos_flow') clears.push(cookieHeader(name, '', { ...flowAttributes, maxAge: 0 }));
  }
  return clears;
}
// The retired names a request carried; names only, never values.
export const retiredCookiesIn = cookieHeaderValue => retiredCookieNames.filter(name => Object.hasOwn(parseCookies(cookieHeaderValue), name));

export function createCsrfToken() { return crypto.randomBytes(32).toString('base64url'); }

export function csrfCookieHeader(value, { clear = false } = {}) {
  return cookieHeader(csrfCookie, clear ? '' : encodeURIComponent(value), { ...csrfAttributes, maxAge: clear ? 0 : sessionMaxAge() });
}

export function verifyCsrfRequest(req) {
  const cookieToken = parseCookies(req.headers.cookie)[csrfCookie];
  // envoi-browser-names v1 §2: only the Envoi header counts.
  const headerToken = String(req.headers['x-envoi-csrf'] || '');
  if (!cookieToken || !headerToken) return false;
  const cookieBytes = Buffer.from(cookieToken);
  const headerBytes = Buffer.from(headerToken);
  if (cookieBytes.length !== headerBytes.length || !crypto.timingSafeEqual(cookieBytes, headerBytes)) return false;
  try {
    const expectedOrigin = process.env.ENVOI_PUBLIC_URL
      ? new URL(process.env.ENVOI_PUBLIC_URL).origin
      : process.env.ENVOI_AUTH_MODE !== 'production' && req.headers.host
        ? `http://${req.headers.host}`
        : null;
    if (!expectedOrigin) return false;
    return String(req.headers.origin || '') === expectedOrigin;
  } catch {
    return false;
  }
}

export class WorkOSAuthService {
  constructor(store, options = {}) {
    this.store = store;
    this.provider = 'workos';
    this.clientId = options.clientId || process.env.WORKOS_CLIENT_ID;
    this.apiKey = options.apiKey || process.env.WORKOS_API_KEY;
    this.cookiePassword = options.cookiePassword || process.env.WORKOS_COOKIE_PASSWORD;
    this.redirectUri = options.redirectUri || process.env.WORKOS_REDIRECT_URI;
    this.issuer = options.issuer || process.env.WORKOS_ISSUER || (this.clientId ? `https://api.workos.com/user_management/${this.clientId}` : undefined);
    if (!this.clientId || !this.apiKey || !this.cookiePassword || !this.redirectUri) {
      throw new Error('WorkOS auth requires WORKOS_CLIENT_ID, WORKOS_API_KEY, WORKOS_COOKIE_PASSWORD, and WORKOS_REDIRECT_URI');
    }
    if (this.cookiePassword.length < 32) throw new Error('WORKOS_COOKIE_PASSWORD must be at least 32 characters');
    this.workos = options.workos || new WorkOS(this.apiKey, { clientId: this.clientId, issuer: this.issuer });
    this.invitedEmails = new Set(String(options.invitedEmails ?? process.env.ENVOI_BETA_INVITED_EMAILS ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean));
    this.signupMode = options.signupMode ?? process.env.ENVOI_HUMAN_SIGNUP_MODE ?? 'invite-only';
    if (!['invite-only', 'public'].includes(this.signupMode)) throw new Error('ENVOI_HUMAN_SIGNUP_MODE must be invite-only or public');
    this.publicSignupLimit = Number(options.publicSignupLimit ?? process.env.ENVOI_PUBLIC_SIGNUP_LIMIT ?? 0);
    if (this.signupMode === 'public' && (!Number.isSafeInteger(this.publicSignupLimit) || this.publicSignupLimit < 1 || this.publicSignupLimit > 100)) {
      throw new Error('ENVOI_PUBLIC_SIGNUP_LIMIT must be an integer from 1 to 100 in public signup mode');
    }
    this.now = options.now || Date.now;
    this.sessionHours = Number(options.sessionHours ?? process.env.ENVOI_SESSION_HOURS ?? 24);
    if (!Number.isFinite(this.sessionHours) || this.sessionHours <= 0) throw new Error('Session duration must be positive');
  }

  config() {
    return { provider: 'workos', hosted: true, inviteOnly: this.signupMode !== 'public', signInPath: '/api/auth/workos/sign-in', signUpPath: '/api/auth/workos/sign-up', csrfCookieName: csrfCookie, assurance: 'provider' };
  }

  admitted(user) {
    const email = String(user?.email || '').trim().toLowerCase();
    return Boolean(user?.emailVerified && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      && (this.signupMode === 'public' || this.invitedEmails.has(email)));
  }

  // A verified identity must also hold a committed public admission before an
  // existing session or background approval can continue. Only the callback's
  // transaction allocates a new public slot; this read never changes identity.
  async hasCurrentAdmission(user, providerUserId = user?.id) {
    if (!this.admitted(user)) return false;
    const email = String(user.email || '').trim().toLowerCase();
    if (this.signupMode !== 'public' || this.invitedEmails.has(email)) return true;
    if (typeof providerUserId !== 'string' || !providerUserId) return false;
    const admission = await this.store.getJson(path.join('auth', 'workos-public-admissions.json'));
    return Array.isArray(admission?.userIds) && admission.userIds.includes(providerUserId);
  }

  async startAuthorization({ screenHint = 'sign-in', returnTo = '/', forceFresh = false } = {}) {
    const result = await this.workos.userManagement.getAuthorizationUrlWithPKCE({
      clientId: this.clientId,
      provider: 'authkit',
      redirectUri: this.redirectUri,
      screenHint,
      ...(forceFresh ? { maxAge: 0 } : {})
    });
    const browserBinding = crypto.randomBytes(32).toString('base64url');
    const flow = {
      browserBindingHash: hash(browserBinding),
      stateHash: hash(result.state),
      codeVerifier: result.codeVerifier,
      returnTo: safeReturnPath(returnTo),
      forceFresh,
      createdAt: this.store.now(),
      expiresAt: new Date(Date.now() + flowMinutes * 60_000).toISOString(),
      usedAt: null
    };
    await this.store.putJson(path.join('auth', 'workos-flows', `${flow.stateHash}.json`), flow);
    return { url: result.url, browserBinding };
  }

  async completeAuthorization({ code, state, browserBinding, ipAddress, userAgent }) {
    if (!code || !state) throw Object.assign(new Error('Authorization code and state are required'), { statusCode: 400 });
    const relative = path.join('auth', 'workos-flows', `${hash(state)}.json`);
    const pending = await this.store.getJson(relative);
    const bindingMatches = typeof browserBinding === 'string' && /^[A-Za-z0-9_-]{43}$/.test(browserBinding)
      && typeof pending?.browserBindingHash === 'string' && /^[a-f0-9]{64}$/.test(pending.browserBindingHash)
      && crypto.timingSafeEqual(Buffer.from(hash(browserBinding), 'hex'), Buffer.from(pending.browserBindingHash, 'hex'));
    if (!bindingMatches) throw Object.assign(new Error('Authentication flow does not match this browser'), { statusCode: 401, code: 'AUTH_FLOW_INVALID' });
    const flow = pending && !pending.usedAt && new Date(pending.expiresAt) > new Date()
      ? await this.store.claimJson(relative, 'usedAt', this.store.now())
      : null;
    if (!flow) throw Object.assign(new Error('Authentication flow is invalid, expired, or already used'), { statusCode: 401, code: 'AUTH_FLOW_INVALID' });
    const authentication = await this.workos.userManagement.authenticateWithCode({
      clientId: this.clientId,
      code,
      codeVerifier: flow.codeVerifier,
      ipAddress,
      userAgent,
      session: { sealSession: true, cookiePassword: this.cookiePassword }
    });
    if (!authentication.sealedSession) throw Object.assign(new Error('Authentication provider did not return a sealed session'), { statusCode: 502 });
    if (!this.admitted(authentication.user)) throw Object.assign(new Error('Verified WorkOS account required by the current signup policy'), { statusCode: 403 });
    let verified;
    try {
      verified = await this.workos.userManagement.loadSealedSession({ sessionData: authentication.sealedSession, cookiePassword: this.cookiePassword }).authenticate();
    } catch { throw unavailable(); }
    if (!verified.authenticated || !verified.sessionId || verified.user?.id !== authentication.user.id || !this.admitted(verified.user)) {
      return { reauthenticate: true, forceFresh: flow.forceFresh, returnTo: flow.returnTo };
    }
    const recorded = await this.recordSession({ ...verified, accessToken: authentication.accessToken }, this.now());
    if (!recorded || !await this.isSessionActive(recorded)) {
      try { await this.workos.userManagement.revokeSession?.({ sessionId: verified.sessionId }); }
      catch {}
      return { reauthenticate: true, forceFresh: flow.forceFresh, returnTo: flow.returnTo };
    }
    let human;
    try { human = await this.upsertHuman(verified.user); }
    catch (error) {
      await this.store.withTransaction([this.sessionKey(verified.sessionId)], async () => {
        const relative = this.sessionPath(verified.sessionId);
        const existing = await this.store.getJson(relative);
        if (existing) await this.store.putJson(relative, { ...existing, revokedAt: new Date(this.now()).toISOString(), replays: [] });
      });
      try { await this.workos.userManagement.revokeSession?.({ sessionId: verified.sessionId }); }
      catch { /* Durable local revocation remains authoritative. */ }
      throw error;
    }
    return { human: publicHuman(human), sealedSession: authentication.sealedSession, returnTo: flow.returnTo };
  }

  async upsertHuman(user) {
    const indexPath = path.join('auth', 'workos-user-index', `${encodeURIComponent(user.id)}.json`);
    const publicAdmission = this.signupMode === 'public' && !this.invitedEmails.has(String(user.email || '').trim().toLowerCase());
    const admissionPath = path.join('auth', 'workos-public-admissions.json');
    return this.store.withTransaction([`auth:workos-user:${user.id}`, ...(publicAdmission ? ['auth:workos-public-admissions'] : [])], async () => {
      const index = await this.store.getJson(indexPath);
      const existing = index ? await this.store.getJson(path.join('humans', `${index.humanId}.json`)) : null;
      if (publicAdmission && !user.emailVerified) throw Object.assign(new Error('Verified WorkOS account required'), { statusCode: 403 });
      const admission = publicAdmission ? (await this.store.getJson(admissionPath) || { userIds: [] }) : null;
      if (admission && !admission.userIds.includes(user.id) && admission.userIds.length >= this.publicSignupLimit) {
        throw Object.assign(new Error('Public beta signup capacity has been reached'), { statusCode: 403, code: 'PUBLIC_SIGNUP_FULL' });
      }
      const now = this.store.now();
      const emailVerified = Boolean(user.emailVerified);
      const previouslyVerified = Boolean(existing?.emailVerified && existing?.verifiedAt);
      const human = {
        ...(existing || { id: this.store.id('human'), createdAt: now }),
        workosUserId: user.id,
        email: user.email,
        emailVerified: emailVerified || previouslyVerified,
        displayName: user.name || [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email,
        authProvider: 'workos',
        verifiedAt: emailVerified ? (existing?.verifiedAt || now) : (previouslyVerified ? existing.verifiedAt : null),
        updatedAt: now
      };
      await this.store.putJsonBatch([
        { path: path.join('humans', `${human.id}.json`), value: human },
        { path: indexPath, value: { humanId: human.id } },
        ...(admission && !admission.userIds.includes(user.id)
          ? [{ path: admissionPath, value: { userIds: [...admission.userIds, user.id] } }] : [])
      ]);
      return human;
    });
  }

  // Background activation has no browser-session projection. Resolve its owner
  // through the durable provider mapping before the existing fresh role check.
  async getStoredHumanForAuthorization(humanId) {
    const human = await this.store.getJson(path.join('humans', `${humanId}.json`));
    if (!human || human.id !== humanId || human.authProvider !== 'workos' || !await this.hasCurrentAdmission(human, human.workosUserId)
      || typeof human.workosUserId !== 'string' || !human.workosUserId) return null;
    const index = await this.store.getJson(path.join('auth', 'workos-user-index', `${encodeURIComponent(human.workosUserId)}.json`));
    if (index?.humanId !== human.id) return null;
    return { ...publicHuman(human), providerUserId: human.workosUserId };
  }

  bindResponse(req, res) {
    if (req[requestResponse]) return;
    req[requestResponse] = res;
    const writeHead = res.writeHead;
    res.writeHead = function (...args) {
      // Apply at the final header boundary so route-level cookie updates survive.
      const pending = req[requestCookie];
      if (pending && !this.headersSent) {
        const existing = this.getHeader('Set-Cookie');
        const cookies = existing ? (Array.isArray(existing) ? existing : [existing]) : [];
        const headerIndex = typeof args[1] === 'string' ? 2 : 1;
        const headers = args[headerIndex];
        if (Array.isArray(headers)) {
          const remaining = [];
          for (let index = 0; index < headers.length; index += 2) {
            if (String(headers[index]).toLowerCase() === 'set-cookie') {
              const values = headers[index + 1];
              cookies.push(...(Array.isArray(values) ? values : [values]));
            } else remaining.push(headers[index], headers[index + 1]);
          }
          args[headerIndex] = remaining;
        } else if (headers) {
          args[headerIndex] = { ...headers };
          for (const name of Object.keys(headers)) {
            if (name.toLowerCase() !== 'set-cookie') continue;
            const values = headers[name];
            cookies.push(...(Array.isArray(values) ? values : [values]));
            delete args[headerIndex][name];
          }
        }
        const clearing = /(?:^|;\s*)Max-Age=0(?:;|$)/.test(pending);
        // An explicit callback/logout session cookie takes precedence over
        // renewal; terminal failures still clear both authentication cookies.
        const explicitSession = cookies.some(value => String(value).startsWith(`${sessionCookie}=`));
        this.setHeader('Set-Cookie', !clearing && explicitSession ? cookies : [
          ...cookies.filter(value => !String(value).startsWith(`${sessionCookie}=`) && (!clearing || !String(value).startsWith(`${csrfCookie}=`))),
          pending,
          ...(clearing ? [csrfCookieHeader('', { clear: true })] : [])
        ]);
      }
      return writeHead.apply(this, args);
    };
  }

  queueSessionCookie(req, sealedSession = null) {
    req[requestCookie] = sessionCookieHeader(sealedSession || '', { clear: !sealedSession });
  }

  sessionPath(sessionId) { return path.join('auth', 'workos-sessions', `${hash(sessionId)}.json`); }
  sessionKey(sessionId) { return `workos-session:${hash(sessionId)}`; }

  async recordSession(session, issuedAt = null) {
    if (!session?.sessionId) return null;
    // A verified, unchanged access token needs no session write. The caller
    // checks the durable revocation record again before granting access.
    const claims = tokenClaims(session.accessToken || session.session?.accessToken);
    const current = await this.store.getJson(this.sessionPath(session.sessionId));
    const now = this.now();
    const tokenExpiry = Number.isFinite(claims.expiresAt) ? claims.expiresAt : current?.sessionExpiresAt;
    if (current && !current.revokedAt && current.sessionExpiresAt > now
      && current.accessExpiresAt > now && tokenExpiry <= current.accessExpiresAt) {
      return { ...session, expiresAt: new Date(Math.min(tokenExpiry, current.sessionExpiresAt)).toISOString() };
    }
    return this.store.withTransaction([this.sessionKey(session.sessionId)], async () => {
      const relative = this.sessionPath(session.sessionId);
      const existing = await this.store.getJson(relative);
      if (existing?.revokedAt) return null;
      const claims = tokenClaims(session.accessToken || session.session?.accessToken);
      const initial = existing?.issuedAt ?? issuedAt ?? (Number.isFinite(claims.issuedAt) ? claims.issuedAt : this.now());
      const maximum = existing?.sessionExpiresAt ?? initial + this.sessionHours * 3_600_000;
      if (maximum <= this.now()) return null;
      const tokenExpiry = Number.isFinite(claims.expiresAt) ? claims.expiresAt : maximum;
      const accessExpiresAt = Math.min(maximum, Math.max(existing?.accessExpiresAt || 0, tokenExpiry));
      const replays = (existing?.replays || []).filter(replay => replay.expiresAt > this.now());
      const record = { sessionId: session.sessionId, issuedAt: initial, sessionExpiresAt: maximum, accessExpiresAt, revokedAt: null, replays };
      await this.store.putJson(relative, record);
      return { ...session, expiresAt: new Date(Math.min(tokenExpiry, maximum)).toISOString() };
    });
  }

  async isSessionActive(session) {
    if (!session?.sessionId) return false;
    const record = await this.store.getJson(this.sessionPath(session.sessionId));
    return Boolean(record && !record.revokedAt && record.sessionExpiresAt > this.now() && record.accessExpiresAt > this.now());
  }

  async captureSessionLease(req) {
    const session = await this.getSession(req);
    return session ? { sessionId: session.sessionId, expiresAt: session.expiresAt } : null;
  }

  async validateSessionLease(lease) { return this.isSessionActive(lease); }

  async getProviderSession(req) {
    if (!req[requestSession]) Object.defineProperty(req, requestSession, { value: this.resolveProviderSession(req), enumerable: false });
    return req[requestSession];
  }

  async resolveProviderSession(req) {
    const sealedSession = parseCookies(req.headers.cookie)[sessionCookie];
    if (!sealedSession) return null;
    const provider = this.workos.userManagement;
    const session = provider.loadSealedSession({ sessionData: sealedSession, cookiePassword: this.cookiePassword });
    let result;
    try { result = await session.authenticate(); }
    catch { throw unavailable(); }
    if (result.authenticated) {
      const recorded = await this.recordSession({ ...result, sealedSession });
      if (!recorded || !await this.isSessionActive(recorded)) { this.queueSessionCookie(req); return null; }
      return recorded;
    }
    if (result.reason !== 'invalid_jwt') { this.queueSessionCookie(req); return null; }
    // Only inspect claims after the SDK has verified the encrypted cookie's seal.
    // These claims select the revocation record; they never authorize a request.
    let data;
    try { data = await provider.getSessionFromCookie({ sessionData: sealedSession, cookiePassword: this.cookiePassword }); }
    catch { this.queueSessionCookie(req); return null; }
    const claims = tokenClaims(data?.accessToken);
    if (!claims.sessionId || !data?.refreshToken) { this.queueSessionCookie(req); return null; }
    const refreshed = await this.store.withTransaction([this.sessionKey(claims.sessionId)], async () => {
      const relative = this.sessionPath(claims.sessionId);
      const lifecycle = await this.store.getJson(relative);
      const issuedAt = lifecycle?.issuedAt ?? (Number.isFinite(claims.issuedAt) ? claims.issuedAt : this.now());
      if (lifecycle?.revokedAt || (lifecycle?.sessionExpiresAt ?? issuedAt + this.sessionHours * 3_600_000) <= this.now()) return null;
      const cookieHash = hash(sealedSession);
      const replay = lifecycle?.replays?.find(value => value.cookieHash === cookieHash && value.expiresAt > this.now());
      let renewed;
      if (replay && replay.expiresAt > this.now()) {
        renewed = { authenticated: true, sealedSession: replay.sealedSession };
      } else {
        try { renewed = await session.refresh(); }
        catch { throw unavailable(); }
      }
      if (!renewed.authenticated) {
        if (renewed.retryable || ['rate_limit_exceeded', 'timeout', 'server_error', 'network_error'].includes(renewed.reason)) throw unavailable();
        await this.store.putJson(relative, { ...lifecycle, sessionId: claims.sessionId, revokedAt: new Date(this.now()).toISOString(), replays: [] });
        return null;
      }
      if (!renewed.sealedSession) throw unavailable();
      let verified;
      try { verified = await provider.loadSealedSession({ sessionData: renewed.sealedSession, cookiePassword: this.cookiePassword }).authenticate(); }
      catch { throw unavailable(); }
      if (!verified.authenticated || verified.sessionId !== claims.sessionId) throw unavailable();
      const recorded = await this.recordSession({ ...verified, sealedSession: renewed.sealedSession }, issuedAt);
      if (!recorded) return null;
      // WorkOS rotation permits a short replay window. Share the sealed replacement
      // across instances so concurrent requests do not rotate the token repeatedly.
      if (!replay || replay.expiresAt <= this.now()) {
        const current = await this.store.getJson(relative);
        const replays = [...current.replays, { cookieHash, sealedSession: renewed.sealedSession, expiresAt: this.now() + 30_000 }].slice(-4);
        await this.store.putJson(relative, { ...current, replays });
      }
      return recorded;
    });
    if (!refreshed || !await this.isSessionActive(refreshed)) { this.queueSessionCookie(req); return null; }
    this.queueSessionCookie(req, refreshed.sealedSession);
    return refreshed;
  }

  async getSession(req) {
    const session = await this.getProviderSession(req);
    if (!session) return null;
    if (!await this.hasCurrentAdmission(session.user) || !await this.isSessionActive(session)) {
      this.queueSessionCookie(req);
      return null;
    }
    return { ...session, assurance: 'provider' };
  }

  async getHuman(req) {
    if (req[requestHuman]) return req[requestHuman];
    const pending = (async () => {
      const session = await this.getSession(req);
      if (!session) return null;
      // getSession has already checked current admission. An unchanged profile
      // needs no provider-user write lock on every inbox request.
      const index = await this.store.getJson(path.join('auth', 'workos-user-index', `${encodeURIComponent(session.user.id)}.json`));
      const stored = index?.humanId ? await this.store.getJson(path.join('humans', `${index.humanId}.json`)) : null;
      const displayName = session.user.name || [session.user.firstName, session.user.lastName].filter(Boolean).join(' ') || session.user.email;
      const human = index && stored?.id === index.humanId && stored.workosUserId === session.user.id
        && stored.email === session.user.email && stored.displayName === displayName
        && stored.authProvider === 'workos' && stored.emailVerified && stored.verifiedAt
        && session.user.emailVerified ? stored : await this.upsertHuman(session.user);
      if (!await this.isSessionActive(session)) return null;
      return { ...publicHuman(human), providerUserId: session.user.id, organizationId: session.organizationId || null, role: session.role || null, permissions: session.permissions || [] };
    })();
    Object.defineProperty(req, requestHuman, { value: pending, enumerable: false });
    return pending;
  }

  async getOrganizationMembership(userId, organizationId) {
    if (!userId || !organizationId) return null;
    const result = await this.workos.userManagement.listOrganizationMemberships({
      userId,
      organizationId,
      statuses: ['active'],
      limit: 10
    });
    return result.data.find(membership => membership.userId === userId
      && membership.organizationId === organizationId
      && membership.status === 'active') || null;
  }

  async logout(req, { onRevoked } = {}) {
    const sessionData = parseCookies(req.headers.cookie)[sessionCookie];
    this.queueSessionCookie(req);
    if (!sessionData) return { revoked: false, logoutUrl: null };
    const provider = this.workos.userManagement;
    let sessionId;
    if (provider.getSessionFromCookie) {
      try {
        const data = await provider.getSessionFromCookie({ sessionData, cookiePassword: this.cookiePassword });
        sessionId = tokenClaims(data?.accessToken).sessionId;
      } catch { return { revoked: false, logoutUrl: null }; }
    } else {
      // Compatibility for injected providers; production SDK exposes safe unsealing.
      const session = await this.getProviderSession(req);
      sessionId = session?.sessionId;
    }
    if (!sessionId) return { revoked: false, logoutUrl: null };
    await this.store.withTransaction([this.sessionKey(sessionId)], async () => {
      const relative = this.sessionPath(sessionId);
      const existing = await this.store.getJson(relative);
      await this.store.putJson(relative, { ...existing, sessionId, revokedAt: new Date(this.now()).toISOString(), replays: [] });
    });
    // Disconnect local live streams as soon as the durable deny is committed,
    // before provider network calls can delay completion of the logout response.
    if (onRevoked) onRevoked(sessionId);
    let providerRevoked = false;
    if (provider.revokeSession) {
      try { await provider.revokeSession({ sessionId }); providerRevoked = true; }
      catch { /* Durable local revocation remains authoritative during outages. */ }
    }
    const returnTo = process.env.ENVOI_PUBLIC_URL || new URL(this.redirectUri).origin;
    let logoutUrl = null;
    try {
      logoutUrl = provider.getLogoutUrl
        ? await provider.getLogoutUrl({ sessionId, returnTo })
        : await provider.loadSealedSession({ sessionData, cookiePassword: this.cookiePassword }).getLogoutUrl({ returnTo });
    } catch { /* Signing out locally must not depend on provider availability. */ }
    return { revoked: true, logoutUrl, sessionId, providerRevoked };
  }
  async createProviderOrganization({ name, externalId, idempotencyKey, userId }) {
    const organization = await this.workos.organizations.createOrganization(
      { name, externalId, metadata: { product: 'envoi' } },
      { idempotencyKey }
    );
    await this.workos.userManagement.createOrganizationMembership({ organizationId: organization.id, userId, roleSlug: 'admin' });
    return organization;
  }
}
