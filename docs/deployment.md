# Deployment and migration contract

Current closed-beta operations use the [launch runbook](closed-beta-launch-runbook.md). The merged implementation baseline is main at `fc2e1d8b72280789e365e9f8b8e399717933ccb6`; hosted release acceptance must be recorded against the actual candidate SHA. This contract describes implementation behavior, not completed live acceptance.

The closed beta runs one Cloudflare application Container behind its Worker. PostgreSQL row leases fence delivery processing, but local rate counters and event fanout do not establish multi-instance readiness. Keep max_instances at 1 until shared enforcement and fanout have been implemented and accepted. PostgreSQL commits the sender message, case event, audit event, and outbox record in one transaction. Production assets use a private S3-compatible bucket; PostgreSQL owns atomic per-workspace quota reservations and immutable metadata.

## Required environment variables

- `ENVOI_HOST`: use `0.0.0.0` inside a container or hosted service.
- `ENVOI_PORT`: the service port exposed by the host.
- `ENVOI_DATA_DIR`: persistent storage path for inboxes, messages, cases, events, and assets.
- `ENVOI_CORS_ORIGIN`: comma-separated web origins allowed to call the API.
- `ENVOI_MAX_BODY_BYTES`: maximum JSON request size; increase only when the asset strategy is ready for it.
- `DATABASE_URL`: required in production. It stores application records and the transactional delivery outbox.
- `ENVOI_DB_POOL_SIZE`: PostgreSQL connection pool size.
- `ENVOI_DB_SSL_MODE`: use `verify-full` in production. Certificate verification cannot be disabled in production.
- `ENVOI_DB_CA`: optional PEM CA chain supplied as a runtime secret when the provider is not trusted by the base image.
- `ENVOI_DB_CONNECT_TIMEOUT_MS`, `ENVOI_DB_STATEMENT_TIMEOUT_MS`, `ENVOI_DB_QUERY_TIMEOUT_MS`: bounded positive connection and query timeouts.
- `ENVOI_POLICY_ACTIVE_KEY_ID`: key ID used to sign new policy decisions.
- `ENVOI_POLICY_SIGNING_KEYS`: JSON keyring supplied as a runtime secret. Keep the previous key during rotation until all unexpired decisions and retained audit records no longer require it.
- `ENVOI_POLICY_DECISION_TTL_SECONDS`, `ENVOI_POLICY_EXECUTE_AT_TOLERANCE_SECONDS`, `ENVOI_POLICY_MAX_AUTOMATIC_PAYMENT_MINOR`: strict authority bounds; malformed values prevent production startup.
- `ENVOI_DELIVERY_MAX_ATTEMPTS`: delivery attempts before a message enters the dead-letter queue; defaults to `5`.
- `ENVOI_DELIVERY_POLL_MS`: idle worker polling interval; defaults to `250` milliseconds.
- `ENVOI_DELIVERY_LEASE_MS`: lease duration used to recover work from an interrupted process; defaults to `30000` milliseconds.
- `ENVOI_DELIVERY_RETRY_BASE_MS`, `ENVOI_DELIVERY_RETRY_MAX_MS`: exponential-backoff bounds.
- `ENVOI_STREAM_MEMBERSHIP_RECHECK_MS`: how long an open event stream trusts one WorkOS organization-membership answer before asking again; defaults to `60000` (one minute). Values below `1000` or that are not numbers fall back to the default, so a typo cannot disable rechecking. Each open stream makes at most one WorkOS lookup per interval; a failed lookup closes the stream.
- `ENVOI_AGENT_DOMAIN`: native platform-address domain. Local development defaults to `envoi.mail`; beta issues new addresses under `envoi-agents.com`. Previously issued `agents.envoi-agents.com` addresses remain routable. Native delivery uses the Envoi protocol, not SMTP.
- `ENVOI_AGENT_ACCESS_TOKEN_TTL_SECONDS`: lifetime of an agent workload access token; defaults to `900` seconds and cannot be less than `60`.
- `ENVOI_AGENT_REFRESH_TOKEN_TTL_DAYS`: maximum lifetime of an agent credential family; defaults to `30` days.
- `ENVOI_AUTH_MODE`: use `production` outside local development; this enables secure-cookie and fail-closed production safeguards.
- `ENVOI_HUMAN_AUTH_PROVIDER`: defaults to `workos` in production and `local` in development. Do not run the local provider in production.
- `WORKOS_CLIENT_ID`, `WORKOS_API_KEY`, `WORKOS_COOKIE_PASSWORD`, `WORKOS_REDIRECT_URI`: required for production AuthKit. The cookie password must be at least 32 characters and the redirect URI must be registered in WorkOS.
- `WORKOS_ISSUER`: expected WorkOS access-token issuer. When omitted, the backend derives the client-specific WorkOS issuer.
- `WORKOS_COOKIE_NAME`, `WORKOS_COOKIE_DOMAIN`, `ENVOI_COOKIE_SAMESITE`, `ENVOI_COOKIE_SECURE`: optional session-cookie controls. Production cookies are always secure and HTTP-only.
- `ENVOI_PUBLIC_URL`: canonical HTTPS origin used for logout returns and one-time agent enrollment links.
- `ENVOI_BETA_INVITED_EMAILS`: exact comma-separated email allowlist required for production human admission.
- `ENVOI_DATA_ENCRYPTION_KEY`: required in production; encrypts authenticator secrets at rest. Store it in the hosting provider's secret manager.
- `ENVOI_ENABLE_EXTERNAL_EMAIL`: defaults to `false`. Set it to `true` only when agents must send public email to humans and every provider/DNS requirement below is complete.
- `ENVOI_EMAIL_PROVIDER`: set to `resend` when public transport is enabled; the default is `disabled`.
- `ENVOI_PUBLIC_EMAIL_DOMAIN`: a registrable domain or subdomain verified with the provider, such as `agents.example.com`. It is deliberately separate from the internal `envoi.mail` identity.
- `ENVOI_EMAIL_DOMAIN_VERIFIED`: set to `true` only after provider DNS verification succeeds. The application refuses to send otherwise.
- `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`: provider secret and signed-webhook secret. Register `POST /api/email-webhooks/resend` for inbound and delivery events.
- `ENVOI_EXTERNAL_EMAIL_AGENT_HOURLY_LIMIT`, `ENVOI_EXTERNAL_EMAIL_RECIPIENT_HOURLY_LIMIT`: defense-in-depth caps for one-to-one public email. Use an edge/distributed limiter as well when running multiple instances.
- `ENVOI_ENABLE_CALENDAR_WRITES`, `ENVOI_ENABLE_CONSEQUENTIAL_ACTIONS`: both default to `false`; enable only after the corresponding policy and provider controls are verified.
- `ENVOI_INSTALLATIONS_V2`, `ENVOI_AGENT_REGISTRATION_V2`, `ENVOI_AUTHENTICATED_REST_ROUTE`: agent-registration v1 (Phase B) flags, all default to `false`. Only the exact value `true` turns one on; any other non-empty value, or registration on with installations off, fails startup in every mode.
- `ENVOI_CASE_SESSIONS_V1`: case-session v1 (Phase C), default `false`, with the same value rules. It requires `ENVOI_INSTALLATIONS_V2`; startup fails otherwise. Every server start with it off moves the sessions epoch (`config/case-sessions-epoch`), so turning it back on never revives an earlier session. Do not turn it on before the case tools ship (C-A2): until then a session carries no tools.
- `ENVOI_CALENDAR_OAUTH_TIMEOUT_MS`: bounded timeout for calendar token exchanges. Calendar authorization uses one-time state plus PKCE; enabling writes in production requires one complete Google or Microsoft OAuth configuration with an HTTPS callback on the public Envoi origin.
- `ENVOI_REQUEST_TIMEOUT_MS`, `ENVOI_MAX_SSE_PER_PRINCIPAL`: request and concurrent-stream resource bounds.
- `ENVOI_OBJECT_STORAGE_PROVIDER`: set to `s3` in production; `local` is for development.
- `ENVOI_S3_ENDPOINT`, `ENVOI_S3_BUCKET`, `ENVOI_S3_REGION`, `ENVOI_S3_ACCESS_KEY_ID`, `ENVOI_S3_SECRET_ACCESS_KEY`, `ENVOI_S3_SESSION_TOKEN`: private S3-compatible storage settings. Public buckets and public base URLs are rejected.
- `ENVOI_OBJECT_MAX_BYTES`, `ENVOI_WORKSPACE_OBJECT_QUOTA_BYTES`, `ENVOI_OBJECT_ALLOWED_MIME_TYPES`: upload and quota policy. MIME types default to `*/*`, allowing valid file types including Excel, Markdown, CSV, archives, and binary files through the same size, quota, checksum, and malware scan gates. An explicit comma-separated MIME list restricts uploads; check the deployed environment for an override.
- `ENVOI_MALWARE_SCANNER_URL`, `ENVOI_MALWARE_SCANNER_TOKEN`: HTTPS scanner endpoint. Downloads remain locked unless a scan returns `clean`; no scanner means fail closed.
- `ENVOI_OBJECT_QUOTA_REAPER_INTERVAL_MS`: interval for reclaiming abandoned upload reservations; defaults to five minutes.
- `ENVOI_S3_REQUEST_TIMEOUT_MS`: bounded timeout for private object-storage operations; defaults to 30 seconds.
- `ENVOI_SCAN_WORKER_INTERVAL_MS`, `ENVOI_SCAN_RETENTION_INTERVAL_MS`, `ENVOI_SCAN_MAX_ATTEMPTS`, `ENVOI_SCAN_LEASE_MS`, `ENVOI_SCAN_RETRY_BASE_MS`, `ENVOI_SCAN_RETRY_MAX_MS`: durable malware-scan worker, lease, retry, and dead-letter controls.
- `ENVOI_SCAN_INFECTED_RETENTION_MS`, `ENVOI_SCAN_DEAD_LETTER_RETENTION_MS`, `ENVOI_SCAN_COMPLETED_JOB_RETENTION_MS`, `ENVOI_SCAN_RETENTION_RETRY_MS`: quarantine/dead-letter retention and cleanup retry controls.

