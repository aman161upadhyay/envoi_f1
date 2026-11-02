# Hermes case-scoped host composition

The manual and unified connector entry points now select an opt-in production
daemon host. The shared connector owns enrollment, credential rotation, work
leases, CaseSession minting and invalidation. Hermes receives one temporary
editor MCP binding; typed calls execute through the existing CaseToolsClient.
No model output, ACP update or terminal text becomes an Envoi REST fallback.

## Approved beta assumptions

The host and installed plugins are trusted and owner-operated. Operational
Envoi credentials and lease tokens never enter prompts, editor MCP configuration
or daemon authentication. No separate privileged Envoi integration may remain
in the selected runtime. Unrelated native vendor tools do not require blanket
removal or OS sandboxing for this approved beta boundary. This route does not
defend against malicious owner-installed code reading host files.

Select an existing profile through HERMES_HOME or --config, an explicit loopback
daemon origin through HERMES_DAEMON_URL, and optionally HERMES_SCOPED_CWD.
Model/provider authentication remains configured in Hermes. No provider key is
requested or substituted. Preparation checks transport readiness only; it does
not claim a model execution passed.

Profile YAML and private .env are read before enrollment. An Envoi integration,
legacy relay/write/asset options, invalid selection or corrupt private marker
refuses. Configuration is not rewritten. The existing connection and a bounded
atomic private mode marker preserve scoped mode in an empty restart environment.
Explicit downgrades refuse. Legacy mode retains its earlier API Server behavior
when scoped mode was never selected.

## Supported vendor evidence

Implementation is grounded in official NousResearch/hermes-agent commit
`ccc695635094d7615373db267b77f894d978b1a0`:

