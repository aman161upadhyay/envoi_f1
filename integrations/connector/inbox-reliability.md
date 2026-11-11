# Inbox monitoring and task execution

Use the Envoi work queue as the record of what still needs to be processed.
An event, a callback acknowledgement, and a running process are intermediate
observations. Verify the actual claim and settlement for the intended agent.

| Host | Intake and execution today | Next reliability check |
| --- | --- | --- |
| ChatGPT Dots / Work | ChatGPT subscribes to `envoi.work_available`, claims work through the Envoi plugin, and applies the owner's workflow. | Recover the source on the same task and identity after reconnect. Verify an acknowledgement before a request, an interrupted claim after a reply, and one new peer request with the browser closed. Require native run and Envoi settlement evidence. |
| Hermes | The supervised Envoi bridge uses the event stream and safety claims, or signed HTTPS wake and safety claims. The bridge invokes Hermes and keeps its run journal across restart. | Supervise the bridge and Gateway separately. Restart each separately with queued work and prove the bridge resumes a known run without starting a duplicate. |
| OpenClaw | Uses the same connector intake. The bridge invokes the configured Gateway agent and records the turn and settlement. | Test Gateway restart separately from connector restart. Occupy the callback port on a disposable host and show that authenticated polling still processes a new task. |
| Grok via xAI Responses | A supervised bridge uses the Envoi event stream and safety claims. Its run journal and rotating credentials share the private connection directory. | Verify that a second launcher is refused and that the original launcher resumes the same identity and processes queued work after restart. |
| Native Grok automation | A signed webhook can invoke a configured target. The target must then use its authorized Envoi connection to claim and act. | Correlate callback acceptance with a native execution, claim and settlement. Exercise pause and revoke in the same test account. |
| Muse | The reviewed connector candidate exposes work tools. Background scheduling and unattended send approval require provider evidence. | Use the reviewed connector in an eligible account. Test an idle arrival and record any approval prompt before enabling unattended actions. |
| Instinct | No Envoi-specific unattended invocation path has been verified. | Establish supported private credential storage and a background trigger, then run the same claim and settlement test. |
| Other MCP, REST or SDK clients | Capabilities depend on the installed host. A supervised connector can reconcile durable work with safety polling. | Document who starts and restarts the worker. Prove catch-up after a missed hint, duplicate hint, restart and revoke using the route actually installed. |

## Read the connector's heartbeat

For the unified connector, run `envoi-link status --state-dir <directory>`
or `envoi-link doctor --state-dir <directory>`. The running process reports
when it last attempted a claim and the time and outcome of its most recent
valid claim response. A more recent attempt than response can indicate a claim
in progress or an unsuccessful check. A paused connector can intentionally
stop claiming and continue checking its control state. These fields describe
the current process and reset on restart. Verify completion separately through
Envoi's settlement record.

## Record one hosted result per route

Use a controlled case and a uniquely identifiable request. Capture the host and
connector release, installed route, arrival time, source or polling evidence,
claim, runtime turn, any authorized external effect and final settlement.
Record the exact blocker when the host stops. Repeat with the normal wake hint
missing and with the host restarted between reply and settlement. Verify that
the next eligible item is handled and that a retry produces no duplicate reply.
