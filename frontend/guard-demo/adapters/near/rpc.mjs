// NEAR JSON-RPC client shared by the checker, the browser proxy and the testnet scripts.
//
// Errors come in two kinds, and callers must be able to tell them apart:
// - NearUnavailable (code NEAR_UNAVAILABLE): we couldn't get an answer (network down, timeout,
//   HTTP 429/5xx, or a node-side transient error). The checker reports these as "not checked".
// - NearRpcError: the network answered and said no (UNKNOWN_ACCOUNT, UNKNOWN_TRANSACTION, ...).
//   These are real answers and must keep failing a proof.
// With several URLs, each one is tried in order, but only after an unavailability error.

export const DEFAULT_RPC = Object.freeze({
  'near-testnet': Object.freeze(['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org']),
  'near-mainnet': Object.freeze(['https://free.rpc.fastnear.com', 'https://rpc.mainnet.near.org'])
});

// Regular RPC nodes keep only a few days of transactions (a 4-day-old seal already returns
// UNKNOWN_TRANSACTION there), so transaction lookups go to archival nodes first. Without this,
// a genuine proof stops verifying a few days after it was sealed, i.e. before judging.
export const DEFAULT_ARCHIVAL_RPC = Object.freeze({
  'near-testnet': Object.freeze(['https://archival-rpc.testnet.fastnear.com', 'https://archival-rpc.testnet.near.org']),
  'near-mainnet': Object.freeze(['https://archival-rpc.mainnet.fastnear.com', 'https://archival-rpc.mainnet.near.org'])
});
const ARCHIVAL_FOR = new Map(Object.keys(DEFAULT_RPC).map(network => [DEFAULT_RPC[network], DEFAULT_ARCHIVAL_RPC[network]]));
const HISTORY_METHODS = new Set(['tx', 'EXPERIMENTAL_tx_status']);

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

// `archivalUrls` defaults to the archival nodes of a default network list, and to none for a
// custom URL (such as the browser's same-origin proxy, which does its own archival lookups).
export function createRpc(url = DEFAULT_RPC['near-testnet'], fetcher = fetch, { timeoutMs = 45000, archivalUrls = ARCHIVAL_FOR.get(url) ?? [] } = {}) {
  const urls = (Array.isArray(url) ? url : [url]).filter(Boolean);
  if (!urls.length) throw new TypeError('No NEAR RPC URL');
  const archival = archivalUrls.filter(Boolean);
  return async (method, params) => {
    const history = HISTORY_METHODS.has(method);
    const endpoints = history && archival.length ? [...archival, ...urls] : urls;
    let lastError;
    // For transaction lookups, one node not knowing a transaction isn't the final word (an
    // archival node can trail by a few blocks, a regular node forgets old ones). Ask the rest,
    // and report UNKNOWN_TRANSACTION only if nobody has it.
    let unknown = null;
    for (const endpoint of endpoints) {
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
      // 408 is what a node returns when it gave up waiting (for example for a transaction it
      // doesn't have yet); it's an outage for us, not a refusal.
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
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
        if (history && name === 'UNKNOWN_TRANSACTION') { unknown = new NearRpcError(name, error.data); continue; }
        throw new NearRpcError(name, error.data);
      }
      if (result === undefined) { lastError = new Error('Missing RPC result'); continue; }
      return result;
    }
    if (unknown) throw unknown;
    throw new NearUnavailable('NEAR RPC unavailable', { cause: lastError });
  };
}
