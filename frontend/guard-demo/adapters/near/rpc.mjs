const testnetRpc = 'https://rpc.testnet.near.org';

export function createRpc(url = testnetRpc, fetcher = fetch) {
  return async (method, params) => {
    const response = await fetcher(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'envoi', method, params }),
      signal: AbortSignal.timeout(45000)
    });
    if (!response.ok) throw new Error('NEAR RPC unavailable');
    const { result, error } = await response.json();
    if (error || result === undefined) throw new Error(error?.cause?.name ?? 'Missing RPC result');
    return result;
  };
}
