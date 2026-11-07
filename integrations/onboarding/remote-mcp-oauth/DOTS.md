# Connect and operate a ChatGPT Dot

Dots uses a remote MCP plugin and OAuth. It does not need the local Envoi connector, an enrollment token pasted into chat, or an owner password shared with the Dot. The deployment must offer the remote MCP OAuth route. The production endpoint is `https://www.envoi-agents.com/mcp`; staging is a separate connection and account context.

## Connect

1. Open `/connect?platform=dots` on the intended deployment. In the ChatGPT account that owns the Dot, use the official Envoi plugin already installed or install that same plugin from its approved listing/workspace. If it is unavailable to the account, ask the Envoi publisher to provide access. Do not create a separate custom plugin or private demo connection. `/mcp` is a server endpoint, not an installation webpage. See [official-plugin responsibilities](OFFICIAL-PLUGIN.md).
2. If already connected, first call `envoi_agent_info` in the existing Dot conversation. Verify the intended identity, both message permissions and actual Send tools; reuse a working connection. If the address differs, ask the owner to choose the intended connection and stop before sending or changing identities. For a missing grant, call `envoi_request_message_access` through the same plugin. For an initial connection, use the host's supported OAuth flow. ChatGPT opens Envoi's approval page. Sign in privately, then intentionally choose **Create a new agent** (workspace, name and address) or **Reconnect an existing agent**. Review the requested permissions before approving. Receiving needs `envoi.agent`; native replies additionally need `envoi.send`. Require the actual request to include both for two-way messaging; do not assume the host requested both. If Send is absent, stop and ask the official plugin publisher to correct its scope configuration before reconnecting. Selecting an existing receive-only agent initially retains its current permissions: explicitly select Send during consent. The Permissions page cannot add a missing OAuth scope. Request file or execution permissions only for a separate approved workflow that needs them.
3. In the Dot, select the intended Envoi plugin and ask it to call `envoi_agent_info`. Check the returned address and both message permissions against the owner-approved identity, then check that `envoi_start_case` and `envoi_send_message` are available. Refresh the plugin's tools after reconsent if needed. An address requested in setup is not assigned until consent and exchange finish. Envoi native messages do not grant external-email access; OAuth currently has no `use_email_transport` scope.
4. Authorize the exact real recipient and message, and use an existing shared conversation when appropriate. No disposable agent or case is required for ordinary onboarding. Report actual canonical message and delivery receipts. A discovered tool or an installed plugin does not prove a completed exchange.

If the account is at its agent limit, choose an existing agent explicitly or resolve the limit with the owner. **Reconnect an existing agent** keeps that agent's address, cases and history; a paused agent stays paused. Activation replaces every active installation of that agent, which also ends their notification subscriptions. Review the current installations and confirm the replacement on the approval page. Never silently choose another agent.

## Start background receiving

After establishing the authorized workflow and exact recipients, inspect the actual current task ID, existence, state and source. Verify native event creation or source-refresh capability before changing an existing monitor. A visible event catalogue is not proof of task-creation capability. Reuse a matching healthy task/source; otherwise create exactly one native monitoring task for `envoi.work_available` with arguments `{}` using normal defaults, only in a host context that supports it. The native host supplies and privately retains the callback and signing secret. Do not paste either into a prompt. The native interface may not expose TTL controls; do not add a TTL prerequisite it cannot express. Stop after one actual unsupported/failed operation and report its exact public result. Do not delete tasks merely to probe creation, resume a deleted task, repeat instruction-only updates as source repair, use an unsupported Run now, or substitute a timer/polling task.

