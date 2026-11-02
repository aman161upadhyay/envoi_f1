# Seamless connection after one onboarding

## Product contract

An approved agent keeps the same address, inbox, installation and private work journal across process restarts, network loss, Gateway restarts and ordinary inactivity. Recoverable interruptions resume without a new claim, model prompt, registration or owner action. Work that arrived while the host was offline remains visible in the inbox and is claimed when a capable runtime returns. A sleeping/offline host cannot process work until it wakes; the website must say so rather than label a saved enrollment as online.

Terminal security and ambiguity remain explicit owner actions: revoked/expired authority, changed owner or scoped Gateway origin, corrupt state, and uncertain external effects cannot be silently repaired. A successful connection is demonstrated by a work claim, a real scoped tool/action, a fenced settlement and a returned reply, not by an open socket or model text.

## Current inventory and gaps (2026-10-30)

| Route | Existing recovery | Gap and intended action |
| --- | --- | --- |
| Local Hermes scoped | Durable connector, Envoi SSE cursor/delta and safety claim, saved daemon selection, scoped run journal | An absent selected daemon at startup was fatal; the current branch now retries that pre-work outage. The inspected Hermes source starts its runtime API on port `0`, so a supervised restart may change the pinned origin. The [supported origin recovery contract](../hermes/SCOPED-ORIGIN-RECOVERY-CONTRACT.md) is an upstream gate; keep origin mismatch and uncertain turns terminal. |
| Local Hermes legacy | Saved credentials, supervised connector option, bounded MCP rediscovery | Restart preflight now uses a read-only capability probe. Its real MCP-tool verification still invokes a bounded model turn before claiming work; replace that with a supported no-model tool probe before promising zero-cost restart. Test parked relay recovery. |
| Local OpenClaw scoped/legacy | Saved agent selection, connector service option, durable claim/reply state | The branch now uses authenticated core readiness instead of a model prompt on restart. Prove the exact selected agent/tool path in a real-host gate, then test Gateway restart and auth rotation. |
| Grok/xAI scoped/legacy | Durable connector, provider journal for scoped turns | The branch now uses an authenticated model-catalog probe instead of inference on restart. Gate a real provider outage, the first enrollment inference test, and uncertain turn preservation. |
| Hosted HTTP wake / provider connector | Persisted wake identities, receiver, replay and queue safety poll | Show ingress, worker and downstream processing as separate health states. Add server presence contract and hosted outage gate. |
| Authenticated REST and remote MCP OAuth | Saved activation and explicit provider-owned access | Local service supervision does not apply. REST `status` now avoids importing or initializing the work handler; onboarding and `run` still validate that handler. Private host clients classify terminal gateway/session responses and keep canonical work polling independent of temporary MCP event maintenance. Validate refresh, expired MCP transport/session reinitialization, replay and on-demand availability against route-specific fixtures. |

## Build sequence

### B1. Make status truthful and safe — implemented in this branch

Persist only startup phase, timestamp and stable code in private state; expose live wake readiness and last event/claim response. Offline doctor reports preflight only. Status probes host service registration separately from the live connector control channel, validates the responding process against the saved runtime/address/API origin, and derives a safe `nextAction` from the current lifecycle and stable error code. A malformed or wrong-identity control record yields `unverified`; a manager-reported process with no responding control channel does not trigger advice to launch a duplicate owner. Scoped Hermes status also projects the selected Gateway's live supervisor and pinned-origin verdict without publishing the origin or profile authority. Windows Task Scheduler and Linux systemd expose read-only enabled and manager state; macOS now reads the current launchd session's exact-label process and last exit status, with enablement still unknown. `registered` does not assert that the process is running or work is processed. Never persist raw errors, prompts, cursors or credentials. Gate: status distinguishes saved, process alive, Envoi wake ready, runtime tool ready, and work processed; killing the process leaves the last safe error visible.

### B2. Remove model calls from ordinary restart — implemented except Hermes legacy proof

Add `startupCheck` per adapter. Setup/adoption retains the existing bounded model proof before authority is consumed. Startup and offline doctor use read-only authenticated capability/readiness probes. Hermes legacy still performs a model-driven MCP tool verification after startup; that exception remains until a supported no-model tool probe can prove the actual tool path. Retry transient network/429/5xx with bounded jitter; fail closed for auth, incompatible protocol and scope changes. Gate: each route restarts with one enrollment identity and no model calls except the documented Hermes legacy proof. A real work item still proves processing.

### B3. Process ownership and gateway supervision — host-specific

Use exactly one connector owner per state directory. Install a host supervisor only by owner opt-in, and show whether it is installed, running or exhausted. On Windows, the task now repeats its logon trigger each minute while ignoring new instances; this rechecks a stopped connector after its five one-minute failure restarts are exhausted. It does not keep a logged-out or sleeping laptop online. On Linux the user `systemd` unit now retries failed starts indefinitely at most once per minute instead of permanently exhausting a five-start burst; on macOS use `launchd`. Hermes/OpenClaw Gateway is a **separate** supervised process with a stable, supported endpoint. Avoid restarting a selected Hermes Gateway merely to satisfy an Envoi health check. Gate: crash each process separately, verify the same identity returns and no duplicate owner starts. Test sleep, wake, logon, logout and service exhaustion explicitly. Existing installed tasks/units need a deliberate service reinstallation to receive the new definitions; the connector upgrade alone does not alter a service already registered on a host.

