import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDeploymentConfiguration } from './check-deployment.mjs';
import { CONTAINER_LEGACY_FALLBACKS } from '../worker/runtime-config.js';
import { orphanedLegacyNames } from '../src/envoi-environment.js';
import { onboardingFlagNames } from '../src/onboarding-flags.js';

export const RELEASE_ACCOUNT_ID = '54a5d6c680bd813fa60f8e088b098b8d';
export const APP_SECRET_NAMES = Object.freeze([
  'DATABASE_URL', 'WORKOS_API_KEY', 'WORKOS_COOKIE_PASSWORD',
  'ENVOI_BETA_INVITED_EMAILS', 'ENVOI_DATA_ENCRYPTION_KEY',
  'ENVOI_POLICY_SIGNING_KEY', 'ENVOI_S3_ACCESS_KEY_ID',
  'ENVOI_S3_SECRET_ACCESS_KEY', 'ENVOI_MALWARE_SCANNER_TOKEN'
]);

export function requireSecretNames(inventory, required = APP_SECRET_NAMES) {
  if (!Array.isArray(inventory)) throw new Error('Worker secret inventory must be a JSON array');
  const names = new Set(inventory.filter(item => item?.type === 'secret_text').map(item => item.name));
  // N2-config-2: only the data encryption key may still be held under its SINALOA_* name, as the
  // Worker forwards it (worker/runtime-config.js). Every other secret needs its ENVOI_* name.
  const hasSecret = name => names.has(name) || (CONTAINER_LEGACY_FALLBACKS[name] !== undefined && names.has(CONTAINER_LEGACY_FALLBACKS[name]));
  const missing = required.filter(name => !hasSecret(name)
    && !(name === 'ENVOI_POLICY_SIGNING_KEY' && hasSecret('ENVOI_POLICY_SIGNING_KEYS')));
  if (missing.length) throw new Error(`Missing encrypted runtime secrets: ${missing.join(', ')}`);
  // An optional secret (a policy keyring, a DB CA, a session token) held only as SINALOA_* would be
  // dropped without an error, because the Worker no longer forwards it.
  const orphaned = orphanedLegacyNames(names);
  if (orphaned.length) throw new Error(`Encrypted runtime secrets held only under retired names: ${orphaned.join(', ')}; add their ENVOI_* twins`);
}

