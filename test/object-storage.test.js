import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { FileStore } from '../src/storage.js';
import { InMemoryMalwareScanJobStore } from '../src/object-scan-lifecycle.js';
import {
  InMemoryMetadataStore,
  DocumentObjectMetadataStore,
  PersistentQuotaLedger,
  InMemoryQuotaLedger,
  HttpMalwareScanner,
  LocalObjectStorageAdapter,
  ObjectStorageError,
  ObjectStorageService,
  S3CompatibleObjectStorageAdapter,
  validateObjectStorageConfig
} from '../src/object-storage.js';

const checksum = body => crypto.createHash('sha256').update(body).digest('base64');

test('agent removal blocks late scan updates and seals owned bytes before releasing quota', async t => {
  const local = await createLocalService();
  t.after(() => rm(local.root, { recursive: true, force: true }));
  const started = await createAndUpload(local);
  await local.service.scanObject(started.object.id);
  await local.service.requestRemoval(started.object.id);
  const late = await local.service.metadataStore.updateScan(started.object.id, { state: 'clean', scannedAt: new Date().toISOString(), result: { status: 'clean' } });
  assert.equal(late.state, 'upload-cleanup-pending');
  const result = await local.service.reapExpiredUploads();
  assert.equal(result.deleted, 1);
  assert.equal(await local.service.metadataStore.get(started.object.id), null);
  await assert.rejects(() => local.service.getObject(started.object.id), error => error.code === 'OBJECT_NOT_FOUND');
  assert.equal((await local.service.quotaLedger.usage('workspace_a')).used, 0);
});

async function createLocalService({ scanner = { scan: async () => ({ status: 'clean', engine: 'test' }) }, quota = 1000, ...serviceOptions } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sinaloa-object-store-'));
  const adapter = new LocalObjectStorageAdapter(root);
  const service = new ObjectStorageService({
    adapter,
    metadataStore: new InMemoryMetadataStore(),
    quotaLedger: new InMemoryQuotaLedger({ defaultQuotaBytes: quota }),
    scanner,
    maxObjectBytes: 1000,
    allowedMimeTypes: ['text/plain'],
    ...serviceOptions
  });
  await service.init();
  return { root, adapter, service };
}

async function createAndUpload({ service, adapter }, body = Buffer.from('safe message'), options = {}) {
  const started = await service.beginUpload({
    workspaceId: options.workspaceId ?? 'workspace_a',
    filename: options.filename ?? 'message.txt',
    mimeType: options.mimeType ?? 'text/plain',
    size: body.length,
    checksumSha256: checksum(body)
  });
  const token = new URL(started.upload.url).pathname.split('/').at(-1);
  await adapter.putPresigned(token, body, started.upload.headers);
  return started;
}

