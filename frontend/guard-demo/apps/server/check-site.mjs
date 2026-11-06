import { createRpc } from '../../adapters/near/rpc.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

export async function serveChecker(samples, port = 4173) {
  const routes = new Map([
    ['/demo', ['apps/web/replay.html', 'text/html; charset=utf-8']],
    ['/replay.css', ['apps/web/replay.css', 'text/css; charset=utf-8']],
    ['/replay.mjs', ['apps/web/replay.mjs', 'text/javascript; charset=utf-8']],
    ['/adapters/near/read.mjs', ['adapters/near/read.mjs', 'text/javascript; charset=utf-8']],
    ...['device', 'testnet'].map(name => [`/${name}.mjs`, [`apps/web/${name}.mjs`, 'text/javascript; charset=utf-8']]),
    ...['rpc', 'sign'].map(name => [`/adapters/near/${name}.mjs`, [`adapters/near/${name}.mjs`, 'text/javascript; charset=utf-8']]),
    ['/permissions', ['apps/web/permissions.html', 'text/html; charset=utf-8']],
    ['/permissions/evidence', ['apps/web/permissions.html', 'text/html; charset=utf-8']],
    ['/permissions.css', ['apps/web/permissions.css', 'text/css; charset=utf-8']],
    ['/permissions.mjs', ['apps/web/permissions.mjs', 'text/javascript; charset=utf-8']],
    ['/check', ['apps/web/check.html', 'text/html; charset=utf-8']],
    ['/check.css', ['apps/web/check.css', 'text/css; charset=utf-8']],
    ['/check.mjs', ['apps/web/check.mjs', 'text/javascript; charset=utf-8']],
    ['/packages/check/index.mjs', ['packages/check/index.mjs', 'text/javascript; charset=utf-8']],
    ...['crypto', 'policy', 'tree'].map(name => [`/packages/core/${name}.mjs`, [`packages/core/${name}.mjs`, 'text/javascript; charset=utf-8']])
  ]);
  const assets = new Map(await Promise.all(Array.from(routes, async ([route, [file, type]]) => [
    route, [await readFile(new URL('../../' + file, import.meta.url)), type]
  ])));
  assets.set('/demo-samples.json', [JSON.stringify(samples), 'application/json']);
  const rpc = createRpc();
  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/testnet-rpc' && samples.testnet) {
      const expectedOrigin = 'http://127.0.0.1:' + server.address().port;
      if (req.headers.origin !== expectedOrigin || req.headers['content-type'] !== 'application/json') {
        return res.writeHead(403).end();
      }
      try {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 65536) throw new Error('Request too large');
        }
        const { method, params } = JSON.parse(body);
        if (!['query', 'send_tx', 'tx'].includes(method)) throw new Error('Unsupported RPC method');
        const result = await rpc(method, params);
        return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ result }));
      } catch {
        return res.writeHead(502).end();
      }
    }
    res.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; frame-ancestors 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET') return res.writeHead(405, { Allow: 'GET' }).end();
    if (req.url === '/') return res.writeHead(302, { Location: '/permissions' }).end();
    const asset = assets.get(req.url.split('?')[0]);
    if (!asset) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': asset[1] }).end(asset[0]);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}
