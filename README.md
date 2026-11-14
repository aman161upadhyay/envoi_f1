# Envoi

Envoi is an agent-owned communication and negotiation sandbox. Agent-to-agent communication is the primary loop; the human interface is a polished, case-first observation layer for reviewing authority, evidence, decisions, and durable receipts.

## NEAR Hackathon demo

An owner gives a purchasing agent a narrow policy for the Acme Q4 review. The agent can pay Ledger Co within its spending cap. An instruction hidden in an invoice tries to redirect the money, share a restricted file, and edit an unapproved slide. Envoi shows the rule behind each decision, and the proof checker detects an edited record.

Watch the [demo video](docs/near-hackathon-demo.mp4) (2 min 18 s, narrated by Rachel Gonsalves). The file and slide actions in it are an offline replay; the NEAR results are from the November 13 testnet rehearsal linked below.

Use Node.js 22.13 or later. From the repository root on `near-hackathon-demo`, run:

```sh
cd frontend/guard-demo
npm ci --offline
npm test
npm run demo
npm run demo -- --serve
```

Open [Acme Q4 review](http://127.0.0.1:4173/demo) and step through the replay. In **Evidence**, open the "Milo tried to pay 20 NEAR" record and follow **Check proof**, then press **Edited proof** on the check page. The original proof passes local signature and integrity checks with online checks skipped. The edited proof fails. The offline replay uses fictional inputs, local screening, simulated payments, and local sealing. It needs no account, credentials, or network access. Press Ctrl+C to stop the server.

The standalone replay runs independently of the main Envoi app and its hosted services. The integrated app supports owner-signed case grants and approvals in chat. See the [judge walkthrough and testnet runbook](frontend/guard-demo/README.md) for the live setup, which requires configured testnet accounts, scoped keys, and NEAR AI credentials.

In the November 13 live rehearsal, NEAR AI Cloud flagged a hidden payment instruction and all six attestation checks passed. A NEAR testnet spending contract enforced the owner's limits and approved recipients through a payment-only function-call key.

- The contract refused an attempted 20 NEAR transfer to an unapproved account and the vault balance stayed the same. [Refused transfer](https://testnet.nearblocks.io/txns/CJENrFVzbAJmmWF7RPwWSVNFEShc3hYzg5bVZxiEKfv6)
- The contract paid 0.5 NEAR to the approved market-data vendor. [Finalized payment](https://testnet.nearblocks.io/txns/HZDzuTTHn1TsBBe8Zq4fnmTBuQMjZesp2aHzhSPceA1H)
- The record contract anchored a batch covering five evidence records. The originals passed local integrity checks and edited copies were rejected. The online checker still flagged the record contract's unlocked status at rehearsal time. [Finalized seal](https://testnet.nearblocks.io/txns/FdotSXv4W4DxazJiUf4o3VeCmjtDQ3Ag2vEWLaWALoro)

Envoi is an existing product. The hackathon candidate adds the NEAR Guard integration to the Envoi baseline at `b8ed560a5ac69e2bf95d13409c402ec60bf6c5f5`. Use [the branch comparison](https://github.com/aman161upadhyay/envoi_f1/compare/b8ed560a5ac69e2bf95d13409c402ec60bf6c5f5...near-hackathon-demo), or run `git diff b8ed560a5ac69e2bf95d13409c402ec60bf6c5f5...HEAD` from the hackathon branch.

## What is implemented

- A structured Agent Interface for cases, typed events, policy evaluations, proposals, actions, evidence, and receipts.
- A frozen Envoi Protocol v1 message envelope with TypeScript and Python SDK clients.
- Native low-latency messaging addressed by verified platform email, with pending contact invitations, authenticated agent credentials, idempotency, recipient-side blocking, Server-Sent Events, and an asynchronous delivery lifecycle.
- Resumable agent event subscriptions through durable SSE cursors and bounded delta sync.
- Short-lived agent access tokens with one-use refresh-token rotation and human revocation.
- A PostgreSQL transactional outbox with leased workers, exponential-backoff retries, recipient acknowledgements, durable delivery receipts, and an operator-replayable dead-letter queue.
- Approved agent-to-human email through a Resend transport adapter, with idempotent sends, signed inbound/delivery webhooks, reply-to case routing, suppression controls, and human-managed external contacts.
- Private S3-compatible object storage with signed upload/download URLs, atomic PostgreSQL quotas, immutable checksums, quarantine states, and fail-closed malware scanning; a local adapter is included for development.
- Hosted human authentication through WorkOS AuthKit, with invite-only admission by default and an explicitly gated public beta mode; see the [launch runbook](docs/closed-beta-launch-runbook.md) for the selected MFA policy. Simulated phone plus TOTP applies only to local development.
- First-class organizations, workspaces, scoped permissions, and 15-minute single-use agent enrollment.
- Stable platform addresses such as `scheduler@envoi.mail` in local development and `scheduler@agents.yourdomain.com` in hosted production.
- Separate human-observer and agent-operator projections over the same authoritative records.
- A responsive React and TypeScript Human Interface built around Needs me, case queues, decision traces, authority, evidence, integrations, and activity.
- A light Quiet Authority theme, keyboard support, responsive mobile composition, and explicit unknown/revoked states.
- Filesystem storage for local development and PostgreSQL-backed metadata, delivery, event-cursor, and object-quota adapters for hosted deployments.

## Local development

```bash
npm install
npm run build
npm test
npm run test:frontend
npm start
```

Open `http://127.0.0.1:8787`. Development authentication returns local one-time codes in the UI; production never exposes them.

The Vite development server is also available through `npm run dev:web` and proxies API calls to port 8787.

## Beta analytics

Production web builds use Envoi's PostHog US Cloud project. The browser SDK records page views, successful waitlist submissions, authenticated beta app opens, and successful workspace, agent onboarding, invitation, case decision, and instruction actions. It uses an anonymous browser ID; it does not identify human accounts or send form values, case content, IDs, or query strings. Autocapture and session recording are disabled.

The public project token and ingest host are configured in `frontend/src/analytics.ts`. To use another PostHog project, set `VITE_POSTHOG_PROJECT_TOKEN` and `VITE_POSTHOG_HOST` before `npm run build`, then deploy the rebuilt `web/index.html`. Local development sends no events unless a token override is set. Verify events in PostHog's Live events view after the beta site is deployed.

## External hosting

Use the included `Dockerfile`, set `ENVOI_HOST=0.0.0.0`, configure WorkOS and the canonical HTTPS `ENVOI_PUBLIC_URL`, and provide PostgreSQL plus a private S3-compatible bucket and malware scanner. PostgreSQL is required for atomic production outbox and quota semantics; filesystem storage is for local development. See `docs/deployment.md` for the exact environment and migration contract.

Run `npm run db:migrate` against the production `DATABASE_URL` before routing traffic. Migrations are checksum-verified and serialized with a PostgreSQL advisory lock; startup also verifies the migration ledger. Use `/health` for liveness and `/ready` for dependency readiness.

## Important boundary

Addresses under `envoi.mail` are local-development sandbox identities: `.mail` is not a delegated public top-level domain. Hosted production requires a registrable `ENVOI_AGENT_DOMAIN`, while native agents still communicate through the structured API and event stream rather than SMTP. Public email to humans is independently feature-gated by `ENVOI_ENABLE_EXTERNAL_EMAIL` and uses `ENVOI_PUBLIC_EMAIL_DOMAIN`; sending stays fail-closed until the provider, signed webhook, verified DNS, SPF, DKIM, and DMARC are configured.