### B4. Durable wake and work reconciliation — shared connector and Lane A contract

Keep Envoi's queue authoritative. Resume SSE from the saved cursor, recover gaps with delta, and perform a safety claim after reconnect even when no event was replayed. For hosted wake, a temporary subscription-status failure must not suppress an otherwise healthy canonical queue claim; its `Retry-After` delays only maintenance. Finish pending control revalidation first, and allow a failed or stalled wake-hint dispatch to leave its notification pending while independent safety claims continue. The server still enforces pause and revoke on claim. Reconcile retry-delayed and paused work. Server work leases, idempotency keys and terminal receipts must prevent duplicate replies. Request Lane A to expose bounded installation presence: last refresh, wake stream, claim and processed timestamps plus an `offline`, `degraded`, `paused`, `needs_reconnect` or `ready` projection. Do not infer online from enrollment or browser login. Gate: 24-hour offline queue, dropped SSE, stale cursor, token rotation, pause/resume, revoke and two-way replies across FileStore and PostgreSQL.

### B5. Route-specific recovery

- Hermes scoped: retry only pre-work daemon absence or a starting/draining owner at its pinned origin. A live descriptor at a different origin reports `SCOPED_CONFIG_INVALID`: perform an owner-confirmed scoped reselection that preserves authority and journals; never rewrite the marker privately. Terminal/unknown turn receipts retain their journal and require the approved settlement/reconciliation procedure.
- Hermes legacy: keep relay listening throughout bounded Gateway rediscovery; verify a real MCP tool call before claiming work.
- OpenClaw: use authenticated `/readyz` and its `coreReady` field so unrelated chat-channel failures do not block Envoi, keep the exact selected agent and mode marker, and distinguish Gateway down, wrong auth, and model/tool failure.
- Grok: probe `/v1/models` with the saved provider credential on restart; classify auth versus temporary provider outage without spending inference tokens.
- Hosted wake and remote MCP: verify signed/authorized delivery, transport reinitialization and durable task lookup independently of local connector state. A subscription quota or temporary MCP event outage must not suppress the separate canonical safety claim, while paused/revoked/owner-repair states must halt it.

### B6. Packaging, rollout and rollback

Build all generated artifacts from one reviewed source SHA; verify release hashes. Installer upgrades replace only the executable atomically after a backup and never replace credentials or authority records. Roll out to disposable staging agents first, then opt-in existing agents. Record initial release, supervisor state, selected runtime, and recovery result. Roll back code while preserving enrollment and work journals; do not roll back a credential rotation by copying an old session file.

## Acceptance gates and measures

The exact-build, route-specific host procedure and safe evidence format are in [RECONNECT-RECOVERY-GATE.md](./RECONNECT-RECOVERY-GATE.md). Prior countersigned B/C acceptance remains historical evidence; the changed connector bytes need their own targeted recovery rows.

1. **Identity:** one onboarding; same agent, inbox and installation after every restart and upgrade; zero duplicate registrations.
2. **Recovery:** after host and network return, recoverable local outages reach a ready wake stream within 2 minutes at p95 and claim queued work within 1 additional minute. Measure from host readiness, not from when a powered-off machine was unavailable.
3. **Correctness:** zero duplicate external replies, zero lost accepted work, and no automatic replacement model turn after an uncertain effect.
4. **Cost:** zero inference calls on idle restart for Hermes scoped, OpenClaw and Grok. Hermes legacy's MCP tool verification is a documented exception until its no-model probe is built and gated; no route may claim universal zero-cost restart before that work passes.
5. **Visibility:** safe state includes process/supervisor, Envoi stream, runtime probe, last claim/processing times and the smallest owner action. Alerts fire on sustained offline/degraded state, not every retry.
6. **Routes:** the gate runs for Hermes scoped/legacy, OpenClaw scoped/legacy, Grok scoped/legacy, hosted wake, authenticated REST and remote MCP OAuth where offered. A route cannot be labeled always-on until its real host gate passes.

## Ownership and dependencies

Lane B owns connector, SDK, runtime adapters, installers, generated downloads and route-specific test harnesses. Lane A owns server presence, durable queue/lease contracts and hosted deployment; request exact fixtures before a server-facing change. The human approves production rollout, Gateway reselection, service installation on a real host and any security contract. This branch does not deploy or change Rachel's existing production profile.

## Research basis

The [A2A specification](https://a2a-protocol.org/latest/specification/) treats task state as retrievable after stream or push loss. [Moltbook's heartbeat](https://github.com/Moltbook-Official/moltbook/blob/main/skill.md) is a scheduled engagement check, not an inbox process supervisor. [OpenClaw's Gateway health guidance](https://docs.openclaw.ai/gateway/health) separates liveness, startup and readiness; [its remote guidance](https://docs.openclaw.ai/gateway/remote/index.html) uses persistent hosts for always-on agents. [MCP HTTP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) can expire sessions; Envoi's durable identity and work recovery must remain above that transport. [Microsoft Task Scheduler](https://learn.microsoft.com/en-au/windows/win32/taskschd/taskschedulerschema-restartonfailure-settingstype-element) and [systemd](https://www.freedesktop.org/software/systemd/man/259/systemd.service.html) provide process restart controls, but neither proves the agent processed an inbox item.
