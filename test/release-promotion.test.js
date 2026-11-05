import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_SECRET_NAMES, RELEASE_ACCOUNT_ID, promotionPlan, requireBetaSecretNames, requireStagingSecretNames, requireSecretNames } from '../scripts/promote-release.mjs';
import { deployScanner } from '../scripts/deploy-scanner.mjs';
import { deployBetaBuild, readBetaBuildSource } from '../scripts/deploy-beta-build.mjs';
import { secretInventory } from '../scripts/promote-release.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { betaBuildDeployArgs } from '../scripts/deploy-beta-build.mjs';
import { deployStaging, stagingDeployArgs } from '../scripts/deploy-staging.mjs';
const main = 'a'.repeat(40);
const candidate = 'b'.repeat(40);
const defaults = { target: 'staging', sha: main, headSha: main, mainSha: main, clean: true, descendedFromMain: true };

test('promotion defaults to a dry-run on the explicit target and records the runtime SHA', () => {
  const plan = promotionPlan(defaults);
  assert.equal(plan.accountId, RELEASE_ACCOUNT_ID);
  assert.deepEqual(plan.args, ['deploy', '--env', 'staging', '--var', `ENVOI_RELEASE_SHA:${main}`, '--dry-run', '--containers-rollout=none']);
});
test('premerge candidate can be dry-run but cannot be published', () => {
  const input = { ...defaults, sha: candidate, headSha: candidate };
  assert.doesNotThrow(() => promotionPlan(input));
  assert.throws(() => promotionPlan({ ...input, deploy: true }), /merge and fetch/);
});
test('accepted main can publish only the explicit beta target', () => {
  assert.deepEqual(promotionPlan({ ...defaults, target: 'beta', deploy: true }).args,
    ['deploy', '--env', 'beta', '--var', `ENVOI_RELEASE_SHA:${main}`]);
});
for (const [name, overrides, message] of [
  ['old production target', { target: 'production' }, /explicit staging or beta/],
  ['unqualified target', { target: undefined }, /explicit staging or beta/],
  ['dirty tracked or untracked work', { clean: false }, /must be clean/],
  ['short SHA', { sha: 'aabbcc' }, /40-hex/],
  ['SHA mismatching source', { sha: candidate }, /exactly match/],
  ['candidate from old branch', { descendedFromMain: false }, /descend/]
]) test(`promotion refuses ${name}`, () => assert.throws(() => promotionPlan({ ...defaults, ...overrides }), message));

