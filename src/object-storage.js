import crypto from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DurableMalwareScanLifecycle } from './object-scan-lifecycle.js';

const DEFAULT_ALLOWED_MIME_TYPES = Object.freeze(['*/*']);
const SHA256_BASE64_LENGTH = 44;
const MAX_PRESIGN_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_REQUEST_TIMEOUT_MS = 120_000;
const WORKSPACE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const MIME_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

export class ObjectStorageError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'ObjectStorageError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function validateObjectStorageConfig(config = {}) {
  if (!config || typeof config !== 'object') throw new ObjectStorageError('INVALID_STORAGE_CONFIG', 'Object storage configuration is required');
  const requestedProvider = config.provider ?? 'local';
  const provider = requestedProvider === 'r2' ? 's3' : requestedProvider;
  const region = requestedProvider === 'r2' ? (config.region ?? 'auto') : config.region;
  const maxObjectBytes = Number(config.maxObjectBytes ?? 25 * 1024 * 1024);
  const requestTimeoutMs = Number(config.requestTimeoutMs ?? 30_000);
  const allowedMimeTypes = config.allowedMimeTypes ?? DEFAULT_ALLOWED_MIME_TYPES;
  if (!['local', 's3'].includes(provider)) throw new ObjectStorageError('INVALID_STORAGE_CONFIG', 'provider must be "local", "s3", or "r2"');
  if (!Number.isSafeInteger(maxObjectBytes) || maxObjectBytes < 1) throw new ObjectStorageError('INVALID_STORAGE_CONFIG', 'maxObjectBytes must be a positive integer');
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS) throw new ObjectStorageError('INVALID_STORAGE_CONFIG', 'requestTimeoutMs must be an integer from 1 to 120000');
  if (!Array.isArray(allowedMimeTypes) || !allowedMimeTypes.length || allowedMimeTypes.some(type => typeof type !== 'string' || (type !== '*/*' && !MIME_TYPE.test(type)))) {
    throw new ObjectStorageError('INVALID_STORAGE_CONFIG', 'allowedMimeTypes must contain valid MIME types');
  }
  if (provider === 'local') {
    if (typeof config.root !== 'string' || !path.isAbsolute(config.root)) throw new ObjectStorageError('INVALID_STORAGE_CONFIG', 'local storage requires an absolute root path');
    return { provider, root: path.resolve(config.root), maxObjectBytes, allowedMimeTypes: [...new Set(allowedMimeTypes)] };
  }
  if (config.publicBucket || config.acl === 'public-read' || config.publicBaseUrl) throw new ObjectStorageError('INVALID_STORAGE_CONFIG', 'Public object buckets are not supported');
  if (typeof config.bucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket)) throw new ObjectStorageError('INVALID_STORAGE_CONFIG', 'A valid private S3 bucket is required');
  if (typeof region !== 'string' || !/^[a-z0-9-]+$/.test(region)) throw new ObjectStorageError('INVALID_STORAGE_CONFIG', 'A valid S3 region is required');
  if (typeof config.accessKeyId !== 'string' || !config.accessKeyId || typeof config.secretAccessKey !== 'string' || !config.secretAccessKey) {
    throw new ObjectStorageError('INVALID_STORAGE_CONFIG', 'S3 credentials are required');
  }
  let endpoint;
  try { endpoint = new URL(config.endpoint); } catch { throw new ObjectStorageError('INVALID_STORAGE_CONFIG', 'A valid S3 endpoint is required'); }
  if (!['https:', 'http:'].includes(endpoint.protocol) || (endpoint.protocol !== 'https:' && !config.allowInsecureEndpoint)) {
    throw new ObjectStorageError('INVALID_STORAGE_CONFIG', 'S3 endpoint must use HTTPS');
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new ObjectStorageError('INVALID_STORAGE_CONFIG', 'S3 endpoint must not include credentials, query, or fragment');
  const isR2 = requestedProvider === 'r2' || endpoint.hostname.endsWith('.r2.cloudflarestorage.com');
  if (requestedProvider === 'r2' && !endpoint.hostname.endsWith('.r2.cloudflarestorage.com')) throw new ObjectStorageError('INVALID_STORAGE_CONFIG', 'R2 requires the Cloudflare S3 API endpoint');
  if (isR2 && endpoint.pathname !== '/') throw new ObjectStorageError('INVALID_STORAGE_CONFIG', 'R2 endpoint must not include a bucket or object path');
  if (isR2 && !['auto', 'us-east-1'].includes(region)) throw new ObjectStorageError('INVALID_STORAGE_CONFIG', 'R2 region must be "auto" (or the supported us-east-1 alias)');
  return {
    provider, endpoint: endpoint.toString().replace(/\/$/, ''), bucket: config.bucket, region,
    accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, sessionToken: config.sessionToken,
    allowInsecureEndpoint: Boolean(config.allowInsecureEndpoint), isR2, maxObjectBytes, requestTimeoutMs, allowedMimeTypes: [...new Set(allowedMimeTypes)]
  };
}

export function createObjectStorageAdapter(config) {
  const validated = validateObjectStorageConfig(config);
  return validated.provider === 'local' ? new LocalObjectStorageAdapter(validated.root) : new S3CompatibleObjectStorageAdapter(validated);
}

function assertWorkspaceId(workspaceId) {
  if (typeof workspaceId !== 'string' || !WORKSPACE_ID.test(workspaceId)) throw new ObjectStorageError('INVALID_WORKSPACE_ID', 'Invalid workspace ID');
}