test('valid file types, including Markdown and CSV, pass the same scan gate', async t => {
  const setup = await createLocalService({ allowedMimeTypes: ['*/*'] });
  t.after(() => rm(setup.root, { recursive: true, force: true }));
  assert.deepEqual(validateObjectStorageConfig({ provider: 'local', root: setup.root, allowedMimeTypes: ['*/*'] }).allowedMimeTypes, ['*/*']);
  for (const [filename, mimeType] of [
    ['budget.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['budget.xls', 'application/vnd.ms-excel'],
    ['notes.md', 'text/markdown'],
    ['budget.csv', 'text/csv'],
    ['archive.zip', 'application/zip'],
    ['data.bin', 'application/octet-stream']
  ]) {
    const started = await createAndUpload(setup, Buffer.from(filename), { filename, mimeType });
    await assert.rejects(() => setup.service.createDownload(started.object.id), error => error.code === 'OBJECT_NOT_CLEAN');
    await setup.service.completeUpload(started.object.id);
    const scanned = await setup.service.scanObject(started.object.id);
    assert.equal(scanned.state, 'clean');
    assert.equal((await setup.service.getObject(started.object.id)).mimeType, mimeType);
  }
  await assert.rejects(() => setup.service.beginUpload({ workspaceId: 'workspace_a', filename: 'bad.bin', mimeType: 'not a mime type', size: 1, checksumSha256: checksum(Buffer.from('x')) }), error => error.code === 'INVALID_MIME_TYPE');
});

test('local storage isolates workspace keys and fails downloads closed until clean', async t => {
  const setup = await createLocalService();
  t.after(() => rm(setup.root, { recursive: true, force: true }));
  const started = await createAndUpload(setup);
  assert.match(started.object.key, /^workspaces\/workspace_a\/objects\/obj_[0-9a-f-]+$/);
  assert.equal(started.object.state, 'quarantine');
  await assert.rejects(() => setup.service.createDownload(started.object.id), error => error.code === 'OBJECT_NOT_CLEAN');
  await setup.service.completeUpload(started.object.id);
  const clean = await setup.service.scanObject(started.object.id);
  assert.equal(clean.state, 'clean');
  const download = await setup.service.createDownload(started.object.id);
  assert.match(download.url, /^local-object:\/\/download\//);
  const original = await setup.service.getObject(started.object.id);
  assert.equal(original.filename, 'message.txt');
  assert.equal(original.checksumSha256, checksum(Buffer.from('safe message')));
});

test('object metadata and checksums are immutable and uploads are verified', async t => {
  const setup = await createLocalService();
  t.after(() => rm(setup.root, { recursive: true, force: true }));
  const body = Buffer.from('fixed payload');
  const started = await setup.service.beginUpload({ workspaceId: 'workspace_a', filename: 'fixed.txt', mimeType: 'text/plain', size: body.length, checksumSha256: checksum(body) });
  const token = new URL(started.upload.url).pathname.split('/').at(-1);
  await assert.rejects(() => setup.adapter.putPresigned(token, Buffer.from('tampered'), started.upload.headers), error => error.code === 'CHECKSUM_MISMATCH');
  await assert.rejects(() => setup.service.completeUpload(started.object.id), error => error.code === 'UPLOAD_VERIFICATION_FAILED');
  const record = await setup.service.getObject(started.object.id);
  assert.throws(() => { record.filename = 'changed.txt'; }, TypeError);
  assert.equal((await setup.service.getObject(started.object.id)).filename, 'fixed.txt');
});

test('infected and scanner-error objects remain unavailable', async t => {
  const infected = await createLocalService({ scanner: { scan: async () => ({ status: 'infected', engine: 'clamav', signature: 'Eicar-Test-Signature' }) } });
  const failed = await createAndUpload(infected, Buffer.from('infected'));
  await infected.service.scanObject(failed.object.id);
  assert.equal((await infected.service.getObject(failed.object.id)).state, 'infected');
  await assert.rejects(() => infected.service.createDownload(failed.object.id), error => error.code === 'OBJECT_NOT_CLEAN');
  await rm(infected.root, { recursive: true, force: true });

  const broken = await createLocalService({ scanner: { scan: async () => { throw new Error('scanner offline'); } } });
  const brokenUpload = await createAndUpload(broken, Buffer.from('scanner error'));
  await assert.rejects(() => broken.service.scanObject(brokenUpload.object.id), /scanner offline/);
  assert.equal((await broken.service.getObject(brokenUpload.object.id)).state, 'error');
  await assert.rejects(() => broken.service.createDownload(brokenUpload.object.id), error => error.code === 'OBJECT_NOT_CLEAN');
  await rm(broken.root, { recursive: true, force: true });
});

test('quota reservations are race-safe and only commit verified uploads', async () => {
  const ledger = new InMemoryQuotaLedger({ defaultQuotaBytes: 10 });
  const attempts = await Promise.allSettled(Array.from({ length: 4 }, () => ledger.reserve('workspace_a', 6)));
  assert.equal(attempts.filter(attempt => attempt.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(attempt => attempt.status === 'rejected' && attempt.reason.code === 'QUOTA_EXCEEDED').length, 3);
  const reservation = attempts.find(attempt => attempt.status === 'fulfilled').value;
  await ledger.release(reservation.id);
  assert.deepEqual(await ledger.usage('workspace_a'), { used: 0, reserved: 0, quota: 10 });
  const committed = await ledger.reserve('workspace_a', 6);
  await ledger.commit(committed.id);
  assert.deepEqual(await ledger.usage('workspace_a'), { used: 6, reserved: 0, quota: 10 });
  await ledger.deleteCommitted(committed.id);
  await ledger.deleteCommitted(committed.id);
  assert.deepEqual(await ledger.usage('workspace_a'), { used: 0, reserved: 0, quota: 10 });
});

test('persistent quota releases expired reservations and rejects late commits', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sinaloa-object-quota-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileStore(root);
  await store.init();
  const reservation = await store.reserveObjectQuota('workspace_a', 8, 10, 1_000);
  const reclaimed = await store.reclaimExpiredObjectQuota(new Date(new Date(reservation.expiresAt).getTime() + 1).toISOString());
  assert.deepEqual(reclaimed, { releasedReservations: 1, releasedBytes: 8 });
  assert.deepEqual(await store.objectQuotaUsage('workspace_a', 10), { workspaceId: 'workspace_a', used: 0, reserved: 0, quota: 10 });
  await assert.rejects(() => store.commitObjectQuota(reservation.id), error => error.code === 'QUOTA_RESERVATION_EXPIRED');
  const committed = await store.reserveObjectQuota('workspace_a', 6, 10);
  await store.commitObjectQuota(committed.id);
  await store.deleteCommittedObjectQuota(committed.id);
  await store.deleteCommittedObjectQuota(committed.id);
  assert.deepEqual(await store.objectQuotaUsage('workspace_a', 10), { workspaceId: 'workspace_a', used: 0, reserved: 0, quota: 10 });
});

test('strict validation rejects unsafe input and public S3 configurations', async t => {
  const setup = await createLocalService();
  t.after(() => rm(setup.root, { recursive: true, force: true }));
  const valid = { workspaceId: 'workspace_a', filename: 'safe.txt', mimeType: 'text/plain', size: 3, checksumSha256: checksum(Buffer.from('abc')) };
  await assert.rejects(() => setup.service.beginUpload({ ...valid, filename: '../escape.txt' }), error => error.code === 'INVALID_FILENAME');
  await assert.rejects(() => setup.service.beginUpload({ ...valid, mimeType: 'application/octet-stream' }), error => error.code === 'INVALID_MIME_TYPE');
  await assert.rejects(() => setup.service.beginUpload({ ...valid, size: 0 }), error => error.code === 'INVALID_SIZE');
  await assert.rejects(() => setup.service.beginUpload({ ...valid, checksumSha256: 'not-a-checksum' }), error => error.code === 'INVALID_CHECKSUM');
  assert.throws(() => validateObjectStorageConfig({ provider: 's3', endpoint: 'https://s3.example.test', bucket: 'private-bucket', region: 'ca-central-1', accessKeyId: 'key', secretAccessKey: 'secret', publicBucket: true }), error => error instanceof ObjectStorageError && error.code === 'INVALID_STORAGE_CONFIG');
});

test('S3-compatible adapter creates private checksum-bound presigned URLs', async () => {
  const adapter = new S3CompatibleObjectStorageAdapter({
    provider: 's3', endpoint: 'https://s3.example.test', bucket: 'private-bucket', region: 'ca-central-1', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret-value'
  });
  const digest = checksum(Buffer.from('payload'));
  const upload = await adapter.createPresignedUpload({ key: 'workspaces/workspace_a/objects/obj_1', contentType: 'text/plain', checksumSha256: digest, expiresInSeconds: 60 });
  const url = new URL(upload.url);
  assert.equal(url.protocol, 'https:');
  assert.match(url.pathname, /^\/private-bucket\/workspaces\/workspace_a\/objects\/obj_1$/);
  assert.equal(url.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
  assert.equal(url.searchParams.get('X-Amz-Content-Sha256'), 'UNSIGNED-PAYLOAD');
  assert.deepEqual(url.searchParams.get('X-Amz-SignedHeaders').split(';'), ['content-type', 'host', 'if-none-match', 'x-amz-checksum-sha256', 'x-amz-meta-sinaloa-sha256']);
  assert.ok(url.searchParams.get('X-Amz-Signature'));
  assert.equal(upload.headers['x-amz-checksum-sha256'], digest);
  assert.equal(upload.headers['x-amz-meta-sinaloa-sha256'], digest);
  assert.equal(upload.headers['if-none-match'], '*');
  assert.ok(!upload.url.includes('secret-value'));
  const download = await adapter.createPresignedDownload({ key: 'workspaces/workspace_a/objects/obj_1', expiresInSeconds: 60 });
  assert.equal(new URL(download.url).searchParams.get('X-Amz-SignedHeaders'), 'host');
});

test('R2 mode uses region auto and metadata-bound SHA-256 without unsupported full-object checksum mode', async () => {
  const adapter = new S3CompatibleObjectStorageAdapter({
    provider: 'r2', endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
    bucket: 'private-bucket', accessKeyId: 'R2EXAMPLE', secretAccessKey: 'secret-value'
  });
  const digest = checksum(Buffer.from('payload'));
  const upload = await adapter.createPresignedUpload({ key: 'workspaces/workspace_a/objects/obj_1', contentType: 'text/plain', checksumSha256: digest, expiresInSeconds: 60 });
  const url = new URL(upload.url);
  assert.match(url.searchParams.get('X-Amz-Credential'), /\/auto\/s3\/aws4_request$/);
  assert.equal(upload.headers['x-amz-meta-sinaloa-sha256'], digest);
  assert.equal(upload.headers['x-amz-checksum-sha256'], undefined);
  assert.deepEqual(url.searchParams.get('X-Amz-SignedHeaders').split(';'), ['content-type', 'host', 'if-none-match', 'x-amz-meta-sinaloa-sha256']);
  await assert.rejects(() => adapter.createPresignedDownload({ key: 'valid/key', expiresInSeconds: 604_801 }), error => error.code === 'INVALID_PRESIGN_TTL');
});

test('S3 adapter verifies object bytes when HEAD reports zero length', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const body = Buffer.from('nonempty R2 object');
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(options.method);
    if (options.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': '0', 'x-amz-meta-sinaloa-sha256': checksum(Buffer.from('different')) } });
    if (options.method === 'GET') return new Response(body, { status: 200 });
    throw new Error('Unexpected storage request');
  };
  const adapter = new S3CompatibleObjectStorageAdapter({
    provider: 'r2', endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
    bucket: 'private-bucket', accessKeyId: 'R2EXAMPLE', secretAccessKey: 'secret-value'
  });
  const head = await adapter.headObject('workspaces/workspace_a/objects/obj_1');
  assert.equal(head.size, body.length);
  assert.equal(head.checksumSha256, checksum(body));
  assert.deepEqual(requests, ['HEAD', 'GET']);
});

test('S3 adapter bounds transport time and sanitizes timeout failures', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = (_url, options) => new Promise((_, reject) => {
    // Model the live socket that keeps a real request pending on Node 22.
    const pendingRequest = setTimeout(() => reject(new Error('Mock request did not abort')), 1000);
    options.signal.addEventListener('abort', () => { clearTimeout(pendingRequest); reject(options.signal.reason); }, { once: true });
  });
  const adapter = new S3CompatibleObjectStorageAdapter({
    provider: 's3', endpoint: 'https://s3.example.test', bucket: 'private-bucket', region: 'ca-central-1',
    accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'must-not-leak', requestTimeoutMs: 5
  });
  await assert.rejects(() => adapter.headObject('workspaces/workspace_a/objects/obj_1'), error => {
    assert.equal(error.code, 'OBJECT_STORAGE_UNAVAILABLE');
    assert.equal(error.statusCode, 503);
    assert.equal(error.message.includes('must-not-leak'), false);
    assert.equal(error.message.includes('s3.example.test'), false);
    return true;
  });
});

test('HTTP scanner enforces a bounded response time', async t => {
  const scannerServer = http.createServer((_request, response) => {
    setTimeout(() => { if (!response.destroyed) response.end(JSON.stringify({ status: 'clean' })); }, 100);
  });
  await new Promise(resolve => scannerServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => scannerServer.close(resolve)));
  const scanner = new HttpMalwareScanner({ endpoint: `http://127.0.0.1:${scannerServer.address().port}/scan`, timeoutMs: 5 });
  const content = Buffer.from('harmless');
  await assert.rejects(() => scanner.scan({ body: content, object: { id: 'obj_timeout', mimeType: 'text/plain', checksumSha256: checksum(content) } }), error => error.name === 'TimeoutError' || error.name === 'AbortError');
});

