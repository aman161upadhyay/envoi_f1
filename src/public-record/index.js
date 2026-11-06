// The PublicRecord interface. All chain code lives in this folder and in contracts/; the rest
// of the server only talks to these functions. Adapters: `local` (dev, CI) and `near`.
//
// interface SealInput   { batchId: number; root: Hex32; previousRoot: Hex32 | null; count: number }
// interface SealReceipt { network: string; contractId: string; txRef: string; explorerUrl?: string }
// interface KeyInput    { kind: 'envoi'|'owner'|'owner_demo'; keyRef: string; keyId: string; fingerprint: Hex32; alg: string; prevSigRef?: string|null }
// interface PublicRecord {
//   readonly network: string; readonly contractId: string;
//   publish(input: SealInput): Promise<SealReceipt>;
//   registerKey(input: KeyInput): Promise<SealReceipt>;
//   status(txRef: string): Promise<{ status: 'submitted'|'final'|'failed'; finalAt?: Date; error?: string }>;
//   readRoot(batchId: number): Promise<{ root, previousRoot, count, sealedAt: Date } | null>;
//   reader(): { network, rootOf(contractId, batchId), keysOf(contractId, keyRef), last(contractId) }   // for packages/verify
//   health(): Promise<{ ok: boolean; balance?: string; detail?: string }>;
// }
//
// Config: PUBLIC_RECORD_NETWORKS=local | near-testnet | near-mainnet (comma separated for several).
import networks from './networks.json' with { type: 'json' };
import { createLocalPublicRecord } from './local.js';

export const NETWORK_IDS = Object.freeze(Object.keys(networks));

export { HEX32, assertSealInput, assertKeyInput } from './validate.js';

export const networkConfig = id => {
  const config = networks[id];
  if (!config) throw new Error(`unknown public record network ${id}`);
  return config;
};

// Builds every configured adapter. NEAR adapters are loaded lazily so dev and CI never need
// near-api-js credentials.
export const createPublicRecords = async (env = process.env) => {
  const ids = String(env.PUBLIC_RECORD_NETWORKS || 'local').split(',').map(s => s.trim()).filter(Boolean);
  const records = [];
  for (const id of ids) {
    const config = networkConfig(id);
    if (config.kind === 'local') records.push(createLocalPublicRecord({ path: env.PUBLIC_RECORD_LOCAL_PATH }));
    else {
      const { createNearPublicRecord } = await import('./near.js');
      records.push(createNearPublicRecord({
        network: id,
        contractId: env[config.contractEnv] || config.contractId,
        rpcUrl: env[config.rpcEnv] || config.rpcUrl,
        publisherId: env[config.publisherIdEnv],
        publisherKey: env[config.publisherKeyEnv],
      }));
    }
  }
  return records;
};

// Readers for packages/verify, keyed by network.
export const readersFor = records => Object.fromEntries(records.map(r => [r.network, r.reader()]));
