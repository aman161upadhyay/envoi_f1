import assert from 'node:assert/strict';
import test from 'node:test';
import { serveChecker } from '../apps/server/check-site.mjs';

test('browser checker serves the shared code and rejects uploads', async () => {
  const server = await serveChecker({ evidenceKeys: {}, genuine: {}, edited: {} }, 0);
  try {
    const request = (url, method = 'GET') => {
      let status;
      let body;
      let headers;
      const response = {
        setHeader() {},
        writeHead(code, fields) { status = code; headers = fields; return this; },
        end(value) { body = String(value ?? ''); }
      };
      server.emit('request', { url, method }, response);
      return { status, body, headers };
    };
    for (const route of ['/permissions', '/permissions/evidence', '/permissions/evidence/demo-record']) {
      const page = request(route);
      assert.equal(page.status, 200);
      assert.match(page.body, /Save changes/);
    }
    assert.equal(request('/').headers.Location, '/cases/acme-q4-review');
    assert.match(request('/cases/acme-q4-review').body, /Acme Q4 review/);
    assert.match(request('/demo').body, /Offline replay/);
    assert.equal(request('/replay.mjs').status, 200);
    assert.equal(request('/packages/core/case-grants.mjs').status, 200);
    const page = request('/check?sample=genuine');
    assert.equal(page.status, 200);
    assert.match(page.body, /Checked on your device/);
    const library = request('/packages/check/index.mjs');
    assert.equal(library.status, 200);
    assert.match(library.body, /export async function checkProof/);
    assert.equal(request('/check', 'POST').status, 405);
    assert.equal(request('/.env').status, 404);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