test('HTTP scanner rejects redirects before sending a scan to another endpoint', async t => {
  const scannerServer = http.createServer((_request, response) => {
    response.writeHead(302, { location: 'http://127.0.0.1:9/redirected' });
    response.end();
  });
  await new Promise(resolve => scannerServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => scannerServer.close(resolve)));
  const scanner = new HttpMalwareScanner({ endpoint: `http://127.0.0.1:${scannerServer.address().port}/scan`, token: 'test-only-token' });
  const content = Buffer.from('harmless');
  await assert.rejects(() => scanner.scan({ body: content, object: { id: 'obj_redirect', mimeType: 'text/plain', checksumSha256: checksum(content) } }));
});

function sigV4Accepts(upload, bytes, secret) {
  const url = new URL(upload.url);
  const query = new URLSearchParams(url.search);
  const supplied = query.get('X-Amz-Signature');
  query.delete('X-Amz-Signature');
  const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  const signed = query.get('X-Amz-SignedHeaders');
  const headers = { ...upload.headers, host: url.host, 'content-length': String(bytes.length) };
  const canonicalHeaders = signed.split(';').map(name => `${name}:${headers[name]}\n`).join('');
  const canonicalQuery = [...query.entries()].map(([name, value]) => [encode(name), encode(value)]).sort(([a, av], [b, bv]) => a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0).map(([name, value]) => `${name}=${value}`).join('&');
  const canonical = `PUT\n${url.pathname}\n${canonicalQuery}\n${canonicalHeaders}\n${signed}\nUNSIGNED-PAYLOAD`;
  const scope = query.get('X-Amz-Credential').split('/').slice(1).join('/');
  const [date, region] = scope.split('/');
  const mac = (key, value) => crypto.createHmac('sha256', key).update(value).digest();
  const key = mac(mac(mac(mac(`AWS4${secret}`, date), region), 's3'), 'aws4_request');
  const value = `AWS4-HMAC-SHA256\n${query.get('X-Amz-Date')}\n${scope}\n${crypto.createHash('sha256').update(canonical).digest('hex')}`;
  return crypto.createHmac('sha256', key).update(value).digest('hex') === supplied;
}

