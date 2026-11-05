import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDeploymentConfiguration } from './check-deployment.mjs';
import { RELEASE_ACCOUNT_ID, promotionPlan, requireBetaSecretNames, secretInventory } from './promote-release.mjs';

export function readBetaBuildSource({ cwd, execute = execFileSync }) {
  const git = (...argv) => execute('git', argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  // Match live promotion: never trust a stale origin/main from the build checkout.
  git('fetch', 'origin', 'main');
  const headSha = git('rev-parse', 'HEAD');
  const mainSha = git('rev-parse', 'origin/main');
  let descendedFromMain = false;
  try { git('merge-base', '--is-ancestor', mainSha, headSha); descendedFromMain = true; }
  catch { /* The existing promotion validator rejects a missing or divergent base. */ }
  return { headSha, mainSha, clean: git('status', '--porcelain', '--untracked-files=all').length === 0, descendedFromMain };
}

// Explicitly selected production messaging profile. These are the seven existing
// live values verified for the Dots release, not defaults for another environment.
export const DOTS_MESSAGING_VARS = Object.freeze({
  ENVOI_INSTALLATIONS_V2: 'true',
  ENVOI_AGENT_REGISTRATION_V2: 'true',
  ENVOI_CASE_SESSIONS_V1: 'true',
  ENVOI_HTTP_WAKE_V1: 'true',
  ENVOI_REMOTE_MCP_OAUTH: 'true',
  ENVOI_MCP_EVENTS_V1: 'true',
  ENVOI_MCP_EVENTS_CALLBACK_ORIGINS: 'https://connectors.api.openai.com'
});

export function betaBuildDeployArgs(sha, { profile } = {}) {
  if (!/^[a-f0-9]{40}$/.test(sha || '')) throw new Error('Beta build requires a full Git commit SHA');
  if (profile !== undefined && profile !== 'dots-messaging') throw new Error('Unsupported beta build profile');
  return ['deploy', '--env', 'beta', '--var', `ENVOI_RELEASE_SHA:${sha}`,
    ...Object.entries(profile === 'dots-messaging' ? DOTS_MESSAGING_VARS : {}).flatMap(([name, value]) => ['--var', `${name}:${value}`])];
}

export async function deployBetaBuild({ cwd = fileURLToPath(new URL('../', import.meta.url)), env = process.env, profile,
  inventory = (...argv) => secretInventory({ cwd, env }, ...argv), run = spawnSync,
  source = () => readBetaBuildSource({ cwd }) } = {}) {
  await checkDeploymentConfiguration();
  const identity = source();
  const plan = promotionPlan({ ...identity, target: 'beta', sha: identity.headSha, deploy: true });
  const args = betaBuildDeployArgs(plan.sha, { profile });
  requireBetaSecretNames(inventory);
  const sha = plan.sha;
  const wrangler = resolve(cwd, 'node_modules/wrangler/bin/wrangler.js');
  const result = run(process.execPath, [wrangler, ...args], {
    cwd, env: { ...env, CLOUDFLARE_ACCOUNT_ID: RELEASE_ACCOUNT_ID }, stdio: 'inherit'
  });
  if (result.error || result.status !== 0) throw new Error('Beta build deployment failed');
  console.log(`Beta Worker deployed from ${sha}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const flags = process.argv.slice(2);
    if (flags.length > 1 || flags.some(flag => flag !== '--profile=dots-messaging')) {
      throw new Error('Usage: node scripts/deploy-beta-build.mjs [--profile=dots-messaging]');
    }
    await deployBetaBuild({ profile: flags.length ? 'dots-messaging' : undefined });
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