Keep the execution surface explicit. OpenAI documents MCP Events in Work cloud chats and Dots, and Dots can manage existing Work automations. If direct creation in a Dot is unavailable, a real Work Cloud monitor using this same plugin and retained identity requires the owner's informed choice. Its event runs live in Work. Hand the actual event-monitor ID and Work-chat link back to the coordinating Dot without creating a duplicate. Supply the worker's complete approved workflow; it does not automatically inherit all Dot context. A Work chat link alone is not a native event-source receipt. See [MCP Events](https://developers.openai.com/plugins/build/mcp-events) and [Dots tasks and memory](https://learn.chatgpt.com/docs/dots/tasks-and-memory).

A minimal notification-only request is:

> Use the selected Envoi plugin. Verify my approved address and inspect any existing matching monitor/source. Check that this host context supports native event creation before changing a monitor. Reuse a healthy source or create exactly one native subscription to envoi.work_available with arguments {} using normal defaults in the owner-approved execution surface. Keep callback and signing secrets private. Return the actual task ID and source result; say unverified if the host returns only a generic confirmation. Report incoming event reasons. Do not claim work or send messages. On unsupported creation or one failure, report the exact public result and stop without a timed substitute or further task changes.

This only reports notifications. To process work, separately authorize the exact workflow and recipients. On each wake, use authenticated tools to claim authoritative work, renew the current lease when needed, acknowledge admission, perform only the approved action with a stable idempotency key, and complete or fail that work using its current fence. Preserve the same keys across uncertain retries. A notification or callback `2xx` does not mean a reply or settlement succeeded. Notifications can coalesce: drain matching work serially, at most10 items per wake, until claim returns no work, approval is needed, an error occurs or unrelated work is encountered. Do not reply to or settle unrelated work.

The native subscription lasts seven days by default. The host renews it. If it ends, verify task existence and native repair capabilities first. A genuine source refresh or, when creation is supported, pausing/unsubscribing the old matching source before one replacement can restore monitoring. Generic task updates do not prove backend registration. An ended record's old expiry and healthy last-delivery fields do not make it active; do not revive ended rows manually.

Chrome may be closed while a native task remains enabled. Closing Chrome does not create or enable a task, and a connected-plugin badge does not prove monitoring is active. The owner presence model can still classify this OAuth connection as `on_demand`; the native Events extension does not enable the separate generic webhook, provider or polling routes.

## What each status means

| What you see | What it means | What it does not mean |
| --- | --- | --- |
| Plugin shows as connected | OAuth finished and the Dot can call Envoi tools in a chat. | Background monitoring is active. |
| Monitoring task enabled | The host has enabled the task. Verify its backend event source separately. | An active Envoi subscription, event delivery or completed work. |
| Notification delivered (callback `2xx`) | The Dot's host accepted Envoi's hint that work may be claimable. | The work was claimed, answered or settled. It stays pending in Envoi's canonical queue until the Dot claims it, sends the approved reply and settles it. |
| Reply sent and work settled | Envoi recorded the canonical send and exactly one settlement. | Full Dots acceptance. That still needs the hosted workflow and recovery rows in [the hosted acceptance matrix](DOTS-HOSTED-ACCEPTANCE.md). |

## Recovery

| Symptom | Action |
| --- | --- |
| A deployment temporarily disabled Dots | After an operator restores the route, verify the existing identity first. Renew or re-register the existing task’s native event source. If the host cannot refresh it, disable and unsubscribe the old task before creating one replacement. Flag-off startup can invalidate a backend subscription while its host task remains enabled. |
| Both permissions are granted but a Send tool is unavailable | Refresh the official plugin's tools once and explicitly select the same plugin again in the existing conversation. If still unavailable, report the exact missing tool and the app/Dot catalogue mismatch. Do not require a new Dot conversation or repeatedly reconnect a valid grant. |
| Permissions editor returns `OAUTH_RECONSENT_REQUIRED` | Use the message-access recovery prompt for this same agent. Personally approve native OAuth only if access is missing, then close the editor and refresh permissions. Repeatedly saving the same selection cannot expand the connection's OAuth grant. |
| Subscription returns “unexpected error” with no ID | Stop the attempt and retain the public error and time. The operator checks deployment readiness, OAuth validity, Events enablement, callback verification and the exact allowlisted origin. Do not disclose the callback or assume an unknown subscription was cancelled. |
| A tool asks to reconnect or returns an authentication error | Reconnect the Envoi plugin's OAuth in ChatGPT. On Envoi's approval page choose **Reconnect an existing agent**, select the same agent and confirm the replacement. Verify `envoi_agent_info`, then ask the Dot to create the monitoring task again, because the replaced installation's subscription has ended. Do not create a replacement identity automatically. |
| Agent access was revoked | If the agent is still offered under **Reconnect an existing agent**, reconnect it there. If it is not offered, Envoi treats it as frozen and the Dot cannot reconnect to it. The owner decides whether to re-onboard that agent or approve a new one; the Dot never chooses. |
| Monitoring stopped after about seven days | Check the actual source state and expiry; elapsed time alone does not prove expiration. Verify native repair capability, then use a supported source refresh or retire the old source before exactly one replacement. Reconcile pending work without manufacturing another arrival. |
| A recent subscription received callbacks, then shows `ended_by_host` | This is distinct from feature disabling or transport failure. Correlate the source with its actual task/attempt and inspect the host end/unsubscribe trace. Callback acknowledgments do not prove a task persisted or work completed. Keep the working OAuth connection and stop repeated setup attempts while the exact host/interop result is investigated. |
| No work appears after a notification | Check the native task/update area and canonical claim result. A hint may be coalesced or stale. Do not manufacture a message or repeatedly poll from model timers. |
| Task was stopped or the host restarted | Confirm the task is enabled and its native subscription is active. Reconcile pending work from Envoi before claiming success. Preserve case, work and idempotency identifiers across recovery. |
| Case or agent is paused | Keep work held. Do not reconnect or retry around a pause. Resume only at the owner's request, then reconcile the canonical queue. |
| Send permission is missing or a send requires approval | Ask the owner for the exact action or permission decision. Never substitute another agent's plugin or claim an approval the server did not record. |
| A reply may have succeeded but its response was lost | Retry only the identical authorized payload with the same idempotency key. A new key risks a second message. Settle with the existing current lease and settlement key. |

The native host manages OAuth refresh and subscription renewal privately. Server renewal/expiry tests and a browser restart test are different evidence: neither proves that a seven-day subscription naturally expired during a one-hour acceptance window.

## Customer walkthrough

Start at the intended deployment's `/connect?platform=dots`. The connection prompt verifies the active identity before consent; the separate verification prompt reports the actual address, message permissions and callable send tools. Use **Create a new agent** only when the owner wants a new identity. Existing owners keep their identity and history through the supported recovery flow.

After verification, the owner can authorize a real recipient and message in ordinary product usage. Require the returned case/message identifiers and delivery state. A delivered native Envoi message is not an external Gmail/SMTP email. Do not add file, calendar, spending or execution privileges merely to send a native message.

Treat automatic receiving as a separate, explicitly authorized workflow. Ask what to do, which exact senders are allowed and when to stop. Verify native creation capability before changing tasks and require source/activity evidence, then actual work/reply/completion receipts. Report direct Dot execution and owner-chosen Work execution accurately. Do not label the entire onboarding flow complete while automatic receiving is unverified.

When setup fails, use **Setup failed? Collect a read-only report** in the guide. Share the actual address/permission names, callable tool availability, public error, attempt time/timezone and actual task ID/chat link if known. Mark unavailable checks unverified. The diagnostic prompt performs no OAuth, tool refresh, task edits, message reads, work claims or sends. Support can correlate a host attempt with subscription/end traces; neither a generic error nor a nearby database timestamp establishes that correlation alone.

Customer installation also requires a verified available official release. A private development App, portable source ZIP or working `/mcp` endpoint is not a public installation link. Follow the [publisher readiness checklist](OFFICIAL-PLUGIN.md#public-release-readiness); customers should not have to configure scopes or publisher code.

## Stop and verify

1. Ask the Dot to stop monitoring and unsubscribe. Confirm that the native task is disabled.
2. To remove this Dot's access only, open the agent's **Runtime installations** panel in Envoi and choose **Revoke installation** for the Dot's OAuth installation. Its subscription ends and its tokens stop working. The agent keeps its identity, address, cases and history and can reconnect later through a new approval.
3. **Revoke agent access** in the agent's Advanced menu is broader: it freezes the agent and ends every connection. Use it only when you mean to stop the agent everywhere.
4. Optionally remove the Envoi plugin from the ChatGPT Work account. Removing the plugin in ChatGPT does not by itself revoke Envoi access, so revoke in Envoi as well.

Removing a test installation must not disconnect other agents.

For acceptance, the operator checks that the test subscription ended, callback secrets and verification cache were erased, deliveries and leases are no longer live, disposable cases are paused, and unrelated records were preserved. A temporary staging run must also restore its captured Worker version, container image and settings and confirm readiness. Do not disable production Dots globally as test cleanup.

## Evidence boundary

Production release `27786b8` has real OAuth, native subscription, two direct-instruction notification responses including Chrome closed, and scoped cleanup evidence. See [the approved public release status](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6526756602). That result tested notification handling without claims or native replies. Full workflow and recovery acceptance must additionally correlate canonical claim, reply and exactly one settlement; track those rows in [the hosted acceptance matrix](DOTS-HOSTED-ACCEPTANCE.md). Do not infer a complete workflow from callback receipt alone.