for (const provider of ['r2', 's3']) {
  test(`${provider} signed upload rejects oversized bytes without browser-set Content-Length`, async () => {
    const adapter = new S3CompatibleObjectStorageAdapter({ provider,
      endpoint: provider === 'r2' ? 'https://test.r2.cloudflarestorage.com' : 'https://s3.example.test',
      bucket: 'private-bucket', region: provider === 'r2' ? 'auto' : 'us-east-1', accessKeyId: 'test-key', secretAccessKey: 'test-secret' });
    const body = Buffer.from('safe');
    const upload = await adapter.createPresignedUpload({ key: 'objects/size-bound', contentType: 'text/plain', checksumSha256: checksum(body), size: body.length, expiresInSeconds: 60 });
    assert.equal(upload.headers['content-length'], undefined, 'Browser must generate this forbidden header');
    assert.ok(new URL(upload.url).searchParams.get('X-Amz-SignedHeaders').split(';').includes('content-length'));
    assert.equal(sigV4Accepts(upload, body, 'test-secret'), true);
    assert.equal(sigV4Accepts(upload, Buffer.alloc(1000), 'test-secret'), false, 'Actual request length must match the signed reservation');
  });
}

function cleanupFixture() {
  let now = new Date('2026-09-29T00:00:00.000Z');
  const objects = new Map();
  const actions = [];
  let deleteFails = false;
  let sealConflicts = false;
  const metadataStore = new InMemoryMetadataStore();
  const quotaLedger = new InMemoryQuotaLedger({ defaultQuotaBytes: 10 });
  const adapter = {
    createPresignedUpload: async options => { assert.equal(options.size, 4); return { url: 'https://objects.example.test/signed', method: 'PUT', headers: {} }; },
    createPresignedDownload: async () => ({ url: 'https://objects.example.test/get' }),
    headObject: async key => objects.get(key) || null,
    getObject: async key => objects.get(key)?.bytes || null,
    deleteObject: async key => { actions.push('delete'); if (deleteFails) throw new Error('credential must-not-leak'); objects.delete(key); },
    sealDeletedObject: async key => { actions.push('seal'); if (sealConflicts) { objects.set(key, { size: 4, bytes: Buffer.from('late') }); throw new Error('Conditional key conflict'); } if (objects.has(key)) throw new Error('Object key already occupied'); objects.set(key, { size: 0, bytes: Buffer.alloc(0), tombstone: true }); return true; }
  };
  const service = new ObjectStorageService({ adapter, metadataStore, quotaLedger, scanner: { scan: async () => ({ status: 'clean' }) },
    uploadUrlTtlSeconds: 1, uploadCleanupGraceMs: 1000, uploadCleanupRetryMs: 10, clock: () => now });
  return { service, adapter, metadataStore, quotaLedger, objects, actions,
    advance: ms => { now = new Date(now.getTime() + ms); },
    failDelete: value => { deleteFails = value; }, conflictSeal: value => { sealConflicts = value; },
    begin: () => service.beginUpload({ workspaceId: 'workspace_a', filename: 'file.txt', mimeType: 'text/plain', size: 4, checksumSha256: checksum(Buffer.from('safe')) }) };
}