test('secret-name gate accepts encrypted names without reading values', () => {
  assert.doesNotThrow(() => requireSecretNames(APP_SECRET_NAMES.map(name => ({ name, type: 'secret_text' }))));
  // N2-config-2: only the data encryption key may still be held under its SINALOA_* name.
  const legacyKeyOnly = APP_SECRET_NAMES.map(name => ({ name: name === 'ENVOI_DATA_ENCRYPTION_KEY' ? 'SINALOA_DATA_ENCRYPTION_KEY' : name, type: 'secret_text' }));
  assert.doesNotThrow(() => requireSecretNames(legacyKeyOnly));
  assert.throws(() => requireSecretNames(APP_SECRET_NAMES.map(name => ({ name: name.replace('ENVOI_', 'SINALOA_'), type: 'secret_text' }))),
    /Missing encrypted runtime secrets: ENVOI_BETA_INVITED_EMAILS, ENVOI_POLICY_SIGNING_KEY, ENVOI_S3_ACCESS_KEY_ID, ENVOI_S3_SECRET_ACCESS_KEY, ENVOI_MALWARE_SCANNER_TOKEN$/);
});
test('secret-name gate reports only missing names and rejects plaintext vars', () => {
  assert.throws(() => requireSecretNames([{ name: 'DATABASE_URL', type: 'plain_text' }], ['DATABASE_URL']),
    /Missing encrypted runtime secrets: DATABASE_URL/);
});
test('secret-name gate allows a policy keyring and requires a separate scanner credential', () => {
  const names = APP_SECRET_NAMES.map(name => ({ name: name === 'ENVOI_POLICY_SIGNING_KEY' ? 'ENVOI_POLICY_SIGNING_KEYS' : name, type: 'secret_text' }));
  assert.doesNotThrow(() => requireSecretNames(names));
  assert.throws(() => requireSecretNames(names, ['ENVOI_SCANNER_TOKEN']), /ENVOI_SCANNER_TOKEN/);
});
// N2-config-2: beta holds SINALOA_* secrets until H-5 adds the ENVOI_* twins. Every beta deploy path
// refuses until then, except for the data encryption key, which may stay under its legacy name.
const secretList = names => names.map(name => ({ name, type: 'secret_text' }));
const betaInventory = ({ app, scanner }) => (...argv) => argv.includes('scanner/wrangler.beta.jsonc') ? secretList(scanner) : secretList(app);
const migratedApp = APP_SECRET_NAMES.map(name => name === 'ENVOI_DATA_ENCRYPTION_KEY' ? 'SINALOA_DATA_ENCRYPTION_KEY' : name);
const betaApp = [...migratedApp, 'ENVOI_MONAD_ISSUER_PRIVATE_KEY', 'ENVOI_WAKE_SIGNING_KEYS'];
test('beta deploys refuse until the ENVOI_* twins exist (H-5)', () => {
  const legacyApp = APP_SECRET_NAMES.map(name => name.replace('ENVOI_', 'SINALOA_'));
  assert.throws(() => requireBetaSecretNames(betaInventory({ app: legacyApp, scanner: ['ENVOI_SCANNER_TOKEN'] })), /ENVOI_BETA_INVITED_EMAILS/);
  assert.throws(() => requireBetaSecretNames(betaInventory({ app: migratedApp, scanner: ['ENVOI_SCANNER_TOKEN'] })), /ENVOI_MONAD_ISSUER_PRIVATE_KEY/);
  assert.throws(() => requireBetaSecretNames(betaInventory({ app: betaApp, scanner: ['SINALOA_SCANNER_TOKEN'] })), /ENVOI_SCANNER_TOKEN/);
  assert.doesNotThrow(() => requireBetaSecretNames(betaInventory({ app: betaApp, scanner: ['ENVOI_SCANNER_TOKEN'] })));
  const asked = [];
  requireBetaSecretNames((...argv) => { asked.push(argv); return betaInventory({ app: betaApp, scanner: ['ENVOI_SCANNER_TOKEN'] })(...argv); });
  assert.deepEqual(asked, [['--env', 'beta'], ['--config', 'scanner/wrangler.beta.jsonc']]);
});
test('an optional secret held only under a retired name is refused, not silently dropped', () => {
  for (const legacy of ['SINALOA_POLICY_SIGNING_KEYS', 'SINALOA_DB_CA', 'SINALOA_S3_SESSION_TOKEN']) {
    assert.throws(() => requireSecretNames(secretList([...migratedApp, legacy])), new RegExp(`held only under retired names: ${legacy}; add their ENVOI_\\* twins`));
    assert.doesNotThrow(() => requireSecretNames(secretList([...migratedApp, legacy, legacy.replace('SINALOA_', 'ENVOI_')])));
  }
});
test('secret inventory lists names in the pinned release account', () => {
  const calls = [];
  const run = (command, args, options) => { calls.push({ args: args.slice(1), account: options.env.CLOUDFLARE_ACCOUNT_ID }); return { status: 0, stdout: '[]' }; };
  assert.deepEqual(secretInventory({ cwd: process.cwd(), env: { CLOUDFLARE_ACCOUNT_ID: 'someone-else' }, run }, '--env', 'beta'), []);
  assert.deepEqual(calls, [{ args: ['secret', 'list', '--env', 'beta'], account: RELEASE_ACCOUNT_ID }]);
});
test('scanner deploys check the target scanner token name before running Wrangler', async () => {
  for (const [target, config] of [['staging', 'scanner/wrangler.jsonc'], ['beta', 'scanner/wrangler.beta.jsonc']]) {
    const runs = [];
    const asked = [];
    const run = (command, args, options) => { runs.push({ args: args.slice(1), account: options.env.CLOUDFLARE_ACCOUNT_ID }); return { status: 0 }; };
    const inventory = names => (...argv) => { asked.push(argv); return secretList(names); };
    await assert.rejects(deployScanner(target, { inventory: inventory(['SINALOA_SCANNER_TOKEN']), run }), /ENVOI_SCANNER_TOKEN/);
    assert.equal(runs.length, 0);
    await deployScanner(target, { inventory: inventory(['ENVOI_SCANNER_TOKEN']), run });
    assert.deepEqual(asked, [['--config', config], ['--config', config]]);
    assert.deepEqual(runs, [{ args: ['deploy', '--config', config], account: RELEASE_ACCOUNT_ID }]);
  }
  await assert.rejects(deployScanner('production', { inventory: () => [], run: () => ({ status: 0 }) }), /staging\|beta/);
});
test('the direct beta deploy checks secret names before running Wrangler', async () => {
  const runs = [];
  const run = (command, args) => { runs.push(args.slice(1)); return { status: 0 }; };
  const source = () => ({ headSha: main, mainSha: main, clean: true, descendedFromMain: true });
  await assert.rejects(deployBetaBuild({ inventory: betaInventory({ app: betaApp, scanner: ['SINALOA_SCANNER_TOKEN'] }), run, source }), /ENVOI_SCANNER_TOKEN/);
  assert.equal(runs.length, 0);
  await deployBetaBuild({ inventory: betaInventory({ app: betaApp, scanner: ['ENVOI_SCANNER_TOKEN'] }), run, source });
  assert.deepEqual(runs, [['deploy', '--env', 'beta', '--var', `ENVOI_RELEASE_SHA:${main}`]]);
});
test('automatic beta Builds pins the exact Git SHA and never selects the old production Worker', () => {
  assert.deepEqual(betaBuildDeployArgs(main), ['deploy', '--env', 'beta', '--var', `ENVOI_RELEASE_SHA:${main}`]);
  assert.throws(() => betaBuildDeployArgs('short-sha'), /full Git commit SHA/);
});
test('staging deploy stamps the checked-out SHA on the explicit staging target', () => {
  assert.deepEqual(stagingDeployArgs({ sha: main, clean: true }), ['deploy', '--env', 'staging', '--var', `ENVOI_RELEASE_SHA:${main}`]);
});
for (const [name, input, message] of [
  ['dirty tracked or untracked work', { sha: main, clean: false }, /clean worktree/],
  ['short SHA', { sha: 'aabbcc', clean: true }, /40-hex/],
  ['uppercase SHA', { sha: 'A'.repeat(40), clean: true }, /40-hex/],
  ['missing SHA', { sha: '', clean: true }, /40-hex/]
]) test(`staging deploy refuses ${name}`, () => assert.throws(() => stagingDeployArgs(input), message));
test('staging deploy refuses an untracked file before invoking Wrangler', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'envoi-staging-deploy-'));
  try {
    const git = (...argv) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', ...argv], { cwd, stdio: 'ignore' });
    git('init', '-q');
    // A local config that hides untracked files must not hide them from the deploy check.
    git('config', 'status.showUntrackedFiles', 'no');
    git('commit', '-q', '--allow-empty', '-m', 'base');
    await writeFile(join(cwd, 'stray.txt'), 'uncommitted');
    await assert.rejects(deployStaging({ cwd, env: {} }), /clean worktree/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('both staging secret inventories are checked on their isolated targets', () => {
  const calls = [];
  requireStagingSecretNames((...args) => {
    calls.push(args);
    return secretList(args.includes('scanner/wrangler.jsonc') ? ['ENVOI_SCANNER_TOKEN'] : migratedApp);
  });
  assert.deepEqual(calls, [['--env', 'staging'], ['--config', 'scanner/wrangler.jsonc']]);
});

test('direct staging refuses missing app or scanner names before deploying, and preserves the legacy encryption key', async () => {
  const runs = [];
  const inventories = [];
  const run = (_command, args, options) => { runs.push({ args: args.slice(1), account: options.env.CLOUDFLARE_ACCOUNT_ID }); return { status: 0 }; };
  const readGit = (...args) => args[0] === 'rev-parse' ? main : '';
  const inventory = (app, scanner) => (...args) => {
    inventories.push(args);
    return secretList(args.includes('scanner/wrangler.jsonc') ? scanner : app);
  };
  await assert.rejects(deployStaging({ inventory: inventory(migratedApp.filter(name => name !== 'ENVOI_POLICY_SIGNING_KEY'), ['ENVOI_SCANNER_TOKEN']), readGit, run }), /ENVOI_POLICY_SIGNING_KEY/);
  await assert.rejects(deployStaging({ inventory: inventory(migratedApp, ['SINALOA_SCANNER_TOKEN']), readGit, run }), /ENVOI_SCANNER_TOKEN/);
  assert.deepEqual(runs, []);
  await deployStaging({ inventory: inventory(migratedApp, ['ENVOI_SCANNER_TOKEN']), readGit, run, env: { CLOUDFLARE_ACCOUNT_ID: 'wrong-account' } });
  assert.deepEqual(runs, [{ args: ['deploy', '--env', 'staging', '--var', `ENVOI_RELEASE_SHA:${main}`], account: RELEASE_ACCOUNT_ID }]);
  assert.ok(inventories.every(args => !args.includes('beta') && !args.includes('scanner/wrangler.beta.jsonc')));
});

for (const [label, overrides, expected] of [
  ['dirty source', { clean: false }, /must be clean/],
  ['unmerged branch', { headSha: candidate }, /merge and fetch/],
  ['divergent branch', { headSha: candidate, descendedFromMain: false }, /descend/],
  ['invalid source SHA', { headSha: 'short' }, /40-hex/]
]) test(`direct beta refuses ${label} before secret access or deployment`, async () => {
  const calls = [];
  await assert.rejects(deployBetaBuild({
    source: () => ({ headSha: main, mainSha: main, clean: true, descendedFromMain: true, ...overrides }),
    inventory: () => { calls.push('inventory'); return secretList(migratedApp); },
    run: () => { calls.push('deploy'); return { status: 0 }; }
  }), expected);
  assert.deepEqual(calls, []);
});

test('direct beta stops if refreshing the main reference fails', async () => {
  const calls = [];
  await assert.rejects(deployBetaBuild({
    source: () => readBetaBuildSource({ cwd: process.cwd(), execute: () => { throw new Error('fetch failed'); } }),
    inventory: () => { calls.push('inventory'); return []; },
    run: () => { calls.push('deploy'); return { status: 0 }; }
  }), /fetch failed/);
  assert.deepEqual(calls, []);
});

test('beta source refreshes an advanced local origin/main and detects hidden untracked work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'envoi-beta-build-source-'));
  try {
    const remote = join(root, 'remote.git');
    const author = join(root, 'author');
    const build = join(root, 'build');
    const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(root, 'init', '--bare', '--quiet', remote);
    git(root, 'init', '-b', 'main', '--quiet', author);
    git(author, 'commit', '--quiet', '--allow-empty', '-m', 'accepted main');
    git(author, 'remote', 'add', 'origin', remote);
    git(author, 'push', '--quiet', 'origin', 'main');
    git(root, 'clone', '--quiet', '--branch', 'main', remote, build);
    const accepted = git(build, 'rev-parse', 'HEAD');
    git(author, 'commit', '--quiet', '--allow-empty', '-m', 'new main');
    git(author, 'push', '--quiet', 'origin', 'main');
    const advanced = git(author, 'rev-parse', 'HEAD');
    assert.equal(git(build, 'rev-parse', 'origin/main'), accepted, 'the checkout begins with a stale remote ref');
    assert.deepEqual(readBetaBuildSource({ cwd: build }), { headSha: accepted, mainSha: advanced, clean: true, descendedFromMain: false });
    git(build, 'config', 'status.showUntrackedFiles', 'no');
    await writeFile(join(build, 'stray.txt'), 'uncommitted');
    assert.equal(readBetaBuildSource({ cwd: build }).clean, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('explicit Hermes/OpenClaw profile serializes every flag and keeps Monad disabled', async () => {
  const { releaseProfileVars } = await import('../scripts/promote-release.mjs');
  const { onboardingFlagNames, readOnboardingFlags } = await import('../src/onboarding-flags.js');
  const vars = releaseProfileVars('hermes-openclaw');
  assert.equal(Object.isFrozen(vars), true);
  assert.deepEqual(Object.keys(vars).sort(), [...onboardingFlagNames, 'ENVOI_MONAD_PERMISSIONS'].sort());
  assert.deepEqual(Object.entries(vars).filter(([,value]) => value === 'true').map(([name]) => name).sort(),
    ['ENVOI_AGENT_REGISTRATION_V2', 'ENVOI_CASE_SESSIONS_V1', 'ENVOI_INSTALLATIONS_V2']);
  assert.equal(vars.ENVOI_MONAD_PERMISSIONS, 'false');
  assert.doesNotThrow(() => readOnboardingFlags(vars));
  assert.equal(releaseProfileVars(), null);
  for (const unknown of ['', null, 'default', 'monad', {}, 'hermes-openclaw --var ENVOI_REMOTE_MCP_OAUTH:true']) {
    assert.throws(() => releaseProfileVars(unknown), /Unsupported release profile/);
  }
  for (const target of ['staging', 'beta']) {
    const plan = promotionPlan({ target, sha: main, headSha: main, mainSha: main, clean: true, descendedFromMain: true,
      deploy: true, profile: 'hermes-openclaw' });
    assert.equal(plan.profile, 'hermes-openclaw');
    assert.deepEqual(plan.vars, vars);
    assert.deepEqual(plan.args, ['deploy', '--env', target, '--var', `ENVOI_RELEASE_SHA:${main}`,
      ...Object.entries(vars).flatMap(([name,value]) => ['--var', `${name}:${value}`])]);
  }
});

test('profile selection cannot bypass clean exact-source and main-ancestry gates', () => {
  const input = { target: 'beta', sha: main, headSha: main, mainSha: main, clean: true, descendedFromMain: true,
    deploy: true, profile: 'hermes-openclaw' };
  assert.throws(() => promotionPlan({ ...input, clean: false }), /clean/);
  assert.throws(() => promotionPlan({ ...input, headSha: candidate }), /exactly/);
  assert.throws(() => promotionPlan({ ...input, descendedFromMain: false }), /descend/);
  assert.throws(() => promotionPlan({ ...input, mainSha: candidate }), /equal fetched origin/);
  assert.throws(() => promotionPlan({ ...input, profile: 'other' }), /Unsupported release profile/);
});

test('core-only secret gate omits only disabled Monad and preserves all app/scanner protections', () => {
  const profile = { profile: 'hermes-openclaw' };
  const inventory = app => betaInventory({ app, scanner: ['ENVOI_SCANNER_TOKEN'] });
  assert.doesNotThrow(() => requireBetaSecretNames(inventory(migratedApp), profile));
  assert.throws(() => requireBetaSecretNames(inventory(migratedApp)), /ENVOI_MONAD_ISSUER_PRIVATE_KEY/);
  for (const name of migratedApp) {
    assert.throws(() => requireBetaSecretNames(inventory(migratedApp.filter(value => value !== name)), profile), /Missing encrypted/);
  }
  assert.throws(() => requireBetaSecretNames(betaInventory({ app: migratedApp, scanner: ['SINALOA_SCANNER_TOKEN'] }), profile), /ENVOI_SCANNER_TOKEN/);
  assert.throws(() => requireBetaSecretNames(inventory([...migratedApp, 'SINALOA_DB_CA']), profile), /retired names/);
  let accessed = false;
  assert.throws(() => requireBetaSecretNames(() => { accessed = true; return []; }, { profile: 'other' }), /Unsupported release profile/);
  assert.equal(accessed, false);
});

test('release CLI refuses duplicate or arbitrary profile flags before source or secret access', async () => {
  const { promoteRelease } = await import('../scripts/promote-release.mjs');
  for (const flags of [ ['--profile=other'], ['--profile'], ['--profile=hermes-openclaw','--profile=hermes-openclaw'],
    ['--deploy','--deploy'], ['--profile=hermes-openclaw','--var=ENVOI_REMOTE_MCP_OAUTH:true'] ]) {
    await assert.rejects(promoteRelease(['beta', main, ...flags], { cwd: 'missing-profile-source-must-not-be-read' }), /Usage:/);
  }
});


test('beta-only preservation profile retains live Monad and its issuer secret gate', async () => {
  const { releaseProfileVars } = await import('../scripts/promote-release.mjs');
  const vars = releaseProfileVars('hermes-openclaw-preserve-monad');
  assert.deepEqual(vars, { ...releaseProfileVars('hermes-openclaw'), ENVOI_MONAD_PERMISSIONS: 'true' });
  assert.equal(Object.isFrozen(vars), true);
  const input = { target: 'beta', sha: main, headSha: main, mainSha: main, clean: true, descendedFromMain: true,
    deploy: true, profile: 'hermes-openclaw-preserve-monad' };
  const plan = promotionPlan(input);
  assert.deepEqual(plan.vars, vars);
  assert.deepEqual(plan.args, ['deploy', '--env', 'beta', '--var', `ENVOI_RELEASE_SHA:${main}`,
    ...Object.entries(vars).flatMap(([name,value]) => ['--var', `${name}:${value}`])]);
  assert.throws(() => promotionPlan({ ...input, target: 'staging' }), /beta only/);
  const profile = { profile: input.profile };
  assert.throws(() => requireBetaSecretNames(betaInventory({ app: migratedApp, scanner: ['ENVOI_SCANNER_TOKEN'] }), profile), /ENVOI_MONAD_ISSUER_PRIVATE_KEY/);
  assert.doesNotThrow(() => requireBetaSecretNames(betaInventory({ app: betaApp, scanner: ['ENVOI_SCANNER_TOKEN'] }), profile));
  assert.throws(() => requireBetaSecretNames(betaInventory({ app: betaApp.filter(name => name !== 'WORKOS_API_KEY'), scanner: ['ENVOI_SCANNER_TOKEN'] }), profile), /WORKOS_API_KEY/);
});

test('preserve-Monad cannot enable staging or choose conflicting CLI profiles before source access', async () => {
  const { promoteRelease } = await import('../scripts/promote-release.mjs');
  const options = { cwd: 'missing-profile-source-must-not-be-read' };
  await assert.rejects(promoteRelease(['staging', main, '--profile=hermes-openclaw-preserve-monad'], options), /beta only/);
  await assert.rejects(promoteRelease(['staging', main, '--deploy', '--profile=hermes-openclaw-preserve-monad'], options), /beta only/);
  for (const profiles of [ ['--profile=hermes-openclaw','--profile=hermes-openclaw-preserve-monad'],
    ['--profile=hermes-openclaw-preserve-monad','--profile=hermes-openclaw'],
    ['--profile=hermes-openclaw-preserve-monad','--profile=hermes-openclaw-preserve-monad'] ]) {
    await assert.rejects(promoteRelease(['beta', main, ...profiles], options), /Usage:/);
  }
});

test('configured beta native wake requires its existing signing-key secret before deployment',()=>{
  assert.throws(()=>requireBetaSecretNames(betaInventory({app:betaApp.filter(name=>name!=='ENVOI_WAKE_SIGNING_KEYS'),scanner:['ENVOI_SCANNER_TOKEN']})),/ENVOI_WAKE_SIGNING_KEYS/);
});
