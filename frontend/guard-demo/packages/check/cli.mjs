import { readFile } from 'node:fs/promises';
import { checkProof } from './index.mjs';

try {
  const [path, keyPath] = process.argv.slice(2);
  if (!path || !keyPath) throw new Error('Usage: npm run check -- proof.json trusted-evidence-keys.json');
  const proof = JSON.parse(await readFile(path, 'utf8'));
  const evidenceKeys = JSON.parse(await readFile(keyPath, 'utf8'));
  const { checks, verdict } = await checkProof(proof, { evidenceKeys });
  for (const { status, id } of checks) console.log(status, id);
  if (verdict === 'failed') process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