test('verification mismatch remains terminal, tracked and charged until deletion plus key sealing', async () => {
  const state = cleanupFixture();
  const begun = await state.begin();
  state.objects.set(begun.object.key, { size: 1000, checksumSha256: begun.object.checksumSha256 });
  await assert.rejects(() => state.service.completeUpload(begun.object.id), { code: 'UPLOAD_VERIFICATION_FAILED' });
  assert.equal((await state.service.getObject(begun.object.id)).state, 'upload-cleanup-pending');
  await assert.rejects(() => state.service.scanObject(begun.object.id), { code: 'UPLOAD_REJECTED' });
  assert.deepEqual(await state.service.reapExpiredUploads(), { processed: 0, deleted: 0, deferred: 0 });
  assert.equal((await state.quotaLedger.usage('workspace_a')).reserved, 4);
  state.advance(2001);
  assert.deepEqual(await state.service.reapExpiredUploads(), { processed: 1, deleted: 1, deferred: 0 });
  assert.deepEqual(state.actions, ['delete', 'seal']);
  assert.equal(state.objects.get(begun.object.key).tombstone, true);
  assert.equal((await state.service.getObject(begun.object.id)).state, 'deleted');
  assert.equal((await state.quotaLedger.usage('workspace_a')).reserved, 0);
  await assert.rejects(() => state.service.createDownload(begun.object.id), { code: 'OBJECT_NOT_CLEAN' });
  assert.deepEqual(await state.service.reapExpiredUploads(), { processed: 0, deleted: 0, deferred: 0 });
});