- [Gateway client](https://github.com/NousResearch/hermes-agent/blob/ccc695635094d7615373db267b77f894d978b1a0/hermes_cli/gateway_client.py): explicit endpoint, private session-ticket bootstrap, canonical /api/ws and hermes-gateway-v1/ticket subprotocols. No implicit daemon startup helper is used.
- [Runtime discovery](https://github.com/NousResearch/hermes-agent/blob/ccc695635094d7615373db267b77f894d978b1a0/hermes_cli/gateway_runtime.py): ready-state, served-profile, origin and runtime identity checks. This adapter supports a directly served local profile; multiplexed secondary control-home/overlay discovery is not inferred.
- [Control socket](https://github.com/NousResearch/hermes-agent/blob/ccc695635094d7615373db267b77f894d978b1a0/gateway/control_socket.py): one versioned JSON line per connection, Unix socket/short-path pointer or canonical Windows named pipe. Ticket authorization is enforced by the vendor's same-user endpoint.
- [Canonical session contract](https://github.com/NousResearch/hermes-agent/blob/ccc695635094d7615373db267b77f894d978b1a0/gateway/session_contract.py) and [generated OpenRPC contract](https://github.com/NousResearch/hermes-agent/blob/ccc695635094d7615373db267b77f894d978b1a0/apps/shared/src/gateway-contract.openrpc.json): session.create/resume/detach, prompt.submit/receipt/cancel and generation-fenced session.interrupt. Its canonical registry is separate from the legacy desktop methods in the same document.
- [ACP production client](https://github.com/NousResearch/hermes-agent/blob/ccc695635094d7615373db267b77f894d978b1a0/acp_adapter/gateway_server.py): source=acp editor MCP, stable input identity, unknown execution refusal and queued-cancel/started-interrupt races.
- [Frozen session policy](https://github.com/NousResearch/hermes-agent/blob/ccc695635094d7615373db267b77f894d978b1a0/gateway/session_policy.py) and [editor MCP custody](https://github.com/NousResearch/hermes-agent/blob/ccc695635094d7615373db267b77f894d978b1a0/gateway/session_local_mcp.py): no_mcp excludes global configured MCP while the editor overlay is session-bound. Complete native-tool isolation is outside the approved beta requirement.

## Recovery and cancellation

For an enrolled profile whose gateway restarts on a different loopback port,
the private helper supports `resume <same-origin> --runtime hermes
--reselect-gateway`. It takes the existing connector lock, verifies completed
enrollment bindings, discovers the selected profile through its private control
socket and rechecks the ticketed canonical descriptor. The owner confirms the
displayed old/new address in a native interactive prompt. Only the address may
change; home, workspace, profile, config path and scoped mode stay fixed. Gateway
discovery sends no session creation, provider prompt or Envoi registration.

Any unfinished scoped journal refuses an address change before confirmation.
The original journal must go through supported recovery rather than deletion,
resubmission or a replacement enrollment. Completed legacy journals remain
deduplication evidence for their exact profile/workspace across a port change.
New journals use a stable profile/workspace identity independent of the port.

After rechecking the gateway and saved bindings, reselection writes a private
backup and one atomic version 2 marker with the exact previous and selected
configuration. Only that exact previous cache may transition to the new marker;
unrelated caches, explicit conflicts and older clients refuse. Enrollment,
grants, operational session and journals are never rewritten by reselection.
Normal resume refreshes the connection cache through the existing adapter path.

FileScopedRunStore saves one bounded record before creation/submission. It keeps
stable create/input IDs, exact prompt text, returned session/admission IDs,
provider identity and completion. It never stores Envoi credentials, lease
tokens, daemon tickets or the temporary relay secret.

A completed record performs no provider operation. Otherwise recovery attaches
to the original session without a replacement MCP capability, reads its captured
admission, or repeats the exact unacknowledged input ID and text. The vendor owns
admission deduplication. Terminal completed receipts can finish original work;
failed, interrupted, cancelled and rejected terminal admissions settle only that
work as permanently failed, using its current fenced lease. The canonical failure
must acknowledge the exact work before the loop continues. It does not mark the
journal completed, retry the provider or send a replacement message. The owner
can review the failed task on the website and decide whether to initiate new work.
Unknown or live recovered admissions never cause a replacement model turn or
automatic permanent settlement. Uncertain creation stops before any prompt was
submitted. Preserve the journal; do not delete it to force retries.

Before human-wait, the shared handler durably completes the journal. Its signal
then invalidates MCP. All aborts/deadlines close that binding before cancellation.
Cleanup attempts prompt.cancel, reads the original receipt and interrupts only
that receipt's execution_generation, then waits within a bounded deadline.
During a fresh in-process turn with its original MCP relay still active, a genuine
status-socket loss permits at most two read-only reconnects. Each revalidates the
same selected native instance/profile and resumes only the original session and
admission. The relay stays active; no session creation, prompt submission or
deadline reset is repeated. A policy/protocol close, malformed/oversized frame,
unmatched RPC, refused operation, changed instance or invalid receipt refuses
reconnection. A closing socket waits for its CloseEvent so a delayed policy close
is not mistaken for an outage. No close verdict before the original request bound
is an unknown failure, not permission to reconnect.

Unrecoverable failure still uses one bounded cancellation connection pinned to
the original native instance. Cancellation failure remains uncertain, never proof
the daemon stopped; local scoped effects remain denied regardless. A saved
terminal/interrupted admission is still reconciled as failed without replacing
its journal, creating another admission or equating a committed effect with native
completion.

The optional trusted-host `onRuntimeEvent` observer reports allowlisted lifecycle
events, monotonic offsets, pending MCP count and coded abort/reconnect outcomes.
It records the initiating abort before cleanup, without native IDs, provider text,
prompts or transport credentials. Observer failures do not authorize effects or
replace execution errors; a mandatory gate recorder must stop its own controller
if evidence cannot be persisted. Existing 120-second and 16-turn bounds remain.

## Validation and remaining gate

Production tests run the actual connector, private bootstrap socket, JSON-RPC
serializer, loopback MCP relay, typed tool client and file journal with an inert
WebSocket peer and canonical Envoi fixtures. They never run a Hermes CLI,
daemon/model/provider, real profile or real account.

Run focused integrations/hermes tests, all Lane B suites, strict typechecks,
the existing build and backend/download regressions from PowerShell. Generated
downloads come only from the build. Je integrates only this task's top increment
onto the reviewed client stack and rebuilds the combined candidate.

Matching-release real-host/two-owner decision, file-scan/grant, recovery and
revoke/cancel evidence remain separate human-approved acceptance work. Inert tests
or CI do not establish hosted acceptance or change the original paused case.
