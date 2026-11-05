# Dots hosted workflow and recovery acceptance

This is the continuation packet for the notification acceptance on production release `27786b8`. It is not a completed gate. The owner approved that narrower result: real OAuth, a native subscription, two direct-instruction notification responses including Chrome closed, and scoped cleanup. It did not process canonical work.

## Entry conditions

- Reserve shared staging with the owner and avoid overlap with Phase C or other claim/setup and identity actions. Further hosted Dots rows are **NOT RUN** until the selected source and test window are authorized; a previously ended window is not a new authorization.
- Freeze one exact source composition, immutable image and passing required CI. The earlier `27786b86b2a1625393e212ecc49b16775279022f` image proves the dated notification-only result; it is not the current onboarding candidate. Do not promote the integration branch wholesale.
- Capture a fresh read-only database inventory and original-record hash fence. Require no live work lease, non-ended subscription/index, pending/live delivery or verification cache before activation. Retain the outbox histogram and protected-case state as preservation baselines.
- Capture the current Worker version, image, namespace, variables, secret-name set and scanner images. Dry-run the candidate, cleanup and paired recovery. Prepare an independent hard stop before deployment. Restoring only a Worker version does not restore a Container image.
- Use a maximum 60-minute window, with native test actions ending at minute 45. Use two disposable synthetic cases and designated agents only. Limit arrivals/instructions and replies to six each. Keep production and unrelated identities untouched.
- Review the actual consent for receiving and native sending. Obtain confirmation when expanding access. Do not request file/execution permissions for a reply test. Keep tokens, private callback URLs and signing secrets out of evidence and prompts.

## Evidence matrix

For every row retain the source, host identity/version when exposed, timestamps, native task result and redacted canonical receipt identifiers. Mark **PASS**, **FAIL**, or **NOT RUN**. A service mock, local driver or callback acknowledgment cannot fill an actual-host row.

| Check | Native action and required observation | Local regression coverage; not hosted proof |
| --- | --- | --- |
| OAuth identity and scope | Verify the selected plugin's actual address and least-privilege grant. Never substitute another connection after a failure. | `test/agent-remote-auth-mcp.test.js`, `test/agent-remote-auth-cimd.test.js` |
| Two canonical workflows | On each designated arrival: claim, check case/recipient, renew, acknowledge, send an approved typed reply and complete. Correlate one incoming work item, one reply and one settlement. | `test/agent-mcp.test.js`, `test/work-claims.test.js` |
| Chrome closed | Close every Chrome window before the second arrival; verify no windows remain until after callback delivery. Reopen without typing. Require native processing and canonical effects, beyond the earlier notification-only result. | Host action required |
| Duplicate effects | Retry the identical approved send and settlement once with their original keys. Require the same receipt and no second canonical effect. Distinguish idempotent retry from an actually duplicated transport event. | `test/agent-mcp.test.js`, `test/work-claims.test.js` |
| Missed notification and restart | Stop/interruption must precede one designated queued arrival. Restart the native task once; require catch-up from pending work without manufacturing a replacement arrival. Record any human action required. | `integrations/connector/mcp-events-host.test.ts`, `test/work-claims.test.js` |
| Cursor and subscription lifecycle | If the native interface exposes refresh/re-subscribe, exercise it once and verify identity, expiry movement and cursor continuity. Preserve pending work across restart. | `test/provider-event-wake-service.test.js`, `integrations/connector/mcp-wake-client.test.ts` |
| OAuth refresh | After the original access-token lifetime, make a new authenticated native operation. Confirm the same installation continues with private host refresh. Do not read tokens. | `test/agent-remote-auth-refresh.test.js` |
| Pause and resume | Pause the designated case or agent, queue one instruction, verify no reply or settlement while held, then resume and require exactly one effect. Do not reconnect around a pause. | `test/agent-remote-auth-mcp.test.js`, `test/provider-event-wake-service.test.js` |
| Denied action | Attempt one operation outside the approved scope; require denial and unchanged canonical state. | `test/agent-remote-auth-mcp.test.js` |
| Unsubscribe and revoke | Disable the native task, confirm unsubscribe, revoke only the test installation, then require one authenticated identity probe to be refused. No further arrivals after revoke. | `test/provider-profiles-http.test.js`, `test/agent-remote-auth-refresh.test.js` |
| Cleanup and preservation | Verify ended subscription/index, absent encrypted callback secrets/cache, no live delivery/lease, paused disposable cases, original records preserved with only individually authorized exceptions. | Read-only hosted receipts required |
| Paired staging recovery | Restore the captured Worker and image. Read back source, flags, bindings, namespace, scanner, health/readiness and unchanged production. | Operator readback required |

Native subscriptions use normal defaults. Do not require a TTL control absent from the native interface. The default seven-day lifetime cannot naturally expire during this window. Controlled-clock server expiry, duplicate transport and rotation tests must remain separate from real native-host observations. If the host offers no supported way to force a lifecycle transition, record the limitation and resolve the acceptance decision explicitly; do not mark a substitute as PASS.

Human owner instructions and native peer messages are different arrival types. Label each observed type accurately. A counterparty must have its own authorized synthetic runtime before a peer-message row can pass; possessing a tool in the operator's chat does not prove the Dot used it.

## Closeout

Complete cleanup before the hard stop, even if workflow rows fail. Keep failed/partial rows and exact public errors. Do not claim the full gate or change operational presence/delivery-mode flags while any required row is missing. Keep the notification-only production result separate and preserve the user's production agents.

After the native matrix passes, update [setup and recovery](DOTS.md), the [cross-provider packet](../skill/DOTS-GROK-ACCEPTANCE.md), onboarding copy and the minimal build-board result. Publish no private receipt payloads or account/database/installation identifiers. Follow the normal draft PR, required CI and human release process; generated `web/**` files come only from `npm run build`.