for (const failure of ['delete', 'seal']) {
  test(`${failure} failure retains quota and persists sanitized cleanup retry across service restart`, async () => {
    const state = cleanupFixture();
    const begun = await state.begin();
    state.advance(2001);
    if (failure === 'delete') state.failDelete(true); else state.conflictSeal(true);
    assert.deepEqual(await state.service.reapExpiredUploads(), { processed: 1, deleted: 0, deferred: 1 });
    const pending = await state.service.getObject(begun.object.id);
    assert.equal(pending.state, 'upload-cleanup-pending');
    assert.doesNotMatch(JSON.stringify(pending), /must-not-leak/);
    assert.equal((await state.quotaLedger.usage('workspace_a')).reserved, 4);
    state.failDelete(false); state.conflictSeal(false); state.advance(11);
    const restarted = new ObjectStorageService({ adapter: state.adapter, metadataStore: state.metadataStore, quotaLedger: state.quotaLedger, scanner: { scan: async () => ({ status: 'clean' }) } });
    assert.equal((await restarted.reapExpiredUploads({ now: pending.cleanupAt })).deleted, 1);
    assert.equal(state.objects.get(begun.object.key).tombstone, true);
    assert.equal((await state.quotaLedger.usage('workspace_a')).reserved, 0);
  });
}

test('abandoned upload cleanup is bounded and excludes verified uploads', async () => {
  const state = cleanupFixture();
  const first = await state.begin();
  const verified = await state.begin();
  state.objects.set(verified.object.key, { size: 4, checksumSha256: verified.object.checksumSha256 });
  await state.service.completeUpload(verified.object.id);
  state.advance(2001);
  assert.equal((await state.service.reapExpiredUploads({ limit: 1 })).deleted, 1);
  assert.equal((await state.service.getObject(first.object.id)).state, 'deleted');
  assert.equal((await state.service.getObject(verified.object.id)).state, 'quarantine');
  assert.equal((await state.quotaLedger.usage('workspace_a')).used, 4);
  await assert.rejects(() => state.service.reapExpiredUploads({ limit: 0 }), { code: 'INVALID_CLEANUP_CONFIG' });
});

test('missing upload bytes are retryable until the cleanup deadline', async () => {
  const state = cleanupFixture();
  const begun = await state.begin();
  await assert.rejects(() => state.service.completeUpload(begun.object.id), { code: 'UPLOAD_VERIFICATION_FAILED' });
  assert.equal((await state.service.getObject(begun.object.id)).state, 'quarantine');
  state.objects.set(begun.object.key, { size: 4, checksumSha256: begun.object.checksumSha256 });
  const complete = await state.service.completeUpload(begun.object.id);
  assert.ok(complete.uploadCompletedAt);
  await state.service.completeUpload(begun.object.id);
  assert.deepEqual(await state.quotaLedger.usage('workspace_a'), { used: 4, reserved: 0, quota: 10 });
});

