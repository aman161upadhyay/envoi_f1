import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPlaybackState, advancePlayback, playbackDelay, selectScenario, togglePlayback, acceptedWaitlistResponse, visibleFeatureCount } from '../src/scripts/playback.mjs';

const scenarios = JSON.parse(await readFile(new URL('../src/data/scenarios.json', import.meta.url)));

test('default auth links use the beta public origin and backend WorkOS routes', async () => {
  const website = await readFile(new URL('../src/components/Website.astro', import.meta.url), 'utf8');
  const exampleEnv = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
  const astroConfig = await readFile(new URL('../astro.config.mjs', import.meta.url), 'utf8');
  assert.ok(astroConfig.includes("site: 'https://www.envoi-agents.com'"));
  assert.ok(website.includes('content="https://www.envoi-agents.com/og-image.png"'));
  for (const [name, route] of [['SIGN_IN', 'sign-in'], ['SIGN_UP', 'sign-up']]) {
    const url = `https://www.envoi-agents.com/api/auth/workos/${route}`;
    assert.ok(website.includes(`import.meta.env.PUBLIC_${name}_URL || '${url}'`));
    assert.ok(exampleEnv.includes(`PUBLIC_${name}_URL=${url}`));
  }
});

test('the locked website toolchain excludes the reported vulnerable versions', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(manifest.scripts['audit:security'], 'npm audit --audit-level=low');
  assert.match(manifest.scripts.check, /npm run audit:security/);
  for (const [dependency, minimum] of [['astro', [7, 4, 2]], ['sharp', [0, 35, 5]], ['esbuild', [0, 28, 1]]]) {
    const installed = lock.packages[`node_modules/${dependency}`];
    if (!installed && dependency !== 'astro') continue;
    assert.ok(installed, dependency);
    const version = installed.version.split('.').map(Number);
    const difference = version.findIndex((part, index) => part !== minimum[index]);
    assert.ok(difference === -1 || version[difference] > minimum[difference], `${dependency}@${installed.version}`);
  }
});


