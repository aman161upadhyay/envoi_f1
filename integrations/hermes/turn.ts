import { createHash } from 'node:crypto';
import { isHumanInstructionMessage, type WorkMessage } from '../../sdk/typescript/src/connector';
import { parseAgentReply, workPrompt, type AgentTurn, type BridgeLedger } from '../agent-bridges/bridge';
import { HermesRunStore } from './run-store';

type History = (caseId: string, group: boolean) => Promise<Array<Record<string, unknown>>>;

export interface HermesTurnOptions {
  apiUrl: string;
  apiKey: string;
  agentId: string;
  runs: HermesRunStore;
  replies: BridgeLedger;
  history?: History;
  fetch?: typeof fetch;
  pollIntervalMs?: number;
  maxRunMs?: number;
  allowEnvoiMcpWrites?: boolean;
  mcpReplySent?: (messageId: string) => Promise<boolean>;
  assetHandles?: Array<{ handle: string; filename: string }>;
  onActive?: (message: WorkMessage, signal: AbortSignal | null) => void;
}

function origin(value: string): string {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new TypeError('Hermes API requires HTTPS or loopback HTTP');
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new TypeError('Hermes API URL must be an origin');
  }
  return url.origin;
}

function sessionId(agentId: string, caseId: string) {
  return `envoi-${createHash('sha256').update(agentId).update('\0').update(caseId).digest('hex').slice(0, 40)}`;
}

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error('Hermes turn was interrupted'));
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(new Error('Hermes turn was interrupted')); };
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Wakes a Hermes API Server run for one claimed Envoi message. */
export function hermesTurn(options: HermesTurnOptions): AgentTurn {
  const base = origin(options.apiUrl);
  if (!options.apiKey || /[\r\n]/.test(options.apiKey)) throw new TypeError('Hermes API key is required');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(options.agentId)) throw new TypeError('Invalid Envoi agent ID');
  const pollMs = options.pollIntervalMs ?? 1_000;
  const maxRunMs = options.maxRunMs ?? 600_000;
  if (!Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 30_000) throw new RangeError('Invalid Hermes poll interval');
  if (!Number.isSafeInteger(maxRunMs) || maxRunMs < 1_000 || maxRunMs > 1_800_000) throw new RangeError('Invalid Hermes run timeout');
  const fetcher = options.fetch ?? fetch;
  const headers = { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' };

  async function stop(runId: string) {
    try { await fetcher(`${base}/v1/runs/${encodeURIComponent(runId)}/stop`, {
      method: 'POST', redirect: 'error', headers, signal: AbortSignal.timeout(5_000)
    }); } catch { /* Best effort; the same run remains recorded for recovery. */ }
  }

  return async (message: WorkMessage, signal: AbortSignal) => {
    if (signal.aborted) throw new Error('Hermes turn was interrupted');
    options.onActive?.(message, signal);
    let runId: string | undefined;
    try {
      const history = message.caseId && options.history ? await options.history(message.caseId, Boolean(message.groupCase)) : [];
      const request = {
        input: workPrompt(message, history, {
          allowEnvoiMcpWrites: options.allowEnvoiMcpWrites,
          assetHandles: options.assetHandles
        }),
        session_id: sessionId(options.agentId, message.id)
      };
      let record = await options.runs.create(message.id, request);
      runId = record.runId;
      if (!runId) {
        // Hermes retains idempotency reservations for 24 h after last status update.
        // Leave a one-hour margin for clock skew and delayed recovery.
        if (Date.now() - Date.parse(record.attemptedAt) >= 23 * 60 * 60 * 1_000) {
          throw new Error('Hermes run identity is uncertain; operator recovery is required');
        }
        const response = await fetcher(`${base}/v1/runs`, {
          method: 'POST', redirect: 'error', signal,
          headers: { ...headers, 'Idempotency-Key': record.idempotencyKey },
          body: JSON.stringify(record.request)
        });
        if (response.status !== 202) throw new Error(`Hermes run creation failed with HTTP ${response.status}`);
        let payload: unknown;
        try { payload = await response.json(); } catch { throw new Error('Hermes run creation returned invalid JSON'); }
        const id = payload && typeof payload === 'object' && !Array.isArray(payload)
          ? (payload as Record<string, unknown>).run_id : undefined;
        if (typeof id !== 'string') throw new Error('Hermes run creation returned no run ID');
        record = await options.runs.saveRunId(record, id);
        runId = record.runId;
      }
      if (!runId) throw new Error('Hermes run identity was not saved');
      while (!signal.aborted) {
        if (options.allowEnvoiMcpWrites && !isHumanInstructionMessage(message) && await options.mcpReplySent?.(message.id)) {
          if (signal.aborted) throw new Error('Hermes turn was interrupted');
          await stop(runId);
          if (signal.aborted) throw new Error('Hermes turn was interrupted');
          const stopped = { stop: true } as const;
          await options.replies.saveReply(message.id, stopped);
          return stopped;
        }
        const response = await fetcher(`${base}/v1/runs/${encodeURIComponent(runId)}`, {
          method: 'GET', redirect: 'error', headers, signal
        });
        if (!response.ok) throw new Error(`Hermes run status failed with HTTP ${response.status}; operator recovery may be required`);
        let payload: unknown;
        try { payload = await response.json(); } catch { throw new Error('Hermes run status returned invalid JSON'); }
        const result = payload && typeof payload === 'object' && !Array.isArray(payload)
          ? payload as Record<string, unknown> : null;
        if (!result || result.run_id !== runId || typeof result.status !== 'string') throw new Error('Hermes run status was invalid');
        if (result.status === 'completed') {
          if (signal.aborted) throw new Error('Hermes turn was interrupted');
          // The tool write marker must win before any reply is stored. Otherwise a
          // crash between this save and the outer wrapper could replay a REST reply.
          if (!isHumanInstructionMessage(message) && await options.mcpReplySent?.(message.id)) {
            const stopped = { stop: true } as const;
            await options.replies.saveReply(message.id, stopped);
            return stopped;
          }
          if (typeof result.output !== 'string') throw new Error('Hermes run had no completed text output');
          const reply = parseAgentReply(result.output);
          await options.replies.saveReply(message.id, reply);
          return reply;
        }
        if (['failed', 'cancelled', 'interrupted'].includes(result.status)) {
          throw new Error(`Hermes run ended ${result.status}; operator recovery may be required`);
        }
        if (!['started', 'queued', 'running', 'stopping', 'waiting_for_approval'].includes(result.status)) {
          throw new Error('Hermes run reported an unknown status');
        }
        if (Date.now() - Date.parse(record.attemptedAt) >= maxRunMs) {
          await stop(runId);
          throw new Error('Hermes run timed out');
        }
        await delay(pollMs, signal);
      }
      throw new Error('Hermes turn was interrupted');
    } finally {
      options.onActive?.(message, null);
      if (signal.aborted && runId) await stop(runId);
    }
  };
}
