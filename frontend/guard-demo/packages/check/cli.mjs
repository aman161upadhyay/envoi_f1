import { readFile } from 'node:fs/promises';
import { checkProof } from './index.mjs';
import { nearReaders } from '../../adapters/near/read.mjs';
import { checkIds, verifyReceipt } from '../../adapters/nearai/screen.mjs';

try {
  const [path, keyPath, mode] = process.argv.slice(2);
  if (!path || !keyPath || (mode && mode !== '--testnet')) {
    throw new Error('Usage: npm run check -- proof.json trusted-evidence-keys.json [--testnet]');
  }
  const proof = JSON.parse(await readFile(path, 'utf8'));
  const evidenceKeys = JSON.parse(await readFile(keyPath, 'utf8'));
  let trust = { evidenceKeys };
  if (mode === '--testnet') {
    process.loadEnvFile();
    const env = process.env;
    if (![env.NEAR_RECORD_CONTRACT, env.NEAR_SPEND_CONTRACT, env.NEAR_PUBLISHER_ACCOUNT]
      .every(account => account?.endsWith('.testnet')) || !env.NEAR_RECORD_CODE_HASH) {
      throw new Error('Configure the trusted testnet contracts, publisher and published record code hash.');
    }
    trust = { ...trust, ...nearReaders({
      rpcUrl: env.NEAR_RPC_URL || 'https://rpc.testnet.near.org', recordContract: env.NEAR_RECORD_CONTRACT,
      spendContract: env.NEAR_SPEND_CONTRACT, publisher: env.NEAR_PUBLISHER_ACCOUNT, recordCodeHash: env.NEAR_RECORD_CODE_HASH
    }), verifyScreen: async evidence => {
      const result = await verifyReceipt(evidence);
      return checkIds.every(id => result[id] === true);
    } };
  }
  const { checks, verdict } = await checkProof(proof, trust);
  for (const { status, id } of checks) console.log(status, id);
  if (verdict === 'failed') process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
