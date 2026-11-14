import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const [, , destination] = process.argv;
if (!destination) throw new Error('Provide a destination directory for the static proof site.');

const files = [
  ['apps/web/public-proof.html', 'index.html'],
  'apps/web/public-proof.mjs',
  'apps/web/check.css',
  'adapters/near/read.mjs',
  'adapters/near/rpc.mjs',
  'packages/check/index.mjs',
  'packages/check/messages.mjs',
  'packages/check/deployment.mjs',
  'packages/core/case-grants.mjs',
  'packages/core/crypto.mjs',
  'packages/core/policy.mjs',
  'packages/core/tree.mjs',
  'packages/core/webauthn.mjs',
  'docs/acme-refused-payment.proof.json',
  'docs/acme-refused-payment-edited.proof.json'
];
for (const file of files) {
  const [source, target] = Array.isArray(file) ? file : [file, file];
  const output = resolve(destination, target);
  await mkdir(dirname(output), { recursive: true });
  await copyFile(new URL('../' + source, import.meta.url), output);
}