test('the client deck is the first and default demo without removing other scenarios', async () => {
  assert.deepEqual(scenarios.map(scenario => scenario.id), ['client-deck', 'bed-frame', 'dinner']);
  const thread = await readFile(new URL('../src/components/Thread.astro', import.meta.url), 'utf8');
  assert.match(thread, /aria-selected=\{index === 0/);
  assert.match(thread, /hidden=\{index !== 0\}/);
});

test('automatic playback reveals exactly one step and stops at the receipt', () => {
  let state = createPlaybackState(5);
  assert.equal(state.visibleCount, 1);
  state = advancePlayback(state);
  assert.equal(state.visibleCount, 2);
  for (let iteration = 0; iteration < 8; iteration++) state = advancePlayback(state);
  assert.equal(state.visibleCount, 5);
});

test('every demo reveals its full conversation at a readable pace', () => {
  for (const scenario of scenarios) {
    let state = createPlaybackState(scenario.steps.length);
    let elapsed = 0;
    while (state.visibleCount < state.stepCount) {
      elapsed += playbackDelay(state);
      state = advancePlayback(state);
    }
    assert.equal(elapsed, (scenario.steps.length - 1) * 850, scenario.id);
    assert.equal(playbackDelay(state), 2600);
  }
});

test('paused playback never advances', () => {
  const state = { ...createPlaybackState(5), paused: true };
  assert.deepEqual(advancePlayback(state), state);
});

test('pause preserves the current message and play resumes from it', () => {
  const current = advancePlayback(createPlaybackState(5));
  const paused = togglePlayback(current);
  assert.equal(paused.visibleCount, 2);
  assert.deepEqual(advancePlayback(paused), paused);
  const resumed = togglePlayback(paused);
  assert.equal(resumed.visibleCount, 2);
  assert.equal(advancePlayback(resumed).visibleCount, 3);
  assert.deepEqual(togglePlayback(selectScenario(5)), createPlaybackState(5));
});

test('manual scenario selection reveals all messages and stops automatic progression', () => {
  const state = selectScenario(7);
  assert.equal(state.visibleCount, 7);
  assert.equal(state.manual, true);
  assert.deepEqual(advancePlayback(state), state);
});

test('reduced motion renders complete static conversations', () => {
  const state = createPlaybackState(7, true);
  assert.equal(state.visibleCount, 7);
  assert.deepEqual(advancePlayback(state), state);
});

test('every scenario uses known senders, demo timestamps and a complete authorization record', () => {
  for (const scenario of scenarios) {
    assert.ok(scenario.subject);
    const allowedSenders = [...scenario.agents.map(agent => agent.id), 'policy', 'receipt', 'human', 'file'];
    for (const step of scenario.steps) {
      assert.ok(allowedSenders.includes(step.from));
      assert.match(step.time, /^\d{1,2}:\d{2} [AP]M$/);
      assert.ok(step.text);
    }
    const finalStep = scenario.steps.at(-1);
    assert.ok(finalStep.auth.authorizedBy);
    assert.ok(finalStep.auth.humanApproval);
    assert.ok(finalStep.auth.shared);
    assert.ok(scenario.steps.some(step => step.from === 'policy'));
  }
});

test('client sharing remains blocked for human review in the illustration', () => {
  const finalStep = scenarios.find(scenario => scenario.id === 'client-deck').steps.at(-1);
  assert.equal(finalStep.state, 'needs-human');
  assert.equal(finalStep.auth.humanApproval, 'Required before sharing');
  assert.equal(finalStep.auth.shared, 'Not sent to client');
});

test('every demo numbers feature markers in conversation order while preserving feature meaning', () => {
  for (const scenario of scenarios) {
    const markedSteps = scenario.steps.filter(step => step.marker);
    assert.deepEqual(markedSteps.map(step => step.marker), [1, 2, 3, 4], scenario.id);
    assert.equal(markedSteps[0].from, 'b', scenario.id);
    assert.ok(['policy', 'file'].includes(markedSteps[1].from), scenario.id);
    assert.equal(markedSteps[2].from, 'a', scenario.id);
    assert.ok(markedSteps[3].auth, scenario.id);
  }
});

test('product features reveal with their matching conversation markers', () => {
  for (const scenario of scenarios) {
    const markers = scenario.steps.map(step => step.marker ?? 0);
    const expected = scenario.id === 'client-deck' ? [1, 2, 3, 3, 4] : [1, 2, 3, 4];
    assert.deepEqual(expected.map((_, index) => visibleFeatureCount(markers, index + 1)), expected, scenario.id);
  }
});

test('feature descriptions match the reordered permission and handoff markers', async () => {
  const page = await readFile(new URL('../src/components/Website.astro', import.meta.url), 'utf8');
  const features = [...page.matchAll(/^  \['([^']+)',/gm)].map(match => match[1]);
  assert.deepEqual(features, [
    'Work across agent platforms.',
    'Scoped permissions and secure file exchange.',
    'Built for agents, not humans.',
    'Human oversight with complete auditability.'
  ]);
});

test('waitlist success requires HTTP success AND the existing API acceptance contract', () => {
  assert.equal(acceptedWaitlistResponse(true, { accepted: true }), true);
  for (const payload of [null, {}, { accepted: false }, { accepted: 'true' }, { success: true }]) assert.equal(acceptedWaitlistResponse(true, payload), false);
  assert.equal(acceptedWaitlistResponse(false, { accepted: true }), false);
});

test('copy uses no em dashes or fabricated activity metrics', async () => {
  const page = await readFile(new URL('../src/components/Website.astro', import.meta.url), 'utf8');
  assert.doesNotMatch(page + JSON.stringify(scenarios), /\u2014/);
  assert.doesNotMatch(page, /SOC 2 compliant|agents online|messages sent today|99\.9%/i);
});

test('titles do not use multiple short sentences', async () => {
  const sources = await Promise.all(['../src/components/Website.astro', '../src/components/Receipt.astro', '../src/components/WaitlistCard.astro'].map(file => readFile(new URL(file, import.meta.url), 'utf8')));
  for (const source of sources) {
    for (const match of source.matchAll(/<(h[123]|label)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
      const title = match[2].replace(/<[^>]*>/g, ' ').replace(/\{[^}]*\}/g, '').trim();
      assert.doesNotMatch(title, /[.!?]\s*\S/, title);
    }
  }
});

test('sample agent email addresses are not displayed on the website', async () => {
  const page = await readFile(new URL('../src/components/Website.astro', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /(?:rachel|john|hello)@envoi-agents\.com|class="address-chip"|class="closing-address"/i);
});

test('the hero signup area has a single primary action without an unrelated tagline', async () => {
  const page = await readFile(new URL('../src/components/Website.astro', import.meta.url), 'utf8');
  const hero = page.match(/<div class="hero-copy">([\s\S]*?)<\/section>/)[1];
  assert.equal((hero.match(/class="button primary hero-start"/g) || []).length, 1);
  assert.match(hero, /href=\{createAccountUrl\}>Start now/);
  assert.doesNotMatch(hero, /WaitlistCard|Join the waitlist/);
  assert.doesNotMatch(hero, /data-copy-invite|hero-aside|Agent collaboration across people/);
});

test('About uses the requested headline and workspace description without the old finance example', async () => {
  const page = await readFile(new URL('../src/components/Website.astro', import.meta.url), 'utf8');
  const description = page.match(/<p class="hero-description">([\s\S]*?)<\/p>/)[1];
  assert.equal(description, 'Envoi gives every agent its own address and secure workspace to connect, collaborate, negotiate, exchange files, schedule and complete tasks with the agents of people you trust.');
  assert.doesNotMatch(page, /Your finance agent can build a budget|Your recruiting agent can create a hiring plan/);
  assert.doesNotMatch(description, /Native messaging|scoped file access|approval gates|building infrastructure/);
  assert.match(page, /<h1 id="hero-title">Break your agents out of their silos<\/h1>/);
  assert.doesNotMatch(page, /Agents cannot reliably work across people, vendors, or systems/);
  assert.doesNotMatch(page, /class="plain-columns"|class="comparison-chart"/);
});

test('all illustrated owner names and initials use John consistently', async () => {
  const sources = await Promise.all(['../src/components/Website.astro', '../src/components/Handshake.astro'].map(file => readFile(new URL(file, import.meta.url), 'utf8')));
  assert.doesNotMatch(sources.join('') + JSON.stringify(scenarios), /Rachel|>R</);
  assert.match(sources[0], /class="owner-avatar">J<\/span><span>John's workspace/);
  for (const scenario of scenarios) {
    assert.deepEqual(scenario.agents.find(agent => agent.id === 'a'), { id: 'a', name: "John's agent", platform: 'Muse', logo: '/agents/muse.svg' });
    assert.equal(scenario.agents.find(agent => agent.id === 'b').platform, 'OpenClaw');
    assert.equal(scenario.agents.find(agent => agent.id === 'b').logo, '/agents/openclaw.svg');
  }
  assert.equal(scenarios.find(scenario => scenario.id === 'client-deck').steps.at(-1).tag, 'Needs John');
});

test('the collaboration diagram shows only the Envoi solution with named agent artwork', async () => {
  const diagram = await readFile(new URL('../src/components/Handshake.astro', import.meta.url), 'utf8');
  assert.match(diagram, /<figure[^>]*aria-labelledby="collaboration-visual-title"/);
  for (const label of ['With Envoi', 'Agent workspace', 'John reviews before sharing']) assert.ok(diagram.includes(label), label);
  assert.ok(diagram.indexOf('John reviews before sharing') < diagram.indexOf('class="agent-workspace"'));
  assert.doesNotMatch(diagram, /Illustrative workflow|Owner view|Direct collaboration/);
  assert.doesNotMatch(diagram, /Without Envoi|Manual relay|Owners pass messages/);
  assert.match(diagram, /src=\{first.logo\}/);
  assert.match(diagram, /src=\{second.logo\}/);
  assert.match(diagram, /\{first.name\}/);
  assert.match(diagram, /\{second.name\}/);
});

test('About has one centered dotted agent orbit and a compact data-request card beside its explanation', async () => {
  const page = await readFile(new URL('../src/components/Website.astro', import.meta.url), 'utf8');
  const orbit = await readFile(new URL('../src/components/AgentOrbit.astro', import.meta.url), 'utf8');
  const layout = await readFile(new URL('../src/styles/hero-refresh.css', import.meta.url), 'utf8');
  assert.equal((page.match(/<AgentOrbit \/>/g) || []).length, 1);
  assert.ok(page.indexOf('<AgentOrbit />') < page.indexOf('<Handshake />'));
  assert.match(page, /class="solution-copy"[\s\S]*class="hero-diagram"><Handshake \/>/);
  assert.match(orbit, /class="ambient-ring"/);
  assert.match(orbit, /\.ambient-ring \{[^}]*border: 1px dashed/);
  assert.match(orbit, /\{agent\.name\}/);
  assert.match(orbit, /src=\{agent\.logo\}/);
  assert.match(page, /PUBLIC_SIGN_UP_URL \|\| 'https:\/\/www\.envoi-agents\.com\/api\/auth\/workos\/sign-up'/);
  assert.match(orbit, /hero-agent-orbit 84s linear infinite/);
  assert.match(orbit, /\.ambient-agent-6 \{ animation-delay: -70s;/);
  for (const [name, path] of [['Hermes', 'hermes.png'], ['Anthropic', 'anthropic.svg']]) {
    assert.ok(orbit.includes(`name: '${name}', logo: '/agents/${path}'`));
    assert.ok((await readFile(new URL(`../public/agents/${path}`, import.meta.url))).length > 100);
  }
  assert.match(layout, /\.hero-ambient \{[^}]*left: 50%; top: calc\(50% \+ 20px\); transform: translate\(-50%, -50%\)/);
  assert.match(layout, /\.solution-showcase \{ display: grid; grid-template-columns:/);
  assert.match(layout, /@media \(max-width: 980px\) \{\s*:where\(html\[data-page="about"\]\) \.solution-showcase \{ grid-template-columns: 1fr;/);
  assert.match(layout, /\.hero-copy \{[^}]*text-align: center/);
  assert.match(layout, /\.main-nav \{[^}]*justify-self: center/);
  const flow = await readFile(new URL('../src/components/Handshake.astro', import.meta.url), 'utf8');
  assert.match(flow, /Request Q4 revenue data/);
  assert.match(flow, /Q4 figures attached/);
  assert.match(flow, /request-slide 8s/);
  assert.match(flow, /reply-slide 8s/);
});

test('diagram labels remain readable instead of shrinking to tiny mobile text', async () => {
  const diagram = await readFile(new URL('../src/components/Handshake.astro', import.meta.url), 'utf8');
  const fontSizes = [...diagram.matchAll(/font-size:\s*(\d+)px/g)].map(match => Number(match[1]));
  assert.ok(fontSizes.length > 0);
  assert.ok(fontSizes.every(size => size >= 14));
  assert.match(diagram, /@media \(max-width: 600px\)/);
  assert.match(diagram, /\.direct-route \{ grid-template-columns: minmax\(66px, 1fr\)/);
});

test('the removed inbox positioning is absent from the website and share metadata', async () => {
  for (const file of ['../src/components/Website.astro', '../src/pages/share.astro']) {
    const page = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(page, /an inbox for your agent/i);
  }
});

test('About and Product have separate static routes and accessible active-page navigation', async () => {
  const about = await readFile(new URL('../src/pages/index.astro', import.meta.url), 'utf8');
  const product = await readFile(new URL('../src/pages/product.astro', import.meta.url), 'utf8');
  const website = await readFile(new URL('../src/components/Website.astro', import.meta.url), 'utf8');
  assert.match(about, /<Website page="about"/);
  assert.match(product, /<Website page="product"/);
  assert.match(website, /aria-current=\{isAbout/);
  assert.match(website, /aria-current=\{isProduct/);
  assert.match(website, /href="\/product\/"/);
});

test('footer links point to real sections rather than placeholder legal or social pages', async () => {
  const footer = await readFile(new URL('../src/components/Footer.astro', import.meta.url), 'utf8');
  for (const label of ['Product', 'Agents', 'Company', 'Access']) assert.ok(footer.includes(`<h2>${label}</h2>`));
  assert.doesNotMatch(footer, /href="#"|Product Hunt|Launch YC|Twitter|LinkedIn|\/privacy|\/terms/);
  assert.match(footer, /\/product\/#your-view/);
  assert.match(footer, /\/#how-it-works/);
});

test('the header keeps the circle mark and the full logo appears above the About headline', async () => {
  const page = await readFile(new URL('../src/components/Website.astro', import.meta.url), 'utf8');
  const header = page.match(/<header\b[\s\S]*?<\/header>/)[0];
  const hero = page.match(/<div class="hero-copy">([\s\S]*?)<div class="hero-diagram">/)[1];
  assert.match(header, /<BrandLogo mark decorative \/>/);
  assert.match(hero, /<div class="hero-brand"><BrandLogo \/><\/div>\s*<h1 id="hero-title">/);
});

test('sections keep their main headings without numbered eyebrow labels', async () => {
  const page = await readFile(new URL('../src/components/Website.astro', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /<p\b[^>]*class="eyebrow"[^>]*>\s*\d{2}\s*\//);
  for (const headingId of ['mechanism-title', 'product-title', 'features-title']) assert.ok(page.includes(`id="${headingId}"`));
});

test('Product has one main inbox headline without the duplicate introduction', async () => {
  const page = await readFile(new URL('../src/components/Website.astro', import.meta.url), 'utf8');
  const footer = await readFile(new URL('../src/components/Footer.astro', import.meta.url), 'utf8');
  assert.match(page, /<h1 id="product-title">Track your agents\u2019 work in different email threads<\/h1>/);
  assert.doesNotMatch(page, /product-intro|product-overview-title|Native messaging between agents with human oversight/);
  assert.doesNotMatch(page, /id="oversight"|Set the terms|<Receipt|import Receipt/);
  assert.match(footer, /href="\/product\/#feature-4">Permissions & approvals/);
  assert.doesNotMatch(footer, /href="\/product\/#oversight"/);
});

test('the owner view uses the requested email-thread heading without its old supporting copy', async () => {
  const page = await readFile(new URL('../src/components/Website.astro', import.meta.url), 'utf8');
  assert.match(page, /<h1 id="product-title">Track your agents\u2019 work in different email threads<\/h1>/);
  assert.doesNotMatch(page, /Review the work<br \/> waiting on you|for Thursday's client review|Illustrative product view/);
});

test('conversation and inbox typography stays comfortably sized at every breakpoint', async () => {
  const styles = await readFile(new URL('../src/styles/site.css', import.meta.url), 'utf8');
  const requiredSizes = new Map([
    ['.message-card p', 16], ['.from-policy .message-card p', 16], ['.message-meta', 14],
    ['.message-kind', 14], ['.message-header time', 14], ['.agent-name', 16],
    ['.scenario-tabs button', 14], ['.receipt-details > div', 14],
    ['.inbox-row-copy > strong', 16], ['.inbox-row-copy > span:not(.status)', 14],
    ['.inbox-row-copy .status', 14], ['.product-detail p', 16], ['.product-detail dl', 14],
    ['.file-preview strong', 14], ['.file-preview span', 14], ['.owner-chip', 16]
  ]);
  for (const [selector, minimumSize] of requiredSizes) {
    const declarations = styles.split('\n').filter(line => line.trim().startsWith(`${selector} {`));
    assert.ok(declarations.length, selector);
    for (const declaration of declarations) {
      const size = declaration.match(/font(?:-size)?:\s*(?:300\s+)?(\d+)px/);
      if (size) assert.ok(Number(size[1]) >= minimumSize, declaration);
    }
  }
});

test('reading text uses the light system font while action labels are larger and bold', async () => {
  const fonts = await readFile(new URL('../src/styles/fonts.css', import.meta.url), 'utf8');
  const tokens = await readFile(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../src/styles/site.css', import.meta.url), 'utf8');
  const hero = await readFile(new URL('../src/styles/hero-refresh.css', import.meta.url), 'utf8');
  const handshake = await readFile(new URL('../src/components/Handshake.astro', import.meta.url), 'utf8');
  assert.match(hero, /local\('Segoe UI Light'\)/);
  assert.match(hero, /:where\(html\[data-page="about"\]\):root \{\s*--display: 'Envoi UI', 'Segoe UI Light'/);
  assert.match(tokens, /--display: "Figtree Variable"/);
  assert.match(tokens, /--sans: var\(--display\)/);
  assert.match(tokens, /--mono: var\(--display\)/);
  assert.match(fonts, /url\('\/fonts\/figtree\.woff2'\)/);
  assert.match(styles, /body \{ font-weight: 300; \}/);
  for (const selector of ['.button', '.header-auth-link']) assert.match(styles, new RegExp(`${selector.replace('.', '\\.') } \\{[^}]*font-weight: 700;`));
  for (const source of [hero, handshake]) assert.doesNotMatch(source, /font-weight:\s*(?!300\b)\d+/);
});

test('About team cards use the supplied individual organization logos', async () => {
  const team = await readFile(new URL('../src/components/Team.astro', import.meta.url), 'utf8');
  const logoNames = ['mckinsey', 'harvard-business-school', 'adobe', 'classpass', 'diversio', 'sundai-hacker-club', 'n-logo', 'vit'];
  for (const name of logoNames) {
    assert.match(team, new RegExp(`src="/team/${name}\\.png"`));
    const image = await readFile(new URL(`../public/team/${name}.png`, import.meta.url));
    assert.equal(image.subarray(1, 4).toString(), 'PNG');
  }
  assert.doesNotMatch(team, /team-logos[^>]*><svg|team-logos[^>]*><image/);
});

test('the supplied brand images are available without replacing the logo lettering', async () => {
  for (const filename of ['envoi-brand.png', 'envoi-logo.png']) {
    const image = await readFile(new URL(`../public/${filename}`, import.meta.url));
    assert.equal(image.subarray(1, 4).toString(), 'PNG');
    assert.equal(image.readUInt32BE(16), 1024);
  }
});

test('brand text and button pairs retain AA contrast', async () => {
  const tokens = await readFile(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');
  const values = new Map([...tokens.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(match => [match[1], match[2].trim()]));
  const resolve = name => {
    const value = values.get(name);
    return value.startsWith('var(') ? resolve(value.slice(4, -1)) : value;
  };
  const luminance = hex => {
    const channels = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255).map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
    return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  };
  for (const [foreground, background] of [['--ink', '--bg'], ['--ink-muted', '--bg-raised'], ['--ink-dim', '--bg-sunken'], ['--accent', '--bg'], ['--agent-b', '--bg-raised'], ['--on-accent', '--brand-navy'], ['--needs-human-ink', '--needs-human-bg'], ['--confirmed', '--confirmed-bg']]) {
    const first = luminance(resolve(foreground));
    const second = luminance(resolve(background));
    const ratio = (Math.max(first, second) + .05) / (Math.min(first, second) + .05);
    assert.ok(ratio >= 4.5, `${foreground} on ${background}: ${ratio.toFixed(2)}`);
  }
});

test('every banner entry has locally served artwork with an official source recorded', async () => {
  const agents = JSON.parse(await readFile(new URL('../src/data/agents.json', import.meta.url)));
  assert.deepEqual(agents.map(agent => agent.name), ['Muse', 'OpenClaw', 'Dots', 'Instinct']);
  for (const agent of agents) {
    assert.match(agent.logo, /^\/agents\/[a-z]+\.(svg|ico)$/);
    assert.match(agent.source, /^https:\/\//);
    const asset = await readFile(new URL(`../public${agent.logo}`, import.meta.url));
    assert.ok(asset.length > 100);
    if (agent.logo.endsWith('.svg')) assert.doesNotMatch(asset.toString(), /<script\b|<foreignObject\b|(?:href|src)=["'](?:https?:|\/\/)/i);
  }
});

test('the logo banner supports accessible duplication and reduced-motion, focus and hover pauses', async () => {
  const banner = await readFile(new URL('../src/components/AgentsBanner.astro', import.meta.url), 'utf8');
  assert.match(banner, /aria-label="Agent platforms"/);
  assert.match(banner, /class="agents-marquee" aria-hidden="true"/);
  assert.match(banner, /prefers-reduced-motion: reduce/);
  assert.match(banner, /:focus-within/);
  assert.match(banner, /:hover/);
  assert.match(banner, /translateX\(-50%\)/);
  assert.match(banner, /data-banner-toggle/);
});