// Names and types of a Worker's encrypted secrets. Values are never fetched or logged.
export function secretInventory({ cwd, env, run = spawnSync }, ...argv) {
  const wrangler = resolve(cwd, 'node_modules/wrangler/bin/wrangler.js');
  const result = run(process.execPath, [wrangler, 'secret', 'list', ...argv], {
    cwd, env: { ...env, CLOUDFLARE_ACCOUNT_ID: RELEASE_ACCOUNT_ID }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.error || result.status !== 0) throw new Error('Could not verify encrypted secret names in the intended Cloudflare account');
  try { return JSON.parse(result.stdout); }
  catch { throw new Error('Worker secret inventory was not valid JSON'); }
}

// N2-config-2: beta still holds SINALOA_* secrets until its ENVOI_* twins are added (H-5). Every beta
// deploy path checks names first, so code that no longer reads the old names cannot reach beta early.
// The default beta path retains its separately reviewed Monad gate. Only the
// fixed core-only profile can omit that unused credential, never a caller's flag.
export function requireBetaSecretNames(inventory, { profile } = {}) {
  const vars = releaseProfileVars(profile);
  const required = vars?.ENVOI_MONAD_PERMISSIONS === 'false'
    ? APP_SECRET_NAMES : [...APP_SECRET_NAMES, 'ENVOI_MONAD_ISSUER_PRIVATE_KEY'];
  // The configured beta route enables native wake; a missing signing key must
  // fail before deploying an image that cannot start with that configuration.
  const wakeKeys = vars?.ENVOI_HTTP_WAKE_V1 === 'false' ? [] : ['ENVOI_WAKE_SIGNING_KEYS'];
  requireSecretNames(inventory('--env', 'beta'), [...required, ...wakeKeys]);
  requireSecretNames(inventory('--config', 'scanner/wrangler.beta.jsonc'), ['ENVOI_SCANNER_TOKEN']);
}

export function requireStagingSecretNames(inventory) {
  requireSecretNames(inventory('--env', 'staging'));
  requireSecretNames(inventory('--config', 'scanner/wrangler.jsonc'), ['ENVOI_SCANNER_TOKEN']);
}

// Explicit release selection; the source/default deployment configuration stays
// unchanged. Serialize every flag so keep_vars cannot retain a broader profile.
export function releaseProfileVars(profile) {
  if (profile === undefined) return null;
  if (!['hermes-openclaw', 'hermes-openclaw-preserve-monad'].includes(profile)) throw new Error('Unsupported release profile');
  const core = new Set(['ENVOI_INSTALLATIONS_V2', 'ENVOI_AGENT_REGISTRATION_V2', 'ENVOI_CASE_SESSIONS_V1']);
  return Object.freeze({ ...Object.fromEntries(onboardingFlagNames.map(name => [name, core.has(name) ? 'true' : 'false'])),
    ENVOI_MONAD_PERMISSIONS: profile === 'hermes-openclaw-preserve-monad' ? 'true' : 'false' });
}

export function promotionPlan({ target, sha, headSha, mainSha, clean, descendedFromMain, deploy = false, profile }) {
  const vars = releaseProfileVars(profile);
  if (profile === 'hermes-openclaw-preserve-monad' && target !== 'beta') throw new Error('The preserve-Monad profile is beta only');
  if (!['staging', 'beta'].includes(target)) throw new Error('Choose the explicit staging or beta release target');
  for (const value of [sha, headSha, mainSha]) {
    if (!/^[a-f0-9]{40}$/.test(value || '')) throw new Error('Release and Git references must use full lowercase 40-hex SHAs');
  }
  if (!clean) throw new Error('Release worktree must be clean, including untracked files');
  if (headSha !== sha) throw new Error('Recorded release SHA must exactly match checked-out HEAD');
  if (!descendedFromMain) throw new Error('Release candidate must descend from fetched origin/main');
  if (deploy && sha !== mainSha) throw new Error('Live promotion requires HEAD to equal fetched origin/main; merge and fetch the reviewed fixes first');
  return {
    target, sha, accountId: RELEASE_ACCOUNT_ID, deploy, ...(vars ? { profile, vars } : {}),
    args: ['deploy', '--env', target, '--var', `ENVOI_RELEASE_SHA:${sha}`,
      ...Object.entries(vars || {}).flatMap(([name, value]) => ['--var', `${name}:${value}`]),
      ...(deploy ? [] : ['--dry-run', '--containers-rollout=none'])]
  };
}

export async function promoteRelease(args, { cwd = fileURLToPath(new URL('../', import.meta.url)), env = process.env } = {}) {
  const [target, sha, ...flags] = args;
  const profiles = flags.filter(flag => flag.startsWith('--profile='));
  if (flags.length > 2 || new Set(flags).size !== flags.length || profiles.length > 1
    || flags.some(flag => !['--deploy', '--profile=hermes-openclaw', '--profile=hermes-openclaw-preserve-monad'].includes(flag))) {
    throw new Error('Usage: node scripts/promote-release.mjs staging|beta FULL_SHA [--deploy] [--profile=hermes-openclaw|hermes-openclaw-preserve-monad]');
  }
  const profile = profiles[0]?.slice('--profile='.length);
  if (profile === 'hermes-openclaw-preserve-monad' && target !== 'beta') throw new Error('The preserve-Monad profile is beta only');
  const git = (...argv) => execFileSync('git', argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (flags.includes('--deploy')) git('fetch', 'origin', 'main');
  const headSha = git('rev-parse', 'HEAD');
  const mainSha = git('rev-parse', 'origin/main');
  const plan = promotionPlan({ target, sha, headSha, mainSha,
    clean: git('status', '--porcelain', '--untracked-files=all').length === 0,
    descendedFromMain: spawnSync('git', ['merge-base', '--is-ancestor', mainSha, headSha], { cwd }).status === 0,
    deploy: flags.includes('--deploy'), profile });
  await checkDeploymentConfiguration();
  const wrangler = resolve(cwd, 'node_modules/wrangler/bin/wrangler.js');
  const workerEnv = { ...env, CLOUDFLARE_ACCOUNT_ID: RELEASE_ACCOUNT_ID };
  if (plan.deploy) {
    const inventory = (...argv) => secretInventory({ cwd, env }, ...argv);
    if (target === 'beta') requireBetaSecretNames(inventory, { profile: plan.profile });
    else requireStagingSecretNames(inventory);
  }
  console.log(JSON.stringify({ target: plan.target, releaseSha: plan.sha, accountId: plan.accountId,
    action: plan.deploy ? 'deploy' : 'dry-run', ...(plan.profile ? { profile: plan.profile, vars: plan.vars } : {}),
    scope: 'Git identity, target configuration and (for deploy) secret names; live provider and product acceptance remain separate gates.' }));
  const result = spawnSync(process.execPath, [wrangler, ...plan.args], { cwd, env: workerEnv, stdio: 'inherit' });
  if (result.error) throw new Error('Unable to start Wrangler');
  if (result.status !== 0) throw new Error(`Wrangler ${plan.deploy ? 'deployment' : 'dry-run'} failed`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { await promoteRelease(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
