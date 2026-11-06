import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

export async function serveChecker(samples, port = 4173) {
  const routes = new Map([
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
  const server = createServer((req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; frame-ancestors 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET') return res.writeHead(405, { Allow: 'GET' }).end();
    if (req.url === '/') return res.writeHead(302, { Location: '/permissions' }).end();
    const asset = assets.get(req.url);
    if (!asset) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': asset[1] }).end(asset[0]);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}
