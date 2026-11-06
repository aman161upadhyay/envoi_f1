import { generateKeyPairSync } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { base58Encode } from '../adapters/near/sign.mjs';
import { validAccount } from '../packages/core/policy.mjs';

const owner = process.argv[2];
if (owner && (!validAccount(owner) || !owner.endsWith('.testnet') || ('publisher.' + owner).length > 64)) {
  throw new Error('Provide a named testnet owner with room for subaccounts.');
}
const template = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
const values = new Map();
for (const role of ['AGENT', 'PUBLISHER']) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  values.set('NEAR_' + role + '_PUBLIC_KEY', 'ed25519:' + base58Encode(raw));
  values.set('NEAR_' + role + '_PRIVATE_KEY', 'ed25519:' + base58Encode(Buffer.concat([seed, raw])));
}
if (owner) {
  values.set('NEAR_OWNER_ACCOUNT', owner);
  for (const [role, prefix] of Object.entries({
    SPEND_CONTRACT: 'spend', RECORD_CONTRACT: 'record', AGENT_ACCOUNT: 'milo',
    PUBLISHER_ACCOUNT: 'publisher', DEMO_PAYEE: 'ledger', DEMO_ATTACKER: 'attacker'
  })) values.set('NEAR_' + role, prefix + '.' + owner);
}
const result = template.replace(/^([A-Z_]+)=.*$/gm, (line, name) => values.has(name) ? name + '=' + values.get(name) : line);
try {
  await writeFile(new URL('../.env', import.meta.url), result, { flag: 'wx', mode: 0o600 });
  console.log('Created the ignored .env file. Add these public keys to the corresponding testnet accounts:');
  for (const [name, value] of values) if (!name.endsWith('_PRIVATE_KEY')) console.log(name + '=' + value);
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.error('.env already exists. Existing credentials were preserved.');
  process.exitCode = 1;
}