function validateUploadInput(input, config) {
  assertWorkspaceId(input.workspaceId);
  if (typeof input.filename !== 'string' || !input.filename || input.filename !== input.filename.trim() || input.filename.length > 255 || /[\\/\u0000-\u001f\u007f]/.test(input.filename) || ['.', '..'].includes(input.filename)) {
    throw new ObjectStorageError('INVALID_FILENAME', 'Filename must be a non-empty basename without control characters');
  }
  if (typeof input.mimeType !== 'string' || !MIME_TYPE.test(input.mimeType)
    || (!config.allowedMimeTypes.includes('*/*') && !config.allowedMimeTypes.includes(input.mimeType))) {
    throw new ObjectStorageError('INVALID_MIME_TYPE', 'MIME type is not permitted');
  }
  if (!Number.isSafeInteger(input.size) || input.size < 1 || input.size > config.maxObjectBytes) throw new ObjectStorageError('INVALID_SIZE', 'Object size is not permitted');
  if (typeof input.checksumSha256 !== 'string' || input.checksumSha256.length !== SHA256_BASE64_LENGTH) throw new ObjectStorageError('INVALID_CHECKSUM', 'A SHA-256 checksum is required');
  let checksum;
  try { checksum = Buffer.from(input.checksumSha256, 'base64'); } catch { throw new ObjectStorageError('INVALID_CHECKSUM', 'A SHA-256 checksum is required'); }
  if (checksum.length !== 32 || checksum.toString('base64') !== input.checksumSha256) throw new ObjectStorageError('INVALID_CHECKSUM', 'A SHA-256 checksum is required');
}

function clone(value) { return structuredClone(value); }
function immutable(value) { return Object.freeze(clone(value)); }
const LEGACY_UPLOAD_LIFETIME_MS = 30 * 60_000;
function uploadCleanupAt(record) { return record.cleanupAt || new Date(Date.parse(record.createdAt) + LEGACY_UPLOAD_LIFETIME_MS).toISOString(); }
function uploadCleanupDue(record, now) {
  return (record.state === 'upload-cleanup-pending' || record.state === 'quarantine' && !record.uploadCompletedAt)
    && Date.parse(uploadCleanupAt(record)) <= new Date(now).getTime();
}
function sha256Base64(body) { return crypto.createHash('sha256').update(body).digest('base64'); }
function safeKey(key) { return typeof key === 'string' && key.split('/').every(part => part && part !== '.' && part !== '..' && !part.includes('\\') && !part.includes('\0')); }
function validatePresignExpiry(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PRESIGN_TTL_SECONDS) throw new ObjectStorageError('INVALID_PRESIGN_TTL', 'Presigned URL expiry must be between 1 second and 7 days');
}

