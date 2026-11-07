// NEAR JSON-RPC client shared by the checker, the browser proxy and the testnet scripts.
//
// Errors come in two kinds, and callers must be able to tell them apart:
// - NearUnavailable (code NEAR_UNAVAILABLE): we couldn't get an answer (network down, timeout,
//   HTTP 429/5xx, or a node-side transient error). The checker reports these as "not checked".
// - NearRpcError: the network answered and said no (UNKNOWN_ACCOUNT, UNKNOWN_TRANSACTION, ...).
//   These are real answers and must keep failing a proof.
// With several URLs, each one is tried in order, but only after an unavailability error.

export const DEFAULT_RPC = Object.freeze({
  'near-testnet': ['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org'],
  'near-mainnet': ['https://free.rpc.fastnear.com', 'https://rpc.mainnet.near.org']
});

const TRANSIENT = new Set(['TIMEOUT_ERROR', 'INTERNAL_ERROR', 'NO_SYNCED_BLOCKS', 'NOT_SYNCED_YET', 'UNAVAILABLE_SHARD']);

export class NearUnavailable extends Error {
  constructor(message = 'NEAR RPC unavailable', options) {
    super(message, options);
    this.name = 'NearUnavailable';
    this.code = 'NEAR_UNAVAILABLE';
  }
}

export class NearRpcError extends Error {
  constructor(name, data) {
    super(name);
    this.name = 'NearRpcError';
    this.rpcError = name;
    this.data = data;
  }
}

export const isNearUnavailable = error => error?.code === 'NEAR_UNAVAILABLE';

export function createRpc(url = DEFAULT_RPC['near-testnet'], fetcher = fetch, { timeoutMs = 45000 } = {}) {
  const urls = (Array.isArray(url) ? url : [url]).filter(Boolean);
  if (!urls.length) throw new TypeError('No NEAR RPC URL');
  return async (method, params) => {
    let lastError;
    for (const endpoint of urls) {
      let response;
      try {
        response = await fetcher(endpoint, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'envoi', method, params }),
          signal: AbortSignal.timeout(timeoutMs)
        });
      } catch (error) {
        lastError = error;
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`NEAR RPC returned ${response.status}`);
        continue;
      }
      if (!response.ok) throw new NearRpcError(`HTTP_${response.status}`);
      let body;
      try { body = await response.json(); } catch (error) { lastError = error; continue; }
      const { result, error } = body ?? {};
      if (error) {
        const name = error.cause?.name ?? error.name ?? 'RPC_ERROR';
        if (TRANSIENT.has(name)) { lastError = new Error(name); continue; }
        throw new NearRpcError(name, error.data);
      }
      if (result === undefined) { lastError = new Error('Missing RPC result'); continue; }
      return result;
    }
    throw new NearUnavailable('NEAR RPC unavailable', { cause: lastError });
  };
}
