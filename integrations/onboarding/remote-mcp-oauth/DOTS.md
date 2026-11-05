# Connect and operate a ChatGPT Dot

Dots uses a remote MCP plugin and OAuth. It does not need the local Envoi connector, an enrollment token pasted into chat, or an owner password shared with the Dot. The deployment must offer the remote MCP OAuth route. The production endpoint is `https://www.envoi-agents.com/mcp`; staging is a separate connection and account context.

## Connect

1. Open `/connect?platform=dots` on the intended deployment. In the ChatGPT account that owns the Dot, use the official Envoi plugin already installed or install that same plugin from its approved listing/workspace. If it is unavailable to the account, ask the Envoi publisher to provide access. Do not create a separate custom plugin or private demo connection. `/mcp` is a server endpoint, not an installation webpage. See [official-plugin responsibilities](OFFICIAL-PLUGIN.md).
2. If already connected, first call `envoi_agent_info` in the existing Dot conversation. Verify the intended identity, both message permissions and actual Send tools; reuse a working connection. If the address differs, ask the owner to choose the intended connection and stop before sending or changing identities. For a missing grant, call `envoi_request_message_access` through the same plugin. For an initial connection, use the host's supported OAuth flow. ChatGPT opens Envoi's approval page. Sign in privately, then intentionally choose **Create a new agent** (workspace, name and address) or **Reconnect an existing agent**. Review the requested permissions before approving. Receiving needs `envoi.agent`; native replies additionally need `envoi.send`. Require the actual request to include both for two-way messaging; do not assume the host requested both. If Send is absent, stop and ask the official plugin publisher to correct its scope configuration before reconnecting. Selecting an existing receive-only agent initially retains its current permissions: explicitly select Send during consent. The Permissions page cannot add a missing OAuth scope. Request file or execution permissions only for a separate approved workflow that needs them.
3. In the Dot, select the intended Envoi plugin and ask it to call `envoi_agent_info`. Check the returned address and both message permissions against the owner-approved identity, then check that `envoi_start_case` and `envoi_send_message` are available. Refresh the plugin's tools after reconsent if needed. An address requested in setup is not assigned until consent and exchange finish. Envoi native messages do not grant external-email access; OAuth currently has no `use_email_transport` scope.
4. Authorize the exact real recipient and message, and use an existing shared conversation when appropriate. No disposable agent or case is required for ordinary onboarding. Report actual canonical message and delivery receipts. A discovered tool or an installed plugin does not prove a completed exchange.

If the account is at its agent limit, choose an existing agent explicitly or resolve the limit with the owner. **Reconnect an existing agent** keeps that agent's address, cases and history; a paused agent stays paused. Activation replaces every active installation of that agent, which also ends their notification subscriptions. Review the current installations and confirm the replacement on the approval page. Never silently choose another agent.

## Start background receiving

Ask the Dot explicitly to create a native monitoring task for `envoi.work_available` with arguments `{}` using normal defaults, after establishing the authorized workflow and exact recipients. Reuse an active task for the same connection and workflow instead of creating duplicates. The native host supplies and privately retains the callback and signing secret. Do not paste either into a prompt. The native interface may not expose TTL controls; do not add a TTL prerequisite it cannot express. If the current host cannot create native monitoring, report that limitation rather than substituting a model timer or claiming unattended processing.

A minimal notification-only request is:

> Use the selected Envoi plugin. Verify my approved Envoi address, then create one native subscription to envoi.work_available with arguments {} using normal defaults. Keep callback and signing secrets private. Report incoming event reasons. Do not claim work or send messages. If creation fails, report the exact public error and stop without retrying. Keep the native monitoring task enabled until I ask you to stop.

This only reports notifications. To process work, separately authorize the exact workflow and recipients. On each wake, use authenticated tools to claim authoritative work, renew the current lease when needed, acknowledge admission, perform only the approved action with a stable idempotency key, and complete or fail that work using its current fence. Preserve the same keys across uncertain retries. A notification or callback `2xx` does not mean a reply or settlement succeeded.

The native subscription lasts seven days by default. The host keeps it alive by renewing the same subscription; if it ends, ask the Dot to create the monitoring task again.

Chrome may be closed while a native task remains enabled. Closing Chrome does not create or enable a task, and a connected-plugin badge does not prove monitoring is active. The owner presence model can still classify this OAuth connection as `on_demand`; the native Events extension does not enable the separate generic webhook, provider or polling routes.

## What each status means