export class InMemoryMetadataStore {
  #records = new Map();
  #uploadLocks = new Map();
  async create(record) {
    if (this.#records.has(record.id)) return false;
    this.#records.set(record.id, immutable(record));
    return true;
  }
  async get(id) { return this.#records.has(id) ? immutable(this.#records.get(id)) : null; }
  async updateScan(id, scan) {
    const current = this.#records.get(id);
    if (!current) return null;
    if (current.state === 'upload-cleanup-pending' || current.state === 'deleted') return immutable(current);
    const next = { ...current, state: scan.state, scannedAt: scan.scannedAt, scan: immutable(scan.result) };
    this.#records.set(id, immutable(next));
    return immutable(next);
  }
  async updateUpload(id, patch) {
    const current = this.#records.get(id);
    if (!current) return null;
    const next = immutable({ ...current, ...patch });
    this.#records.set(id, next);
    return next;
  }
  async withUploadLock(id, operation) {
    const previous = this.#uploadLocks.get(id) || Promise.resolve();
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    this.#uploadLocks.set(id, pending);
    await previous;
    try { return await operation(); }
    finally { release(); if (this.#uploadLocks.get(id) === pending) this.#uploadLocks.delete(id); }
  }
  async listUploadCleanupCandidates(now, limit) {
    return [...this.#records.values()].filter(record => uploadCleanupDue(record, now))
      .sort((a, b) => uploadCleanupAt(a).localeCompare(uploadCleanupAt(b))).slice(0, limit).map(immutable);
  }
  async remove(id) { return this.#records.delete(id); }
}

export class DocumentObjectMetadataStore {
  constructor(store) { this.store = store; }
  #path(id) { return path.join('object-storage', 'metadata', `${id}.json`); }
  #workspacePath(record) { return path.join('inboxes', record.workspaceId, 'assets', `${record.id}.json`); }
  async create(record) {
    if (!await this.store.putJsonIfAbsent(this.#path(record.id), record)) return false;
    try { await this.store.putJson(this.#workspacePath(record), record); }
    catch (error) { await this.store.deleteJson(this.#path(record.id)); throw error; }
    return true;
  }
  async get(id) { return this.store.getJson(this.#path(id)); }
  async updateScan(id, scan) {
    return this.store.withTransaction([], async () => {
      const current = typeof this.store.query === 'function'
        ? (await this.store.query('SELECT value FROM sinaloa_documents WHERE path = $1 FOR UPDATE', [this.#path(id).replaceAll('\\', '/')])).rows[0]?.value
        : await this.get(id);
      if (!current) return null;
      if (current.state === 'upload-cleanup-pending' || current.state === 'deleted') return immutable(current);
      const next = { ...current, state: scan.state, scannedAt: scan.scannedAt, scan: clone(scan.result) };
      await this.store.putJsonBatch([{ path: this.#path(id), value: next }, { path: this.#workspacePath(next), value: next }]);
      return immutable(next);
    });
  }
  async updateUpload(id, patch) {
    const current = await this.get(id);
    if (!current) return null;
    const next = { ...current, ...patch };
    await this.store.putJsonBatch([{ path: this.#path(id), value: next }, ...(next.uploadCleanupReason === 'AGENT_REMOVED' ? [] : [{ path: this.#workspacePath(next), value: next }])]);
    return immutable(next);
  }
  withUploadLock(id, operation, additionalKeys = []) { return this.store.withTransaction([`object-upload:${id}`, ...additionalKeys], operation); }
  async listUploadCleanupCandidates(now, limit) {
    if (typeof this.store.query === 'function') {
      const result = await this.store.query(`SELECT value FROM sinaloa_documents
        WHERE path LIKE 'object-storage/metadata/%'
          AND ((value->>'state') = 'upload-cleanup-pending'
            OR ((value->>'state') = 'quarantine' AND COALESCE(value->>'uploadCompletedAt', '') = ''))
          AND COALESCE((value->>'cleanupAt')::timestamptz, (value->>'createdAt')::timestamptz + interval '30 minutes') <= $1::timestamptz
        ORDER BY COALESCE(value->>'cleanupAt', value->>'createdAt'), path LIMIT $2`, [new Date(now).toISOString(), limit]);
      return result.rows.map(row => immutable(row.value));
    }
    return (await this.store.listJson(path.join('object-storage', 'metadata'))).filter(record => uploadCleanupDue(record, now))
      .sort((a, b) => uploadCleanupAt(a).localeCompare(uploadCleanupAt(b))).slice(0, limit);
  }
  async remove(id) {
    const current = await this.get(id);
    if (!current) return false;
    await Promise.all([this.store.deleteJson(this.#path(id)), this.store.deleteJson(this.#workspacePath(current))]);
    return true;
  }
}

export class PersistentQuotaLedger {
  constructor(store, { defaultQuotaBytes, reservationTtlMs = 1_200_000 } = {}) {
    if (!store || !['reserveObjectQuota', 'commitObjectQuota', 'releaseObjectQuota', 'deleteCommittedObjectQuota', 'reclaimExpiredObjectQuota'].every(method => typeof store[method] === 'function')) throw new ObjectStorageError('INVALID_QUOTA_STORE', 'Storage backend does not implement atomic object quota operations');
    if (!Number.isSafeInteger(defaultQuotaBytes) || defaultQuotaBytes < 1) throw new ObjectStorageError('INVALID_QUOTA', 'defaultQuotaBytes must be a positive integer');
    if (!Number.isSafeInteger(reservationTtlMs) || reservationTtlMs < 1_000) throw new ObjectStorageError('INVALID_QUOTA', 'reservationTtlMs must be at least one second');
    this.store = store;
    this.defaultQuotaBytes = defaultQuotaBytes;
    this.reservationTtlMs = reservationTtlMs;
  }
  reserve(workspaceId, bytes) { return this.store.reserveObjectQuota(workspaceId, bytes, this.defaultQuotaBytes, this.reservationTtlMs, { retainUntilCleanup: true }); }
  commit(reservationId) { return this.store.commitObjectQuota(reservationId); }
  release(reservationId) { return this.store.releaseObjectQuota(reservationId); }
  deleteCommitted(reservationId) { return this.store.deleteCommittedObjectQuota(reservationId); }
  reclaimExpired(now) { return this.store.reclaimExpiredObjectQuota(now); }
  async isCommitted(reservationId) {
    if (typeof this.store.query === 'function') {
      const result = await this.store.query('SELECT status FROM sinaloa_object_quota_reservations WHERE id = $1', [reservationId]);
      return result.rows[0]?.status === 'committed';
    }
    return (await this.store.getJson(path.join('object-storage', 'quota-reservations', `${reservationId}.json`)))?.state === 'committed';
  }
  usage(workspaceId) { return this.store.objectQuotaUsage(workspaceId, this.defaultQuotaBytes); }
}

export class HttpMalwareScanner {
  constructor({ endpoint, token = null, timeoutMs = 30_000 } = {}) {
    try { this.endpoint = new URL(endpoint); } catch { throw new ObjectStorageError('INVALID_SCANNER_CONFIG', 'A valid malware scanner endpoint is required'); }
    if (this.endpoint.protocol !== 'https:' && !(this.endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(this.endpoint.hostname))) throw new ObjectStorageError('INVALID_SCANNER_CONFIG', 'Malware scanner endpoint must use HTTPS');
    this.token = token;
    this.timeoutMs = timeoutMs;
  }
  async scan({ body, object }) {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        'content-type': object.mimeType,
        'content-length': String(body.length),
        'x-sinaloa-object-id': object.id,
        'x-sinaloa-sha256': object.checksumSha256,
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {})
      },
      body
    });
    if (!response.ok) throw new ObjectStorageError('SCANNER_UNAVAILABLE', `Malware scanner failed with ${response.status}`, 503);
    const result = await response.json().catch(() => null);
    if (!result || !['clean', 'infected'].includes(result.status)) throw new ObjectStorageError('INVALID_SCAN_RESULT', 'Scanner returned an invalid result', 502);
    return { status: result.status, engine: result.engine || 'external', signature: result.signature || null };
  }
}

export class FailClosedScanner {
  async scan() { throw new ObjectStorageError('SCANNER_NOT_CONFIGURED', 'Malware scanning is not configured', 503); }
}

export class InMemoryQuotaLedger {
  #limits;
  #usage = new Map();
  #reservations = new Map();
  #locks = new Map();
  constructor({ defaultQuotaBytes, workspaceQuotaBytes = {} } = {}) {
    if (!Number.isSafeInteger(defaultQuotaBytes) || defaultQuotaBytes < 1) throw new ObjectStorageError('INVALID_QUOTA', 'defaultQuotaBytes must be a positive integer');
    this.defaultQuotaBytes = defaultQuotaBytes;
    this.#limits = new Map(Object.entries(workspaceQuotaBytes));
  }
  async #withWorkspaceLock(workspaceId, action) {
    const previous = this.#locks.get(workspaceId) ?? Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    const chain = previous.then(() => current);
    this.#locks.set(workspaceId, chain);
    await previous;
    try { return await action(); } finally { release(); if (this.#locks.get(workspaceId) === chain) this.#locks.delete(workspaceId); }
  }
  quotaFor(workspaceId) { return Number(this.#limits.get(workspaceId) ?? this.defaultQuotaBytes); }
  async reserve(workspaceId, bytes) {
    assertWorkspaceId(workspaceId);
    if (!Number.isSafeInteger(bytes) || bytes < 1) throw new ObjectStorageError('INVALID_SIZE', 'Reservation size must be positive');
    return this.#withWorkspaceLock(workspaceId, async () => {
      const usage = this.#usage.get(workspaceId) ?? { used: 0, reserved: 0 };
      if (usage.used + usage.reserved + bytes > this.quotaFor(workspaceId)) throw new ObjectStorageError('QUOTA_EXCEEDED', 'Workspace object quota exceeded', 413);
      const reservation = { id: crypto.randomUUID(), workspaceId, bytes, state: 'reserved' };
      this.#reservations.set(reservation.id, reservation);
      this.#usage.set(workspaceId, { ...usage, reserved: usage.reserved + bytes });
      return immutable(reservation);
    });
  }
  async commit(reservationId) { return this.#settle(reservationId, true); }
  async release(reservationId) { return this.#settle(reservationId, false); }
  async deleteCommitted(reservationId) {
    const reservation = this.#reservations.get(reservationId);
    if (!reservation) throw new ObjectStorageError('UNKNOWN_RESERVATION', 'Unknown quota reservation');
    return this.#withWorkspaceLock(reservation.workspaceId, async () => {
      if (reservation.state === 'released') return immutable(reservation);
      if (reservation.state !== 'committed') throw new ObjectStorageError('QUOTA_NOT_COMMITTED', 'Object quota is not committed', 409);
      const usage = this.#usage.get(reservation.workspaceId);
      this.#usage.set(reservation.workspaceId, { ...usage, used: Math.max(0, usage.used - reservation.bytes) });
      reservation.state = 'released';
      return immutable(reservation);
    });
  }
  async #settle(reservationId, commit) {
    const reservation = this.#reservations.get(reservationId);
    if (!reservation) throw new ObjectStorageError('UNKNOWN_RESERVATION', 'Unknown quota reservation');
    return this.#withWorkspaceLock(reservation.workspaceId, async () => {
      if (reservation.state !== 'reserved') return immutable(reservation);
      const usage = this.#usage.get(reservation.workspaceId);
      const next = { used: usage.used + (commit ? reservation.bytes : 0), reserved: usage.reserved - reservation.bytes };
      reservation.state = commit ? 'committed' : 'released';
      this.#usage.set(reservation.workspaceId, next);
      return immutable(reservation);
    });
  }
  async isCommitted(reservationId) { return this.#reservations.get(reservationId)?.state === 'committed'; }
  async usage(workspaceId) { const usage = this.#usage.get(workspaceId) ?? { used: 0, reserved: 0 }; return immutable({ ...usage, quota: this.quotaFor(workspaceId) }); }
}

export class LocalObjectStorageAdapter {
  #tokens = new Map();
  constructor(root) { this.root = path.resolve(root); }
  async init() { await mkdir(this.root, { recursive: true }); }
  #file(key) {
    if (!safeKey(key)) throw new ObjectStorageError('INVALID_OBJECT_KEY', 'Invalid object key');
    const target = path.resolve(this.root, ...key.split('/'));
    if (!target.startsWith(`${this.root}${path.sep}`)) throw new ObjectStorageError('INVALID_OBJECT_KEY', 'Invalid object key');
    return target;
  }
  async putObject({ key, body, contentType, checksumSha256 }) {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
    if (sha256Base64(data) !== checksumSha256) throw new ObjectStorageError('CHECKSUM_MISMATCH', 'Object checksum did not match');
    const target = this.#file(key);
    await mkdir(path.dirname(target), { recursive: true });
    try {
      await writeFile(target, data, { flag: 'wx' });
      await writeFile(`${target}.metadata.json`, JSON.stringify({ contentType, checksumSha256, size: data.length }), { flag: 'wx' });
    } catch (error) {
      if (error.code === 'EEXIST') throw new ObjectStorageError('OBJECT_EXISTS', 'Object key already exists', 409);
      throw error;
    }
  }
  async headObject(key) {
    try { return immutable(JSON.parse(await readFile(`${this.#file(key)}.metadata.json`, 'utf8'))); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async getObject(key) { try { return await readFile(this.#file(key)); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
  async deleteObject(key) {
    const target = this.#file(key);
    await Promise.all([unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error; }), unlink(`${target}.metadata.json`).catch(error => { if (error.code !== 'ENOENT') throw error; })]);
  }
  async sealDeletedObject(key) {
    try { await this.putObject({ key, body: Buffer.alloc(0), contentType: 'application/x-sinaloa-tombstone', checksumSha256: sha256Base64(Buffer.alloc(0)) }); }
    catch (error) {
      if (error.code !== 'OBJECT_EXISTS') throw error;
      const head = await this.headObject(key);
      if (head?.size !== 0 || head.contentType !== 'application/x-sinaloa-tombstone' || head.checksumSha256 !== sha256Base64(Buffer.alloc(0))) throw new ObjectStorageError('UPLOAD_CLEANUP_CONFLICT', 'An upload reached the object key during cleanup', 409);
    }
    return true;
  }
  async createPresignedUpload({ key, contentType, checksumSha256, expiresInSeconds }) {
    validatePresignExpiry(expiresInSeconds);
    const token = crypto.randomUUID();
    this.#tokens.set(token, { key, contentType, checksumSha256, expiresAt: Date.now() + expiresInSeconds * 1000, method: 'PUT' });
    return immutable({ url: `local-object://upload/${token}`, method: 'PUT', headers: { 'content-type': contentType, 'x-amz-checksum-sha256': checksumSha256 } });
  }
  async putPresigned(token, body, headers = {}) {
    const request = this.#tokens.get(token);
    if (!request || request.method !== 'PUT' || request.expiresAt < Date.now()) throw new ObjectStorageError('INVALID_UPLOAD_TOKEN', 'Upload token is invalid or expired', 403);
    if (headers['content-type'] !== request.contentType || headers['x-amz-checksum-sha256'] !== request.checksumSha256) throw new ObjectStorageError('INVALID_UPLOAD_HEADERS', 'Upload headers do not match the signed request');
    await this.putObject({ key: request.key, body, contentType: request.contentType, checksumSha256: request.checksumSha256 });
    this.#tokens.delete(token);
  }
  async createPresignedDownload({ key, expiresInSeconds }) {
    validatePresignExpiry(expiresInSeconds);
    const token = crypto.randomUUID();
    this.#tokens.set(token, { key, expiresAt: Date.now() + expiresInSeconds * 1000, method: 'GET' });
    return immutable({ url: `local-object://download/${token}`, method: 'GET', headers: {} });
  }
  async getPresigned(token) {
    const request = this.#tokens.get(token);
    if (!request || request.method !== 'GET' || request.expiresAt < Date.now()) throw new ObjectStorageError('INVALID_DOWNLOAD_TOKEN', 'Download token is invalid or expired', 403);
    const body = await this.getObject(request.key);
    if (!body) throw new ObjectStorageError('OBJECT_NOT_FOUND', 'Object is missing from storage', 404);
    return body;
  }
}

function awsEncode(value) { return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`); }
function hmac(key, value, encoding) { return crypto.createHmac('sha256', key).update(value).digest(encoding); }
function amzDate(date) { return date.toISOString().replace(/[:-]|\.\d{3}/g, ''); }
function dateStamp(date) { return amzDate(date).slice(0, 8); }
function canonicalQuery(query) { return [...query.entries()].map(([key, value]) => [awsEncode(key), awsEncode(value)]).sort(([aKey, aValue], [bKey, bValue]) => aKey < bKey ? -1 : aKey > bKey ? 1 : aValue < bValue ? -1 : aValue > bValue ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('&'); }

export class S3CompatibleObjectStorageAdapter {
  constructor(config) { this.config = validateObjectStorageConfig({ ...config, provider: config?.provider ?? 's3' }); this.endpoint = new URL(this.config.endpoint); }
  #objectPath(key) {
    if (!safeKey(key)) throw new ObjectStorageError('INVALID_OBJECT_KEY', 'Invalid object key');
    const base = this.endpoint.pathname.replace(/\/$/, '');
    return `${base}/${awsEncode(this.config.bucket)}/${key.split('/').map(awsEncode).join('/')}`;
  }
  #host() { return this.endpoint.port ? `${this.endpoint.hostname}:${this.endpoint.port}` : this.endpoint.hostname; }
  #sign({ method, objectPath, query = new URLSearchParams(), headers = {}, now = new Date() }) {
    const requestHeaders = { host: this.#host(), ...Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value).trim()])) };
    const signedHeaderNames = Object.keys(requestHeaders).sort();
    const canonicalHeaders = signedHeaderNames.map(name => `${name}:${requestHeaders[name].replace(/\s+/g, ' ')}\n`).join('');
    const signedHeaders = signedHeaderNames.join(';');
    const canonicalRequest = `${method}\n${objectPath}\n${canonicalQuery(query)}\n${canonicalHeaders}\n${signedHeaders}\nUNSIGNED-PAYLOAD`;
    const scope = `${dateStamp(now)}/${this.config.region}/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate(now)}\n${scope}\n${crypto.createHash('sha256').update(canonicalRequest).digest('hex')}`;
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${this.config.secretAccessKey}`, dateStamp(now)), this.config.region), 's3'), 'aws4_request');
    return { signature: hmac(signingKey, stringToSign, 'hex'), scope, signedHeaders, requestHeaders };
  }
  #url(objectPath, query) { return `${this.endpoint.origin}${objectPath}?${canonicalQuery(query)}`; }
  async createPresignedUpload({ key, contentType, checksumSha256, expiresInSeconds, size }) {
    validatePresignExpiry(expiresInSeconds);
    if (size !== undefined && (!Number.isSafeInteger(size) || size < 1 || size > this.config.maxObjectBytes)) throw new ObjectStorageError('INVALID_SIZE', 'Signed upload size is not permitted');
    const now = new Date();
    const objectPath = this.#objectPath(key);
    const uploadHeaders = {
      'content-type': contentType,
      'if-none-match': '*',
      'x-amz-meta-sinaloa-sha256': checksumSha256,
      ...(!this.config.isR2 ? { 'x-amz-checksum-sha256': checksumSha256 } : {})
    };
    // Browsers generate Content-Length from the bytes; JavaScript must not set
    // this forbidden header. Bind it in SigV4 without returning it to callers.
    const signingHeaders = { ...uploadHeaders, ...(size !== undefined ? { 'content-length': String(size) } : {}) };
    const signedHeaders = ['host', ...Object.keys(signingHeaders)].sort().join(';');
    const query = new URLSearchParams({ 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Content-Sha256': 'UNSIGNED-PAYLOAD', 'X-Amz-Credential': `${this.config.accessKeyId}/${dateStamp(now)}/${this.config.region}/s3/aws4_request`, 'X-Amz-Date': amzDate(now), 'X-Amz-Expires': String(expiresInSeconds), 'X-Amz-SignedHeaders': signedHeaders });
    if (this.config.sessionToken) query.set('X-Amz-Security-Token', this.config.sessionToken);
    const signing = this.#sign({ method: 'PUT', objectPath, query, headers: signingHeaders, now });
    query.set('X-Amz-Signature', signing.signature);
    return immutable({ url: this.#url(objectPath, query), method: 'PUT', headers: uploadHeaders });
  }
  async createPresignedDownload({ key, expiresInSeconds }) {
    validatePresignExpiry(expiresInSeconds);
    const now = new Date();
    const objectPath = this.#objectPath(key);
    const query = new URLSearchParams({ 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Content-Sha256': 'UNSIGNED-PAYLOAD', 'X-Amz-Credential': `${this.config.accessKeyId}/${dateStamp(now)}/${this.config.region}/s3/aws4_request`, 'X-Amz-Date': amzDate(now), 'X-Amz-Expires': String(expiresInSeconds), 'X-Amz-SignedHeaders': 'host' });
    if (this.config.sessionToken) query.set('X-Amz-Security-Token', this.config.sessionToken);
    query.set('X-Amz-Signature', this.#sign({ method: 'GET', objectPath, query, now }).signature);
    return immutable({ url: this.#url(objectPath, query), method: 'GET', headers: {} });
  }
  async #request(method, key, { headers: additionalHeaders = {}, body } = {}) {
    const now = new Date();
    const objectPath = this.#objectPath(key);
    const headers = { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'x-amz-date': amzDate(now), ...additionalHeaders };
    if (this.config.sessionToken) headers['x-amz-security-token'] = this.config.sessionToken;
    const signing = this.#sign({ method, objectPath, headers, now });
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${signing.scope}, SignedHeaders=${signing.signedHeaders}, Signature=${signing.signature}`;
    try {
      return await fetch(`${this.endpoint.origin}${objectPath}`, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(this.config.requestTimeoutMs) });
    } catch {
      throw new ObjectStorageError('OBJECT_STORAGE_UNAVAILABLE', 'Object storage request failed or timed out', 503);
    }
  }
  async headObject(key) {
    const response = await this.#request('HEAD', key);
    if (response.status === 404) return null;
    if (!response.ok) throw new ObjectStorageError('OBJECT_STORAGE_UNAVAILABLE', `S3 HEAD failed with ${response.status}`, 503);
    let size = Number(response.headers.get('content-length'));
    let checksumSha256 = response.headers.get('x-amz-meta-sinaloa-sha256') || response.headers.get('x-amz-checksum-sha256');
    if (!Number.isSafeInteger(size) || size === 0) {
      // A live R2 HEAD returned zero length for a nonempty object; use the
      // retrieved bytes for both size and checksum before accepting upload.
      const body = await this.getObject(key);
      if (!body) return null;
      size = body.length;
      checksumSha256 = sha256Base64(body);
    }
    return immutable({ size, checksumSha256, contentType: response.headers.get('content-type') });
  }
  async getObject(key) {
    const response = await this.#request('GET', key);
    if (response.status === 404) return null;
    if (!response.ok) throw new ObjectStorageError('OBJECT_STORAGE_UNAVAILABLE', `S3 GET failed with ${response.status}`, 503);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > this.config.maxObjectBytes) {
      await response.body?.cancel();
      throw new ObjectStorageError('CHECKSUM_MISMATCH', 'Stored object exceeds the permitted size', 422);
    }
    const reader = response.body?.getReader();
    if (!reader) return Buffer.alloc(0);
    const parts = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > this.config.maxObjectBytes) {
          await reader.cancel();
          throw new ObjectStorageError('CHECKSUM_MISMATCH', 'Stored object exceeds the permitted size', 422);
        }
        parts.push(Buffer.from(value));
      }
      return Buffer.concat(parts, size);
    } finally { reader.releaseLock(); }
  }
  async sealDeletedObject(key) {
    const body = Buffer.alloc(0);
    const response = await this.#request('PUT', key, { body, headers: {
      'if-none-match': '*', 'content-length': '0', 'content-type': 'application/x-sinaloa-tombstone',
      'x-amz-meta-sinaloa-tombstone': '1'
    } });
    await response.body?.cancel();
    if (response.ok) return true;
    if (response.status === 412) {
      const existing = await this.#request('HEAD', key);
      const marked = existing.ok && existing.headers.get('x-amz-meta-sinaloa-tombstone') === '1';
      await existing.body?.cancel();
      if (marked && (await this.getObject(key))?.length === 0) return true;
      throw new ObjectStorageError('UPLOAD_CLEANUP_CONFLICT', 'An upload reached the object key during cleanup', 409);
    }
    throw new ObjectStorageError('OBJECT_STORAGE_UNAVAILABLE', 'Storage could not seal the expired upload key', 503);
  }
  async deleteObject(key) {
    const response = await this.#request('DELETE', key);
    if (!response.ok && response.status !== 404) throw new ObjectStorageError('OBJECT_STORAGE_UNAVAILABLE', `S3 DELETE failed with ${response.status}`, 503);
  }
}

export class ObjectStorageService {
  constructor({ adapter, metadataStore, quotaLedger, scanner, scanJobStore = null, scanLifecycle = {}, maxObjectBytes = 25 * 1024 * 1024, allowedMimeTypes = DEFAULT_ALLOWED_MIME_TYPES, uploadUrlTtlSeconds = 900, downloadUrlTtlSeconds = 300, uploadCleanupGraceMs = 15 * 60_000, uploadCleanupRetryMs = 60_000, clock = () => new Date() } = {}) {
    if (!adapter || !['createPresignedUpload', 'createPresignedDownload', 'headObject', 'getObject', 'deleteObject'].every(method => typeof adapter[method] === 'function')) throw new ObjectStorageError('INVALID_ADAPTER', 'Object storage adapter is incomplete');
    if (!metadataStore || !['create', 'get', 'updateScan', 'updateUpload', 'withUploadLock', 'listUploadCleanupCandidates', 'remove'].every(method => typeof metadataStore[method] === 'function')) throw new ObjectStorageError('INVALID_METADATA_STORE', 'Metadata store is incomplete');
    if (!quotaLedger || !['reserve', 'commit', 'release'].every(method => typeof quotaLedger[method] === 'function')) throw new ObjectStorageError('INVALID_QUOTA_LEDGER', 'Quota ledger is incomplete');
    if (!scanner || typeof scanner.scan !== 'function') throw new ObjectStorageError('INVALID_SCANNER', 'A malware scanner is required');
    this.adapter = adapter;
    this.metadataStore = metadataStore;
    this.quotaLedger = quotaLedger;
    this.scanner = scanner;
    validatePresignExpiry(uploadUrlTtlSeconds);
    validatePresignExpiry(downloadUrlTtlSeconds);
    if (!Number.isSafeInteger(uploadCleanupGraceMs) || uploadCleanupGraceMs < 0 || !Number.isSafeInteger(uploadCleanupRetryMs) || uploadCleanupRetryMs < 1) throw new ObjectStorageError('INVALID_CLEANUP_CONFIG', 'Upload cleanup intervals must be nonnegative grace and positive retry integers');
    this.clock = clock;
    this.config = { maxObjectBytes, allowedMimeTypes, uploadUrlTtlSeconds, downloadUrlTtlSeconds, uploadCleanupGraceMs, uploadCleanupRetryMs };
    this.scanLifecycle = scanJobStore ? new DurableMalwareScanLifecycle({ jobStore: scanJobStore, adapter, metadataStore, quotaLedger, scanner, ...scanLifecycle }) : null;
  }
  async init() { await this.adapter.init?.(); }
  async beginUpload(input, { lockKeys = [], authorize } = {}) {
    validateUploadInput(input, this.config);
    const id = `obj_${crypto.randomUUID()}`;
    // Durable retained quota and its cleanup metadata must commit together.
    return this.metadataStore.withUploadLock(id, async () => {
      if (authorize) await authorize();
      const reservation = await this.quotaLedger.reserve(input.workspaceId, input.size);
      const createdAt = this.clock();
      const record = { id, workspaceId: input.workspaceId, key: `workspaces/${input.workspaceId}/objects/${id}`, filename: input.filename, mimeType: input.mimeType, size: input.size, checksumSha256: input.checksumSha256, caseId: input.caseId || null, createdByAgentId: input.createdByAgentId || null, state: 'quarantine', createdAt: createdAt.toISOString(), uploadExpiresAt: new Date(createdAt.getTime() + this.config.uploadUrlTtlSeconds * 1000).toISOString(), cleanupAt: new Date(createdAt.getTime() + this.config.uploadUrlTtlSeconds * 1000 + this.config.uploadCleanupGraceMs).toISOString(), uploadCompletedAt: null, scannedAt: null, scan: null, reservationId: reservation.id };
      try {
        if (!await this.metadataStore.create(record)) throw new ObjectStorageError('OBJECT_EXISTS', 'Object metadata already exists', 409);
        const upload = await this.adapter.createPresignedUpload({ key: record.key, contentType: record.mimeType, checksumSha256: record.checksumSha256, expiresInSeconds: this.config.uploadUrlTtlSeconds, size: record.size });
        return immutable({ object: record, upload });
      } catch (error) {
        await this.metadataStore.remove(record.id);
        await this.quotaLedger.release(reservation.id);
        throw error;
      }
    }, lockKeys);
  }
  async completeUpload(id) {
    const result = await this.metadataStore.withUploadLock(id, async () => {
      const record = await this.#recoverLegacyUpload(await this.#requireObject(id));
      if (record.state === 'upload-cleanup-pending' || record.state === 'deleted') return { error: new ObjectStorageError('UPLOAD_REJECTED', 'Upload was rejected or expired; begin a new upload', 409) };
      if (record.state !== 'quarantine' || record.uploadCompletedAt) return { record };
      if (uploadCleanupDue(record, this.clock())) {
        await this.#markUploadCleanup(record, 'UPLOAD_EXPIRED');
        await this.#cleanupUpload(id, this.clock());
        return { error: new ObjectStorageError('UPLOAD_EXPIRED', 'Upload expired; begin a new upload', 409) };
      }
      let head;
      try { head = await this.adapter.headObject(record.key); }
      catch (error) {
        if (error.code !== 'CHECKSUM_MISMATCH') throw error;
        await this.#markUploadCleanup(record, 'UPLOAD_VERIFICATION_FAILED');
        return { error };
      }
      if (!head) return { error: new ObjectStorageError('UPLOAD_VERIFICATION_FAILED', 'Upload bytes are not available yet', 422) };
      if (head.size !== record.size || head.checksumSha256 !== record.checksumSha256) {
        await this.#markUploadCleanup(record, 'UPLOAD_VERIFICATION_FAILED');
        return { error: new ObjectStorageError('UPLOAD_VERIFICATION_FAILED', 'Uploaded object does not match immutable metadata', 422) };
      }
      try { await this.quotaLedger.commit(record.reservationId); }
      catch (error) {
        if (error.code !== 'QUOTA_RESERVATION_EXPIRED') throw error;
        await this.#markUploadCleanup(record, 'QUOTA_RESERVATION_EXPIRED');
        return { error };
      }
      const verified = await this.metadataStore.updateUpload(id, { uploadCompletedAt: this.clock().toISOString() });
      // Keep verified uploads recoverable across a crash before inline scanning.
      if (this.scanLifecycle) await this.scanLifecycle.enqueue(id);
      return { record: verified };
    });
    if (result.error) throw result.error;
    return result.record;
  }
  async #recoverLegacyUpload(record) {
    if (record.state !== 'quarantine' || record.uploadCompletedAt || record.uploadExpiresAt) return record;
    const job = this.scanLifecycle ? await this.scanLifecycle.jobStore.get(`scan_${record.id}`) : null;
    if (!job && !await this.quotaLedger.isCommitted?.(record.reservationId)) return record;
    const verified = await this.metadataStore.updateUpload(record.id, { uploadCompletedAt: record.scannedAt || record.createdAt });
    if (this.scanLifecycle && !job) await this.scanLifecycle.enqueue(record.id);
    return verified;
  }
  async #markUploadCleanup(record, reason) {
    return this.metadataStore.updateUpload(record.id, {
      state: 'upload-cleanup-pending', uploadCleanupReason: reason,
      cleanupAt: uploadCleanupAt(record), scan: { status: 'upload-cleanup-pending', reason }
    });
  }
  async #cleanupUpload(id, now) {
    const record = await this.#recoverLegacyUpload(await this.#requireObject(id));
    if (!uploadCleanupDue(record, now)) return false;
    if (record.state === 'quarantine') await this.#markUploadCleanup(record, 'UPLOAD_EXPIRED');
    try {
      if (typeof this.adapter.sealDeletedObject !== 'function') throw new ObjectStorageError('UPLOAD_CLEANUP_UNSUPPORTED', 'Adapter must seal expired upload keys before quota release', 503);
      await this.adapter.deleteObject(record.key);
      // The same-key zero-byte tombstone prevents even a PUT begun before URL
      // expiry from recreating the user object after its quota is released.
      if (await this.adapter.sealDeletedObject(record.key) !== true) throw new ObjectStorageError('UPLOAD_CLEANUP_UNCONFIRMED', 'Object key sealing was not confirmed', 503);
      const quota = await this.quotaLedger.release(record.reservationId);
      // Legacy quarantine records may already have committed quota.
      if (quota?.state === 'committed') await this.quotaLedger.deleteCommitted(record.reservationId);
      await this.metadataStore.updateUpload(id, { state: 'deleted', uploadCleanupCompletedAt: new Date(now).toISOString(), cleanupAt: null,
        scan: { status: 'deleted', reason: record.uploadCleanupReason || 'UPLOAD_EXPIRED', tombstone: true } });
      if (record.uploadCleanupReason === 'AGENT_REMOVED') await this.metadataStore.remove(id);
      return true;
    } catch {
      await this.metadataStore.updateUpload(id, { state: 'upload-cleanup-pending', cleanupAt: new Date(new Date(now).getTime() + this.config.uploadCleanupRetryMs).toISOString(),
        scan: { status: 'upload-cleanup-pending', reason: record.uploadCleanupReason || 'UPLOAD_EXPIRED', code: 'UPLOAD_CLEANUP_FAILED' } });
      return false;
    }
  }
  async reapExpiredUploads({ limit = 25, now = this.clock() } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || !Number.isFinite(new Date(now).getTime())) throw new ObjectStorageError('INVALID_CLEANUP_CONFIG', 'Cleanup needs a valid time and a limit between 1 and 1000');
    const candidates = await this.metadataStore.listUploadCleanupCandidates(now, limit);
    const result = { processed: 0, deleted: 0, deferred: 0 };
    for (const record of candidates) {
      const deleted = await this.metadataStore.withUploadLock(record.id, () => this.#cleanupUpload(record.id, now));
      result.processed += 1;
      if (deleted) result.deleted += 1;
      else result.deferred += 1;
    }
    return result;
  }
  async scanObject(id) {
    const record = await this.completeUpload(id);
    if (this.scanLifecycle) return this.scanLifecycle.processObject(id);
    try {
      const body = await this.adapter.getObject(record.key);
      if (!body) throw new ObjectStorageError('OBJECT_NOT_FOUND', 'Object is missing from storage', 404);
      if (body.length !== record.size || sha256Base64(body) !== record.checksumSha256) throw new ObjectStorageError('CHECKSUM_MISMATCH', 'Stored object failed immutable size or checksum verification', 422);
      const result = await this.scanner.scan({ body, object: record });
      if (!result || !['clean', 'infected'].includes(result.status)) throw new ObjectStorageError('INVALID_SCAN_RESULT', 'Scanner returned an invalid result');
      return this.metadataStore.updateScan(id, { state: result.status, scannedAt: new Date().toISOString(), result: { status: result.status, engine: result.engine ?? null, signature: result.signature ?? null } });
    } catch (error) {
      await this.metadataStore.updateScan(id, { state: 'error', scannedAt: new Date().toISOString(), result: { status: 'error', message: error.message } });
      throw error;
    }
  }
  async processNextScan(workerId) {
    if (!this.scanLifecycle) throw new ObjectStorageError('SCAN_LIFECYCLE_NOT_CONFIGURED', 'Durable malware scan lifecycle is not configured', 503);
    return this.scanLifecycle.processNext(workerId);
  }
  async reapScanRetention(workerId) {
    if (!this.scanLifecycle) throw new ObjectStorageError('SCAN_LIFECYCLE_NOT_CONFIGURED', 'Durable malware scan lifecycle is not configured', 503);
    return this.scanLifecycle.reapRetention(workerId);
  }
  async createDownload(id) {
    const record = await this.#requireObject(id);
    if (record.state !== 'clean') throw new ObjectStorageError('OBJECT_NOT_CLEAN', 'Object is unavailable until malware scanning completes', 423);
    return this.adapter.createPresignedDownload({ key: record.key, expiresInSeconds: this.config.downloadUrlTtlSeconds });
  }
  async readCleanObject(id) {
    const record = await this.#requireObject(id);
    if (record.state !== 'clean') throw new ObjectStorageError('OBJECT_NOT_CLEAN', 'Object is unavailable until malware scanning completes', 423);
    const bytes = await this.adapter.getObject(record.key);
    if (!bytes || bytes.length !== record.size || sha256Base64(bytes) !== record.checksumSha256) {
      throw new ObjectStorageError('CHECKSUM_MISMATCH', 'Stored object failed immutable size or checksum verification', 422);
    }
    return { object: record, bytes };
  }
  async requestRemoval(id) {
    return this.metadataStore.withUploadLock(id, async () => {
      const record = await this.metadataStore.get(id);
      if (!record || record.state === 'deleted') return record;
      return this.metadataStore.updateUpload(id, { state: 'upload-cleanup-pending', uploadCleanupReason: 'AGENT_REMOVED', cleanupAt: this.clock().toISOString(), scan: { status: 'upload-cleanup-pending', reason: 'AGENT_REMOVED' } });
    });
  }
  async abortUpload(id) {
    return this.metadataStore.withUploadLock(id, async () => {
      const record = await this.#requireObject(id);
      if (record.state === 'upload-cleanup-pending' || record.state === 'deleted') return record;
      if (record.state !== 'quarantine' || record.uploadCompletedAt) throw new ObjectStorageError('OBJECT_NOT_ABORTABLE', 'Only incomplete quarantined objects may be aborted', 409);
      // A returned signed PUT remains live; retain the hold until safe sealing.
      return this.#markUploadCleanup(record, 'UPLOAD_ABORTED');
    });
  }
  async getObject(id) { return this.#requireObject(id); }
  async #requireObject(id) {
    const record = await this.metadataStore.get(id);
    if (!record) throw new ObjectStorageError('OBJECT_NOT_FOUND', 'Object metadata was not found', 404);
    return record;
  }
}