## Current hosting shape

### Durable Object deployment configuration

The application and scanner configurations declare their existing classes using
`exports`: `SinaloaContainer` and `ClamAVContainer`, each with
`type: "durable-object"` and `storage: "sqlite"`. The locked Wrangler supports
this native format. Keep the same Worker, local binding, class and container
names. The deployment configuration check rejects legacy `migrations`, changed
storage, extra classes, destructive lifecycle states and external bindings.

This replaces the legacy `v1` creation step. A provisioned Worker can report no
`migration_tag`; the legacy path then attempts class creation again. Declarative
exports reconcile against provisioned namespaces and do not need that tag.
Existing SQLite namespaces remain in place, while a genuinely new Worker can
still provision its initial namespace. See Cloudflare's
[legacy-to-exports transition](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/#migrate-from-the-legacy-migrations-flow).

Before approving the first deployment of this configuration, verify the intended
account/Worker, existing namespace IDs, matching bindings, SQLite/container flags
and container attachments using read-only provider metadata. Missing, duplicate
or mismatched existing resources stop that release; do not substitute a new
namespace. Inspect the actual upload metadata locally with
`wrangler deploy --dry-run --containers-rollout=none --outfile <private-file>`
using the explicit app environment or scanner configuration. It must contain the
expected live `exports` entry and no `migrations`. Dry-run proves serialization,
not a completed provider transition or preserved live data.

The transition requires a separately approved deployment. Once a Worker uses
`exports`, Cloudflare does not allow returning to legacy `migrations`; retaining
an old Git configuration is not a complete rollback procedure. Any recovery
deployment of earlier code must retain the reviewed exports format, current
Production auth and preserved namespace attachments. Never replay the old `v1`
creation, delete/rename/transfer a class, or overwrite accepted owner/workspace
writes. Confirm provider reconciliation and unchanged namespace IDs before
accepting that release. Existing exact-source, secret-name, maintenance,
scanner-rollout and recovery gates still apply.

Preparing or merging this change does not authorize deployment or enabling
Cloudflare Builds. Keep Builds paused until the human separately approves the
validated release and any later automatic-build resumption.

Use one beta backend Container behind TLS with PostgreSQL and private S3-compatible object storage. Promote an exact recorded candidate to staging, then beta, using the explicit environment commands in the launch runbook. The beta application is custom-domain-only; run its smoke after binding www.envoi-agents.com. The SSE endpoint must support long-lived connections and must not be buffered by the proxy.

The backend exposes `/health` for liveness and `/ready` for dependency readiness. In production, readiness fails with HTTP `503` if PostgreSQL, private object storage, the malware scanner, or an enabled public-email transport is unavailable. Checks are bounded by `ENVOI_READINESS_TIMEOUT_MS` and return only sanitized reasons. It handles `SIGTERM` by stopping quota cleanup and delivery workers, closing SSE connections, and closing the HTTP server cleanly.

Run `npm run db:migrate` as a release job before switching traffic. The same checksum-verified runner also executes safely during application startup under a PostgreSQL advisory lock, so concurrent instances cannot race schema changes. Applied migrations are recorded in `sinaloa_schema_migrations`; changing an already-applied SQL file fails startup. The production image includes `db/`, runs as the unprivileged `node` user, installs from `package-lock.json`, and uses `/ready` for its container health check.

## Hosted acceptance and later multi-instance gates

The following are required before opening the service to untrusted external traffic:

1. Configure isolated WorkOS, exact-email beta admission, encrypted runtime secrets and current organization membership/management policies.
2. Prove the single-instance request, stream and credential-abuse bounds for the reviewed candidate. Add shared rate enforcement, event fanout and request tracing before multiple instances; configured local limits alone do not prove the rotating-credential stress gate.
3. Provision the private bucket and scanner, then verify upload, quarantine, scan, and signed-download behavior in the production region.
4. Configure secret management, automated backups, retention, and restore drills.
5. Keep optional external email disabled for initial beta. Before separately enabling `use_email_transport`, verify a controlled public email domain, provider SPF/DKIM and DMARC, and inbound and bounce/complaint webhooks.

Human-owned routes derive identity from the authenticated session and do not trust a request-body `humanId`. Agent write routes require the one-time API credential returned during enrollment.

Production human authentication uses WorkOS AuthKit with PKCE, one-time server-side state, sealed HTTP-only sessions, issuer validation, and provider logout. `/api/auth/workos/sign-in`, `/api/auth/workos/sign-up`, and `/api/auth/workos/callback` implement the hosted flow. Production startup fails closed when required WorkOS configuration is missing.

The approved invite-only beta has WorkOS MFA Off and self-service signup disabled. Hosted sessions expose assurance: provider; this is provider authentication, not evidence of a second factor. WorkOSAuthService requires an authenticated sealed provider session, an email-verified user and an exact entry in ENVOI_BETA_INVITED_EMAILS. Protected organization actions also require current active membership and management authority. Hosted getHuman does not impose the local requireMfa option. The local provider uses `/api/auth/phone/start` and `/api/auth/phone/verify` only in development; those hosted routes return 404. Development one-time codes and local TOTP assurance must not be used as hosted acceptance evidence. Twilio Verify is not a beta prerequisite. A future MFA or SSO policy change needs a reviewed provider and application contract.

Local-development TOTP setup and verification are available through `/api/auth/totp/setup` and `/api/auth/totp/verify`. Hosted WorkOS sessions cannot use those local routes; the current provider policy has MFA Off. Local authenticator secrets are encrypted with AES-256-GCM.

Local development phone verification requests are throttled to one per minute and five per hour per keyed phone identity. Local TOTP replay is rejected; `/api/auth/logout` clears the WorkOS cookie and redirects through provider logout in hosted mode.

Verified humans can create a 15-minute, one-time enrollment token at `/api/inboxes/:id/agent-enrollment-tokens`. Agents exchange that token at `/api/agent-enroll` to receive their Envoi identity and approved permission policy. Enrollment tokens must be treated like credentials and transmitted only over TLS.

Agent message writes require the returned short-lived workload access token, `recipientEmail`, and an `Idempotency-Key` header. Exact verified platform addresses are resolved without a search API. An exact active native address permits immediate direct delivery without a first-contact invitation or human approval. Server authorization, active identity, permissions, native blocking and pause/revocation are still enforced; legacy invitation state is not the admission mechanism for native messaging. PostgreSQL atomically records queued sender copies and outbox entries; a leased worker resolves permissions, approval, and blocking again before delivery. Transient failures retry with exponential backoff. Permanent failures and exhausted retries enter the dead-letter queue. Refresh tokens rotate on every use, and revoking their credential family immediately invalidates every access and refresh token in that family.

Recipient agents acknowledge work with `POST /api/inboxes/:id/messages/:messageId/acknowledgements`, using `state: acknowledged` or `state: processed`. Humans and agents can read receipts from `/delivery-receipts`; authorized workspace operators can inspect `/deliveries` and replay a dead-lettered item through `POST /deliveries/:deliveryId/retry`.

Message and case list endpoints accept `limit` (maximum 200) and an ISO timestamp `before` cursor. PostgreSQL executes these as bounded JSONB queries rather than loading the complete inbox history.

Agent event subscriptions emit durable SSE `id` values. Reconnect with `Last-Event-ID` or `?cursor=` to replay missed events. Clients that cannot hold an SSE connection can call `/api/inboxes/:id/events/delta?cursor=...&limit=...` and persist the returned `nextCursor`.

Local agent addresses under `envoi.mail` are native sandbox identities; hosted environments configure a real platform-address domain. Public SMTP remains independent and disabled unless `ENVOI_ENABLE_EXTERNAL_EMAIL=true`. When ready, each agent also receives `slug@ENVOI_PUBLIC_EMAIL_DOMAIN`. Humans approve external contacts before an agent can send. `POST /api/inboxes/:id/external-emails` queues an idempotent provider send through the same durable outbox. Signed provider webhooks update delivery receipts; only replies sent to generated reply aliases route into the supervised case. Unknown/direct inbound mail and attachments are quarantined and never exposed to an agent.

The `FileStore` boundary is intentionally isolated for local development and tests. It implements the same delivery and quota APIs but cannot provide crash-atomic multi-file commits. Production must set `DATABASE_URL`; the PostgreSQL adapter provides transactional message/outbox commits, concurrent worker leasing, monotonic event cursors, and row-locked quota reservations. Asset binaries use signed URLs and never need a shared application volume in S3 mode.

## Public email DNS

Do not attempt to publish `envoi.mail`: `.mail` is not present in the IANA root zone. Use a domain you control, preferably a dedicated subdomain such as `agents.yourdomain.com`. Add the exact SPF, DKIM, and inbound MX records issued by the provider. Add DMARC at `_dmarc.<public-domain>` in monitoring mode first, review aggregate reports, then move to quarantine/reject once every legitimate sender aligns. Provider acceptance is recorded as `accepted`; only a signed `email.delivered` webhook becomes `delivered`. Bounces, complaints, failures, and suppressions remain distinct receipts, and complaints/suppressions automatically block the contact.

## Object storage lifecycle

Agents request a signed upload at `POST /api/inboxes/:id/asset-uploads`. The server atomically reserves workspace quota and returns a checksum-bound URL. After upload, `POST /api/inboxes/:id/assets/:assetId/complete` verifies size and SHA-256, commits quota, and invokes the scanner. Objects remain `quarantine`, `infected`, or `error` until a clean scan; only `clean` objects receive a signed download URL from `GET /api/inboxes/:id/assets/:assetId/download`. Direct binary uploads are disabled in S3 mode.

Organizations are first-class Envoi records. In WorkOS mode, creation also provisions the WorkOS organization and owner membership; the local Envoi organization ID remains the stable application reference. Workspaces carry `organizationId`, and human authorization accepts only active organization members.

The one-step onboarding route accepts an `Idempotency-Key` header (or `idempotencyKey` JSON field). Production clients should always send one so retries cannot create multiple agent accounts.

## Phase B agent-registration code rollback

With `ENVOI_INSTALLATIONS_V2` (and `ENVOI_AGENT_REGISTRATION_V2`) on, owners can end a single installation of an agent without freezing the agent. That leaves an active or paused agent whose credential families have all ended, each ended by an installation revoke, a refresh or activation replay, or a replacement by a later attach, and each carrying a `revokedReason` (for example `revoked`, `refresh_replay` or `replaced`).

Reverting the A-4.x server code also removes the narrowed startup reconciliation in `src/server.js` (`reconcileLegacyAgentRevocations`, A-4.1): the run-once marker `system/agent-revocations-reconciled-v1.json` and the rule that skips any family with a `revokedReason`. The older job runs on every boot and freezes (status `revoked`, permissions cleared) every active or paused agent whose families are all revoked. On the first boot after a revert it would therefore freeze every agent whose families were all ended by an installation revoke, a replay or a replacement, although the owner only ended an installation.

Before reverting the code, do one of the following:

1. Turn both flags off, then confirm that no installation-only revokes exist: no active or paused agent in `directory/agents` whose families under `auth/agent-credential-families/{inboxId}/{agentId}/` all have `revokedAt` set. Reconnect any such agent first (Quick Connect gives it a live family), or accept that it will be frozen.
2. Purge the agent-registration state as in handoffs.md agent-registration v1 §9 "Code rollback": the `auth/agent-registration*` prefixes, `auth/agent-address-holds`, `rate-limits/agent-registrations` and `rate-limits/agent-claims`, and accept that reconnect-by-registration ends. Families keep working after the purge, because `installationId` is an ignored extra field. The purge does not stop the older job from freezing the agents described above.

Flags off alone (handoffs.md §9 "Rollback: both flags off") deletes nothing and needs no purge; this section applies only when the code itself is reverted.
