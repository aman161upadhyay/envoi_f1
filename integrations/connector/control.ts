import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, rm, lstat } from 'node:fs/promises';
import path from 'node:path';
import { privateJson } from './store';
import { ConnectorSetupError } from './adapter';
import { HostTaskError, validateHostTask, type HostTaskReceipt, type HostTaskRequest } from './host-task';

export async function startControl(directory: string, identity: { runtime: string; address: string; apiUrl?: string }, stop: () => void,
  diagnostics: () => Record<string, unknown> = () => ({ status: 'running' }), sendTask?: (request: unknown) => Promise<HostTaskReceipt>) {
  const secret = randomBytes(32).toString('base64url');
  const startedAt = new Date().toISOString();
  const filename = path.join(directory, 'control.json');
  const server = createServer(async (req, res) => {
    const address = server.address();
    const expected = address && typeof address === 'object' ? `127.0.0.1:${address.port}` : '';
    const supplied = Buffer.from(req.headers.authorization || '');
    const token = Buffer.from(`Bearer ${secret}`);
    if (req.headers.host !== expected || req.headers.origin || supplied.length !== token.length || !timingSafeEqual(supplied, token)) {
      res.writeHead(403); res.end(); return;
    }
    if (req.method === 'GET' && (req.url === '/status' || req.url === '/doctor')) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ...identity, pid: process.pid, startedAt, ...diagnostics() })); return;
    }
    if (req.method === 'POST' && req.url === '/stop') { res.writeHead(202); res.end('{}'); stop(); return; }
    if (req.method === 'POST' && req.url === '/tasks' && sendTask) {
      res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store');
      if (req.headers['content-type'] !== 'application/json') { res.writeHead(415); res.end('{}'); req.resume(); return; }
      try {
        const chunks: Buffer[] = []; let length = 0;
        for await (const chunk of req) { length += chunk.length; if (length <= 65_536) chunks.push(Buffer.from(chunk)); }
        if (length > 65_536) { res.writeHead(413); res.end('{}'); return; }
        let input: unknown;
        try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HostTaskError('TASK_INVALID'); }
        const result = await sendTask(validateHostTask(input));
        res.writeHead(200); res.end(JSON.stringify(result));
      } catch (error) {
        // Never reflect upstream errors, tokens, payloads or private paths to a model/tool caller.
        const code = error instanceof HostTaskError ? error.code : 'TASK_SEND_UNCERTAIN';
        res.writeHead(error instanceof HostTaskError ? 409 : 503); res.end(JSON.stringify({ code }));
      }
      return;
    }
    res.writeHead(404); res.end();
  });
  server.requestTimeout = 5_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Control listener unavailable');
  try { await privateJson(filename, { version: 1, port: address.port, secret }); }
  catch (error) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); throw error; }
  return { close: async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    const current = await readFile(filename, 'utf8').then(text => JSON.parse(text)).catch(() => null);
    if (current?.secret === secret) await rm(filename, { force: true });
  } };
}
async function controlRecord(directory: string) {
  const filename = path.join(directory, 'control.json');
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2048) throw new ConnectorSetupError('CONTROL_INVALID', 'Invalid connector control file');
  let record: { version: number; port: number; secret: string };
  try { record = JSON.parse(await readFile(filename, 'utf8')); }
  catch { throw new ConnectorSetupError('CONTROL_INVALID', 'Invalid connector control file'); }
  if (!record || typeof record !== 'object' || Array.isArray(record) || record.version !== 1 || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535 || typeof record.secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(record.secret)) throw new ConnectorSetupError('CONTROL_INVALID', 'Invalid connector control file');
  return record;
}
export async function queryControl(directory: string, action: 'status' | 'stop' | 'doctor') {
  const record = await controlRecord(directory);
  // The control origin is always local and never accepted from a stored URL.
  const response = await fetch(`http://127.0.0.1:${record.port}/${action}`, {
    method: action === 'stop' ? 'POST' : 'GET', redirect: 'error',
    headers: { authorization: `Bearer ${record.secret}` }, signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) throw new ConnectorSetupError('CONNECTOR_UNREACHABLE', 'The connector is not responding to local management');
  return await response.json() as Record<string, unknown>;
}

export function controlIdentityMatches(value: unknown, expected: { runtime: string; address: string; apiUrl: string }): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && (value as Record<string, unknown>).runtime === expected.runtime
    && (value as Record<string, unknown>).address === expected.address
    && (value as Record<string, unknown>).apiUrl === expected.apiUrl;
}

/** Verify the saved owner before a local management action can affect a process. */
export async function queryOwnedControl(directory: string, action: 'status' | 'stop', expected: { runtime: string; address: string; apiUrl: string }) {
  const status = await queryControl(directory, 'status');
  if (!controlIdentityMatches(status, expected)) throw new ConnectorSetupError('CONTROL_INVALID', 'Local connector identity does not match this installation');
  return action === 'status' ? status : queryControl(directory, 'stop');
}

export async function sendTaskControl(directory: string, request: HostTaskRequest): Promise<HostTaskReceipt> {
  const task = validateHostTask(request);
  const record = await controlRecord(directory);
  const response = await fetch(`http://127.0.0.1:${record.port}/tasks`, {
    method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${record.secret}`, 'content-type': 'application/json' },
    body: JSON.stringify(task), signal: AbortSignal.timeout(35_000)
  });
  if (!response.ok) throw new HostTaskError('TASK_SEND_UNCERTAIN');
  const result = await response.json() as HostTaskReceipt;
  if (!result || result.state !== 'accepted' || result.requestId !== task.requestId || result.recipientAddress !== task.recipientAddress
    || typeof result.senderAddress !== 'string' || typeof result.replayed !== 'boolean') throw new HostTaskError('TASK_RESPONSE_INVALID');
  return { state: 'accepted', requestId: task.requestId, senderAddress: result.senderAddress,
    recipientAddress: task.recipientAddress, replayed: result.replayed };
}