test('retained FileStore holds survive raw expiration and block quota reuse until sealed cleanup', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sinaloa-retained-upload-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileStore(root);
  await store.init();
  const ledger = new PersistentQuotaLedger(store, { defaultQuotaBytes: 10, reservationTtlMs: 1000 });
  const reservation = await ledger.reserve('workspace_a', 8);
  assert.equal(reservation.expiresAt, null);
  assert.deepEqual(await ledger.reclaimExpired(new Date(Date.now() + 86_400_000)), { releasedReservations: 0, releasedBytes: 0 });
  await assert.rejects(() => ledger.reserve('workspace_a', 3), { code: 'QUOTA_EXCEEDED' });
  await ledger.release(reservation.id);
  assert.equal((await ledger.usage('workspace_a')).reserved, 0);
});

test('local tombstone blocks a stale signed PUT from recreating an abandoned file', async t => {
  let now = new Date();
  const state = await createLocalService({ clock: () => now, uploadUrlTtlSeconds: 60, uploadCleanupGraceMs: 0 });
  t.after(() => rm(state.root, { recursive: true, force: true }));
  const begun = await state.service.beginUpload({ workspaceId: 'workspace_a', filename: 'late.txt', mimeType: 'text/plain', size: 4, checksumSha256: checksum(Buffer.from('safe')) });
  const token = new URL(begun.upload.url).pathname.split('/').at(-1);
  now = new Date(now.getTime() + 60_001);
  assert.equal((await state.service.reapExpiredUploads()).deleted, 1);
  await assert.rejects(() => state.adapter.putPresigned(token, Buffer.from('safe'), begun.upload.headers), { code: 'OBJECT_EXISTS' });
  assert.equal((await state.adapter.headObject(begun.object.key)).size, 0);
});

test('R2 cleanup fails closed when a late PUT wins the conditional tombstone race', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(options);
    if (options.method === 'PUT') return new Response(null, { status: 412 });
    return new Response(null, { status: 200, headers: { 'content-length': '4' } });
  };
  const adapter = new S3CompatibleObjectStorageAdapter({ provider: 'r2', endpoint: 'https://test.r2.cloudflarestorage.com', bucket: 'private-bucket', region: 'auto', accessKeyId: 'key', secretAccessKey: 'secret' });
  await assert.rejects(() => adapter.sealDeletedObject('objects/race'), { code: 'UPLOAD_CLEANUP_CONFLICT' });
  assert.equal(requests[0].headers['if-none-match'], '*');
  assert.equal(requests[0].body.length, 0);
});

test('R2 body reads stop at the configured bound even without Content-Length', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(11)); }, cancel() { cancelled = true; } }));
  const adapter = new S3CompatibleObjectStorageAdapter({ provider: 'r2', endpoint: 'https://test.r2.cloudflarestorage.com', bucket: 'private-bucket', region: 'auto', accessKeyId: 'key', secretAccessKey: 'secret', maxObjectBytes: 10 });
  await assert.rejects(() => adapter.getObject('objects/oversize'), { code: 'CHECKSUM_MISMATCH' });
  assert.equal(cancelled, true);
});

for (const evidence of ['scan-job', 'committed-quota']) {
  test(`legacy verified quarantine with ${evidence} is recovered rather than deleted`, async () => {
    const state = cleanupFixture();
    const started = await state.begin();
    const bytes = Buffer.from('safe');
    state.objects.set(started.object.key, { size: bytes.length, bytes, checksumSha256: checksum(bytes) });
    await state.metadataStore.updateUpload(started.object.id, { uploadExpiresAt: undefined, uploadCompletedAt: undefined, cleanupAt: undefined, createdAt: '2000-01-01T00:00:00.000Z' });
    const jobs = new InMemoryMalwareScanJobStore();
    const service = new ObjectStorageService({ adapter: state.adapter, metadataStore: state.metadataStore, quotaLedger: state.quotaLedger,
      scanner: { scan: async () => ({ status: 'clean' }) }, scanJobStore: jobs });
    if (evidence === 'scan-job') await service.scanLifecycle.enqueue(started.object.id);
    else await state.quotaLedger.commit(started.object.reservationId);
    assert.deepEqual(await service.reapExpiredUploads(), { processed: 1, deleted: 0, deferred: 1 });
    assert.deepEqual(state.actions, []);
    assert.equal((await service.getObject(started.object.id)).state, 'quarantine');
    assert.ok((await service.getObject(started.object.id)).uploadCompletedAt);
    assert.ok(await jobs.get(`scan_${started.object.id}`));
    const scanned = await service.processNextScan('restarted-worker');
    assert.equal(scanned.state, 'clean');
  });
}