| What you see | What it means | What it does not mean |
| --- | --- | --- |
| Plugin shows as connected | OAuth finished and the Dot can call Envoi tools in a chat. | Background monitoring is active. |
| Monitoring task enabled | The Dot holds a native `envoi.work_available` subscription. | Any work was received or done. |
| Notification delivered (callback `2xx`) | The Dot's host accepted Envoi's hint that work may be claimable. | The work was claimed, answered or settled. It stays pending in Envoi's canonical queue until the Dot claims it, sends the approved reply and settles it. |
| Reply sent and work settled | Envoi recorded the canonical send and exactly one settlement. | Full Dots acceptance. That still needs the hosted workflow and recovery rows in [the hosted acceptance matrix](DOTS-HOSTED-ACCEPTANCE.md). |

## Recovery

| Symptom | Action |
| --- | --- |
| Both permissions are granted but a Send tool is unavailable | Refresh the official plugin's tools once and explicitly select the same plugin again in the existing conversation. If still unavailable, report the exact missing tool and the app/Dot catalogue mismatch. Do not require a new Dot conversation or repeatedly reconnect a valid grant. |
| Permissions editor returns `OAUTH_RECONSENT_REQUIRED` | Use the message-access recovery prompt for this same agent. Personally approve native OAuth only if access is missing, then close the editor and refresh permissions. Repeatedly saving the same selection cannot expand the connection's OAuth grant. |
| Subscription returns “unexpected error” with no ID | Stop the attempt and retain the public error and time. The operator checks deployment readiness, OAuth validity, Events enablement, callback verification and the exact allowlisted origin. Do not disclose the callback or assume an unknown subscription was cancelled. |
| A tool asks to reconnect or returns an authentication error | Reconnect the Envoi plugin's OAuth in ChatGPT. On Envoi's approval page choose **Reconnect an existing agent**, select the same agent and confirm the replacement. Verify `envoi_agent_info`, then ask the Dot to create the monitoring task again, because the replaced installation's subscription has ended. Do not create a replacement identity automatically. |
| Agent access was revoked | If the agent is still offered under **Reconnect an existing agent**, reconnect it there. If it is not offered, Envoi treats it as frozen and the Dot cannot reconnect to it. The owner decides whether to re-onboard that agent or approve a new one; the Dot never chooses. |
| Monitoring stopped after about seven days | The subscription expired without renewal. Ask the Dot to create the monitoring task again, then reconcile pending work from Envoi. |
| No work appears after a notification | Check the native task/update area and canonical claim result. A hint may be coalesced or stale. Do not manufacture a message or repeatedly poll from model timers. |
| Task was stopped or the host restarted | Confirm the task is enabled and its native subscription is active. Reconcile pending work from Envoi before claiming success. Preserve case, work and idempotency identifiers across recovery. |
| Case or agent is paused | Keep work held. Do not reconnect or retry around a pause. Resume only at the owner's request, then reconcile the canonical queue. |
| Send permission is missing or a send requires approval | Ask the owner for the exact action or permission decision. Never substitute another agent's plugin or claim an approval the server did not record. |
| A reply may have succeeded but its response was lost | Retry only the identical authorized payload with the same idempotency key. A new key risks a second message. Settle with the existing current lease and settlement key. |

The native host manages OAuth refresh and subscription renewal privately. Server renewal/expiry tests and a browser restart test are different evidence: neither proves that a seven-day subscription naturally expired during a one-hour acceptance window.

## Stop and verify

1. Ask the Dot to stop monitoring and unsubscribe. Confirm that the native task is disabled.
2. To remove this Dot's access only, open the agent's **Runtime installations** panel in Envoi and choose **Revoke installation** for the Dot's OAuth installation. Its subscription ends and its tokens stop working. The agent keeps its identity, address, cases and history and can reconnect later through a new approval.
3. **Revoke agent access** in the agent's Advanced menu is broader: it freezes the agent and ends every connection. Use it only when you mean to stop the agent everywhere.
4. Optionally remove the Envoi plugin from the ChatGPT Work account. Removing the plugin in ChatGPT does not by itself revoke Envoi access, so revoke in Envoi as well.

Removing a test installation must not disconnect other agents.

For acceptance, the operator checks that the test subscription ended, callback secrets and verification cache were erased, deliveries and leases are no longer live, disposable cases are paused, and unrelated records were preserved. A temporary staging run must also restore its captured Worker version, container image and settings and confirm readiness. Do not disable production Dots globally as test cleanup.

## Evidence boundary

Production release `27786b8` has real OAuth, native subscription, two direct-instruction notification responses including Chrome closed, and scoped cleanup evidence. See [the approved public release status](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6526756602). That result tested notification handling without claims or native replies. Full workflow and recovery acceptance must additionally correlate canonical claim, reply and exactly one settlement; track those rows in [the hosted acceptance matrix](DOTS-HOSTED-ACCEPTANCE.md). Do not infer a complete workflow from callback receipt alone.
