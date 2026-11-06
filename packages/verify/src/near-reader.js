// Read-only NEAR client for the checker. Plain JSON-RPC over fetch, no keys, no dependencies,
// so it runs in the browser and the CLI alike.
import { bytesToBase64Url } from './bytes.js';

export const DEFAULT_RPC = Object.freeze({
  'near-mainnet': 'https://free.rpc.fastnear.com',
  'near-testnet': 'https://test.rpc.fastnear.com',
});

export const EXPLORER = Object.freeze({
  'near-mainnet': { tx: hash => `https://nearblocks.io/txns/${hash}`, account: id => `https://nearblocks.io/address/${id}` },
  'near-testnet': { tx: hash => `https://testnet.nearblocks.io/txns/${hash}`, account: id => `https://testnet.nearblocks.io/address/${id}` },
});

const toBase64 = text => {
  const b64url = bytesToBase64Url(new TextEncoder().encode(text));
  return b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64url.length % 4)) % 4);
};

export const createNearReader = ({ network, rpcUrl = DEFAULT_RPC[network], fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) => {
  if (!rpcUrl) throw new Error(`no RPC URL for ${network}`);
  const view = async (contractId, methodName, args) => {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await fetchImpl(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 'envoi-verify', method: 'query',
          params: { request_type: 'call_function', finality: 'final', account_id: contractId, method_name: methodName, args_base64: toBase64(JSON.stringify(args)) },
        }),
        signal: controller?.signal,
      });
      if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
      const body = await response.json();
      if (body.error) throw new Error(`RPC error: ${body.error?.cause?.name ?? body.error?.message ?? 'unknown'}`);
      if (body.result?.error) throw new Error(`contract error: ${body.result.error}`);
      const bytes = Uint8Array.from(body.result.result);
      return JSON.parse(new TextDecoder().decode(bytes));
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  return {
    network,
    rootOf: (contractId, batchId) => view(contractId, 'root_of', { batch_id: batchId }),
    keysOf: (contractId, keyRef) => view(contractId, 'keys_of', { key_ref: keyRef }),
    last: contractId => view(contractId, 'last', {}),
  };
};