test('verification persists scan work before a restart and never cleans it as abandoned', async () => {
  const state = cleanupFixture();
  const jobs = new InMemoryMalwareScanJobStore();
  const service = new ObjectStorageService({ adapter: state.adapter, metadataStore: state.metadataStore, quotaLedger: state.quotaLedger,
    scanner: { scan: async () => ({ status: 'clean' }) }, scanJobStore: jobs });
  const begun = await service.beginUpload({ workspaceId: 'workspace_a', filename: 'safe.txt', mimeType: 'text/plain', size: 4, checksumSha256: checksum(Buffer.from('safe')) });
  state.objects.set(begun.object.key, { size: 4, bytes: Buffer.from('safe'), checksumSha256: begun.object.checksumSha256 });
  await service.completeUpload(begun.object.id);
  assert.equal((await jobs.get(`scan_${begun.object.id}`)).status, 'queued');
  const restarted = new ObjectStorageService({ adapter: state.adapter, metadataStore: state.metadataStore, quotaLedger: state.quotaLedger,
    scanner: { scan: async () => ({ status: 'clean' }) }, scanJobStore: jobs });
  assert.equal((await restarted.reapExpiredUploads({ now: new Date(Date.now() + 86_400_000) })).processed, 0);
  assert.equal((await restarted.processNextScan('new-process')).state, 'clean');
});

test('FileStore metadata transaction protects verification against concurrent expired cleanup', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sinaloa-upload-fence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileStore(root);
  await store.init();
  let releaseHead;
  let reportHead;
  const startedHead = new Promise(resolve => { reportHead = resolve; });
  const headGate = new Promise(resolve => { releaseHead = resolve; });
  const bytes = Buffer.from('safe');
  let deleted = false;
  const adapter = {
    createPresignedUpload: async () => ({ url: 'https://objects.example.test/upload' }), createPresignedDownload: async () => ({}),
    headObject: async () => { reportHead(); await headGate; return { size: bytes.length, checksumSha256: checksum(bytes) }; }, getObject: async () => bytes,
    deleteObject: async () => { deleted = true; }, sealDeletedObject: async () => true
  };
  const metadata = new DocumentObjectMetadataStore(store);
  const ledger = new PersistentQuotaLedger(store, { defaultQuotaBytes: 10 });
  const options = { adapter, metadataStore: metadata, quotaLedger: ledger, scanner: { scan: async () => ({ status: 'clean' }) }, uploadUrlTtlSeconds: 1, uploadCleanupGraceMs: 0 };
  const writer = new ObjectStorageService(options);
  const cleaner = new ObjectStorageService(options);
  const begun = await writer.beginUpload({ workspaceId: 'workspace_a', filename: 'safe.txt', mimeType: 'text/plain', size: bytes.length, checksumSha256: checksum(bytes) });
  const verification = writer.completeUpload(begun.object.id);
  await startedHead;
  const cleanup = cleaner.reapExpiredUploads({ now: new Date(Date.now() + 86_400_000) });
  releaseHead();
  await verification;
  assert.equal((await cleanup).deleted, 0);
  assert.equal(deleted, false);
  assert.equal((await ledger.usage('workspace_a')).used, bytes.length);
});

test('durable upload-start failure rolls back both retained quota and cleanup metadata', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sinaloa-upload-start-rollback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileStore(root);
  await store.init();
  const adapter = {
    createPresignedUpload: async () => { throw new Error('signer unavailable'); },
    createPresignedDownload: async () => ({}), headObject: async () => null, getObject: async () => null, deleteObject: async () => {}
  };
  const metadata = new DocumentObjectMetadataStore(store);
  const ledger = new PersistentQuotaLedger(store, { defaultQuotaBytes: 10 });
  const service = new ObjectStorageService({ adapter, metadataStore: metadata, quotaLedger: ledger, scanner: { scan: async () => ({ status: 'clean' }) } });
  await assert.rejects(() => service.beginUpload({ workspaceId: 'workspace_a', filename: 'safe.txt', mimeType: 'text/plain', size: 4, checksumSha256: checksum(Buffer.from('safe')) }), /signer unavailable/);
  assert.equal((await ledger.usage('workspace_a')).reserved, 0);
  assert.deepEqual(await store.listJson(path.join('object-storage', 'quota-reservations')), []);
  assert.deepEqual(await store.listJson(path.join('object-storage', 'metadata')), []);
});
