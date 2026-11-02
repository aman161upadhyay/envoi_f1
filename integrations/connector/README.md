# Shared connector lifecycle and recovery

## Idle reconnect diagnosis

An agent address and inbox are server-side durable identities. A local MCP transport
is a replaceable path to tools, not the mailbox. Envoi keeps the queue authoritative:
SSE wakes the running connector, a saved cursor plus delta repairs event gaps, and
bounded safety claims catch work after an offline period. A connector and its runtime
Gateway still need a host supervisor and a machine that stays awake. Windows startup
uses a logon trigger and an independent one-minute time trigger to recheck a stopped connector while the
session is active; it does not run while the user is logged out or the computer
is asleep. The Linux user service retries failed starts at one-minute intervals,
but a user service needs a running user manager after logout.

`status` includes `startupService.registration` and `runtimeDiagnostic`.
Registration means the host manager recognizes the installed task or service.
`controlChannel` distinguishes a responding owner process from an absent,
unreachable, invalid, or wrong-identity local control endpoint. A mismatched
endpoint is never reported as this agent's live connector; `doctor` also
withholds offline preflight until that ambiguity is resolved. When the manager
reports a running process but the authenticated control channel does not
respond, status is `unverified` and asks for process inspection, not another
connector start. Local `stop` and `uninstall` verify the responding runtime,
address and API origin against the saved installation before they can stop a
process.
On Windows and Linux, `startupService.enabled` and `managerState` report the
manager's read-only view. macOS reports `managerState` from the current
LaunchAgent session's exact-label PID and last exit status; it cannot infer
whether the job is enabled from that query. A manager's `running` state does
not prove Envoi control, Gateway readiness, or processing. `unverified`
means the manager could not be queried safely. While the process is alive, its authenticated
local control endpoint reports the current startup phase and `wake.transport`, with
last ready, event, and successful work-claim times. `connected` means the Envoi event
stream delivered its ready frame; it does **not** mean a model turn or MCP tool call
succeeded. For scoped Hermes, `status.selectedGateway` separately reports a
read-only live descriptor verdict, its declared supervisor, and whether the
origin matches the saved pin. It omits the actual origin, profile identifier,
ticket, and authority record. After an exit, a private `runtime-diagnostic.json` preserves the last
phase and stable error code. It contains no token, prompt, inbox content, cursor,
Gateway key, or raw exception message. `doctor` with no live process reports
`preflight_only`; it cannot prove wake or processing. A `failed` phase needs its exact
code investigated before restarting. `status.nextAction` derives a safe owner step
from the live lifecycle, stable error code, and host-manager state; a live status
never borrows a stale failure from a previous process. Preserve the enrollment
and work journal.

## Review an existing local service update

On Windows, an installed task can be `Ready` but have no repeating trigger and no running
connector. `status --state-dir <existing directory>` reports that task as
`startupService.recoveryPolicy: "outdated"`; it does not repair it. Before an
owner changes the task, record the saved `agentId`, `address`, `runtime`,
`credentialState`, `controlChannel`, `startupService.name`, `managerState`, and
`recoveryPolicy` from the candidate's status output. Keep the full status output
private because it also contains the local state directory and API origin. Confirm
that the candidate bundle matches `web/downloads/release.json`, and make a private
backup of the existing state directory and task definition. Do not run `setup` or
redeem another handoff for this update.

After reviewing the exact profile and task name, the owner may run the candidate's
`install-service --state-dir <existing directory>` on that host. This command
checks the saved agent and installation identity, backs up the old executable as
`connector.previous.mjs`, atomically installs the invoked candidate as
`connector.mjs`, replaces the task definition for the same directory, and starts
that task; it does not re-enroll an agent or replace credentials. A running
connector holds the installation lock and blocks this update. Compare the
reported candidate SHA256 with the reviewed release metadata. The Windows definition has
an enabled logon trigger, an enabled one-minute time trigger, and `IgnoreNew` for an already
running instance. The owner then checks `status` again for the same `agentId`,
`address`, and task name, `recoveryPolicy: "current"`, a scheduled next run, one responding connector,
and the selected Gateway at its saved origin. A running manager state alone is
not proof of processing, so the approved disposable staging gate must still
show one claim, settlement, and reply for queued work after a controlled crash,
outage, and restart. If the check fails, preserve the state directory and work
journal, stop the staged task, and restore the reviewed prior task definition;
do not run a fresh setup or silently change a scoped Gateway origin. User-logon
tasks cannot keep the connector running while the machine is asleep or logged
out. The owner must approve any change to a live task separately.

## Recovery boundaries by runtime

