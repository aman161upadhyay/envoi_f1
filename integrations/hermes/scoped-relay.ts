import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { bindScopedMcpTurn } from './scoped-mcp';
import { scopedMcpStdioSource } from './scoped-stdio';
import type { ScopedModelTurn } from '../agent-bridges/scoped-turn';

export async function startScopedMcpRelay(turn: ScopedModelTurn) {
  turn.signal.throwIfAborted();
  const bindings = new Map<string, ReturnType<typeof bindScopedMcpTurn>>();
  const queue = { pending: 0, tail: Promise.resolve<unknown>(undefined), closed: false };
  let ended = false;
  const active = () => !ended && !queue.closed && !turn.signal.aborted;
  const end = () => { ended = true; for (const binding of bindings.values()) binding.close(); };
  const token = randomBytes(32).toString('hex');
  const secret = Buffer.from(token);
  let expectedHost = '';
  let closing: Promise<void> | null = null;
  const send = (res: ServerResponse, status: number, payload?: string) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(payload);
  };
  const server = createServer((req, res) => { void handle(req, res).catch(() => {
    if (res.headersSent) res.destroy(); else send(res, 502, JSON.stringify({ error: 'Scoped MCP request unavailable' }));
  }); });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (req.headers.host !== expectedHost || req.headers.origin !== undefined) return send(res, 403);
    if (req.url !== '/mcp') return send(res, 404);
    const supplied = Buffer.from((req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!req.headers.authorization?.startsWith('Bearer ') || supplied.length !== secret.length || !timingSafeEqual(supplied, secret)) return send(res, 401);
    if (!active()) return send(res, 410);
    if (req.method !== 'POST') return send(res, 405);
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415);
    if (Number(req.headers['content-length']) > 262144) { send(res, 413); req.resume(); return; }
    const connectionId = req.headers['x-envoi-mcp-connection'];
    if (typeof connectionId !== 'string' || !/^[a-f0-9]{32}$/.test(connectionId)) return send(res, 400);
    let binding = bindings.get(connectionId);
    if (!binding) {
      if (bindings.size >= 32) return send(res, 429);
      // Hermes opens a new stdio process when discovery is repeated at admission.
      // Its MCP handshake is transport-local; authority and the call queue stay turn-local.
      binding = bindScopedMcpTurn({ ...turn, tools: turn.tools, signal: AbortSignal.any([turn.signal]), callTool: turn.callTool.bind(turn) }, queue);
      bindings.set(connectionId, binding);
    }
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 262144) return send(res, 413);
      chunks.push(chunk);
    }
    const reply = await binding.dispatch(Buffer.concat(chunks).toString('utf8'));
    if (!binding.active) end();
    if (!active()) return send(res, 410);
    return reply === null ? send(res, 204) : send(res, 200, reply);
  }

  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  } catch (error) { end(); throw error; }
  const address = server.address();
  if (!address || typeof address === 'string') { end(); server.close(); throw new Error('Private MCP relay unavailable'); }
  expectedHost = `127.0.0.1:${address.port}`;
  const url = `http://${expectedHost}/mcp`;
  const close = () => {
    end();
    turn.signal.removeEventListener('abort', onAbort);
    if (!closing) closing = new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    return closing;
  };
  const onAbort = () => { void close(); };
  turn.signal.addEventListener('abort', onAbort, { once: true });
  if (turn.signal.aborted) { await close(); turn.signal.throwIfAborted(); }
  return Object.freeze({
    close,
    get active() { return active(); },
    get discovered() { return [...bindings.values()].some(binding => binding.discovered); },
    get pendingCalls() { return queue.pending; },
    mcpServer: Object.freeze({ name: `envoi_turn_${randomBytes(8).toString('hex')}`, command: process.execPath,
      args: ['--input-type=module', '-e', scopedMcpStdioSource],
      env: [{ name: 'ENVOI_SCOPED_MCP_URL', value: url }, { name: 'ENVOI_SCOPED_MCP_TOKEN', value: token }] })
  });
}