| Runtime route | What must stay running | Reconnect check | Recovery boundary |
| --- | --- | --- | --- |
| Hermes scoped | Selected canonical Hermes Gateway and one Envoi connector for the saved profile | Read-only pinned daemon check, then scoped tool invocation; status shows `tool_verification` until ready | If the selected daemon is absent, starting or draining **before work is claimed**, startup retries the same saved origin. A changed daemon origin reports `SCOPED_CONFIG_INVALID` and needs owner-confirmed reselection. An uncertain or failed saved turn keeps its journal; no automatic replacement model call. |
| Hermes legacy | Hermes Gateway plus loopback MCP relay and connector | Read-only capabilities check, then model-driven MCP tool verification during the bounded recovery window | A relay socket alone does not prove tool invocation. The real tool proof still spends a model call on idle restart until a supported no-model probe exists. |
| OpenClaw scoped or legacy | OpenClaw Gateway and the connector, supervised separately | Authenticated read-only Gateway core readiness, then selected-agent tool verification | A Gateway restart may be retried; credentials or scoped-mode mismatch require owner action. |
| Grok and other hosted model routes | A continuously supervised connector or configured hosted wake worker | Read-only provider catalog check plus Envoi wake and work claim | Provider availability is separate from inbox delivery; do not use a model heartbeat merely to show presence. |
| Remote MCP / on-demand | Provider-owned MCP service; no local connector to keep alive | Provider session and auth health, then an actual tool call | The provider owns reconnection. Envoi must not claim an always-on local runtime for this route. |

For scoped Hermes, the selected Gateway source can assign a new runtime API port
after restart. The [origin recovery contract](../hermes/SCOPED-ORIGIN-RECOVERY-CONTRACT.md)
names the upstream capability required before that route can be called seamless.

The design follows the [A2A task model](https://a2a-protocol.org/latest/specification/):
durable tasks can be read after a stream or push notification is missed. [Moltbook's
heartbeat](https://github.com/Moltbook-Official/moltbook/blob/main/skill.md) is a
scheduled agent check-in for engagement, not a guarantee that an MCP socket or inbox
consumer stays alive. [OpenClaw's remote Gateway guidance](https://docs.openclaw.ai/gateway/remote/index.html)
places always-on sessions on a persistent host. MCP's
[2025-11-25 HTTP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
supports session expiry and reconnection; protocol drafts change those details, so
Envoi's durable work recovery stays above the MCP transport layer.

The shared connector records STARTING, RUNNING, DEGRADED, PAUSED, NEEDS_RECONNECT,
REVOKED and STOPPED atomically with its credentials in the private session file.
Status and doctor include this lifecycle and operator guidance without credentials.
Paused agents keep refreshing and reading delta events; claims, actions and MCP
requests stop. Runtime tool verification is deferred while paused. A resume event
wakes the claim loop immediately. Stopping the process preserves the pause flag.

Outages use bounded exponential jitter (up to 30 seconds), with Retry-After as a
minimum delay. The retry deadline and pending rotation ID survive restart.
Revoked, replaced or expired credentials require an explicit owner recovery step;
the connector never enrolls automatically. For ROTATION_ID_REQUIRED, update your
connector before reconnecting through Envoi. Preserve the private state directory
when recovering a lost refresh response. Reconnect replaces credentials for the
same agent and preserves a server pause until the owner explicitly resumes it.

## Private Phase B adoption seam

The bundled `envoi-link` entry can call `adoptActivatedConnection(origin, runtime,
activation, resolveAdapter, options)` from `core.ts` after explicit host confirmation
and the private activation credential commit. This accepts only Hermes/OpenClaw
`local_helper` installations with `envoi_link` delivery. It never redeems a legacy
enrollment token or starts a new registration.

Pass `options.stateDir` for the helper's private state directory and the persisted
`options.completionId`. The helper's atomic `session.json` contains normal connector
credentials plus `_onboarding: { completionId, origin, runtime, agent, installation,
effectivePermissions }`; `runtime` is the server-declared `{ type, version }` object.
The connector validates installation, completion, origin and runtime before contacting
Envoi. It preserves newer credentials, rotation recovery state, inbox cursors and
terminal lifecycle state when setup is retried. If the helper has not yet written a
session, the seam can atomically commit that same shape before runtime configuration.

`connection.json.activationSetup` records the completion and installation identifiers.
Configuration failures retain both records for retry with the same helper state.
Authentication status is checked before configuring the runtime; paused attachments
skip tool verification and ready reports. The return value is private caller metadata,
not helper stdout. The caller projects only approved safe fields, then can run
`startConnection` in the foreground using the same directory. Setup does not prove
closed-app wake, and real host validation remains a separate human checkpoint.

`operationalConnectionStatus(privateContext, options)` returns the actual authenticated
status response to the private helper caller. Pass `{ origin, runtime, stateDirectory,
completionId }` from its saved context. The response must match the saved agent, inbox
and installation, including route and delivery mode. Keep the model-safe projection
in the helper layer.

When the local control listener is active, status reads the saved access token without
writing or refreshing; if Envoi returns `ACCESS_TOKEN_EXPIRED`, it reloads once and
retries only when the foreground owner already saved a successor. Without a live
listener it obtains the connector lock and uses the existing connector refresh and
lifecycle logic. A concurrent owner prevents lock acquisition. Saved revoked or
reconnect-required state stops before either local control or Envoi HTTP requests.
All status requests reject redirects and use a ten-second timeout.

Explicit replacement after a definitive ended state carries private `_onboarding`
fields `previousCompletionId`, `previousInstallationId`, `previousAgentId`,
`previousInboxId` and `previousAddress` from the prior saved session. Adoption reuses
local configuration only when the prior completion and installation match that
binding, the origin/runtime match, and the new activation has the same agent,
inbox and address. Missing or changed bindings fail closed. Newly saved
`connection.json.activationSetup` also records agent and inbox identifiers.
