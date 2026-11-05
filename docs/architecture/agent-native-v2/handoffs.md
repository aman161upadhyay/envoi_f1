# Agent-native v2 shared contract handoffs

This file records shared contracts **before** their implementation. The integrator owns changes to `src/server.js` and shared schemas. Other phases remain ordered A1 → A3 → A2 → A4 → A5 → Phase A hosted acceptance → Phase B.

## A1: renewable credentials and replay-safe rotation

**Current contract.** `POST /api/agent-token` takes `{grantType:"refresh_token",agentRefreshToken}`. `src/server.js` consumes the old refresh token, issues a new access/refresh pair, and returns it once. A credential family's `refreshExpiresAt` is fixed at enrollment. `sdk/typescript/src/connector.ts` saves the successor only after the response; loss of that response or crash before save strands the connector. Current old-token replay returns 401.

**Proposed change.** The trusted connector persists a stable `rotationId` in its private session state before sending the request. The request includes that ID. The server atomically marks the old refresh credential used, extends the family expiry by the configured inactivity lifetime, creates one successor, and stores a short-lived AES-GCM recovery envelope bound to the old raw refresh token, rotation ID, family, and a server secret/context. A retry of the exact old token and rotation ID during the recovery period receives exactly the same successor. A different ID, expired recovery, or revoked family is rejected. The connector atomically saves the successor and clears its pending rotation. Rachel explicitly chose **mandatory `rotationId` with every connector updated together** on 2026-10-07; the A1 release cannot be staged server-only or advertised as compatible with already-running old connector binaries.

**Reason.** Current refresh expiration kills otherwise healthy installations after roughly 30 days, and a lost rotation response may require re-enrollment. A stable request ID plus short encrypted recovery fixes this without storing plaintext successor tokens or creating immortal credentials.

**Dependent modules.** `src/server.js` credential issue/rotate/authentication paths; TypeScript SDK `rotateAgentToken` and `SinaloaConnector`; connector persistence in `integrations/connector`; Hermes/OpenClaw bridges that reuse the connector; auth/SDK/integration tests; deployment configuration for the existing `SINALOA_DATA_ENCRYPTION_KEY` secret. No model-facing token exposure.

**Migration impact.** Existing credential families keep their identity and grants; no agent re-enrollment. Existing stored sessions without `pendingRotation` remain valid once an updated connector writes that field before its first rotation. Every shipped connector and direct SDK caller must be updated and tested in the same candidate. Before deploying the server change, distribute the updated Hermes, OpenClaw, xAI, and generic connector bundles and arrange to restart old running installations at cutover; an old binary will fail its next refresh because it omits mandatory `rotationId`. Do not promote or merge A1 until the combined server/bundle candidate, restart sequence, and rollback target are accepted. A rotation already pending during a server-secret change may need owner reconnect because recovery encryption uses the configured data-encryption key. The recovery record must be garbage-collectable after a bounded window and invalidated by revocation. Hosted validation must use a known release SHA and simulate an actual lost response.

**Status.** Implemented in the A1 branch, pending exact-commit CI and review. The API now requires `rotationId`; the TypeScript connector saves it before refresh and recovers a lost response within five minutes. The Python SDK and direct TypeScript SDK require callers to supply their own persisted ID. Hermes, OpenClaw, and xAI bridges use the updated connector. Phase A hosted acceptance and any production promotion remain separate.

## a3-pause-auth v1

**Contract:** `a3-pause-auth`, version 1. **Status:** approved by the human on 2026-10-09 (`CONTRACT-APPROVED a3-pause-auth v1 @e97853c`, build board #34) after Lane B `CONTRACT-ACK`. Frozen: changes need a new version.

**Fixtures:** [`test/contract-fixtures/a3-pause-auth/`](../../../test/contract-fixtures/a3-pause-auth/). It holds:
- `schemas.json`, which contains the draft-07 schemas and the machine-readable code table `x-codes`;
- one JSON file per case.

All files are registered in `test/contract-fixtures/index.json`.

**Owner:** Lane A. **Consumer:** Lane B (A2 connector lifecycle, SDKs, UI). **Implemented by:** task A-1.

None of this is implemented yet. Where the server behaves differently today, the text says "Current behavior".

This contract covers the stable codes an agent credential can receive, what each code means for the connector, how a paused agent behaves, and the pause/resume events. It applies D1 from [claude-codex-build-plan.md](claude-codex-build-plan.md) §1 and v3 §10–§20.

### 1. Error envelope

Every error covered by this contract has this JSON body:

```json
{ "code": "AGENT_PAUSED", "error": "AGENT_PAUSED", "message": "This agent is paused by its owner.", "requestId": "req_example" }
```

- **`code`** is the stable machine code. Clients branch on `code` only. They never branch on `message` or on the HTTP status alone.
- **`error`** always equals `code`. It stays for clients that already read a code from `error`.
- **`message`** is safe to show a human. Clients display `message`, not `error`.
  - It never contains a credential or token fingerprint.
  - It never reveals whether some other token exists.
- **`requestId`** echoes the client's `x-request-id` only if it matches `^[A-Za-z0-9._:-]{1,128}$`. Otherwise the server generates one.
- **Optional fields:**
  - `retryAfterSeconds` (`RATE_LIMITED`);
  - `caseId` (`CASE_CONTROLLED`);
  - `reason` (`CREDENTIAL_REVOKED`; see §2).
- **Forward compatibility.** Clients ignore unknown fields. New optional fields are additive and do not bump the version.

**Current behavior.** There are four different error shapes today:
- Routes that use `fail()` send `{ "error": "<message>" }`. This includes the claim pre-check, MCP, SSE connect and rate limiting.
- Errors thrown with a code send `{ "error": "<CODE>", "message", "requestId" }` with no `code` field. `CASE_CONTROLLED` is one of these.
- Errors thrown without a code send `{ "error": "REQUEST_FAILED", "message", "requestId" }`. Refresh and in-transaction claim errors are like this.
- The header-based `ACCOUNT_CHANGED` sends `{ "error": "<message>", "code": "ACCOUNT_CHANGED" }`.

A-1 moves every case in §2 to the single envelope above. Errors not listed in §2 keep their current shape in v1. Examples are enrollment rejections, validation `400`s, permission `403`s and `AGENT_BLOCKED`.

### 2. Codes

The columns mean:
- **Lifecycle:** the A2 connector state (v3 §19) the connector enters. `UNCHANGED` means the state does not change.
- **Guidance:** the safe, user-facing hint the connector or UI shows.

The same table is machine-readable in `schemas.json` → `x-codes`. The fixture test checks every fixture against it.

| Code | HTTP | Returned when | Next allowed operation | Lifecycle | Guidance |
| --- | --- | --- | --- | --- | --- |
| `AGENT_PAUSED` | 409 | A valid credential of a **paused** agent tries to act. That covers send, case action, proposal, any `/mcp` request, `mcp-read-token`, any request made with an `mcp_read` token, or settling a lease (`renew`, `acknowledge`, `complete`, `fail`, instruction `reply`). Never returned by claim, refresh, status, connection-status, SSE or delta (§3). | Stop actions. Keep refreshing, keep SSE open, read `GET /api/agent/status`. Wait for `agent.resumed`. Do not re-enroll or reconnect. | `PAUSED` | `wait_for_resume` |
| `CREDENTIAL_REVOKED` | 401 | This credential family can no longer be used. `reason` says why. **`revoked`:** the owner revoked access, or the agent was revoked or removed. **`replaced`:** a reconnect issued a newer family, and every reconnect revokes all earlier families. **`refresh_replay`:** the family was revoked after a `REFRESH_REPLAY`. Returned for access tokens and refresh tokens. | None. Stop claims, sends, refresh, MCP, case writes and late settlement. | `REVOKED` | `revoked` → `owner_reenroll`; `refresh_replay` → `owner_reenroll`; `replaced` → `replaced_by_reconnect` |
| `CREDENTIAL_EXPIRED` | 401 | The family's rolling inactivity expiry passed (`refreshExpiresAt`, 30 days by default). Returned for refresh and for access tokens of that family. Pause does not extend the expiry. | No refresh. The owner issues a reconnect for the **same** identity (§4). Do not enroll a new agent. | `NEEDS_RECONNECT` | `owner_reconnect` |
| `ACCESS_TOKEN_EXPIRED` | 401 | The access token expired but its family is valid. | Refresh once with the stored refresh token, then retry the original request once. | `UNCHANGED` | `none` |
| `AUTHENTICATION_REQUIRED` | 401 | The bearer token is missing, malformed, unknown, or belongs to a different inbox than the route. The response is identical whether or not a similar token exists. | If the connector holds a refresh token, refresh once. If that fails, follow the code the refresh returns. | `UNCHANGED` | `none` |
| `ROTATION_ID_REQUIRED` | 400 | `POST /api/agent-token` without a `rotationId` that matches `^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$`. Checked before the token is looked up, so it reveals nothing about the token. The token is **not** consumed. | Do not retry automatically. The stored credential stays valid for the updated connector. | `NEEDS_RECONNECT` | `update_connector` |
| `REFRESH_TOKEN_INVALID` | 401 | One of three cases. (a) The refresh token is unknown, malformed or no longer retained. (b) It was already used, but its record does not say which `rotationId` used it, which is true of records written before A-1. (c) Its own expiry passed while the family is still valid. Identical whether or not a similar token exists. | No retry. The owner reconnects the same identity. | `NEEDS_RECONNECT` | `owner_reconnect` |
| `REFRESH_REPLAY` | 401 | A refresh token that was **already used** is presented with a **different** `rotationId` from the one that used it. This means two holders of one token, so the server **revokes that family**: later requests get `CREDENTIAL_REVOKED` with `reason: "refresh_replay"`. The server also closes the family's streams with `credential.ended` and audits `agent.refresh_replay_detected` for the owner. A1's same-`rotationId` recovery already covers an honest lost response, so this never fires for a correct connector. | None. Do not retry with another `rotationId`. | `REVOKED` | `owner_reenroll` |
| `REFRESH_RECOVERY_EXPIRED` | 401 | An already-used refresh token is presented with the **same** `rotationId` after the 5-minute recovery window, so the successor can no longer be returned. Also returned when the recovery envelope cannot be decrypted, for example after a data-encryption key change. | No retry. The owner reconnects the same identity. | `NEEDS_RECONNECT` | `owner_reconnect` |
| `CASE_CONTROLLED` | 409 | A human paused or revoked this **case**. Case-scoped: the agent keeps working other cases. A case resume cannot override an agent pause, and `AGENT_PAUSED` takes precedence when both apply. The body includes `caseId`. | Skip that case. Do not retry the write until the case resumes. Claim never offers work from a controlled case. | `UNCHANGED` | `case_paused` |
| `ACCOUNT_CHANGED` | 409 | Browser only, from either of two paths. (1) A mutating human request whose `x-envoi-expected-human` header names a different account from the session cookie. (2) The session's human changed while a human mutation was being authorized. Never returned to agent credentials. | The browser reloads before doing anything else. | `NOT_APPLICABLE` | `reload_browser` |
| `RATE_LIMITED` | 429 | Request rate limit, or too many concurrent event streams for one principal. Includes a `retry-after` header (seconds) and `retryAfterSeconds` in the body. | Wait at least `retry-after`, then retry with jittered backoff. | `DEGRADED` until a request succeeds | `service_busy` |
| `INTERNAL_SERVER_ERROR` (500), `AUTH_UNAVAILABLE` (503), any other 5xx, a non-JSON 502/503/504 from the edge, a network error or a timeout | 5xx / none | Server, edge or network failure. Never an authorization decision. | Retry with bounded exponential backoff and jitter, and keep all credentials. A refresh that fails this way keeps its pending `rotationId` and retries with the **same** ID (A1 recovery). | `DEGRADED` until a request succeeds | `service_unavailable` |

#### 2.1 Precedence on access-token routes

`RATE_LIMITED` may be returned before any of these checks. After that, the first matching check wins:

1. `AUTHENTICATION_REQUIRED`: no recognizable token for this route.
2. `CREDENTIAL_REVOKED`: the family is revoked, even if the access token has also expired.
3. `CREDENTIAL_EXPIRED`
4. `ACCESS_TOKEN_EXPIRED`
5. `AGENT_PAUSED`: only on the operations listed in §2. A paused agent learns it is paused before any validation or permission error.
6. Validation `400`s and permission `403`s, which are unchanged.
7. `CASE_CONTROLLED`

A valid paused credential is therefore never reported as `401`. An expired or revoked one always is.

#### 2.2 Refresh outcome order (`POST /api/agent-token`)

The first matching step wins:

1. `rotationId` missing or malformed → `ROTATION_ID_REQUIRED`.
2. Token unknown, malformed or not retained → `REFRESH_TOKEN_INVALID`.
3. Family or agent revoked or removed → `CREDENTIAL_REVOKED`.
4. Family expired → `CREDENTIAL_EXPIRED`.
5. Token already used:
   - the used record has no stored `rotationId` hash → `REFRESH_TOKEN_INVALID`;
   - a different `rotationId` → `REFRESH_REPLAY`, and the family is revoked;
   - the same `rotationId`, inside the recovery window → `200` with the identical successor;
   - the same `rotationId`, after the window or when the envelope cannot be decrypted → `REFRESH_RECOVERY_EXPIRED`.
6. Token unused but past its own expiry → `REFRESH_TOKEN_INVALID`.
7. Otherwise → `200` with a new successor. The agent may be `active` **or** `paused`, and the response does not say which.

For step 5, A-1 adds the hash of the consuming `rotationId` to the used refresh-credential document. That keeps the cases distinguishable after the 5-minute encrypted envelope is reaped. This is a new field on a stored document, not a SQL migration. Records written before A-1 lack it and fall under the first bullet of step 5.

**Current behavior:** steps 2–6 all return `{ "error": "REQUEST_FAILED", ... }` with HTTP `401`. A paused agent's refresh is rejected. A replay does not revoke the family.

### 3. Paused agent behavior

An agent is paused when the owner calls `POST /api/inboxes/{inboxId}/agents/{agentId}/pause`. A paused agent stays **addressable and authenticated**: it can observe and maintain its credential but cannot act (`canReceive` true, `canAct` false; v3 §11).

| Operation by a paused agent with a valid **access token** | Result |
| --- | --- |
| `POST /api/agent-token` (refresh) | `200` with a normal successor. Refresh never grants action rights. |
| `GET /api/agent/status` (new in v1) | `200` `{ "state": "paused", "agent": { "id", "address", "status": "paused" }, "inboxId" }`. An active agent gets `"state": "active"`. A5 adds presence fields additively. |
| `POST /api/agent/connection-status` | `200`, as today. |
| `GET /api/inboxes/{inboxId}/events` (SSE) and `.../events/delta` | Allowed. Pausing **no longer closes** the stream (§5). |
| Read-only `GET`s the access token could already make (inbox, cases, messages) | Allowed. |
| `POST /api/agent/work/claim` | `200` `{ "work": null, "state": "paused" }`. Never an error. |
| Any request on `/mcp`, including `initialize` and `tools/list` | HTTP `409` with the §1 envelope, `code: "AGENT_PAUSED"`, not a JSON-RPC result. MCP clients surface it as a transport error. |
| Any request made with an `mcp_read` token, including `GET`s | `409 AGENT_PAUSED`. Model-held read tokens stop working during a pause. |
| Any other mutating request, including settling a lease claimed before the pause | `409 AGENT_PAUSED` |

Every claim response gets a `state` field:
- `"claimed"` when `work` is present;
- `"idle"` when there is nothing to claim;
- `"paused"` as above.

The rest of the claim response does not change. `work.message` remains the stored message record: either the full native agent message (schema `nativeWorkMessage`: protocol envelope fields plus `senderType`, `senderAgentId`, `senderInboxId`, `recipientAgentId`, `recipientInboxId`, `recipientEmail`, `transport: "native"`, `text` and `status`), or a human instruction in its current shape. `nextAvailableAt` is reserved for `a4-wake`.

**Current behavior:** a paused agent's claim, MCP request and status read all return `401`. Its `mcp_read` token is rejected too, because `getAgentPrincipal` requires `active`.

#### Held work

Pause alone never:
- consumes a delivery or work attempt;
- advances backoff;
- dead-letters anything.

Held work stays durable until one of three things happens: resume, explicit human cancellation, or a separately documented retention action.

- **Inbound to a paused recipient.** The sender's request is accepted exactly as if the recipient were active: `202`, `status: "queued"`, no `404`, no dead letter. In a case with **no** held outbound message, delivery then proceeds normally. The message reaches the paused recipient's inbox (`status: "delivered"`), and only the recipient's work is held: it is not claimable until resume. **Current behavior:** `404 Recipient is unavailable`.
- **Outbound from a paused sender.** On pause, the agent's already-queued outbound items move to `status: "held"` with `heldReason: "sender_paused"` and `heldAt`. Attempt count and next-attempt time do not change. The paused agent and its owner see this on the message record (fixture `sender-paused-held-message`).
- **D1 per-case barrier.** Outbox ordering is strict per case in both directions: the `orderingKey` is the `caseId`. While a case has a `sender_paused` message, every later outbox item in that case stays queued behind it. This includes the active counterparty's reply. That reply is still accepted with the same `202` and `status: "queued"` as any other send. The counterparty is **not** told that the other side is paused, and it never sees a held message ID. The item is never rejected or dead-lettered, and it is delivered in order once the barrier clears. On the owner's side, the message record shows `status: "held"`, `heldReason: "case_ordering"` and `heldBehindMessageId`. This is the explicit exception to v3 §12 for that case only.
- **Barrier release.** The barrier stays while **any** `sender_paused` message remains in the case. It clears in one of two ways:
  - **Resume.** The sender's held messages become eligible in order, followed by the items behind them.
  - **Human cancellation.** A human cancels the held messages, each with `POST /api/inboxes/{inboxId}/messages/{messageId}/cancel` (human session, workspace manager). The response is `200` with the message in `status: "cancelled"`. Cancellation publishes `message.cancelled` (§5). It does **not** resume the agent. When the last `sender_paused` message in a case is cancelled, the case is released immediately.
- **In-flight lease.** Pausing during a fenced claim invalidates the lease.
  - Later settlement with that lease returns `409 AGENT_PAUSED`.
  - The attempt count does not increase.
  - On resume, the work is offered again with a new fence and the same idempotency protection.
  - External effects committed before the pause stay recorded and are not silently retried.
- **Oversight.** The owner sees the held count and the oldest held age. A-1 names the UI fields; this contract does not.

### 4. Reconnect while paused

**Issuing.** The owner can issue a reconnect token (`POST /api/inboxes/{inboxId}/agents/{agentId}/credentials/reconnect-token`) for an approved agent that is **active or paused**. The response is today's `201` response.

**Redeeming.** Redeeming the token at `POST /api/agent-enroll` issues a new credential family for the **same** identity, so address, cases and history are kept.
- As today, it **revokes every earlier family**. Their holders get `CREDENTIAL_REVOKED` with `reason: "replaced"`.
- The response is today's reconnect response with `agent.status: "paused"`. The agent stays paused.
- Claims and actions reopen only after a separate human resume.

**Current behavior:** issuing and redeeming both require `active`.

The long-pause path:
1. The agent is offline for more than 30 days while paused.
2. Refresh returns `CREDENTIAL_EXPIRED`, and the connector moves to `NEEDS_RECONNECT`.
3. The owner reconnects. The connector is now `PAUSED` with fresh credentials.
4. The owner resumes. The connector moves to `RUNNING`.

### 5. Events

**Persisted events** use the existing stream format:
- the SSE `id` is the event cursor;
- the SSE `event` is the type;
- `data` is the JSON event `{ id, type, createdAt, sequence, cursor, ... }`.

Clients ignore unknown fields and unknown event types.

| Event | When | Fields beyond the common ones |
| --- | --- | --- |
| `agent.paused` | The owner pauses the agent. The stream stays open afterwards. | `agentId`, `humanId`, `status: "paused"` |
| `agent.resumed` | The owner resumes the agent. | `agentId`, `humanId`, `status: "active"` |
| `work.available` | **New.** Sent right after `agent.resumed` when the agent has held work, so it does not wait for a poll. | `agentId`, `reason: "agent_resumed"` |
| `message.cancelled` | **New.** A human cancels a held message. Sent to the canceling owner's inbox. | `messageId`, `caseId`, `humanId` |

`agent.paused` and `agent.resumed` already exist today with these fields. The change is that the stream is no longer closed after `agent.paused`.

When the connector receives `agent.resumed`, it leaves `PAUSED` and claims once immediately, whether or not `work.available` follows. `a4-wake` will add more `work.available` reasons, so v1 consumers must accept any `reason` string.

**Stream control event.** Agent streams re-check their credential family on every heartbeat, and also immediately on revoke, replay or reconnect.

- **When it fires.** The family is revoked, replaced or expired.
- **What the server sends.** It writes `event: credential.ended` with `data: { "code": "CREDENTIAL_REVOKED" | "CREDENTIAL_EXPIRED", "reason"? }` and no `id`, then closes the stream.
- **Why there is no `id`.** It is not a persisted event, so it does not move the cursor.
- **How the connector reacts.** It applies the lifecycle for that `code` from §2.

**Current behavior:** agent streams are never re-authorized, and `disconnectAgentStreams` closes them without sending an event. The stream itself does not reach the connector's error handling, so SSE connect errors (for example, too many streams) also use the §1 envelope after A-1.

### 6. Fixtures

**Fixture file fields.** Each fixture file has:
- `contract`, `version` and `id` (the file name without `.json`);
- `description`;
- `kind`: `http`, `sse` or `network`;
- the request and response, or the event, or the network failure;
- a `client` block with:
  - the expected `lifecycle`: a v3 §19 state, `UNCHANGED` or `NOT_APPLICABLE`;
  - the `retry` policy: `none`, `refresh_then_retry_once`, `after_retry_after`, `backoff`, `after_resume` or `after_case_resume`;
  - the required `guidance` (values from §2, plus `none`);
  - the `next` operation.

**What `test/contract-fixtures.test.js` checks.** Every HTTP response body and SSE event names a definition in `schemas.json`. The test then checks:
- every fixture against its schema;
- that `error` equals `code`;
- that each error fixture's HTTP status, lifecycle, retry and guidance match `x-codes`;
- that SSE ids are cursors;
- that no `message` and no fixture value contains a real-looking token. All token values are placeholders.

| Group | Fixtures |
| --- | --- |
| Codes | `agent-paused-send`, `agent-paused-settlement`, `agent-paused-mcp`, `agent-paused-mcp-read-token`, `credential-revoked-claim`, `credential-revoked-refresh`, `credential-replaced-claim`, `credential-expired-refresh`, `credential-expired-claim`, `access-token-expired`, `authentication-required`, `rotation-id-required`, `refresh-token-invalid`, `refresh-replay`, `refresh-recovery-expired`, `refresh-recovered`, `case-controlled`, `account-changed`, `rate-limited`, `server-error`, `auth-unavailable`, `edge-unavailable`, `network-failure-refresh` |
| Paused behavior | `paused-claim`, `idle-claim`, `claimed-work`, `paused-refresh`, `paused-status`, `paused-recipient-accepted`, `case-ordering-reply-accepted`, `sender-paused-held-message`, `cancel-held-message`, `reconnect-token-while-paused`, `reconnect-while-paused` |
| Events | `event-agent-paused`, `event-agent-resumed`, `event-work-available`, `event-message-cancelled`, `event-credential-ended` |

### 7. Compatibility and migration

**Server behavior changes old connectors will see after A-1.** Each one is less disruptive than today's behavior:
- A paused agent's claim returns `200` with `state: "paused"` instead of `401`.
- Its refresh succeeds instead of returning `401`.
- Pausing no longer closes SSE.
- A send to a paused agent is accepted instead of returning `404`.
- A detected refresh replay now revokes the family.

**Consumer changes Lane B must make (B-1 and B-3).** Without these, the new envelope reads badly or cannot be acted on:
- **Display text.** The TypeScript SDK (`sdk/typescript/src/index.ts` `responsePayload`), the Python SDK (`sdk/python/sinaloa_protocol`) and the connector's work calls (`sdk/typescript/src/connector.ts` `postWork`) take `body.error` as the human-readable text. After A-1, `error` is the code, so users would see `AGENT_PAUSED`. Read `message` for display.
- **Branching.** Pass `code` through to the thrown error so A2 can branch on it.
- **Statuses.** Add `held` and `cancelled` to the `DeliveryState` unions (`sdk/typescript/src/index.ts`, `frontend/src/types.ts`).
- **Browser.** The browser already reads `code` for `ACCOUNT_CHANGED`. It will now also catch path (2) in §2, which it misses today.

**Data.** No SQL migration is needed:
- `held` and `cancelled` are new values in the existing text status column, and held work keeps its attempt counters;
- the used refresh-credential document gains one field (§2.2).

**Rollback.** Reverting A-1 restores today's behavior. The rollback procedure written with A-1 must move messages left in `held` back to `queued`. Families revoked by a replay stay revoked.

### 8. Revisions within v1

- **MISMATCH round 1, from Lane B, against `564b9dd`.** `claimed-work.json` returned a cut-down `work.message` with no sender or recipient fields, and the existing SDK correctly rejected it. This was a fixture error, not a contract change, so the version stays 1:
  - the fixture now carries the complete stored native message;
  - `claimClaimed.work.message` now requires `nativeWorkMessage` (or a human instruction);
  - the fixture test also checks the message's protocol envelope with the server's own `assertValidProtocolMessage`.

- **v2 (`envoi-names` v1, Envoi naming N1), approved 2026-10-10 (`CONTRACT-APPROVED a3-pause-auth v2`, build board #34, after Lane B `CONTRACT-ACK`).** The only change is the credential prefixes in fixtures and schemas: `envoi_agent_access_`, `envoi_agent_refresh_` and `envoi_mcp_read_`, with example addresses on `envoi.mail`. Codes, statuses, lifecycle, events and behaviour are identical to v1. The regenerated v2 fixtures land in that PR together with the server change, so fixtures and server never disagree on one SHA; `index.json` lists a3 as version 2, status `published`. It needs a Lane B ACK and human approval like any version.

- **v3 (`envoi-browser-names` v1 §3, Envoi naming N2), approved 2026-10-11 (`CONTRACT-APPROVED a3-pause-auth v3`, build board #34, after Lane B `CONTRACT-ACK`).** Name-only: the three human-session fixtures (`account-changed`, `cancel-held-message`, `reconnect-token-while-paused`) send `cookie: envoi_session=…; envoi_csrf=…`, `x-envoi-csrf` and an `origin`, so the real server's CSRF gate passes them before the case each one describes; v2 had neither a CSRF cookie nor an origin. Every fixture's `version` is 3. Codes, statuses, lifecycle, events and behaviour are identical to v2. The fixtures land with the N2-server implementation and integrate on one SHA with N2-client, which moves Lane B's review pin to v3; it needs a Lane B ACK and human approval like any version.

## a4-wake v1

**Contract:** `a4-wake`, version 1. **Status:** approved by the human on 2026-10-10 (`CONTRACT-APPROVED a4-wake v1 @e9c00ac`, build board #34) after Lane B `CONTRACT-ACK`. Frozen: changes need a new version.

**Fixtures:** [`test/contract-fixtures/a4-wake/`](../../../test/contract-fixtures/a4-wake/), which holds:
- `schemas.json`: the schemas plus the `x-codes` table;
- one JSON file per case.

**Owner:** Lane A. **Consumer:** Lane B (B-2 resilient wake). **Implemented by:** task A-2. Nothing here changes server behavior until A-2; anything A-2 changes is marked **Current behavior**.

This contract builds on `a3-pause-auth` v1:
- its error envelope and codes;
- `credential.ended`;
- `GET /api/agent/status`;
- the `agent.paused`, `agent.resumed` and `work.available` events (a3 §5).

It defines how a connector learns that work may be waiting:
- the event stream and resume rules;
- the delta endpoint for gaps;
- which events trigger a claim;
- the claim hint;
- the bounded polling a connector must keep.

**The queue stays authoritative.** Every wake signal is only a hint to call `POST /api/agent/work/claim`. A connector that misses every event must still settle all work through claims. There is no new WebSocket service and no parallel queue (v3 §21–§26).

### 1. Cursors

- **Scope.** A cursor identifies one stored event in one inbox. Clients store the last *processed* cursor **keyed by `inboxId`**.
- **Format.** A cursor is the event's sequence number written as exactly 20 decimal digits, zero-padded (for example `00000000000000000042`). Sequences are allocated per inbox in commit order, so within one inbox comparing two cursors as strings is the same as comparing them as numbers.
  - Clients may compare cursors of the same inbox to drop duplicates or detect regressions. The TypeScript connector already does this.
  - Clients never construct cursors and never compare cursors across inboxes.
- **No other format is served.** The server never serves events without a sequence. If an inbox still has such legacy events, its history is reported as `EVENT_HISTORY_UNAVAILABLE` (§5) until migrated. **Current behavior:** a `createdAt|id` fallback cursor exists in code for unmigrated events.
- **Validation.** A resume cursor is rejected with `EVENT_CURSOR_INVALID` if it is:
  - not exactly 20 digits;
  - or greater than the inbox's newest sequence, for example after a database restore restarted sequences or when it comes from another inbox.

  Silently accepting such a cursor would skip events.

### 2. Event stream

`GET /api/inboxes/{inboxId}/events` (SSE).

**Authentication**
- The stream takes the agent's **access** token and is allowed while paused (a3 §3).
- An `mcp_read` token is rejected with 401 `AUTHENTICATION_REQUIRED`.
- A request that carries a human session cookie is treated as a human stream, so connectors must not send cookies.
- **Current behavior:** auth failures on this route use the old `{ error }` shape. A-2 uses the a3 envelope.

**Where the stream starts**

| Request | Start |
| --- | --- |
| `Last-Event-ID` header (takes precedence) or `?cursor=` | After that cursor. An empty value means no cursor. |
| `?from=latest` and no cursor | No replay. `ready` reports the inbox's newest cursor (or `null` for an empty inbox), which the client stores as its baseline (see below). For a connector with no stored cursor for this inbox, or one resetting after `EVENT_CURSOR_INVALID`. It then claims. (New in A-2.) |
| Neither | Replay from the beginning of the inbox history. |

**Replay limit.** One connection replays at most 500 events (5 pages of 100). Beyond that the server sends `replay_required`, and the client continues through delta (§3).

**Frames**

| Frame | SSE `id` | `data` | Meaning and client action |
| --- | --- | --- | --- |
| Stored event (e.g. `message.delivered`) | its cursor | the event JSON `{ id, type, createdAt, sequence, cursor, ... }` | Apply it, then store `cursor`. Ids increase strictly on one connection and start above the resume cursor. Drop anything at or below the stored cursor. |
| `ready` | none | `{ inboxId, at, cursor }`. On a `from=latest` stream, `cursor` is the inbox's newest cursor. Otherwise it is the last cursor sent on this connection, else the resume cursor, else `null`. | Replay is complete and live events follow. **Claim once** (§4). Store `cursor` only on a `from=latest` stream (baseline rule below). |
| `replay_required` | none | `{ cursor, hasMore: true }`; `cursor` follows the same rule as `ready` | The server could not finish replay on this connection and closes it. Page delta from your own last processed cursor until `hasMore` is false, reconnect from the newest cursor, then claim once. |
| `replay_error` | none | `{}` | Transient server failure, and the stream closes. Reconnect with backoff (§6). |
| `credential.ended` | none | a3 §5 | Apply the lifecycle for `data.code`. Do not reconnect with that credential. |
| `: keepalive <ISO time>` (comment) | — | — | Every 20 s. With no frame or comment for 60 s, close the stream and reconnect. |

**Cursor persistence.** The client keeps one stored cursor per inbox.
- **Normal rule:** it advances only when a stored event (a frame with an `id`) has been processed. Control frames without an `id` (`ready`, `replay_required`, `replay_error`, `credential.ended`) never advance it, and their `cursor` fields are informational.
- **Baseline exception:** on a `from=latest` stream, the client stores `ready.cursor` as its starting cursor before processing any later event. This applies only when the inbox has no stored cursor or the client is resetting after `EVENT_CURSOR_INVALID`. If `ready.cursor` is `null`, the stored cursor stays empty until the first event.
- **Why the exception is safe:** nothing is skipped silently. Pending work lives in the queue, and the claim that follows `ready` picks it up.

Clients ignore unknown event types and fields, but still store their cursor. Human-only frames (`session.recheck`, `session.expired`, `session.revoked`) are never sent to an agent stream.

**Current behavior:**
- `replay_required` carries `{}` only when a live stream's write queue overflows. A-2 sends `{ cursor, hasMore: true }` there too.
- A history that needs migration currently produces `replay_error`. A-2 detects it before opening the stream and returns 503 `EVENT_HISTORY_UNAVAILABLE` instead, so `replay_error` only ever means transient.

### 3. Delta endpoint

`GET /api/inboxes/{inboxId}/events/delta?cursor=<cursor>&limit=<1-200>`

**Request and response**
- The default limit is 100. Authentication is the same as the stream, and the endpoint is allowed while paused.
- The response is `200 { events, nextCursor, hasMore }`, where:
  - `events` are the events after `cursor`, in cursor order, with the same JSON as stream `data`;
  - `nextCursor` is the last returned cursor, or the request cursor when the page is empty, or `null` with no cursor;
  - `hasMore: true` implies the page is non-empty.
- Repeat with `cursor = nextCursor` until `hasMore` is false. A valid cursor equal to the newest event returns an empty page with the same cursor.

**Errors** (all use the a3 envelope)

| Code | When |
| --- | --- |
| `EVENT_CURSOR_INVALID` | Invalid cursor (§1). |
| `EVENT_LIMIT_INVALID` | Invalid limit. |
| `EVENT_HISTORY_UNAVAILABLE` | Unmigrated history. |

**Use:** delta is for recovery after `replay_required` only. Connectors do **not** poll delta periodically; the safety timer claims instead (§6).

**Current behavior:**
- A cursor longer than 512 characters returns `{ error: "Event cursor is invalid" }`.
- Other cursor, limit and history errors return `{ error: "REQUEST_FAILED", message, requestId }`.
- The stream's cursor 400 uses the `{ error }` shape.
- Cursors beyond the newest event are accepted silently.

### 4. When a connector claims

**Single flight.** At most one claim request is in flight. Triggers that arrive meanwhile collapse into at most one follow-up claim, sent when the current one returns.

**Triggers**
1. Startup.
2. `ready` on a new stream.
3. The end of delta recovery after `replay_required`.
4. `work.available` (any `reason`).
5. `agent.resumed`.
6. `message.delivered` or `human.instruction_created` whose `recipientAgentId` is this agent. A `message.delivered` for this agent's *own sent* message, whose `recipientAgentId` is someone else, is not a trigger.
7. A finished piece of work. The connector keeps claiming until the claim returns `idle`.
8. The safety timer or claim hint (§6).

All other events only advance the cursor.

**Paused.** A claim returning `state: "paused"` stops triggers 1–8 until the connector sees the agent active again, by either route:
- `agent.resumed`;
- or `GET /api/agent/status` returning `state: "active"`. A paused connector reads status after every `ready` or reconnect and every 30–60 s with jitter, so a missed or unreplayable `agent.resumed` cannot keep it paused forever.

**`work.available` reasons.** Consumers must accept any `reason` string; producers emit only these. Every event is written to the agent's own inbox and carries exactly `{ id, type, createdAt, sequence, cursor, agentId, reason }` plus `caseId` where noted. It never names the human or the other workspace.

| `reason` | `caseId` | Emitted when |
| --- | --- | --- |
| `agent_resumed` | no | The owner resumed this agent and inbound work is waiting (a3). |
| `case_resumed` | yes | A human (from either side) resumed a paused case. One event goes to each participant inbox whose agent has claimable inbound work in that case, in the same case mutation. |
| `counterparty_resumed` | no | An agent that had sent this agent delivered-but-unclaimable work (claims skip work from a sender that cannot act) was resumed. |
| `lease_released` | no | A reconnect issued a new credential family. The server released this agent's live leases held by the replaced families, without using an attempt (like the a3 pause re-offer), so the new installation can claim them now rather than waiting up to the lease length. |

Normal arrivals produce `message.delivered`, not `work.available`.

**Safety timer only.** These changes make work claimable with no event:
- retry delays ending;
- lease expiry;
- a contact being unblocked;
- human-instruction authority being restored.

They are covered by the claim hint (§5) and the safety timer (§6).

### 5. Claim hint

An empty claim (`state: "idle"`) may carry two fields:
- **`nextAvailableAt`**: an ISO time, never in the past;
- **`nextAvailableInMs`**: a non-negative integer, the same instant measured from the response.

Clients schedule from `nextAvailableInMs`, so clock skew does not matter.

The value is the earliest of two times, considering only work that passes every eligibility filter of the claim itself except time:
- the request's `acceptHumanInstructions`;
- the case not paused or revoked;
- the sender able to act;
- no block;
- attempts remaining;
- human-instruction authority.

The two times are:
- the `retryAt` of this agent's retryable work;
- the `leaseExpiresAt` of this agent's live leases from any of its credential families.

Both fields are absent when nothing is scheduled. They are never sent with `state: "paused"` and never refer to other agents' work. **Current behavior:** never sent.

### 6. Polling and backoff

**Safety timer**

| State | Rule |
| --- | --- |
| Healthy stream | Claim every 30–60 s, uniform jitter. A hint earlier than that schedules one claim at that time, at least 1 s away. |
| Disconnected or degraded (reconnecting, `replay_error`, missed keepalive) | Claim every 15 s ±20 % jitter. |
| Paused | No claims. Status as in §4. |

**Reconnect**
- Use exponential backoff from 1 s to 30 s with full jitter.
- Reset the backoff only after a stream has stayed open for 60 s.
- Close the previous stream before opening a new one.
- A 429 `RATE_LIMITED` on connect (for example too many concurrent streams) waits at least `retry-after`.

**Exactly-once settlement.** The claim fence and settlement idempotency keys (existing) make each piece of work settle exactly once. A handler can still run twice if its lease expires mid-run, so connectors renew leases while working and handlers dedupe by `workId`. Gate GA4 checks that retry-delayed work and work that arrived offline each settle exactly once after reconnect, with no new event.

### 7. Codes added to the a3 envelope

| Code | HTTP | Returned when | Next allowed operation | Lifecycle | Guidance |
| --- | --- | --- | --- | --- | --- |
| `EVENT_CURSOR_INVALID` | 400 | The resume cursor is malformed, or beyond the inbox's newest event (§1). | Discard the stored cursor for this inbox, reconnect with `from=latest`, and claim once. Work is not lost because the queue is authoritative. | `UNCHANGED` | `none` |
| `EVENT_LIMIT_INVALID` | 400 | The delta limit is not an integer from 1 to 200. | Keep the cursor and fix the limit. This is a client bug, so do not retry the same request. | `UNCHANGED` | `none` |
| `EVENT_HISTORY_UNAVAILABLE` | 503 | The inbox history needs a server-side cursor migration (stream connect or delta). | Retry with backoff and keep the disconnected safety timer. | `DEGRADED` | `service_unavailable` |

### 8. Fixtures

**Fields.** Fixtures use the a3 §6 fields, with two additions:
- **`client.claim`**: whether the outcome triggers exactly one claim.
- **`kind: "sse-session"`**: has a `request` (with resume headers or query) and `frames`, an ordered list. Each frame is either `{ id?, event, data, schema }` (`schema` is required on event frames) or `{ comment }`.

**What the fixture test checks**
- **Stream frames:** control frames carry no `id`, and stored events do. Ids rise above the resume cursor. `ready` and `replay_required` report the right cursor.
- **Delta pages:** `nextCursor` and `hasMore` are consistent, and cursors rise above the request cursor.
- **Events:** producer schemas are closed.

| Group | Fixtures |
| --- | --- |
| Stream | `stream-resume-last-event-id`, `stream-resume-query-cursor`, `stream-ready-no-replay`, `stream-from-latest`, `stream-replay-required`, `stream-replay-error`, `stream-keepalive`, `stream-credential-ended`, `stream-cursor-invalid`, `stream-cursor-beyond-newest`, `stream-history-unavailable`, `stream-mcp-read-rejected` |
| Wake events | `event-message-delivered-to-agent`, `event-message-delivered-own-send`, `event-work-available-case-resumed`, `event-work-available-counterparty-resumed`, `event-work-available-lease-released` |
| Delta | `delta-page-more`, `delta-last-page`, `delta-empty-after-cursor`, `delta-cursor-invalid`, `delta-limit-invalid`, `delta-history-unavailable` |
| Claim | `claim-idle-next-available`, `claim-idle-no-hint`, `claim-paused-no-hint` |

### 9. Compatibility and B-2 notes

**Server changes are additive for a3 clients:**
- the new `work.available` reasons;
- the claim hint;
- coded stream and delta errors;
- `from=latest`;
- `cursor` always present in `replay_required`;
- releasing old-family leases on reconnect.

No new endpoints and no data migration.

**Consumer changes for B-2:**
- stop polling delta every 5 s (`sdk/typescript/src/connector.ts`, `deltaPollMs`) and use the §6 safety timer instead;
- key stored cursors by `inboxId`;
- read status while paused;
- treat `EVENT_CURSOR_INVALID` as "restart with `from=latest`".

**Rollback:** reverting A-2 removes the hints, the new reasons and `from=latest`. Clients fall back to the safety timer, which they must keep anyway.

### 10. Revisions within v1

- **MISMATCH round 1 (Lane B, `stream-from-latest`, against `67df29d`).** The no-id invariant contradicted the `from=latest` fixture, which told the client to store `ready.cursor`. §2 now separates the processed cursor, which only stored events advance, from the explicit `from=latest` baseline exception (no stored cursor for the inbox, or reset after `EVENT_CURSOR_INVALID`). The `ready` row and the wording of two fixtures now match. This is a clarification, so the version stays 1.
- **v2 (`envoi-browser-names` v1 §3, Envoi naming N2), approved 2026-10-11 (`CONTRACT-APPROVED a4-wake v2`, build board #34, after Lane B `CONTRACT-ACK`).** Name-only: every placeholder token uses `envoi_agent_access_` (and `stream-mcp-read-rejected` uses `envoi_mcp_read_`), which `envoi-names` v1 had promised for v1 but the approved v1 fixtures never carried. The token-leak guard in `schemas.json` now matches both the `envoi_` and `sinaloa_` prefixes. Every fixture's `version` is 2; behaviour is identical to v1. It lands with N2-server, integrates on one SHA with N2-client (Lane B's review pin moves to v2), and needs a Lane B ACK and human approval.

## envoi-names v1

**Contract:** `envoi-names`, version 1. **Status:** approved by the human on 2026-10-10 (`CONTRACT-APPROVED envoi-names v1 @2591063`, build board #34) after Lane B `CONTRACT-ACK`. Frozen: changes need a new version.

**Fixtures:** [`test/contract-fixtures/envoi-names/`](../../../test/contract-fixtures/envoi-names/). **Owner:** Lane A. **Consumer:** Lane B. **Implemented by:** N1 (see [`docs/architecture/envoi-naming-plan.md`](../envoi-naming-plan.md)).

**What it changes:** every agent-facing name moves from Sinaloa to Envoi.

**Decision (human, 2026-10-09).** There are no beta testers yet, so this is a **clean cutover**:
- the server and every client change on **one integration SHA**;
- the server offers **no `sinaloa_*` aliases**;
- credentials issued before the cutover stop working, and their owners reconnect (§2).

This contract also defines **`a3-pause-auth` v2**. The only change is the credential prefixes in a3's fixtures and schemas; everything else is unchanged from v1. The regenerated a3 v2 fixtures are published with the N1 implementation PR, so the server and its fixtures change on the same SHA.

`a4-wake` v1, which is not yet approved, uses the new prefixes in its fixtures within v1.

### 1. MCP tool names

`tools/list` returns these names, and `tools/call` accepts only them. A call to a `sinaloa_*` name gets JSON-RPC error `-32602` "Tool not available to this agent", the same response as any unknown tool. Arguments, results and scopes are unchanged.

| Old | New |
| --- | --- |
| `sinaloa_agent_info` | `envoi_agent_info` |
| `sinaloa_list_cases` | `envoi_list_cases` |
| `sinaloa_read_case` | `envoi_read_case` |
| `sinaloa_list_messages` | `envoi_list_messages` |
| `sinaloa_start_case` | `envoi_start_case` |
| `sinaloa_send_message` | `envoi_send_message` |
| `sinaloa_send_proposal` | `envoi_send_proposal` |
| `sinaloa_send_decision` | `envoi_send_decision` |
| `sinaloa_send_completion` | `envoi_send_completion` |
| `sinaloa_claim_work` | `envoi_claim_work` |
| `sinaloa_renew_work` | `envoi_renew_work` |
| `sinaloa_acknowledge_work` | `envoi_acknowledge_work` |
| `sinaloa_complete_work` | `envoi_complete_work` |
| `sinaloa_fail_work` | `envoi_fail_work` |
| `sinaloa_list_assets` | `envoi_list_assets` |
| `sinaloa_begin_asset_upload` | `envoi_begin_asset_upload` |
| `sinaloa_complete_asset_upload` | `envoi_complete_asset_upload` |
| `sinaloa_asset_download` | `envoi_asset_download` |
| `sinaloa_grant_asset` | `envoi_grant_asset` |

A model-held `mcp_read` token still lists only `envoi_agent_info`, `envoi_read_case` and `envoi_list_messages`. The MCP `serverInfo.name` stays `envoi`.

### 2. Credential formats

| Credential | Format |
| --- | --- |
| Access token | `envoi_agent_access_` + 43 base64url characters |
| Refresh token | `envoi_agent_refresh_` + 64 base64url characters |
| Case read token (`mcp_read`) | `envoi_mcp_read_` + 43 base64url characters |

**Issuing.** The server issues only these formats. That covers enrollment, reconnect, refresh, the A1 recovery successor and `mcp-read-token`.

**Accepting.** The server accepts only these formats. Credentials are stored hashed, so a credential issued before the cutover carries the old `sinaloa_` prefix and is refused with an a3 code:
- an access or `mcp_read` token gets `AUTHENTICATION_REQUIRED`;
- a refresh token gets `REFRESH_TOKEN_INVALID`.

The connector moves to `NEEDS_RECONNECT` and the owner reconnects the same identity (a3 §4), which issues `envoi_` credentials. Agent identity, address, cases and history are kept.

**On staging and beta:** the cutover deploy is announced on the build board, and any test agent reconnects once.

### 3. Other agent-facing names

- **Health identity.** `/health` and `/ready` report `service: "envoi"` (already integrated: PRs #46 and #48).
- **Protocol schema `$id`:**
  - the message schema is `https://envoi-agents.com/schemas/protocol/v1/message.json`, in file `protocol/envoi-protocol-v1.schema.json`;
  - the agent interface is `https://envoi-agents.com/schemas/agent-interface/v1.json`.

  Messages themselves carry `schemaVersion: "1.0"` and do not change.
- **Downloads.** `web/downloads/` serves only `envoi-connector.mjs` and `envoi-openclaw.mjs`, and `release.json` lists only those. The `sinaloa-*.mjs` duplicates are no longer built (`scripts/package-openclaw.mjs`, Lane A) or served.

### 4. Client names (Lane B; informative)

Lane B owns these names. They are listed so the cutover is complete on one SHA:
- **TypeScript:** `@envoi/protocol` with `EnvoiClient`, `EnvoiConnector`, `EnvoiError` and `EnvoiIntent`.
- **Python:** `envoi-protocol` / `envoi_protocol`.
- **Connector:**
  - internal identifiers and every user-visible string;
  - the state directory `…/envoi/<runtime>/<id>`, migrating an existing `…/sinaloa/…` directory once on first start;
  - OS service labels `com.envoi.*`;
  - Hermes, OpenClaw and xAI adapter prompts and relays use only the `envoi_*` tool names.

### 5. Fixtures

**Fixtures:**
- `mcp-tools-list`
- `mcp-tools-list-case-read`
- `mcp-call-old-name`
- `credentials-issued`
- `access-old-prefix`
- `refresh-old-prefix`
- `mcp-read-old-prefix`
- `health-identity`

`schemas.json` carries the tool-name mapping as `x-tool-names`. Clients can assert their adapters reference only the new names.

## a5-presence v1

**Contract:** `a5-presence`, version 1. **Status:** approved by the human on 2026-10-11 (`CONTRACT-APPROVED a5-presence v1 @a232f46`, build board #34) after Lane B `CONTRACT-ACK` (consuming tests in PR #62). Frozen: changes need a new version. Implemented by A-3.

**Fixtures:** [`test/contract-fixtures/a5-presence/`](../../../test/contract-fixtures/a5-presence/). That holds:
- `schemas.json`: the schemas plus the machine-readable tables `x-presence-throttle`, `x-presence-updates`, `x-presence-never`, `x-connection-states` and `x-agent-labels`;
- one JSON file per case.

**Owner:** Lane A. **Consumer:** Lane B (B-3 presence UI and connector diagnostics). **Implemented by:** task A-3.

This contract adds minimal Phase A presence (v3 §27–§28; two-owner plan A5). It records when the server last heard from an installation, and it shows that to the agent's owner in conservative terms. It builds on:
- `a3-pause-auth` v2: credential families, pause, and `GET /api/agent/status`;
- `a4-wake` v1: the claim loop and safety timer that keep a healthy connector talking to the server.

**What presence means.** Presence is evidence that **some process holding this installation's credentials** recently called the server. It is never proof of any of these:
- that a runtime is running;
- that a model is reachable;
- that work will be processed.

The UI must not say "online", "running" or "connected" (§5).

### 1. Presence is an installation projection

- **Keyed by credential family.** There is one presence record per credential family. In Phase A a credential family *is* the installation. Families are created by enrollment redemption, by onboarding approval and by a reconnect or re-enroll redemption. Each reconnect replaces the earlier families (a3 §4).
- **Phase B migration.** When `AgentInstallation` arrives (v3 §43–§44), each family's record becomes that installation's presence:
  - `lastSeenAt` → `lastSeenAt`;
  - `lastWorkClaimAt` → `lastClaimAt`;
  - `lastProcessedAt` → `lastProcessedAt`;
  - `lastSuccessfulRefreshAt` stays with the installation's credential.

  The agent identity is never reinterpreted as a runtime.
- **Stored apart from authorization.** This is a deliberate deviation from the wording "fields on the existing credential family" in v3 §27 and the build plan.
  - The record lives at `auth/agent-presence/{inboxId}/{agentId}/{familyId}.json`, not inside the family document.
  - The family document is written read-modify-write by refresh, revocation and setup reports. A presence write inside it could overwrite a concurrent revocation or expiry roll.
  - It is a new document path on both FileStore and PostgreSQL, not a SQL migration. No existing listing reads that prefix.
- **What it never holds.** No IP address, user agent, host name, runtime version, request path or token material. It holds only the four timestamps below.
- **Removal.** Removing an agent deletes all of its presence records, with or without `deleteHistory`.

### 2. Fields

| Field | Meaning |
| --- | --- |
| `lastSeenAt` | The last request authenticated by this family's credential (§3), including setup checks. **Diagnostic only:** it decides the connection state only while the agent is paused (§4.2). |
| `lastSuccessfulRefreshAt` | The last `POST /api/agent-token` that returned `200` for this family. That covers both a new successor and an A1 recovery of the same successor. |
| `lastWorkClaimAt` | The last **work-loop** request: a `POST /api/agent/work/claim` answered with `state: "claimed"` or `state: "idle"`, or a lease request (`renew`, `acknowledge`, `complete`, `fail`, instruction `reply`) with any outcome except `409 AGENT_PAUSED`. It shows that the connector's work loop is talking to the queue, not that work was found. Renewals keep it fresh during a long handler. A paused claim (`state: "paused"`) does not count. |
| `lastProcessedAt` | The last work `complete` that returned `201`, meaning the message became `processed`. An idempotent replay (`200`) of an earlier completion does not count. |

Each value is either an ISO 8601 UTC timestamp with milliseconds, taken from the server's clock, or `null` if it never happened.

**Write rules**
- **After the outcome, outside the request's transaction.** The server records presence once the response outcome is known, for the family that authenticated the request. It never writes inside a request's mutation or transaction. So a presence write cannot be rolled back by a failing request, and it cannot abort a successful one.
- **Throttled.** A field is written only when its stored value is absent or at least **60 s** older than the new value. Each field therefore changes at most once per family per 60 s, however many requests arrive and across all server instances. The one exception is the next rule.
- **`lastSeenAt` leads.** A write that advances any other field also advances `lastSeenAt` to the same time in the same document write, outside `lastSeenAt`'s own throttle. So `lastSeenAt` is never earlier than the other three.
- **Monotonic.** A field never moves backwards, even under concurrent requests. Each write is a single conditional storage operation that compares in storage, not in memory. A-3 adds this primitive to both FileStore and PostgreSQL; `claimJson` only checks for absence.
- **Lag.** When writes succeed, a stored value is at most 60 s earlier than the latest activity it records, and never later than it.
- **Best effort.** A presence write never changes a response's status or body. If the write fails, the request still succeeds and the failure is logged.
- **Quiet.** Presence writes are not audited and publish no events.

### 3. What updates presence

The same table is machine-readable in `schemas.json` → `x-presence-updates`. A-3 tests each row on FileStore and PostgreSQL.

**"Authenticated" means** that the server resolved the bearer token to an identity:
- a typed `envoi_` access or refresh credential of a family that is not revoked or expired;
- belonging to an approved agent that is `active` or `paused`.

That is the identity a3 §2.1 checks 1–4 accept. Credentials of pending or legacy agents, and untyped development tokens, never write presence.

| Request (authenticated by this family) | Outcome | `lastSeenAt` | `lastSuccessfulRefreshAt` | `lastWorkClaimAt` | `lastProcessedAt` |
| --- | --- | --- | --- | --- | --- |
| `POST /api/agent-token` (refresh token) | `200` | ✓ | ✓ | | |
| `POST /api/agent/work/claim` | `200`, `state` is `claimed` or `idle` | ✓ | | ✓ | |
| `POST /api/agent/work/claim` | `200`, `state: "paused"` | ✓ | | | |
| `POST /api/agent/work/{workId}/complete` | `201` | ✓ | | ✓ | ✓ |
| `POST /api/agent/work/{workId}/{renew,acknowledge,complete,fail}`, `POST /api/agent/instructions/{id}/reply` | any other response except `409 AGENT_PAUSED` | ✓ | | ✓ | |
| Any other request with an authenticated **access** token. Examples: status, connection-status, event stream connect, delta, `/mcp`, sends, case actions, read-only `GET`s | Any response, including validation `400`, permission `403`, `409 AGENT_PAUSED`, `CASE_CONTROLLED` and a `429` returned after authentication | ✓ | | | |

**What never updates presence**
- **Rejected credentials.** Any `401` (`AUTHENTICATION_REQUIRED`, `ACCESS_TOKEN_EXPIRED`, `CREDENTIAL_EXPIRED`, `CREDENTIAL_REVOKED`, `REFRESH_*`, and the uncoded `401` that pending agents get), `ROTATION_ID_REQUIRED`, and a `429 RATE_LIMITED` returned before authentication.
- **Model-held `mcp_read` tokens.** They are bearer tokens a model may pass around, so they are not evidence of the installation.
- **Enrollment and reconnect redemption** (`POST /api/agent-enroll`). Setting up credentials does not show that a runtime keeps running.
- **Holding a stream open.** Only the stream **connect** counts. Keepalives and the heartbeat credential re-check (a3 §5) do not, because a half-open connection can keep accepting writes.
- **Anything a human does.** Browser sessions, approval, pause, resume, issuing a reconnect token and an open dashboard never touch presence.

**Setup traffic.** Setup and doctor commands call `GET /api/agent/status` and `POST /api/agent/connection-status` from a short-lived process (for example `integrations/openclaw/quick-connect.ts`). Those update `lastSeenAt` only. For an active agent they never make it `seen_recently`, because that needs work-loop activity (§4.2). The setup report's `ready`/`error` result stays a setup check (`connectionSetup`) and never changes the connection state.

### 4. Where presence is exposed

**Bounded.** Each response carries exactly the fields below, for one family per agent. There is no history, list or per-request detail.

#### 4.1 The agent: `GET /api/agent/status`

The a3 status response gains two fields:
- `presence`: the calling family's four fields (§2), as stored;
- `asOf`: the server's time when it built the response.

The request's own update may not be included yet, so values can be up to 60 s behind. `asOf` follows the §4.2 rule: it is never earlier than any `presence` timestamp. Connector doctor or setup output may show these values, computing ages from `asOf`. The connector's lifecycle never depends on them.

```json
{
  "state": "active",
  "agent": { "id": "agent_example", "address": "example@envoi.mail", "status": "active" },
  "inboxId": "inbox_example",
  "asOf": "2026-10-12T12:00:42.000Z",
  "presence": {
    "lastSeenAt": "2026-10-12T12:00:00.000Z",
    "lastSuccessfulRefreshAt": "2026-10-12T11:52:10.000Z",
    "lastWorkClaimAt": "2026-10-12T12:00:00.000Z",
    "lastProcessedAt": null
  }
}
```

#### 4.2 The owner: `connection` on owner agent views

Owner views of an agent gain `connection`:
- `GET /api/inboxes/{inboxId}/agents`;
- the inbox view's `agents[]`;
- the pause and resume responses.

**Who sees it.** Only human sessions of the owning workspace.
- `GET /api/inboxes/{inboxId}/agents` also accepts the agent's own access token. For that caller the field is omitted; the agent reads its own presence from §4.1.
- `connection` is never sent to counterparties, never included in the participant directory and never put in events.

**Where it is computed.** In the owner response projection only, not in the agent control state the server uses for authorization decisions. So a presence read never slows or fails an authorization path.
- If the presence read fails, the server omits `connection` and the response still succeeds. `connection` is therefore optional for consumers. The `ownerAgent` schema describes the success path only.
- A client that gets no `connection` (a rolled-back server, or a failed read) shows "Status unknown". It never falls back to deriving "online" from enrollment or approval.

```json
"connection": {
  "state": "seen_recently",
  "asOf": "2026-10-12T12:00:42.000Z",
  "recentWindowSeconds": 300,
  "seenAt": "2026-10-12T12:00:00.000Z",
  "credentialExpiresAt": "2026-11-11T11:52:10.000Z",
  "presence": {
    "lastSeenAt": "2026-10-12T12:00:00.000Z",
    "lastSuccessfulRefreshAt": "2026-10-12T11:52:10.000Z",
    "lastWorkClaimAt": "2026-10-12T12:00:00.000Z",
    "lastProcessedAt": "2026-10-12T11:58:03.000Z"
  }
}
```

- **`asOf`** is the server's time when it built the response, raised if needed so it is never earlier than any `presence` timestamp (instances' clocks can differ slightly). `credentialExpiresAt` is not part of this rule. Clients compute ages as `asOf − timestamp`, never from their own clock, and clamp negative ages to 0.
- **`recentWindowSeconds`** is 300 in v1.
  - A healthy active connector claims every 30–60 s (a4 §6) and renews during long handlers, so with the 60 s write lag `seenAt` is at most ~120 s old.
  - A healthy paused connector reads status every 30–60 s (a4 §4), with the same bound.
  - 300 s absorbs a missed poll or a brief outage without flapping.
  - A connector run with no work handler never claims, so it shows `not_seen_recently`. Every shipped runtime has a handler.
- **`seenAt`** is the timestamp of the installation's last **check-in**, the one the state is based on:
  - `presence.lastSeenAt` while the agent is paused, because a paused connector reads status instead of claiming;
  - `presence.lastSeenAt` in the **resume grace**: the agent's `resumedAt` is at most `recentWindowSeconds` before `asOf`, and `lastWorkClaimAt` is `null` or earlier than `resumedAt`. A connector that was checking in while paused gets one window to claim after resume;
  - otherwise `presence.lastWorkClaimAt`.

  It is `null` when that field is `null`. A-3 records `resumedAt` on the agent record at each resume. Like other agent record fields, it appears in owner views.
- **Reported family.** The newest non-revoked family by `createdAt`. If every family is revoked, the newest family. If the agent has no family, there is none.
- **`credentialExpiresAt`** is the reported family's rolling `refreshExpiresAt` (a3 `CREDENTIAL_EXPIRED`). It is `null` when there is no family or the reported family is revoked.
- **`presence`** holds the reported family's four fields. They are all `null` when there is no family. A revoked agent keeps its last-known values.

**`connection.state`.** The first matching row wins. The same table, with UI labels, is in `x-connection-states`.

| # | Condition | `state` |
| --- | --- | --- |
| 1 | `status` is `revoked`, or `credentialRevoked` is `true` (every family revoked, for example after `REFRESH_REPLAY`) | `revoked` |
| 2 | `onboardingStatus` is `rejected` | `rejected` |
| 3 | `onboardingStatus` is any other value except `approved` | `pending_approval` |
| 4 | No credential family | `not_connected` |
| 5 | `credentialExpiresAt` ≤ `asOf` | `needs_reconnect` |
| 6 | `seenAt` is `null` | `never_seen` |
| 7 | `asOf − seenAt` ≤ `recentWindowSeconds` | `seen_recently` |
| 8 | Otherwise | `not_seen_recently` |

Removed agents are not listed, so they need no state.

- **Pause is separate.** `connection.state` describes the installation; the existing `paused` field describes the agent.
  - A paused agent whose connector keeps reading status is `seen_recently` with `paused: true`.
  - In the a3 long-pause path it becomes `needs_reconnect` with `paused: true`.
- **Right after resume.** The resume grace keeps the paused-time basis, so the resume response of a connector that was checking in says `seen_recently` with no flap. A running connector claims as soon as it sees `agent.resumed` (a4 §4), and the basis moves to `lastWorkClaimAt`. If it has not claimed when the grace ends, the state honestly becomes `not_seen_recently`.
- **Rejected after approval.** Rejecting an already-approved agent revokes its families, so it shows `revoked` (row 1), not `rejected`.
- **Only what the server can see.** Here, `needs_reconnect` means the family's expiry passed. A connector can also reach `NEEDS_RECONNECT` from codes the server cannot see afterwards, for example `REFRESH_TOKEN_INVALID` after a lost state file. The server shows those as `not_seen_recently` once the connector stops calling.
- **Unknown values.** Clients must accept unknown `state` values and show them as "Status unknown".

### 5. Owner UI wording (B-3)

| `state` | Connection label | Must never claim |
| --- | --- | --- |
| `seen_recently` | "Seen recently" | That the runtime is online, running or will process work |
| `not_seen_recently` | "Last checked in {relative time of `seenAt` from `asOf`}" | That the runtime is stopped or broken |
| `never_seen` | "Not checked in yet" | That enrollment or a passed setup check means the runtime runs |
| `not_connected` | "Not connected" | |
| `needs_reconnect` | "Needs reconnect" | |
| `pending_approval` | "Waiting for approval" | |
| `rejected` | "Not approved" | |
| `revoked` | "Access revoked" | |
| missing `connection`, or an unknown `state` | "Status unknown" | Anything derived from enrollment or approval |

- **Agent label** (`x-agent-labels`; first match wins):
  1. "Revoked" when `status` is `revoked` or `credentialRevoked` is `true`;
  2. "Rejected" when `onboardingStatus` is `rejected`;
  3. "Pending" when `onboardingStatus` is any other value except `approved`;
  4. "Paused" when `paused` is `true`;
  5. otherwise "Active".
- **Show both.** Show the agent label next to the connection label, for example "Paused · Seen recently".
- **Nothing in the browser changes the label.** Enrollment, approval, issuing a reconnect token or having the dashboard open never change it. Only `connection` does.
- **What "checked in" means.** A check-in is `seenAt`: the work loop talking to the queue, or a status read while paused. Setup checks are not check-ins.
- **Optional detail.** The UI may show the four timestamps, for example "Last processed work 2 min ago". Label `lastSeenAt` as "Last request", not "Last seen", so it never contradicts the connection label. `lastWorkClaimAt` means "the work loop checked in", not "received work".

### 6. Fixtures

**Fields.** Fixtures use the a3 §6 file fields: `contract`, `version`, `id`, `description`, `kind: "http"`, `request` and `response`. `request.auth` is `human_session` (a signed-in member of the owning workspace) or `agent_access`. Only the `client` block differs from a3:
- **Owner fixtures** have `client.surface: "owner_ui"`, plus `client.connectionLabel` and `client.agentLabel` (the §5 wording).
- **Agent status fixtures** have `client.surface: "connector"` and `client.lifecycle`, which is unchanged from a3.

**What `test/contract-fixtures.test.js` checks**
- Every response against its schema.
- Each owner fixture's `seenAt` and `connection.state`, re-derived from §4.2 using the fixture's own `agent`, `asOf`, `credentialExpiresAt` and `presence`.
- The connection label against `x-connection-states`, and the agent label against the §5 rule (plus the `x-agent-labels` order).
- That no `presence` timestamp is later than `asOf`.
- That `lastSeenAt` is never earlier than the other three (§2, "`lastSeenAt` leads").
- That tokens are placeholders.

| Group | Fixtures |
| --- | --- |
| Owner list | `owner-seen-recently`, `owner-resume-grace-expired`, `owner-not-seen-recently`, `owner-never-seen` (setup checks only), `owner-not-connected`, `owner-pending-approval`, `owner-rejected`, `owner-needs-reconnect`, `owner-paused-seen-recently`, `owner-paused-needs-reconnect`, `owner-revoked`, `owner-revoked-refresh-replay` |
| Owner control | `owner-pause-response`, `owner-resume-response` |
| Agent | `agent-status-presence`, `agent-status-paused-presence` |

### 7. Compatibility and migration

- **Additive.** `asOf` and `presence` on the agent status, and `connection` on owner views, are new fields. a3 and a4 behavior does not change, and old clients ignore the new fields.
- **No events, no endpoints, no SQL migration.** Presence uses new document paths. Families that existed before A-3 start with all-`null` presence. They show `never_seen` until their connector's next claim, which is at most ~60 s away for a healthy connector.
- **Cost.** All four fields share one document per family, and each field changes at most once per 60 s, so at most four document writes per family per 60 s. The usual case is one write a minute per connected installation, which updates `lastSeenAt` and `lastWorkClaimAt` together.
- **Rollback.** Reverting A-3 removes the fields, and clients show "Status unknown". The `auth/agent-presence/` documents become inert and can be deleted with no other effect.

**Consumer changes for B-3** (Lane B; informative)
- `frontend/src/App.tsx` currently derives "online" / "Enrolled" from enrollment and approval, and reads a `pausedAt` field the server never sends. Replace that with `connection.state`, the agent's `paused` field and the §5 wording.
- Add `connection?` (optional) and `resumedAt?` to the agent type in `frontend/src/types.ts`.
- The onboarding step "Observe runtime activity" (`frontend/src/model.ts`) may use `connection.presence.lastProcessedAt`.
- Connector doctor may print `presence` from `GET /api/agent/status`.

## a5-presence-on-demand v1

**Contract:** `a5-presence-on-demand`, version 1 (task **RA-0**, part 1). **Status:** approved by the human on 2026-10-21 (`CONTRACT-APPROVED a5-presence-on-demand v1 @cf3e39d`, board #34 comment 6324921026) after Lane B's `CONTRACT-ACK` (comment 6324646426, consuming review in PR #175). Published as `CONTRACT-PUBLISHED a5-presence-on-demand v1 @cf3e39d` (comment 6324488564). Frozen: changes need a new version. The approved fixtures and schemas are unchanged by this status update. Approval does not turn on any flag; implementation state is recorded in the board's `INTEGRATED` comments, not here. The sentences below that say nothing is implemented describe the state at publication.

**What it is.** An amendment of a5-presence v1 for installations that declare `deliveryMode: "on_demand"`. It is prerequisite 1 of agent-remote-auth v1 §1: "an a5-presence revision gives `on_demand` an honest owner label and connection state, so an installation that is not running is not shown as failing (v3 §45)". a5-presence v1 is frozen and stays approved and unchanged. For every installation that does not declare `on_demand`, a5-presence v1 alone still decides the owner connection. Once both are approved, the owner connection is a5-presence v1 plus this amendment.

**Why a separate contract.** a5-presence v1 says "changes need a new version", and Lane B's tests pin its fixture set. A separate amendment leaves every v1 fixture, test and consumer untouched, and the new rows can be reviewed on their own.

**Fixtures:** [`test/contract-fixtures/a5-presence-on-demand/`](../../../test/contract-fixtures/a5-presence-on-demand/). `schemas.json` holds a5-presence v1's definitions with one state added, plus the tables `x-connection-states` (the whole ordered table, v1's rows included), `x-seen-at-basis`, `x-presence-updates` and `x-presence-never` (both list only the rows this amendment adds), and `x-agent-labels` (v1's, unchanged).

**Owner:** Lane A. **Consumer:** Lane B (the owner agent list and the claim page; RA-B2). **Implemented by:** RA-A3 (server projection) with RA-B2 (owner UI).

### 1. Scope

- **Which agents.** An agent whose **reported family** (a5-presence v1 §4.2: the newest non-revoked family, else the newest family) belongs to an installation that declares `deliveryMode: "on_demand"` (agent-registration §6.4). Only agent-remote-auth v1 activations create such installations (its §1).
- **Which family decides.** Only the reported family. When an existing-agent reconnect replaces an on-demand installation with a local-helper one, v1's rows apply again from the new family. When it replaces a local-helper installation with an on-demand one, this amendment applies, and the old family's presence is no longer reported. A family with no installation document is a legacy `envoi_link` installation (agent-registration §9).
- **What it does not change.**
  - The shape of every response: `connection` keeps a5-presence v1's fields, and only `state` gains a value. `recentWindowSeconds` stays 300 in every response, but no on-demand row uses it.
  - Presence storage, the throttle, the write rules and the agent's `GET /api/agent/status` (a5-presence v1 §1–§4.1).
  - The agent labels (a5-presence v1 §5), pause, resume and every a3 code.
  - Availability. This amendment makes no delivery mode, route or wake path available. `on_demand` stays available only as agent-remote-auth v1 §1 says. `poll`, `webhook`, `provider` and `a2a` gain no label and stay as before. An http-wake subscription would never change the state. Today an OAuth installation cannot create one at all: its tokens are refused at `/api/agent/wake-subscriptions` (agent-remote-auth §9), and no `/mcp` tool creates one. That gap belongs to agent-remote-auth and is reported separately; this amendment adds no wake path.
  - The local helper's states (agent-registration §7). The helper's routes refuse `on_demand` (agent-registration §6.1 row 8), so no helper state is added.

### 2. Connection state

The first matching row wins. The whole table, with labels, is `x-connection-states`.

| # | Condition | `state` |
| --- | --- | --- |
| 1 | `status` is `revoked`, or `credentialRevoked` is `true` | `revoked` |
| 2 | `onboardingStatus` is `rejected` | `rejected` |
| 3 | `onboardingStatus` is any other value except `approved` | `pending_approval` |
| 4 | No credential family | `not_connected` |
| 5 | `credentialExpiresAt` ≤ `asOf` | `needs_reconnect` |
| **6** | **The reported family's installation declares `on_demand`** | **`on_demand`** |
| 7 | `seenAt` is `null` | `never_seen` |
| 8 | `asOf − seenAt` ≤ `recentWindowSeconds` | `seen_recently` |
| 9 | Otherwise | `not_seen_recently` |

Rows 1–5 and 7–9 are a5-presence v1's rows 1–8, unchanged.

**`seenAt` for an on-demand installation** is `presence.lastSeenAt`, whether or not the agent is paused, with no resume grace (`x-seen-at-basis`). An on-demand host has no work loop: it calls `/mcp` only while its user has it open, so `lastWorkClaimAt` says nothing about it. `seenAt` is `null` until the family makes its first authenticated request. Activation (the token exchange) writes no presence, as a5-presence v1 §3 already says for enrollment redemption. Rows 1–5 still report this `seenAt`.

**Precedence, case by case**

| Case | Result | Why |
| --- | --- | --- |
| The family was revoked: by the client (`POST /oauth/revoke`), by the owner, or for a replay | `revoked` (row 1), "Access revoked" | v1 row 1. The identity is not frozen, so the owner UI offers "Reconnect an existing agent" (agent-registration revision 4). |
| The rolling refresh lifetime passed | `needs_reconnect` (row 5) | The user must authorize again; that is a real problem and not "idle". It is v1 row 5 for every mode. |
| Paused | `on_demand`, agent label "Paused" | Pause belongs to the agent label (a5-presence v1 §4.2, "Pause is separate"). The assistant's tool calls get `409 AGENT_PAUSED`, and refresh still succeeds (agent-remote-auth §6.2). Both still update `lastSeenAt`. |
| Paused and expired | `needs_reconnect`, agent label "Paused" | Row 5 comes first. |
| No request since activation | `on_demand`, detail "No requests yet" | Never `never_seen` ("Not checked in yet"), which would suggest that a running process has not started. |
| Idle, for however long short of credential expiry (row 5) | `on_demand`, detail "Last request {relative}" | Never `not_seen_recently`. Age alone never makes an on-demand installation look stopped or broken. Only the rolling refresh lifetime ending does, and then the state is `needs_reconnect`. |
| Recently used | `on_demand`, detail "Last request {relative}" | Never `seen_recently`. A recent request is not evidence that the assistant is reachable now. |
| Route flags off (agent-remote-auth §11 rollback) | `on_demand`, unchanged | The state is derived from the declared mode, not from flags. The installation stays active and revocable while its tokens get `401` at `/mcp`. |

**Reading the installation.** The server already reads the reported family to build `connection`. For on-demand detection it also reads that family's installation document. If that read fails, or the family names an installation whose document is absent, the server omits `connection` and the response still succeeds, exactly like a failed presence read (a5-presence v1 §4.2). It never falls back to v1's rows for a family that names an installation it could not read.

**Owner wording (RA-B2).**

| `state` | Connection label | Detail | Must never claim |
| --- | --- | --- | --- |
| `on_demand` | "On demand" | `seenAt` is `null`: "No requests yet". Otherwise "Last request {relative time of `seenAt` from `asOf`}". | That the assistant is running, online, connected or reachable now; that it will receive, process or answer work while its user does not have it open; that it is offline, stopped, broken or failing, or needs attention, because it made no recent request. |

- **Show all three:** the agent label, the connection label and the detail, for example "Active · On demand · Last request 9 days ago" or "Paused · On demand · No requests yet".
- **Neutral presentation** (`presentation: "neutral"`). An on-demand state is styled neither as a problem (no warning or error colour, icon or "needs attention" badge) nor as online or healthy (no green dot or "connected" mark).
- **"Request", not "use".** The detail counts any request the installation's credential authenticated, including a token refresh, which a host may make without its user (§3). So the label says "Last request", never "Last used" or "Last active".
- Every other state keeps a5-presence v1 §5's wording. Unknown states still show "Status unknown".

### 3. Presence updates for these routes

a5-presence v1 §3 applies unchanged: its "authenticated" means a typed `envoi_` access or refresh credential of a family that is not revoked or expired, belonging to an approved agent that is `active` or `paused`. OAuth-family tokens are such credentials. agent-registration revision 5 (§14.2) stores them with the token types `oauth_access` and `oauth_refresh`; presence counts those exactly as it counts `access` and `refresh`. These rows make explicit how its table applies to the agent-remote-auth endpoints (`x-presence-updates`, `x-presence-never`):

| Request | Outcome | Fields |
| --- | --- | --- |
| `POST /oauth/token`, `grant_type=refresh_token` | `200`, including the identical response inside the recovery window | `lastSeenAt`, `lastSuccessfulRefreshAt` (the a5 v1 `POST /api/agent-token` row) |
| `POST /mcp` with an OAuth-family access token | any response after authentication, including `403 INSUFFICIENT_SCOPE` and `409 AGENT_PAUSED` | `lastSeenAt` (the a5 v1 "any other request" row) |
| An agent operation that a `/mcp` tool call performs: claim, renew, acknowledge, complete, fail, instruction reply | as a5 v1's row for that operation | as a5 v1's row for that operation, recorded for the family that authenticated the `/mcp` request |

**Never** (in addition to a5-presence v1's list):
- `POST /oauth/token` with `grant_type=authorization_code` or the bootstrap grant. That is activation, like enrollment redemption;
- `POST /oauth/revoke`;
- an OAuth-family token presented anywhere except `/mcp`. It gets `401 AUTHENTICATION_REQUIRED` (agent-remote-auth §9, audience), so it is a rejected credential;
- discovery, client metadata fetches and `GET /oauth/authorize`;
- the consent page and its approve, deny and withdraw requests, and issuing a bootstrap code. These are human requests.

The last row of the first table holds whatever internal dispatch `/mcp` uses (agent-remote-auth §14). An internal call records presence for the family of the outer `/mcp` request, at most as a5 v1's rows allow, and the throttle makes a double count harmless.

### 4. Compatibility and rollback

- **No change until an on-demand installation exists.** Every installation the server can create today declares `envoi_link`, or `poll` for a provider-browser-poll gateway installation, and this amendment leaves both on v1's rows. Owner responses therefore stay identical until an agent-remote-auth route is turned on and used.
- **Consumers that know only v1** show "Status unknown" for `on_demand` (a5-presence v1 §4.2). That is honest: it neither claims the assistant is reachable nor says it is broken. Turning a route flag on still waits for RA-B2's rendering (agent-remote-auth §1).
- **No new storage, endpoint, event, audit type or migration.** The projection reads the installation document that agent-registration already stores.
- **Rollback of the server change.** Reverting RA-A3's projection makes on-demand installations fall back to v1's rows: "Not checked in yet" or "Last checked in …". That is less accurate but claims nothing false about reachability. No data needs to change in either direction.
- **Version.** This is v1 of a new contract. a5-presence keeps version 1. A later consolidation into one a5-presence version is optional and would be its own publication.

### 5. Fixtures

Owner fixtures use a5-presence v1 §6's fields, plus:
- `context.reportedInstallations`: one `{ agentId, installation }` per agent in the body, in order. `installation` is the reported family's installation `{ id, connectionRoute, deliveryMode, legacy }`, or `null` for a legacy family. This is input for re-deriving the state; owner views never carry it;
- `context.flags` (optional): the two route flags, when the fixture is about them;
- `client.connectionDetail`: the §2 detail, present exactly when the state is `on_demand`.

**What `test/contract-fixtures.test.js` checks**
- Every response against its schema, with v1's checks: `seenAt`, `connection.state` and both labels are re-derived from the fixture's own fields, using §2's rows when the reported installation declares `on_demand`.
- The detail against `x-connection-states`.
- The amendment against a5-presence v1:
  - the state table is v1's with exactly one row inserted after `needs_reconnect`;
  - every other definition and the agent labels are v1's, byte for byte;
  - a5-presence stays at version 1.
- The precedence cases of §2:
  - revoked and expired win, paused or not;
  - pause stays the agent label;
  - idle time beyond the recent window stays `on_demand`;
  - no presence gives "No requests yet";
  - after the resume grace the basis is still `lastSeenAt`;
  - only the reported family decides, in both directions;
  - both routes are covered;
  - flags off does not change the state.
- No on-demand fixture uses a v1 check-in label. The added presence rows cover refresh, exchange, revocation and the audience refusal.
- The table below lists exactly the registered fixtures.

| Group | Fixtures |
| --- | --- |
| On demand | `owner-on-demand-no-requests`, `owner-on-demand-recent-request`, `owner-on-demand-idle`, `owner-on-demand-refresh-only`, `owner-on-demand-after-resume` |
| Pause | `owner-on-demand-paused`, `owner-on-demand-pause-response` |
| Precedence | `owner-on-demand-needs-reconnect`, `owner-on-demand-paused-needs-reconnect`, `owner-on-demand-revoked-by-client` |
| Reported family | `owner-on-demand-replaced-by-local-helper`, `owner-local-helper-replaced-by-on-demand` |
| Rollback | `owner-on-demand-flags-off` |

### 6. Decisions for review

1. **One state with a detail line**, instead of separate "unused", "recent" and "idle" states. A "recent" state would read as "reachable now", and an "idle" state as a problem. One neutral state with a factual detail avoids both.
2. **`lastSeenAt` as the basis, labelled "Last request".** It includes token refreshes, which a host may make without its user. Counting only `/mcp` calls would need a new presence field, which is a storage change. The label stays accurate either way.
3. **Age never changes the state.** Only credential expiry (row 5) or revocation (row 1) turns an idle on-demand installation into something the owner must act on.
4. **The state does not depend on flags.** During an agent-remote-auth rollback the installation still shows "On demand", while its tokens are refused at `/mcp`. A flag-dependent "route unavailable" state would make the projection depend on configuration. The owner UI may read `GET /api/onboarding/routes` to explain the outage.
5. **A separate amendment contract**, not a new a5-presence version (see "Why a separate contract").
6. **Approval.** Version-specific `CONTRACT-APPROVED a5-presence-on-demand v1 @<publication sha>` after Lane B's `CONTRACT-ACK`. Approval does not turn on any flag, and does not satisfy agent-remote-auth's other prerequisites: the hosted route gates, and the paired implementation, planner and redaction work.

### 7. Consumer changes for RA-B2 (Lane B; informative)

- Accept `on_demand` in the owner connection type, and render the label, the detail and the neutral style of §2.
- Keep "Status unknown" for unknown states, and v1's wording for every other state.
- The claim page's reconnect offer (agent-registration revision 4) is unchanged. A revoked on-demand agent is offered like any other.
- Installation rows keep showing route, mode and runtime as declared (agent-registration §6.5).

### 8. Implementation notes for RA-A3 (Lane A; informative)

- `ownerConnection` in `src/agent-presence.js` gains the reported family's installation `deliveryMode`. The owner projection reads `installationPath(…, family.installationId)` alongside the presence record, and reads nothing for a family without `installationId`.
- The precedence stays a single expression, with the on-demand row placed after `needs_reconnect`.
- Presence recording (`trackAgentPresence` in `src/server.js`) today returns early for every token type except `access`. It must count `oauth_access`, and the OAuth refresh grant must record `lastSuccessfulRefreshAt` as `POST /api/agent-token` does (§3).
- Server tests run every fixture here through the real owner routes, on FileStore and PostgreSQL, as `test/a5-presence.test.js` does for v1.

## envoi-browser-names v1

**Contract:** `envoi-browser-names`, version 1. **Status:** approved by the human on 2026-10-11 (`CONTRACT-APPROVED envoi-browser-names v1 @1b88e1d`, build board #34) after Lane B `CONTRACT-ACK` (consuming tests in PR #66). Frozen: changes need a new version.

**Fixtures:** [`test/contract-fixtures/envoi-browser-names/`](../../../test/contract-fixtures/envoi-browser-names/).

**Owner:** Lane A. **Consumer:** Lane B (frontend).

**Implemented by** two tasks, integrated together on **one SHA**, like N1:
- N2-server (Lane A);
- N2-client (Lane B).

This contract covers the browser names of Envoi naming phase N2 ([`docs/architecture/envoi-naming-plan.md`](../envoi-naming-plan.md)). It is a separate contract id, so `envoi-names` v1 stays approved and unchanged.

**Decision (human, 2026-10-09; unchanged): a clean cutover.**
- There are no `sinaloa_*` aliases.
- The server never accepts an old cookie or header *value*, so it cannot half-accept one.
- It only detects old cookie *names*, so it can clear them (§1.3).

**Scope.** Only the names a browser sends or receives.
- The other N2 work needs no client change and is tracked in the naming plan: monitoring events (PR #63), configuration keys and docs.
- Object-storage metadata, scanner request headers and other internal identifiers move with N3 (human decision, 2026-10-10).

### 1. Cookies

| Old | New | `Path` | `HttpOnly` | `SameSite` | `Domain` | Set by |
| --- | --- | --- | --- | --- | --- | --- |
| `sinaloa_session` | `envoi_session` | `/` | yes | `ENVOI_COOKIE_SAMESITE`, default `Lax` | `WORKOS_COOKIE_DOMAIN` when set | Successful WorkOS callback; local phone verify |
| `sinaloa_csrf` | `envoi_csrf` | `/` | no (the browser reads it) | `Strict` | never | Same as the session; `GET /api/auth/me` when missing |
| `sinaloa_workos_flow` | `envoi_workos_flow` | `/api/auth/workos` | yes | `Lax` | never | WorkOS sign-in start (`Max-Age` = flow minutes × 60, default 600) |

`Secure` is added in production or with `ENVOI_COOKIE_SECURE=true`. Session and CSRF `Max-Age` is `ENVOI_SESSION_HOURS` × 3600 (default 86400). All of these attributes are unchanged from today.

#### 1.1 Configuration

**Overrides keep working.** `WORKOS_COOKIE_NAME` and `ENVOI_CSRF_COOKIE_NAME` (or its alias `SINALOA_CSRF_COOKIE_NAME`, until N2-config-2 removes it) still override the names.

**Old names are refused.** Startup, in every mode (`src/production-config.js` and the development startup check), refuses two things:
- an override that names a retired cookie (`sinaloa_session`, `sinaloa_csrf` or `sinaloa_workos_flow`);
- a session cookie name equal to the CSRF cookie name.
- Otherwise the new default would never apply.
- Worse, the clearing rule below would delete the live session at sign-in.

**N2-server also updates `.env.example`,** which sets both overrides to the old names today, and the tests that do the same.

**Human check.** Confirm that no staging or beta dashboard variable sets `WORKOS_COOKIE_NAME`, `ENVOI_CSRF_COOKIE_NAME` or `SINALOA_CSRF_COOKIE_NAME`. This is on the N2-config dashboard checklist.

#### 1.2 The CSRF cookie name in `GET /api/auth/config`

`GET /api/auth/config` reports `csrfCookieName: "envoi_csrf"`. That holds for the WorkOS and local providers alike. The frontend keeps reading the name from there, and its fallback becomes `envoi_csrf`.

#### 1.3 Old cookies are ignored and cleared

**Ignored.** A request that carries only old cookies is unauthenticated. For example, `GET /api/auth/me` returns `401 { "error": "Authenticated human session required" }`. A mutation that carries only old cookies, such as logout from an old tab, skips the CSRF gate because it has no `envoi_session`.

**Cleared.** These responses also clear old cookies, with `Max-Age=0` and the old cookie's own `Path` and `Domain` from the table:

| Response | Clears |
| --- | --- |
| WorkOS sign-in start | `sinaloa_workos_flow` |
| Successful WorkOS callback; local phone verify; `POST /api/auth/logout` | all three old names |
| A callback whose flow fails (§4) | `envoi_workos_flow` and all three old names |
| `GET /api/auth/me` returning `401` | the old names the request carried; the server reads the name only, never the value |

**The session cookie's `Domain`.** A `Domain` cookie and a host-only cookie with the same name are separate, so one clear cannot remove both. `sinaloa_session` is therefore cleared in its host-only form, plus its `Domain` form when `WORKOS_COOKIE_DOMAIN` is set. The fixtures show the host-only case.

**What stays the same.** Callback error, re-authenticate and `fresh` branches other than §4's are unchanged. Header order is not part of the contract: compare `set-cookie` values as a set.

**When the clearing code goes.** It keeps the three old names in the source until the cookies can no longer exist:
- at least 24 h (the cookie `Max-Age`) after the cutover reaches beta;
- plus the rollback window.

N3 removes it. Until then it is the only allowed `sinaloa` text in the session code.

#### 1.4 Hosted sessions

The cutover does not revoke a WorkOS session behind an old cookie. It stays live at WorkOS until WorkOS's own lifetime ends (beta policy: 7-day maximum, 1-day inactivity).

Signing in again may be silent and create a second WorkOS session. To end the old sessions at once, the people signed in to staging (Rachel has an active staging session) sign out before the cutover deploy.

### 2. CSRF header

- **The header.** Mutating browser requests send **`x-envoi-csrf`**, equal to the `envoi_csrf` cookie. The server checks only that header; `x-sinaloa-csrf` is ignored.
- **When the check runs.** It runs on every non-`GET`/`HEAD`/`OPTIONS` request that carries `envoi_session`, except the existing exemptions: the email webhook, local object upload, and phone start and verify. `POST /api/auth/logout` is **not** exempt.
- **Origin.** As today, the `Origin` header must also equal the `ENVOI_PUBLIC_URL` origin. Outside production with no public URL, it must equal `http://{host}`.
- **Failure.** Any failure, including sending only the old header, gets today's response: `403 { "error": "CSRF validation failed" }`. That shape stays outside the a3 envelope (a3 §1).
- **CORS.** `access-control-allow-headers` lists `x-envoi-csrf` instead of `x-sinaloa-csrf`. Every other entry is unchanged; `x-amz-meta-sinaloa-sha256` moves in N3.
- **Already Envoi.** Header names that already say Envoi do not change, for example `x-envoi-expected-human`.

### 3. Name-only versions of a3 and a4

These ride on the cutover SHA, like `a3-pause-auth` v2 in N1. Their regenerated fixtures land in the N2-server PR, together with the Lane B review updates in N2-client, because Lane B's review tests pin exact versions.
- `sdk/typescript/test/a3-pause-auth.review.ts` accepts only versions 1–2.
- `sdk/typescript/reviews/a4-wake.review.ts` requires version 1.

Codes, statuses, lifecycle, events and behaviour are identical to the previous versions.

**`a3-pause-auth` v3.** The three human-session fixtures (`account-changed`, `cancel-held-message`, `reconnect-token-while-paused`) change:
- They send `cookie: envoi_session=…; envoi_csrf=…`, `x-envoi-csrf` and an `origin`.
- The v2 fixtures had no CSRF cookie and no origin, so the real server would have answered `403` before the case each one describes. v3 adds both, so the requests now pass the CSRF gate.

**`a4-wake` v2.** 21 fixtures change their placeholders:
- `sinaloa_agent_access_` → `envoi_agent_access_` in the `claim-*`, `delta-*` and `stream-*` fixtures;
- `sinaloa_mcp_read_` → `envoi_mcp_read_` in `stream-mcp-read-rejected`.

The five `event-*` fixtures are already clean.

**Token-leak guards.** The guards in both `schemas.json` files (`errorEnvelope.message` `not.pattern`) match **both** the `envoi_` and `sinaloa_` prefixes.
- a4's guard matches only `sinaloa_` today, so it would miss a real `envoi_` token.
- A deny pattern is not an alias: it keeps refusing to leak a retired credential format.

**`a5-presence`.** Unaffected: its fixtures name no cookie (`request.auth: "human_session"`).

### 4. Cutover hazards

**A sign-in in progress at deploy time.** The browser returns to the callback holding only `sinaloa_workos_flow`.
- **Current behavior:** the callback returns a raw `401` JSON page.
- **After N2-server:** when the flow binding is missing or does not match, or the flow is expired, missing or already used, the callback redirects to `/?auth_error=sign_in_failed`. It clears `envoi_workos_flow` and the old names, like the existing error branch. The user starts sign-in again.

**Tabs still running the old frontend.** Such a tab keeps sending `x-sinaloa-csrf`, so every change it makes gets `403 CSRF validation failed` until it reloads. `index.html` is served `no-store`, so a reload loads the new frontend. Lane B offers "Reload" on that error.

**Event streams.** A human `EventSource` that reconnects after the deploy gets `401`, because its old cookie is ignored. Lane B sends the user to sign-in, as on any `401`.

**Rollback** to the pre-cutover SHA:
- **People who already signed in again.** Their old cookies were cleared and the old code ignores `envoi_*`, so they sign in once more.
- **People who opened the app after the cutover.** Their old cookies were cleared by the `GET /api/auth/me` `401`, so they sign in once more too.
- **Browsers that never visited after the cutover.** Their `sinaloa_session` (up to 24 h `Max-Age`) works again.
- **Shared fixtures.** The registry entry, the a3 v3 and a4 v2 fixtures and Lane B's version pins all revert with the SHA.

### 5. Client changes (Lane B; informative)

**Browser code**
- `frontend/src/api.ts`: send `x-envoi-csrf`, and make the fallback cookie name `envoi_csrf`.
- `frontend/test/api.test.ts`: update the expectations.
- Offer "Reload" on `403 CSRF validation failed`.
- Send the user to sign-in when the stream gets a `401`.

**Build.** Rebuild `web/**`, including `web/index.html`, through `npm run build`.

**Review tests**
- `sdk/typescript/test/a3-pause-auth.review.ts` → v3.
- `sdk/typescript/reviews/a4-wake.review.ts` → v2.
- A consuming test for this contract.

**Server-side checklist (Lane A; informative):**
- `src/workos-auth.js`;
- `src/human-auth.js`, which has a second CSRF default;
- `src/server.js`: CORS and the clears;
- `.env.example`;
- `docs/envoi-backend-rename-inventory.md`;
- `test/browser-session.js`, the shared helper;
- `test/session-lifecycle-integration.test.js`, `test/session-response.test.js`, `test/workos-auth.test.js`, `test/workos-session.test.js`, `test/human-instructions-integration.test.js` and `test/inbox-preferences-integration.test.js`.

**Not adopted:** a `__Host-` cookie prefix. It cannot be combined with `WORKOS_COOKIE_DOMAIN`.

### 6. Fixtures

**Fixture fields.** The file fields are the a3 §6 ones, plus a top-level `cookies` field: `{ set: [names], cleared: [names] }`, which lists exactly the cookies the response sets and clears.

**`client` block**
- `lifecycle: "NOT_APPLICABLE"`.
- `retry`.
- `next`.
- `guidance`, one of:
  - `none`;
  - `sign_in_again`: show sign-in and let the user start it again;
  - `reload_browser` (as in a3).

| Fixture | Case |
| --- | --- |
| `auth-config-csrf-cookie` | `GET /api/auth/config` reports `envoi_csrf`. |
| `sign-in-start-sets-flow-cookie` | Sign-in start sets `envoi_workos_flow` and clears `sinaloa_workos_flow`. |
| `sign-in-sets-cookies` | The callback sets `envoi_session` and `envoi_csrf`, and clears `envoi_workos_flow` and the three old names. |
| `callback-old-flow-cookie` | A sign-in in progress at the deploy redirects to `/?auth_error=sign_in_failed` (§4). |
| `phone-verify-sets-cookies` | Local phone verify (development, so no `Secure`) sets both cookies and clears the old names. |
| `logout-clears-cookies` | Logout with the new cookies, the new header and a matching `Origin`. This is also the positive CSRF case. |
| `logout-old-cookies-only` | Logout from a browser holding only old cookies. The gate is skipped, the response is `{ revoked: false, logoutUrl: null }`, and the old names are cleared. |
| `me-old-cookies-only` | `GET /api/auth/me` with only old cookies returns `401` and clears them. |
| `csrf-old-header-rejected` | The same as a valid mutation, except it sends only `x-sinaloa-csrf`. It gets `403`. |

**`schemas.json`** carries the cookie table as `x-browser-cookies` and the header mapping as `x-browser-headers`.

**What `test/contract-fixtures.test.js` checks**
- The `set-cookie` values, as a set, match `cookies.set` and `cookies.cleared`.
- Every cookie name is in the table.
- Old names only ever appear as clears.
- The successful callback, phone verify and both logout fixtures clear all three old names.
- Every cookie that is set has a `Max-Age`.
- Every mutation that carries `envoi_session` sends `x-envoi-csrf`, unless it is marked `oldNamesInRequest` (`x-browser-headers`).
- Every cookie's `Path`, `HttpOnly` and `SameSite` match the table.
- A redirect's `location` and `cache-control: no-store`.
- No request carries a `sinaloa` cookie or header, except the fixtures marked `oldNamesInRequest`. N2-server extends this check to every contract when a3 v3 and a4 v2 land.
- `plainError` is used only for browser requests (requests that carry a cookie).

## agent-registration v1

**Contract:** `agent-registration`, version 1 (build-plan task **A-3.1a**). **Status:** approved, fifth revision (§14). **Revision 5** (§14, stored records for the agent-remote-auth routes) was acknowledged by Lane B and approved by the human as `CONTRACT-APPROVED agent-registration v1 revision 5 @b9aa369` (board #34 comments 6346370584 and 6346396365); revision 4 (§13) remains the history it builds on. For revision 4, Lane B posted [`CONTRACT-ACK` @532789b](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6275137188) and the human posted [`CONTRACT-APPROVED` rev 4](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6275502353) on 2026-10-19. Earlier history: the human's first `CONTRACT-APPROVED` preceded Lane B's review, which found a `MISMATCH`. By the human's decision the corrected contract stayed v1. Lane B posted [`CONTRACT-ACK` @4da219e](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6134589212) and the human posted a [fresh `CONTRACT-APPROVED`](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6134778271) on 2026-10-12, before #76 was integrated. Revision 4 (§13) clarifies which agents the owner UI offers for reconnect. It does not change the wire contract, server behaviour or a5-presence v1. Server code is A-4.x; nothing here is default-on.

**Fixtures:** [`test/contract-fixtures/agent-registration/`](../../../test/contract-fixtures/agent-registration/). It holds:
- `schemas.json`: draft-07 schemas plus the machine-readable tables `x-codes`, `x-limits`, `x-model-visible`, `x-permission-labels`, `x-route-availability`, `x-delivery-availability`, `x-operations`, `x-legacy-projection`, `x-installation-derivation` and `x-stored-records` (revision 5);
- one JSON file per case, including migration, rollback and re-enable fixtures (§9) and stored-record fixtures (§14).

**Owner:** Lane A. **Consumer:** Lane B. That covers `envoi-link connect`, the `/connect` skill and manifest, the claim UI, and the host planner in PR #72. **Implemented by:** A-4.x. It needed this contract's approval (given above) **and** needs the hosted Phase A gate (two-owner plan A5).

**What it covers.** This is the route-neutral Phase B core from v3 §30–§45, as amended by PR #75:
- one registration, human claim, activation and installation state machine;
- the same agent operations for every connection route.

It builds on `a3-pause-auth` v3 (envelope, codes, pause, reconnect), `a4-wake` v2 (work availability) and `a5-presence` v1 (presence, owner connection states).

**Not in v1.** Everything below is **A-3.1b** (`agent-remote-auth`), which is published separately:
- the remote MCP/OAuth route;
- the provider-connector route, including OAuth metadata, consent-as-claim and the secure-field bootstrap code;
- the delivery modes `webhook`, `provider` and `a2a`.

`poll` and `on_demand` also stay off until an `a5-presence` revision gives them an honest owner label (§1). Each of these is `available: false` in v1, and registration or activation refuses it.

### 1. Flags and route availability

| Flag (server-only, default off) | Turns on |
| --- | --- |
| `ENVOI_INSTALLATIONS_V2` | The installation model: the legacy projection (§9), `installation` on agent status (§6.4) and the owner installation routes (§6.5). |
| `ENVOI_AGENT_REGISTRATION_V2` | Registration (§3), polling (§4), the claim routes (§5) and activation (§6). It requires `ENVOI_INSTALLATIONS_V2`; startup fails closed if this flag is on and that one is off. |
| `ENVOI_AUTHENTICATED_REST_ROUTE` | Offers the `authenticated_rest` route, in addition to the two above. **New** relative to v3 §65, because the breadth gate (v3 §47) proves REST separately. |

**About `ENVOI_AUTHENTICATED_REST_ROUTE`.** `connectionRoute` is declared by the client, and in v1 both routes use the same bootstrap and bearer mechanics. So this flag controls what Envoi **offers and supports**:
- what the routes endpoint, `/connect` and `skill.json` advertise;
- whether a registration declaring `authenticated_rest` is accepted.

It cannot stop a REST client that declares `local_helper`.

**Route availability.** Lane A owns the flags; clients never read them. Clients read `GET /api/onboarding/routes`, which needs no auth and is served with `cache-control: public, max-age=60`. It returns `routeAvailability`:
- `registrationEnabled` and `installationsEnabled`;
- all four `connectionRoute`s and all six `deliveryMode`s, each exactly once, in schema order, with `available`.

The rules are in `x-route-availability` and `x-delivery-availability`:

| Route or mode | Available when |
| --- | --- |
| `local_helper` | both V2 flags are on |
| `authenticated_rest` | both V2 flags and `ENVOI_AUTHENTICATED_REST_ROUTE` are on |
| `remote_mcp_oauth`, `provider_connector` | never in v1 (A-3.1b) |
| delivery mode `envoi_link` | both V2 flags are on |
| any other delivery mode | never in v1 |

`envoi_link` means SSE plus the a4-wake safety poll, run by a trusted host process. A REST client that implements a4 the same way also declares it.

**Outcomes.** `/connect`, `skill.json` and the helper offer only what this endpoint marks available. A route whose flag is off returns `404 FEATURE_DISABLED`, and the fixture test ties that code to the fixture's flags. The human turns a flag on only after the route's hosted gate passes (v3 §47).

### 2. Codes, tokens and limits

Every value here is machine-readable in `x-limits`.

| Item | Rule |
| --- | --- |
| Verification code | 8 symbols, uniformly random, from the Crockford alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ` (40 bits), shown as `XXXX-XXXX`. Typing is case-insensitive, spaces and hyphens are ignored, `I`/`L` read as `1` and `O` as `0`. Stored only as HMAC-SHA256 under a key derived from `ENVOI_DATA_ENCRYPTION_KEY`, never in clear and never logged. A new code that collides with a live one is drawn again. |
| Bootstrap token | `envoi_reg_` + 32 random bytes, base64url. Stored as SHA-256 and bound to one registration. See below. |
| Claim window | 600 s from creation (`expiresAt`). |
| Activation window | 600 s from approval (`activationExpiresAt`). |
| Activation recovery | 300 s from activation (§6.2). When the window ends, the token record becomes a **tombstone**, kept until cleanup. Any activation or poll with that token then gets `401 ACTIVATION_RECOVERY_EXPIRED`, which revokes nothing and tells the helper that an agent already exists. The window ends by time (`activatedAt` + 300 s), whether or not a job has run. |
| Polling | `pollAfterSeconds` is 5. A poll less than 4 s after the previous one gets `429 RATE_LIMITED` with reason `poll_interval`. This check may live in memory; it is not a safety boundary. |
| Registration creation | At most 10 per source per hour, 30 per network per hour, 100 per wide network per hour, at most 1,000 pending globally, and a body of at most 4,096 bytes. All are keyed by `clientIp` (with today's trusted-proxy rule): **source** is the IPv4 address or the IPv6 /64, **network** the IPv4 /24 or the IPv6 /48, **wide network** the IPv6 /32. The network limits stop one cheaply obtained IPv6 /48 (65,536 /64s) from filling the global cap. The key is never the bearer- or cookie-keyed `rateIdentity`, which an unauthenticated caller could vary. **Durable:** the counters live in the document store, so a container restart does not reset them. Over any limit → `429 RATE_LIMITED`, reason `registration_limit`. |
| Claim failures | At most 5 per human per 15 minutes, durable. A lookup, approve or reject whose code does not match counts as one failure; 5xx responses never count. When the limit is hit → `429 RATE_LIMITED`, reason `claim_attempts`, and the correct code is refused too until `retry-after`. |
| Approvals waiting | At most 3 approved-but-unactivated registrations per human (`PENDING_ACTIVATION_LIMIT`). |
| Cleanup | Each registration record is kept **at least** 24 h after creation and deleted **by** 25 h, whatever its state, together with its token index or tombstone, its code index, its address hold (only if the hold still names this registration, since a later registration may have replaced it, §9) and its recovery envelope. Nothing is deleted earlier, so the tombstone, decision replays (§5.3, §5.4) and the owner's 24-hour list hold for their whole window. Lookup only ever finds **pending** registrations. |
| Abuse monitoring | Creating a registration and hitting any limit emit structured log events: `agent_registration.created` and `agent_registration.limited`. They carry the hashed source, the route and the reason, never the body or a token (v3 §37). |

**Where a bootstrap token works.** It authenticates only the registration status route (§4) and activation (§6.1). On any other **authenticated** route it is an unrecognized bearer and gets `401 AUTHENTICATION_REQUIRED`, identical to an unknown token. That covers `/mcp` (an HTTP 401, not a JSON-RPC result), claim, send and status. Public routes ignore it. `POST /api/agent-token` reads only its own body (a3 §2.2). There are fixtures for pending, rejected and expired tokens.

**Never register twice by accident.** A helper may send an activation and never learn its outcome. Such an activation is **unresolved**, and the agent may or may not exist. The rules:
- Retry backoff gives up before the recovery window ends. Before abandoning an unresolved activation, the helper polls status (§4) once. `activated` or `ACTIVATION_RECOVERY_EXPIRED` means the agent exists (owner reconnect). `pending_claim`, `approved`, `rejected`, `expired` or `withdrawn` resolve it the usual way.
- The helper deletes the `activationId` once its activation is resolved: credentials saved, or any definitive `4xx` from §6.1.
- If the token was already deleted by cleanup, the helper gets `REGISTRATION_TOKEN_INVALID` while still unresolved. It then uses the row's `guidanceByHelperState.activation_unresolved`, which is `check_owner_agents`: "ask the owner whether the agent appears in Envoi; reconnect it if it does, register again if it does not". It never registers again on its own, and never sends the owner to reconnect an agent that may not exist (fixture `activation-token-invalid-unresolved`).

**Change from the two-owner plan.** The plan's starting rule was "five wrong claims before invalidation". Here the human **types** the code (§5.1), so a wrong code never identifies a registration and there is nothing to invalidate. The cap applies per human instead. Five tries per 15 minutes against a 40-bit space, by allowlisted, signed-in humans only, makes guessing a live code negligible. The plan's "bounded per pending owner/workspace" is met per human (three approvals waiting, §5.3), plus the source, network and global creation limits. A registration has no owner or workspace until it is claimed, so it cannot be bounded per workspace (§10).

### 3. Registration

`POST /api/agent-registrations` takes no auth. The body is `registrationCreateRequest`, a closed object: unknown fields → `400 REGISTRATION_INVALID`.

| Field | Rule |
| --- | --- |
| `requestedName` | 1–80 characters. Control, zero-width and bidirectional formatting characters are refused, including U+061C and U+180E. |
| `requestedLocalPart` | Optional. Today's local-part rules: 3–32 characters matching `^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$`, and not reserved. Nothing is held at this step. |
| `requestedPermissions` | 1–5 of `send_agent_messages`, `receive_agent_messages`, `create_assets`, `execute_cases`, `use_email_transport`. The agent asks; it never grants (v3 §40). |
| `connectionRoute` | Must be available (§1), otherwise `400 ROUTE_NOT_AVAILABLE`. |
| `runtime` | `{ type, version }`. Metadata only, never trusted. |
| `deliveryCapabilities` | The six booleans of v3 §36. These are host declarations: shown to the human as claims, never used as evidence. |
| `helper` | Optional `{ name, version }`. |

**`201` `registrationCreated`** is sent with `cache-control: no-store`:

```json
{ "registrationId": "registration_…", "status": "pending_claim", "bootstrapToken": "envoi_reg_…",
  "claim": { "url": "https://www.envoi-agents.com/claim", "verificationCode": "F7KQ-PM4D", "expiresAt": "…" },
  "expiresAt": "…", "pollAfterSeconds": 5 }
```

- `claim.url` is `${ENVOI_PUBLIC_URL}/claim`, with no query or fragment, so it **never contains the code** (§10).
- **Not idempotent.** If the response is lost, the helper registers again. The orphan expires and grants nothing.
- **A registration grants nothing,** in any state other than activated. It has no inbox, messaging, work claim, case, file, MCP or directory access (v3 §36).

**Names and addresses in responses.** The name and local-part rules above apply to **new** names. Responses also carry existing agents and workspaces, which predate them. Today's addresses can be 48-character slugs, slug-suffix forms or bare UUIDs starting with a digit, and today's names have no length limit. So:
- response-side `address` accepts every existing address (fixtures `agent-status-legacy-address`, `owner-claims`);
- every agent or workspace name the server returns is a `displayName`, made in this order:
  1. control, zero-width and bidirectional formatting characters are removed;
  2. token-like substrings (`x-model-visible` never-list prefixes) are replaced with `[redacted]`;
  3. the result is truncated to 80 characters (79 plus `…`);
  4. a name left empty becomes the address local part.

  So the refusal rule and the length bound hold for anything a helper may show a model, and the server-derived equality rule (§7) never forces a helper to repeat an unbounded string.

### 4. Registration status

`GET /api/agent-registrations/{registrationId}` with `Authorization: Bearer envoi_reg_…` returns `registrationStatus`.

**Status is derived from time.** A pending registration past `expiresAt`, or an approved one past `activationExpiresAt`, *is* `expired`. That holds even if no cleanup job has run yet, and it holds on every route.

| `status` | Extra fields | Helper does |
| --- | --- | --- |
| `pending_claim` | `expiresAt`, `pollAfterSeconds` | Waits and polls. Shows the code again only if the human asks and it has not expired. |
| `approved` | `target`, `workspaceName`, `approverEmailHint`, `agent { name, address, id? }` (`id` exactly for `existing_agent`), `effectivePermissions`, `activationExpiresAt` | **Confirms, then activates** (lifecycle `CONFIRMING`, state `confirm_approval`). It shows who approved (`approverEmailHint`), `workspaceName`, the agent and the permissions to the human beside the host, and activates (§6) only after that human confirms. See "Local confirmation" below. |
| `activated` | `installationId` | Visible only inside the 300 s recovery window. After that, polls get `401 ACTIVATION_RECOVERY_EXPIRED`. Credentials are **never** repeated here. A helper that lost them retries activation with its `activationId` (§6.2); otherwise the owner reconnects the existing agent. |
| `rejected` | none | Stops and deletes the bootstrap token. |
| `expired` | none | Stops. Never shows the old code again. Starts one new registration only if the human asks. |
| `withdrawn` | none | Stops. A manager withdrew the approval, or an activation-time re-check found it no longer holds (§6.1). Asks the human before registering again. |

An unknown, deleted or mismatched token gets `401 REGISTRATION_TOKEN_INVALID`, the same response in every case.

**Local confirmation.** A code shown in a shared chat can be typed by any allowlisted human, who could then approve the agent into their own workspace (§10). So the helper never activates on its own.
- After polling `approved`, it shows `approverEmailHint`, the approving `workspaceName`, the agent's name and address, and `permissionSummary`, then waits for the human beside the host to confirm them.
- **`approverEmailHint` is the check that matters.** The approver chooses `workspaceName`, so a name like "Acme, your workspace" proves nothing. The hint is derived from the approving human's verified sign-in email: the first character of the local part, `***`, then the full domain, e.g. `o***@example.com`. The approver cannot choose it, and the real owner recognizes their own account.
- **Where the confirmation comes from.** A helper that has a host-native interactive prompt (a terminal prompt or a dialog on the host) must use it. That is the only path the helper itself can attribute to the human. When the helper runs only as a tool the model calls, the confirmation reaches it through the model and is **advisory**. `/connect` and `nextAction` then tell the model to show the approver and workspace to the human and wait for the human's explicit answer. §10 lists this as residual risk.
- If the human declines, or does not answer before `activationExpiresAt`, the helper deletes the bootstrap token and does not activate. The approval then expires, which releases its hold and slot. The owner sees it as `expired` in `GET /api/agent-claims`.
- The confirmation is a host-side step, so the wire is unchanged apart from the lifecycle and state values. The activation window (600 s) covers it.

### 5. Human claim

#### 5.1 Who can claim

Every claim route checks the following, in this order:

1. **A human session.** Mutations also need CSRF, as envoi-browser-names v1 requires. A CSRF failure keeps today's plain `403 { error }` browser response; it is not an `x-codes` entry.
2. **The beta allowlist,** re-evaluated now rather than taken from an earlier login. A human who is no longer admitted → `401 AUTHENTICATION_REQUIRED`.
3. **The current assurance rule.** Local auth requires `mfa`. WorkOS sessions keep their provider assurance.

**Managing the target** is a separate check, at approve time. It uses the live provider-membership check (`maxAgeMs: 0`):
- `new_agent`: the human must be able to manage `workspaceInboxId`;
- `existing_agent`: the human must be able to manage that agent's **dedicated inbox**, the same rule today's reconnect-token route uses.

An unknown, foreign or removed id gets the **identical** `403 CLAIM_FORBIDDEN`. Holding a code never reveals whether a workspace or agent exists.

The human types the code their agent shows at `/claim`. Typing it is the comparison v3 §38 asks for. §10 covers what typing does and does not protect against.

#### 5.2 Lookup

`POST /api/agent-claims/lookup` with `{ verificationCode }` returns `claimLookup`:
- the normalized code;
- `requestedName` and `requestedLocalPart`;
- `requestedPermissions`, and `grantablePermissions` (requested ∩ organization maximum);
- `connectionRoute`, `runtime` and `deliveryCapabilities`;
- `createdAt`, so the UI can show "registered N minutes ago", and `expiresAt`.

The UI presents the agent's fields as **claims the agent makes**, not facts.

A code that is malformed, unknown, expired, decided, or another registration's gets `404 CLAIM_CODE_INVALID`. The response is identical in every case and counts as one failure.

**Malformed codes.** `typedCode` (at most 32 characters) describes what a well-behaved client sends. On every claim route the server answers any `verificationCode` it cannot normalize to 8 symbols (§2) with `404 CLAIM_CODE_INVALID`, never `CLAIM_INVALID`. That includes a missing or non-string code and an over-long one. The code is checked before the body (§5.3 precedence).

#### 5.3 Approve

`POST /api/agent-registrations/{registrationId}/approve`. The body is `claimApproveRequest`:

```json
{ "verificationCode": "F7KQ-PM4D",
  "target": { "kind": "new_agent", "workspaceInboxId": "inbox_…", "name": "…", "localPart": "…" },
  "grantedPermissions": ["send_agent_messages", "receive_agent_messages"], "policyProfile": "default" }
```

For an existing agent, `target` is `{ "kind": "existing_agent", "agentId": "agent_…", "replacesInstallationId": "installation_…" | null }`.

The code is required again, which binds the decision to what the owner saw. The `{registrationId}` comes from the lookup.

**Permissions, for both targets**
- `grantedPermissions` is required. The UI pre-fills it with the requested permissions, or for an existing agent with its current ones.
- The server computes `effectivePermissions` = requested ∩ granted ∩ organization maximum, plus `receive_agent_messages`. Every agent can receive, as today's enrollment already ensures, so the schemas require it in every `effectivePermissions` (§10).
- In v1 the organization maximum is the full list, since there are no per-organization ceilings yet.
- Anything granted but not requested is dropped silently. The response states the result.
- **Re-attaching an agent re-decides its permissions,** as today's re-enroll does. This matters most after a revocation or replay: old permissions are never restored without a fresh decision.

**Agent slots.** These follow today's `assertActiveAgentSlot`:
- a human has `x-limits.activeAgentsPerHuman` (2) slots;
- the slot belongs to the agent's **principal human**;
- an `active` or `paused` agent uses a slot while it has a **live** family (neither revoked nor past `refreshExpiresAt`), **or no family at all**;
- a live approval that will need a slot when it activates counts too: every `new_agent` approval, and an `existing_agent` approval of an agent whose families are all dead (an agent with no family already counts itself).

For an `existing_agent` approval the count excludes the agent being attached (today's `excludingAgentId`). The activation-time re-check (§6.1) also excludes the approval being activated. So nothing is counted twice.

**`new_agent`**
- **Nothing is created at approval.** The server:
  - holds the address for this registration (§9, "Address holds");
  - counts one slot against the approver, who becomes the agent's principal human;
  - counts one waiting approval (`PENDING_ACTIVATION_LIMIT`);
  - records the decision.
- The agent, its dedicated inbox and its directory entries are created **at activation** (§6.3).
- If activation never happens (expiry or withdrawal), the hold and the slot are released and no agent ever existed.
- An address held by a live approval counts as taken (`409 ADDRESS_TAKEN`).

**`existing_agent`**
- The agent must be approved and `active` or `paused`. It may have every credential family revoked or expired.
- A pending or rejected agent, or one frozen by the agent-wide revoke (status `revoked`), gets `409 AGENT_NOT_RECONNECTABLE`. A frozen agent is still re-enrolled through Quick Connect in v1.
- **Owner-UI eligibility (revision 4).** The rules above apply to the **stored** agent record. The owner UI never sees that record. It sees the owner view (a5-presence v1): `GET /api/inboxes/{inboxId}/agents`, and the `agents` of `GET /api/inboxes/{inboxId}/human-view`, which the claim page reads. Both are the same `ownerAgentState`. The owner UI offers an agent under "Reconnect an existing agent" when:
  - `onboardingStatus === "approved"`, **and**
  - `status` is `"active"` or `"paused"`, **or** `credentialRevoked === true`.

  The owner view reports `status: "revoked"`, `credentialRevoked: true` and `permissions: []` for an agent whose families are all revoked (a5-presence v1, fixture `owner-revoked-refresh-replay`). Such an agent is **not frozen**: it is still reconnectable, and the owner UI must offer it. This happens after a per-installation revoke of its only installation (§6.5), a `REFRESH_REPLAY` or an `ACTIVATION_REPLAY`.

  How to tell the cases apart: every freeze writes `onboardingStatus: "revoked"` together with `status: "revoked"`. That covers the agent-wide `credentials/revoke`, agent removal and the one-time legacy reconciliation. A frozen agent therefore always has `onboardingStatus: "revoked"` in the owner view, and stays ineligible (`AGENT_NOT_RECONNECTABLE`; re-enrolled through Quick Connect). Families that end without a freeze leave `onboardingStatus` and the stored `status` unchanged, so an approved agent stays `active` or `paused`. For every record the server writes, this predicate agrees with the server's status check of the stored record. The approval can still fail for other reasons: `CLAIM_FORBIDDEN`, `CLAIM_STALE` or `ACTIVE_AGENT_LIMIT`.

  Re-enrollment through Quick Connect also stays available for an agent with revoked credentials. That is why a5-presence v1's `owner-revoked-refresh-replay` says "Offer re-enrollment". Revision 4 adds the reconnect offer beside it and replaces nothing. Fixture: `owner-reconnect-after-installation-revoke`.
- If the agent has no live family, the approval needs a slot, checked against the agent's principal human (`ACTIVE_AGENT_LIMIT`).
- **`replacesInstallationId` must name the agent's newest active installation** (latest `activatedAt`, §6.4), or be `null` when it has none, otherwise `409 CLAIM_STALE`. This forces the UI to show the owner which installation, and which last check-in, will be disconnected. Activation replaces **every** active installation, including older legacy ones.
- Approval changes nothing yet. The current installation keeps working until the new one **activates**.

**Policy profile.** `policyProfile` is `"default"` only in v1: the workspace's active policy.

**`200` `claimApproved`** returns:
- `target` and `workspaceName`;
- `agent { name, address }`, plus `id` for `existing_agent`;
- `effectivePermissions`, `policyProfile` and `activationExpiresAt`.

**No credential ever reaches the browser.** Today's `POST …/agent-onboarding/{agentId}/approve` returns tokens; A-4.x moves both paths onto one approval module (v3 §41), and only the legacy route keeps its response shape. The server stores the following for the activation-time re-checks (§6.1):
- `approverHumanId`;
- the target;
- for `existing_agent`, the agent's `accessGeneration` and `replacesInstallationId`.

**Audit:** `agent.registration_approved`, with the target and the effective permissions.

**Precedence.** The first matching check wins:
1. session and CSRF (`401`, plain `403`), then `ACCOUNT_CHANGED`;
2. `RATE_LIMITED`, for the claim-failure lock or the ordinary limit;
3. **the code and the registration's state:**
   - The code matches a registration **this human decided**, in **any later state** (`approved`, `activated`, `withdrawn`, expired after approval, or `rejected`). A lost response is usually retried after the helper has already activated, so the replay must not depend on the state. Neither branch below counts as a failure:
     - the same decision with an identical body replays the identical original `200` (fixtures `claim-approve-replayed`, `claim-approve-replayed-after-activation`, `claim-reject-replayed`);
     - any other decision or body gets `409 CLAIM_ALREADY_DECIDED`: approve with a different body, approve after rejecting, or reject after approving (fixture `claim-reject-after-approve`). To change an approval, withdraw it (§5.4) and have the agent register again.
   - Otherwise, unless the code matches a `pending_claim` registration that has not expired, the response is `404 CLAIM_CODE_INVALID`, and it counts as a failure. That includes a registration another human decided.
4. `CLAIM_INVALID` (body validation);
5. `CLAIM_FORBIDDEN`;
6. `AGENT_NOT_RECONNECTABLE`, `CLAIM_STALE`, `ADDRESS_TAKEN`, `ACTIVE_AGENT_LIMIT` or `PENDING_ACTIVATION_LIMIT`.

The code is checked before anything that would reveal facts about workspaces or agents.

**Concurrency.** The first decision wins, through a conditional write.

#### 5.4 Reject, list and withdraw

- **Reject:** `POST /api/agent-registrations/{registrationId}/reject` with `{ verificationCode }` → `200 { registrationId, status: "rejected" }`. Allowed while pending. Retries follow the §5.3 precedence: the same human retrying a lost reject gets the identical `200`, and a reject after their own approval gets `409 CLAIM_ALREADY_DECIDED`. Neither counts as a failure. Audit `agent.registration_rejected`.
- **List:** `GET /api/agent-claims` → `ownerClaimList`, newest first by `approvedAt`, at most `x-limits.ownerClaimListMax` (20). It holds approvals of registrations **created** in the last 24 hours, so the list never outlives the records (§2). It includes every approval whose target the caller can manage now (the same live check as approve and withdraw), whether the caller or a colleague made it. `approvedByMe` tells them apart. An approval whose target the caller can no longer manage is not listed, even their own, so every listed `approved` entry can be withdrawn. So a co-manager sees a colleague's approval and can withdraw it, which is the "undo a colleague's mistake" mitigation in §10. Each entry shows its status and activation deadline; `installationId` is set exactly when it activated.
- **Withdraw:** `POST /api/agent-claims/{registrationId}/withdraw` → `200 { registrationId, status: "withdrawn" }`.
  - Allowed while `approved`, for any human who passes the same live management check on the target.
  - If the same human repeats their own withdrawal, they get the identical `200` (fixture `claim-withdraw-replayed`). The server stores `withdrawnByHumanId` for this.
  - Otherwise → `404 CLAIM_NOT_FOUND`, identical for unknown, not approved and not manageable.
  - It releases the address hold and the slot, and makes later activation fail with `REGISTRATION_ENDED` reason `withdrawn`.
  - Audit `agent.registration_withdrawn`.

### 6. Activation and installations

#### 6.1 Activate

`POST /api/agent-installations/activate` with `Authorization: Bearer envoi_reg_…`:

```json
{ "registrationId": "registration_…", "activationId": "…", "deliveryMode": "envoi_link" }
```

**`activationId`** matches `^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$`. The helper persists it privately **before** sending, like A1's `rotationId`.

**`deliveryMode`** is the host's declared wake mode. It is `envoi_link` only in v1. It is a **declaration**, never evidence of closed-app reachability (§7).

The first matching row wins:

| # | Condition | Response |
| --- | --- | --- |
| 1 | `ENVOI_AGENT_REGISTRATION_V2` off | `404 FEATURE_DISABLED` |
| 2 | `activationId` missing or malformed (checked before the token; nothing consumed) | `400 ACTIVATION_ID_REQUIRED` |
| 3 | Token unknown, deleted by cleanup, or not this registration's | `401 REGISTRATION_TOKEN_INVALID`. Revokes nothing. |
| 4 | Token is a tombstone (activated, recovery window over) | `401 ACTIVATION_RECOVERY_EXPIRED`. Revokes nothing. |
| 5 | Body otherwise invalid | `400 ACTIVATION_INVALID`. Nothing consumed; the approval stays live (fixture `activation-invalid`). |
| 6 | Status `activated`, the installation has **ended** (any `activationId`) | `401 ACTIVATION_RECOVERY_EXPIRED`. Nothing changes: an ended installation's history is never rewritten. |
| 7 | Status `activated` and the **same** `activationId` | `200` with the **identical** body as the original `201`. If the envelope cannot be decrypted → `401 ACTIVATION_RECOVERY_EXPIRED`. |
| 7a | Status `activated` and a **different** `activationId` | `401 ACTIVATION_REPLAY`. Two parties hold one bootstrap token, so the still-active installation that activation created is revoked. See below. |
| 8 | `deliveryMode` not available | `400 DELIVERY_MODE_NOT_AVAILABLE`. Nothing consumed. |
| 9 | Status `pending_claim` and not expired | `409 REGISTRATION_PENDING` |
| 10 | `rejected`, `expired` (derived from time, §4) or `withdrawn` | `409 REGISTRATION_ENDED` with that `reason` |
| 11 | `approved`, but a re-check fails | `409 REGISTRATION_ENDED` reason `withdrawn`, and the registration becomes `withdrawn` |
| 12 | `approved` and every re-check passes | `201` `activated` |

**What `ACTIVATION_REPLAY` does.** It applies only inside the recovery window, because after it the token is a tombstone (row 4). It also applies only while the installation is active (row 6). The revoked family's `revokedReason` is stored as `"revoked"`, so a3 holders get `CREDENTIAL_REVOKED` with `reason: "revoked"` and `credential.ended`. `activation_replay` is recorded only on the installation (`replayDetectedAt`) and in the audit event `agent.activation_replay_detected`. It never reaches an a3 reason.

The helper row pairs lifecycle `REVOKED` with guidance `owner_reconnect`, while a3 pairs `REVOKED` with `owner_reenroll`. That is deliberate: this revoke ends one installation but does **not** freeze the identity, so the owner can attach a new registration to the same agent (§6.5).

**Re-checks (row 11)** run inside the activation's lock, so a decision that no longer holds can never activate:
- the approver is still admitted and can still manage the target (live check);
- the registration's `connectionRoute` is still available (§1), so a route turned off after registration never gains an installation;
- for `new_agent`:
  - the address hold still belongs to this registration;
  - the address can still be reserved;
- for `existing_agent`:
  - the agent still exists, is approved, and is `active` or `paused`;
  - its `accessGeneration` is unchanged, so the agent-wide revoke or freeze has not happened since;
  - its newest active installation is still `replacesInstallationId`;
  - the slot rule (§5.3) still admits it, if it needs a slot, counting without this approval itself.

If a re-check fails, the helper is told `approval_ended`, a neutral "this approval no longer holds; ask the human", not that the owner withdrew it.

**`activated` body:**
- `installation` (§6.4);
- `agent { id, name, address, status }` and `inboxId`;
- `effectivePermissions`;
- `agentApiToken`, `agentRefreshToken`, `agentTokenExpiresAt`, `agentRefreshTokenExpiresAt` and `tokenType`.

The token fields are the same as today's enrollment response. Refresh then continues through `POST /api/agent-token` unchanged (A1, a3 §2.2).

**Retries.** A 5xx, network error or timeout is retried as the identical request, same `activationId` included, with bounded backoff (`backoff` in `x-codes`). If the first attempt committed, row 7 returns its credentials. Retrying stops before the recovery window ends, and an activation still unresolved then follows §2 ("Never register twice"). A later retry gets row 4, and the owner reconnects the existing agent; a new agent is never registered.

#### 6.2 Lost activation response

On `201`, the server stores a 300-second AES-GCM recovery envelope of the response. This mirrors A1's `rotationRecoveryKey` and `rotationRecoveryContext`:
- the key is HKDF-SHA256 with input key material the **raw** bootstrap token, salt the SHA-256 of `ENVOI_DATA_ENCRYPTION_KEY`, and info `envoi-agent-activation-recovery-v1`, 32 bytes;
- the registration id and the SHA-256 of the `activationId` are bound as AES-GCM additional data, not HKDF inputs.

A database read plus the server key therefore cannot decrypt it, and an envelope cannot be replayed into another registration or activation.

The envelope is deleted when the window ends. When the installation ends (revoke, replace or replay), deleting it is best-effort: row 6 already refuses to return credentials for an ended installation, whatever the envelope state. At the end of the window the token record becomes the row-4 tombstone. The helper saves the credentials atomically, then deletes the bootstrap token and the `activationId`.

#### 6.3 What activation does

**Creates the installation and its credential family together.**
- In v1 an installation has exactly one family.
- Presence stays keyed by that family with the a5 field names (§10).
- Activation itself writes no presence, as a5 §3 already says for enrollment redemption.

**For `new_agent`, it also creates the agent:** `status: "active"`, `onboardingStatus: "approved"`, the held address (reserved now in `identities/`), its dedicated inbox and its directory entries, exactly as enrollment does today. Both `principalHumanId` and `approvedByHumanId` are the approver.

**For `existing_agent`, it:**
1. sets the agent's permissions to `effectivePermissions`;
2. revokes **every earlier** family with `reason: "replaced"`, so every active installation is replaced;
3. releases held leases, emitting `work.available` with reason `lease_released` (a4 §4);
4. closes the old streams with `credential.ended`.

This matches a3 §4 reconnect redemption, including its release of held sends and its delivery-worker kick when the agent is active. It does **not** match today's Quick Connect re-enroll, which sets the agent back to `active`. A paused agent stays paused: the response carries `agent.status: "paused"`, and the connector enters `PAUSED`.

**Audit:** `agent.installation_activated`, for the owner.

#### 6.4 The installation object

| Field | Meaning |
| --- | --- |
| `id` | `installation_…`. Legacy families use `installation_legacy_` + the family id without its `credential_family_` prefix (§9). Only legacy installations use that prefix. |
| `agentId` | The agent identity, which outlives installations. |
| `connectionRoute` | How this host authenticates (v3 §45). |
| `deliveryMode` | The host's **declared** wake mode. |
| `runtime` | `{ type, version }` as declared; `version` may be `null`. |
| `status` | `active` or `ended` (§10). `active` means the family is **not revoked**; it is not a connection state. An expired, unrevoked family stays `active`, and a5-presence shows it as `needs_reconnect`. |
| `endedReason` | `null` while active. Otherwise `revoked`, `replaced`, `refresh_replay` or `activation_replay`. |
| `legacy` | `true` for a projected pre-Phase-B family (§9): then the id has the legacy prefix, the route is `local_helper`, the mode `envoi_link` and `runtime.version` is `null`. An activation always creates `legacy: false`. |
| `createdAt`, `activatedAt`, `endedAt` | Timestamps. `endedAt` is `null` while active. |

**Stored vs derived (`x-installation-derivation`).** The installation document stores only immutable fields: ids, route, mode, runtime, timestamps and `replayDetectedAt`. `status`, `endedReason` and `endedAt` are **derived from its credential family at read time**:
- active while the family is not revoked;
- `endedReason` is `activation_replay` if `replayDetectedAt` is set, otherwise the family's `revokedReason`, defaulting to `revoked`;
- `endedAt` is the family's `revokedAt`.

Every path that revokes a family therefore updates its installation, with no second write to drift. That includes Quick Connect reconnect, the agent-wide revoke and `REFRESH_REPLAY`, even while the flags are off.

**Agent status.** `GET /api/agent/status` gains `installation: { id, connectionRoute, deliveryMode, legacy }` exactly when `ENVOI_INSTALLATIONS_V2` is on. The field is additive (a3 §1); old connectors ignore it.

#### 6.5 Owner installation routes (`ENVOI_INSTALLATIONS_V2`)

**`GET /api/inboxes/{inboxId}/agents/{agentId}/installations`** → `ownerInstallationList`:
- **every** active installation, newest `activatedAt` first, then at most `x-limits.ownerInstallationEndedMax` (5) ended ones, newest `endedAt` first;
- the list has **no bound on active installations**, and a client must not assume one. v1 creates at most one non-legacy active installation per agent. But before the legacy approve was guarded (6e9d4bf), each approve POST created a new family without revoking earlier ones, and refresh keeps such families alive. Each of them shows as active until a reconnect replaces them all (fixture `owner-installations-legacy-several`). Ended families are never deleted, which is why only the list caps them;
- the UI shows route, mode and runtime **as declared**, while connection state and wording still come only from a5-presence §4–§5.

**`POST …/installations/{installationId}/revoke`** (human session, manager of the agent's inbox) → `200 { installation }`, now `ended`/`revoked`:
- it revokes that installation's family; holders get `CREDENTIAL_REVOKED` with `reason: "revoked"`;
- unlike the agent-wide `credentials/revoke`, it **does not freeze the identity**: a new registration can attach to it (`existing_agent`, with permissions decided again);
- **not even after a restart.** Today's startup job `reconcileLegacyAgentRevocations` freezes every active or paused agent whose families are all revoked. Unchanged, it would freeze an agent after this revoke, or after a `REFRESH_REPLAY` or `ACTIVATION_REPLAY` of its only family, on the next boot, and its claims would then get `AGENT_NOT_RECONNECTABLE`. A-4.x must narrow it to the pre-freeze data it was written for (§12), so that only the agent-wide revoke freezes. Fixture: `reconnect-after-installation-revoke`;
- once every family is revoked, a5-presence v1 reports the agent as `revoked` ("Access revoked"), as it already does today. An agent left only with expired families shows `needs_reconnect`;
- **that `revoked` is the owner view, not a freeze (revision 4).** The owner view also reports `credentialRevoked: true` and keeps `onboardingStatus: "approved"`, and the stored agent stays `active` or `paused`. The owner UI must still offer the agent under "Reconnect an existing agent" (§5.3, Owner-UI eligibility), with `replacesInstallationId: null` because no installation is active. Of the owner's actions, only the agent-wide `credentials/revoke` freezes. Every freeze writes `onboardingStatus: "revoked"`, and a frozen agent is not offered. Fixture: `owner-reconnect-after-installation-revoke`;
- an unknown id → `404 INSTALLATION_NOT_FOUND`;
- audit `agent.installation_revoked`.

#### 6.6 One set of agent operations for every route

"Route-neutral" means every route reaches the **same** operations, with the same codes (`x-operations`):

| Operation | Requests | Defined by |
| --- | --- | --- |
| Identity | `GET /api/agent/status` | a3 §3, a5 §4.1, §6.4 here |
| Work availability | event stream, delta, claim `nextAvailableAt` | a4-wake v2 |
| Claim | `POST /api/agent/work/claim` | a3 §3, a4 §4–§5 |
| Reply | instruction reply, `POST /api/inboxes/{inboxId}/messages` | existing shapes, a3 codes |
| Settlement | `POST /api/agent/work/{workId}/{renew,acknowledge,complete,fail}` | a3 §3 |
| Refresh | `POST /api/agent-token` | A1, a3 §2.2 |

v1 adds no new agent operation. A-3.1b maps the remote MCP and provider routes onto these same operations, including HTTP `409 AGENT_PAUSED` rather than a JSON-RPC result (a3 §3).

### 7. What the model may see

`x-model-visible` is the allowlist. A helper, connector or tool may put **only these keys** where a model can read them: helper stdout, tool results or chat.

**Server-derived keys.** Each must equal its source in the response; the fixture test checks this.

| Key | Source |
| --- | --- |
| `claimUrl` | `claim.url` |
| `verificationCode` | `claim.verificationCode`, only while `pending_claim` and before `expiresAt` |
| `expiresInSeconds` | derived from `claim.expiresAt` |
| `registrationStatus` | `status` |
| `workspaceName` | from an approved registration |
| `approverEmailHint` | from an approved registration (§4) |
| `agentName`, `agentAddress`, `agentStatus` | `agent` |
| `permissionSummary` | `effectivePermissions` mapped through `x-permission-labels`, in the same order |
| `connectionRoute`, `deliveryMode` | `installation` |
| `guidance` | the received code's guidance |

**Helper-derived keys.** Closed values, or helper-authored text.

| Key | Values |
| --- | --- |
| `schemaVersion` | short version string |
| `state` | `pending_approval`, `confirm_approval`, `connected`, `paused`, `needs_reconnect`, `revoked`, `degraded`, `registration_ended`, `needs_help`. It must fit the response: the fixture test maps each response to the states it allows. `confirm_approval` is the §4 local confirmation. A connected-on-demand state arrives with the a5 revision. |
| `reachability` | `not_verified_closed_app`, `verified_while_host_running`, `verified_closed_app`. Host-owned evidence (v3 §47); the server never asserts it in v1. |
| `nextAction` | at most 300 characters of helper text, quoting only server-derived values |

**Never model-visible:** the bootstrap token, the `activationId`, any access or refresh token or fragment, registration, installation, agent, inbox and credential-family ids (including their bare UUIDs), raw bodies, authorization and cookie headers, and storage paths. An existing agent's address is model-visible even when its local part is a UUID, because it is the address and not an id.

**Beyond v3's "only claim URL/code".** v3 §32 step 5 and §47 step 6 have the model see only the claim URL and code. v1 also allows the keys above: workspace, agent name and address, permissions, route and mode. None of them is a secret, and the §4 confirmation needs them in the chat (§10).

**Answers to Lane B's open questions** (PR #72, `HELPER-OUTPUT-EXAMPLES.md`):
1. **Wire states and codes:** see §4 and §8.
2. **What "connected" means:** an authenticated `GET /api/agent/status` succeeded after activation (fixture `agent-status-installation`, lifecycle `CONNECTED`). Activation responses are `ACTIVATING` until that check passes. It is never delivery evidence; `verified_closed_app` stays host-owned (v3 §47), and the owner's "On demand" label is a later a5 revision.
3. **Code expiry and retry:** codes last 10 minutes. On retry while pending, the helper reuses the stored registration and shows the code again only if the human asks. An expired code is never shown.
4. **Permission labels:** only `x-permission-labels`.
5. **Publishing `/connect`:** when `GET /api/onboarding/routes` shows an available route. The UI never reads flags.
6. **`verified_closed_app` evidence:** none in v1 (see 2).

### 8. Codes

New codes use the a3 §1 envelope. `reason` carries the values shown below.

**Rows are per client surface** (`x-codes` → `bySurface`):
- **`helper`:** the registration helper or REST client during setup. Its lifecycle values are `REGISTERING`, `PENDING_CLAIM`, `CONFIRMING`, `ACTIVATING`, `CONNECTED` and `REGISTRATION_ENDED`, plus a3's `NEEDS_RECONNECT`, `REVOKED` and `DEGRADED`. A row may also give `guidanceByHelperState`, which takes precedence over `guidanceByReason` and `guidance` when the fixture's `client.helperState` names that state (§2).
- **`connector`:** the a3 rows, unchanged.
- **`owner_ui`:** lifecycle `NOT_APPLICABLE`.

| Code | HTTP | Surface: lifecycle / retry / guidance |
| --- | --- | --- |
| `FEATURE_DISABLED` | 404 | helper: `REGISTRATION_ENDED` / none / `route_unavailable`; owner_ui: `route_unavailable` |
| `ROUTE_NOT_AVAILABLE` | 400 | helper: `REGISTRATION_ENDED` / none / `route_unavailable` |
| `DELIVERY_MODE_NOT_AVAILABLE` | 400 | helper: `UNCHANGED` / none / `update_helper` |
| `REGISTRATION_INVALID` | 400 | helper: `REGISTRATION_ENDED` / none / `update_helper` (registration body only) |
| `REGISTRATION_TOKEN_INVALID` | 401 | helper: `REGISTRATION_ENDED` / none / `register_again`; with helper state `activation_unresolved` → `check_owner_agents` (§2) |
| `REGISTRATION_PENDING` | 409 | helper: `PENDING_CLAIM` / `poll_after` / `wait_for_claim` |
| `REGISTRATION_ENDED` | 409 | helper: `REGISTRATION_ENDED` / none / `rejected` → `owner_rejected`, `expired` → `register_again`, `withdrawn` → `approval_ended` |
| `ACTIVATION_INVALID` | 400 | helper: `UNCHANGED` / none / `update_helper` (§6.1 row 5; the approval stays live) |
| `ACTIVATION_ID_REQUIRED` | 400 | helper: `UNCHANGED` / none / `update_helper` |
| `ACTIVATION_REPLAY` | 401 | helper: `REVOKED` / none / `owner_reconnect` (the identity is not frozen, §6.1) |
| `ACTIVATION_RECOVERY_EXPIRED` | 401 | helper: `NEEDS_RECONNECT` / none / `owner_reconnect` (also any activation or poll on a tombstoned token) |
| `AUTHENTICATION_REQUIRED` | 401 | helper: `UNCHANGED` / none / none; connector: a3 (`refresh_then_retry_once`); owner_ui: `sign_in` |
| `CLAIM_CODE_INVALID` | 404 | owner_ui: `check_code` |
| `CLAIM_INVALID` | 400 | owner_ui: `fix_claim` |
| `CLAIM_FORBIDDEN` | 403 | owner_ui: `not_permitted` |
| `CLAIM_STALE` | 409 | owner_ui: `reload_claim` (the replaced installation changed) |
| `CLAIM_ALREADY_DECIDED` | 409 | owner_ui: `withdraw_first` |
| `CLAIM_NOT_FOUND` | 404 | owner_ui: none |
| `ADDRESS_TAKEN` | 409 | owner_ui: `choose_another_address` |
| `ACTIVE_AGENT_LIMIT` | 409 | owner_ui: `agent_limit` |
| `PENDING_ACTIVATION_LIMIT` | 409 | owner_ui: `withdraw_or_wait` |
| `AGENT_NOT_RECONNECTABLE` | 409 | owner_ui: `choose_another_agent` |
| `INSTALLATION_NOT_FOUND` | 404 | owner_ui: none |
| `ACCOUNT_CHANGED` | 409 | owner_ui: `reload_browser` |
| `RATE_LIMITED` | 429 | helper: `DEGRADED` / `after_retry_after` / `service_busy`; connector: a3; owner_ui: `after_retry_after` / `service_busy`, `claim_attempts` → `too_many_attempts` |
| `INTERNAL_SERVER_ERROR` / `AUTH_UNAVAILABLE` | 500 / 503 | every surface: `backoff` / `service_unavailable` (helper and connector `DEGRADED`) |

**More points.**
- The test reads a fixture's row from its `client.surface`.
- `RATE_LIMITED` reasons are per route: `registration_limit` only on creation, `poll_interval` only on the status poll, `claim_attempts` only on the claim routes. Any route may return the ordinary a3 limit with no reason.
- Request bodies over the server's general limit keep today's `413`.

### 9. Migration and rollback

**Migration (`ENVOI_INSTALLATIONS_V2` on).** Every credential family with no `installationId` is **projected** as an installation (`x-legacy-projection`; fixture `migration-legacy-family`) when its agent is **approved**, or **frozen** by the agent-wide revoke (`onboardingStatus: "revoked"`, fixture `owner-installations-frozen-agent`). A frozen agent's installations therefore show as ended, as §6.4 promises, instead of disappearing. Families of pending or rejected agents are not projected.

| Installation field | Projected value |
| --- | --- |
| `id` | `installation_legacy_` + the family id without its `credential_family_` prefix |
| `connectionRoute` / `deliveryMode` | `local_helper` / `envoi_link`. Every shipped connector (Hermes, OpenClaw, xAI) is a local bridge. |
| `runtime` | `{ type: family.runtime \|\| agent.runtime \|\| "unknown", version: null }`. Families issued by the legacy approve have no `runtime`. |
| `createdAt`, `activatedAt` | the family's `createdAt` |
| `status`, `endedReason`, `endedAt` | from the family, as in §6.4. Families revoked before `a50766c` (2026-10-09) have no `revokedReason`, so they default to `revoked`. |
| `legacy` | `true` |

- **Nothing is written.** No user re-enrolls, no SQL migration runs and presence is untouched.
- **Replacement.** A legacy installation is replaced like any other when a new registration activates for that agent.

**New documents.** These are path-keyed documents on both FileStore and PostgreSQL, so there is no SQL migration:

| Path | Holds |
| --- | --- |
| `auth/agent-registrations/{registrationId}.json` | the registration, including the decision and its re-check fields |
| `auth/agent-registration-tokens/{sha256}.json` | `{ registrationId }` |
| `auth/agent-registration-codes/{hmac}.json` | `{ registrationId }` |
| `auth/agent-registration-recovery/{…}.json` | the §6.2 envelope |
| `auth/agent-installations/{agentInboxId}/{agentId}/{installationId}.json` | immutable installation fields |
| `rate-limits/agent-registrations/…`, `rate-limits/agent-claims/…` | durable counters |
| `auth/agent-address-holds/{address}.json` | an address hold: `{ registrationId, expiresAt }` |

New families also gain `installationId`, a new field on an existing document.

**Address holds** live under their own prefix, not in `identities/`, so an ended hold can never block today's paths.
- **Live holds count as taken.** Every path that reserves or checks an address treats a live hold (registration still `approved`, before `activationExpiresAt`) as taken: `reserveIdentity`, enrollment-token creation, `agent-address-availability`, and approval itself. The one exception is the holding registration's own activation.
- **Ended holds are ignored.** A hold has ended once its registration is no longer `approved` or is past `activationExpiresAt`. Withdraw, reject, expiry and activation each end it, and withdraw and activation also delete it.
- **Replacing an ended hold** happens inside the approval's own `withInboxMutation` transaction, under the lock key `address-hold:<address>`: read the hold with `getJson`, check its registration, then `putJson`. `updateJson` cannot be used there: it runs its own transaction, which deadlocks behind the caller's on FileStore and commits separately on PostgreSQL. `putJsonIfAbsent` checks only for absence, and `claimJson` only sets a null field on an existing document, so neither can replace an ended hold.
- **At activation** the hold becomes the real reservation, through `reserveIdentity`'s `putJsonIfAbsent` in `identities/`. If that fails, the row-11 re-check fails.

**Rollback: both flags off** (fixture `rollback-flags-off`).
- Agents activated through the new flow keep working on their families. `GET /api/agent/status` just loses `installation`.
- The registration, claim and activation routes return `404 FEATURE_DISABLED`.
- An approved but unactivated registration cannot finish. No agent was created for it, and the owner uses Quick Connect instead.
- Nothing is deleted.

**Re-enable** (fixture `reenable-after-rollback`). Status is derived from the families, so changes made while the flags were off show up correctly with nothing to reconcile. For example, a Quick Connect reconnect that replaced the new-flow family appears as an ended `replaced` installation next to the new legacy one.

**Code rollback.** Reverting A-4.x leaves the documents unread, and families keep working, because `installationId` is an ignored extra field. No cleanup job then runs, so registration documents (requested name, runtime) remain. The rollback runbook purges the `auth/agent-registration*` prefixes and expired holds by hand.

### 10. Deliberate differences, and residual risk

| Plan text | v1 decision | Why |
| --- | --- | --- |
| §42: a separate short-lived activation code after approval | The bootstrap token activates once, with `activationId` recovery | One fewer secret, with the same binding: one registration, private to the helper, single use. The secure-field fallback's bootstrap **code** belongs to A-3.1b. |
| §43: `status` includes `connected`, `offline`, `degraded`, `needs_reconnect` and `paused` | Stored status is `active` or `ended`, derived from the family | Connection wording has one source of truth, a5-presence. `paused` belongs to the agent and `needs_reconnect` is credential expiry. Storing them twice would let them disagree. |
| §43: `inboxId` and `capabilities` on the installation | Not included | The inbox belongs to the agent. Declared capabilities stay on the registration, so they are never mistaken for proof. |
| §36: registration statuses | Adds `activated` and `withdrawn` | Recovery needs `activated`; the owner's undo needs `withdrawn`. |
| §38: the claim screen "displays the same code" | The human types the code, and `claim.url` never contains it | See below. |
| §39: grants **per installation** | Permissions stay **per agent**, re-decided at every attach | Matches today's model and a3. Per-installation grants arrive with central authorization (Phase D). |
| §39: a policy profile | `"default"` only | No named profiles exist yet. The field is in the wire shape, so adding them later is additive. |
| §65: the flag list | Adds `ENVOI_AUTHENTICATED_REST_ROUTE` | REST is proven separately (§1). |
| a5 §1: presence renames at Phase B (`lastWorkClaimAt` → `lastClaimAt`) | Not renamed | Installation and family are 1:1 in v1, so a rename would only break a5 consumers. Revisit when an installation can have several families. |
| Two-owner plan: "five wrong claims before invalidation" | Five failures per human per 15 minutes | §2 |
| Two-owner plan: creation "bounded per pending owner/workspace" | Bounded per source, network and wide network, globally, and at three waiting approvals per human | A registration has no owner or workspace until it is claimed (§2). |
| v3 §40: effective permissions are a strict intersection | The intersection plus `receive_agent_messages`, always | Every agent can receive, as today's enrollment ensures. An agent that cannot receive could not get owner instructions. |
| v3 §32 step 5, §47 step 6: the model sees only the claim URL and code | `x-model-visible` also allows workspace, agent name and address, permissions, route and mode | None is a secret, and the §4 confirmation needs them in the chat (§7). |
| PR #75: on-demand hosts need an "On demand" label | `poll` and `on_demand` stay unavailable | The label does not exist yet; with a5 v1 a healthy on-demand host would look broken. |

**What typing the code protects against, and what it does not.** Typing stops the one-click case: a link that pre-fills a code and gets an agent approved without the owner ever handling the code. It does **not** stop social engineering. Anyone can create a registration with no auth, then talk an owner into typing its code: a new agent in the victim's workspace, or a takeover of an existing agent's identity. Conversely, a code exposed in a chat transcript can be claimed by whoever types it first.

The v1 mitigations are:
- only allowlisted, signed-in humans can claim;
- the lookup shows the requested details as the agent's claims, with its age;
- `existing_agent` forces explicit confirmation of the installation being replaced (`replacesInstallationId`), re-decides permissions, and re-checks everything at activation;
- **the helper activates only after the human beside the host confirms** the approver (`approverEmailHint`), the workspace, the agent and the permissions (§4). A code leaked from a shared chat and approved by someone else therefore stops at that human, who sees a stranger's account and declines;
- every approval appears in `GET /api/agent-claims`, for the approver and for every current manager of its target, with Withdraw until activation (§5.4);
- approvals, activations and replays are audited;
- names refuse control and bidirectional characters.

**Accepted for the beta, not in v1:**
- a coarse network origin on the lookup screen;
- fresh re-authentication before replacing an existing agent's installation;
- address squatting: an allowlisted human could hold up to three addresses at a time, ten minutes each, by approving self-made registrations, and repeat that by script. The beta has few, known humans, and each hold is audited;
- the confirmation is enforced by the helper. A host controlled by the attacker can skip it, but such an attacker already holds the bootstrap token, and the owner who typed the code still had to approve;
- without a host-native prompt the confirmation is advisory: a model that is manipulated, or that answers for the human, can confirm a stranger's approval. The approver hint still reaches the chat, where the human can see it;
- `approverEmailHint` shows a masked email and full domain to whoever runs the host. For a leaked code, that is the attacker's own sign-in, which they chose to use;
- a declined confirmation is not reported to the owner, who sees the approval only as `expired`. A bootstrap-authenticated decline route is a v2 candidate;
- a distributed attacker with many /48 or /24 networks can still fill the global pending cap. Every registration expires within 600 s, and `agent_registration.limited` events surface the attack; operators can lower the limits.

These are candidates for v2 or A-3.1b.

### 11. Fixtures

`test/contract-fixtures.test.js` checks the following for every fixture:
- **schemas:** responses, and request bodies named in `request.schema`. A negative body named in `request.invalidAgainst` must **fail**, and for the reason in `request.invalidBecause`. Every body sent to a registration route names one or the other;
- **codes:** the `x-codes` row for the fixture's surface (status, lifecycle, retry, guidance including `guidanceByHelperState`, `retry-after`); that route-specific codes appear only on their route (`REGISTRATION_INVALID` and `ROUTE_NOT_AVAILABLE` on creation, the activation codes on activate, `INSTALLATION_NOT_FOUND` on installation routes); that `FEATURE_DISABLED`, `ROUTE_NOT_AVAILABLE` and `DELIVERY_MODE_NOT_AVAILABLE` occur exactly when the fixture's flags say so; that a bootstrap token on any other route gets `AUTHENTICATION_REQUIRED`; and that each `RATE_LIMITED` reason fits its route;
- **headers:** `cache-control` on every successful response (`public, max-age=60` for routes, `no-store` otherwise, except the a3 status route);
- **helper lifecycle:** the lifecycle of each successful helper response, including `CONFIRMING` for an approved poll;
- **model-visible output:** every key is allowlisted; server-derived values equal their source; `state` fits the response; no token, internal id, `activationId` or id UUID from the exchange or its stored state appears, not even in free text; no code appears outside a pending registration;
- **route availability:** completeness and the flag rules;
- **claims:** code normalization, grantable and effective permissions (always including receive, also by schema), `agent.id` exactly for `existing_agent` (also by schema), a new agent's chosen name and address, the response target matching the request, and the owner claim list's order;
- **installation lists:** every active installation newest first, then at most `ownerInstallationEndedMax` ended ones newest first, all for the listed agent;
- **installations elsewhere:** an activation creates an active, non-legacy installation on the requested mode and an available route; a revoke returns ended/revoked; a legacy installation has the projected shape (by schema);
- **derivation:** every listed installation, and the installation named by agent status, is re-derived from the stored families (projection, frozen agents, read-time status, and the five-newest-ended cut). A legacy installation can never have ended by `activation_replay`;
- **migration and restart steps:** every step of the migration, rollback, re-enable and restart fixtures. After a restart every step succeeds, the stored agent is approved and not frozen, an `existing_agent` approval attaches to it, and its `replacesInstallationId` is the newest active installation derived from the stored families, or `null`;
- **owner-UI eligibility (revision 4):** a step may show the owner view, validated against a5-presence v1's `ownerAgentList` (named `a5-presence/ownerAgentList`). Each row's `status`, `credentialRevoked`, `onboardingStatus` and `permissions` are derived from the stored agent and families as a5-presence v1 derives them. `client.reconnectOffered` lists exactly the rows that §5.3's predicate offers, and every `existing_agent` approval in the fixture targets one of them;
- **tokens:** placeholders only, now including `envoi_reg_`.

A separate test checks three things:
- `activation-recovered`, `claim-approve-replayed`, `claim-approve-replayed-after-activation`, `claim-reject-replayed` and `claim-withdraw-replayed` repeat their originals exactly, and `activation-token-invalid-unresolved` is the identical activation request;
- the registration, lookup, approval (both targets), polling and paused-activation fixtures describe one consistent registration, including its claim window and activation deadline;
- the lookup's window equals `registrationTtlSeconds`, the unresolved retry declares its helper state, the legacy fixture stores more ended families than the list shows, and the limits agree (claim-list bound, retention order, widening creation limits).

The revision-3 checks were mutation-tested: 42 deliberate fixture and schema mutations are each caught, and existing agents' UUID and 48-character addresses and 80-character display names validate.

| Group | Fixtures |
| --- | --- |
| Availability | `routes-available`, `routes-available-rest`, `routes-disabled` |
| Registration | `registration-created`, `registration-feature-disabled`, `registration-route-not-available`, `registration-rest-not-enabled`, `registration-invalid`, `registration-unsafe-name`, `registration-rate-limited` |
| No access | `bootstrap-pending-no-status`, `bootstrap-pending-no-mcp`, `bootstrap-rejected-no-claim`, `bootstrap-expired-no-send` |
| Polling | `registration-pending`, `registration-approved`, `registration-rejected`, `registration-expired`, `registration-withdrawn`, `registration-activated`, `registration-poll-after-recovery-window`, `registration-poll-too-fast`, `registration-token-invalid` |
| Claim | `claim-lookup`, `claim-feature-disabled`, `claim-code-invalid`, `claim-attempts-exhausted`, `claim-not-admitted`, `claim-auth-unavailable`, `claim-approve-new-agent`, `claim-approve-replayed`, `claim-approve-replayed-after-activation`, `claim-approve-existing-agent`, `claim-approve-wrong-code`, `claim-already-decided`, `claim-account-changed`, `claim-forbidden`, `claim-address-taken`, `claim-agent-limit`, `claim-pending-activation-limit`, `claim-agent-not-reconnectable`, `claim-stale`, `claim-invalid`, `claim-reject`, `claim-reject-replayed`, `claim-reject-after-approve`, `claim-reject-wrong-code`, `owner-claims`, `claim-withdraw`, `claim-withdraw-replayed`, `claim-withdraw-not-found` |
| Activation | `activation-created`, `activation-recovered`, `activation-paused-agent`, `activation-pending`, `activation-rejected`, `activation-expired`, `activation-withdrawn`, `activation-id-required`, `activation-invalid`, `activation-token-invalid-unresolved`, `activation-replay`, `activation-after-recovery-window`, `activation-recovery-expired`, `activation-delivery-not-available`, `activation-server-error` |
| Installations | `agent-status-installation`, `agent-status-legacy-address`, `owner-installations`, `owner-installations-legacy-several`, `owner-installations-frozen-agent`, `owner-installation-revoke`, `owner-installation-not-found`, `installations-feature-disabled` |
| Migration and restart | `migration-legacy-family`, `rollback-flags-off`, `reenable-after-rollback`, `reconnect-after-installation-revoke`, `owner-reconnect-after-installation-revoke` |

### 12. Implementation notes for A-4.x (Lane A; informative)

- **One approval module.** Extract today's pending-agent approval into `src/agent-approval.js` and call it from the legacy approve route and from §5.3 (v3 §41). Registration and installations go in `src/agent-registration.js` and `src/agent-installations.js` (v3 §64).
- **Locks and slot counting.** Approve, withdraw and activate run inside `withInboxMutation`, with lock keys for the registration, the principal's `human:<id>:active-agents` and, for `new_agent`, `address-hold:<address>`. State moves only through conditional writes. Slot counting (`assertActiveAgentSlot`) charges the principal human, counts agents with a live family or no family (live: not revoked and not past `refreshExpiresAt`), and passes `excludingAgentId` for `existing_agent`. It adds that human's live `new_agent` approvals, plus `existing_agent` approvals of their agents that have no live family.
- **Startup reconciliation.** Narrow `reconcileLegacyAgentRevocations` (`src/server.js`, run at boot) so that it never freezes an agent whose families were ended by a per-installation revoke, a replay or a replacement. The freeze arrived in `ce07de5` (2026-10-02), and every boot since then has reconciled the pre-freeze data, while today's agent-wide revoke freezes in its own mutation. So the preferred option is to run the job once more behind a marker document and then retire it. The alternative is to reconcile only when every family lacks `revokedReason`, which arrived in `a50766c` (2026-10-09). Add a restart test on FileStore and PostgreSQL for `reconnect-after-installation-revoke`, and one for a `REFRESH_REPLAY` of an agent's only family.
- **Approval module.** The legacy approve route also lets a linked principal who is not an inbox manager approve. The shared module keeps that rule for the legacy route only.
- **Tests.** Every fixture runs against FileStore and PostgreSQL. Restart tests prove that durable limits, holds and pending registrations survive a container restart (two-owner plan B). A cleanup test proves the 24-hour deletion and the release of address holds.
- **Deployment.** Add the three flags to the Worker allowlist, `production-config`, `promote-release`, `.env.production.example` and `check-deployment`, all defaulting off.
- **Order (two-owner plan).** No implementation starts before `CONTRACT-APPROVED agent-registration v1`, and none is enabled before the hosted Phase A gate passes.

### 13. Revisions within v1

The entries before revision 4 were made before Lane B's `CONTRACT-ACK`.

- **Lane A independent review, against `a814a75`.** The review found three blockers:
  - activation did not re-check the decision, and approvals could not be undone;
  - re-attaching an agent restored its old permissions and skipped the agent limit;
  - approval created an agent that was orphaned if activation never happened.

  Most of the should-fix items were also addressed:
  - surface-specific code rows that match a3;
  - read-time installation status;
  - HKDF over the raw token;
  - the IPv6 /64 source key;
  - `CLAIM_FORBIDDEN` without an existence oracle;
  - approve replay and the owner claim list;
  - `poll` and `on_demand` held back;
  - a model-visible allowlist that fits Lane B's output;
  - the missing fixtures;
  - test checks that now fail on each of the review's 26 surviving mutations.

  Nothing had been consumed yet, so the version stays 1.
- **Lane A re-review, against `5e24430`.** The re-review confirmed the three blockers fixed and found four problems the revision introduced:
  - a late retry could register a duplicate agent; the token now becomes a tombstone that answers `ACTIVATION_RECOVERY_EXPIRED`;
  - the replay semantics were contradictory; `CLAIM_ALREADY_DECIDED` now has its own code;
  - address holds blocked today's reservation paths; they now live under their own prefix;
  - slot counting was unspecified; the slot is charged to the principal human, and "live" means unexpired.

  Also fixed:
  - test holes: free-text leaks, `state` not tied to the response, silent loss of a request schema, negative bodies that could fail for the wrong reason, the agent-status projection, and legacy `activation_replay`;
  - nits: withdraw by any co-manager, reject replay, the newest active installation, a neutral `approval_ended` guidance, and address squatting listed as residual risk.

  The version stays 1.
- **Lane B `MISMATCH` round 1 and a full Lane A review, against `36f7943` (after the first `CONTRACT-APPROVED`).**
  - **Why:** Lane B's consumer review found that `ownerInstallationList` capped `installations` at 6. That rejected a valid list of two active legacy installations plus five ended ones. The new Lane A session then ran three independent reviews, of the prose against the plans, the schemas and fixtures, and the claims about today's code.
  - **Version:** the approval preceded Lane B's review and nothing consumes v1 yet, so the human decided it stays v1 and is re-approved after a new `CONTRACT-ACK`.
  - **Product decisions (human):**
    - local confirmation of the approving workspace before activation (§4);
    - co-managers see and can withdraw each other's approvals (§5.4);
    - network-level registration limits (§2).
  - **Blockers fixed:**
    - the installation list has no bound on active entries; ended ones are capped by the test, and a seven-entry fixture proves it (§6.5);
    - response-side addresses and names accept existing agents' UUID and 48-character addresses and unbounded names (§3);
    - startup reconciliation must not freeze an agent after a per-installation revoke or a replay (§6.5, §12, a restart fixture);
    - agents frozen by the agent-wide revoke are still projected (§9).
  - **Semantics fixed:**
    - decision replays work in every later state, for approve, reject and withdraw (§5.3, §5.4);
    - the `REGISTRATION_TOKEN_INVALID` wording matches the tombstone, and an unresolved activation gets `check_owner_agents` (§2);
    - records are kept at least 24 h and deleted by 25 h;
    - `claim.url` follows `ENVOI_PUBLIC_URL`;
    - `receive_agent_messages` and `agent.id`-by-target are enforced by schema;
    - U+061C and U+180E are refused;
    - the slot rule matches `assertActiveAgentSlot`;
    - `active` means not revoked;
    - an activation replay never rewrites an ended installation;
    - activation re-checks the route and the slot;
    - an invalid activation body has its own code, `ACTIVATION_INVALID`, and leaves the approval live;
    - the recovery-key construction and the hold transaction are stated correctly;
    - three plan differences gained §10 rows.
  - **Test holes closed:** derivation outside migration fixtures, `cache-control`, `activationId` and UUID leaks, bootstrap tokens elsewhere, rate-limit reasons, claim-list order, cross-fixture deadlines, and fixtures for §6.1 rows 3 and 5 and the claim-route `FEATURE_DISABLED`.
  - **Re-review of the revision (`bcbef50`)** found no blocker. Fixed:
    - a fixture for existing agents' addresses and names;
    - a confirmation the helper can actually attribute: host-native prompt preferred, chat advisory, and `approverEmailHint` because the approver chooses `workspaceName`;
    - display-bounded, redacted names;
    - a restart check that proves the agent was not frozen;
    - codes tied to their routes;
    - the claim list keyed on creation and filtered by the live check;
    - the cleanup sparing a replaced hold;
    - no double-counted slots;
    - limit consistency checks.
  - **Mutation testing:** 42 deliberate mutations caught (§11).
- **Revision 4: owner-UI eligibility for reconnect (2026-10-19, after approval of revision 3).**
  - **Why:** Gate B-local failed at `7baaf63`, row 18. The owner revoked an agent's only installation (§6.5). Then the claim page's "Reconnect an existing agent" did not list that agent, so it could not be reconnected as the same identity.
  - **Cause:** two approved texts read differently.
    - This contract says a per-installation revoke does not freeze the identity, and that an `existing_agent` may have every credential family revoked, with `replacesInstallationId: null` (§5.3, §6.5).
    - a5-presence v1 reports such an agent in the owner view as `status: "revoked"`, `credentialRevoked: true`, `onboardingStatus: "approved"` (fixture `owner-revoked-refresh-replay`).
    - The server checks the stored record (approved, `active` or `paused`), so it accepts the approval. The owner UI filtered on the view's `status`, so it hid the agent.
  - **What changed:**
    - §5.3 gains "Owner-UI eligibility": `onboardingStatus === "approved"` and either `status` is `active` or `paused`, or `credentialRevoked === true`. A frozen agent always has `onboardingStatus: "revoked"` and stays ineligible.
    - §6.5 states the same beside the installation revoke route.
    - New fixture `owner-reconnect-after-installation-revoke`, with a new optional `client.reconnectOffered` field and the cross-contract schema name `a5-presence/ownerAgentList` (§11).
    - New server regression test `test/agent-reconnect-after-revoke.test.js`.
  - **Unchanged:** the wire format, every server behaviour and code, and a5-presence v1.
  - **For consumers of the fixtures:** the registration directory now holds 79 fixtures, up from 78. A step may name another contract's schema as `<contract>/<definition>`. Lane B's consuming reviews (`sdk/typescript/reviews/agent-registration.review.ts`, `integrations/onboarding/test/agent-registration.review.mjs`) pin the count at 78 and look schema names up in this contract only, so they need that update.
  - **Version:** this is a clarification of approved behaviour, so the contract stays v1. The human approved revision 4 ([`CONTRACT-APPROVED` rev 4](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6275502353), 2026-10-19), after Lane B's [`CONTRACT-ACK` @532789b](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6275137188). Lane B's #156 fixes the owner UI predicate.
- **Revision 5: stored records for the agent-remote-auth routes (2026-10-21; approved).** Lane B acknowledged it (board #34 comments 6344061712 and 6345010843, with client pairing #178) and the human approved it: `CONTRACT-APPROVED agent-registration v1 revision 5 @b9aa369` with #178 @5ff21d1 (comments 6346370584 and 6346396365). The earlier approval of the pre-rebase pair `f8a3354` + `774bf07` (comment 6344626717) is historical.
  - **Why:** agent-remote-auth v1 (approved @`bbd361e`) reaches this contract's approval, activation and family operations, and its §14 deferred the stored-shape note to this contract. The implementation (RA-A1, RA-A2) needs every stored record, transaction, hash rule, retention limit and cleanup path agreed before it starts.
  - **What changed:**
    - New §14: `audience` and `oauthClientId` on the credential family (§14.1); `oauth_access` and `oauth_refresh` token records, so a source rollback fails closed (§14.2); OAuth registrations and the code index (§14.3); consent decisions, including the denial record that agent-remote-auth §5.3's "Nothing is created" leaves implicit (§14.4); the refresh recovery envelope (§14.5); cleanup, the cleanup index and orphans (§14.6); flags-off and source rollback (§14.7).
    - `schemas.json`: typed `audience`/`oauthClientId` on `storedCredentialFamily` (present together); a rule that `remote_mcp_oauth` installations declare `on_demand` with runtime `remote_mcp`, and `provider_connector` installations `on_demand` with runtime `provider`; new `storedCredentialRecord`, `storedOAuthRegistration`, `storedConsentDecision`, `storedOAuthCode`, `storedOAuthRefreshRecovery`, `storedOAuthCleanupIndex`; fixture kind `stored`; optional fixture flags `ENVOI_REMOTE_MCP_OAUTH`, `ENVOI_PROVIDER_CONNECTORS`; `x-stored-records`.
    - Eleven fixtures (§14.0, §14.8) and `checkStoredOAuthRecords` plus an agreement test in `test/contract-fixtures.test.js`.
    - §14.0: the public registration and activation routes never create a remote-auth registration or installation, whatever the flags (clarifies agent-remote-auth §1).
  - **Unchanged:** the wire format, every route, code and owner view, today's server behaviour, and every existing record. No data migration.
  - **For consumers of the fixtures:** the registration directory now holds 90 fixtures, up from 79. Lane B's consuming reviews `integrations/onboarding/test/agent-registration.review.mjs` and `sdk/typescript/reviews/agent-registration.review.ts` pin 79. The `.mjs` also allows only the kinds `http`, `migration`, `rollback` and `restart`. Neither runs in CI, but both need the new count and the kind `stored`.
  - **Second review round** (Lane B `MISMATCH` [6324725735](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6324725735), [review](https://github.com/rachelgonsalves821/Envoi/pull/176#issuecomment-6324721163), @`b099fc9`):
    1. **Envelope deletion.** §14.5 had kept the envelope after a successor's first use. It now deletes it, as agent-remote-auth §6.2 requires, found through the successors' new `recoveryTokenHash`. New fixtures: `stored-oauth-successor-access-used` and `stored-oauth-successor-refresh-used`.
    2. **Parent and child retention.** A `+24 h` `deleteAfter` could delete the children of a registration that is legitimately kept until 25 h. Children now have no deadline of their own: registration cleanup deletes them with their registration, in one transaction, and the index sweep only deletes orphans and expired denials. New fixtures: `stored-oauth-retention-boundary` and `stored-oauth-orphan-sweep`.
    3. **Revoke coverage.** The rollback fixtures had lost their revoke steps. These are restored as transitions (`storedAfter`), with a listing after them. `test/agent-registration-stored-revoke.test.js` runs the real revoke route over the seeded OAuth state in both contexts. It showed that the real revoke also writes `revokedByHumanId`, which the fixtures now record.
  - **Version:** internal storage plus one clarification of agent-remote-auth §5.3, so the contract stays v1. It needs Lane B's `CONTRACT-ACK` and the human's version-specific approval before RA-A1 or RA-A2 writes any of these records.

### 14. Stored records for the agent-remote-auth routes (revision 5)

agent-remote-auth v1 (revision 2, approved @`bbd361e`) runs this contract's approval, activation, installation and credential family operations from its consent page and token endpoint. This section says what those flows store, so that both storage backends, cleanup and rollback can be checked before any code exists. It is task **RA-0**, part 2.

- **No wire change.** No route, response, code or owner view changes. Every record here is internal.
- **No data migration.** Each record is either new or gains optional fields. No existing record is rewritten, and every existing family keeps working unchanged. FileStore and PostgreSQL store these as documents at new paths, with no SQL migration.
- **Hashes.** "Hash" means the lowercase hex SHA-256 of the raw value, as `hashSecret` already does for agent credentials. Raw codes, bootstrap codes, handles, verifiers, client secrets and tokens are never stored. The handle and request body are stored only as digests.
- **Machine-readable table:** `x-stored-records`, one row per record: path, writer, transaction, secret handling, retention and cleanup.

#### 14.0 Public routes never create these records

agent-remote-auth §1 makes `remote_mcp_oauth` and `provider_connector` available in `GET /api/onboarding/routes` when their flags are on. That availability means "through agent-remote-auth's own flow": consent (§5) or a bootstrap code (§8). This contract's own public routes still never create such a registration or installation, whatever the flags:
- `POST /api/agent-registrations` with either route gets `400 ROUTE_NOT_AVAILABLE`, as it does today (x-route-availability: "never in v1"). Fixture `registration-remote-route-refused`;
- `POST /api/agent-installations/activate` with `deliveryMode: on_demand` gets `400 DELIVERY_MODE_NOT_AVAILABLE` (agent-remote-auth §11).

Otherwise a bootstrap-token registration could create an installation on an OAuth route with no `audience`, which §14.1 forbids. This clarifies agent-remote-auth §1, and no response changes.

#### 14.1 Credential family: `audience` and `oauthClientId`

agent-remote-auth §6.1 adds two facts to the family that an exchange creates:

| Field | Value |
| --- | --- |
| `audience` | The resource: `${origin}/mcp`, from `ENVOI_PUBLIC_URL` when the family is created. |
| `oauthClientId` | The client the code or bootstrap code was issued to: a client metadata document URL or a pre-registered `client_…` id. |

- Both are present, or neither is (`storedCredentialFamily.dependencies`). They are present only on families that an agent-remote-auth exchange created. Every family that exists today has neither.
- They are written once, in the activation transaction, and never change. Refresh, revocation, replacement, owner revoke, rollback and cleanup leave them as they are. A reconnect creates a new family and never copies them.
- Neither appears in any response, audit body, event or model-visible value.
- **Origin change.** If `ENVOI_PUBLIC_URL`'s origin changes, a family's `audience` no longer equals the resource. Its tokens are then refused at `/mcp` (`401`), and the user connects again. The server fails closed, and nothing is migrated.
- **Correction.** agent-remote-auth §14 calls `storedCredentialFamily` "closed". It is open: the server keeps other internal fields in it, such as `rotationCounter` and `updatedAt`. Revision 5 adds the two fields as typed, optional properties. The rest of that §14 note stands.

#### 14.2 Token records: `oauth_access` and `oauth_refresh`

An OAuth family's token index records (`auth/agent-credentials/{hash}`, `auth/agent-refresh-credentials/{hash}`) use `tokenType: "oauth_access"` and `"oauth_refresh"`, not `access` and `refresh`. The raw token formats stay `envoi_agent_access_…` and `envoi_agent_refresh_…` (agent-remote-auth §1).

**Why.** A server that predates agent-remote-auth knows only `access`, `refresh` and `mcp_read`. It refuses any other token type on every route: `401 AUTHENTICATION_REQUIRED`, or `REFRESH_TOKEN_INVALID` at `POST /api/agent-token`. A source rollback therefore fails closed: an audience-bound token never works on REST, not even on a server that has no audience check. Fixture `stored-oauth-source-rollback`.

**Rules**
- A family has `audience` exactly when every token record of it is an `oauth_` type. The server checks both the record type and the family. If they disagree, the token is refused and the mismatch is logged without token material.
- `oauth_access` is accepted only at `/mcp` (agent-remote-auth §9). Everywhere else it gets `401 AUTHENTICATION_REQUIRED`, like an unknown token. The one exception is agent-remote-auth §14's internal dispatch: the agent operations a `/mcp` tool call performs on behalf of the outer `/mcp` request. That dispatch must be marked in a way no external request can forge (a header or a loopback address is not enough), or call the services directly. Either way, the outer request is what authenticated the token.
- `oauth_refresh` is accepted only at `POST /oauth/token`. At `POST /api/agent-token` it gets `401 REFRESH_TOKEN_INVALID` and **revokes nothing**: it is not a replay of an A1 family. In the other direction, an A1 `refresh` record is unknown at `/oauth/token` (agent-remote-auth §6.2 row 4).
- An OAuth family never has `mcp_read` records. `POST /api/agent/mcp-read-token` needs an `access` token, and no `/mcp` tool issues one for an OAuth family.
- `oauth_access.usedAt` records the first outer `/mcp` request the token authenticated. The server sets it once, before it dispatches that request, with a conditional write under the family's lock, the same lock a refresh takes. Internal dispatch never writes it.
- The two successors of a rotation carry `recoveryTokenHash`: the hash of the old refresh token, which keys that rotation's recovery envelope. It is how the first use of a successor finds the envelope it must delete (§14.5). It is cleared then.

#### 14.3 Registrations and the code index

**The registration.** Consent approval (agent-remote-auth §5.2) and bootstrap issue (§8) create a registration that is already `approved` (`storedOAuthRegistration`). It enters the same indexes as every approval: the created and decided hour buckets, the principal's slot index, the approver index and, for `new_agent`, the address hold. It holds the usual decision fields of §5.3: `target`, `workspaceName`, `approverHumanId`, `principalHumanId`, `effectivePermissions`, `policyProfile`, `approvedAt` and `activationExpiresAt`. Every server version reads those, including one that predates this revision (`GET /api/agent-claims`). It also holds `oauth`:

| `oauth` field | Value |
| --- | --- |
| `source` | `consent` or `bootstrap` |
| `clientId` | the client |
| `redirectUri` | exactly as requested, loopback port included. `null` for a bootstrap code. |
| `codeChallenge` | the S256 challenge. `null` for a bootstrap code. |
| `resource` | the resource, which becomes the family's `audience` |
| `scope` | the effective permissions as scopes, in `x-scopes` order |
| `handleDigest` | the hash of the authorization request handle. `null` for a bootstrap code. |
| `codeHash` | the hash of the authorization code or bootstrap code |
| `codeUsedAt` | `null` until the exchange |

The registration never has `tokenHash` or `codeHmac`. It has no bootstrap token and no verification code, so the agent-registration activation route can never activate it. Its `decision` keeps `kind`, `humanId`, the body `digest` and `decidedAt`. It never keeps `redirectTo`, the code, or any response that contains the code. Its `activationExpiresAt` is the code's expiry: 60 s, or 600 s for a bootstrap code.

**The code index** `auth/oauth-codes/{codeHash}` (`storedOAuthCode`) lets the token endpoint find the registration from the code alone. It holds `kind` (`authorization_code` or `bootstrap_code`), `registrationId`, `clientId`, `expiresAt` and `usedAt`. Approval writes it in the approval transaction.

**The exchange** (agent-remote-auth §6.1) runs in one transaction under the registration's activation lock. It sets:
- the code index's `usedAt`;
- the registration's `status: "activated"`, `activatedAt`, `installationId`, `credentialFamilyId`, `agentId` and `oauth.codeUsedAt`;
- and, as §6.3 does, it creates the installation, the family (with `audience` and `oauthClientId`) and the token records.

So two concurrent exchanges of one code cannot both activate. The second sees `usedAt`, which is reuse (§6.1 row 5), and revokes the installation the first one created. The code index stays until its registration is deleted, so reuse after expiry still revokes, as §6.1 requires.

**Retry outcomes** (agent-remote-auth §5.2, `consentDecided.status`) are derived from these records alone, so they survive a restart:

| Status | Stored state |
| --- | --- |
| `pending_exchange` | `status: "approved"`, `codeUsedAt: null`, and `activationExpiresAt` not yet passed |
| `completed` | `status: "activated"` |
| `expired` | `status: "approved"` and `activationExpiresAt` passed (§4, derived) |
| `withdrawn` | `status: "withdrawn"`, from a manager (§5.4) or a failed exchange-time re-check (§6.1 row 11) |

#### 14.4 Consent decisions

`auth/oauth-consent-decisions/{handleDigest}` (`storedConsentDecision`) is the one decision on an authorization request handle.
- **Fields:** `humanId`, `decision` (`approved` or `denied`), `bodyDigest` and `registrationId` (both `null` for a denial), `decidedAt` and `handleExpiresAt`.
- **Created only if absent,** with the existing create-if-absent primitive. For an approval this happens inside the approval transaction, together with the registration and the code index. The first decision therefore wins:
  - a concurrent request by another human gets `404 AUTHORIZATION_REQUEST_INVALID`;
  - a concurrent identical approve by the same human gets `consentDecided`;
  - any other body, or a deny after an approve, gets `409 CLAIM_ALREADY_DECIDED`.
- **A denial creates only this record.** That is what agent-remote-auth §5.3's "Nothing is created" means: no registration, agent, code, hold or slot. The record is still needed so that approving after a deny gets `409 CLAIM_ALREADY_DECIDED`, and so that another human gets `404`. This clarifies §5.3 and changes none of its responses.
- **Retention.** An approval's record lives as long as its registration and is deleted with it. A denial's record lives until `handleExpiresAt` (at most 600 s after the handle was made), and cleanup then sweeps it. That is the retention agent-remote-auth §5.2 states.

#### 14.5 OAuth refresh rotation and recovery

A refresh (agent-remote-auth §6.2) runs in one transaction under the family's lock. It:
- sets the old `oauth_refresh` record's `usedAt`;
- writes the new `oauth_access` and `oauth_refresh` records, each with `recoveryTokenHash` set to the old token's hash;
- extends the family's `refreshExpiresAt` (A1);
- writes the recovery envelope `auth/agent-oauth-refresh-recovery/{old token hash}` (`storedOAuthRefreshRecovery`).

**The envelope** mirrors A1's rotation recovery:
- **Key:** HKDF-SHA256 with input key material the **old raw refresh token**, salt the SHA-256 of `ENVOI_DATA_ENCRYPTION_KEY`, and info `envoi-oauth-refresh-recovery-v1`, 32 bytes.
- **Encryption:** AES-256-GCM, with `familyId` and `oauthClientId` bound as additional data. A database read plus the server key cannot decrypt it, and it cannot be replayed into another family or for another client.
- **Contents:** the `tokenResponse`. The record also holds the two successor hashes and `expiresAt`, 60 s after the rotation.

**Recovery.** The same client presenting the old token gets the identical response from the envelope, provided all of these hold, checked under the family's lock:
- the family is not revoked;
- the envelope exists and has not expired;
- both successors are unused: the new refresh record's `usedAt` is `null`, and so is the new access record's (§14.2).

Every other presentation of a used refresh token is replay. The family is revoked with `refresh_replay`, and the installation ends with that reason (§6.4).

**Deletion at first successor use** (agent-remote-auth §6.2: "The first use of a successor deletes the envelope"). The first use of **either** successor runs in one write under the family's lock:
- **the successor access token at `/mcp`:** its `usedAt` is set before the request is dispatched;
- **the successor refresh token at `/oauth/token`:** this is the next rotation, and its transaction does this write too;
- **in both cases:** the envelope named by `recoveryTokenHash` is deleted, and `recoveryTokenHash` is cleared on both successors.

Because a recovery checks the envelope under the same lock, it can never race a successor's first use. From then on the old token finds no envelope, so it is replay: `invalid_grant`, the family is revoked as `refresh_replay`, and a3 holders get `CREDENTIAL_REVOKED` (fixture `token-refresh-replay`, unchanged). Each rotation has its own envelope, keyed by the token it rotated. Using a successor deletes only the envelope that names it. Fixtures: `stored-oauth-successor-access-used` and `stored-oauth-successor-refresh-used`.

**Other deletion.** The reaper deletes any envelope past `expiresAt`, as `reapAgentRotationRecovery` does for A1. Revoking the family also deletes the family's envelopes; this is best effort, because a revoked family is refused anyway. After either, a successor's `recoveryTokenHash` may name no envelope, and its first use then deletes nothing.

#### 14.6 Cleanup and orphans

**Parent and children.** A registration is the parent of its code index and its approved consent decision. The children live exactly as long as the parent, and never by a clock of their own.
- **Registration cleanup.** §2 keeps a registration at least 24 h after `createdAt` and deletes it by 25 h (`x-limits` `deleteRecordsAfterHours` and `deleteRecordsByHours`). When it deletes an OAuth registration, it deletes the code index, the approved consent decision and their cleanup entries **in the same transaction**, under the registration's lock. There is never a moment when the registration exists without its children, or the children exist without the registration, except for an orphan an older server left.
- **Cleanup index.** Every code index and consent decision write also writes an entry `auth/oauth-cleanup/{hour of createdAt}/{key}` (`storedOAuthCleanupIndex`: `kind`, `key`, `registrationId`, `createdAt`, `deleteAfter`), in the same write. Cleanup walks these hour buckets, so its work stays bounded.
  - **An entry with a registration** has `deleteAfter: null`. The index sweep reads that registration. While it exists, the sweep keeps the entry and its record and revisits them on a later run. It never deletes them because time has passed. Only when the registration is gone (an orphan) does it delete the record and then the entry.
  - **A denial** has no registration. Its entry's `deleteAfter` is its `handleExpiresAt`, and the sweep deletes it after that. This is separate from every registration-backed rule.
- **What survives the boundary.** Until registration cleanup removes the registration, a consent retry still gets `consentDecided`, and a reused code still revokes the installation it activated, across restarts. That holds at 24 h 30 min, at 24 h 59 min, and at any later sweep that finds the registration. After the registration is gone, both are unknown. Fixture: `stored-oauth-retention-boundary`.
- **Sweeps.** Through that index, cleanup also sweeps:
  - denied consent decisions after `handleExpiresAt`;
  - **orphans**: a code index or consent decision whose registration no longer exists. Fixture: `stored-oauth-orphan-sweep`.

  Expired refresh recovery envelopes are reaped separately (§14.5).
- **Orphans are unknown.** At the token endpoint an orphan code is `invalid_grant` and revokes nothing. At the consent routes an orphan handle is `404 AUTHORIZATION_REQUEST_INVALID`.
- **Families and token records** follow A1's existing retention. Revision 5 deletes none of them.
- **The client metadata cache** lives in process memory only. It is never stored.

#### 14.7 Compatibility and rollback

- **Flags off** (agent-remote-auth §11; fixture `stored-oauth-flags-off`):
  - every record stays, and nothing is deleted or rewritten;
  - OAuth tokens get `401` everywhere;
  - the installation stays listed and active, and the owner revoke ends it as `revoked`, at the family's `revokedAt`;
  - turning a flag on again restores every family that has not expired or been revoked.
- **Source rollback** to a release that predates agent-remote-auth (fixture `stored-oauth-source-rollback`):
  - That server refuses `oauth_` token types everywhere (§14.2).
  - It lists the installation from the same documents, and lists the approval in `GET /api/agent-claims`. Its owner revoke ends the installation as `revoked`.
  - It ignores `audience`, `oauthClientId`, the `oauth` registration field and the new paths.
  - Its registration cleanup deletes OAuth registrations after 24 h and leaves their code index and consent decision behind. A revision-5 server treats those as orphans (§14.6).
  - Rolling forward again needs no repair.
- **Evidence before any rollout.** Before any rollout is proposed, the implementation PRs name the source rollback SHA. They also demonstrate this compatibility by running that SHA's credential check, owner installation views, owner revoke and registration cleanup over records written by the new server, on FileStore and PostgreSQL.

#### 14.8 Fixtures (`kind: "stored"`, `"rollback"`)

Revision 5 adds the fixture kind `stored`: the records a flow leaves, with the owner views derived from them. It also adds:
- **`storedAfter` on a step:** the state after a step that changes storage. That step's response and every later step read it. The two rollback fixtures use it for the owner revoke;
- **`timeline`:** internal events, each with `event`, `at`, `storedAfter` and the `outcome` a request would get then. An event may also carry `tokenHash`. The events are `old_refresh_presented`, `successor_access_used`, `successor_refresh_used`, `index_sweep`, `registration_cleanup` and `restart`;
- optional `stored` arrays (`credentialRecords`, `registrations`, `consentDecisions`, `oauthCodes`, `oauthRefreshRecoveries`, `oauthCleanupIndex`) and the optional fixture flags `ENVOI_REMOTE_MCP_OAUTH` and `ENVOI_PROVIDER_CONNECTORS`.

`test/contract-fixtures.test.js` (`checkStoredOAuthRecords`) checks that:
- a family has `audience` exactly when its installation is on an agent-remote-auth route, and its token records are `oauth_` types exactly then;
- an activated registration's `resource` and `clientId` are its family's;
- the code index and the consent decision agree with their registration;
- only a consent registration has a handle, a redirect and a challenge, and a bootstrap registration has no consent decision;
- a denial lives no longer than its handle;
- a recovery envelope is keyed by a rotated refresh token of its family, bound to its client, and lives 60 s. It names unused successors issued by that rotation, and the successor refresh token carries the family's rolled expiry;
- every code index and consent decision has exactly one cleanup entry. Only a denial's entry has a deadline, its `handleExpiresAt`. An entry with a registration has `deleteAfter: null`;
- an existing envelope names two unused successors, both pointing back to it;
- every state the fixture describes passes these checks: the initial state, the state after each step that changes storage, and the state after each timeline event;
- each timeline state is the previous state with that event's rule applied. The rules are written in the test, independently of any server code. Each outcome is derived from the state the event leaves: recovery or replay; reuse revokes or `invalid_grant`; `consentDecided` or `404`;
- a revoke step's response and every later listing are derived from its `storedAfter`;
- no stored record holds a code, token, verifier, secret or code-bearing URL;
- no response carries the audience, the client or the client's host, derived from the fixture's own records;
- every OAuth bearer outside the flow is refused with `AUTHENTICATION_REQUIRED`.

The agreement test checks that:
- `x-stored-records` names every new path;
- both rollback fixtures read exactly the records the approval left. Each lists the installation active, revokes it (the state after changes only the family's `revokedAt`, `revokedReason` and `revokedByHumanId`), and lists it ended/revoked at the revoke time;
- both successor kinds delete the envelope, and the old token is then replay, as the approved `token-refresh-replay` fixture says;
- a sweep keeps a present registration's children before 24 h, at 24 h 30 min and near 25 h, including across a restart;
- no registration cleanup happens before 24 h, and the registration and its children are deleted together between 24 h and 25 h;
- orphans are swept;
- this table lists exactly the `stored-*` fixtures.

**The real revoke route.** `test/agent-registration-stored-revoke.test.js` seeds each rollback fixture's OAuth records onto a real enrolled agent, on FileStore. It then checks that OAuth tokens are refused on REST, at `/mcp` and at `/api/agent-token`, and that trying revokes nothing. Next it runs the existing owner revoke route and checks that the installation ends `revoked` at the family's `revokedAt`, that only the fields in the fixture's `storedAfter` change, and that audience and client stay. At this PR's head the server is the source-rollback server itself: it has no remote-auth code. Each RA implementation PR reruns the same test with its own server and the flags off.

| Fixture | Shows |
| --- | --- |
| `stored-oauth-installation` | A consent approval and its exchange: family, installation, token records, registration, code index, consent decision and cleanup entries. Also an earlier denial's record. |
| `stored-provider-installation` | A bootstrap code and its exchange: no handle, redirect, challenge or consent decision. |
| `stored-oauth-refresh-recovery` | 30 s after a rotation: the used old record, unused successors pointing to the envelope, and the envelope. |
| `stored-oauth-successor-access-used` | The old token recovered once; the successor access token's first use deletes the envelope; the old token is then replay and revokes the family. |
| `stored-oauth-successor-refresh-used` | The successor refresh token's first use (the next rotation) deletes the first envelope and writes the second; the first token is then replay; revocation deletes the second envelope. |
| `stored-oauth-retention-boundary` | Sweeps at 23 h, 24 h 30 min and 24 h 59 min, and a restart, keep a present registration's children and protections. Registration cleanup deletes them all together before 25 h. The denial lapses on its own. |
| `stored-oauth-orphan-sweep` | Children an older server orphaned are unknown, and the next sweep deletes them. |
| `stored-oauth-replaced-by-local-helper` | A local-helper reconnect replaces the OAuth family. The old family keeps its fields; the new one has none. |
| `stored-oauth-flags-off` | Flags off: tokens refused at `/mcp` and on REST; listed active, owner revoke, then listed ended/revoked. |
| `stored-oauth-source-rollback` | An older server over the same records: tokens refused everywhere; the approval listed; installation listed active, owner revoke, then listed ended/revoked. |

#### 14.9 Decisions for review

1. **Separate `oauth_` token types**, so a source rollback fails closed. The alternative is `access`/`refresh` records plus the family's `audience`, which an older server would ignore. That server would then accept OAuth tokens on REST.
2. **A stored consent decision for a denial.** It is the only way approve-after-deny and another human's request can be told apart, as agent-remote-auth §5.2 and §5.3 require.
3. **The code index outlives the code** until its registration is deleted, so reuse after expiry still revokes (agent-remote-auth §6.1).
4. **The first use of either successor deletes the envelope under the family lock**, as agent-remote-auth §6.2 requires. The successors' `recoveryTokenHash` finds the envelope. For the access token this costs one write, before dispatch.
5. **A cleanup index for OAuth records, with children tied to their parent.** It keeps cleanup bounded, and lets a revision-5 server find the code indexes and decisions that an older server's cleanup left behind. Children never get a deadline of their own, so no clock can delete them while their registration is retained.
6. **Approval.** Version-specific `CONTRACT-APPROVED agent-registration v1 revision 5 @<publication sha>` after Lane B's `CONTRACT-ACK`. It authorizes no flag, and no implementation beyond the separately approved RA tasks.

## Gate GA observability (additive audit data, 2026-10-13)

**What it is.** Audit data that makes the Phase A hosted gate (v3 §29) provable from the server side. It is additive under a3 §5 and a4 §2: agent clients ignore unknown event types and fields. No contract version changes and no fixture changes. These events reach the owner audit feed (`GET /api/inboxes/{id}/events/delta`) and the agent's own event stream, like every audit event.

The web client is the exception to "ignore unknown types". It subscribes to a fixed list (`frontend/src/event-replay.ts`), and its Activity page shows recent events. So a new type lands paired with that list, as progress-only. An event per ordinary refresh would also have flooded Activity, which is why only recoveries are audited.

| Event | Fields | When |
| --- | --- | --- |
| `agent.refresh_recovered` (**new**) | `agentId`, `credentialFamilyId`, `refreshExpiresAt` | When `POST /api/agent-token` is an A1 recovery: the same token and `rotationId` retried after a lost response, answered with the stored successor. `refreshExpiresAt` is that successor's, so it equals the family's current expiry. Ordinary refreshes stay visible only as the owner view's `credentialExpiresAt` and `presence.lastSuccessfulRefreshAt`. A replay writes only `agent.refresh_replay_detected`. Best-effort: the rotation has already committed. |
| `agent.work_claimed` | adds `attempts`, `credentialFamilyId` | Every claim. |
| `agent.work_failed` | adds `attempts`, `retryAt` (`null` unless retryable) | Every `fail` settlement. |

**Never in these events:** a token, a lease token, a `rotationId` or message text.

**Evidence capture** for the gate uses `scripts/ga-evidence.mjs` and `docs/architecture/agent-native-v2/evidence/phase-a-TEMPLATE.md`.

## case-session v1

**Contract:** `case-session`, version 1 (Phase C task **C-A0**, first of three). **Status:** approved. Rachel approved it at `f5b7950` for client work (C-B1 builds on it), and the human posted `CONTRACT-APPROVED case-session v1 @f5b7950` (board #34 comment 6257953606). The amendment below was approved with case-tools v1 revisions 1–3 as `CONTRACT-APPROVED case-session v1 amendment @15fff09` (comment 6257953866). case-tools v1 revision 2 amended it, before that contract's approval:
- added the `human_decision` work kind and its claim envelope (§2, §3, §3.1, §5);
- moved `envoi_authority_check` and `envoi_request_human` to `execute_cases`.

The amendment is additive for clients built on `f5b7950`. It needs the same final, exact-head human review as case-tools v1.

The blanket "CONTRACT-APPROVED (for Phase C)" posted on board #34 at 17:01Z on 2026-10-17 predates this publication and names no version, so it does not approve this contract; the version-specific approvals are the ones in the Status line. At publication nothing here was implemented and nothing was default-on; the server work is C-A1 and the client work is C-B1, and their state is recorded in the board's `INTEGRATED` comments.

**Fixtures:** [`test/contract-fixtures/case-session/`](../../../test/contract-fixtures/case-session/). It holds:
- `schemas.json`: draft-07 schemas plus the machine-readable tables `x-codes`, `x-rpc-codes`, `x-limits`, `x-case-tools`, `x-scope-fields`, `x-ended-precedence`, `x-implied-conditions`, `x-model-visible` and `x-operations`;
- one JSON file per case, including retry, reclaim, cancellation and rollback fixtures.

**Owner:** Lane A. **Consumer:** Lane B: the TypeScript connector's work loop, the local MCP relay, the Hermes, OpenClaw and xAI/Grok adapters, and the owner UI's audit list.

**Name.** Phase C planning called this `case-session-v1`. The registry convention keeps the version out of the id, so the canonical id is `case-session`, version 1, like `a3-pause-auth` and `agent-registration`. Lane B's C-B0 readiness check (PR #114) looks for the planning id and needs a one-line update.

**What it covers.** How a trusted host turns a claimed piece of work into a short-lived, server-bound scope for one model turn. This is the [Phase C plan](phase-c-execution-plan.md)'s "contract details" items 1, 2, 3, 5 and 7:
- minting a **case session** after a fenced claim, and what the session is bound to;
- how the session's bearer token is held, carried and used;
- the checks the server repeats on every use, and when and why a session ends;
- how claim, renew, acknowledge, complete and fail relate to the session (they all stay host-only);
- cancelling the model turn, and handling late writes and late settlement;
- retries, lost responses, reclaim and resume;
- flags, compatibility and rollback.

**Not in this contract.**
- **The tools themselves.** Their names, inputs, outputs, effects, idempotency and receipts belong to **`case-tools` v1**, published separately. This contract fixes only which tool **names** a session can carry (§5), the scope and result rules every tool must follow (§6.3), and how tools must be executed (§6.3). Tool fixtures here use only the MCP envelope, never a tool's own result shape.
- **HTTPS wake** (`http-wake` v1). A session starts only from a claim, however the host learned that work was waiting.
- **Starting a new case.** A session exists only for claimed inbound work. Starting a case stays a host operation in v1 (§15).

It builds on `a3-pause-auth` v3 (envelope, codes, pause, lease invalidation), `a4-wake` v2 (claim triggers and hints) and `agent-registration` v1 (installations, model visibility).

### 1. Flags and availability

| Flag (server-only, default off) | Turns on |
| --- | --- |
| `ENVOI_CASE_SESSIONS_V1` | The mint and end routes (§3, §8), session tokens on `/mcp` (§6), the `case_session.ended` event (§9), coded settlement errors (§7.3), and lease release on case pause and on `WORK_NOT_ELIGIBLE` (§3, §7.4). It requires `ENVOI_INSTALLATIONS_V2`, because a session binds an installation. If this flag is on and that one is off, startup fails closed. |

**How a host learns availability.** `GET /api/agent/status` gains `caseSessions: { "available": <flag>, "version": 1 }`. The field appears on every status response once C-A1 is deployed, whatever the flag. It is additive under a3 §1, so old connectors ignore it. A host never reads flags.
- **`available: false`, or the field is absent:** the host does not mint. A client released before Phase C keeps its pre-Phase-C flow (§13). Any other client stops and reports that sessions are unavailable.
- **`available: true`:** the host mints a session for every model turn and gives the model nothing else (§4).

With the flag off:
- the mint and end routes return `404 FEATURE_DISABLED`;
- a session token anywhere is an unrecognized bearer, `401 AUTHENTICATION_REQUIRED`.

**Sessions epoch.** No session outlives a disable. The server keeps one stored document, `config/case-sessions-epoch`, which holds `epoch` and `activeUntil`.
- **On startup with the flag off,** a C-A1 server sets `epoch` to now.
- **On startup with the flag on,** the server sets `epoch` to now if `activeUntil` has already passed. That covers a code rollback: the reverted server never refreshed `activeUntil`.
- **While the flag is on,** every server extends `activeUntil` to now + 60 s at least every 20 s.
- **Checking a session.** A session created before `epoch` is an unrecognized bearer (`401 AUTHENTICATION_REQUIRED`), even if every other check would pass. Each check reads `epoch` from a cache no more than 5 s old.
- **The result.** A disable takes effect when a server restarts. So turning the flag back on, or redeploying after a code rollback, never revives an earlier session (§13). During a rolling change, a session minted on a still-old server may be refused within seconds. Refusal is the safe direction.

### 2. Terms

| Term | Meaning |
| --- | --- |
| **Host** | The trusted process that holds the installation's access and refresh tokens and runs the work loop: the connector, `envoi-link`, or an equivalent REST client. It is never the model. |
| **Work** | One claimed message (`workId`, a3 §3). It is one of three kinds: agent work (a native message from another agent), a human instruction from the agent's owner, or a human decision (a person's approval of the agent's own request, case-tools v1 §12.6). |
| **Lease** | The fenced claim on that work: `leaseToken`, `leaseExpiresAt`, and a server-side `fence` that rises by one on every claim (a3, a4 §6). |
| **Turn** | One model invocation that handles one piece of work. |
| **Case session** | A server record plus a bearer token, minted by the host for one lease. It lets one turn call the case tools for exactly that work's case. |
| **Tool channel** | Whatever carries the model's tool calls to Envoi: the local MCP relay, or a provider's remote MCP client given the session token for this turn. |

### 3. Minting a session

`POST /api/agent/work/{workId}/session` with the host's **access token**:

```json
{ "leaseToken": "<the lease token from the claim>" }
```

The body has exactly this one field. `leaseToken` is 1–256 characters. Every response has `cache-control: no-store`.

The first matching row wins:

| # | Condition | Response |
| --- | --- | --- |
| 1 | `ENVOI_CASE_SESSIONS_V1` off | `404 FEATURE_DISABLED` |
| 2 | Over the a3 request limit | `429 RATE_LIMITED` |
| 3 | No bearer, an unknown or malformed one, or one that is not an access token. A session token, an `mcp_read` token and a bootstrap token are all unrecognized here, so a session can never mint another session. | `401 AUTHENTICATION_REQUIRED` |
| 4 | a3 §2.1 steps 2–4 | `401 CREDENTIAL_REVOKED`, `CREDENTIAL_EXPIRED` or `ACCESS_TOKEN_EXPIRED` |
| 5 | The agent is paused | `409 AGENT_PAUSED` |
| 6 | Body invalid | `400 CASE_SESSION_REQUEST_INVALID`. Nothing changes. |
| 7 | `workId` unknown, or not a message addressed to this agent | `404 WORK_NOT_FOUND`, identical in both cases |
| 8 | The work's case is paused or revoked | `409 CASE_CONTROLLED` with `caseId` |
| 9 | The work fails the eligibility checks the claim applies (listed below) | `409 WORK_NOT_ELIGIBLE` with `reason`. A live lease this host holds is released **without an attempt**, in the same transaction (§7.4). |
| 10 | The lease token does not hold this host's live lease (reasons below) | `409 WORK_LEASE_STALE` with `reason` |
| 11 | Otherwise | `201 sessionCreated`. The previous session for this work, if any, ends in the same transaction: with `superseded` if it was still usable, otherwise with the reason it already had (§6.2). |

**Deliberate difference from a3 §2.1.** a3 puts permission `403`s before `CASE_CONTROLLED`. Here, `CASE_CONTROLLED` (row 8) comes before `permission_removed` (row 9, a `409`). Rows 7–10 are facts about the work, not about the caller, and a controlled case is the most useful thing for the host to learn.

**`WORK_NOT_ELIGIBLE` reasons:**
- `counterparty_unavailable`: the sending agent can no longer act (paused, revoked or removed);
- `relationship_blocked`: either side blocked the other;
- `instruction_authority_lost`: the sender of a human instruction may no longer instruct this agent;
- `permission_removed`: this agent no longer has `receive_agent_messages`.

**`WORK_LEASE_STALE` reasons**, checked in this order:
- `other_installation`: the lease belongs to another credential family of the same agent. That is possible only for legacy agents with several active families (agent-registration §6.5).
- `superseded`: a later claim replaced this lease (the fence moved on), or the token is simply wrong.
- `settled`: the work completed or failed under this lease. A retryable `fail` counts as settled for that lease.
- `released`: the server released the lease without an attempt. That happens after an agent pause, a case pause (§7.4), a reconnect, an installation revoke or a `WORK_NOT_ELIGIBLE` mint.
- `expired`: the lease ran out without renewal.

Minting does **not** renew the lease. The lease keeps its own expiry, which the host renews as before.

**`201` body (`sessionCreated`):**

```json
{
  "session": {
    "id": "case_session_…",
    "token": "envoi_case_session_…",
    "tokenType": "Bearer",
    "status": "active",
    "transport": { "kind": "mcp_streamable_http", "url": "https://<public origin>/mcp" },
    "agentId": "agent_…",
    "installationId": "installation_…",
    "workId": "msg_…",
    "workKind": "agent_message",
    "caseId": "case_…",
    "fence": 3,
    "counterparty": { "kind": "agent", "address": "partner@envoi.mail" },
    "allowedTools": ["envoi_case_snapshot", "envoi_case_reply", "…"],
    "createdAt": "…",
    "expiresAt": "…"
  },
  "lease": { "workId": "msg_…", "leaseExpiresAt": "…" }
}
```

- **`token`** is `envoi_case_session_` plus 32 random bytes in base64url. The server stores only its SHA-256, and returns the token once, never again.
- **`transport.url`** is `${ENVOI_PUBLIC_URL}/mcp`, the only place the token works (§6).
- **`workKind`** is `agent_message`, `human_instruction` or `human_decision`. The last one was added with case-tools v1 revision 2 (§12.6).
- **`counterparty`** is derived from the work, never from the caller:
  - for agent work, `{ "kind": "agent", "address" }`, the sending agent's address;
  - for a human instruction, `{ "kind": "human" }`, meaning the owner who sent it, with no name or email;
  - for a human decision, the case's other agent, `{ "kind": "agent", "address" }`. The next step goes to that agent; the person who approved is never the counterparty.
- **`allowedTools`** is computed now, from the work kind and the agent's permissions (§5), in `x-case-tools` order. It is never empty: `envoi_case_snapshot` is always present.
- **`fence`** and **`installationId`** are for host evidence (Phase C rows C13–C18). They are never model-visible.
- **`expiresAt`** is `createdAt` + 900 s (`x-limits.sessionTtlSeconds`). It is an absolute cap: a session is not renewable, and it stops earlier whenever §6.2 says so.
- **`lease.leaseExpiresAt`** is the lease's current expiry, unchanged by the mint.
- **What the session never depends on:** the expiry of the access token that minted it. Its credential family, however, must stay valid (§6.2).

#### 3.1 The `humanDecision` work message

This message was added with case-tools v1 revision 2 (§12.6). When a person resolves an agent's request for a human decision, the server writes one `humanDecision` message into that agent's inbox for the case.

**How it is claimed.** A claim offers it like agent work, with no `acceptHumanInstructions` needed. `work.message` carries the schema `humanDecisionWorkMessage`, shown in fixture `claimed-human-decision`:

| Field | Meaning |
| --- | --- |
| `id`, `kind: "humanDecision"`, `type: "humanDecision"` | The message, which is also the `workId`. |
| `inboxId`, `caseId` | This agent's inbox, and the case the request was made in. |
| `recipientInboxId`, `recipientAgentId` | This agent. The host checks both are its own before minting a session. |
| `counterpartyAgentId`, `counterpartyInboxId`, `counterpartyAddress` | The case's other agent. This is the session's counterparty (`{ kind: "agent", address }`), and the §3 eligibility checks apply to that agent. |
| `senderType` | `human` for an approval or a decline, and then `senderHumanId` and `from.humanId` name the person. `system` for an expiry, which carries no person. |
| `requestId`, `policyEvaluationId`, `action` | The request and the authority it resolves. `action` is `proposal.accept` or `case.complete`. |
| `outcome` | `approved`, `declined` or `expired`. |
| `text` | A server-written summary of at most 500 characters. It never names the person. |
| `status`, `createdAt`, `deliveredAt`, `updatedAt` | As for any delivered work message. |

**Privacy.** Every id in this message is host-only, per §4: the person's id, the request and evaluation ids, and the counterparty's agent and inbox ids. The session minted for it (fixture `session-created-human-decision`) shows the model only the §4 keys, with the other agent as counterparty. Its lease, fence and expiry bind exactly as for agent work.

**Audit:** `agent.case_session_created`, for the owner. It carries `agentId`, `installationId`, `workId`, `caseId`, `sessionId`, `fence`, `allowedTools` and `expiresAt`, never the token or the lease token.

### 4. Custody: who may hold what

| Secret or value | Host | Tool channel | Model context (prompt, tool results, chat, logs the model reads) |
| --- | --- | --- | --- |
| Refresh token, access token | yes, private (A1, a3) | **never** | **never** |
| Lease token | yes, private | **never** | **never** |
| Session token | yes, until the turn ends | yes, as the MCP `Authorization` header for this turn only | **never** |
| Session id and fence; installation, agent, inbox, credential-family, work and case ids | yes | not needed | **never** |
| `x-model-visible` keys (below) | yes | — | yes |

The session token is the only Envoi credential a tool channel ever holds. The host gives it to the channel in one of two ways:
- **A local relay** keeps it in memory and adds it to each `/mcp` request.
- **A remote provider**, for example a provider-hosted MCP client, receives it as that MCP server's bearer for one turn and nothing longer-lived.

The host never writes the token into a prompt, system message, tool result, transcript, or log line the model or a provider's chat history can read.

**Model-visible keys** (`x-model-visible`). A host may put only these where a model can read them:

| Key | Source |
| --- | --- |
| `counterpartyKind` | `session.counterparty.kind` |
| `counterpartyAddress` | `session.counterparty.address`, agent work only |
| `allowedTools` | `session.allowedTools` |
| `sessionExpiresInSeconds` | `session.expiresAt` minus the time the turn starts |
| `agentAddress` | the agent's own address, from `GET /api/agent/status` (agent-registration §7) |

Everything else from §3 stays with the host. The case content the model works on comes from the tools.

**Tool results are model context.** `case-tools` v1 must keep every tool result within this rule:
- no token of any kind;
- no internal id: no case, work, message, inbox, agent, installation, session or credential-family id;
- only the opaque, session-local references that contract defines, so the model can point at a message, proposal or asset.

### 5. Which tools a session can carry

`x-case-tools` lists every tool name a session may ever carry, the permission each one needs, and the work kinds it applies to. Every row that applies to agent work also applies to `human_decision` work. A session's `allowedTools` is the subset of that list the agent's permissions allow for this work kind.

| Tool | Needs | Work kinds |
| --- | --- | --- |
| `envoi_case_snapshot` | read (send or receive) | both |
| `envoi_case_reply` | `send_agent_messages` | both |
| `envoi_case_propose` | `send_agent_messages` | agent work |
| `envoi_case_decide` | `execute_cases` | agent work |
| `envoi_authority_check` | `execute_cases` | agent work |
| `envoi_request_human` | `execute_cases` | agent work |
| `envoi_case_list_assets` | read | both |
| `envoi_case_share_asset` | `create_assets` | agent work |
| `envoi_case_complete` | `execute_cases` and `send_agent_messages` | agent work |

`execute_cases` is the permission today's agent case actions already require (`POST /api/inboxes/{inboxId}/cases/{caseId}/actions`).

**This table is provisional until `case-tools` v1 is approved.** If that contract renames a tool or changes what a tool needs, this table changes with it. The change goes into a revision of case-session v1 made before either contract is approved, so the two never disagree.

The legacy tools (`envoi_send_message`, `envoi_send_proposal`, `envoi_claim_work`, `envoi_complete_work` and the rest of `src/agent-mcp.js`) are **never** in a session. Neither is any lease tool: settling work is host-only (§7).

### 6. Using a session

#### 6.1 Where the token works

**Only on `POST /mcp`**, sent as `Authorization: Bearer envoi_case_session_…`. Today's MCP transport rules in `docs/agent-mcp-remote.md` all still apply:
- JSON-RPC over stateless Streamable HTTP, the `MCP-Protocol-Version` header, and the methods `initialize`, `ping`, `tools/list` and `tools/call`;
- `403` when the Origin is not allowed. This is checked before anything else.
- `405` for `GET` and `DELETE`, `202` for `notifications/initialized`, and the `406`, `413`, `415` and `400` envelope errors (JSON-RPC `-32600` and `-32700`). These run after §6.2 steps 1–5, because today's code authenticates first.

`tools/list` returns exactly the effective set (§6.4).

**On any other route** a session token is an unrecognized bearer: `401 AUTHENTICATION_REQUIRED`, identical to an unknown token. That covers `/api/agent/*`, `/api/inboxes/*`, the event stream and delta, the token routes, agent status, and the settlement, mint and end routes. A session therefore cannot claim, renew, acknowledge, complete, fail, reply through REST, refresh, read status, mint or end.

#### 6.2 Checks on every request, and when a session ends

A session is **usable** until it **ends**. Once ended, it stays ended.

**Ends are recorded eagerly.** Each action in the table below records the end in the **same transaction** as the action itself. It does so for every session the action ends that is still usable and not yet past `expiresAt`. That same transaction also writes the `agent.case_session_ended` audit and, where §9 says so, the `case_session.ended` event. A session already past `expiresAt` gets `expired` recorded instead, with no event.

| Action | Recorded reason |
| --- | --- |
| Credential family revoked or replaced (any a3 `CREDENTIAL_REVOKED` reason), installation revoked, agent revoked or removed | `credential_ended` |
| Agent paused | `agent_paused` |
| Case paused or revoked | `case_controlled` |
| A `WORK_NOT_ELIGIBLE` mint | `work_ineligible` |
| `complete` or `fail` of the work | `work_settled` |
| The host's end call (§8) | `ended_by_host` |
| A newer mint for the same work | `superseded` |
| A claim that gives the work a new fence | `lease_lost` |
| Cleanup after `expiresAt` | `expired` |

**Conditions are also derived on every request.** Some conditions arise without any action, for example:
- a lease that silently expires;
- a family that passes its refresh expiry;
- a counterparty that pauses or is revoked (an action on the other side's agent, which records no end on this side's sessions);
- a permission or authority change.

The server therefore re-derives every condition on every request, as defense in depth. The first request that finds one records it.

**Order of checks.** Every `/mcp` request with a session token runs these checks first. The first match wins.

1. `429 RATE_LIMITED`.
2. `401 AUTHENTICATION_REQUIRED` when the token is unknown or malformed, when the flag is off, or when the session was created before the sessions epoch (§1).
3. `401 CASE_SESSION_ENDED`, with the recorded `reason`, when the session has a recorded end reason other than `expired`. The recorded reason always wins, even if a condition higher in the precedence holds now.
4. `401 CASE_SESSION_EXPIRED` when the recorded reason is `expired`, or when nothing is recorded and `expiresAt` has passed. In the second case the request records `expired`. Expiry outranks every condition derived after it, so a session past `expiresAt` never reports a later lease loss or pause.
5. `401 CASE_SESSION_ENDED` when nothing is recorded and a condition below holds now. The request reports the first holding condition in this order (`x-ended-precedence`) and records it:

   | `reason` | Holds when |
   | --- | --- |
   | `credential_ended` | The session's credential family is revoked, replaced or past its refresh expiry; its installation has ended; or the agent is revoked or removed. |
   | `agent_paused` | The agent is paused. A pause releases the lease (a3 §3), and a resume never revives the session. |
   | `case_controlled` | The case is paused or revoked. A case resume never revives the session either. |
   | `work_ineligible` | Any §3 `WORK_NOT_ELIGIBLE` condition holds. The transaction that records this also releases the work's live lease without an attempt (§7.4). |
   | `work_settled` | The work completed or failed, under any lease. |
   | `ended_by_host` | The host ended the session (§8). |
   | `superseded` | A newer session exists for this work. |
   | `lease_lost` | The session's lease is no longer the work's live lease: it expired, it was released, or a newer claim replaced it. |

6. JSON-RPC errors for the method, tool name or arguments (§6.4).
7. The tool runs. `case-tools` v1 defines its result and errors.

**Implied conditions** (`x-implied-conditions`). Pausing an agent, pausing a case and settling the work each also end the lease. So whenever `agent_paused`, `case_controlled` or `work_settled` holds, `lease_lost` holds too, and the fixtures mark both.

Ending a credential does **not** always release the lease:
- reconnect and installation revoke do release it;
- agent revoke, agent removal, owner access revoke and refresh replay leave it to lapse, because the host can no longer renew it.

**Error bodies.**
- Steps 1–5 answer at the HTTP level with the a3 §1 envelope, never with a JSON-RPC result. This matches how a3 §3 returns `AGENT_PAUSED` on `/mcp`, and an MCP client surfaces such an answer as a transport error.
- A `401` from steps 3–5 also carries `www-authenticate: Bearer realm="Envoi agent MCP", error="invalid_token"`.

#### 6.3 Rules every case tool must follow

**Scope comes from the session.** Every case tool takes its case, counterparty, recipient, inbox and agent from the session.
- **No** case tool accepts `caseId`, `workId`, `inboxId`, `agentId`, `senderAgentId`, `recipientAddress`, `recipientAgentId` or any other field that names a scope (`x-scope-fields`).
- Every tool's input schema has `additionalProperties: false`. A scope argument therefore fails as `-32602`, with `data.code: "TOOL_ARGUMENTS_INVALID"`, before anything runs.
- Fixture `session-scope-override-rejected` pins this rule, and `case-tools` v1 must keep it.

**Case tools run in-process.** A case tool runs inside the server process, against the session's scope.
- It never goes through today's `/mcp` loopback (`callRest` in `src/server.js`), because that forwards the bearer to REST, and REST refuses session tokens (§6.1).
- It never wraps a REST error body into a tool result.

**Writes are checked inside the write.** Every tool that writes takes the same locks as work settlement: the agent's inbox, every inbox bound to the case, and the case mutation key. Under those locks, inside the same transaction as its effect, it re-runs the §6.2 step 3–5 checks.
- **What this rules out.** Agent pause, installation revoke, refresh replay, case pause and revoke, settlement and claim all take one of those locks. A write therefore either commits before such a change and stays durable and audited, or it is rejected. It is never partly applied.
- **How a rejection arrives.** As the HTTP-level `401 CASE_SESSION_ENDED` or `CASE_SESSION_EXPIRED` from §6.2, never as a tool result.
- **Changes made under other locks.** For example, an owner's membership or role change that affects instruction authority. The transaction reads these conditions, but they are not serialized with the write. A write racing such a change may commit, and the next request ends the session.

**Reads are checked after the read.** A tool that only reads loads its data, then re-runs the checks before returning anything. A read that started before a revoke and returns after it gets `401 CASE_SESSION_ENDED`, not data.

**Results** follow the §4 rule for tool results.

#### 6.4 Tool availability within a session

The **effective set** for each request is the session's `allowedTools`, intersected with what the agent's **current** permissions allow (§5), and limited to the tools this server implements. A tool whose `case-tools` revision has not shipped is absent from `tools/list` and from a newly minted session's `allowedTools`, and gets `TOOL_NOT_IN_SESSION` (clarified with `case-tools` v1 §1). The fixtures here model a server that implements all nine.
- A permission removed after the mint removes its tools at once.
- Losing `receive_agent_messages` ends the session instead, with `work_ineligible`.

| Request | Response (HTTP 200, JSON-RPC) |
| --- | --- |
| `tools/call` for a name outside the effective set, including every legacy and lease tool | error `-32602`, `data.code: "TOOL_NOT_IN_SESSION"` |
| `tools/call` whose arguments fail the tool's schema | error `-32602`, `data.code: "TOOL_ARGUMENTS_INVALID"` |
| Unknown method | error `-32601` |

These errors change nothing, and the turn may continue. The host never performs a refused action itself (§10).

### 7. Work operations stay with the host

#### 7.1 What changes

Claim, renew, acknowledge, complete and fail keep their routes, bodies and access-token authentication (a3 §3, a4 §4–§6, `x-operations`). The model cannot reach them (§6.1, §6.4).

What is new:
- **Completing or failing the work ends its session** (`work_settled`). Acknowledging it does not.
- **A claim that re-fences the work ends the previous fence's session** (`lease_lost`).
- **`envoi_case_complete` is not settlement.**
  - The tool marks the **case** finished, with a canonical outcome receipt (`case-tools` v1). It does not settle the work.
  - Work settlement records only that this one message was processed.
  - A host settles the work after every turn, whatever the case's state, and a processed work item never marks a case finished.

#### 7.2 The host's loop with a session

1. **Claim** (a3, a4). On `claimed`, keep the `leaseToken` private.
2. **Mint a session** (§3). On any error, do not start a turn; follow the code's row in `x-codes`.
3. **Start the turn**, giving the model only the §4 model-visible keys and the session-scoped tool channel.
4. **Renew the lease while the turn runs**, at least every 20 s (`x-limits.hostRenewIntervalMaxSeconds`, a third of today's 60 s lease). Any renewal error cancels the turn (§10).
5. **When the turn ends**, end the session (§8), then settle:
   - `complete` if the turn finished and its tool effects are the intended result;
   - `fail` with `retryable: true` for a transient fault;
   - `fail` with `retryable: false` for a permanent one.

   Settlement never carries model text.

#### 7.3 Coded settlement errors (with the flag on)

With `ENVOI_CASE_SESSIONS_V1` on, the settlement routes use the a3 envelope for exactly the cases in the table below. The settlement routes are `renew`, `acknowledge`, `complete` and `fail`, plus the instruction reply `POST /api/agent/instructions/{workId}/reply`, which shares their code path. No HTTP status changes, so a client that branches on status keeps working.

| Today (status, message) | With the flag on |
| --- | --- |
| `404` "Work was not found for this agent" | `404 WORK_NOT_FOUND` |
| `409` "Work lease fence is stale", where the lease belongs to another credential family | `409 WORK_LEASE_STALE`, reason `other_installation` |
| `409` "Work lease fence is stale", where the token does not match or no claim exists | `409 WORK_LEASE_STALE`, reason `superseded` |
| `409` "Work lease has expired or was consumed", where the lease was released (`reofferWithoutAttempt`) | `409 WORK_LEASE_STALE`, reason `released` |
| `409` "Work lease has expired or was consumed", where it was settled (`completed`, `failed`, or `retryable` after a `fail`) | `409 WORK_LEASE_STALE`, reason `settled` |
| `409` "Work lease has expired or was consumed", where it expired | `409 WORK_LEASE_STALE`, reason `expired` |
| `409` "Work has already been processed", or "Message already has a receipt outside this work fence" | `409 WORK_LEASE_STALE`, reason `settled` |

Everything else on these routes keeps **today's body** in v1:
- **Validation `400`s:** "Claim body must be a JSON object", "leaseToken is required", "retryable must be a boolean", "Only text and leaseToken are accepted", and the instruction text validation.
- **Eligibility and authority `403`s:**
  - "Sender agent is paused or unavailable";
  - "Message receive permission was lost";
  - "Agent is not approved to receive messages";
  - "Agent is not approved to send replies";
  - "Instruction human no longer has workspace administrator authority";
  - every other human-instruction authority refusal.
- **`404` "Human instruction required"** (a reply to agent work).
- **The transient `409`** "Case participants changed while acquiring the mutation lock; retry". Retry it with backoff.
- **The integrity `409`s on instruction replies:** "Reply has no matching durable record" and "Reply exists without its idempotency record".

**Eligibility runs before the lease check.** Once the work is ineligible, the host cannot settle it. It mints instead: row 9 answers `WORK_NOT_ELIGIBLE` and releases the lease without an attempt. A host with no session support lets the lease lapse.

`AGENT_PAUSED` and `CASE_CONTROLLED` keep their a3 meaning. With the flag off, every settlement body stays exactly as it is today.

#### 7.4 Leases released without an attempt (with the flag on)

**New.** Three things release a live lease without using an attempt, as an agent pause already does (a3 §3, `reofferWithoutAttempt`):
- **Pausing or revoking a case** releases every live lease on work in that case and ends their sessions with `case_controlled`. When the case resumes, a4's `work.available` with reason `case_resumed` lets the host claim again at once, under a new fence.
- **A `WORK_NOT_ELIGIBLE` mint** (§3 row 9) releases that lease.
- **A session request that records `work_ineligible`** (§6.2 step 5) releases the work's live lease in the same transaction.

After a release for ineligibility, the claim filter skips the work until it is eligible again. Without the flag, the lease simply runs out, and the reclaim then costs an attempt.

### 8. Ending a session

`POST /api/agent/work/{workId}/session/end` with the host's access token:

```json
{ "leaseToken": "…", "sessionId": "case_session_…" }
```

**Who can end it.** The host that minted the session: the same agent, the same credential family and the same `leaseToken`. Ending is always safe, so the call also works while the agent is paused, while the case is controlled, and after the lease is no longer live.

**`200 sessionEnded`** returns `{ "session": { "id", "status": "ended", "endedReason", "endedAt" } }`. The end route uses the same derivation as §6.2 steps 3–5, then records the result:
- **Already recorded:** the response repeats that first ending exactly, so ending twice is safe.
- **Nothing recorded, past `expiresAt`:** `endedReason: "expired"`, with `endedAt` equal to `expiresAt`.
- **Nothing recorded, a condition holds:** the first holding condition in `x-ended-precedence`.
- **Still usable:** the session ends now, with `endedReason: "ended_by_host"`.

**Errors.** Rows 1–4 of §3 apply first. `AGENT_PAUSED` does not apply here. Then:
- `400 CASE_SESSION_REQUEST_INVALID` when the body is invalid;
- `404 CASE_SESSION_NOT_FOUND` when the session is unknown, belongs to other work, belongs to another lease, or is older than the sessions epoch. The response is identical in every case.

**Audit:** `agent.case_session_ended`, with `sessionId`, `workId`, `caseId` and `endedReason`. Exactly one is written per session, in the transaction that records the end (§6.2).

### 9. Event

`case_session.ended` is a stored event in the agent's own inbox. It uses the a3 §5 event format with an a4 §1 cursor.

| Field | Value |
| --- | --- |
| common | `id`, `type`, `createdAt`, `sequence`, `cursor` |
| `agentId`, `workId`, `caseId`, `sessionId` | the session's |
| `reason` | `case_controlled` or `agent_paused` |

**When it is emitted.** In the same transaction as a case pause, a case revoke or an agent pause, once for each session that ends with that reason.

**When it is not.**
- A revoke already closes the stream with `credential.ended`.
- Settlement, `ended_by_host`, `superseded` and a re-fencing claim are the host's own actions.
- An expiry or an unrenewed lease comes from the host's own timers.

**What the host does.** It cancels that turn at once (§10), without waiting for the next renewal to fail. The event is not a claim trigger (a4 §4).

**Owner UI.** Like every audit type, the event needs a paired entry in Lane B's `WORKSPACE_EVENT_TYPES`.

### 10. Cancellation, late results and no fallback

The host cancels the running turn when any of these happens:
- a renewal returns an error;
- `case_session.ended`, `agent.paused` or `credential.ended` arrives;
- the tool channel reports `CASE_SESSION_ENDED` or `CASE_SESSION_EXPIRED`;
- the tool channel reports `401 AUTHENTICATION_REQUIRED`, after a rollback or an epoch move (§1). The host then re-reads `caseSessions` from status. If sessions are available it mints once more; otherwise it stops.
- the host's own deadline passes.

**Cancelling** means:
1. Stop the model invocation, and abort any provider request.
2. End the session (§8), unless it has already ended.
3. **Discard** whatever the model produces after that point. It is never sent, settled or shown to the counterparty.
4. Settle only if the lease is still live and the work deserves it. Otherwise follow the code's row: `reclaim`, `after_resume`, `after_case_resume` or `none`.

**Late writes.** A tool write that reaches the server after the session ended is rejected (§6.3). A write that committed before is durable. On resume the snapshot (`case-tools` v1) shows it, so the next turn does not repeat it.

**Late settlement.** Settling with a lease that is no longer live is rejected, as today:
- `WORK_LEASE_STALE` with the flag on (§7.3);
- or `AGENT_PAUSED`, `CASE_CONTROLLED`, or an a3 `401`.

**No privileged fallback.** A host using sessions never uses its own access token to carry out an action that the session refused or could not perform.
- In particular, it never posts model-authored text through `POST /api/inboxes/{inboxId}/messages`, the instruction-reply route or a legacy MCP tool, either after a session tool or instead of one.
- Model content reaches Envoi **only** through the case tools.
- A refusal is an outcome to report, not a reason to try a stronger credential.

The server cannot observe this rule, so C-B1 evidence must show it (Phase C rows C04–C06 and C16–C18).

### 11. Retry, lost responses, reclaim and resume

| Situation | Exact behavior |
| --- | --- |
| **Mint lost response** (5xx, network error, or timeout after sending) | Retry the identical request, with bounded backoff, while the lease is live. Each successful mint ends the previous session (`superseded`), so the session the host actually received is always the live one. Minting is **not** idempotent by key: a lost session token is never needed again, so the server never stores a way to return it. |
| **Two mints in flight** | The host keeps at most one mint in flight per work. If it breaks this rule and then sees `superseded` during a turn, it cancels that turn, mints once more and starts again. |
| **Claim lost response** (unchanged, a3 and a4) | The lease exists, but the host has no `leaseToken`, so it cannot mint. The next claim returns `idle` with `nextAvailableAt` at that lease's expiry (a4 §5). The claim after that returns the same `workId` with a new lease and a higher fence. |
| **Lease lost mid-turn** (renewal failed, or `lease_lost`) | Cancel the turn and claim again. If the same work comes back, it has a new fence and needs a new session. |
| **Agent pause and resume** | The pause ends the session (`agent_paused`) and releases the lease without an attempt (a3). After `agent.resumed`, the host claims, mints and runs a new turn. The old session never works again. |
| **Case pause and resume** | The same, through §7.4, `case_session.ended` and a4's `case_resumed`. |
| **Reconnect or new installation** | Every earlier family is revoked, so its sessions end with `credential_ended`. The new installation claims and mints. Its sessions name the new `installationId`, with the same agent, address and cases. |
| **Tool call retried after a lost response** | Defined by `case-tools` v1. Every write tool takes an idempotency key scoped to the agent, the **work** and the tool, never to the session or the fence. A reclaimed or resumed turn handles the same `workId`, so an identical replay under a later session returns the original committed result, and a conflicting reuse is refused. A new inbound message is new work, so a key used in an earlier turn of the same case never collides with it. A host that resumes a turn reuses the keys of the calls it replays. |
| **Session expired mid-turn** (`CASE_SESSION_EXPIRED`) | Cancel the turn. If the lease is still live, mint once more and start a new turn, which reads the snapshot first. |
| **Rate limited or 5xx on `/mcp`** | The tool channel waits as told and retries. The session is unaffected. |

**Identity is preserved.** Throughout, the agent's identity, address, cases and history stay the same. Only an owner reconnect changes the installation and credential family (agent-registration §6.3). No path restores a scope that has ended: every new session is minted against current state.

### 12. Codes

New codes use the a3 §1 envelope. `x-codes` gives one row per client surface (`bySurface`):
- **`host`**: the host on its own routes. `lifecycle` is the a3 connector state.
- **`tool_channel`**: whatever holds the session token. It has no lifecycle of its own, so its lifecycle is `UNCHANGED`.

**`turn`** says what the host does with a turn that is running when it gets the code:
- `continue`: keep the turn running.
- `cancel`: cancel the turn (§10).
- `none`: the code arises only before a turn exists.
- `start`: success fixtures only. The host may start a turn now.

At mint no turn is running yet, so `cancel` and `none` both mean "start no turn", and `continue` means "retry the mint as `retry` says".

| Code | HTTP | Surface: lifecycle / retry / guidance / turn |
| --- | --- | --- |
| `FEATURE_DISABLED` | 404 | host: `UNCHANGED` / none / `sessions_unavailable` / none |
| `CASE_SESSION_REQUEST_INVALID` | 400 | host: `UNCHANGED` / none / `update_connector` / none |
| `WORK_NOT_FOUND` | 404 | host: `UNCHANGED` / none / none / none. Drop the work id and do not settle it. |
| `WORK_NOT_ELIGIBLE` | 409 | host: `UNCHANGED` / `reclaim` / none / none. The lease was released without an attempt (§7.4). |
| `WORK_LEASE_STALE` | 409 | host: `UNCHANGED` / `reclaim` / none / `cancel` |
| `CASE_CONTROLLED` | 409 | host: `UNCHANGED` / `after_case_resume` / `case_paused` / `cancel` (a3 meaning) |
| `CASE_SESSION_NOT_FOUND` | 404 | host: `UNCHANGED` / none / none / none |
| `CASE_SESSION_ENDED` | 401 | tool_channel: `UNCHANGED` / by reason / by reason / `cancel` |
| `CASE_SESSION_EXPIRED` | 401 | tool_channel: `UNCHANGED` / `mint_again_once` / none / `cancel` |
| `AUTHENTICATION_REQUIRED` | 401 | host: `UNCHANGED` / `refresh_then_retry_once` / none / `cancel` (a3). tool_channel: `UNCHANGED` / none / none / `cancel`; a session token is never refreshed. |
| `ACCESS_TOKEN_EXPIRED` | 401 | host: `UNCHANGED` / `refresh_then_retry_once` / none / `continue` (a3). A running session is not affected. |
| `CREDENTIAL_EXPIRED` | 401 | host: `NEEDS_RECONNECT` / none / `owner_reconnect` / `cancel` (a3) |
| `CREDENTIAL_REVOKED` | 401 | host: `REVOKED` / none / a3's guidance for its reason / `cancel` |
| `AGENT_PAUSED` | 409 | host: `PAUSED` / `after_resume` / `wait_for_resume` / `cancel` (a3) |
| `RATE_LIMITED` | 429 | host: `DEGRADED` / `after_retry_after` / `service_busy` / `continue`. tool_channel: `UNCHANGED` / `after_retry_after` / `service_busy` / `continue`. |
| `AUTH_UNAVAILABLE` | 503 | host: `DEGRADED` / `backoff` / `service_unavailable` / `continue`. tool_channel: the same, with lifecycle `UNCHANGED`. Never an authorization decision (a3). |
| `INTERNAL_SERVER_ERROR` | 500 | host: `DEGRADED` / `backoff` / `service_unavailable` / `continue`. tool_channel: the same, with lifecycle `UNCHANGED`. |

**`CASE_SESSION_ENDED` by reason:**

| `reason` | retry | guidance |
| --- | --- | --- |
| `credential_ended` | none | `check_host_credential` |
| `agent_paused` | `after_resume` | `wait_for_resume` |
| `case_controlled` | `after_case_resume` | `case_paused` |
| `work_ineligible` | `reclaim` | none |
| `work_settled` | none | none |
| `ended_by_host` | none | none |
| `superseded` | `mint_again_once` | none |
| `lease_lost` | `reclaim` | none |

**Retry values**
- `reclaim`: drop this lease, and claim again on the next a4 trigger.
- `mint_again_once`: mint one new session under the same live lease, then start a new turn.
- `after_resume`, `after_case_resume`, `after_retry_after`, `backoff`, `refresh_then_retry_once` and `none` keep their a3 and a4 meanings.

**JSON-RPC codes** (`x-rpc-codes`). `-32602`, with `data.code` set to `TOOL_NOT_IN_SESSION` or `TOOL_ARGUMENTS_INVALID`, and `-32601` for an unknown method. The turn continues after each.

### 13. Compatibility, migration and rollback

**With the flag off, nothing changes except one additive status field:** `caseSessions` shows `available: false`. Every other route, body and token type behaves exactly as today, and a session token is an unknown bearer everywhere.

**With the flag on, existing clients see only additive or status-preserving changes:**
- `caseSessions` appears on agent status;
- settlement errors are coded, with the same HTTP statuses (§7.3);
- a case pause releases leases without using an attempt (§7.4);
- a new event type appears, which clients ignore if unknown (a3 §5).

**Legacy model access is for pre-Phase-C clients only.** Two kinds of model access keep working for connector and adapter releases made before Lane B's first C-B1 release:
- the full access token on `/mcp`;
- the five-minute `mcp_read` tokens (`docs/agent-mcp-remote.md`).

Lane B owns that release list. The server cannot tell releases apart, so the rule binds client code and is shown by evidence. The connector minimum versions and hashes from the Phase C plan's item 7 are set at C-A6 rollout, not here.

A Phase C host never gives a model either credential, and never falls back to one after a session refusal (§10). `mcp_read` stays in v1 and will be retired in a later version, with notice.

**Data**
- **New documents:** session records (`inboxes/{inboxId}/case-sessions/{sessionId}`), their token index (`auth/case-sessions/{sha256}`) and the epoch document (§1). They are documents, not SQL tables, so there is no SQL migration, and PostgreSQL and FileStore behave the same.
- **Retention:** a session record **and its token index** are kept at least 24 h after `expiresAt`, so an ended token keeps reporting its recorded reason (§6.2), then both are deleted. Cleanup records `expired` on any session that nothing else ended, and writes its audit.

**Rollback by flag.**
- Mint and end return `404`.
- Session tokens become unknown bearers at once, so every turn using one fails closed.
- Settlement bodies return to today's shape.
- Leases already released stay released and are offered again as usual.
- Turning the flag back on later moves the epoch (§1), so no earlier session works again.

**Rollback by code** (reverting C-A1). The pre-C-A1 server does not know the `envoi_case_session_` prefix, so it answers `/mcp` with today's `401`. It also stops refreshing `activeUntil`, so redeploying C-A1 with the flag on later moves the epoch too.

**Consumer changes Lane B makes (C-B1).** Informative; Lane B owns the details:
- read `caseSessions` from status;
- mint one session per turn, keep the token in the tool channel only, and end the session when the turn ends;
- renew the lease while the turn runs, and cancel on the §10 signals;
- map the new codes and the coded settlement errors through `code`, and keep display on `message`;
- add `case_session.ended`, `agent.case_session_created` and `agent.case_session_ended` to `WORKSPACE_EVENT_TYPES`;
- remove every path where a model result reaches Envoi through the host's access token.

### 14. Fixtures

**Fixture file fields.**
- Each fixture has `contract`, `version`, `id`, `description` and `kind`. The kind decides what else it carries:
  - `http`: one exchange, as `request` plus `response`;
  - `event`: an `event`;
  - `sequence` and `rollback`: `steps`, each an exchange. A step with `delivered: false` is a response the server committed but the client never received.
- `request.auth` is `none`, `agent_access`, `case_session`, `mcp_read`, `bootstrap` or `human_session`.
- An MCP response gives the HTTP status, and either the JSON-RPC body or, for §6.2 steps 1–5, the a3 envelope.
- The `client` block names the `surface`; `lifecycle`, `retry`, `guidance` and `turn`; `next`; and an optional `modelVisible`.
- `context` gives the stored state the fixture assumes:
  - the permissions **now**, which may be fewer than at mint;
  - the work kind;
  - the session's `allowedTools`;
  - the §6.2 conditions (`ended`), plus any `recordedReason`, `expired` and `turnStartedAt`.

**What `test/contract-fixtures.test.js` checks for this contract**, beyond the shared checks:
- each error matches its `x-codes` row, including `turn`, and for `CASE_SESSION_ENDED` the retry and guidance of its reason;
- every `/mcp` session response is the one §6.2 gives for its context: the recorded reason, else expiry, else the first holding condition in `x-ended-precedence`, else success. A `401 AUTHENTICATION_REQUIRED` appears only with no session context, a session older than the epoch, or the flag off;
- `x-implied-conditions` holds in every context;
- `allowedTools` is exactly the `x-case-tools` rows that the context's permissions and work kind allow, in table order;
- `tools/list` returns exactly the effective set, and a `tools/call` outside it, or carrying a scope field, is refused;
- `expiresAt` is `createdAt` plus `sessionTtlSeconds`;
- every non-`/mcp` route a fixture sends a session token to answers `AUTHENTICATION_REQUIRED`;
- model-visible keys are on the allowlist, equal their sources (`sessionExpiresInSeconds` from `context.turnStartedAt`), and carry no token or id;
- every token is a placeholder;
- the fixtures agree with each other: replays, retries, reclaims and reconnects;
- this table lists exactly the registered fixtures.

| Group | Fixtures |
| --- | --- |
| Mint and use | `session-created`, `session-created-receive-only`, `session-created-human-instruction`, `claimed-human-decision`, `session-created-human-decision`, `session-mcp-initialize`, `session-tools-list`, `session-tool-call`, `agent-status-case-sessions` |
| Authentication and scope | `session-missing-auth`, `session-unknown-token`, `session-token-on-claim`, `session-token-on-renew`, `session-token-on-settlement`, `session-token-on-end`, `session-token-on-status`, `session-token-on-events`, `session-token-on-inbox-route`, `mint-with-session-token`, `mint-with-mcp-read-token`, `mint-with-bootstrap-token`, `session-tool-not-in-session`, `session-permission-removed`, `session-legacy-tool-rejected`, `session-lease-tool-rejected`, `session-scope-override-rejected`, `session-unknown-method` |
| Wrong agent, work, installation, case or counterparty | `mint-unknown-work`, `mint-other-agent-work`, `mint-other-installation-lease`, `mint-case-controlled`, `mint-counterparty-unavailable`, `mint-relationship-blocked`, `mint-instruction-authority-lost`, `mint-permission-removed`, `mint-request-invalid`, `mint-feature-disabled`, `mint-agent-paused`, `mint-access-token-expired`, `mint-rate-limited`, `mint-server-error` |
| Fence, expiry and lease | `mint-lease-superseded`, `mint-lease-expired`, `mint-lease-released`, `mint-lease-settled`, `session-expired`, `session-expired-outranks-later-pause`, `session-ended-lease-lost`, `session-ended-superseded` |
| Invalidation | `session-ended-work-settled`, `session-ended-case-paused`, `session-ended-agent-paused`, `session-ended-agent-revoked`, `session-ended-installation-revoked`, `session-ended-work-ineligible`, `session-ended-by-host`, `session-ended-precedence`, `session-recorded-reason-wins`, `session-end`, `session-end-replayed`, `session-end-expired`, `session-end-not-found`, `event-case-session-ended-case-paused`, `event-case-session-ended-agent-paused` |
| Cancellation and late operations | `late-write-after-pause`, `late-settlement-stale`, `late-settlement-paused`, `pause-does-not-revive-on-resume` |
| Retry and lost responses | `mint-lost-response-retry`, `claim-lost-response`, `rate-limited-mcp` |
| Reclaim and resume | `reclaim-after-agent-resume`, `reclaim-after-case-resume`, `reclaim-after-reconnect` |
| Rollback | `rollback-flag-off`, `reenable-after-rollback` |

### 15. Decisions for review

These are Lane A's proposals. Any of them can change before approval.

1. **One session per lease, minted after the claim.** The claim response does not carry it, so claim stays exactly as a3 defines it.
2. **A new mint supersedes the old session instead of replaying it** (§11). The server never stores a way to return a session token again.
3. **A 900 s absolute cap, with no renewal.** A longer turn ends and starts again from the snapshot. Lane B's real Hermes, OpenClaw and xAI turn times may argue for a different value.
4. **Session tokens work on `/mcp` only.** An `authenticated_rest` host that runs a model still gives it an MCP tool channel. A REST form of the case tools would be a later revision.
5. **The §5 tool table**, in particular `execute_cases` for decide and complete, and the three tools allowed for a human instruction. It is provisional until `case-tools` v1.
6. **Releasing leases without using an attempt** on a case pause and on a `WORK_NOT_ELIGIBLE` mint (§7.4). This is a server behavior change, kept behind the flag.
7. **Starting a case stays host-only in v1.** A model-initiated case start under a session is not defined here.
8. **The sessions epoch** (§1) makes rollback unable to revive a session, at the cost of one small stored document and a 20 s heartbeat.
9. **Approval.** This contract needs a version-specific `CONTRACT-APPROVED case-session v1 @<publication sha>` after Lane B's `CONTRACT-ACK`. The build plan names the human (pjsk02) as the sole approver; the merged Phase C plan names Rachel. The humans settle on board #34 which of them posts it.

### 16. Implementation notes for C-A1 (Lane A; informative)

- **Telling released from expired.** Every path that releases a lease without an attempt sets `reofferWithoutAttempt: true` and `releasedAt`. That covers agent pause (which today writes only `pausedAt`), reconnect, installation revoke, case pause and a `WORK_NOT_ELIGIBLE` mint. `WORK_LEASE_STALE` reports `released` when `reofferWithoutAttempt` is set, `settled` when the status is `completed` or `failed` or the claim carries a `failure`, and otherwise `expired`.
- **Recording an end eagerly.** Each action that ends a session lists that work's live session, or the case's live sessions, inside its own transaction, skipping sessions past `expiresAt` (those get `expired`). A lookup from `workId` or `caseId` to its live session ids avoids scanning every session.
- **Running tools.** Case tools call the case, policy and asset services directly, under the settlement lock set (`withInboxMutation` with the case's inboxes and `caseMutationKey`). They never call `callRest`.

## case-tools v1

**Contract:** `case-tools`, version 1 (Phase C task **C-A0**, the second of three). **Status:**
- **Revision 1:** published on 2026-10-17 at `cb5f6fe` (board #34), with Lane B's ACK limited to that SHA.
- **Revision 2:** published in the same PR. Lane B's ACK was withheld until the `human_decision` host fixtures were reviewed (case-session §3.1) and was given for revisions 1–3 in board #34 comment 6240990960.
- **Revision 3:** published in the same PR.
- **Earlier revisions changed here:** revisions 2 and 3 regenerated revision 1's fixtures, so Lane B's revision 1 ACK covers `cb5f6fe` only. The changes are:
  - `allowedActions` follows the state rules;
  - `authority.lastPolicyDecision` gained `authorityRef`, `humanApproval` and `optionRef`;
  - JSON-RPC ids were renumbered.

  Revision 3 also made `action` required in revision 2's `authorityResult`, and moved revision 2's human request off the shared case state (§12.3).
- **Approval:** approved. Lane B posted `CONTRACT-ACK case-tools v1 revisions 1–3 @15fff09` (board #34 comment 6240990960), and the human posted `CONTRACT-APPROVED case-tools v1 @15fff09` covering all nine tools and the case-session amendment (comment 6257953866). At publication nothing here was implemented or on by default; C-A2 to C-A4 did the server work and C-B2 to C-B4 the client work, recorded in the board's `INTEGRATED` comments.

**Revision 1 covers:**
- the rules that every case tool shares (§1–§5);
- **`envoi_case_snapshot`** (§6);
- **`envoi_case_reply`** (§7).

That is enough to unblock C-B2.

**Revision 2 (§12)** adds negotiation and authority: `envoi_authority_check`, `envoi_request_human`, `envoi_case_propose` and `envoi_case_decide`. That unblocks C-B3. **Revision 3** will add `envoi_case_list_assets`, `envoi_case_share_asset` and `envoi_case_complete`, which unblock C-B4. Both are revisions of v1 before approval, so v1 is approved once, with all nine tools.

**Fixtures:** [`test/contract-fixtures/case-tools/`](../../../test/contract-fixtures/case-tools/). It holds:
- `schemas.json`: draft-07 schemas plus the machine-readable tables `x-tools`, `x-tool-errors`, `x-limits`, `x-ref-kinds`, `x-untrusted-fields`, `x-event-projection` and `x-status-projection`;
- one JSON file per case.

**Owner:** Lane A. **Consumer:** Lane B, namely the typed SDK and tool client, the local MCP relay, the Hermes, OpenClaw and xAI/Grok adapters, and the owner UI.

**Name.** Phase C planning called this contract `case-tools-v1`. Its canonical id is `case-tools`, version 1.

**It builds on these contracts:**
- **`case-session` v1:**
  - every case tool is reached only with a usable case session on `POST /mcp`;
  - the session supplies the case, the counterparty and the allowed tools (case-session §3, §5);
  - session errors are HTTP-level `401`s (§6.2);
  - tools run in-process, under the settlement lock set (§6.3);
  - results obey the model-visibility rule (§4).
- **`a3-pause-auth` v3:** held messages and the D1 barrier.
- **`agent-registration` v1:** model visibility.

### 1. Calling a tool

A tool call is an MCP `tools/call` on `POST /mcp`, sent with the session token (case-session §6.1):

```json
{ "jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": { "name": "envoi_case_reply", "arguments": { "text": "…", "idempotencyKey": "reply-1" } } }
```

**Arguments:**
- Each tool's `inputSchema` is `x-tools[].inputSchema`, and `tools/list` returns it verbatim. It has `additionalProperties: false`.
- No property in any input schema is in case-session's `x-scope-fields`.
- Arguments that fail the schema get JSON-RPC `-32602` with `data.code: "TOOL_ARGUMENTS_INVALID"`, and nothing runs.

**Session errors.** Every session failure is the HTTP-level `401` from case-session §6.2, never a tool result. That covers an unknown, ended or expired session, and a write rejected inside its transaction.

**Which tools exist.** A server lists and allows only the tools it implements. Before a tool's revision ships, the tool is absent from `tools/list` and from `allowedActions`, and calling it gets `-32602` `TOOL_NOT_IN_SESSION`. This narrows case-session §6.4's effective set (clarified there).

### 2. Results

**Shape.** Every result, success or failure, is a single JSON text item:

```json
{ "content": [{ "type": "text", "text": "<one JSON document>" }], "isError": false }
```

| `isError` | Document | Schema |
| --- | --- | --- |
| `false` | `{ "ok": true, "tool": "<name>", "result": { … } }` | the tool's result definition (`x-tools[].resultSchema`) |
| `true` | `{ "ok": false, "tool": "<name>", "code": "<code>", "message": "…", "retryable": <bool> }` | `toolErrorEnvelope` |

**Tool errors.** A tool error is part of the model's context.
- Its `message` is fixed per code. It never names an id or a token, and never reveals whether some other case, agent or message exists.
- The model branches on `code`. The host treats a tool error as an outcome and never retries the call with a stronger credential (case-session §10).

**Tool error codes** (`x-tool-errors`):

| Code | `retryable` | Meaning |
| --- | --- | --- |
| `REF_NOT_FOUND` | false | A reference argument does not name an object in this session's case (§4). The message is identical whether or not the reference exists elsewhere. |
| `IDEMPOTENCY_CONFLICT` | false | This `idempotencyKey` was already used, for this work and tool, with different arguments (§3). |
| `NOT_SUPPORTED_FOR_WORK` | false | An argument this work kind does not allow (§7.1). |
| `CURSOR_INVALID` | false | A paging cursor is malformed, expired, or from another case or agent (§6.3). |
| `TOOL_BUSY` | true | The write could not take its locks within `x-limits.lockWaitMaxMs` (5 s), or the case's participants changed while it was acquiring them. Nothing was committed. Retry the identical call with backoff. Today's lock waits without limit, so C-A2 adds the bounded wait. |

`x-tool-errors[].clientRetry` gives the client's next step for each code: `none` or `backoff`.

**Other failures.** Any other server fault is an HTTP `500 INTERNAL_SERVER_ERROR`, as in case-session §12, because only a fault before commit can promise that nothing was written. Rate limits stay HTTP `429`.

**Size.** No result document exceeds `x-limits.resultMaxBytes` (64 KiB) of UTF-8 JSON (§6.4).

### 3. Idempotency

Every tool that writes takes a required `idempotencyKey`: 1–128 characters matching `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`. Its scope is **the agent, the work and the tool** (case-session §11), never the session or the fence.

**Order of checks.** A write checks in this order:
1. the arguments, against the schema (`-32602`);
2. the references (`REF_NOT_FOUND`);
3. the work-kind rules (`NOT_SUPPORTED_FOR_WORK`);
4. the idempotency record.

**Same arguments.** Two calls have the same arguments when the canonical JSON of every argument other than `idempotencyKey` matches. The comparison happens after defaults are filled in and references are resolved. For example, `intent` omitted equals `"message"`, and `inReplyTo` omitted equals the work's own reference.

| Same scope and key | Outcome |
| --- | --- |
| The same arguments, under any usable session for the same work | `ok: true` with the **original** result and `replayed: true`. Nothing is written. |
| Different arguments | `IDEMPOTENCY_CONFLICT`. Nothing is written. |
| A key never used in this scope | The call runs. The effect and its idempotency record commit in one transaction. |

**Recovering from a lost response.** Repeat the identical call with the same key. That works under the same session, or under a later session for the same work after a reclaim.

**Collisions across turns.** A new inbound message is new work, so `reply-1` from an earlier turn never collides with it.

**Keys the model uses.** The host's turn instruction asks the model for short keys that are distinct within the turn, for example `reply-1`. A host that replays a turn reuses the same keys.

`envoi_case_snapshot` only reads, so it takes no key.

### 4. References

Models never see internal ids (case-session §4). Every object that a tool result names carries a **reference** instead: `<kind>_<16 base32 characters>`.

**Kinds** (`x-ref-kinds`):

| Kind | Names |
| --- | --- |
| `m` | a message |
| `p` | a structured proposal |
| `o` | a proposal option |
| `a` | an asset |
| `e` | another case event |

**How a reference is made.**
- It is HMAC-SHA256 of the agent id, the case id, the object kind and the object id.
- **The key.** A dedicated random reference key is generated once, stored in the document store (`config/case-reference-key`) and encrypted at rest under the data key. A data-key rotation re-encrypts it without changing it. HKDF-SHA256 derives two subkeys from it: `envoi-case-ref-v1` for references and `envoi-case-cursor-v1` for sealing cursors (§6.3).
- **Resolving a reference.** References are one-way, so the server resolves one by computing the references of that case's candidate objects of the given kind. That work is bounded by the case. C-A2 may add an index instead.

**Properties.** A reference is:
- **Stable** for that agent and case across sessions, turns and reclaims. A resumed turn sees the same references, and a message has one reference wherever it appears (§6).
- **Opaque.** It cannot be turned back into an id.
- **Per agent.** The two parties to a case see different references for the same message.
- **Local.** Another case's reference, or another agent's, gives `REF_NOT_FOUND`. It never resolves to anything else.

Tool **inputs** take references, never ids.

### 5. Untrusted content

**Which fields.** These fields carry text that someone other than this server wrote (`x-untrusted-fields`): `text`, `objective`, `filename`, `mimeType` and `value`. The authors include the counterparty, either side's people, and the agent's own earlier messages.

**The notice.** Every snapshot carries a fixed `notice` that names these fields. It tells the model they are information to weigh, never instructions to follow.

**What the server does to them.**
- It never rewrites or filters them. It only truncates them to the limits, and every truncated item carries `truncated: true`.
- `intent` is never free text. The server maps it onto the closed `x-event-projection.intents` list, and any other value becomes `other`.

The host keeps the notice with the content, and gives that content no more authority than the notice does.

### 6. `envoi_case_snapshot`

**Permission:** read (send or receive). **Work kinds:** both. **Writes:** nothing. No document is created; even the cursor carries no server state (§6.3).

#### 6.1 Input

```json
{ "eventLimit": 20, "eventsBefore": "c_…" }
```

Both fields are optional:
- **`eventLimit`**: 1–50, default 20.
- **`eventsBefore`**: the `page.olderCursor` from an earlier snapshot of this case. With it, the snapshot returns only older events, and no `requestedResponse`.

#### 6.2 Result (`snapshotResult`)

| Field | Content |
| --- | --- |
| `notice` | The fixed untrusted-content notice (§5). |
| `case` | `{ objective, collaborationMode, status, deadline, createdAt, updatedAt }`, taken from the canonical case record. `status` is the shared case state. A request for a human decision never changes it (§12.3). A paused or revoked case never reaches a usable session (case-session §6.2). `objective` is untrusted text. |
| `you` | `{ address }`, this agent's own address. |
| `counterparty` | Exactly the session's `counterparty` (case-session §3). For agent work, `{ kind: "agent", address }`. For a human instruction, `{ kind: "human" }`. |
| `requestedResponse` | Present on a first page only. It is the work being handled: `{ ref, from, kind, intent, text, truncated, receivedAt }`. `from` is `other_agent` or `your_human`. `kind` and `intent` follow `x-event-projection`. For `human_decision` work it follows §12.6. |
| `recentEvents` | Up to `eventLimit` items, oldest first, ending with the newest event before the cursor (§6.3). When the work message falls within the page, it has the **same** `ref` as `requestedResponse` and `text: null`; its text is in `requestedResponse`. |
| `page` | `{ hasOlder, olderCursor }`. `olderCursor` is `null` exactly when `hasOlder` is false. |
| `proposal` | The case's current proposal, or `null`, as `{ ref, kind, status, lastActor, options, expiresAt }`. It is the newest proposal that a typed `offer` message created (`proposal_<messageId>`, kind `negotiation`) whose status is `open` or `countered`. Proposals made through the case API are not shown in v1 (§12.1). `options` lists **live** options only (`expired: false`), at most 10, newest first. A counter expires every earlier option, so only the counter's options stay. Each option is `{ ref, value, truncated }`. `lastActor` is `you` or `other_agent`: the actor of the newest case event whose `payload.proposalId` is this proposal. An accepted proposal is no longer current. |
| `authority` | `{ pendingHumanDecision, lastPolicyDecision }`. `pendingHumanDecision` is true exactly while this agent has an open `envoi_request_human` request (§12.3). `lastPolicyDecision` is that evaluation, or `null`, as `{ authorityRef, action, decision, humanApproval, optionRef, expiresAt }`. `action` is the stored `requestedAction` when it matches `^[a-z][a-zA-Z_.]{0,63}$`, and `other` otherwise. `humanApproval` is `not_required`, `pending` or `approved` (§12.2). `optionRef` is the bound option, or `null`. A resumed turn uses `authorityRef` to accept (§12.6). |
| `allowedActions` | The tool names usable now, in `x-tools` order: the session's effective set (case-session §6.4), limited to the tools this server implements (§1) and then by the state rules in §12.1 (`x-state-rules`). Clients treat it as a subset of the effective set, never the whole of it. |
| `assets` | Up to 10 assets in this case that this agent created or was granted, newest first: `{ ref, filename, mimeType, size, scan, origin, shared }` (`x-status-projection.scan`). `origin` is `you` or `other_agent`. `shared` means the other side holds a grant. There is never a URL or any file bytes. `assetsHasMore` says whether more exist. |
| `limits` | Echoes the byte limits in `x-limits`. |

**Only this agent's own records.** Every source is a record that this agent's inbox already holds or was granted.
- Timeline messages come only from this agent's own inbox messages in the session's case.
- Case events of type `message` are **never** projected. A shared case record also holds the other side's owner instructions as message events, so projecting them would leak those instructions.
- Nothing comes from the other side's private state: its people, their approvals or actions, its other cases, or its held items. Human actions are projected only when the actor is `your_human`.

#### 6.3 Events and paging (`x-event-projection`)

**Sources:**
- **Messages:** this agent's own inbox messages in the case, in both directions, including human instructions and instruction replies.
- **Case events:** only those of type `humanAction` whose actor is `your_human`, `stateChange` and `receipt`. Proposal state is shown in `proposal`. Policy evaluations, tool actions, errors and message events are never projected.

**`kind` for a message.**
1. The record kind comes first (`x-event-projection.messageKinds`): `humanInstruction` → `instruction`, `humanInstructionReply` → `instruction_reply`.
2. Otherwise, the native type the case recorded for that message (`payload.messageType`) maps through `x-event-projection.nativeTypes`: `request` or `message` → `message`; `proposal`, `counterproposal`, `decision` and `completion` keep their names.
3. Anything else → `message`.

| Source | `kind` | `intent` | `text` |
| --- | --- | --- | --- |
| Agent message | as above | the protocol intent, mapped onto `x-event-projection.intents`; anything else becomes `other` | message text |
| Human instruction | `instruction` | `null` | instruction text |
| Instruction reply | `instruction_reply` | `null` | reply text |
| `humanAction` event (`your_human` only) | `human_action` | the stored action key: one of `approveOnce`, `decline`, `editProposal`, `pause`, `resume`, `revoke` or `takeOver` | `null` |
| `stateChange` event | `state_change` | the new case state. Any case state can appear here, including `paused` and `revoked` from an earlier pause. | `null` |
| `receipt` event | `receipt` | `null` | the receipt `result` |

**Time fields.** `at` is the source record's `createdAt`. `requestedResponse.receivedAt` is the work message's `deliveredAt`.

**Actors:**
- `you`: this agent.
- `other_agent`: the other agent in the case.
- `your_human`: a person in this agent's workspace.
- `system`: everything else.

People outside this workspace never appear. People and agents never appear by name, id or email, except the two agent addresses in `you` and `counterparty`.

**`deliveryStatus`.** Only `actor: you` messages carry one, mapped through `x-status-projection.delivery`:

| Stored status | `deliveryStatus` |
| --- | --- |
| `queued`, `held`, `retrying`, `pendingContactApproval` | `queued` |
| `delivered` | `delivered` |
| `acknowledged` | `acknowledged` |
| `processed` | `processed` |
| `failed`, `deadLettered`, `declined` | `failed` |
| `cancelled` | `cancelled` |

Every other item carries `null`. Because `held` maps to `queued`, a snapshot never shows that either side paused (a3 §3).

**Order.** Items are ordered by `createdAt`, with ties broken by object id. This is the same order today's message store pages in (`listMessages`), so paging needs no new index.

**Paging.**
- A first page holds the newest `eventLimit` items.
- `olderCursor` is an opaque `c_` token of up to 512 characters, AES-GCM sealed under the cursor subkey (§4). It holds the agent id, case id, oldest returned item's `createdAt` and object id, and an expiry 24 h ahead (`x-limits.cursorTtlSeconds`). It needs no stored document.
- An older page holds the next older items.
- A cursor that is malformed, expired, or sealed for another case or agent gets `CURSOR_INVALID`.

#### 6.4 Size bounds

Byte limits count the **UTF-8 bytes of the value as serialized in the result JSON**, escaping included. Truncation always ends on a code-point boundary, so a cut text may end up to 3 bytes under its limit. All values are in `x-limits`.

| Item | Bound |
| --- | --- |
| Whole result | 64 KiB |
| `requestedResponse.text` | 12 KiB |
| Each event's `text` | 4 KiB |
| `case.objective` | 500 characters (the stored limit), at most 2,000 bytes |
| Proposal options | 10 live options. Each `value` is at most 1 KiB of JSON; a larger one becomes `null` with `truncated: true`. |
| Assets | 10, then `assetsHasMore`. Each `filename` is at most 255 bytes and each `mimeType` at most 128 bytes. |

**Fixed sections.** These sections are never dropped: `notice`, `case`, `you`, `counterparty`, `requestedResponse`, `proposal`, `authority`, `allowedActions`, `assets`, `page` and `limits`. Together they stay within `x-limits.fixedSectionsMaxBytes` (40 KiB). Their worst case at the limits above is about 34 KiB:

| Section | Worst case |
| --- | --- |
| `requestedResponse` | 12.3 KiB |
| `proposal` | 10.8 KiB |
| `assets` | 5.3 KiB |
| `case` | 2.3 KiB |
| `page` (with a cursor) | 0.6 KiB |
| everything else | 1.5 KiB or less |

That leaves at least 24 KiB for `recentEvents`.

**When events don't fit.** The server drops the oldest events until the result fits, and sets `page.hasOlder` and `olderCursor` so those events can be paged. It never drops a fixed section.

#### 6.5 Checks

The read follows case-session §6.3: it loads its data, then re-runs the session checks before it returns anything. Reads are not audited per call in v1.

### 7. `envoi_case_reply`

**Permission:** `send_agent_messages`. **Work kinds:** both. **Writes:** one message.

#### 7.1 Input

```json
{ "text": "…", "idempotencyKey": "reply-1", "intent": "message", "inReplyTo": "m_…" }
```

| Field | Rule |
| --- | --- |
| `text` | Required, 1–8,000 characters (`x-limits.replyTextMaxChars`). |
| `idempotencyKey` | Required (§3). |
| `intent` | Optional: `message` (default), `clarify` or `status`. Offers, counteroffers, acceptance, rejection and completion belong to revision 2's tools and are never replies. **Human instruction:** only `message`. Any other value gets `NOT_SUPPORTED_FOR_WORK`, because an instruction reply record has no intent. |
| `inReplyTo` | Optional. A message reference in this case; the default is the work's own message (`requestedResponse.ref`). **Agent work:** it must name an agent message (`kind` `message`, `proposal`, `counterproposal`, `decision` or `completion`). An instruction or instruction reply gets `NOT_SUPPORTED_FOR_WORK`, because it would become the outgoing message's `causationId` and reveal a private message's id to the counterparty. **Human instruction:** only the work's own reference. Any other in-case reference gets `NOT_SUPPORTED_FOR_WORK`, because an instruction reply always answers its instruction. |

There is **no** recipient field and no case field. The recipient is the session's counterparty and the case is the session's case (case-session §6.3).

#### 7.2 Effect

**Agent work.** The tool sends one native message from this agent to the counterparty agent, in the session's case. It is the record that today's `POST /api/inboxes/{inboxId}/messages` creates, with the same delivery, ordering and D1 barrier:
- `type` is `message`;
- `intent` is the input intent;
- `causationId` is the `inReplyTo` message.

The counterparty can always act at this point. A sender that cannot act ends the session first (case-session §3, `counterparty_unavailable`). So a reply never waits on the counterparty's own pause. A hold that does happen, for example a contact approval, reads as `queued` (§6.3).

**Human instruction.** The tool sends one instruction reply to the person who sent the instruction. It is the record that today's `POST /api/agent/instructions/{workId}/reply` creates: delivered at once, in the instruction's case, with `inReplyTo` set to the instruction.

**For both kinds:**
- The message, its idempotency record, the case update and the audit commit in one transaction, and the session checks run inside it (case-session §6.3).
- The message id is derived from the §3 scope, so a replay can never create a second message.
- A reply does **not** settle the work. The host still completes or fails it (case-session §7).

#### 7.3 Result (`replyResult`)

```json
{ "ok": true, "tool": "envoi_case_reply", "result": { "messageRef": "m_…", "status": "queued", "recipient": { "kind": "agent", "address": "partner@envoi.mail" }, "inReplyTo": "m_…", "createdAt": "…", "replayed": false } }
```

| Field | Value |
| --- | --- |
| `status` | `queued` for agent work, which includes a pending contact approval. `delivered` for an instruction reply. It is the status at commit; the next snapshot's `deliveryStatus` shows later progress. |
| `recipient` | The session's counterparty, in the same shape as the snapshot. |
| `replayed` | `true` only when §3 returned an earlier result. |

#### 7.4 Errors

| Situation | Response |
| --- | --- |
| `text` missing or too long, an unknown field, or a scope field | `-32602` `TOOL_ARGUMENTS_INVALID` |
| The session lacks `envoi_case_reply`, for example a receive-only agent | `-32602` `TOOL_NOT_IN_SESSION` (case-session §6.4) |
| `inReplyTo` is not a message reference in this case | tool error `REF_NOT_FOUND` |
| A human instruction with a non-default `intent` or `inReplyTo`, or agent work replying to an instruction | tool error `NOT_SUPPORTED_FOR_WORK` |
| The key was already used with other arguments | tool error `IDEMPOTENCY_CONFLICT` |
| The write could not take its locks | tool error `TOOL_BUSY`; retry the identical call with backoff |
| The case is closed: `completed`, `failed` or `expired` (§14.1) | tool error `CASE_CLOSED` |
| The session ended or expired, either before the call or inside the write | HTTP `401 CASE_SESSION_ENDED` or `CASE_SESSION_EXPIRED` (case-session §6.2). Nothing is written. |
| Any other server fault | HTTP `500` (§2) |

#### 7.5 Events and audit

**Events.** The message produces exactly the events today's send produces:
- agent work: `message.queued`, then `message.delivered` and the delivery receipts;
- an instruction: `agent.instruction_replied`.

**New owner audit.** `agent.case_tool_used`, with `agentId`, `installationId`, `sessionId`, `workId`, `caseId`, `tool` and `messageId`. It is written once per effect, never for a replay, and needs a paired Lane B `WORKSPACE_EVENT_TYPES` entry.

### 8. Isolation

Two sessions of the same agent, for two cases with the same counterparty, each see only their own case:
- snapshot events, references, proposals and assets come only from that session's case;
- a reference from one case gives `REF_NOT_FOUND` in the other;
- a reply is delivered in its own case only;
- the same key in both cases is two different messages, because the scope is the work.

Fixture `two-cases-same-counterparty` pins this. A second owner's agent never appears in a snapshot, except as the counterparty of its own case.

### 9. Compatibility

**No new flag.** The case tools exist only behind `ENVOI_CASE_SESSIONS_V1` and a usable session.

**Legacy MCP tools are unchanged.** `envoi_read_case`, `envoi_list_messages`, `envoi_send_message` and the others keep working with access tokens and `mcp_read` tokens, and they are never in a session (case-session §5, §13).

**Clarification to case-session §6.4.** It now says that `tools/list`, the effective set and a newly minted session's `allowedTools` include only tools the server implements. The case-session fixtures model a server that implements all nine tools. Hosts tell the model which tools it has from `tools/list` or the snapshot's `allowedActions`.

**Case-session addition (§12.6).** case-session v1 gains the work kind `human_decision`; see its §2, §3 and §5.

**Consumer changes Lane B makes (C-B2).** Informative; Lane B owns the details:
- a typed client for the two tools;
- start every turn with a snapshot, not stitched history;
- keep simultaneous cases in separate sessions and separate contexts;
- add `agent.case_tool_used` to `WORKSPACE_EVENT_TYPES`;
- never fall back to a legacy tool after a refusal.

### 10. Fixtures

**Fields.** Each fixture has `contract`, `version`, `id`, `kind` and `description`, followed by either `context`, `request`, `response` and `client`, or `steps`.
- **`context`** names the session that a call runs under: `sessionRef`, `caseRef`, `workKind` and `allowedTools` (the session's effective set). These are fixture-only names that tie fixtures together.
- **`response.toolResult`** names the definition that the parsed JSON text must match.

**What `test/contract-fixtures.test.js` checks:**
- **Result shape.** Every result's JSON text is checked against its schema, and `ok` against `isError`. Tool error codes, messages, `retryable` and the client's retry are checked against `x-tool-errors`.
- **Arguments.** Arguments are checked against the tool's own `inputSchema`. `TOOL_NOT_IN_SESSION` must appear exactly when a tool is outside the session or not implemented. `tools/list` must return the implemented effective set verbatim.
- **References.** Every reference matches the reference pattern.
- **Leaks.** No result carries a token. Outside `x-untrusted-fields`, no result carries an internal id, a URL, or an email address other than `you.address` and the counterparty's.
- **Snapshot.** Byte bounds, and that a truncated text ends within 3 bytes of its limit. The fixed-sections budget. Events are ordered oldest first. When the work message is in the page, it shares the work message's reference and has no text. Your own messages carry a `deliveryStatus`, and nobody else's do. `allowedActions` equals the effective set limited to the implemented tools.
- **Consistency with case-session.** `x-tools` names, order, `needs` and `workKinds` equal case-session's `x-case-tools`, and no input property is a scope field.
- **Replays and conflicts.** A replay returns the original result. A conflicting reuse writes nothing: the original call still replays unchanged afterwards. A reply's default `inReplyTo` is the snapshot's `requestedResponse.ref`.
- **Isolation.** The two-case fixture shares no reference.
- **Registry.** This table lists exactly the registered fixtures.

| Group | Fixtures |
| --- | --- |
| Snapshot and tool list | `snapshot-agent-work`, `snapshot-human-instruction`, `snapshot-older-page`, `snapshot-truncated`, `snapshot-untrusted-content`, `snapshot-cursor-invalid`, `snapshot-unknown-argument`, `tools-list` |
| Reply | `reply-agent-work`, `reply-human-instruction`, `reply-clarify`, `reply-replayed`, `reply-lost-response`, `reply-replayed-after-reclaim`, `reply-idempotency-conflict`, `reply-ref-not-found`, `reply-in-reply-to-instruction-refused`, `reply-instruction-intent-not-supported`, `reply-not-in-session`, `reply-recipient-override-rejected`, `reply-intent-not-allowed`, `reply-session-ended-in-write`, `reply-tool-busy` |
| Isolation and audit | `two-cases-same-counterparty`, `event-case-tool-used` |

### 11. Revision plan

| Revision | Tools | Unblocks | Status |
| --- | --- | --- | --- |
| 1 | `envoi_case_snapshot`, `envoi_case_reply` (§6, §7) | C-B2 | published @`cb5f6fe` |
| 2 | `envoi_authority_check`, `envoi_request_human`, `envoi_case_propose`, `envoi_case_decide` (§12) | C-B3 | published; host fixtures added at `99cde94` |
| 3 | `envoi_case_list_assets`, `envoi_case_share_asset`, `envoi_case_complete` (§14) | C-B4 | published in this PR |

Each revision is additive within v1 and is published before approval, so a client built against one revision keeps working on the next. `tools/list` and `allowedActions` show only the tools a server implements (§1).

### 12. Revision 2: negotiation and authority

**Scope.** Revision 2 adds four tools: `envoi_authority_check`, `envoi_request_human`, `envoi_case_propose` and `envoi_case_decide`. Together they unblock C-B3. Revision 3 will add `envoi_case_list_assets`, `envoi_case_share_asset` and `envoi_case_complete` for C-B4.

Each revision 2 tool:
- follows §1–§5;
- writes, so takes an `idempotencyKey` (§3);
- applies to agent work and to `human_decision` work (§12.6), never to a human instruction.

**New references** (`x-ref-kinds`):

| Kind | Names |
| --- | --- |
| `g` | a server-issued authority (a policy evaluation) |
| `q` | a request for a human decision |

**What already exists.** Each tool runs today's services in-process, under the settlement lock set (case-session §6.3):

| Area | Today's service |
| --- | --- |
| Authority | `evaluateServerPolicy`, `validatedPolicyBinding` |
| Accept | `acceptProposal` |
| Counter | `counterProposal` |
| Native messages | today's native send and `advanceNativeCase` |
| Human request and approval | `applyAgentAction`, `approveOnce` |

**What is new in C-A3:**
- the accept policy rule (§12.2);
- the case-state changes (§12.3);
- request expiry (§12.3);
- the `human_decision` work kind (§12.6);
- rejection withdrawing a proposal (§12.5);
- the accept-message rule (§12.5).

#### 12.1 When each tool appears in `allowedActions`

Revision 2 narrows `allowedActions` (§6.2) by case state (`x-state-rules`). A tool appears only when it is in the effective set and its rule holds now. The test derives `allowedActions` from the snapshot fields with exactly these rules.

| Tool | Appears when |
| --- | --- |
| `envoi_case_snapshot`, `envoi_case_reply` | always |
| `envoi_case_propose` | `proposal` is `null` |
| `envoi_authority_check`, `envoi_case_decide` | `proposal` is not `null` and `proposal.lastActor` is `other_agent` (it awaits this agent's answer) |
| `envoi_request_human` | `authority.lastPolicyDecision.decision` is `needsHuman`, its `humanApproval` is `pending`, and `authority.pendingHumanDecision` is false (nothing is requested yet) |

A tool in the session whose rule does not hold answers with a tool error that names the reason: `PROPOSAL_EXISTS`, `PROPOSAL_NOT_AWAITING` or `AUTHORITY_NOT_PENDING`. It never answers `TOOL_NOT_IN_SESSION`.

**Which proposals.** The proposal tools act only on proposals that a native message created (`proposal_<messageId>`). That is also the only kind §6.2's `proposal` shows. Proposals made through the case API stay out of v1's tools.

#### 12.2 `envoi_authority_check`

**Permission:** `execute_cases`. **What it does:** asks the server whether this agent may accept a specific live option now. It writes one policy evaluation.

```json
{ "action": "accept_proposal", "proposalRef": "p_…", "optionRef": "o_…", "idempotencyKey": "authority-1" }
```

**Input**
- **`action`:** `accept_proposal` is the only value in v1. Later actions are additive enum values.
- **`optionRef`:** must be a live option of the current proposal. Otherwise the result is `OPTION_NOT_LIVE`. A reference that resolves to nothing gives `REF_NOT_FOUND`.

**Effect.** One policy evaluation, as today's `POST …/cases/{caseId}/policy-evaluations` creates it:
- `requestedAction` is **`proposal.accept`**;
- `actionPayload` is `{ proposalId, optionId }`;
- the binding covers the digest of all the case's proposals, the option, the agent and the case.

The tool skips that route's own permission and acting-agent checks, which the session and §12.1 replace.

**New in C-A3: the accept rule.** Today `proposal.accept` is a safe internal action and always returns `allow`. C-A3 makes it policy-controlled:

| Situation | Decision |
| --- | --- |
| The workspace policy's `agreements.requireHumanApproval` is true. **This is the proposed default**, and decision 10 asks whether it is right. | `needsHuman` |
| That setting is false | `allow` |
| The agent lacks `execute_cases` | `deny` |

**TTLs.** A `needsHuman` evaluation lives `x-limits.humanDecisionTtlSeconds` (24 h). Any other evaluation keeps today's TTL.

**Result (`authorityResult`)**
- `authorityRef` (`g_…`).
- `decision`: `allow`, `deny` or `needsHuman`.
- `humanApproval`: `not_required` for `allow` or `deny`. For `needsHuman` it starts `pending` and becomes `approved` once a person approves.
- `expiresAt`.
- `proposalRef` and `optionRef`: the binding.
- `replayed`.

**Lifetime of an authority**
- **One-time:** a successful accept consumes it (§12.5).
- **When it stops applying:**
  - **any change to the case's proposals**, such as a counter, a reject or a new offer, because the digest covers all of them;
  - the option is no longer live;
  - the workspace policy changes after the approval, which `validatedPolicyBinding` detects.
- **A new key** gives a fresh evaluation. **The same key** replays the original (§3).

#### 12.3 `envoi_request_human`

**Permission:** `execute_cases`. **What it does:** asks a person in this agent's workspace to approve a `needsHuman` authority.

```json
{ "authorityRef": "g_…", "question": "Accept 26 Oct 10:00–13:00 at 4.10/unit?", "idempotencyKey": "ask-1" }
```

**Input**
- `question`: 1–2,000 characters. It is shown to the person as the agent's own words.
- The authority must be `needsHuman`, undecided and unexpired:
  - otherwise `AUTHORITY_NOT_PENDING`;
  - if it is expired, `AUTHORITY_EXPIRED`.

**Effect.** One transaction does all of the following:
- records an open request for **this agent** (`requestHumanDecision`, with the evaluation's id). The shared case state does **not** change. **New in C-A3:** today's `needsApproval` outcome moves the shared case to `waitingForHuman`, which would block or reveal the request to the counterparty;
- writes owner audit `case.human_decision_requested`, with `caseId`, `agentId`, `requestId`, `policyEvaluationId` and the question.

The owner UI shows the request and the question. The counterparty never sees them.

**Result (`humanRequestResult`):** `{ requestRef: "q_…", status: "pending", authorityRef, endTurn: true, replayed }`.
- `endTurn: true` with client `turn: end` means: end the turn now, then settle the work (case-session §7).
- The agent never waits for a person inside a turn.

**How the request resolves** (new in C-A3). Each outcome closes the open request and writes `human_decision` work for the agent (§12.6). `approveOnce` and `decline` check the open request instead of a `waitingForHuman` case state.
- For an accept evaluation, an approval leaves the case state as it is. The accept itself later moves the case to `authorized`.
- For a `case.complete` evaluation, an approval moves the case to `authorized`, as today (§14.4).
- A decline never revokes the case.

| Outcome | Person's action | Authority | `human_decision` intent |
| --- | --- | --- | --- |
| Approve | `approveOnce` with `externalRefs.policyEvaluationId` | `approved` | `approveOnce` |
| Decline | `decline` naming the same evaluation | stays unapproved | `decline` |
| Expire | none: the request passes the evaluation's `expiresAt` | ends with the request | `expired` |

- **Decline.** It no longer revokes the case. The case is shared, so a revoke would end the counterparty's work too.
- **Expiry.** C-A3's cleanup handles it.
- **A case that closes while a request is open** (§14.1): the request resolves as `expired`, and no `human_decision` work is written for the closed case.

**Visibility.** `pendingHumanDecision` (§6.2) is true only while **this agent** has an open request. The shared case state never changes for a request, so the counterparty neither learns of it nor is blocked by it.

#### 12.4 `envoi_case_propose`

**Permission:** `send_agent_messages`. **When:** only with no current proposal (§12.1).

```json
{ "text": "We can deliver on 26 Oct, 10:00–13:00.", "terms": { "date": "2026-10-26", "window": "10:00-13:00" }, "idempotencyKey": "offer-1" }
```

**Input**
- `text`: 1–8,000 characters.
- `terms`: a JSON object with 1–32 properties, at most 1 KiB serialized. It becomes the proposal's single option.

**Effect.** One native message to the counterparty: type `proposal`, intent `offer`, `payload.proposal = terms`. It is sent like today's send (§7.2), including the D1 barrier. Today's `advanceNativeCase` then creates `proposal_<messageId>`: kind `negotiation`, status `open`, one option.

**Result (`proposeResult`):** `{ messageRef, proposalRef, optionRef, status: "queued", recipient, replayed }`.

**Errors**
- `PROPOSAL_EXISTS` when a proposal is current, whoever made it. v1 has no withdraw tool. To replace your own offer, reply and wait for the counterparty's answer.

#### 12.5 `envoi_case_decide`

**Permission:** `execute_cases`. **When:** only while the current proposal awaits this agent's answer (§12.1).

```json
{ "proposalRef": "p_…", "decision": "accept", "optionRef": "o_…", "authorityRef": "g_…", "text": "Agreed: 26 Oct, 10:00–13:00.", "idempotencyKey": "decide-1" }
```

**Input**

| `decision` | Required | Not allowed |
| --- | --- | --- |
| `accept` | `optionRef`, `authorityRef` | `terms` |
| `counter` | `terms` (as in §12.4) | `optionRef`, `authorityRef` |
| `reject` | — | `optionRef`, `authorityRef`, `terms` |

Every decision also takes `text` (1–8,000 characters) and `idempotencyKey`. A missing required field fails the schema (`TOOL_ARGUMENTS_INVALID`).

**Effects**
- **`counter`:** one native message, type `counterproposal`, intent `counteroffer`.
  - `payload.counterproposal = terms` exactly, so the option value holds only the terms.
  - `payload.decision = { kind: "counteroffer", proposalMessageId }`. `advanceNativeCase` reads the reference from there.
  - Today's `counterProposal` then expires every earlier option and adds the counter's option. The proposal is `countered`, and `lastActor` becomes `you`.
- **`reject`:** one native message, type `decision`, intent `reject`, `payload.decision = { kind: "reject", proposalMessageId }`.
  - **New in C-A3:** the proposal becomes `withdrawn`, so it is no longer current. Today it stays `open`.
- **`accept`:** one transaction:
  1. `validatedPolicyBinding` is called with `requestedAction: "proposal.accept"` and `actionPayload: { proposalId, optionId }`, passed explicitly so the binding digest matches. It writes its execution record and `policy.re_evaluated` audit **inside this transaction**. A refused accept therefore consumes nothing (new in C-A3; today those writes happen before the checks that can refuse).
  2. Today's `acceptProposal` runs: the proposal becomes `accepted`, the case moves to `authorized`, and the authority is consumed.
  3. One native message goes to the counterparty: type `decision`, intent `accept`, `payload.decision = { kind: "accept", proposalMessageId }`.

  **New in C-A3: the accept message.** `advanceNativeCase` must not try to move an `authorized` case to `waitingForHuman` for this server-sent accept. Today that transition is not allowed, so it would throw. The counterparty still receives the accept message. Any review its own workspace wants happens when it completes the case (revision 3), which already requires a verified human decision after an accept.

**Result (`decideResult`):** `{ decision, messageRef, proposalRef, optionRef, proposalStatus, caseStatus, recipient, replayed }`.
- `proposalStatus` is `countered`, `withdrawn` or `accepted`.
- `optionRef` is the accepted option, the counter's new option, or `null` for a reject.
- `caseStatus` is the case state after commit.

**Errors** (`x-tool-errors`). All are non-retryable except `TOOL_BUSY`.

| Code | When |
| --- | --- |
| `PROPOSAL_NOT_AWAITING` | `proposalRef` is not the current proposal, or its `lastActor` is `you`. That includes a second accept after a successful one, because the accepted proposal is no longer current. |
| `OPTION_NOT_LIVE` | `optionRef` is not a live option of that proposal. |
| `AUTHORITY_CHANGED` | The binding no longer matches the case's proposals or the option. |
| `AUTHORITY_EXPIRED` | The authority is past `expiresAt`. |
| `AUTHORITY_DENIED` | The stored decision is `deny`, or the re-check at execution says `deny`. |
| `AUTHORITY_PENDING` | `needsHuman` with no approval yet. If nothing is requested yet, call `envoi_request_human`. Otherwise end the turn and wait for `human_decision` work. |
| `REF_NOT_FOUND`, `IDEMPOTENCY_CONFLICT`, `TOOL_BUSY` | §2 |

**Order of checks**
1. References.
2. Whether the proposal awaits this agent.
3. Whether the option is live.
4. The authority, in the order `validatedPolicyBinding` uses:
   1. binding changed;
   2. expired;
   3. stored deny;
   4. pending;
   5. deny at execution;
   6. policy changed after the approval (`AUTHORITY_CHANGED`).

A refused decide writes nothing.

#### 12.6 `human_decision` work

**What creates it.** When a request resolves (§12.3), the server writes a `humanDecision` message into this agent's inbox for that case. It emits `work.available` with reason `human_decision`, which is a new a4 reason; consumers already accept any reason. The claim offers this work like agent work, without `acceptHumanInstructions`.

**Session.** The work kind is `human_decision`, added to case-session v1 (its §2, §3, §5).
- **Counterparty:** the case's **other agent**. The person who decided is never the counterparty.
- **Eligibility:** the §3 checks apply to that other agent. If it is paused, the claim skips the work until a4's `counterparty_resumed`. `instruction_authority_lost` does not apply.

**Snapshot.**
- **`requestedResponse`** is `{ ref, from: "your_human", kind: "human_decision", intent, text, receivedAt }`.
  - `intent` is `approveOnce`, `decline` or `expired`.
  - `text` is a server-written summary, for example "Approved: accept option <optionRef>."
- **`authority.lastPolicyDecision`** shows the evaluation, with its `humanApproval`.
- **Timeline:** the decision appears as a timeline item of kind `human_decision`, with the same `intent`.

**Tools and replies.**
- The tools are the same as for agent work.
- A reply's default `inReplyTo` is the newest message from `other_agent` in the case. The agent-work reply rules apply (§7.1).
- The usual next step after an approval: `envoi_case_decide` with `accept`, the approved option and the same `authorityRef`.

**When the approval no longer applies.** Any of these makes the accept fail, and the agent checks authority again:
- the case's proposals changed (`AUTHORITY_CHANGED`);
- the authority expired (`AUTHORITY_EXPIRED`);
- the policy changed (`AUTHORITY_CHANGED`).

#### 12.7 Events and audit

- **Native messages** from these tools produce today's events (§7.5).
- **Authority:** policy evaluations audit `policy.evaluated`, and `policy.re_evaluated` at execution.
- **Accepts** audit `proposal.accept_attempted`.
- **New owner audit types:**
  - `case.human_decision_requested`;
  - `case.human_decision_resolved`, with `requestId` and outcome `approved`, `declined` or `expired`.
- **New a4 reason:** `work.available` with `human_decision`.
- **Every first effect** also writes `agent.case_tool_used` (§7.5).
- **Lane B:** each new audit type needs a paired `WORKSPACE_EVENT_TYPES` entry.

#### 12.8 Fixtures added by revision 2

| Group | Fixtures |
| --- | --- |
| Authority | `authority-check-allow`, `authority-check-needs-human`, `authority-check-deny`, `authority-check-replayed`, `authority-check-option-not-live`, `authority-check-not-awaiting` |
| Human request | `request-human`, `request-human-not-pending`, `request-human-expired`, `snapshot-human-decision`, `snapshot-human-decision-declined` |
| Propose | `propose-new`, `propose-proposal-exists`, `snapshot-no-proposal` |
| Decide | `snapshot-awaiting-decision`, `decide-counter`, `decide-reject`, `decide-accept`, `decide-accept-authority-pending`, `decide-accept-authority-expired`, `decide-accept-authority-changed`, `decide-accept-authority-denied`, `decide-not-awaiting`, `decide-option-not-live`, `decide-accept-missing-authority`, `decide-after-human-approval` |

### 13. Decisions for review

These are Lane A's proposals. Each one can change before approval.

1. **Results are JSON text, with no MCP `structuredContent`.** That matches today's tools and every MCP client. `structuredContent` can be added later without breaking anything.
2. **References are stable per agent and case,** not per session, so a resumed turn can point back at the same objects.
3. **Snapshot bounds:** 64 KiB in all, with fixed sections capped at 40 KiB (worst case about 34 KiB); 20 events by default and 50 at most; a 12 KiB requested text; 10 assets; per-text limits in serialized bytes. Lane B's real turn sizes may argue for other values.
4. **Reply intents** are limited to `message`, `clarify` and `status`. Every typed negotiation step goes through revision 2's tools.
5. **A held message reads as `queued`** in a snapshot.
6. **`proposal` is the newest open or countered proposal that a typed offer message created.** It shows live options only. Proposals made through the case API are left out of v1's tools.
7. **Reads are not audited per call** in v1.
8. **Every human outcome resumes the agent through `human_decision` work** (§12.6), not by reopening settled work. That covers approve, decline and expire. The approving person never becomes the session counterparty.
9. **A reject withdraws the proposal** (new in C-A3), so a rejected offer is never current again.
10. **Agreements need human approval by default.** C-A3 makes `proposal.accept` policy-controlled, with `agreements.requireHumanApproval` defaulting to true (§12.2). That is a product decision for Rachel. If false is chosen instead, accepts are `allow` unless the workspace opts in.
11. **A `needsHuman` authority lives 24 h,** not today's 10 minutes, so a person has time to decide.
12. **Human requests are tracked per agent, not in the shared case state** (§12.3). A decline never revokes the case, because the case record is shared with the counterparty.
13. **No model upload in v1.** Files enter a case only through the host's upload routes, under the owner's control (§14.3). A model-authored artifact tool would come in a later revision.
14. **An approved accept counts as the agreement's human decision** when completing (§14.4), so a person approves once rather than twice.
15. **Inline reads are limited** to clean text assets of at most 32 KiB, returned as untrusted text (§14.2). Bytes and anything larger stay a host operation.
16. **Sharing into an open case with its own counterparty needs no policy authority** (§14.3), even though the engine classes `asset.share` as consequential. Any later sharing beyond the counterparty would need one.

### 14. Revision 3: assets and completion

**Scope.** Revision 3 adds `envoi_case_list_assets`, `envoi_case_share_asset` and `envoi_case_complete`, which unblocks C-B4. With this revision all nine case tools are defined, so v1 can be approved in one step.

**Rules shared by the three tools**
- Each one follows §1–§5.
- The two that write take an `idempotencyKey` (§3).
- All three run in-process under the settlement lock set (case-session §6.3).
- One new reference kind is added: `r`, a case receipt (`x-ref-kinds`). A receipt has the same `r_…` reference everywhere: in `envoi_case_complete`'s result and in the snapshot timeline.

**What they build on**
- Asset visibility: today's `assetReadAccess`.
- Grants: today's `POST …/assets/{assetId}/grants`.
- Completion: today's native completion path (`advanceNativeCase`), which writes the canonical receipt.

#### 14.1 State rules (extending §12.1)

A case whose `case.status` is `completed`, `failed` or `expired` is **closed**, and `advanceNativeCase` refuses every message to it. While a case is closed:
- `allowedActions` holds only `envoi_case_snapshot` and `envoi_case_list_assets`;
- every writing tool returns the tool error `CASE_CLOSED`. That includes `envoi_case_reply` (§7.4), which is additive for revision 1 clients.

While the case is open:

| Tool | Appears when |
| --- | --- |
| `envoi_case_list_assets` | always, including when the case is closed |
| `envoi_case_share_asset` | `assets` contains an item with `origin: "you"`, `scan: "clean"` and `shared: false`, **or** `assetsHasMore` is true |
| `envoi_case_complete` | `authority.pendingHumanDecision` is false |
| `envoi_authority_check` | the proposal awaits this agent's answer (§12.1), **or** `envoi_case_complete` would appear |

#### 14.2 `envoi_case_list_assets`

**Permission:** read. **Work kinds:** all. **Writes:** nothing.

Visibility follows today's `assetReadAccess`:
- assets this agent created, if it holds `create_assets`;
- assets granted to this agent, if it holds `receive_agent_messages`.

**List mode:** `{ "limit": 20, "before": "c_…" }`, both optional.
- Returns up to `limit` visible assets in this session's case, where `limit` is 1–50 and defaults to 20.
- Assets come newest first, each with the snapshot's fields plus `checksumSha256` (SHA-256, base64).
- Paging uses `{ hasMore, nextCursor }` and the sealed-cursor rules of §6.3.

**Single mode:** `{ "assetRef": "a_…", "includeContent": true }`. Returns that one asset, under the same visibility.
- Without `includeContent`, the asset comes back in any scan state, with `content: null` and `contentUnavailable: null`.
- With `includeContent`, the result depends on the asset:

| Asset | `content` |
| --- | --- |
| `scan: "clean"`, a text type (`x-limits.inlineContentTypes`) and at most `x-limits.inlineContentMaxBytes` (32 KiB) | `{ encoding: "utf-8", text }`. `text` is the whole file, its SHA-256 equals `checksumSha256`, and it is untrusted (§5). |
| Clean but binary, or larger than the limit | `null`, with `contentUnavailable` set to `"binary"` or `"too_large"`. The bytes stay a host operation, through today's download route. |
| `scan` is `pending` or `blocked` | tool error `ASSET_NOT_CLEAN` |

**Never in a result:** a URL, a signed link, an internal id, or an asset the other side has not granted.

**Errors**
- `REF_NOT_FOUND` when `assetRef` is not visible to this agent in this case. The same answer covers an asset that does not exist, one never granted, one in another case and one in another tenant.
- `CURSOR_INVALID` for a bad cursor.

**Result (`assetListResult`):** `{ assets, hasMore, nextCursor }` in list mode, or `{ asset, content, contentUnavailable }` in single mode.

#### 14.3 `envoi_case_share_asset`

**Permission:** `create_assets`. **Work kinds:** agent work and `human_decision`.

```json
{ "assetRef": "a_…", "idempotencyKey": "share-1" }
```

**Effect.** The tool grants the asset to the session's counterparty, which is the only possible recipient. It writes today's grant record (`grant_…`) and audits `asset.granted`.
- **No policy authority (decision 16).** The policy engine classes `asset.share` as consequential, but sharing an asset into an open case with its own counterparty needs no authority in v1. Any later sharing to other recipients would.

**Order of checks**
1. Idempotency replay (§3).
2. `CASE_CLOSED`.
3. `REF_NOT_FOUND`.
4. `ASSET_NOT_SHAREABLE`: this agent did not create the asset in this case. Granted assets cannot be re-shared.
5. `ASSET_NOT_CLEAN`: the scan is not `clean`. **New in C-A4:** today a grant may be made before the scan and only becomes active once the asset is clean.

**Result (`shareResult`):** `{ assetRef, recipient, alreadyShared, replayed }`.
- `alreadyShared` is true when a grant to this counterparty already existed under a different key; nothing new is written.
- A replay returns the original result with `replayed: true` (§3).
- A grant sends no message. A reply (§7) tells the counterparty, and its snapshot shows the asset with `origin: "other_agent"`.

**How files get into a case.** v1 has no model upload (decision 13). Files enter a case through the host's existing upload routes (begin upload with `caseId`, then complete), under the owner's control. The host never uploads model-authored content that way (case-session §10).

#### 14.4 `envoi_case_complete`

**Permission:** `execute_cases` **and** `send_agent_messages`, because completion sends a native message. **Work kinds:** agent work and `human_decision`.

```json
{ "result": "Delivery agreed for 26 Oct, 10:00–13:00 at 4.10/unit.", "authorityRef": "g_…", "evidenceRefs": ["a_…"], "idempotencyKey": "complete-1" }
```

**Input**
- `result`: 1–2,000 characters, the outcome in the agent's words.
- `evidenceRefs`: at most 32 assets in this case that **the counterparty can also see**, meaning assets this agent shared or the counterparty created. Any other asset gets `EVIDENCE_NOT_SHARED`.
- `authorityRef`: required exactly when completing needs a person (below).

**When completing needs a person.** A completion needs a decision from a person in **this agent's workspace** when the case has an accepted agreement that no such person approved. The accept may have been made by either side; today `approvalRequired` covers both. In that case:
1. `envoi_authority_check` with `{ "action": "complete_case", "result": "<exact text>" }`.
   - **New in C-A4:** `requestedAction` `case.complete` becomes policy-controlled for this purpose, with `actionPayload: { result }`. The decision is `needsHuman` exactly when the condition above holds, `allow` otherwise, and `deny` without `execute_cases`.
2. On `needsHuman`, `envoi_request_human`, as in §12.3.
3. The person approves in the owner UI. The UI sends only `{ "actionKey": "approveOnce", "externalRefs": { "policyEvaluationId": "…" } }`.
   - **New in C-A4:** the server copies `requestedAction: "case.complete"` and `result` from the binding, so the person approves the bound text and never types it. It checks the evaluation is `needsHuman`, unexpired and open for this agent. The approval is today's verified case decision (`verifiedHumanCaseDecision`). It no longer requires the shared case to be `waitingForHuman` (see §12.3, as revised by this revision).
   - The approval moves the case to `authorized`, as today, and writes `human_decision` work.
4. In the resumed turn, the agent calls `envoi_case_complete` with the same `result` and `authorityRef`. The server maps `authorityRef` to the approving action's id and uses it as the receipt's `authorityBasis`.

**An approved accept counts (decision 14).** An accept that a person of this workspace already approved (§12) counts as that agreement's decision. Completing then needs no second approval: `complete_case` returns `allow`, and the receipt uses that approval's action id as `authorityBasis`. **New in C-A4:** `verifiedHumanCaseDecision` accepts this approval. Today it accepts only `case.complete` approvals.

**Effect.** One native message goes to the counterparty, with type `completion` and intent `receipt`. Today's `advanceNativeCase` then:
- writes the case's canonical receipt (`receipt_<messageId>`, with `authorityBasis` and `humanApprovalStatus`);
- moves the shared case to `completed`.

Both parties then see the receipt in their timelines, and the case is closed (§14.1).

**Privacy of the delivered payload** (new in C-A4)
- The delivered `payload.completion` carries `{ result, evidence, humanApproval }`.
- `evidence` lists only assets the counterparty can see. Each viewer's snapshot shows them as its own references.
- `humanApproval` is `approved` or `not_required`. The `authorityBasis` (an action id of this workspace's person) stays on the receipt record and is never delivered.

**Separation from work settlement.** The host still completes or fails the work (case-session §7). A completed case never settles work, and settled work never completes a case.

**Result (`completeResult`):** `{ receiptRef, messageRef, humanApproval, caseStatus: "completed", recipient, evidenceRefs, replayed }`.
- `humanApproval` is `approved` when a person's decision is the receipt's `authorityBasis`, and `not_required` otherwise.

**Order of checks**
1. Idempotency replay.
2. `CASE_CLOSED`.
3. References (`REF_NOT_FOUND`, then `EVIDENCE_NOT_SHARED`).
4. Authority:
   - `AUTHORITY_REQUIRED` when a person is needed and there is no `authorityRef`;
   - otherwise the §12.5 authority checks. `AUTHORITY_CHANGED` also covers a `result` that differs from the bound text, and `AUTHORITY_PENDING` covers this agent's own open request.

`IDEMPOTENCY_CONFLICT` and `TOOL_BUSY` apply as in §2.

#### 14.5 `envoi_authority_check` gains `complete_case`

| `action` | Required | Not allowed |
| --- | --- | --- |
| `accept_proposal` | `proposalRef`, `optionRef` | `result` |
| `complete_case` | `result` | `proposalRef`, `optionRef` |

**Result.** `authorityResult` gains `action`, which names the **tool action** checked (`accept_proposal` or `complete_case`). For `complete_case`, `proposalRef` and `optionRef` are `null`.

**Snapshot.** In the snapshot, `lastPolicyDecision.action` names the **policy action**:
- `proposal.accept`, for `accept_proposal`;
- `case.complete`, for `complete_case`.

#### 14.6 Events and audit

- Grants audit `asset.granted`, as today.
- Completion produces today's completion events: the native message's events, the case's `receipt` and `case.completed`.
- Every first effect also writes `agent.case_tool_used` (§7.5).

#### 14.7 Fixtures added by revision 3

| Group | Fixtures |
| --- | --- |
| List assets | `list-assets`, `list-asset-content`, `list-asset-content-binary`, `list-asset-content-too-large`, `list-asset-content-not-clean`, `list-asset-content-infected`, `list-asset-ungranted`, `list-asset-other-tenant` |
| Share asset | `share-asset`, `share-asset-replayed`, `share-asset-already-shared`, `share-asset-not-clean`, `share-asset-not-yours` |
| Complete | `authority-check-complete-allow`, `authority-check-complete-needs-human`, `snapshot-human-decision-complete`, `complete-case`, `complete-case-replayed`, `complete-case-with-evidence`, `complete-case-evidence-not-shared`, `complete-case-after-human-approval`, `complete-case-after-approved-accept`, `complete-case-authority-required`, `complete-case-result-changed`, `complete-case-closed`, `reply-case-closed`, `snapshot-completed` |
| Staged servers | `revision-3-tool-not-in-session` |

## http-wake v1

**Contract:** `http-wake`, version 1 (Phase C task **C-A0**, third of three). **Status:** approved. Lane B acknowledged it (board #34 comment 6243852729) and the human posted `CONTRACT-APPROVED http-wake v1 @269d969` (comment 6257954193), including its §13 decisions.

The blanket "CONTRACT-APPROVED (for Phase C)" on board #34 predates this publication and names no version, so it does not approve this contract; the version-specific approval is the one in the Status line. At publication nothing here was implemented and nothing was default-on; the server work is C-A5 and the client work is C-B5, recorded in the board's `INTEGRATED` comments.

**Fixtures:** [`test/contract-fixtures/http-wake/`](../../../test/contract-fixtures/http-wake/). It holds:
- `schemas.json`: draft-07 schemas plus the machine-readable tables `x-codes`, `x-limits`, `x-url-checks`, `x-reserved-names`, `x-ipv6-global-unicast`, `x-blocked-ranges`, `x-failure-classes`, `x-wake-reasons`, `x-signing`, `x-receiver-checks`, `x-responsibility`, `x-ended-reasons`, and the examples `x-public-origin-example` and `x-self-hosts-example`;
- one JSON file per case. Every signature in them is a real Ed25519 signature by a throwaway test key whose public half is in the fixtures.

**Owner:** Lane A. **Consumer:** Lane B: the trusted reference receiver and host adapter (C-B5), and the owner UI's wake status. Phase B **B-R8** consumes the same contract.

**Name.** Phase C planning called this `http-wake-v1`. The canonical id is `http-wake`, version 1, like `case-session`. Lane B's C-B0 readiness check (PR #114) needs the same one-line rename.

**What it covers.** How Envoi tells a host's own HTTPS endpoint that work may be waiting, without revealing any content or identifier of that work:
- registering an endpoint, proving ownership, activation, replacement and revocation;
- the notification bodies, the signed headers, the exact signing bytes, and key distribution and rotation;
- the destination checks the server makes against SSRF and DNS rebinding;
- acknowledgement, timeouts, retries, deduplication and ordering;
- the checks a receiver must make, and how it then fetches the real work;
- pause, revoke, availability reporting, flags and rollback.

**The queue stays authoritative.** As in a4 v2, a notification is only a hint to call `POST /api/agent/work/claim`. It never carries work. A receiver that misses every notification still finds all its work by claiming. Losing, delaying, duplicating or reordering notifications can delay work, but it never loses or duplicates a canonical effect.

**One adapter.** This is the only outbound HTTPS wake path in Envoi. Phase B B-R8 and Phase C C-A5 and C-B5 all use it, and there is no second webhook delivery engine (Phase C plan, C-A5). A provider that can host a receiver meeting §7 can use it as it is.

**Generic support is not host support.** Passing these fixtures does not establish Muse, Instinct or any other named host. Each host still needs its own evidence that its product accepts and verifies these callbacks and acts on them while the app is closed (v3 §45 and §47, and the Phase B plan's Muse and Instinct sections). A provider that cannot receive arbitrary signed callbacks needs its own reviewed contract.

**Not in this contract.**
- **Making `webhook` a declarable delivery mode.** agent-registration v1 keeps `webhook` at `available: false`, and this contract does not change that (§11, §13).
- **Owner presence labels.** A delivered notification is not evidence that a runtime ran (a5-presence v1, §9 here).
- **The work itself.** Claim (a3, a4) and case sessions (case-session v1) are unchanged.

It builds on `a3-pause-auth` v3 (envelope, codes, pause), `a4-wake` v2 (claim triggers, claim hint), `agent-registration` v1 (installations) and `case-session` v1 (minting after a claim).

### 1. Flags, availability and the wake epoch

| Flag (server-only, default off) | Turns on |
| --- | --- |
| `ENVOI_HTTP_WAKE_V1` | The host and owner wake routes (§3), the key set (§5.2), and every outbound notification (§6). It requires `ENVOI_INSTALLATIONS_V2`, because a subscription binds an installation. If this flag is on and that one is off, startup fails closed. |

**How a host learns availability.** `GET /api/agent/status` gains:

```json
"httpWake": { "available": true, "version": 1, "subscription": { "id": "wake_sub_…", "status": "active", "endedReason": null, "expiresAt": "…" } }
```

- The field appears on every status response once C-A5 is deployed, whatever the flag. It is additive under a3 §1, so old connectors ignore it. A host never reads flags.
- **`subscription`** summarizes the calling installation's most relevant subscription: its active one, else its pending one, else its most recently ended one, else `null`. It is `null` whenever the flag is off. A host reads it at startup and on every safety poll (§7.4), so a subscription that ended is never missed silently.
- **The host remembers endings.** Ended records are deleted after `retainEndedDays` (§6.5), and `subscription` then reads `null`. A host therefore stores the last ended reason it saw. A `null` never licenses a new create after `revoked_by_owner`.
- **`available: false`, or the field is absent:** the host creates no subscription and relies on SSE and the a4 safety poll.
- **`available: true`:** a host that runs an HTTPS receiver may create one (§3.1).

**With the flag off:**
- the wake routes and the key set return `404 FEATURE_DISABLED`;
- nothing is sent, and queued notifications are dropped. Work is untouched.

**Wake epoch.** No subscription outlives a disable or a code rollback. The mechanism follows the case-session sessions epoch (case-session §1), with its own stored document `config/http-wake-epoch`, which holds `epoch` and `activeUntil`, and a longer window because subscriptions live for days:
- **On startup with the flag off,** a C-A5 server sets `epoch` to now. In a mixed rollout, any instance that starts with the flag off moves the epoch for all of them; that is a disable.
- **On startup with the flag on,** the server sets `epoch` to now if `activeUntil` has already passed. That covers a code rollback, because the reverted server never refreshed `activeUntil`.
- **While the flag is on,** every server extends `activeUntil` to now + `epochGraceSeconds` (6 h) at least every `epochRefreshSeconds` (10 min). An outage or restart shorter than 6 h therefore keeps every subscription.
- **A subscription created before `epoch` that had not already ended** reads as `ended`, with `endedReason: "feature_disabled"` and `endedAt` equal to the epoch, on every route and before every attempt. The first read or attempt that finds it records that. A subscription that had already ended keeps its first ending, so an owner revoke is never relabelled.
- **Every epoch move is logged and audited** (`http_wake.epoch_moved`, with its cause: flag off at startup, or `activeUntil` passed). A container restarted with a stale environment can move the epoch for everyone, and the operator must be able to see that.

After a disable, the host registers again and proves its URL again (fixture `reenable-after-rollback`), because the domain may have changed hands in between. Any other drift while the code was rolled back, such as an installation revoked by a path that did not end its subscriptions, is caught by the per-attempt derivation in §8.3.

### 2. Model

#### 2.1 Terms

| Term | Meaning |
| --- | --- |
| **Host** | As in case-session §2: the trusted process that holds the installation's access and refresh tokens. It is never the model. |
| **Receiver** | The host's HTTPS endpoint that accepts notifications. It belongs to the host and shares its credential custody: it claims with the host's access token. |
| **Subscription** | `wake_sub_…`: one receiver URL, registered by one installation. |
| **Notification** | One signed `POST` from Envoi to a subscription's URL. Its id is `wake_evt_…`. |
| **Attempt** | One try at sending a notification. |

#### 2.2 Subscriptions

A subscription belongs to **one installation** (agent-registration §6.4) of one agent. Only that installation's **access token** creates and manages it.

| `status` | Meaning | Receives |
| --- | --- | --- |
| `pending` | Created; ownership not proven yet. | Only its `wake.challenge` (§3.2) |
| `active` | Activated with the challenge (§3.3), until `expiresAt`. | Work and control notifications |
| `ended` | Finished for good, with an `endedReason`. | Nothing, ever |

The rules:
- **At most one `pending` and one `active` subscription per installation.** A create while one is pending ends the pending one with `superseded`. An activation while one is active ends the active one with `replaced`, in the activation's transaction (§3.4).
- **A bounded life.** An active subscription has `expiresAt`, `subscriptionLifetimeDays` (30) after activation, and ends with `expired` then. A host replaces it (§3.4) at least `replaceBeforeExpiryDays` (7) ahead. So an endpoint is proved again at least monthly, and a domain that changes hands stops receiving notifications within that time.
- **Ended is final.** No route revives an ended subscription. A host that wants wake again creates a new one and proves its URL again.
- **Subscriptions never move between installations.** A reconnect or a new installation starts with none (§8.3).
- **Several installations.** An agent with several active installations, which only legacy data can have (agent-registration §6.5), may have one active subscription on each. Each gets every notification for the agent.

**`endedReason`** (`x-ended-reasons`), with what the host does next:

| `endedReason` | When | Host retry / guidance |
| --- | --- | --- |
| `superseded` | A newer create from the same installation replaced it while it was pending (§3.1). | none / none |
| `replaced` | A newer subscription of the same installation was activated (§3.4). | none / none |
| `challenge_expired` | The challenge window passed without an activation (§3.2). `endedAt` is `challengeExpiresAt`. | `create_subscription` / `create_new_subscription` |
| `ended_by_host` | The host ended it (§3.5). | none / none |
| `revoked_by_owner` | The owner revoked it (§3.6). | none / `owner_revoked_wake` |
| `credential_ended` | Its installation ended (§8.3). `endedAt` is when the family or agent ended, not when the server noticed. | none / `check_host_credential` |
| `receiver_gone` | The receiver answered `410 Gone` (§6.4). | none / none |
| `delivery_failed` | Deliveries kept failing (§6.6). | `create_subscription` / `fix_receiver` |
| `expired` | It reached `expiresAt`. | `create_subscription` / `create_new_subscription` |
| `feature_disabled` | It predates the wake epoch (§1). | `create_subscription` / `create_new_subscription` |

`create_subscription` means: create a new subscription and activate it (§3.1–§3.3). A host applies this row when its status summary, or the first entry of its list, shows an ended subscription.

#### 2.3 Notifications

Every notification body is compact JSON of at most `requestBodyMaxBytes` (1,024) bytes, with exactly these fields:

| Field | Value |
| --- | --- |
| `type` | `wake.work_available`, `wake.control_changed` or `wake.challenge` |
| `version` | `1` |
| `id` | `wake_evt_…`. Random, unique per notification, and the same on every attempt of that notification. It is the deduplication key, and it equals the `envoi-wake-id` header. |
| `subscriptionId` | The subscription it was sent for. A receiver that serves several installations or subscriptions routes by it. |
| `sequence` | Per subscription, from 1, in the order notifications are created. Informational only (§6.3). |
| `reason` | Work and control notifications only (below). |
| `createdAt` | When the notification was created, not when an attempt was signed. |
| `challenge`, `expiresAt` | Challenge only (§3.2). |

**What a notification never carries:**
- no case, message, work, lease, inbox, agent, installation, human, asset or credential-family id;
- no message text, subject, proposal, file name or hash;
- no address, sender or recipient;
- no URL, token or credential.

`id` is random and is not derived from any of these, nor from `sequence` or `reason`, so two notifications about the same work look unrelated. That `id` is v3 §54's opaque work reference (`workRef` there). It refers only to the notification itself. `type`, `reason`, `sequence` and timing do reveal the kind and volume of activity, but no content and no identifier. The receiver learns what the work is only by claiming (§7.4).

**Types and reasons** (`x-wake-reasons`). Producers emit only these. Receivers accept any `reason` string of a known type, ignore unknown fields, and acknowledge and ignore an unknown `type` (§7.1).

| `type` | `reason` | Sent when | Receiver action |
| --- | --- | --- | --- |
| `wake.work_available` | `message_delivered` | A native message for this agent became claimable (a4 §4, trigger 6). | claim |
| | `human_instruction` | A human instruction for this agent was created (a4 §4, trigger 6). | claim |
| | `agent_resumed` | The owner resumed this agent (§8.1). Sent whether or not work is waiting. | claim |
| | `case_resumed`, `counterparty_resumed` | The a4 §4 `work.available` reasons of the same names. | claim |
| | `work_due` | A retry delay ended or a lease expired, so work became claimable with no event (a4 §4, "safety timer only"). | claim |
| | `subscription_activated` | The subscription was just activated (§3.3), so the host claims once through it. | claim |
| `wake.control_changed` | `agent_paused` | The owner paused this agent (§8.1). | renew live leases |
| | `case_controlled` | A case pause or revoke released one of this agent's leases (case-session §7.4). | renew live leases |
| `wake.challenge` | — | A subscription was created (§3.2). | activate |

**Receiver actions:**
- **claim:** trigger the single-flight claim (a4 §4), and keep claiming until `idle` (§7.4).
- **renew live leases:** renew every lease the host holds, now. Each renewal that fails cancels its turn (case-session §10). This is not a claim trigger.
- **activate:** call §3.3 with the challenge.

**Not sent:** a4's `lease_released`. It follows a reconnect, and a reconnect ends every earlier installation's subscriptions (§8.3); the new installation is woken by its own `subscription_activated` and its startup claim instead.

**`work_due`** is best effort: at most one per subscription per `workDueMinIntervalSeconds` (60), at the instant a4 §5's claim hint names. When the timer fires, the scheduler checks again that the work is claimable, so a lease that was renewed meanwhile sends nothing. The other "safety timer only" cases of a4 §4, a contact unblocked and authority restored, send nothing; the receiver's safety poll covers them (§7.4).

#### 2.4 Who checks what

The server can enforce only its own side. The receiver rules bind client code, and C-B5 evidence must show them (Phase C rows C19–C21). The same lists are in `x-responsibility`.

| Server (C-A5) | Receiver (C-B5) |
| --- | --- |
| URL rules at create and before every attempt (§4.1) | Fetch keys only from its configured Envoi origin's fixed key-set URL, honoring `max-age` (§5.3) |
| Resolve once per attempt through a public recursive resolver, and refuse a failed, empty or blocked answer (§4.2) | Run the checks of §7.1 in order, verifying the raw body with its own registered URL before parsing |
| Connect only to an address from that resolution, with SNI and certificate checks for the URL host; no proxy (§4.3) | Hold the set of subscription ids it created for each URL, including a pending replacement (§7.1) |
| Never follow a redirect (§4.4) | Keep processed ids for at least `replayCacheMinSeconds` (§7.2) |
| Timeouts, read caps, single flight, and per-host, per-address and per-network limits (§4.5, §6) | Acknowledge within the timeout, and do the work afterwards (§7.3) |
| Sign every attempt with the key active at that moment; publish and rotate keys (§5) | Treat every notification as a hint: claim with its own credentials at its configured origin, never at a URL from a request; keep a safety poll and read its subscription from status (§7.4) |
| Opaque bodies with no content, no identifier beyond the notification and subscription ids, and no credentials (§2.3) | Keep every token away from the model (case-session §4) |
| Durable, bounded retries with a deadline; coalescing; suppression while paused or while the credential is expired; nothing for an ended subscription, derived before every attempt (§6, §8) | |
| Activation only with the challenge sent to the URL, by the installation that created it (§3.3) | |

### 3. Routes

| Route | Auth | Body | Success |
| --- | --- | --- | --- |
| `POST /api/agent/wake-subscriptions` | access token | `{ "url" }` | `201 subscriptionResponse`, `pending` |
| `POST /api/agent/wake-subscriptions/{id}/activate` | access token | `{ "challenge" }` | `200 subscriptionResponse`, `active` |
| `POST /api/agent/wake-subscriptions/{id}/end` | access token | `{}` | `200 subscriptionResponse`, `ended` |
| `GET /api/agent/wake-subscriptions` | access token | — | `200 hostSubscriptionList` |
| `GET /api/inboxes/{inboxId}/agents/{agentId}/wake-subscriptions` | human session | — | `200 ownerSubscriptionList` |
| `POST /api/inboxes/{inboxId}/agents/{agentId}/wake-subscriptions/{id}/revoke` | human session | `{}` | `200 subscriptionResponse`, `ended` |
| `GET /.well-known/envoi-wake-keys.json` | none | — | `200 jwks` (§5.2) |

**Common rules for the host routes:**
- They take the installation's **access token** (a3 §2.1). A case-session, `mcp_read` or bootstrap token is an unrecognized bearer, `401 AUTHENTICATION_REQUIRED`, identical to an unknown token. So a model, which never holds the access token (case-session §4), cannot touch wake.
- Every response has `cache-control: no-store`. Bodies are closed objects: an unknown field is `400 WAKE_SUBSCRIPTION_INVALID`.
- **They work while the agent is paused.** Like refresh, status and SSE (a3 §3), managing wake maintains connectivity and acts on nothing, so `AGENT_PAUSED` never applies here (fixture `subscription-created-while-paused`).

**The subscription object** (`subscription`):

| Field | Meaning |
| --- | --- |
| `id`, `installationId`, `agentId` | Its id, and the installation and agent it belongs to. |
| `url` | The registered URL in canonical form: the WHATWG URL parser's serialization of the request's `url` (lowercase host, punycode, default port removed, dot segments resolved, non-ASCII percent-encoded). Signatures bind this exact string (§5.1), so the host stores the returned `url`, not the one it typed (fixture `subscription-created-canonical-url`). |
| `status`, `endedReason`, `endedAt` | §2.2. `endedReason` and `endedAt` are `null` until it ends. |
| `createdAt`, `activatedAt` | `activatedAt` is `null` until activation. |
| `expiresAt` | `activatedAt` + `subscriptionLifetimeDays`, or `null` before activation. |
| `challengeExpiresAt` | `createdAt` + `challengeTtlSeconds` (600) while `pending`, otherwise `null`. |
| `replacesSubscriptionId` | The active subscription this one replaces or replaced (§3.4), or `null`. It stays set after activation. |
| `delivery` | Delivery health (§9). |

#### 3.1 Create

`POST /api/agent/wake-subscriptions` with `{ "url": "https://…" }`. The first matching row wins:

| # | Condition | Response |
| --- | --- | --- |
| 1 | `ENVOI_HTTP_WAKE_V1` off | `404 FEATURE_DISABLED` |
| 2 | Over the a3 request limit | `429 RATE_LIMITED` |
| 3 | No bearer, an unknown or malformed one, or one that is not an access token | `401 AUTHENTICATION_REQUIRED` |
| 4 | a3 §2.1 steps 2–4 | `401 CREDENTIAL_REVOKED`, `CREDENTIAL_EXPIRED` or `ACCESS_TOKEN_EXPIRED` |
| 5 | Body invalid, including a `url` longer than `createUrlFieldMaxLength` (8,192 characters, counted as JSON Schema counts them) | `400 WAKE_SUBSCRIPTION_INVALID`. Nothing changes. |
| 6 | The URL breaks a §4.1 rule | `400 WAKE_URL_REJECTED` with `reason`. **No DNS lookup.** |
| 7 | This installation made `createPerInstallationPerHour` (5), or this agent `createPerAgentPerHour` (10), creates that reached this row in the last hour | `429 RATE_LIMITED`, `reason: "wake_subscription_create_limit"`. **No DNS lookup.** |
| 8 | The resolution breaks a §4.2 rule | `400 WAKE_URL_REJECTED`, `reason: "address_not_allowed"` |
| 9 | Otherwise | `201`, a `pending` subscription. In the same transaction: this installation's pending subscription, if any, ends with `superseded`; `replacesSubscriptionId` names its active one, if any; the challenge is queued (§3.2). |

- **Counting.** Every request that reaches row 7 counts toward those limits, including those rows 7 and 8 refuse. Row 7's `retry-after` is the time until the oldest counted create leaves the hour.
- **Why row 6 comes first.** A malformed URL is never resolved: a lookup of an attacker's name is itself a signal to that attacker.
- **Why row 8 has one reason.** `address_not_allowed` covers an empty answer, a failed lookup and a blocked address alike. Create therefore reveals nothing about what Envoi's resolver can see; the detail goes only to server logs.

**Lost response.** A create returns no secret, so a lost response costs nothing. Retry the identical request: the retry creates a new pending subscription, and the first one ends with `superseded` (fixture `subscription-create-lost-response-retry`). A host keeps at most one create in flight.

**Audit:** `agent.wake_subscription_created`, for the owner, with the subscription and installation ids and the URL's origin (scheme and host). Audit and logs never record the URL path.

#### 3.2 The challenge

On create, Envoi queues one `wake.challenge` notification, with `sequence` 1, signed like every notification (§5).
- **`challenge`** is `envoi_wake_challenge_` plus 32 random bytes in base64url (43 characters). The server stores only its SHA-256.
- **`expiresAt`** equals the subscription's `challengeExpiresAt`.
- **The first attempt** starts `challengeFirstAttemptDelaySeconds` (2) after the create commits, so the 201 usually reaches the host first.
- **The receiver** verifies it like any notification (§7.1), acknowledges it, and its host activates (§3.3). If the 201 has not arrived yet, the receiver does not know the subscription id; it answers `503`, and Envoi retries (fixture `challenge-before-create-response`). Beyond that, the receiver's answer only updates delivery health.

**Delivery limits for a challenge** (stricter than §6, because the URL is not proved yet):
- at most `challengeMaxAttempts` (3) attempts, and none after `expiresAt`;
- a transport failure (`timeout`, `connect_failed`, `tls_failed`, `address_rejected`) is final, not retried (`x-failure-classes` `challengeRetryable`). A URL that nothing answers therefore gets one connection attempt per create (fixture `challenge-unreachable-not-retried`);
- a retry whose earliest start would fall after `expiresAt` is not scheduled: the challenge is exhausted (fixture `challenge-not-retried-after-expiry`).

- a `410` only fails that challenge: the subscription stays `pending` until `challenge_expired`, and its end says nothing about the URL's answer (fixture `challenge-receiver-gone`);
- the third attempt is the last (fixture `challenge-attempts-exhausted`).

No other notification goes to a pending subscription (fixture `wake-not-sent-while-pending`). When `expiresAt` passes without an activation, the subscription ends with `challenge_expired`, recorded by the first read, attempt or cleanup that finds it.

**Why this proves ownership.** Only the URL receives the challenge, and only the installation that created the subscription can activate it. So:
- an installation cannot point Envoi at a URL whose requests it does not read;
- nobody who merely reads that URL can activate a subscription for an installation whose access token they do not hold.

A URL that belongs to someone else receives at most `challengeMaxAttempts` attempts of one signed challenge per create, within the create limits, and nothing more.

#### 3.3 Activate

`POST /api/agent/wake-subscriptions/{id}/activate` with `{ "challenge": "envoi_wake_challenge_…" }`. The first matching row wins:

| # | Condition | Response |
| --- | --- | --- |
| 1–4 | As §3.1 rows 1–4 | |
| 5 | Body invalid | `400 WAKE_SUBSCRIPTION_INVALID` |
| 6 | The subscription is unknown, or belongs to another installation or agent | `404 WAKE_SUBSCRIPTION_NOT_FOUND`, identical in every case |
| 7 | The subscription has ended, including a `challenge_expired` derived now | `409 WAKE_SUBSCRIPTION_ENDED`, `reason` is its `endedReason` |
| 8 | The challenge's SHA-256 does not match the stored one (compared in constant time) | `400 WAKE_CHALLENGE_INVALID`. Nothing changes. |
| 9 | `pending` | `200`, now `active`. In the same transaction: this installation's active subscription, if any, ends with `replaced` and its queued notifications are cancelled; one `wake.work_available` with `subscription_activated` is queued for the new subscription, unless the agent is paused (§8.1): then the resume's `agent_resumed` wakes it instead. |
| 10 | Already `active` and the challenge matches | `200` with the identical body, so a lost activation response is safe to retry. |

The challenge hash is kept while the subscription is not ended.

**Audit:** `agent.wake_subscription_activated`.

#### 3.4 Replacement

To move to a new URL, to renew before `expiresAt`, or to prove the same URL again, the host creates a new subscription while the old one stays active:
1. The create returns a `pending` subscription with `replacesSubscriptionId` set.
2. The challenge goes to the new URL. The old subscription keeps receiving notifications.
3. The activation ends the old subscription with `replaced`, cancels its queue, and wakes the new one with `subscription_activated` (§3.3 row 9). From then on, no new attempt goes to the old subscription; one already in flight may still finish.

There is no window in which neither subscription would be woken. A replacement that never activates simply expires, and the old subscription is untouched (fixture `subscription-replacement-flow`).

**Same URL.** While both exist, notifications for the old subscription and the challenge for the new one go to the same URL. The receiver holds both subscription ids for that URL until the old one ends (§7.1, fixture `subscription-replacement-same-url`).

#### 3.5 The host ends a subscription

`POST /api/agent/wake-subscriptions/{id}/end` with `{}`, for a pending or an active subscription:
- **`200`** with the subscription `ended` and `endedReason: "ended_by_host"`;
- **already ended, for any reason:** `200` repeating that first ending exactly, so ending twice is safe (fixtures `subscription-end-replayed`, `subscription-end-after-receiver-gone`);
- **errors:** §3.1 rows 1–4, `400 WAKE_SUBSCRIPTION_INVALID`, then `404 WAKE_SUBSCRIPTION_NOT_FOUND` as in §3.3 row 6.

**Audit:** `agent.wake_subscription_ended`, with `endedReason`. Exactly one is written per subscription, by whatever ends it.

#### 3.6 Owner list and revoke

Both routes take a human session of a manager of the agent's inbox, the same authority as the owner installation routes (agent-registration §6.5). The first matching row wins:

| # | Condition | Response |
| --- | --- | --- |
| 1 | `ENVOI_HTTP_WAKE_V1` off | `404 FEATURE_DISABLED` |
| 2 | Over the a3 request limit | `429 RATE_LIMITED` |
| 3 | Sign-in, CSRF or permission failure | today's human-route errors, unchanged |
| 4 | Authorization could not be checked | `503 AUTH_UNAVAILABLE` |
| 5 | (revoke) Body not exactly `{}` | `400 WAKE_SUBSCRIPTION_INVALID` |
| 6 | (revoke) The subscription is unknown, or another agent's | `404 WAKE_SUBSCRIPTION_NOT_FOUND` |
| 7 | Otherwise | `200` |

A server failure is `500 INTERNAL_SERVER_ERROR` at any point.

**List.** Every subscription of this agent, across its installations: pending, then active, then at most `ownerEndedListMax` (5) ended ones, newest `endedAt` first. The owner sees each full `url`.

**Revoke.** `POST …/wake-subscriptions/{id}/revoke` with `{}`:
- `200` with the subscription `ended` and `endedReason: "revoked_by_owner"`;
- already ended: `200` repeating the first ending (fixture `subscription-revoke-replayed`);
- unknown, or another agent's: `404 WAKE_SUBSCRIPTION_NOT_FOUND` (row 6).

**After an owner revoke** the host must not create a subscription again on its own (retry `none`, guidance `owner_revoked_wake`). The server does not block a deliberate new create; it shows in the owner's list and audit. To stop a host entirely, the owner revokes its installation (agent-registration §6.5), which also ends its subscriptions (§8.3). See §13.

#### 3.7 Host list

`GET /api/agent/wake-subscriptions` returns this installation's subscriptions only: pending, then active, then at most `hostEndedListMax` (5) ended ones, newest `endedAt` first.

### 4. Destination safety (server)

These rules run **at create** (§3.1) and **again before every attempt** (§6). A URL that was accepted earlier can still be refused later: before an attempt, a §4.1 failure is `url_rejected` (nothing resolved or sent, not retried; fixture `wake-url-rejected-at-attempt`), and a §4.2 failure is `address_rejected`.

#### 4.1 URL rules

The server parses the URL with the WHATWG URL parser and refuses it with the first matching reason, in `x-url-checks` order:

| `reason` | Refused when |
| --- | --- |
| `url_too_long` | The input, or its canonical serialization, is longer than `urlMaxLength` (2,048) UTF-16 code units. Percent-encoding can lengthen a URL, so both are checked (fixture `url-rejected-canonical-too-long`). |
| `url_invalid` | The parser rejects it. |
| `scheme_not_https` | The scheme is not `https`. |
| `userinfo_present` | It has a user name or password. |
| `port_not_allowed` | It names a port other than 443 (`allowedPorts`). |
| `query_present` | The input contains `?` anywhere, even with an empty query or inside a fragment. The check is on the input or `href`, never on the parser's `search`, which is empty for a bare `?`. Notifications are authenticated by signature, never by a secret in the URL. |
| `fragment_present` | It contains `#`. |
| `address_literal` | The host is an IP literal. That includes every IPv4 notation the parser normalizes, such as `https://0x7f.1/` for 127.0.0.1, and every IPv6 literal. |
| `self_target` | The host equals, or is a subdomain of, the host of `ENVOI_PUBLIC_URL` or any entry of the server setting `ENVOI_WAKE_SELF_HOSTS`. The setting must list the deployment's registrable domains (the example is `envoi-agents.com`, `x-self-hosts-example`) and its platform hosts, so Envoi never calls itself (fixture `url-rejected-self-subdomain`). |
| `reserved_name` | The host ends in a dot, is a single label, or equals one of `x-reserved-names` or ends in `.` followed by one (`localhost`, `localdomain`, `local`, `internal`, `intranet`, `lan`, `home`, `corp`, `home.arpa`, `arpa`, `test`, `example`, `invalid`, `onion`, `alt`). |

No DNS lookup happens for a URL that any of these rules refuses. The address rules in §4.2 remain the real defense; names are only a cheap first filter.

#### 4.2 Resolution and address rules (DNS rebinding)

**The resolver.** At create, and before **every** attempt, the server resolves the host's A and AAAA records **once**, in parallel, through a **public recursive resolver with no private zones**: the server setting `ENVOI_WAKE_DNS_RESOLVERS`, by default `1.1.1.1,8.8.8.8`. It never uses a VPC, split-horizon or local resolver, and it never reads `/etc/hosts`. DNS time counts toward the attempt's `deliveryTimeoutMs`, with at most `dnsTimeoutMs` (2,000) per lookup; a lookup that times out is a failed lookup.

**What is refused.** The resolution fails closed: it is refused when
- both queries return no address;
- either query fails with anything other than NXDOMAIN or NODATA, for example SERVFAIL, REFUSED or a timeout (fixtures `url-rejected-dns-error`, `wake-dns-timeout-at-attempt`). A DNS timeout is always `address_rejected`, never `timeout`;
- **any** returned address is not allowed. One blocked address refuses the whole answer, so a resolver can never pick the private one later (fixture `url-rejected-mixed-answers`).

At create this is `address_not_allowed`. Before an attempt, the attempt fails with `address_rejected`, and nothing is sent.

**Allowed addresses:**
- **IPv4:** any address outside `x-blocked-ranges`. That table covers this network, private, shared (CGNAT), loopback, link-local (including the `169.254.169.254` metadata service), IETF protocol, documentation, benchmarking, 6to4 relay, multicast and reserved ranges.
- **IPv6:** only global unicast, `2000::/3` (`x-ipv6-global-unicast`), and within it nothing in `x-blocked-ranges` (IETF protocol including Teredo, documentation including `3fff::/20`, and 6to4). Everything outside `2000::/3` is refused, which covers loopback, IPv4-mapped, IPv4-compatible, IPv4-translated, NAT64, discard, SRv6, unique-local (including the `fd00:ec2::254` metadata service), link-local, site-local and multicast. Embedded IPv4 addresses are therefore never reached through IPv6 (fixtures `url-rejected-ipv4-mapped-ipv6`, `url-rejected-nat64`).
- **Deployment additions:** the server setting `ENVOI_WAKE_EXTRA_BLOCKED_CIDRS` adds ranges that sit in public space but must never be reached: platform host-service addresses (for example Azure's `168.63.129.16`), the deployment's own NAT64 prefix if it is inside `2000::/3`, and the container platform's egress ranges. The server also refuses its own public and egress addresses.

A CNAME gets no special treatment: only the final addresses count.

**DNS rebinding.** Three rules together defeat it: resolve again before every attempt, check every address, and connect only to a checked address (§4.3). A name that resolved to a public address at registration and resolves to loopback later gets nothing sent (fixture `wake-dns-rebinding-rejected`). For an active subscription `address_rejected` is retryable, because DNS can be fixed; every retry checks again.

#### 4.3 Connection

- **Pinned address.** The server connects to an address from the resolution it just checked, and it never resolves again for that attempt: the HTTP and TLS stack gets the address, not the name (fixture `wake-pinned-address`).
- **TLS.** TLS 1.2 or later. The SNI is the URL host, and the certificate is verified against that host with Node's bundled Mozilla root store (`tls.rootCertificates`), passed explicitly so that `NODE_EXTRA_CA_CERTS` and any system additions do not apply to wake. Verification is never skipped.
- **Nothing extra.** No proxy: proxy environment variables, including `NODE_USE_ENV_PROXY`, never apply to wake, and C-A5 checks that at startup. No cookies, no `Authorization` header, no credential of any kind, and no connection reuse in v1.
- **Method.** Always `POST`.

#### 4.4 Redirects

Never followed. Any `3xx` fails the attempt as `redirect_rejected`, which is not retried (§6.2). The server never reads the `Location` value (fixture `wake-redirect-rejected`).

#### 4.5 Limits

| Limit | Value |
| --- | --- |
| DNS | `dnsTimeoutMs`, 2,000 ms per lookup, inside the delivery timeout |
| Connect | `connectTimeoutMs`, 5,000 ms |
| Response status and headers | within `deliveryTimeoutMs`, 10,000 ms from the start of the attempt |
| Response body | at most `responseBodyReadMaxBytes` (4,096) read within what is left of that timeout, then the socket is destroyed. The body is untrusted, so it is never stored, logged, parsed or shown. |
| In flight per subscription | one attempt per lane (§6.3) |
| Per destination host name | `perHostConcurrency` (4) concurrent attempts and `perHostRequestsPerMinute` (120) |
| Per resolved address, and per IPv4 /24 or IPv6 /48 | `perAddressConcurrency` (2) concurrent attempts and `perAddressRequestsPerMinute` (60); `perNetworkRequestsPerMinute` (120) per network |
| Creates | `createPerInstallationPerHour` (5) and `createPerAgentPerHour` (10), §3.1 |

**Who the host, address and network limits bind.** They apply to traffic that is unproven or failing: every challenge, and every attempt for a subscription whose last result was a transport, TLS or address failure. A `healthy` subscription is bound only by its own single flight. So many subscriptions cannot be aimed at one victim by changing DNS after activation (their attempts start failing, and then the limits apply), while receivers that share a CDN address or one provider host name are not throttled by each other.

**Fairness.** Inside each host, address or network bucket, attempts queue fairly per subscription, so one subscription cannot hold more than its share of a bucket's slots. An attempt over a limit waits; it does not fail, and it still counts toward the delivery deadline (§6.2). The values are server settings with these defaults.

### 5. Signing and keys

**Decision recorded by the human:** Ed25519 signatures with published, rotatable server keys and JWKS-style key ids, not a shared HMAC secret. A receiver holds no verification secret, so nothing returned at create needs protecting, and a leaked receiver configuration cannot forge notifications.

#### 5.1 Headers and signing bytes

Every attempt carries exactly these headers (`x-signing.headers`), besides transport headers such as `host` and `content-length`:

| Header | Value |
| --- | --- |
| `content-type` | `application/json` |
| `user-agent` | `Envoi-Wake/1` |
| `envoi-wake-id` | The notification `id`. |
| `envoi-wake-timestamp` | When this attempt was signed, in Unix seconds: decimal digits, no sign, no leading zero. |
| `envoi-wake-key-id` | The `kid` of the signing key. |
| `envoi-wake-signature` | `v1=` followed by the 64-byte Ed25519 signature in base64url without padding (86 characters). |

**The signing bytes** are the UTF-8 bytes of

```text
envoi-wake/1\n<envoi-wake-key-id>\n<envoi-wake-timestamp>\n<envoi-wake-id>\n<url>\n
```

followed immediately by the raw body bytes.
- `\n` is one line feed (0x0A).
- `<url>` is the subscription's stored `url` (§3), exactly.
- None of the fields before the body can contain a line feed, so the bytes are unambiguous.

**No canonicalization.** Envoi sends compact JSON: UTF-8, no byte-order mark, no whitespace. A receiver verifies the raw bytes it received, before parsing them, and never re-serializes the body.

**Why the URL is signed.** A request captured at one receiver cannot be replayed at another (fixture `wake-replayed-to-other-receiver`). So the receiver must use the URL it registered, not its `Host` header or what its proxy saw.

**Every attempt is signed again,** with the key that is active at that moment and a new timestamp. The body and `id` stay the same.

**Versions.** `envoi-wake-signature` is a space-separated list of entries. A v1 receiver uses the one entry that starts with `v1=` and ignores the others; a header with no `v1=` entry, or with two, is malformed to it (fixtures `wake-signature-v2-and-v1`, `wake-signature-no-v1`, `wake-signature-two-v1`). v1 senders send exactly one entry, so a later version can add another without breaking v1 receivers.

**One key set per environment.** The signing bytes bind the receiver URL but not the Envoi origin. Staging and production therefore never share a signing key, so a notification signed by one cannot be accepted by a receiver registered with the other.

**When an attempt starts.** An attempt starts when the §4.5 limits admit it. It is signed after that admission, with the key active at that moment, and its `deliveryTimeoutMs` and the start-to-start spacing of §6.2 are measured from it. A notification that waited for a slot is therefore never sent with a stale timestamp.

#### 5.2 The key set

`GET /.well-known/envoi-wake-keys.json` on `ENVOI_PUBLIC_URL`. No auth, `cache-control: public, max-age=300, s-maxage=0` (`jwksMaxAgeSeconds`), so no shared cache in front of it keeps it at all. The deployed Worker's `no-store` wrapper must exempt this one path (§14).

The body is a JWK set (RFC 7517, with RFC 8037 OKP keys). Each key has `kty: "OKP"`, `crv: "Ed25519"`, `x`, `kid`, `use: "sig"` and `alg: "EdDSA"`, plus two Envoi fields:
- **`status`:**
  - `active`: exactly one key, and the only one Envoi signs with;
  - `next`: at most one, published at least `keyPublishLeadSeconds` (24 h) before it becomes active;
  - `retired`: no longer signs, but still verifies until its `notAfter`.
- **`notAfter`:** on retired keys only. It is at least `keyRetireGraceSeconds` (24 h) after retirement.

**Private keys** live only in the server secret `ENVOI_WAKE_SIGNING_KEYS`: a JSON list of `{ kid, privateKey (PKCS#8, base64), activeFrom, notAfter }`, where `notAfter` may be `null`. Every server derives each key's status from those times, so promotion happens at the same instant on every instance and does not depend on a deploy:
- **active:** the key with the greatest `activeFrom` at or before now, among keys whose `notAfter` is after now;
- **retired:** any other key with an earlier `activeFrom` and a `notAfter` after now;
- **next:** a key whose `activeFrom` is after now. At most one.

At startup with the flag on, the server fails closed if there is no active key, more than one next key, or a retired key whose `notAfter` is less than its successor's `activeFrom` + `keyRetireGraceSeconds`. Publishing the next key at least `keyPublishLeadSeconds` ahead is an operator obligation: the secret is updated at least 24 h before `activeFrom`, except in an emergency. Keys are never logged and never appear in fixtures. The fixtures use a throwaway test key set whose private halves were discarded.

#### 5.3 How a receiver gets keys

- **Only from its configured Envoi origin:** `<the origin the host was set up with>/.well-known/envoi-wake-keys.json`, over verified HTTPS. Never from a URL found in a request, a header or a body.
- **Cache** for at most `max-age` minus any `Age` header.
- **A failed refresh** (network error, non-200, or a body that is not a key set) is treated like an unknown key: answer `503` and keep the old cache.
- **Unknown members and keys.** Ignore JWK members it does not know, and keys whose `kty`, `crv` or `alg` it does not support. The closed `jwk` schema describes what Envoi publishes.
- **Unknown `kid`:** refresh at most once per `unknownKeyRefreshMinIntervalSeconds` (60). If the key is still unknown, answer `503` with `retry-after: 60` (`unknownKeyRetryAfterSeconds`), not `401`. Envoi then retries, so a notification signed just after an emergency rotation is not lost, while forged key ids still cannot make a receiver hammer Envoi (fixture `wake-unknown-key`).
- **Accept any listed key** whose `notAfter`, if it has one, is after the receiver's clock: active, next or retired.
- A receiver may also pin keys out of band, but never instead of following rotation.

#### 5.4 Rotation and emergency removal

**Routine rotation:**
1. Publish the new key as `next`, at least 24 h ahead.
2. At its `activeFrom`, it becomes `active`. The old key becomes `retired`, with `notAfter` at least 24 h later.
3. Remove the old key after its `notAfter`.

Fixtures: `keys-published`, then `keys-rotated` (each names the instant it came into force as `context.validFrom`, and how, as `context.rotation`); `wake-signed-next-key` (a receiver whose cache still lists the new key as `next` accepts it); `wake-retired-key-expired`.

**Emergency removal,** after a key compromise: remove the key from the set at once, and promote a new key without the 24 h lead (fixture `keys-emergency`). Receivers stop accepting the removed key within `max-age` plus one refresh, since no shared cache holds the set. A receiver that has not yet seen the new key answers `503`, and Envoi's retry succeeds after its refresh (fixture `wake-emergency-rotation`). The window is the residual risk, and a forged notification can still only cause a claim (§7.4), never an effect.

### 6. Delivery

#### 6.1 Acknowledgement and timeout

A notification is **acknowledged** by any `2xx` whose status and headers arrive within `deliveryTimeoutMs` (10 s) of the attempt's admission (§5.1). The response body is ignored. Interim `1xx` responses (`100`, `102`, `103`) are ignored, are not an acknowledgement, and leave the timeout running. The receiver acknowledges first and works afterwards (§7.3).

#### 6.2 Failure classes, retries and backoff

`x-failure-classes`:

| Class | When | Retried | Retried for a challenge |
| --- | --- | --- | --- |
| `timeout` | The connection did not complete within `connectTimeoutMs`, or status and headers did not arrive within `deliveryTimeoutMs`. A DNS timeout is `address_rejected`. | yes | no |
| `connect_failed` | Connection refused, reset or unreachable | yes | no |
| `tls_failed` | Handshake failed, or the certificate is not valid for the URL host | yes | no |
| `address_rejected` | The resolution failed, timed out, was empty or contained a blocked address (§4.2). Nothing was sent. | yes | no |
| `url_rejected` | The stored URL now breaks a §4.1 rule (§4). Nothing was resolved or sent. | no | no |
| `interrupted` | The server stopped while the attempt was in flight, so its outcome is unknown (§6.5) | yes | yes |
| `http_retryable` | `408`, `425`, `429` or any `5xx` | yes | yes |
| `redirect_rejected` | Any `3xx` (§4.4) | no | no |
| `receiver_gone` | `410 Gone` (§6.4) | no | no |
| `http_rejected` | Any other final status, including `101` (the socket is destroyed) and every other `4xx` | no | no |

**Schedule.** After attempt *n* fails with a retried class, attempt *n* + 1 starts no earlier than

```text
start(n) + max( jitter(retryScheduleSeconds[n - 1]), min(retry-after, retryAfterMaxSeconds) )
```

- `retryScheduleSeconds` is 10, 30, 120, 600, 1,800 s, and `jitter` is uniform ±20 % (`retryJitterRatio`).
- `retry-after` counts only on a `429` or `503`, and only as delta-seconds; an HTTP-date is ignored. It is capped at `retryAfterMaxSeconds` (1,800), and the jittered schedule is never capped.
- Times are measured from the **admission** of attempt *n* (§5.1), so an attempt's own duration (up to 10 s) is included.
- The server draws the jittered wait when attempt *n* fails. If that wait would start the next attempt after the deadline, no attempt is scheduled and the notification is exhausted.

**Bounds.**
- **Attempts:** at most `maxAttempts` (6); a challenge, at most `challengeMaxAttempts` (3).
- **Deadline:** no attempt starts after `createdAt` + `deliveryDeadlineSeconds` (3,600); for a challenge, after its `expiresAt` (fixtures `wake-deadline-exhausted`, `challenge-not-retried-after-expiry`).
- **Typical span:** on the plain schedule the six attempts span about 43 minutes, and at most about 51 with jitter. `retry-after` and the §4.5 waits can only use up the deadline sooner, never extend it.
- **When a bound is reached,** the notification is **exhausted** and dropped. A class that is not retried fails the notification at once.

In every case the work itself is unchanged, and the receiver's safety poll finds it (§7.4, fixture `wake-retries-exhausted`).

#### 6.3 Single flight, coalescing and ordering

Each subscription has two **lanes**, work (`wake.work_available`) and control (`wake.control_changed`), and the challenge stands alone. A lane holds at most one **live** notification: queued, in flight or waiting to retry. It also holds one **dirty** flag.
- A trigger with no live notification in its lane creates one.
- A trigger while one is live only sets the dirty flag, whether that notification is in flight or waiting to retry.
- When the live notification is acknowledged, fails or is exhausted, a set dirty flag creates exactly one new notification and clears the flag (fixture `wake-coalesced`).
- A pause (§8.1) clears the work lane's dirty flag along with its queue, and a `replaced` end (§3.3) clears both lanes of the old subscription.
- So a burst produces at most one live notification plus one follow-up per lane, and nothing that arrived after a claim could have seen it is lost.

**Lanes are independent.** A control notification never waits behind work in backoff, and the reverse. At most one attempt per lane is in flight, across all server instances.

**Ordering.** Within a lane, notifications go out in `sequence` order. Across lanes, and with retries, restarts and failover, a lower `sequence` can arrive after a higher one, and a late retry is signed again, so its timestamp is fresh. **Receivers never depend on order or on `sequence`:** every verified new `id` is a hint (fixtures `wake-out-of-order`, `wake-delayed-retry`). `sequence` is there for evidence and diagnostics.

**Ids.** Every attempt of one notification carries the same `id`. Envoi never sends one notification under two ids.

#### 6.4 `410 Gone`

A receiver that answers `410` ends the subscription with `receiver_gone`, in the transaction that records the attempt. It is the receiver's way to unsubscribe without credentials. The host does not create a new subscription on its own (fixture `wake-receiver-gone`).

#### 6.5 Durability and restarts

**Storage.** Notifications are durable records in a **wake queue of their own**, not in the message outbox. Each is written in the same transaction as its trigger (a delivery, a resume, a pause), or by the `work_due` scheduler. A dedicated worker sends them, with its own concurrency, and never holds a database transaction during network I/O. So a slow receiver cannot stall message delivery, and a server without C-A5 simply ignores the queue.

**Restarts.** A server restart loses no notification. An attempt whose outcome is unknown after a restart counts as `interrupted` and is retried on the schedule, with the same `id`. The receiver may therefore see an `id` it has already processed (§7.2, fixture `wake-server-restart-recovery`).

**Retention.** A notification record is deleted 24 h after it is acknowledged, failed or exhausted. A subscription record is kept `retainEndedDays` (30) after it ends, so audit and the lists can show it, then deleted.

#### 6.6 Ending a failing subscription

A subscription ends with `delivery_failed` when both hold:
- at least `endAfterFailedDeliveries` (10) consecutive notifications failed or were exhausted;
- no notification was acknowledged for `endAfterFailingSeconds` (24 h), counted from the last acknowledgement, or from activation if there was none.

An acknowledgement resets the count. A `not_sent` outcome (§8) never counts as a failure and never changes `delivery`, so a long pause or an expired credential does not end a subscription. A new subscription needs a new challenge, which proves the receiver works again (fixture `subscription-ended-delivery-failed`).

### 7. Receiver rules (client)

#### 7.1 Checks, in order

**What the receiver holds.** For each URL it serves, the receiver keeps the **set of subscription ids** its host created for that URL and has not seen end. A pending replacement for the same URL is in the set alongside the active subscription (§3.4).

**The checks** (`x-receiver-checks`). The receiver runs them in order, and the first that applies decides:

| # | Check | Applies when | Answer |
| --- | --- | --- | --- |
| 1 | `malformed` | Not a `POST`; `content-type` not `application/json` (a `charset=utf-8` parameter is allowed); a body over `requestBodyMaxBytes`; or any `envoi-wake-*` header missing or not in its format, including a signature header with no `v1=` entry | `400` |
| 2 | `unknown_key` | The key id is not in the key set, after at most one refresh, or the refresh failed (§5.3) | `503` with `retry-after: 60` |
| 3 | `key_expired` | The key's `notAfter` is at or before the receiver's clock | `401` |
| 4 | `timestamp_out_of_window` | The timestamp differs from the receiver's clock by more than `timestampToleranceSeconds` (300) | `400` |
| 5 | `signature_invalid` | The signature does not verify over the §5.1 bytes, built with the receiver's own registered URL | `401` |
| 6 | `not_a_notification` | The body is not JSON matching the minimal `notificationEnvelope` (`type` a string, `version` 1, `id`, `subscriptionId`), or its `id` differs from `envoi-wake-id` | `400` |
| 7 | `challenge_for_unknown_subscription` | A `wake.challenge` whose `subscriptionId` is not in the set: its create response may still be on the way (§3.2) | `503` |
| 8 | `subscription_unknown` | Any other notification whose `subscriptionId` is not in the set | `400` |
| 9 | `duplicate` | The `id` was already processed | `200`, and nothing else |
| 10 | `process` | — | `200` or `204`, then act (§2.3). An unknown `type` is acknowledged and ignored; unknown fields and reasons are ignored. |

**Producer and receiver schemas.** The closed `notification` schema describes what Envoi sends. A v1 receiver requires only `notificationEnvelope`, so a later additive change does not break it.

**Other answers.** A receiver that verified a notification but cannot accept it now answers a retryable status (`408`, `425`, `429` or a `5xx`), and Envoi retries. It answers `410` to unsubscribe (§6.4). Any other answer to a valid notification wastes it. The rejection statuses are fixed so that Envoi's classification is predictable: a rejection is not retried, and a deferral (`503`) is (§6.2).

**Clocks.** Receivers keep their clocks within a few seconds, for example with NTP. A receiver whose clock is more than 300 s off rejects every notification, and its subscription eventually ends with `delivery_failed` (fixture `wake-rejected-by-receiver`).

#### 7.2 Replay and deduplication

- **Replay window.** Keep processed ids for at least `replayCacheMinSeconds` (600 s, twice the timestamp tolerance). That stops an exact replay inside the window (fixture `wake-replayed`); outside it, the timestamp check stops it (fixture `wake-expired-timestamp`).
- **Envoi's own retries.** Keeping ids for `dedupeCacheRecommendedSeconds` (3,900 s: the delivery deadline plus the tolerance) also absorbs those (fixture `wake-duplicate-retry`).
- **When an id counts as processed:** only once the notification has been durably accepted, with its claim scheduled. A deferred notification is not processed.
- **Correctness never depends on deduplication.** A duplicate hint costs one claim, which returns `idle` (fixture `wake-receiver-restart-recovery`).

#### 7.3 Acknowledge, then work

Answer within `deliveryTimeoutMs`, before any claim, model call or tool call. Then act asynchronously. Never do the work inside the request.

#### 7.4 Authenticating back: claim, then mint

For a **claim** action, the host:
1. **Claims** with `POST /api/agent/work/claim`, at its configured Envoi origin, with its own access token, under a4 §4's single-flight rule. It may send the notification `id` as `x-request-id`, which a3 §1 echoes, so evidence can tie a claim to its wake. It never uses a URL, header or other value from the notification to decide where or how to call.
2. **On `claimed`, mints a case session** for that lease (case-session §3) and runs the turn (case-session §7.2). Without `caseSessions`, a pre-Phase-C client keeps its earlier flow.
3. **Keeps claiming** until `idle`, settling and deduplicating by `workId` as a4 §6 says.

Fixture `wake-then-claim-and-mint` shows the whole path.

**Safety poll.** A host that relies on wake instead of SSE departs from a4 §6's 30–60 s timer in these ways:
- It claims once at startup.
- It then claims at least every `receiverSafetyPollMaxSeconds` (900 s), with whatever scheduling its platform supports.
- It honors a4 §5's `nextAvailableInMs` hint where it can, since `work_due` is best effort.
- On each of those polls it also reads `httpWake.subscription` from status (§1), and follows `x-ended-reasons` if the subscription has ended.

That bounds the delay when notifications are lost, exhausted or never sent. A host that cannot schedule anything reports itself as on demand (Phase B B-R9), never as automatically reachable.

**Custody.** Unchanged from case-session §4. The receiver holds the host's access and refresh tokens like any host; the model never sees them, the lease token or the session token.

### 8. Pause, revoke and replacement

#### 8.1 Agent pause and resume

- **The subscription stays active,** and the host may still manage it (§3).
- **At pause:** one `wake.control_changed` with `agent_paused`, so the host cancels running turns at once, as `agent.paused` does on SSE (fixture `wake-control-agent-paused`). Queued and retrying work notifications are cancelled in the pause's transaction.
- **While paused:** no work notification is sent (fixture `wake-suppressed-while-paused`). Work triggers are dropped rather than queued, because a claim would only answer `paused`.
- **At resume:** one `wake.work_available` with `agent_resumed`, whether or not work is waiting (a3 §5, fixture `wake-agent-resumed`).

#### 8.2 Case pause and resume

- A case pause or revoke that releases one of this agent's leases (case-session §7.4) sends `wake.control_changed` with `case_controlled`.
- A case resume sends `wake.work_available` with `case_resumed` (a4 §4).

#### 8.3 Ending with the installation

**Derived before every attempt and every read.** The server derives the credential state as a3 §2.1 steps 2–3 do, not only from the family document as agent-registration §6.4 does:
- **Ended:** the family is revoked for any a3 `CREDENTIAL_REVOKED` reason (installation revoke, reconnect, refresh replay, activation replay, owner access revoke), or the agent is revoked or removed even when its family document is not. The installation's pending and active subscriptions are ended with `credential_ended`, and nothing is sent (fixtures `wake-not-sent-installation-ended`, `wake-not-sent-agent-removed`).
- **Family expired** (a3 `CREDENTIAL_EXPIRED`): nothing is sent, because the host could not claim. The subscription stays active, and notifications resume if the owner reconnects. In practice a reconnect replaces the family, which ends the subscription anyway (fixture `wake-not-sent-credential-expired`).

**Eager end, as an optimization.** The paths that revoke a family also end that installation's subscriptions in the same transaction, and cancel their queued notifications, like case-session §6.2's eager session ends. Correctness never depends on this, because of the derivation above.

**After any end commits,** no new attempt starts for that subscription. An attempt already in flight may finish, and its result only updates history (fixture `wake-after-end-not-sent`).

**No goodbye.** No notification announces an end: an ended subscription's URL receives nothing more. The host learns of it from its status summary (§1), its list, or its next authenticated call (`CREDENTIAL_REVOKED`) (fixture `subscription-ended-installation-revoked`).

**No carry-over.** A reconnect never carries subscriptions over. The new installation creates its own and proves its URL again (fixture `subscription-ended-reconnect`).

### 9. Availability reporting

Each subscription carries `delivery`, which the server updates from each notification's outcome:

| Field | Meaning |
| --- | --- |
| `state` | `unverified` until the first acknowledgement; `healthy` after an acknowledgement; `failing` after a failed or exhausted notification. |
| `lastAttemptAt`, `lastSuccessAt` | The last attempt, and the last acknowledgement. |
| `consecutiveFailures` | Failed or exhausted notifications since the last acknowledgement. |
| `lastFailureClass` | The class (§6.2) of the last failure while `failing`, otherwise `null`. |

**Until activation,** `delivery` is always `unverified` with every other field `null` or `0`, also after a pending subscription ends (`superseded`, `challenge_expired`, `ended_by_host`). Its URL was never proved, so how its challenge fared is not reported back; otherwise create would become a probe of arbitrary hosts from Envoi's addresses (fixture `subscription-ended-challenge-expired`).

**Not-sent outcomes** (§8) never count as failures and never change `delivery`.

**What it is not.** Delivery health is not presence. a5-presence v1 is unchanged, and `healthy` means only that the endpoint acknowledged notifications. It is not evidence that a runtime ran, or that it acts while its app is closed (v3 §47). A host is advertised as automatically reachable only with its own wake evidence (Phase B plan).

**Owner UI** (Lane B, informative): "Wake not verified", "Wake working", "Wake failing (<class>)" and the ended reasons, plus paired `WORKSPACE_EVENT_TYPES` entries for `agent.wake_subscription_created`, `agent.wake_subscription_activated` and `agent.wake_subscription_ended`.

**Logs.** Each attempt writes a structured `http_wake.attempt` line with the subscription id, URL origin, resolved address, attempt number, class and duration. It never records the path, the body, the response body or any header value.

### 10. Codes

New codes use the a3 §1 envelope. `x-codes` gives one row per client surface (`bySurface`):
- **`host`:** the host on its own routes. `lifecycle` is the a3 connector state.
- **`owner`:** the owner's browser. Its lifecycle is `NOT_APPLICABLE`.
- **`receiver`:** the receiver fetching the key set. Its lifecycle is `UNCHANGED`.

| Code | HTTP | Surface: lifecycle / retry / guidance |
| --- | --- | --- |
| `FEATURE_DISABLED` | 404 | host: `UNCHANGED` / none / `wake_unavailable`. owner: `NOT_APPLICABLE` / none / `wake_unavailable`. receiver: `UNCHANGED` / none / `wake_unavailable`. |
| `WAKE_SUBSCRIPTION_INVALID` | 400 | host: `UNCHANGED` / none / `update_connector`. owner: `NOT_APPLICABLE` / none / `update_connector`. |
| `WAKE_URL_REJECTED` | 400 | host: `UNCHANGED` / none / `fix_wake_url`, for every `reason` |
| `WAKE_SUBSCRIPTION_NOT_FOUND` | 404 | host: `UNCHANGED` / none / none. owner: `NOT_APPLICABLE` / none / none. |
| `WAKE_CHALLENGE_INVALID` | 400 | host: `UNCHANGED` / none / none |
| `WAKE_SUBSCRIPTION_ENDED` | 409 | host: `UNCHANGED` / by reason / by reason, from the §2.2 table |
| `AUTHENTICATION_REQUIRED` | 401 | host: `UNCHANGED` / `refresh_then_retry_once` / none (a3) |
| `ACCESS_TOKEN_EXPIRED` | 401 | host: `UNCHANGED` / `refresh_then_retry_once` / none (a3) |
| `CREDENTIAL_EXPIRED` | 401 | host: `NEEDS_RECONNECT` / none / `owner_reconnect` (a3) |
| `CREDENTIAL_REVOKED` | 401 | host: `REVOKED` / none / a3's guidance for its reason |
| `RATE_LIMITED` | 429 | host: `DEGRADED` / `after_retry_after` / `service_busy`, with or without `reason: "wake_subscription_create_limit"`. owner: `NOT_APPLICABLE` / `after_retry_after` / `service_busy`. |
| `AUTH_UNAVAILABLE` | 503 | host: `DEGRADED` / `backoff` / `service_unavailable`. owner: `NOT_APPLICABLE` / `backoff` / `service_unavailable`. Never an authorization decision (a3). |
| `INTERNAL_SERVER_ERROR` | 500 | host: `DEGRADED` / `backoff` / `service_unavailable`. owner: `NOT_APPLICABLE` / `backoff` / `service_unavailable`. |

`reason` appears only on `WAKE_URL_REJECTED` (§4.1–§4.2), `WAKE_SUBSCRIPTION_ENDED` (an `endedReason`), `CREDENTIAL_REVOKED` (a3) and the create-limit `RATE_LIMITED`.

### 11. Compatibility, migration and rollback

**With the flag off, nothing changes except one additive status field:** `httpWake` shows `available: false` and `subscription: null`.

**With the flag on, existing clients see only additive changes:** the new routes, the key set, and the status field. No existing route, body or token changes. Outbound requests go only to URLs a host registered and proved.

**Delivery modes.** agent-registration v1's `webhook` delivery mode stays `available: false` in `GET /api/onboarding/routes`, and activation still refuses it. A subscription may be added to any installation, whatever delivery mode it declared, which in v1 is always `envoi_link`. A host may run SSE and wake together. Making `webhook` declarable is an agent-registration revision (§13).

**Data.**
- **New documents:** subscription records (`agents/{agentId}/wake-subscriptions/{id}`), the wake queue (§6.5), and the epoch document (§1).
- They are documents, not SQL tables, so there is no SQL migration, and PostgreSQL and FileStore behave the same. The message outbox is not touched.

**Rollback by flag.**
- The routes and the key set return `404`, and nothing is sent. Queued notifications are dropped.
- Hosts fall back to SSE or their safety poll, which they keep anyway (§7.4).
- The flag-off startup moves the epoch (§1), so when the flag is turned on again every earlier subscription reads as ended, and hosts register again (fixtures `rollback-flag-off`, `reenable-after-rollback`).

**New server settings:** `ENVOI_HTTP_WAKE_V1`, `ENVOI_WAKE_SIGNING_KEYS`, `ENVOI_WAKE_SELF_HOSTS`, `ENVOI_WAKE_EXTRA_BLOCKED_CIDRS` and `ENVOI_WAKE_DNS_RESOLVERS`. Each must be passed into the container (the Worker's `CONTAINER_ENV_KEYS`).

**Rollback by code** (reverting C-A5). The earlier server knows none of the routes, sends nothing, and ignores the wake queue, because it is not part of the outbox. It also stops refreshing `activeUntil`, so redeploying C-A5 more than `epochGraceSeconds` later moves the epoch too.

**Consumer changes Lane B makes (C-B5).** Informative; Lane B owns the details:
- a reference receiver that implements §7 exactly, with private storage for processed ids and its per-URL subscription sets;
- a host adapter that creates, activates, replaces before expiry and ends subscriptions, reads `httpWake` from status, and maps the codes through `code`;
- the §7.4 path from a notification to claim, mint and turn, plus the safety poll;
- the owner UI wording and event types in §9.

### 12. Fixtures

**Fixture file fields.**
- Each fixture has `contract`, `version`, `id`, `description` and `kind`. The kind decides what else it carries:
  - `http`: one exchange with Envoi, as `request` plus `response` plus `client`;
  - `delivery`: one notification attempt, as `delivery`, plus a `receiver` block when the request reached a receiver;
  - `sequence` and `rollback`: `steps`, each either an exchange or a delivery. A step with `delivered: false` is a response the server committed but the client never received.
- **Schemas.** A `request.schema` or `response.schema` names a definition in this contract's `schemas.json`, or `case-session#<name>` for one of case-session v1's own definitions (the claim and mint steps).
- **`delivery`:**
  - `origin` is `server` for an attempt by Envoi, or `third_party` for a replay or forgery someone else sent. A third-party delivery has only a `request`.
  - A server delivery gives `attempt`, `dns` (the one resolution of that attempt, with `error` when a query failed), `sent`, `connect` (address, port and SNI name), `request` (`method`, `url`, `headers` and the raw `bodyText`), `response` (`null` when none arrived, and then `transport` says in which phase and after how many ms of admission it stopped), `failureClass`, `outcome` and, for a retry, `nextAttemptInSeconds`.
  - When nothing was attempted at all, `outcome` is `not_sent` with a `notSentReason` and the `suppressed` notification's type, and there is no `dns` or `request`.
- **`receiver`:** its `clock`, `registeredUrl`, `subscriptionIds` (its set for that URL), the key set it holds (`jwks`), the ids it has processed (`seenIds`), and its `verdict` (`process`, `duplicate`, `reject` or `defer`), `reason`, `respondStatus`, `respondHeaders`, `action` and `next`.
- **`context`:** the stored state the fixture assumes: a create's `dns` answer, the agent's status, the credential state as derived now (`credential`), the subscription's state, `triggersDuringAttempt` for coalescing, extra `selfHosts` in force, and a key set's `validFrom` and `rotation`.
- **`client`:** the `surface`, `lifecycle`, `retry`, `guidance` and `next`. On a success, retry and guidance are `none`/`none`, except where a host reads an ended subscription as its most relevant one; there they are that reason's `x-ended-reasons` row. A success's lifecycle is `UNCHANGED` for the host (`RUNNING` or `PAUSED` on agent status), `NOT_APPLICABLE` for the owner and `UNCHANGED` for the receiver.

**Timelines.** Each alternative history is its own scenario, with its own subscription, installation and agent, so no subscription is ended two ways or used after its end. Across all fixtures each subscription id has one url, installation, agent, creation time and ending; no attempt follows its end; a replaced one ended when its successor activated; its notifications' `sequence` follows their `createdAt`; and per lane a notification is created only once the previous one is no longer live. Keys follow the sets in force: every attempt is signed by the key active in the latest of `keys-published`, `keys-rotated` and `keys-emergency` whose `validFrom` is not after it.

**What `test/contract-fixtures.test.js` checks for this contract**, beyond the shared checks:
- each error matches its `x-codes` row for its surface, including by-reason retry and guidance; each success's `client` follows the rule above;
- `FEATURE_DISABLED` appears exactly on wake routes with the flag off; only an access token reaches the host routes;
- every create's outcome is the first §4.1–§4.2 rule its URL and `dns` break, in `x-url-checks` order, against `x-blocked-ranges` and the IPv6 global-unicast rule; a URL refused by a rule that needs no lookup has no `dns`;
- a create stores the canonical url; end and revoke answer as §3.5 and §3.6 say, including repeats of an earlier ending;
- subscription objects and lists follow §2.2, §3 and §9: status fields, challenge window, lifetime, which ended reasons follow activation, no attempt after the end, health state, a pending subscription's empty health, list order and the per-installation limits;
- every server delivery follows §3.2, §4, §6 and §8:
  - the not-sent reason for its state, and what it withheld;
  - the URL rules again before the attempt, the address checks, and a pinned connection to a checked address;
  - exactly the signed headers, in their formats, and no credentials;
  - a closed, opaque body whose id encodes nothing;
  - the challenge rules;
  - the earliest start each attempt may have;
  - the failure class for its response or transport phase, the outcome, the attempt caps, the deadline for every attempt, and the jittered and `retry-after` delays;
- every receiver verdict is the one `x-receiver-checks` gives, recomputed with real signature verification, and its answer, headers and action follow it;
- every bearer matches its declared `auth`; every wake POST names its body schema; the wake flag never runs without installations;
- a status summary and a host list in one fixture agree;
- retries carry the identical body, are signed again and wait at least the scheduled delay; triggers during an attempt create exactly one follow-up, created after that attempt;
- every challenge is a placeholder;
- the fixtures agree with each other:
  - the tables match their enums in both directions;
  - routine and emergency rotations are consistent, and every server signature is by the key active at its timestamp;
  - one timeline per subscription id, with one ending, no attempt after it, replacements at activation, sequences that follow creation order (including Envoi-signed third-party copies), one live notification per lane, and receivers that hold only existing ids;
  - the host list is the owner list for its installation;
  - byte-identical replays;
  - challenge to activation, the challenge race, replacement on a new URL and on the same URL;
  - the lost create, the canonical URL, emergency rotation, claim and mint after a wake, restart recovery and exhausted retries;
- the claim and mint steps validate against case-session v1's own schemas;
- every URL reason, failure class, receiver check, not-sent reason, ended reason, wake reason, and code on each of its surfaces has a fixture;
- this table lists exactly the registered fixtures.

| Group | Fixtures |
| --- | --- |
| Keys and availability | `agent-status-http-wake`, `keys-emergency`, `keys-feature-disabled`, `keys-published`, `keys-rotated` |
| Registration | `host-list-rate-limited`, `subscription-create-access-token-expired`, `subscription-create-auth-unavailable`, `subscription-create-credential-expired`, `subscription-create-credential-revoked`, `subscription-create-feature-disabled`, `subscription-create-invalid`, `subscription-create-lost-response-retry`, `subscription-create-rate-limited`, `subscription-create-server-error`, `subscription-create-url-field-too-long`, `subscription-create-with-bootstrap-token`, `subscription-create-with-case-session-token`, `subscription-create-with-mcp-read-token`, `subscription-created-canonical-url`, `subscription-created-replacing-active`, `subscription-created-while-paused`, `subscription-created` |
| URL, private-address and metadata rejection | `url-rejected-canonical-too-long`, `url-rejected-dns-error`, `url-rejected-fragment`, `url-rejected-http-scheme`, `url-rejected-invalid`, `url-rejected-ip-literal`, `url-rejected-ipv4-mapped-ipv6`, `url-rejected-ipv6-documentation`, `url-rejected-ipv6-literal`, `url-rejected-ipv6-unique-local`, `url-rejected-link-local-metadata`, `url-rejected-localhost-name`, `url-rejected-mixed-answers`, `url-rejected-nat64`, `url-rejected-port`, `url-rejected-private-address`, `url-rejected-query`, `url-rejected-self-subdomain`, `url-rejected-self-target`, `url-rejected-single-label`, `url-rejected-too-long`, `url-rejected-trailing-dot`, `url-rejected-unresolvable`, `url-rejected-userinfo` |
| Challenge, activation and replacement | `challenge-attempts-exhausted`, `challenge-before-create-response`, `challenge-delivered`, `challenge-not-retried-after-expiry`, `challenge-receiver-gone`, `challenge-unreachable-not-retried`, `subscription-activate-active-wrong-challenge`, `subscription-activate-challenge-expired`, `subscription-activate-invalid`, `subscription-activate-not-found`, `subscription-activate-replayed`, `subscription-activate-wrong-challenge`, `subscription-activated`, `subscription-ended-challenge-expired`, `subscription-replacement-flow`, `subscription-replacement-same-url`, `wake-not-sent-while-pending` |
| Signed wakes, with no private content | `wake-agent-resumed`, `wake-case-resumed`, `wake-control-agent-paused`, `wake-control-case-controlled`, `wake-counterparty-resumed`, `wake-delivered-signed`, `wake-human-instruction`, `wake-then-claim-and-mint`, `wake-work-due` |
| Keys at the receiver | `wake-emergency-rotation`, `wake-retired-key-expired`, `wake-signed-next-key`, `wake-unknown-key` |
| Invalid signature, expiry and replay | `wake-expired-timestamp`, `wake-invalid-signature`, `wake-malformed`, `wake-rejected-by-receiver`, `wake-replayed-to-other-receiver`, `wake-replayed`, `wake-subscription-unknown` |
| Forward compatibility and format rules | `wake-body-too-large`, `wake-content-type-charset`, `wake-not-a-notification`, `wake-not-post`, `wake-signature-no-v1`, `wake-signature-two-v1`, `wake-signature-v2-and-v1`, `wake-timestamp-leading-zero`, `wake-unknown-field`, `wake-unknown-reason`, `wake-unknown-type` |
| Duplicate, delayed, out-of-order and coalesced | `wake-coalesced`, `wake-delayed-retry`, `wake-duplicate-retry`, `wake-out-of-order` |
| Timeout, temporary failure, bounded retries, deadlines and restart | `subscription-ended-delivery-failed`, `subscription-ended-expired`, `wake-deadline-exhausted`, `wake-receiver-408`, `wake-receiver-gone`, `wake-receiver-restart-recovery`, `wake-receiver-temporary-failure`, `wake-receiver-timeout`, `wake-retries-exhausted`, `wake-retry-after-http-date`, `wake-server-restart-recovery` |
| Redirect, DNS rebinding and URL re-checks | `wake-address-empty-at-attempt`, `wake-dns-rebinding-rejected`, `wake-dns-timeout-at-attempt`, `wake-pinned-address`, `wake-redirect-rejected`, `wake-url-rejected-at-attempt` |
| Pause, revoke and replaced installations | `host-subscription-list`, `owner-list-auth-unavailable`, `owner-list-feature-disabled`, `owner-list-rate-limited`, `owner-list-server-error`, `owner-revoke-invalid`, `owner-revoke-not-found`, `owner-subscription-list`, `subscription-end-after-receiver-gone`, `subscription-end-pending`, `subscription-end-replayed`, `subscription-ended-by-host`, `subscription-ended-installation-revoked`, `subscription-ended-reconnect`, `subscription-revoke-after-receiver-gone`, `subscription-revoke-replayed`, `subscription-revoked-by-owner`, `wake-after-end-not-sent`, `wake-not-sent-agent-removed`, `wake-not-sent-credential-expired`, `wake-not-sent-installation-ended`, `wake-suppressed-while-paused` |
| Rollback | `rollback-flag-off`, `reenable-after-rollback` |

### 13. Decisions for review

These are Lane A's proposals, except the first, which the human decided. Any of the others can change before approval.

1. **Ed25519 with published, rotatable keys** (human decision, §5). Recorded here, not open.
2. **Ownership by challenge, then activation with the access token** (§3.2–§3.3), rather than echoing the challenge in the HTTP response. An echo proves only that something at the URL answers; activation proves that the holder of this installation's credential reads that URL.
3. **The opaque reference is the notification id** (§2.3), random per notification rather than stable per work, so even "these two wakes concern the same work" is not revealed.
4. **Port 443 only, and no query strings** (§4.1). Receivers on other ports need a reverse proxy; URL secrets are unnecessary with signatures.
5. **The limits:**
   - a ±300 s timestamp window and a 10 s acknowledgement;
   - six attempts within a one-hour deadline, and three for a challenge, with transport failures final;
   - ending after 10 failed notifications and 24 h without an acknowledgement;
   - a 30-day subscription lifetime;
   - a 900 s receiver safety poll;
   - a 6 h epoch grace;
   - the host, address and network limits, which bind only unproven or failing traffic and queue fairly per subscription.

   Lane B's real receiver and host timings may argue for other values (§4.5, §6, §7).
6. **One reason for refused resolutions** (`address_not_allowed`, §3.1), so create is not a DNS oracle, at the cost of a less specific error for honest hosts.
7. **Owner revoke does not block a new create** (§3.6). The alternative is a server-side block with an owner "allow" route; revoking the installation already stops a host completely.
8. **No notification when a subscription ends** (§8.3); the status summary (§1) tells the host instead, so an ended URL receives nothing at all.
9. **Subscriptions do not survive a reconnect** (§8.3). A new installation may run on a different machine, so it proves its URL again.
10. **Control notifications, `subscription_activated` and `work_due`, and no `lease_released`** (§2.3, §8). They give a host without SSE what `agent.paused`, `case_session.ended` and the a4 safety timer give an `envoi_link` host, at the cost of a small server-side scheduler.
11. **`webhook` stays undeclarable** (§11). Route availability and the a5 owner labels change only with agent-registration and a5 revisions, after a host's own wake evidence.
12. **Approval.** This contract needs a version-specific `CONTRACT-APPROVED http-wake v1 @<publication sha>` after Lane B's `CONTRACT-ACK`. As with case-session §15, the humans settle on board #34 who posts it.

### 14. Implementation notes for C-A5 (Lane A; informative)

- **Delivery engine.** A dedicated wake queue and worker (§6.5). Claim queued records per subscription lane, release the database before any network I/O, and record the outcome in a short transaction afterwards. Do not reuse the message outbox: its claim has no kind filter, and its worker holds a transaction around delivery.
- **Resolution.** Use a `dns.promises.Resolver` pointed at `ENVOI_WAKE_DNS_RESOLVERS`, with `resolve4` and `resolve6` in parallel, never `dns.lookup`, so `/etc/hosts` and local search domains never apply. Check addresses with one `net.BlockList` per family plus the `2000::/3` allow rule: a single list matches every IPv4 address against `::ffff:0:0/96`.
- **Pinning.** Call `https.request` with `servername` set to the URL host, `ca: tls.rootCertificates`, `agent: false`, and a `lookup` that returns only the checked addresses. That `lookup` must also handle `{ all: true }`, which Node 20+ requests when `autoSelectFamily` is on; alternatively, set `autoSelectFamily: false`. Node's `https` does not follow redirects.
- **Signing.** `crypto.sign(null, bytes, privateKey)`, with keys parsed once from `ENVOI_WAKE_SIGNING_KEYS` and their status derived from `activeFrom` and `notAfter`.
- **Runtime.** Wake runs in the Node server container. The Cloudflare Worker sends no notifications. Its `withNoStoreHeaders` wrapper (`worker/router.js`) must pass the key set's `cache-control` through for `/.well-known/envoi-wake-keys.json`, and the new settings (§11) must be added to `CONTAINER_ENV_KEYS`. The container needs outbound UDP and TCP port 53 to the configured resolvers, because `dns.Resolver` has no DNS over HTTPS.
- **Responses.** Listen for the request's `'upgrade'` event: Node delivers a `101` there, and it must be classified `http_rejected` and the socket destroyed. Bound the body read in time as well as size.
- **Ending subscriptions.** Derive from the credential family on every read and attempt (§8.3). Also end eagerly on every revoking path, as an optimization.

## provider-browser-poll v1

Status: Stage 1 implementation authorized by the human directly in the implementation task on 2026-10-18, after review of PR #141 exact contract head 8f3c7568fafaccb17ef98f4ef9ae7d2149eca3ff. The human explicitly delegated the required gateway server, registration/activation hooks and canonical contract/fixture paths to that task. This records the direct authorization; no GitHub countersign or hosted pass is fabricated.

Normative text: [installation-scoped browser-session and polling contract](../../../integrations/provider-gateway/BROWSER-POLL-CONTRACT.draft.md). The historical filename is retained for reviewed-link stability. The selected canonical ordering source is the existing recipient inbox event sequence and its message.delivered events, read under the inbox mutation lock; pending message, claim, sender/block and canonical case-control state are rechecked on every projection and notification acknowledgement.

Publication: test/contract-fixtures/provider-browser-poll/schemas.json and its registry entry. Stage 1 maps trusted gateway activation to authenticated_rest + poll through an internal Symbol capability; public registration/activation body fields cannot assert that authority. The unversioned agent-registration v1 routes response remains byte-schema compatible and still does not offer poll. The versioned routes projection describes the gateway-specific pair. ENVOI_PROVIDER_BROWSER_POLL defaults off and requires all three existing registration, installation and authenticated-REST flags.

Additional owner-confirmation surface: GET /agent-gateway/owner, POST /api/agent-gateway/owner-confirm with the approved code/comparison phrase, existing owner session/assurance and CSRF. It is not reachable as human authority through the delegated browser cookie. The HTML browser shell and same-origin JSON/form handlers expose no operational credentials. Gateway audit events are additive normal owner-refresh events, not authentication controls or progress-only events.

Notification acknowledgement is host-asserted presentation only and never canonical work claim, acknowledgement, approval, settlement or proof the person saw an alert. Stage 1 is read/notify only. Host scheduling and closed-app proof remain external acceptance gates; both Muse and Instinct remain OPEN. Stage 2 writes, live account operations, deployment and rollout remain separately controlled.

PR #144 review corrections preserve provider-browser-poll v1's public payloads: cursors/notification refs additionally bind a private run nonce and browser generation; retries do not consume new-page budget or refresh successful-check presence. Notification retention starts only from canonical terminal facts, never lease/backoff/block/pause visibility. Renewal uses canonical refresh with one persisted operation and private recovery. Owner-confirmed repair of a live gateway installation reuses that installation/family and ledger, changes the browser generation, and denies the old browser. Unknown/ended bindings and uncertain rotation fail closed; ordinary registration/activation clients gain no attachment authority. Read/notify remains the only exposed scope; both named hosts stay OPEN. Exact review tests and CI are recorded in PR #144 and the implementation guide; no hosted acceptance or deployment is claimed.

## agent-remote-auth v1

**Contract:** `agent-remote-auth`, version 1 (build-plan task **A-3.1b**; Phase B backlog **B-R2**). **Status:** revision 4 (Policy B) approved: `CONTRACT-APPROVED agent-remote-auth v1 revision 4 @7d85748` (board #34 comment 6344626717, relaying the human's decision; PR #194 approval comment 6344615320) after Lane B's `CONTRACT-ACK` (comment 6343887844). The human selected revision 4 and not the separate revision-3 Policy A alternative. Revision 2 had been approved earlier (`CONTRACT-APPROVED agent-remote-auth v1 revision 2 @bbd361e`, comment 6321077051, integrated in comment 6321122478). **Revision 3** (§15) was published at `af482b0` (comment 6343901071) and acknowledged by Lane B as a Policy A candidate (comment 6343970266). It has no approval of its own: its additions are contained in revision 4, which is the approved text, and the revision-3 Policy A alternative was not selected. **Revision 4** (§15, this text) is the approved amendment on top of revision 3, published at `7d85748` (comment 6343901071). It changes when a used code revokes (Policy B, decision 13). Fixtures and schemas keep their approved bytes; this paragraph only records the status. The status text that follows is kept for history, including its statements that nothing was implemented at publication; implementation state is in the board's `INTEGRATED` comments (for example comment 6371328798) and both remote flags stay off: Lane A posts `CONTRACT-PUBLISHED agent-remote-auth v1 @<sha>` on board #34 for the commit that carries this text. Nothing here is implemented, and nothing is default-on. It needs Lane B's `CONTRACT-ACK` and a version-specific `CONTRACT-APPROVED agent-remote-auth v1 @<publication sha>` before any dependent work starts. The server work is a new A-4.x task; the client work is B-R3.

**Fixtures:** [`test/contract-fixtures/agent-remote-auth/`](../../../test/contract-fixtures/agent-remote-auth/). It holds:
- `schemas.json`: draft-07 schemas plus the machine-readable tables `x-codes`, `x-oauth-errors`, `x-limits`, `x-scopes`, `x-route-availability`, `x-delivery-availability`, `x-client-metadata-checks`, `x-redirect-rules`, `x-authorize-checks`, `x-token-checks`, `x-consent-display`, `x-consent-decisions` and `x-endpoints`;
- one JSON file per case. The PKCE verifiers and challenges in them are real S256 pairs made for the fixtures; every code, token and secret is a placeholder.

**Owner:** Lane A. **Consumers:** Lane B (B-R3): the owner consent page, `/connect` and `skill.json` route guidance, and the remote MCP and provider host setup notes. Every real remote MCP client and reviewed provider connector consumes it too.

**What it covers.** The two connection routes that agent-registration v1 reserved for A-3.1b (its §1: "never in v1 (A-3.1b)"):
- **`remote_mcp_oauth`:** a cloud assistant with remote MCP support and no local command runner connects to Envoi's hosted `/mcp` with OAuth 2.1;
- **`provider_connector`:** a reviewed provider connects through the same OAuth flow as a pre-registered client, or, if it has only a private credential field, through the single-use bootstrap code of v3 §31 and §42 (§8).

It specifies discovery metadata, client identification, the authorization request, the owner consent that **is** the human claim, the token endpoint, refresh, revocation, the resource-server behaviour of `/mcp`, flags and rollback.

**Standards.** Envoi is both the authorization server and the resource server. The contract follows the MCP authorization specification, revision 2026-07-28 (OAuth 2.1 draft 13, RFC 6750, RFC 8414, RFC 8707, RFC 9207, RFC 9728, RFC 7009, and OAuth Client ID Metadata Documents draft 00). Where this contract is stricter than those documents, it says so. It supports no OpenID Connect: Envoi issues no ID tokens, and serves no `openid-configuration`.

**One state machine.** This is not a second onboarding backend. Every route here reaches the same registration, approval, activation, installation, credential family and agent operations as agent-registration v1:
- the consent page runs agent-registration §5.1 (who may claim) and §5.3 (targets, permissions, slots, holds, staleness);
- the token exchange runs agent-registration §6.1 rows 10–12 (re-checks) and §6.3 (what activation does);
- the tokens are ordinary A1 credentials (`envoi_agent_access_…`, `envoi_agent_refresh_…`) of an ordinary credential family, with two additions: an **audience** and an **OAuth client** (§6.1);
- the agent operations are agent-registration §6.6's, reached through `/mcp`.

It builds on `a3-pause-auth` v3 (envelope, codes, pause), `agent-registration` v1 revision 4 (registrations, installations, owner eligibility), `envoi-names` v1 (credential formats), `envoi-browser-names` v1 (cookies, CSRF) and `http-wake` v1 (destination safety, §4.2 here).

**Not in this contract.**
- **Wake (corrected in revision 3).** An installation made here declares `on_demand` (§1). In v1 it has **no wake path**:
  - its audience-bound tokens are refused at `/api/agent/wake-subscriptions`, like every route except `/mcp` (§9);
  - no `/mcp` tool creates a subscription, so it cannot add an http-wake v1 subscription.

  Nothing here claims that such an assistant can be reached while its user does not have it open. A wake path would need its own contract and review, for example a `/mcp`-scoped wake tool. This contract adds no audience exception for REST. Provider-native wake (`provider`) is a later contract too.
- **The owner "On demand" label.** a5-presence v1 has no honest label for `on_demand`. §1 makes the route depend on that revision before its flag is turned on.
- **Dynamic Client Registration.** Deprecated in the MCP specification; not offered (§3, decision 1).
- **Authenticated REST.** That route keeps agent-registration v1's bootstrap-token mechanics.
- **A named provider.** Passing these fixtures does not establish Muse, ChatGPT, Grok/xAI, Instinct or any other host. Each needs its own hosted evidence (v3 §47).

### 1. Flags and route availability

| Flag (server-only, default off) | Turns on |
| --- | --- |
| `ENVOI_REMOTE_MCP_OAUTH` | The `remote_mcp_oauth` route: discovery (§2), client metadata documents (§3.1), authorization (§4), consent (§5), the token and revocation endpoints (§6, §7) for clients on this route, and the `/mcp` challenge (§9). |
| `ENVOI_PROVIDER_CONNECTORS` | The `provider_connector` route: the same endpoints for pre-registered provider clients (§3.2), and the bootstrap code (§8). |

Both require `ENVOI_AGENT_REGISTRATION_V2` and `ENVOI_INSTALLATIONS_V2`. Startup fails closed if either is on while those are off, as agent-registration §1 does.

**Route availability.** `GET /api/onboarding/routes` keeps its agent-registration v1 shape. These rows replace that contract's "never in v1 (A-3.1b)" rows (`x-route-availability`, `x-delivery-availability`):

| Route or mode | Available when |
| --- | --- |
| `remote_mcp_oauth` | both V2 flags and `ENVOI_REMOTE_MCP_OAUTH` are on |
| `provider_connector` | both V2 flags and `ENVOI_PROVIDER_CONNECTORS` are on |
| delivery mode `on_demand` | both V2 flags, and either route flag, are on |
| delivery modes `webhook`, `provider`, `poll`, `a2a` | unchanged (never, in this contract) |

`on_demand` means the host acts only while its user has it open, or when another trigger outside Envoi starts it. It is a **declaration**, like every delivery mode. Activation through this contract always declares it; agent-registration's public activation still refuses it for `local_helper` and `authenticated_rest` (§11).

**Before either flag is turned on** (human only):
1. an a5-presence revision gives `on_demand` an honest owner label and connection state, so an installation that is not running is not shown as failing (v3 §45);
2. the route's hosted gate passes (v3 §47, breadth items 1 and 2).

**Flag off.** Every endpoint in `x-endpoints` returns `404 FEATURE_DISABLED` (a3 envelope) when no route flag that serves it is on. A pre-registered client whose route flag is off is unknown (§3). The `/mcp` challenge drops `resource_metadata` (§9), and tokens issued here stop working (§11).

### 2. Discovery

Envoi's origin is the origin of `ENVOI_PUBLIC_URL`, the same value `/connect` uses. Every URL below is built from it, never from the `Host` header.

| Name | Value |
| --- | --- |
| Resource (canonical MCP server URI) | `${origin}/mcp` |
| Issuer | `${origin}` (no path, no trailing slash) |

#### 2.1 Protected resource metadata (RFC 9728)

`GET /.well-known/oauth-protected-resource/mcp` (the path form) and `GET /.well-known/oauth-protected-resource` (the root form) take no auth and return the **identical** `protectedResourceMetadata` body, served with `cache-control: public, max-age=300`:

```json
{ "resource": "https://www.envoi-agents.com/mcp",
  "authorization_servers": ["https://www.envoi-agents.com"],
  "scopes_supported": ["envoi.agent", "envoi.send", "envoi.files", "envoi.cases"],
  "bearer_methods_supported": ["header"],
  "resource_name": "Envoi",
  "resource_documentation": "https://www.envoi-agents.com/connect" }
```

`scopes_supported` lists every scope a client may request (§4.3). The client's usual starting set comes from the `/mcp` challenge (§9).

#### 2.2 Authorization server metadata (RFC 8414)

`GET /.well-known/oauth-authorization-server` takes no auth and returns `authorizationServerMetadata`, with `cache-control: public, max-age=300`:

| Field | Value |
| --- | --- |
| `issuer` | `${origin}`, exactly the value the client built the URL from |
| `authorization_endpoint` | `${origin}/oauth/authorize` |
| `token_endpoint` | `${origin}/oauth/token` |
| `revocation_endpoint` | `${origin}/oauth/revoke` |
| `response_types_supported` | `["code"]` |
| `response_modes_supported` | `["query"]` |
| `grant_types_supported` | `["authorization_code", "refresh_token"]`, plus the bootstrap grant (§8) while `ENVOI_PROVIDER_CONNECTORS` is on |
| `code_challenge_methods_supported` | `["S256"]` |
| `token_endpoint_auth_methods_supported` | `["none", "client_secret_basic"]` |
| `revocation_endpoint_auth_methods_supported` | `["none", "client_secret_basic"]` |
| `scopes_supported` | the four scopes of §2.1 |
| `client_id_metadata_document_supported` | `true` while `ENVOI_REMOTE_MCP_OAUTH` is on, otherwise `false` |
| `authorization_response_iss_parameter_supported` | `true` |
| `service_documentation` | `${origin}/connect` |

There is **no** `registration_endpoint` (§3) and no `jwks_uri`: tokens are opaque.

`GET /.well-known/openid-configuration` is `404`. Clients that try OpenID Connect discovery first fall back to RFC 8414, as the MCP specification requires them to.

### 3. Clients

A `client_id` is either an HTTPS URL (a client metadata document, §3.1) or a pre-registered id (§3.2). Anything else is unknown. An unknown or invalid client is never redirected to (§4.1).

#### 3.1 Client metadata documents (`remote_mcp_oauth`)

Only while `ENVOI_REMOTE_MCP_OAUTH` is on. The `client_id` is the URL of the client's own JSON document.

**The URL** passes every `x-client-metadata-checks` rule, else the client is invalid:
- at most 2,048 characters; parsed by the WHATWG URL parser;
- scheme `https`; no user name or password; port 443 or none;
- a path other than `/`; no query; no fragment;
- not Envoi's own origin;
- the http-wake v1 §4.1 name rules (no address literal, no reserved name, not a self host) and §4.2 address rules: every resolved address must be allowed, resolution uses the configured resolvers, and the fetch is pinned to the checked addresses.

**The fetch:** `GET`, with `accept: application/json`, no cookies and no credentials; no redirects; a 5 s deadline; a 5,120-byte body limit; `200` only; content type `application/json`.

**The document** must be a JSON object that satisfies `clientMetadataDocument`:
- `client_id` equals the URL **exactly** (string comparison);
- `client_name`: 1–80 characters, refusing the same control, zero-width and bidirectional characters as agent-registration §3;
- `redirect_uris`: 1–10 URIs, each obeying §3.3;
- `token_endpoint_auth_method`, if present: `none`. A metadata document client is always a **public** client;
- `grant_types`, if present: a subset of `authorization_code` and `refresh_token`, containing `authorization_code`;
- `response_types`, if present: `["code"]`;
- `client_uri` and `logo_uri`, if present: HTTPS URLs. Envoi never fetches them and never shows the logo (decision 5);
- other members are ignored.

**Caching.** A valid document is cached for its `cache-control` `max-age`, clamped to 300–86,400 s; `no-store` counts as 300 s. A failed fetch is not cached. The cache is keyed by the exact `client_id`.

**Its route** is always `remote_mcp_oauth`.

#### 3.2 Pre-registered clients

Envoi's operators configure these in `ENVOI_OAUTH_CLIENTS`, a JSON array. Each entry is `preRegisteredClient`:

| Field | Rule |
| --- | --- |
| `clientId` | `client_` + 3–40 of `[a-z0-9-]`. Never a URL, so it cannot collide with §3.1. |
| `clientName` | As `client_name` in §3.1. Shown to owners. |
| `connectionRoute` | `provider_connector` or `remote_mcp_oauth`. |
| `redirectUris` | As §3.3. May be empty only for a bootstrap-only client (§8). |
| `tokenEndpointAuthMethod` | `none` or `client_secret_basic`. |
| `clientSecretSha256` | Required exactly for `client_secret_basic`: the lowercase hex SHA-256 of the secret. The secret itself is never in configuration or logs. |
| `bootstrapCode` | `true` lets owners issue bootstrap codes for this client (§8). Requires `client_secret_basic` and `provider_connector`. |
| `provider` | A short label for the reviewed provider, shown to owners. |

Startup fails closed on an invalid entry. A pre-registered client is usable only while its route's flag is on. Adding one is an operator change reviewed with that provider's own gate; it is not an API.

#### 3.3 Redirect URIs (`x-redirect-rules`)

A redirect URI must be one of:
- `https:` with a host name (no address literal), no user name or password, and no fragment;
- `http:` to the loopback address `127.0.0.1` or `[::1]`, with any port, no user name or password, and no fragment (OAuth 2.1 §8.4.2). `localhost` is refused: OAuth 2.1 recommends against it, because a name can resolve elsewhere.

No custom schemes in v1 (decision 6).

**Matching.** The authorization request's `redirect_uri` is required, and must equal one registered URI **exactly**, as strings. The one exception is the loopback rule: for an `http:` loopback URI the port is ignored in the comparison, and everything else must still match exactly.

### 4. Authorization request

`GET /oauth/authorize`. The host's own browser, or the user's, opens it.

#### 4.1 Checks

The server checks the query in `x-authorize-checks` order. The first failing check decides the response:

| # | Check | On failure |
| --- | --- | --- |
| 1 | A route flag is on | `404 FEATURE_DISABLED` |
| 2 | Every parameter appears at most once | `302` to Envoi's own `/authorize-agent?error=invalid_request` |
| 3 | `client_id` names a valid client (§3) | `302` to `/authorize-agent?error=invalid_client` |
| 4 | `redirect_uri` matches one of the client's (§3.3) | `302` to `/authorize-agent?error=invalid_redirect_uri` |
| 5 | `response_type` is `code` | redirect to the client with `unsupported_response_type` |
| 6 | `code_challenge` is present, 43 base64url characters | redirect to the client with `invalid_request` |
| 7 | `code_challenge_method` is `S256` (absent counts as `plain`, which is refused) | redirect to the client with `invalid_request` |
| 8 | `resource` is present and equals the resource exactly (§2) | redirect to the client with `invalid_target` |
| 9 | `scope`, if present, is a set of `x-scopes` names containing `envoi.agent` | redirect to the client with `invalid_scope` |
| 10 | `state`, if present, is 1–512 printable ASCII characters | redirect to the client with `invalid_request` |
| 11 | The encoded handle (§4.2) is at most 2,048 characters (revision 3) | redirect to the client with `invalid_request` |

**Row 11 (revision 3).** Each parameter can be valid on its own and the request still too large to seal. That can happen with a `client_id` of up to 2,048 characters, a `state` of up to 512 and the redirect URI, plus the encryption and encoding overhead. The server therefore measures the handle it would issue: the exact string after encryption and base64url encoding, which is what appears in the URL. It does this after rows 1–10 pass.
- Up to 2,048 characters: the handle is issued.
- Longer: `invalid_request` to the checked `redirect_uri`, with `state` and `iss`.
- The server never truncates a bound field, never drops one from the seal, and never weakens the seal to fit.
- Like every authorization `GET`, a refused request stores nothing.

Fixtures: `authorize-handle-at-limit` and `authorize-handle-overflow`. They carry the measured length in `context.sealedHandleLength`, because the exact length depends on the implementation's sealing format.

**Never redirect to an unchecked URI.** Rows 2–4 send the browser to Envoi's own page, which explains the problem and links nowhere else. From row 5 on, the error goes to the checked `redirect_uri` as `error`, `error_description`, `state` (if sent) and `iss` (the issuer), per RFC 6749 §4.1.2.1 and RFC 9207. Every `302` here has `cache-control: no-store` and `referrer-policy: no-referrer`.

`state` is optional on the wire, as OAuth 2.1 allows, but every client should send it. `resource` is **required**: the MCP specification requires clients to send it, so a missing one is a broken client.

#### 4.2 Success

On success the server creates **nothing durable**. It seals the validated request into an **authorization request handle** and returns `302` to `${origin}/authorize-agent?request=<handle>`:
- the handle is opaque, at most 2,048 characters as encoded (row 11 refuses a request whose handle would be longer), and expires `x-limits.authorizationRequestTtlSeconds` (600 s) after it is made;
- it binds the client, the redirect URI as requested (loopback port included), the code challenge, the scope set, the state and the resource;
- it is integrity-protected and encrypted under a key derived from `ENVOI_DATA_ENCRYPTION_KEY`, so it cannot be edited or read;
- it is **not a credential**: holding it does nothing without a signed-in human (§5).

An unauthenticated `GET` therefore writes no store record and cannot fill one. This is the reason it is a sealed value.

#### 4.3 Scopes (`x-scopes`)

| Scope | Permission (agent-registration §5.3) | Notes |
| --- | --- | --- |
| `envoi.agent` | `receive_agent_messages` | Required in every request and grant. Identity, work availability, claim, reply to a received case and settlement. |
| `envoi.send` | `send_agent_messages` | Start cases and message other agents. |
| `envoi.files` | `create_assets` | Share files. |
| `envoi.cases` | `execute_cases` | Act on cases (case-tools v1). |

`use_email_transport` has **no** scope in v1. It cannot be granted through this contract (decision 7).

A request without `scope` asks for `envoi.agent envoi.send`, the same set as the `/mcp` challenge. Requested permissions are the scopes mapped through this table. The agent asks; it never grants (v3 §40).

### 5. Consent: the human claim

`/authorize-agent` is an owner page (Lane B). The human signs in there if needed and the page then continues with the same handle. **Approving this page is the human claim** (v3 §45): one consent issues the grant, with no limited first grant to widen later.

#### 5.1 Reading the request

`GET /api/oauth/authorization-requests/{handle}`, human session, returns `consentView`:
- `client`: `name` (as a `displayName`), `clientIdHost` (the host of a URL client id, or `null` for a pre-registered client), `redirectHost` (the redirect URI's host and, for loopback, the port), `loopbackRedirect` (boolean), `registration` (`metadata_document` or `pre_registered`) and `provider` (pre-registered clients only);
- `connectionRoute`;
- `requestedPermissions` and `grantablePermissions` (requested ∩ organization maximum), as in agent-registration §5.2;
- `expiresAt`, the handle's expiry;
- `decision`: present exactly when **this** human already decided the handle. It is the `consentDecided` body of §5.2, or `{ "status": "denied" }` after a deny. The page then shows the outcome instead of the form, so a reload never offers the same decision twice.

**What the page must show** (`x-consent-display`):
- the client name **as a claim the client makes**, beside the host it came from (`clientIdHost`) or the provider;
- `redirectHost`, always. The MCP specification requires it;
- for a loopback redirect, a warning that any program on that computer could receive the authorization, and that the user should approve only a connection they just started;
- the requested permissions, through agent-registration's `x-permission-labels`;
- the target choice of agent-registration §5.3: a new agent in a workspace the human manages, or an existing agent the owner UI offers for reconnect (revision 4 eligibility).

The page never shows the handle's contents in raw form and never fetches `client_uri` or `logo_uri`.

The checks are agent-registration §5.1's: a human session, the beta allowlist re-evaluated now, and the assurance rule. A handle that is malformed, tampered, already decided by another human, or expired without a decision by this human gets `404 AUTHORIZATION_REQUEST_INVALID`, identical in every case. A handle this human approved stays readable for as long as its registration is kept; a denied one, until it expires (§5.2, "Retention").

#### 5.2 Approve

`POST /api/oauth/authorization-requests/{handle}/approve`, human session and CSRF. The body is `consentApproveRequest`, which is agent-registration's `claimApproveRequest` without `verificationCode`:

```json
{ "target": { "kind": "new_agent", "workspaceInboxId": "inbox_…", "name": "…", "localPart": "…" },
  "grantedPermissions": ["send_agent_messages", "receive_agent_messages"], "policyProfile": "default" }
```

Everything in agent-registration §5.3 applies unchanged: the permission intersection, agent slots, address holds, `replacesInstallationId`, the live management check and the policy profile. The precedence is §5.3's, with the code step replaced by the handle:
1. session and CSRF, then `ACCOUNT_CHANGED`;
2. `RATE_LIMITED` (`x-limits.consentApprovalsPerHumanPerHour`, 10);
3. **the handle:** for a handle this human already approved, the identical body gets `200 consentDecided` ("Retrying an approval", below), never the code again. Any other body, or approving after denying, gets `409 CLAIM_ALREADY_DECIDED`. Any other unusable handle gets `404 AUTHORIZATION_REQUEST_INVALID`;
4. `CLAIM_INVALID`;
5. `CLAIM_FORBIDDEN`;
6. `AGENT_NOT_RECONNECTABLE`, `CLAIM_STALE`, `ADDRESS_TAKEN`, `ACTIVE_AGENT_LIMIT` or `PENDING_ACTIVATION_LIMIT`.

**What approval does.** In one transaction the server:
- creates an agent registration with `status: approved`, the client's `connectionRoute`, `runtime: { type: "remote_mcp", version: null }` (`provider_connector`: `{ type: "provider", version: null }`), and the decision fields of agent-registration §5.3;
- records the decision against the handle: the human, a SHA-256 digest of the request body, and the registration id. It never records the code, the `redirectTo` or any other response that contains the code;
- issues one **authorization code**: `envoi_oauth_code_` + 32 random bytes, base64url, stored only as SHA-256, single use, expiring `x-limits.authorizationCodeTtlSeconds` (60 s) after approval. The code's expiry is the registration's `activationExpiresAt`. The code appears in exactly **one** response, this first `200`, and nothing that could rebuild it is kept.

The registration then behaves like any approved one: it holds its address and slot, appears in the owner's `GET /api/agent-claims`, and can be withdrawn there (agent-registration §5.4). It has no bootstrap token and no verification code. Audit: `agent.registration_approved`, as today, with the route.

**`200` `consentApproved`**, with `cache-control: no-store`:
- `redirectTo`: the request's `redirect_uri` with `code`, `state` (if sent) and `iss` added as query parameters;
- `registrationId`, `target`, `workspaceName`, `agent { name, address, id? }`, `effectivePermissions`, `policyProfile` and `codeExpiresAt`.

The page navigates the browser to `redirectTo`. This is the one place an authorization code crosses a browser, as OAuth requires (v3 §45). It is not an agent credential, and it is useless without the client's PKCE verifier.

**Retrying an approval** (`x-consent-decisions`). The code is returned once. A repeated identical approve by the same human gets `200` `consentDecided`, with `cache-control: no-store`. That covers a lost response, a reload, a double click, and a server restart in between. The status is derived from the stored registration at the time of the retry, so it survives a restart:

| `status` | When | The page shows |
| --- | --- | --- |
| `pending_exchange` | Approved; the code is unused and `codeExpiresAt` has not passed. | "Approved. Go back to your assistant to finish connecting. If it doesn't connect, start again from your assistant." It also shows that the approval lapses at `codeExpiresAt`, and offers Withdraw (agent-registration §5.4, with `registrationId`). |
| `completed` | The code was exchanged, so activation happened (§6.1), whatever has happened to the installation since. | "Connected. You can close this page." |
| `expired` | The code was never exchanged, and `codeExpiresAt` passed. | "This approval expired before your assistant finished. Start again from your assistant." |
| `withdrawn` | A manager withdrew it (agent-registration §5.4), or an exchange-time re-check failed (§6.1 row 10). | "This approval no longer holds. Start again from your assistant." |

`consentDecided` carries `status`, `registrationId`, `target`, `workspaceName`, `agent`, `effectivePermissions`, `policyProfile` and `codeExpiresAt`. It has **no** `redirectTo` and no code.

**The page never navigates on `consentDecided`.** It navigates to the client only on the first `200 consentApproved`. So an honest retry can never send a used code back through the token endpoint, where §6.1 row 9 would revoke the installation. It can never strand the user at the client with an expired code either. The token endpoint's reuse check and revocation are unchanged.

**Recovery is a new authorization.** If the first response never reached the page, the host never receives the code, and its authorization never completes. The user starts again from the assistant, which sends a new authorization request with a new handle. The server never issues a second code for a decided handle, and never creates a second registration for it. The unused approval holds its address, slot and waiting-approval count only until `codeExpiresAt` (60 s), or until it is withdrawn. A new `new_agent` approval for the same address inside that window gets `ADDRESS_TAKEN`, so the page offers withdrawing the pending approval first.

**Retention.** A decided handle keeps getting `consentDecided`, and `decision` in §5.1, after its own 600 s expiry, for as long as its registration is kept (agent-registration §2: at least 24 h). After cleanup it gets `404 AUTHORIZATION_REQUEST_INVALID`, like any unknown handle. A denied handle has no registration, so its decision lasts only until the handle itself expires (600 s); after that a repeated deny, or a read, also gets `404 AUTHORIZATION_REQUEST_INVALID`.

#### 5.3 Deny

`POST /api/oauth/authorization-requests/{handle}/deny`, human session and CSRF, empty body → `200 { redirectTo }`, with `error=access_denied`, `state` and `iss`. Nothing is created. The same human repeating it gets the identical `200`; its `redirectTo` carries no code, so it can be rebuilt from the handle and the page may navigate again. Denying a handle this human approved gets `409 CLAIM_ALREADY_DECIDED`.

### 6. Token endpoint

`POST /oauth/token`, `content-type: application/x-www-form-urlencoded`. It reads no cookies, takes no CSRF header, and is not a browser route. Every response has `cache-control: no-store` and `pragma: no-cache`.

**Errors** use the OAuth error body `oauthError` (`{ error, error_description? }`, RFC 6749 §5.2), not the a3 envelope. `error_description` is fixed text from `x-oauth-errors`, never a token, and never says which check failed beyond the error name. Status `400`, except `invalid_client`, which is `401` and, when the client used `client_secret_basic`, carries `www-authenticate: Basic realm="Envoi"`. Rate limiting is `429` with `retry-after` and `error: temporarily_unavailable` (`x-limits.tokenRequestsPerSourcePerMinute`, 60).

**Client authentication.** A public client sends `client_id` in the body and no secret. A `client_secret_basic` client sends HTTP Basic and no `client_id` in the body, or the same one; any mismatch, a missing or wrong secret, or a secret sent by a public client is `invalid_client`.

#### 6.1 Authorization code grant

Parameters: `grant_type=authorization_code`, `code`, `redirect_uri`, `code_verifier` (43–128 characters of the RFC 7636 alphabet), `resource`, and `client_id` (public clients).

Checks, in `x-token-checks` order. The first failure decides:

| # | Check | Error |
| --- | --- | --- |
| 1 | A route flag is on | `404 FEATURE_DISABLED` (a3 envelope) |
| 2 | Parameters are present, each once, and well formed | `invalid_request` |
| 3 | The client authenticates (§6) | `invalid_client` |
| 4 | The code exists and was issued to this client | `invalid_grant` |
| 5 | The code has not expired | `invalid_grant` |
| 6 | `redirect_uri` equals the authorization request's exactly | `invalid_grant` |
| 7 | `BASE64URL(SHA-256(code_verifier))` equals the code challenge | `invalid_grant` |
| 8 | `resource` equals the resource | `invalid_target` |
| 9 | The code has not been used | `invalid_grant`, and the installation the first exchange activated is revoked (below) |
| 10 | The registration is still `approved`, and agent-registration §6.1's re-checks pass | `invalid_grant`. The registration becomes `withdrawn`, as in agent-registration §6.1 row 11. |

Every failure from row 4 on also counts toward the rate limit. **Revision 4 (Policy B).** The reuse check, row 9, comes after every check that makes a request valid: parameters, client authentication, the client binding, expiry, the exact redirect, PKCE and the resource. A used code is therefore always denied. It revokes only when the replay is otherwise a valid token request, as OAuth 2.1 draft-16 §4.1.3 and §7.5.3 require. A replay that fails an earlier row gets that row's error and revokes nothing. Revision 2's order (reuse at row 5, before expiry, redirect, PKCE and resource) is replaced.

**Activation.** When every check passes, the exchange **is** the activation of agent-registration §6.1 row 12 and §6.3, for `deliveryMode: on_demand`:
- `new_agent` creates the agent, its dedicated inbox and directory entries;
- `existing_agent` replaces every active installation, sets the permissions, releases held leases, and closes old streams;
- the installation and its credential family are created together, as in agent-registration §6.3.

The credential family stores two new facts:
- **`audience`:** the resource. Its tokens are accepted only at `/mcp` (§9);
- **`oauthClientId`:** the client. Refresh and revocation must come from the same client.

**`200` `tokenResponse`:**

```json
{ "access_token": "envoi_agent_access_…", "token_type": "Bearer", "expires_in": 900,
  "refresh_token": "envoi_agent_refresh_…", "scope": "envoi.agent envoi.send" }
```

- `expires_in` is the configured access-token lifetime (`ENVOI_AGENT_ACCESS_TOKEN_TTL_SECONDS`, default 900);
- the refresh token follows A1: the family's `refreshExpiresAt` is extended by the inactivity lifetime on every rotation, and is never immortal;
- `scope` lists the **effective** permissions mapped back through `x-scopes`, in table order. It may be narrower than the request, because the owner can grant less. A client must read it.

Audit: `agent.installation_activated`, as today.

**A used code** (row 9) means two parties may hold one code. As OAuth 2.1 §4.1.3 recommends, the server revokes the installation the first exchange created, if it is still active, exactly as agent-registration §6.1 row 7a does: the family's `revokedReason` is `revoked`, the installation records `replayDetectedAt` and ends with `activation_replay`, and the audit event is `agent.activation_replay_detected`. The identity is not frozen.

**Who can trigger that revocation (revision 4, Policy B; decision 13).** Only a party that sends an otherwise valid token request: the right client, authenticated, with the exact `redirect_uri`, the matching verifier and the resource, while the code is unexpired. That is the genuine replay case (`token-code-reused`), and it still revokes.
- **A leaked code and the public `client_id` alone revoke nothing.** A missing or malformed verifier fails row 2 with `invalid_request` (`token-code-reused-missing-verifier`, `token-code-reused-malformed-verifier`). A well-formed but wrong verifier fails row 7 with `invalid_grant` (`token-code-reused-wrong-verifier`).
- **Other invalid replays revoke nothing either:**
  - a wrong `redirect_uri` fails row 6 (`token-code-reused-wrong-redirect`);
  - a wrong resource fails row 8 with `invalid_target` (`token-code-reused-wrong-resource`);
  - the identical request after the code's 60 s fails row 5 (`token-code-reused-expired`).
- **A genuine replay is not an escalation.** It never yields a token, it never touches any other installation, and the identity stays unfrozen, so the owner reconnects the same agent.
- **It is confined to the original installation, while that installation is still active:**
  - a code presented by another client revokes nothing (row 4; `token-code-reused-other-client`);
  - a confidential client whose authentication fails revokes nothing (row 3; `token-code-reused-confidential-auth-failed`);
  - a code whose installation has already ended revokes nothing further (`token-code-reused-installation-ended`).
- **The code never leaves the browser redirect or the host:** codes, verifiers and code-bearing URLs stay out of logs, audits, model context and browser storage (§10).

**Standards note (revision 3).** Revision 2's phrase "As OAuth 2.1 §4.1.3 recommends" is accurate about *revoking* on reuse, but not about *when*. OAuth 2.1 (draft-ietf-oauth-v2-1-16) words it conditionally:
- **§4.1.3** has the server deny a *second valid* token request for a used code, and revoke what that code issued where possible;
- **§7.5.3** says to revoke only when the request, including `code_verifier` and client authentication, is valid. It recommends against revoking for a replay with invalid parameters, because invalid requests would then let an attacker revoke a legitimate client's tokens;
- **RFC 7636 §4.6** has a matching verifier continue normal processing, and a mismatch get `invalid_grant`.

Revision 2's row 5, which revoked before the redirect, PKCE and resource checks, was **Envoi's own, earlier revocation policy**. It was stricter than that draft's validity condition, and the standard does not require it. Revision 4 adopts the draft's condition (Policy B, decision 13).

**No lost-response recovery.** A token response that never arrives cannot be fetched again, unlike agent-registration §6.2. The client starts a new authorization. The owner then sees the agent under "Reconnect an existing agent" and approves it as `existing_agent`, which replaces the installation the lost response created (decision 2).

#### 6.2 Refresh grant

Parameters: `grant_type=refresh_token`, `refresh_token`, `client_id` (public clients), and optionally `scope` and `resource`.

| # | Check | Error |
| --- | --- | --- |
| 1 | A route flag that serves this client is on | `404 FEATURE_DISABLED` |
| 2 | Parameters are well formed | `invalid_request` |
| 3 | The client authenticates | `invalid_client` |
| 4 | The token is a refresh token of a family issued to this client (`oauthClientId`) | `invalid_grant`. A refresh token of a `local_helper` family, or of another client, is unknown here. |
| 5 | The family is not revoked, and `refreshExpiresAt` has not passed | `invalid_grant` |
| 6 | The token is the family's **current** refresh token, or the previous one inside the recovery window (below) | otherwise `invalid_grant`, and the family is revoked as `refresh_replay` |
| 7 | `scope`, if present, equals the family's current scopes | `invalid_scope`. Narrowing is not supported in v1. |
| 8 | `resource`, if present, equals the family's audience | `invalid_target` |

On success: `200` `tokenResponse` with a **new** access token and a **new** refresh token. Refresh tokens always rotate, which the MCP specification requires for public clients. A1's `rotationId` does not exist in OAuth, so the server keys recovery differently.

**Recovery window** (`x-limits.refreshRecoverySeconds`, 60 s, decision 3). After a rotation the server keeps an AES-GCM envelope of the response, keyed like A1's from the **old** raw refresh token. If the same client presents that old token again within 60 s, **and** neither successor token has been used yet, it gets the identical `200` again. Any other reuse is replay: the family is revoked with `reason: "refresh_replay"`, a3 holders get `CREDENTIAL_REVOKED`, and the installation ends with `refresh_replay` (agent-registration §6.4). The first use of a successor deletes the envelope.

**Paused agents.** Refresh succeeds while the agent is paused (a3 §14). The tokens still get `409 AGENT_PAUSED` at `/mcp`.

### 7. Revocation (RFC 7009)

`POST /oauth/revoke`, form body `token` and optional `token_type_hint`, with the same client authentication as §6.
- A token of a family issued to this client, access or refresh: the **family is revoked** with `reason: "revoked"`. Its installation ends with `revoked`, holders get `CREDENTIAL_REVOKED`, and streams close with `credential.ended`. The identity is not frozen: the owner can reconnect it (agent-registration revision 4). Audit: `agent.installation_revoked`, with actor `client`.
- An unknown, expired or already-revoked token: `200`, and nothing changes (RFC 7009 §2.2).
- A token of a family issued to **another** client, or of a family with no client (`local_helper`): `400 unauthorized_client`, and nothing changes.

The `200` body is empty. A client revokes when its user disconnects Envoi in the host. The owner's own revoke (agent-registration §6.5) is unchanged and works on these installations too.

### 8. Bootstrap code (provider fallback)

v3 §31 and §42 allow one exception to "no operational secret in a human browser": a provider whose connector can store only a **private credential field** can receive a single-use code that the owner pastes into that field. This section defines it. It is available only while `ENVOI_PROVIDER_CONNECTORS` is on, and only for a pre-registered client with `bootstrapCode: true` (§3.2), which in turn needs that provider's reviewed design and gate (v3 §45).

**Issue.** `POST /api/oauth/bootstrap-codes`, human session and CSRF. The body is `bootstrapCodeRequest`: `clientId` plus the approve body of §5.2. The checks and precedence are §5.2's, with step 3 being "the client is a bootstrap client", else `404 AUTHORIZATION_REQUEST_INVALID`. On success the server creates an approved registration exactly as §5.2 does, with `connectionRoute: provider_connector`, and issues:
- `bootstrapCode`: `envoi_boot_` + 32 random bytes, base64url, stored only as SHA-256, single use;
- `expiresAt`: `x-limits.bootstrapCodeTtlSeconds` (600 s) after issue. It is the registration's `activationExpiresAt`.

`201` `bootstrapCodeIssued`, with `cache-control: no-store`, carries the code **once**. The owner page shows it once, with the provider's name, and tells the owner to paste it only into that provider's credential field, never into a chat. Issuing again creates a second registration; it does not repeat the code. Not issuing a code for a lost response is safe: the registration expires and grants nothing.

**Exchange.** The provider's backend calls `POST /oauth/token` with `grant_type=urn:envoi:params:oauth:grant-type:bootstrap_code`, `bootstrap_code`, `resource`, and HTTP Basic client authentication. A public client cannot use this grant (`unauthorized_client`). The checks are §6.1 rows 1–5 and 8, then row 9 (reuse; an otherwise valid replay revokes the installation it created), then row 10, applied to the code. As in §6.1, the reuse check comes after every validity check (revision 4). The success response and activation are §6.1's.

**What it never is.** It is never an access or refresh token, never valid at `/mcp` or any other route (`AUTHENTICATION_REQUIRED`), never in a URL or log, and useless without the provider's client secret.

### 9. `/mcp` as the resource server

The existing `/mcp` endpoint keeps its tools and behaviour. While `ENVOI_REMOTE_MCP_OAUTH` or `ENVOI_PROVIDER_CONNECTORS` is on, these rules are added:

**Challenge.** Every `401` from `/mcp` carries:

```text
WWW-Authenticate: Bearer resource_metadata="https://www.envoi-agents.com/.well-known/oauth-protected-resource/mcp", scope="envoi.agent envoi.send"
```

When the request carried a bearer token that failed, the header also has `error="invalid_token"`. The body keeps the a3 envelope and code (`AUTHENTICATION_REQUIRED`, `CREDENTIAL_REVOKED`, `CREDENTIAL_EXPIRED` and so on). With both flags off the header is today's `Bearer realm="Envoi agent MCP"`.

**Audience.** A token whose family has an `audience` is accepted **only** at that resource, `/mcp`. On every other route, including `/api/agent/*` and `/api/inboxes/*`, it is an unrecognized bearer: `401 AUTHENTICATION_REQUIRED`, identical to an unknown token. Tokens without an audience (`local_helper`, `authenticated_rest`, legacy) keep working everywhere they work today, `/mcp` included.

**Insufficient scope.** A tool call that needs a permission the family does not have gets `403 INSUFFICIENT_SCOPE` (a3 envelope) with:

```text
WWW-Authenticate: Bearer error="insufficient_scope", scope="envoi.send", resource_metadata="…"
```

`scope` names every scope the call needs, in `x-scopes` order. A client may then re-authorize with the union of its scopes and these; the owner approves that as `existing_agent`, which replaces the installation (§5.2). For families without an audience, a missing permission keeps today's response.

**Pause.** Unchanged: `409 AGENT_PAUSED` as an HTTP status, never a JSON-RPC result with an error (a3 §3, agent-registration §6.6).

**No pass-through.** The server never forwards a token it received to any other service.

### 10. What the model may see

Nothing new. The OAuth flow runs between the host, the browser and Envoi:
- the authorization URL, the handle, the code, the code verifier and every token stay with the host and the browser. The host must keep them out of the model's context; that is part of each host's evidence (v3 §47);
- tool results through `/mcp` are unchanged, and carry no credential;
- agent-registration §7's never-list gains `envoi_oauth_code_…`, `envoi_boot_…`, client secrets, authorization request handles and code verifiers.

### 11. Codes, compatibility and rollback

**a3-envelope codes** (`x-codes`), on `/mcp`, the owner routes and the disabled endpoints:

| Code | HTTP | Surface: lifecycle / retry / guidance |
| --- | --- | --- |
| `FEATURE_DISABLED` | 404 | host: `REGISTRATION_ENDED` / none / `route_unavailable`; owner_ui: `NOT_APPLICABLE` / none / `route_unavailable` |
| `AUTHORIZATION_REQUEST_INVALID` | 404 | owner_ui: `NOT_APPLICABLE` / none / `start_again` |
| `INSUFFICIENT_SCOPE` | 403 | host: `UNCHANGED` / none / `reauthorize` |
| `AUTHENTICATION_REQUIRED`, `ACCESS_TOKEN_EXPIRED` | 401 | host: `UNCHANGED` / `refresh_then_retry_once` / none (a3's connector row) |
| `CREDENTIAL_REVOKED` | 401 | host: `REVOKED` / none / `owner_reconnect`. The identity is not frozen, so the owner reconnects it, rather than a3's `owner_reenroll`. |
| `AGENT_PAUSED` | 409 | host: `PAUSED` / `after_resume` / `wait_for_resume` (a3) |

The owner routes also return agent-registration's `CLAIM_INVALID`, `CLAIM_FORBIDDEN`, `CLAIM_ALREADY_DECIDED`, `AGENT_NOT_RECONNECTABLE`, `CLAIM_STALE`, `ADDRESS_TAKEN`, `ACTIVE_AGENT_LIMIT`, `PENDING_ACTIVATION_LIMIT`, `RATE_LIMITED` and `ACCOUNT_CHANGED`, with their `owner_ui` rows unchanged. `/mcp` keeps every a3 code.

**OAuth errors** (`x-oauth-errors`) are only on `/oauth/token`, `/oauth/revoke` and the client redirect: `invalid_request`, `invalid_client`, `invalid_grant`, `unauthorized_client`, `unsupported_grant_type`, `unsupported_response_type`, `invalid_scope`, `invalid_target`, `access_denied`, `temporarily_unavailable`.

**Compatibility.**
- `GET /api/onboarding/routes` keeps its shape and its `contract` value; only availability changes, and only with the new flags.
- agent-registration's public activation refuses `on_demand` for its own routes (`400 DELIVERY_MODE_NOT_AVAILABLE`), so this contract adds no declarable mode to them.
- Installation and owner views are unchanged in shape: an installation made here shows `connectionRoute: remote_mcp_oauth` or `provider_connector`, `deliveryMode: on_demand` and its `runtime`.
- A local-helper token at `/mcp` behaves as today, except that a `401` gains the challenge header while a flag is on.

**Rollback** (flags off): every endpoint here returns `404 FEATURE_DISABLED`; consent pages report the route unavailable; a token whose family has an `audience` gets `401 AUTHENTICATION_REQUIRED` at `/mcp`, without the challenge. **Nothing is revoked or deleted.** Installations stay `active` in the owner views and the owner can still revoke them. Turning the flag on again restores every family that has not expired, and refresh continues. Approved registrations whose codes expire while the flag is off expire normally. No data migration exists in either direction.

### 12. Fixtures

| Group | Fixtures |
| --- | --- |
| Availability and discovery | `routes-available-remote-mcp`, `routes-available-provider`, `protected-resource-metadata`, `protected-resource-metadata-root`, `authorization-server-metadata`, `discovery-feature-disabled` |
| `/mcp` challenge | `mcp-challenge-unauthenticated`, `mcp-challenge-invalid-token`, `mcp-insufficient-scope`, `mcp-paused-oauth-token`, `oauth-token-refused-on-rest` |
| Authorization request | `authorize-redirects-to-consent`, `authorize-loopback-redirect`, `authorize-unknown-client`, `authorize-client-id-mismatch`, `authorize-redirect-uri-mismatch`, `authorize-pkce-missing`, `authorize-pkce-plain`, `authorize-resource-missing`, `authorize-scope-invalid`, `authorize-feature-disabled`, `authorize-handle-at-limit`, `authorize-handle-overflow` |
| Consent | `consent-view`, `consent-view-loopback`, `consent-view-decided`, `consent-request-invalid`, `consent-approve-new-agent`, `consent-approve-existing-agent`, `consent-approve-other-body`, `consent-deny`, `consent-agent-limit` |
| Consent retry | `consent-approve-retry-pending`, `consent-approve-retry-completed`, `consent-approve-retry-expired`, `consent-approve-retry-withdrawn`, `consent-approve-lost-response` |
| Token: authorization code | `token-authorization-code`, `token-pkce-mismatch`, `token-redirect-uri-mismatch`, `token-resource-mismatch`, `token-code-expired`, `token-code-reused`, `token-code-reused-wrong-verifier`, `token-code-reused-missing-verifier`, `token-code-reused-malformed-verifier`, `token-code-reused-wrong-redirect`, `token-code-reused-wrong-resource`, `token-code-reused-expired`, `token-code-reused-other-client`, `token-code-reused-confidential-auth-failed`, `token-code-reused-installation-ended`, `token-approval-withdrawn`, `token-public-client-secret` |
| Token: refresh | `token-refresh`, `token-refresh-recovered`, `token-refresh-replay`, `token-refresh-other-client`, `token-refresh-scope-changed`, `token-refresh-paused`, `token-rate-limited` |
| Revocation | `revoke-refresh-token`, `revoke-unknown-token`, `revoke-other-client` |
| Bootstrap code | `bootstrap-code-issued`, `bootstrap-code-exchanged`, `bootstrap-code-public-client`, `bootstrap-code-at-mcp` |
| Owner view and rollback | `owner-installations-oauth`, `rollback-flags-off` |

### 13. Decisions for review

These are Lane A's proposals. Any of them can change before approval.

1. **Client metadata documents and pre-registration only, no Dynamic Client Registration** (§3). The MCP specification deprecates DCR. Offering it would mean an unauthenticated route that writes client records. The cost: a host that supports only DCR cannot connect until it adopts metadata documents or is pre-registered.
2. **No lost-response recovery for the code exchange** (§6.1). OAuth codes are single use, and code reuse revokes, as OAuth 2.1 recommends. A lost response costs one more consent and an `existing_agent` reconnect, which is visible and safe. Agent-registration's `activationId` recovery has no OAuth equivalent a generic client would send.
3. **A 60-second refresh recovery window** (§6.2). Without it, one lost refresh response revokes the installation, because the next try looks like replay. Without `rotationId` the window is keyed by the old token alone, and it closes as soon as a successor is used. The stricter alternative is no window at all, as plain OAuth 2.1 rotation does.
4. **Audience-bound tokens, accepted only at `/mcp`** (§9). RFC 8707 and the MCP specification require it. The alternative, also accepting them on REST, would make the REST route reachable without its own registration path and gate.
5. **No logos, and the client name shown as a claim beside its host** (§3.1, §5.1). A logo fetch is another SSRF and tracking surface, and a picture adds no proof.
6. **No custom-scheme redirect URIs in v1** (§3.3). Desktop clients use loopback; mobile and custom schemes can be a later revision after a real client needs them.
7. **No email-transport scope** (§4.3). External email through a remote assistant needs its own review.
8. **Four coarse scopes, one per permission** (§4.3). Finer scopes (for example read-only) would need new permissions in agent-registration first.
9. **The sealed handle instead of a stored pending request** (§4.2). An unauthenticated `GET` writes nothing. The cost: a handle cannot be revoked before it expires. That is harmless, because a handle grants nothing without a signed-in human's decision.
10. **`on_demand` for every installation made here** (§1), with the flag waiting for an a5-presence label. The alternative, declaring `envoi_link`, would claim a running host process that a cloud assistant does not have.
11. **The code is returned once; a retry gets a decision outcome** (§5.2, revision 2). The alternative is to keep an encrypted copy of the first response for the code's 60 s life. That needs key binding, a TTL, deletion and replay limits, and it would still have to refuse a retry once the code is used. It adds a stored secret and saves the user nothing: either way, a host that missed the code must start again.
12. **Approval.** Version-specific `CONTRACT-APPROVED agent-remote-auth v1 @<publication sha>` after Lane B's `CONTRACT-ACK`. It does not authorize any provider's gate or any flag change.
13. **When a used code revokes (revisions 3 and 4; Je's decision).** Two policies, compared with revision 2's row numbers:
   - **Policy A (revision 2, approved; kept by revision 3).** Row 5 checks reuse after client authentication (row 3) and the client check (row 4), and revokes before the expiry, redirect, PKCE and resource checks (rows 6–9).
   - **Policy B (revision 4, this amendment).** Reuse is still always denied. But it revokes only when the rest of the request is valid. In revision 4's numbering, the order is: parameters (2), client authentication (3), client binding (4), expiry (5), redirect (6), PKCE (7), resource (8), then reuse (9), then the registration re-checks (10). This is OAuth 2.1 draft-16 §4.1.3 and §7.5.3.

   | Replayed used code, still-active original installation | Policy A (approved) | Policy B |
   | --- | --- | --- |
   | Same client; correct verifier, `redirect_uri` and resource; code unexpired (`token-code-reused`) | `invalid_grant`, **revokes** | `invalid_grant`, **revokes** |
   | Same public `client_id`; verifier **missing or malformed** (not 43–128 characters of the RFC 7636 alphabet) | `invalid_request` at row 2, **no revoke** | `invalid_request` at row 2, **no revoke** |
   | Same public `client_id`; verifier **well formed but wrong** (`token-code-reused-wrong-verifier`) | reaches row 5: `invalid_grant`, **revokes** | `invalid_grant` at the PKCE check, **no revoke** |
   | Same client; wrong `redirect_uri` or resource | `invalid_grant`, **revokes** | `invalid_grant` or `invalid_target`, **no revoke** |
   | Same client and verifier, but the code is past its 60 s | `invalid_grant`, **revokes** ("even after expiry") | `invalid_grant`, **no revoke** |
   | Another client (`token-code-reused-other-client`) | `invalid_grant`, no revoke | same |
   | Confidential client, failed authentication (`token-code-reused-confidential-auth-failed`) | `401 invalid_client`, no revoke | same |
   | Original installation already ended (`token-code-reused-installation-ended`) | `invalid_grant`, nothing further | same |

   In both policies:
   - a replay never yields a token;
   - revocation ends only the original installation, and only while it is still active;
   - the identity stays unfrozen.

   Row 2, parameter validation, comes first in both policies. A missing or malformed verifier therefore never reaches a reuse check, and never revokes.

   **What the choice is.** Should a party holding a leaked code and the public `client_id`, but **not** the verifier, be able to end the original installation by sending any well-formed verifier? Under Policy A it can; that is a denial of service the owner repairs by reconnecting. Under Policy B it cannot. A holder of both code and verifier can still trigger revocation under either policy while the code is unexpired.
   - **What Policy B gives up:** revocation for a replay that arrives after the code's 60 s lifetime, and for a replay that fails another check (wrong redirect or resource).
   - **What it gains:** it follows the draft's validity condition, and removes the code-only denial of service. With a 60 s single-use code, PKCE and an exact redirect match, a replay with the verifier inside the code's lifetime is the case that indicates a real second holder. Policy B still revokes then.

   **Lane A's recommendation (corrected).** Policy B, which revision 4 specifies. It aligns with OAuth 2.1 draft-16 §7.5.3 and narrows the trigger to a holder of the verifier, without weakening the genuine-replay revocation. An earlier version of this decision said that under Policy B a code stolen together with its verifier would revoke nothing. That was wrong, as the first row of the table shows.

   **The choice.**
   - **Policy A:** approve revision 3 and not revision 4.
   - **Policy B:** approve revision 4. It contains revision 3, changes `x-token-checks` and §6.1's table, turns `token-code-reused-wrong-verifier` into a no-revoke case, and adds the missing-verifier, malformed-verifier, wrong-redirect, wrong-resource and expired replay cases. The genuine replay (`token-code-reused`) still revokes.

   Nothing here selects a policy for Je.
14. **Refuse an oversized handle rather than shrink it (revision 3).** Row 11 refuses with `invalid_request`. The alternative, storing a pending request and sending only its id, would make an unauthenticated `GET` write storage (decision 9).
15. **No wake path for these installations in v1 (revision 3).** The revision-2 text promised an http-wake subscription that audience binding makes impossible. A `/mcp`-scoped wake tool, or any other path, is a separate contract.

### 14. Implementation notes (Lane A; informative)

- **One approval module.** Consent and bootstrap issue call the same approval code as `POST …/approve` (agent-registration §5.3, `src/agent-approval.js`), with a decision source of `oauth_consent` instead of a verification code. Activation is the same `activateRegistration` path, entered from the token endpoint.
- **Stored family fields.** `audience` and `oauthClientId` are new fields on the stored credential family. agent-registration's `storedCredentialFamily` schema is closed, so its stored-shape fixtures need a revision note when this lands.
- **Audience check.** Do it in `checkAgentCredential`, before route dispatch. The existing `/mcp` handler calls the REST routes over loopback with the caller's `authorization` header. Those internal calls must be marked as coming from `/mcp` in a way no external request can forge, or the handler must call the services directly.
- **Client metadata fetch.** Reuse the http-wake destination module (`src/http-wake-destination.js`) for name rules, resolution and pinning; do not write a second SSRF filter.
- **Runtime.** These routes run in the Node container. The Cloudflare Worker must route `/.well-known/oauth-*`, `/oauth/*` and `/authorize-agent` to it and must pass the metadata `cache-control` through `withNoStoreHeaders` (as for the wake key set). The new settings are added to `CONTAINER_ENV_KEYS`.
- **Audit types.** None are new, so Lane B's `WORKSPACE_EVENT_TYPES` needs no pairing change. `agent.installation_revoked` gains the actor value `client`.

### 15. Revisions before approval

**Revision 4: Policy B** (proposed amendment on top of revision 3; Je asked for it to be prepared for Lane B review). This is not an approval of either revision.
1. **Check order** (§6.1 table, `x-token-checks`): the reuse check moves after every validity check. Code grant: route flag, parameters, client authentication, client binding, expiry, redirect, PKCE, resource, **reuse**, registration re-checks. Bootstrap grant: route flag, parameters, client authentication, client binding, expiry, resource, **reuse**, registration re-checks.
2. **Effects.** A used code is always denied, and only an otherwise valid replay revokes the original installation. Client authentication, the client binding (row 4) and installation-only revocation are unchanged; so are the unfrozen identity and the denial of every replay.
3. **Fixtures.**
   - `token-code-reused` (the genuine replay) still revokes.
   - `token-code-reused-wrong-verifier` now revokes nothing.
   - New: `token-code-reused-missing-verifier`, `token-code-reused-malformed-verifier`, `token-code-reused-wrong-redirect`, `token-code-reused-wrong-resource` and `token-code-reused-expired`. Each refuses at its own row and revokes nothing.
   - `token-code-reused-other-client`, `-confidential-auth-failed` and `-installation-ended` are unchanged. There are 70 fixtures.
4. **Text.** §5.2's reference moves to row 9. The §6.1 trigger paragraph and standards note, §8's bootstrap checks and decision 13 are updated.


**Revision 3** (after approval of revision 2). This answers the gaps Lane A reported in [6324594912](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6324594912), which Lane B confirmed in [6325070244](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6325070244). The approved check order and every revision-2 response are unchanged.
1. **Wake.** The "Not in this contract" text claimed an http-wake subscription for these installations. Audience binding refuses that, and no MCP tool exists for it. The text now says there is no wake path in v1 and no audience exception (decision 15).
2. **Used-code revocation.** §6.1 now states who can trigger row 5's revocation and what it is confined to. New fixtures: `token-code-reused-wrong-verifier`, `token-code-reused-other-client`, `token-code-reused-confidential-auth-failed` and `token-code-reused-installation-ended`. The policy is a decision for Je (decision 13).
   - **Correction** (Lane B MISMATCH [6330139979](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6330139979), [review](https://github.com/rachelgonsalves821/Envoi/pull/187#issuecomment-6330134936), [standards](https://github.com/rachelgonsalves821/Envoi/pull/187#issuecomment-6330122547)):
     - decision 13 no longer claims that revoking after PKCE would spare a code stolen with its verifier;
     - it compares Policy A and Policy B case by case;
     - it attributes the validity condition to OAuth 2.1 draft-16 §4.1.3 and §7.5.3, and RFC 7636 §4.6;
     - the §6.1 standards note states that revision 2's early revocation is Envoi's policy, not the standard's;
     - Lane A's recommendation changes to Policy B, which would be a separate amendment. The fixtures and the approved order are unchanged.
3. **Handle length.** New check, row 11 (`x-authorize-checks`, after `state`). It measures the encoded handle and refuses one over 2,048 characters with `invalid_request` at the checked redirect, with `state` and `iss`, never truncating. New fixtures: `authorize-handle-at-limit` and `authorize-handle-overflow` (decision 14).

The contract stays v1: this clarifies approved behaviour and adds no wire field. It needs Lane B's `CONTRACT-ACK` and Je's `CONTRACT-APPROVED agent-remote-auth v1 revision 3 @<publication sha>`. RA-A1 part 1 (#177) already implements row 11 as published here, behind flags that are off. It is not integrated before that approval.


**Revision 2** (this publication) answers Lane B's [`MISMATCH` 6319543594](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6319543594) ([review](https://github.com/rachelgonsalves821/Envoi/pull/171#issuecomment-6319539287)) on revision 1 @`f103660`. The contract stays version 1, because nothing has been approved or implemented.

1. **Approval retry and code storage.** Revision 1 replayed the original `200`, code included, while storing the code only as SHA-256; the two cannot both hold. Now the code is in exactly one response and is never stored in clear or in an envelope. A repeated identical approve gets `consentDecided` (§5.2), with no code. The fixture `consent-approve-replayed` is replaced by `consent-approve-retry-pending`.
2. **The boundary after an exchange or expiry.** `consentDecided` reports `pending_exchange`, `completed`, `expired` or `withdrawn`, and the page never navigates on it. An honest retry therefore never reaches the token endpoint's reuse revocation, which is unchanged (`token-code-reused`). New fixtures: `consent-approve-retry-completed`, `consent-approve-retry-expired`, `consent-approve-retry-withdrawn`, `consent-approve-lost-response` (lost response, then a restart, then expiry) and `consent-view-decided`.
3. **Additions.** `consentView` gains the optional `decision` (§5.1), and `schemas.json` gains `consentDecided` and `x-consent-decisions`. Nothing else in the wire contract changes.

## provider-gateway-native v1

**Contract:** `provider-gateway-native`, version 1 (Lane A backlog item 3 of board #34 comment 6371261746; Phase B backlog B-R5/B-R8, Instinct). **Status:** approved by the human on 2026-10-24 (`CONTRACT-APPROVED provider-gateway-native v1 @f56e3c4`, board #34 comment 6389743298, revision 2) after Lane B's `CONTRACT-ACK` (comment 6389723646) and green exact-head CI (run 40133226145). Revision 1 (@9b13fa3) and the earlier revision-2 heads (@b785836, @ddf8df0, @9bca238) answered Lane B's `MISMATCH` rounds (comments 6373764561 and 6375143615) and are superseded history that was never approved; the contract stays v1. The human approved all seven section 8 decisions, the UTF-8 byte limits and the standing-consent and per-item owner-decision requirements. Frozen: changes need a new version. The approved contract bytes are unchanged by this status line. This approves the contract only: nothing here is implemented, nothing is default-on, and no flag changes. It extends the approved-for-Stage-1 `provider-browser-poll` v1 without changing any of its routes, schemas or fixtures.

**Fixtures:** [`test/contract-fixtures/provider-gateway-native/`](../../../test/contract-fixtures/provider-gateway-native/): `schemas.json` (tables `x-flags`, `x-endpoints`, `x-actions`, `x-limits`, `x-no-exposure`, `x-codes`, `x-states`) and 51 cases. Revision 2 adds `x-utf8-guards`, `x-claim-replay`, `x-session-repair`, `x-clocks` and `x-check-order`. Executable checks: `test/contract-fixtures.test.js` and `test/contract-provider-gateway-native.test.js`.

**Owner:** Lane A. **Consumers:** Lane B (the gateway's host setup guidance and scheduled task prompt) and the owner UI.

### 1. Route selected, and why

Instinct's reported mechanism is a **scheduled HTTPS run** that can use a browser session. The trusted-persistent-process `authenticated_rest` helper rejects `scheduledPolling` (a host that runs only on a schedule cannot keep a supervised process), and no private credential custody inside Instinct is proven. Stage 1 (`provider-browser-poll`) can read and notify but cannot claim, reply or settle. So this contract selects the **Stage 2 gateway**: the **server-held installation credential** claims, replies and settles on the host's behalf, one bounded item at a time, while the host holds only the delegated gateway cookie and CSRF token. The alternative, host-held credentials calling REST natively on a schedule, stays unselected until the account proves private credential storage and a scheduled HTTPS client (a separate contract if so). **No email bridge is selected** and none is specified here.

| Flag (server-only, default off; startup fails closed if a requirement is off) | Turns on |
| --- | --- |
| `ENVOI_PROVIDER_GATEWAY_NATIVE_V1` | The three work routes and the owner scope route below. Requires `ENVOI_PROVIDER_BROWSER_POLL`, `ENVOI_CASE_SESSIONS_V1`, `ENVOI_INSTALLATIONS_V2`, `ENVOI_AGENT_REGISTRATION_V2`. |

Flag off: the routes return `404 FEATURE_DISABLED` (`claim-flag-off`), delegations behave as read/notify, held leases are released without consuming attempts, sent replies stay sent, and Stage 1 is unchanged (`rollback-flag-off`). Turning it back on never resurrects `native_work` from a stored record: each delegation needs the owner's scope approval again.

### 2. Principals, binding and custody

1. **Credential custody.** Unchanged from Stage 1 (§5 of that contract): the installation's access and refresh tokens live only in the gateway's encrypted record; renewal and rotation are server-internal with one persisted operation and canonical lost-response recovery. The host never sees, and the model never receives, an operational token, a lease token, a case-session token, a family, installation, owner or workspace id (`x-no-exposure`). Hosts hold the Stage 1 cookie `__Host-envoi_agent_gateway` and CSRF token; every new POST uses the Stage 1 origin, content-type, encoding and 8 KiB rules.
2. **Scope is explicit (`scope-upgrade-owner`, `claim-read-only-session`, `scope-upgrade-from-gateway-session-denied`).** A delegation has scope `read_notify` (Stage 1) or `native_work`. The signed-in owner, with CSRF, assurance, the comparison phrase and `expectedRevision`, grants `native_work` through `POST /api/inboxes/{inboxId}/agents/{agentId}/installations/{installationId}/gateway-scope`. That records the owner's grant, bumps the session generation and ends the old cookie and CSRF token at once; **it issues no cookie** (see 2a). A delegated cookie cannot call it, and a read/notify session gets `403 GATEWAY_SCOPE_DENIED` on the work routes. Effective rights remain the installation's approved permissions intersected with live policy; stored scope never widens a later reduction.
2a. **The replacement session (G1: `old-session-refused-after-upgrade`, `repair-pairing-created`, `repair-activate-native-scope`, `claim-new-generation-ok`, `x-session-repair`).** The host gets its generation-N+1 session only through the existing Stage 1 owner-confirmed repair of the same installation, with no new route: (1) the old cookie is refused with `401 GATEWAY_SESSION_EXPIRED`, reason `generation_changed`, and retries do not renew it; (2) the host runs the unchanged Stage 1 `POST /api/agent-gateway/pairings` (the body is the Stage 1 closed object, `requestedPermissions: ["receive_agent_messages"]`; the scope never comes from the request); (3) the owner confirms at `/claim` for the exact existing installation, with the comparison phrase and current assurance, and the confirmation shows `native_work`; (4) the Stage 1 `POST /api/agent-gateway/pairing/activate` returns the new `__Host-` cookie with scope `native_work`, clears the pending cookie, and carries no credential in the body. The new session's absolute lifetime is seven days **from the owner confirmation**, never from the old session and never longer. Effective rights are the installation's approved permissions intersected with the granted scope. A delegated cookie cannot upgrade itself (`scope-upgrade-from-gateway-session-denied`). **Controlled clocks and the CSRF step (`repair-sequence`, `repair-acquire-session-csrf`, `reply-sent-after-repair`).** Every step runs at a declared server clock (`context.asOf`) and the times strictly increase: owner upgrade 12:00:00, old-cookie refusal 12:00:05, pairing 12:00:20, owner confirmation 12:05:00, activation 12:05:05, then the replacement session reads the existing Stage 1 inbox shell (`GET /agent-gateway/inbox`) for its generation-bound synchronizer token at 12:05:10 (the generation-4 token is not accepted), claims at 12:05:20 (lease to 12:07:50) and replies at 12:05:40 inside that live lease and its run budget. The seven-day bound is exactly seven days from 12:05:00. A lease can never precede the authorization that allows it, and the repaired reply is its own fixture: the generation-4 `reply-sent` does not stand in for it (the `consent-model` sequence now names `reply-sent-after-repair`).
3. **Tenant and owner binding.** Every id is server state bound to the session (`ownerId, workspaceId, agentId, installationId, credentialFamilyId, generation`). No request carries one. Opaque `workRef`, `caseRef`, `receiptRef`, `requestRef` are session-scoped and expire with the run.

### 3. Claim, lease and settlement

1. **Claim (`POST /api/agent-gateway/work/claim` `{runId}`; `claim-work`, `claim-idle`).** **Claim replay (G2: `claim-lost-response-replay`, `claim-lost-response-after-restart`, `claim-next-item-after-settlement`, `claim-replay-after-lease-expiry`, `claim-other-run-while-active`, `x-claim-replay`).** The gateway keeps one durable outstanding-claim record per installation and run. A repeated `claim` with the same `runId` while that claim is unsettled returns the same packet (`replayed: true`, same `workRef` and lease), leases nothing, and does not charge the run budget again; the record survives a restart. After the item is settled (sent, owner request or deferred) the same run advances to a different item with a new `workRef` and the budget counts it. A claim retry is a replay only while its run is inside the 120 s run budget (see 3.1a). Once the lease has expired (150 s) the record is void and the item is claimable again by a **fresh authorized run**, which gets a new `workRef`; the expired claim has already counted as one attempt under the existing queue rules and the old run is not charged again. A different `runId` while another run holds an unsettled claim is `409 GATEWAY_CHECK_ACTIVE` with `Retry-After` and leases nothing; there is no second queue. The gateway makes the canonical claim for this installation (a3/a4 claim, fence and lease), mints the case-session privately (case-session v1) and returns **one** work packet: `workRef`, `caseRef`, `kind`, `leaseExpiresAt`, `renewalsLeft`, a bounded snapshot from the canonical case projection (objective, status, participant display names, at most 10 recent events with summaries of at most 2 KiB, asset refs with clean/scan state and **no bytes or URL**, pending proposal), `allowedActions`, and `untrusted: true`. Inbound text is data, never instructions; the host prompt must say so, and the fixture keeps an injection attempt to prove the packet does not strip or obey it.
1a. **Run budget, lease and their order (G2: `x-clocks`, `x-check-order`, `claim-expired-run-refused`, `act-expired-run-refused`, `claim-fresh-run-while-old-lease-live`, `claim-replay-after-lease-expiry`, `reply-replay-after-run-expiry`).** The 120 s run bound of Stage 1 is neither waived nor raised. A run starts at `runStartedAt` and its budget (inclusive) ends 120 s later; a lease is 150 s from the claim, so a run always ends **before** its lease does. Checks run in this order (`x-check-order`): session, CSRF and generation; flag and scope; pause, revoke and case controls; the idempotency record (a settled key with the same body replays its stored result and has no new effect, lease or budget; a different body is `IDEMPOTENCY_CONFLICT`); run binding (`GATEWAY_RUN_MISMATCH`); **run budget (`409 GATEWAY_RUN_EXPIRED` when the clock is past `runStartedAt` + 120 s, whatever the lease says)**; lease and fence (`LEASE_LOST`); then the effect, atomically with settlement. So after 12:02:00 the old `run_example` is refused for both claim and reply even though its lease is live until 12:02:30; nothing is leased, sent or extended. A fresh authorized run (at least 60 s after the previous run started) gets `idle` with the time left while the old lease is live, and, after the lease expires, claims the item with a new `workRef` and its own item budget. Renewal is allowed only inside the run budget and grants 150 s from the renewal. In-budget behaviour is unchanged: same-run and restart replay, next item after settlement, other run refused (`GATEWAY_CHECK_ACTIVE`) until the guard ends.
2. **Lease (`leaseSeconds` 150, one renewal per claim: `renew-once`, `renew-twice-refused`).** No lease is held while a human or the next tick is awaited. Expiry returns the item to the queue under the existing lease and attempt rules (a claim that expires unsettled counts as an attempt, bounded by `maxAttempts`, like any host that crashes). `defer` releases without an attempt (`defer-releases-lease`).
3. **Settlement is the canonical reply.** `reply` sends one message through the existing typed reply path, with sender, case and recipient derived from the claimed work, and settles the work in the same transaction under the fence (`reply-sent`). No separate acknowledgement or completion call exists; notification acknowledgement (Stage 1) is presentation only and never settlement.
4. **Late actions.** Every act re-checks the lease and fence, the session generation and expiry, current membership and permission, agent pause and case controls. A lost lease, another run's `workRef`, a pause, a revoke or an expired session is refused with no effect (`reply-lease-lost`, `reply-wrong-run`, `reply-after-pause`, `reply-after-revoke`, `claim-session-expired`).
5. **Limits and missed ticks (`x-limits`, `claim-run-budget-reached`, `claim-before-min-interval`, `missed-tick-and-restart`).** At most 3 items and 120 s per run, 6 actions per run, 60 s between runs, 60 replies per owner per hour, 4 KiB reply text. A skipped tick causes no catch-up burst; durable queue state, not the schedule, decides what is processed. Presence is overdue only after cadence plus grace (Stage 1 §7). A server restart loses nothing: leases, idempotency records and the notification ledger are durable.

### 4. Actions, idempotency and correlation

1. **Byte limits (G3: `x-utf8-guards`, `reply-text-*`, `claim-summary-truncated-on-code-point`).** `replyTextMaxBytes` (4,096) and `summaryMaxBytes` (2,048) are **UTF-8 bytes, not characters**; the schema's `maxLength` is only a coarse upper bound. `act` text over 4,096 bytes, even with fewer characters (1,100 four-byte characters are 4,400 bytes), is `400 GATEWAY_REQUEST_INVALID` with reason `text_too_long` and sends nothing; exactly 4,096 bytes is accepted and 4,097 refused. Inbound summaries are cut at 2,048 bytes on a code point boundary with `truncated: true`, never mid-character, and the 64 KiB response and 8 KiB request caps still apply as whole-message byte limits.

**Closed set (`x-actions`).** `act` takes `{runId, workRef, idempotencyKey, action, text?}`. v1 supports `reply`, `request_owner` and `defer`. Proposals, decisions, case completion, new cases and **every asset operation** are not in v1 (`act-action-unsupported`); fields for a recipient, case, attachment or URL are refused, never ignored (`act-request-invalid-extra-field`). A later contract adds more by reusing case-tools v1.
2. **Idempotency (`reply-replayed-same-key`, `reply-key-conflict`).** The server key is `{installationId, workRef, idempotencyKey}` with the canonical request digest. The same key and body return the original result with `replayed: true` and no second message; the same key with a different body is `409 IDEMPOTENCY_CONFLICT`.
3. **Correlation.** `runId` binds every packet and action to one run (Stage 1 serializes runs per installation). `receiptRef` is the canonical receipt of the reply, not proof the human saw it.
4. **Outage (`service-unavailable-recovers`).** `503 GATEWAY_TEMPORARILY_UNAVAILABLE` claims no effect; the same key is safe to retry within the run budget.

### 5. Consent

1. **Standing consent** is exactly what the owner approved at pairing or scope upgrade: the permission set (`receive_agent_messages`, `send_agent_messages`, `execute_cases`), cadence, alert destination and absolute lifetime, re-approved at each 7-day re-pairing. It covers only actions current policy allows for this agent and case.
2. **Per-item consent** is the existing policy and human-request flow. When policy requires a human decision, nothing is sent: the item opens an owner request and the result is `owner_approval_pending` with `settled: false` (`reply-needs-owner-approval`, `request-owner`). The owner decides in the dashboard; the decision binds exact case, recipient, content and generation, and a changed detail needs a fresh decision. The gateway, the host and any browser click cannot approve, and no recurring task waives owner MFA or assurance.
3. Provider-side prompts (for example a host that asks its own user to approve each write) are the host's behaviour. They are observed and reported, not assumed or controlled.

### 6. Pause, resume, revoke

Pause: `409 AGENT_PAUSED` on every work route, leases released as held, order preserved (D1), no notification or claim state change (`claim-paused`). Resume needs no new identity and re-checks the delegation. Revoke or an ended installation invalidates the session and generation before any further effect and rejects late replies; a stranded host task keeps no access. Session end is not agent-wide revoke. Reconnect or a new browser profile is owner-authorized same-identity attachment, never a revived family.

### 7. What this does not do

It does not make Instinct "automatic". A scheduled run is a host schedule, not a closed-app proof: acceptance still needs the owner's real account, a real read-back task, two differently timed closed-app arrivals each producing one canonical reply, a missed run and restart, a denied write, pause/resume/revoke and a late run rejected, with exact hashes and the human's countersign. Both Muse and Instinct stay OPEN. It adds no email route, no general proxy, no raw token, no second reply store and no second queue.

### 8. Decisions for review

1. **Server-held credential gateway (chosen) vs host-held credentials.** The second needs proven private custody in a scheduled Instinct runtime.
2. **Reply-only first (chosen).** Proposals, decisions, completion and assets wait for a later revision over case-tools v1.
3. **Claims that expire unsettled consume an attempt (existing rule)** vs a gateway-specific exemption. A 30-minute cadence makes repeated crashes expensive; the bound is `maxAttempts`.
4. **`native_work` needs the owner's explicit upgrade (chosen)** rather than being implied by the Stage 1 approval.
5. **Replacement session through the existing owner-confirmed repair (chosen, G1)** rather than a new endpoint that issues cookies at upgrade time. It reuses Stage 1 unchanged and keeps the owner present for the cookie that carries write authority; the cost is one more owner step.
6. **Outstanding-claim replay keyed by run (chosen, G2)** rather than a client-supplied claim key, so the Stage 1 `runId` stays the only correlation id.
7. **Run budget stays 120 s and is checked before the 150 s lease (chosen, G2)** rather than exempting retries or lengthening the run. The cost is that a host that overruns its run must start a fresh run and may wait until the actual outstanding lease expires. A lease is 150 s from its claim or renewal, so an in-budget last claim or renewal can leave up to 150 s after the run ends (in the fixtures: the run ends 12:02:00, the next-item lease expires 12:03:30, 90 s later, and the renewed lease expires 12:04:30, 150 s later); 30 s applies only to an initial claim at the start of the run with no renewal. The benefit is one bound, one queue and no duplicate item budget.

### 9. Implementation notes (Lane A, informative)

Extend `src/provider-browser-poll*.js` with the work routes calling the existing claim, case-session and typed-reply services under `gateway-installation:{id}` locks; scope field and generation in the gateway record in both storage backends; owner route and flag in `src/server.js` and `src/onboarding-flags.js`. Dependent implementation starts only after Lane B's `CONTRACT-ACK` and the human's exact `CONTRACT-APPROVED`. Tests: the 51 fixtures with FileStore and PostgreSQL parity for idempotency, fences, lease expiry, generation bumps and flag-off release; Stage 1 suites unchanged.

> Implementation-preparation receipt (2026-10-24): the publication below is human-approved at `32975892945718296a4968a3d6ddbc40ef6d175b`, board #34 comment 6374090183. Its original publication-era status text is retained verbatim; the board approval and registry status govern. No new contract decision is made here.

## mcp-wake v1

**Contract:** `mcp-wake`, version 1 (Lane A backlog item 1 of board #34 comment 6371261746; Phase B backlog B-R8, MCP-scoped part). **Status:** published, awaiting Lane B's `CONTRACT-ACK` and a version-specific `CONTRACT-APPROVED mcp-wake v1 @<publication sha>`. Nothing here is implemented, nothing is default-on, and no flag changes. It does not amend approved `agent-remote-auth` v1 revision 4 or `http-wake` v1: it adds an operation surface beside them.

**Fixtures:** [`test/contract-fixtures/mcp-wake/`](../../../test/contract-fixtures/mcp-wake/): `schemas.json` (tables `x-flags`, `x-tools`, `x-binding`, `x-wake-origins`, `x-limits`, `x-notification`, `x-url-extra-reasons`, `x-codes`, `x-tool-errors`) and 22 cases. Executable checks: `test/contract-fixtures.test.js` (generic) and `test/contract-mcp-wake.test.js`.

**Owner:** Lane A. **Consumers:** Lane B (the provider-connector client and `/connect` guidance) and the backend of every reviewed provider connector.

### 1. The gap and the answer

agent-remote-auth ("Not in this contract") left installations made by OAuth with no wake path: their audience-bound tokens are refused on `/api/agent/wake-subscriptions` (§9), and no `/mcp` tool creates a subscription. This contract adds four `/mcp` tools that drive the **existing** http-wake v1 subscription, key set, notification, retry and derivation machinery. Nothing is a second queue, a second signer or a second delivery engine, and REST keeps refusing audience tokens (fixture `rest-route-refuses-audience-token`).

| Flag (server-only, default off) | Turns on |
| --- | --- |
| `ENVOI_MCP_WAKE_V1` | The four tools below in `tools/list` and `tools/call`. Requires `ENVOI_HTTP_WAKE_V1`, `ENVOI_INSTALLATIONS_V2`, `ENVOI_AGENT_REGISTRATION_V2` and `ENVOI_PROVIDER_CONNECTORS`; startup fails closed if any is off. |

Flag off: `tools/list` is exactly the 19 `envoi-names` tools, byte for byte (`tools-list-flag-off`), and a call is an unknown tool (`create-flag-off-unknown-tool`). **Rollback:** subscriptions created through these tools carry a stored `createdVia: "mcp"` (never in a response). While the flag is off they read `ended` with `endedReason: "feature_disabled"` from the first read or attempt after the flag-off start, derived per attempt as http-wake §1 derives its epoch. REST-created subscriptions and the http-wake epoch are untouched (`rollback-flag-off`).

### 2. Who may use it: binding and custody

1. **Route and client (§2.1).** The caller's credential family must be audience-bound to `/mcp` **and** belong to a **pre-registered provider client** (agent-remote-auth §3.2) with at least one declared wake origin. A client identified by a client metadata document (`remote_mcp_oauth`) has no wake path in v1 (`WAKE_ROUTE_NOT_SUPPORTED`, `create-cimd-client-not-supported`): a public cloud-assistant client has no backend to receive a wake and cannot keep the OAuth tokens private from the model. A host credential that is not audience-bound uses the REST routes (`create-non-audience-token`); a scoped read token never sees the tools (`create-mcp-read-token-unavailable`).
2. **Tenant, owner, installation (§2.1).** All ids are derived server-side from the family. Arguments never carry an inbox, agent, installation or owner id. A subscription belongs to one installation (http-wake §2.2). An id from another installation or an unknown id answers identically (`end-other-installation-not-found`).
3. **Destination bound to client identity, not to model text (§2.2).** The `/mcp` tools are model-reachable in most hosts. A prompt-injected model must not be able to choose where Envoi sends metadata. So the URL's origin must equal one of the client's declared `wakeOrigins` (`x-wake-origins`: at most 3 exact HTTPS origins on port 443, no wildcard, IP literal or path), checked **before DNS** with the new reason `origin_not_declared` (`create-origin-not-declared`). `wakeOrigins` is an additive field of the pre-registered client record, which is server configuration; a client metadata document cannot set it in v1. Every http-wake §4 rule then applies unchanged (`create-private-address`).
4. **Scope and credential custody (§2.3).** The tools need permission `receive_agent_messages` (OAuth scope `envoi.agent`, which every family has). **No new OAuth scope** is added and approved agent-remote-auth `x-scopes`, consent display and fixture bytes are untouched. The receiver is the connector backend: it is the principal that holds the OAuth access and refresh tokens, and it claims with them over `/mcp` (`envoi_claim_work`). Envoi stores no per-subscription secret: notifications are Ed25519-signed with Envoi's published key set (http-wake §5), so there is no receiver secret for Envoi to custody. No token, URL from a request or credential appears in any notification.

### 3. Tools

All arguments are closed objects (`x-tools.inputSchema`). Results use the case-tools envelope: success `{ok:true,tool,result}`, failure `{ok:false,tool,code,reason?,message,retryable}` with `isError:true`. HTTP-level failures are the existing `/mcp` envelopes (`x-codes`).

| Tool | Arguments | Same effect as |
| --- | --- | --- |
| `envoi_wake_create` | `{url}` | `POST /api/agent/wake-subscriptions` (http-wake §3.1): pending subscription, one signed `wake.challenge` queued, replaces a pending one (`superseded`), same create limits |
| `envoi_wake_activate` | `{subscriptionId, challenge}` | `…/activate` (§3.3): only the creating installation, only with the challenge sent to the URL; replacement and `replaced` as §3.4 |
| `envoi_wake_end` | `{subscriptionId}` | `…/end` (§3.5), `ended_by_host` |
| `envoi_wake_status` | `{}` | the `httpWake` field of `GET /api/agent/status` (§1): availability and the most relevant subscription, so a backend learns an ending and never creates again after `revoked_by_owner` |

Tool error codes (`x-tool-errors`): `WAKE_SUBSCRIPTION_INVALID`, `WAKE_URL_REJECTED` (reasons are http-wake's plus `origin_not_declared`), `WAKE_SUBSCRIPTION_NOT_FOUND`, `WAKE_CHALLENGE_INVALID`, `WAKE_SUBSCRIPTION_ENDED`, `WAKE_ROUTE_NOT_SUPPORTED`.

### 4. Notifications, admission and catch-up (all inherited)

- Bodies are http-wake §2.3 byte for byte: opaque, at most 1,024 bytes, no case, message, work, lease, inbox, agent, installation, asset or credential id, no content, no URL, no token. `x-notification.newFields` is empty.
- **Durable admission.** Notifications are created from the existing durable queue and event sequence (http-wake §6.5), not from a new store. A restart or outage loses none; coalescing and single flight are §6.3.
- **Duplicates and loss.** `id` is the deduplication key (§7.2). A lost notification is covered by the receiver's startup claim and safety poll (at most `receiverSafetyPollMaxSeconds`, 900), both through `envoi_claim_work`; `envoi_wake_status` supplies the ended reason. A notification is a hint: acknowledging it is not completion, and work is claimed, fenced and settled only through the canonical `envoi_claim_work`, lease and fence rules (a3, case-session).
- **Bounded retries.** http-wake §6.2 schedule and deadline, `410 Gone` ends the subscription (`receiver_gone`), ten failed deliveries or 24 h of failure end it (`delivery_failed`).
- **Idempotency.** Create is not idempotent by design (a retry supersedes the pending one); activate and end are repeat-safe as in http-wake. Claims and settlement keep their existing idempotency keys and fences.
- **Assets.** Notifications carry none. Files stay behind the existing scan, grant and case-session gates when the backend claims the work.

### 5. Limits

The http-wake `x-limits` apply, shared with REST: 5 creates per installation and 10 per agent per hour, 4 concurrent and 120 requests per minute per destination host, and so on. A limit is HTTP 429 `RATE_LIMITED` with `retryAfterSeconds` (`create-rate-limited`). A subscription lives 30 days and is replaced at least 7 days ahead (http-wake §2.2); the origin check repeats on every replacement.

### 6. Pause, resume, revoke, late actions

- **Pause.** `/mcp` answers HTTP 409 `AGENT_PAUSED` to **every** tool while the agent is paused, wake tools included, never a JSON-RPC result (`create-paused`). Existing active subscriptions receive `wake.control_changed/agent_paused` and, on resume, `wake.work_available/agent_resumed` (http-wake §8.1). Held work and ordering are unchanged.
- **Revoke.** A revoked family is `CREDENTIAL_REVOKED` at `/mcp` (`create-revoked`) and its installation's subscriptions already ended with `credential_ended` (§8.3). An owner revoke of one subscription is the existing owner route; the backend sees `revoked_by_owner` in `envoi_wake_status`.
- **Late actions.** Notification attempts derive the subscription's state before every send (§8), so nothing is sent for an ended subscription, and a backend that claims after revoke gets the existing rejected-settlement behaviour.
- **Reconnect.** A new installation starts with no subscription (§8.3) and creates its own.

### 7. What this does not do

- It does not make a host "automatically reachable". Wake remains a declaration plus evidence: the installation keeps its declared `on_demand` mode, and the owner label changes only through a separately approved contract after a countersigned closed-app test (Phase B plan, shared host acceptance). No named host passes because of this contract.
- It is not the answer for hosts whose backend is the provider's chat product (ChatGPT/Dots, Muse): see `provider-event-wake` v1.
- It adds no OAuth scope, endpoint, REST exception or second queue.

### 8. Decisions for review

1. **Reuse `envoi.agent` (chosen) or add `envoi.wake`.** A new scope would amend approved agent-remote-auth `x-scopes`, consent display and fixtures; reuse changes none. The cost: the owner does not see a wake consent line. The destination is limited to origins the owner's connector already declares, and the owner can see and revoke every subscription on the existing owner list.
2. **Destination bound to pre-registered `wakeOrigins` (chosen) or any public HTTPS URL.** The second is simpler but lets a prompt-injected model aim metadata at any server.
3. **Wake tools return HTTP 409 while paused (chosen, consistent with `/mcp`)** or work while paused as REST does. The chosen rule keeps one pause behaviour on `/mcp`.
4. **Flag-off ends tool-created subscriptions (chosen)** rather than leaving ones the backend can no longer manage.
5. **Declared delivery mode stays `on_demand`.** A later revision may allow a declared upgrade after evidence.

### 9. Implementation notes (Lane A, informative)

New `src/mcp-wake-tools.js` calling the existing http-wake service functions with the family-derived installation; `tools/list` gating in `src/agent-mcp.js`; `createdVia` and the client record's `wakeOrigins` in both storage backends; flag parsing in `src/onboarding-flags.js`. Dependent implementation starts only after Lane B's `CONTRACT-ACK` and the human's exact `CONTRACT-APPROVED`. Tests: the 22 fixtures, FileStore and PostgreSQL parity for `createdVia` and the flag-off derivation, and the existing http-wake delivery suites unchanged.

> Implementation-preparation receipt (2026-10-24): the publication below is human-approved at `d920f65cf2ad2ec1933ab92c29d46fbdb4397a7b`, board #34 comment 6389430643. Its original publication-era status text is retained verbatim; the board approval and registry status govern. No new contract decision is made here.

## provider-event-wake v1

**Contract:** `provider-event-wake`, version 1 (Lane A backlog item 2 of board #34 comment 6371261746; Phase B backlog B-R7/B-R8, named-host part). **Status:** published, **revision 2** (this text answers Lane B's `MISMATCH` E1 to E3, board #34 comment 6373764059; revision 1 @3e1574f is superseded and was never ACKed or approved, so the contract stays v1), awaiting Lane B's re-review `CONTRACT-ACK` and a version-specific `CONTRACT-APPROVED provider-event-wake v1 @<publication sha>`. Nothing here is implemented, nothing is default-on, and no flag changes. It amends no approved contract.

**Fixtures:** [`test/contract-fixtures/provider-event-wake/`](../../../test/contract-fixtures/provider-event-wake/): `schemas.json` (tables `x-flags`, `x-protocol`, `x-events`, `x-signing`, `x-secret`, `x-limits`, `x-no-retry-statuses`, `x-retry-statuses`, `x-notification`, `x-codes`, `x-callback-errors`, `x-target-states`, `x-evidence-gates`) and 49 cases, including signed deliveries whose HMAC and timestamp freshness the test recomputes. Revision 2 adds `x-verification-cache` and `x-clock`. Executable checks: `test/contract-fixtures.test.js` and `test/contract-provider-event-wake.test.js`.

**Owner:** Lane A. **Consumers:** Lane B (ChatGPT/Dots plugin setup, Grok setup guidance, trusted bridge) and the owner UI.

### 1. Why a separate contract

Both providers document a **Standard Webhooks HMAC** protocol, not the Ed25519 `envoi-wake/1` protocol of http-wake v1. A provider will not run Envoi's receiver code, so the generic wake cannot be assumed to work. The interfaces below were read from the providers' public documentation on **2026-10-23**; account and workspace capability is **not** established and is listed as open gates (fixture `grok-evidence-gates`). The two profiles reuse the existing durable queue, event sequence, opaque notification content (http-wake §2.3), destination safety (http-wake §4), retry deadline, limits and derivation of ended states (http-wake §6, §8). They add no queue, no parallel notification store and no provider-only inbox.

| Flag (server-only, default off; startup fails closed if a requirement is off) | Profile | Requires |
| --- | --- | --- |
| `ENVOI_MCP_EVENTS_V1` | `mcp_events`: ChatGPT/Dots subscribes to Envoi's MCP Events | `ENVOI_HTTP_WAKE_V1`, both V2 flags, and `ENVOI_REMOTE_MCP_OAUTH` or `ENVOI_PROVIDER_CONNECTORS` |
| `ENVOI_GROK_TRIGGER_V1` | `grok_trigger`: Envoi sends to an owner-supplied Grok webhook trigger | `ENVOI_HTTP_WAKE_V1`, both V2 flags |

### 2. Profile `mcp_events` (ChatGPT / Dots): Envoi is the event source

Interface (documented): MCP 2.0 protocol `2026-07-28`; `server/discover` advertises `capabilities.events: {}`; the same authenticated endpoint implements `events/list`, `events/subscribe`, `events/unsubscribe`; webhook delivery only (no polling, streaming, `gap` or `terminated` notifications); HTTPS callbacks, no redirects, no private addresses; Standard Webhooks signing; body limit 256 KiB; verification challenge echo; renewal before `refreshBefore`; cursor replay with `truncated`. Source: <https://developers.openai.com/plugins/build/mcp-events>.

1. **Prerequisite (open gate D3).** `/mcp` today negotiates `2025-11-25`. The events methods and capability exist **only** at `2026-07-28` (`subscribe-older-protocol-version` answers `-32601`); the 19 tools are unchanged at the old version. Supporting 2026-07-28 at `/mcp` is a separate implementation task and decision for the human (decision 1 below).
2. **Who may subscribe (`discover-events-capability`, `subscribe-not-qualifying-family`).** Only an audience-bound family of `remote_mcp_oauth` or `provider_connector`. For any other credential the methods do not exist. `events/subscribe` is a protocol method the host's runtime calls after user authorization; it is not a model tool.
3. **Events (`x-events`, `events-list`).** `envoi.work_available` (reasons as http-wake §2.3) and `envoi.control_changed` (`agent_paused`, `case_controlled`). Arguments are `{}`: a subscription is scoped to the authenticated installation, never to a case. Payloads carry only `reason`. `data` and the envelope hold no case, message, work, lease, inbox, agent, installation, asset or credential id, no content, no URL, no token. `eventId` is the random `wake_evt_…` id and equals `webhook-id`.
4. **Subscribe (`subscribe-created`, `subscribe-renewed-same-identity`).** The subscription belongs to the installation of the calling family; the tenant, owner and agent are derived server-side. The id is deterministic from installation, event name, canonical arguments and URL (`evtsub_` plus 20 hex), so a repeat with the same identity is a renewal that moves `refreshBefore` (default and maximum TTL 7 days, minimum 1 hour; `ttlMs: null` is treated as the maximum), replaces the secret (dual signing for 10 minutes, `delivery-secret-rotation-dual-signature`) and never creates a second subscription. At most one subscription per installation and event.
5. **Callback safety (`subscribe-callback-origin-not-allowed`, `subscribe-callback-address-not-allowed`).** HTTPS, port 443, public addresses, no redirects: http-wake §4 verbatim. In addition the URL's origin must be in an operator-recorded **provider callback allowlist**, which is **empty by default** and filled only from evidence the human records (gate D2). So the feature is inert until the hosts ChatGPT actually uses are observed; no hostname is guessed in this contract. Refusals are JSON-RPC `-32015 CallbackEndpointError` with `data.reason` `origin_not_allowed`, `address_not_allowed`, `challenge_failed` or `timeout`.
6. **Verification (`verification-request`, `subscribe-verification-failed`).** Before any event Envoi sends one signed `{"type":"verification","challenge":…}` and requires a 2xx response echoing the challenge (constant-time compare). Nothing is stored and nothing is sent if it fails. **Bounded verification cache (E2: `x-verification-cache`, `subscribe-renewed-same-identity`, `subscribe-renewed-secret-rotated`, `subscribe-verification-cache-expired`, `subscribe-verification-binding-changed`, `subscribe-cache-hit-address-now-disallowed`).** As the provider's guide allows, a successful verification is cached per authenticated principal (the installation) and canonical callback URL for at most 3,600 s. A subscribe or renewal that matches an unexpired entry with the same secret sends no new challenge. The entry is invalidated by expiry, a changed secret (a verification signed with the new secret proves the callback holds it), a changed URL (a different URL is its own key), a changed allowlist, an ended subscription or installation, and flag-off. A hit skips only the challenge round trip: the allowlist, scheme, port, public-address and no-redirect checks run on every request, so a cached URL that now resolves to a private address is refused and its entry dropped. The cache stores a timestamp and a one-way key, never the secret. No callback origin is inferred; the allowlist stays empty by default.
7. **Secret custody (`x-secret`).** The host supplies a `whsec_` secret (24 to 64 bytes decoded; `subscribe-secret-invalid`). Envoi must hold it to sign, so it is stored encrypted with the server data key, readable only by the delivery worker, never returned, logged or audited, and deleted on unsubscribe, end, revoke, flag-off and installation end. This is the one new secret Envoi stores; every other key in the system is unchanged.
8. **Delivery, retries, acknowledgement (`delivery-*`).** One event per POST, body at most 1,024 bytes, serialized once and signed as sent: `{webhook-id}.{webhook-timestamp}.{raw body}` with HMAC-SHA256 under the decoded secret. A retry keeps `eventId` and `webhook-id` and is signed again at the retry time (E3: `x-clock`): `webhook-timestamp` is the signing time, never earlier than the event it carries, and a retry waits for `Retry-After` before its fresh timestamp and signature. Receivers accept a request only when their clock is within 300 s of `webhook-timestamp`; the fixtures carry a declared receiver clock (`asOf`) and verdict for fresh, 300 s and 301 s edges, stale replay and future-clock cases, and show that a stale replay of a valid signature is rejected by the clock check, not the HMAC (`delivery-replayed-stale`, `delivery-future-timestamp-rejected`, `delivery-clock-edge-300s-accepted`, `delivery-clock-edge-301s-rejected`, `grok-delivery-replayed-stale`, `grok-delivery-retry-fresh-clock`). Retries follow the http-wake schedule and deadline (10, 30, 120, 600, 1800 s; six attempts; one hour); `408, 425, 429, 5xx` retry honouring `Retry-After`; `410` ends the subscription (`receiver_gone`) and `413` is never retried. **A 2xx is receipt only.** Envoi infers nothing about processing; completion exists only as a canonical, fenced claim and settlement over `/mcp`. Events may arrive out of order and more than once; the receiver deduplicates by `eventId` and every write is idempotent.
9. **Durable admission and catch-up (`subscribe-replay-truncated`).** Events are created from the existing durable queue and the a4 event sequence. The subscribe `cursor` is the a4 cursor (20 digits). A cursor inside the retained history (72 hours or 1,000 events) replays the missed `envoi.work_available` hints; older yields `truncated: true`. Either way the host claims once after every subscribe and keeps a safety poll (at most 900 s), because a hint can be lost.
10. **Pause, resume, revoke (`subscribe-paused`, `subscribe-revoked`, `delivery-control-changed`).** `/mcp` answers HTTP 409 `AGENT_PAUSED` to subscribe while paused; existing subscriptions receive `envoi.control_changed/agent_paused` and, on resume, `envoi.work_available/agent_resumed`. A revoked family is `CREDENTIAL_REVOKED` and its subscriptions ended (`credential_ended`) before any further attempt: derivation happens before every send (http-wake §8). Late claims after revoke get the existing rejected-settlement behaviour. Unsubscribe is idempotent and reveals nothing (`unsubscribe-unknown-is-idempotent`). Its request is the documented form, the original name and arguments plus `delivery` with `mode: "webhook"` and the original `url` (E1: `unsubscribeParams`, `unsubscribe-ok`); a request without `delivery.mode` is invalid params (`unsubscribe-delivery-mode-missing`), and the result carries no secret.
11. **Limits.** http-wake `x-limits` plus the additions in `x-limits.additional`; creates share the per-installation and per-agent hourly limit (`subscribe-rate-limited`).

### 3. Profile `grok_trigger`: Envoi sends to an owner-supplied trigger

Interface (documented, checked 2026-10-23, source <https://docs.x.ai/grok/automations/webhooks>): each saved Grok automation has a unique webhook endpoint; the sender POSTs with `webhook-id`, `webhook-timestamp`, `webhook-signature` (`v1,` plus base64 HMAC-SHA256 of `{id}.{timestamp}.{raw body}` under the decoded `whsec_` secret); timestamps beyond five minutes are rejected; the secret is shown once and rotating it invalidates the old one; bodies over 1 MiB get `413`; `202 Accepted` starts the automation asynchronously; `400`, `401`, `413`, `429`, `503` are defined. **Not documented:** the endpoint URL form, duplicate handling, retry behaviour, whether the payload reaches the model as data, and plan requirements.

1. **What this profile is.** A **sender**: a transport that nudges a Grok automation. It is not a claim path. Whether the automation can then act on Envoi at all is open gate G1; until proven, no statement that Grok processes work is allowed, and the sender ships disabled. This contract does not assume that Grok supports remote MCP or Envoi's REST routes.
2. **Credential custody (`grok-target-put`, `grok-target-get-no-secret`, `grok-target-agent-token-refused`).** The **owner** supplies the trigger URL and the signing secret in a signed-in owner session (CSRF, origin, assurance as the existing owner routes): `PUT/GET/DELETE /api/inboxes/{inboxId}/agents/{agentId}/wake-targets/grok`. One target per agent. The response and every read show `secretSet: true`, never the secret or any part of it. An agent credential, the model and the browser-delegated cookie cannot read or change it. Secret storage, rotation and deletion follow `x-secret`.
3. **Destination (`grok-target-put-origin-not-allowed`).** HTTPS and http-wake §4 rules plus an exact-origin allowlist, **empty by default** until the trigger URL form is observed (gate G2).
4. **Payload.** The unchanged opaque http-wake §2.3 `wake.work_available` body (at most 1,024 bytes). It never carries content, ids, a URL or a token. If the automation needs work content it must obtain it through an authenticated, fenced canonical claim by a trusted bridge (G1); Envoi never pushes case content through the trigger.
5. **Outcomes (`grok-delivery-*`, `x-no-retry-statuses`).** `202` is receipt only (`accepted_receipt_only`): no acknowledgement, claim, processing or presence is inferred. `429`, `408`, `5xx` retry on the http-wake schedule with `Retry-After` and a fresh timestamp and signature, the same `webhook-id`. `401` means a rotated secret, a stale clock or a trigger that stopped accepting: the target moves to `needs_secret`, no retry loop, owner action required. `400` and `413` are sender defects: `needs_attention`, audited, not retried. Delivery is at least once; because Grok's dedupe is undocumented (G3), the receiving side must deduplicate by `id`.
6. **Pause, revoke, rotation.** Paused agent: only `wake.control_changed` is sent. Revoked agent, ended installation, owner delete or flag-off end the target and delete the secret before any further attempt. After the owner updates the secret, Envoi sends one `wake.work_available/work_due` so the bridge claims.
7. **Limits.** One target per agent; at least 5 seconds between sends to a target; http-wake coalescing and single flight; Grok's own `429` is honoured.

### 4. Reuse, assets, idempotency, rollback

- **Canonical system only.** Subscriptions and targets are installation-bound records beside http-wake subscriptions; delivery uses the one durable queue and its fences; claims and settlement use the existing work, case-session and case-tools services and idempotency keys. Assets stay behind the existing scan, grant and case-session gates; no notification carries one.
- **Duplicate and lost delivery.** `eventId`/`id` is the dedupe key; a lost notification is recovered by the startup claim and safety poll; a duplicate does no extra canonical effect because claims are fenced.
- **Rollback (`rollback-flags-off`).** Each flag off ends the profile's records with `feature_disabled` from the first read or attempt after the flag-off start, deletes their secrets, sends nothing, and leaves work, leases, the a4 stream and Ed25519 http-wake subscriptions untouched.

### 5. Decisions for review

1. **Support MCP 2.0 (`2026-07-28`) at `/mcp` for events only (chosen), or not at all.** Without it the `mcp_events` profile cannot exist; Dots then relies on a safety poll while its app is open.
2. **Provider callback and trigger allowlists empty by default (chosen)** rather than hard-coding hostnames this contract cannot verify. Until the human records observed evidence (gates D2 and G2) both profiles are inert.
3. **Envoi stores the host-supplied or owner-supplied `whsec_` secret, encrypted (chosen).** HMAC signing cannot work without Envoi holding the key. The custody is exactly §2.7 and `x-secret`: encrypted at rest with the server data key, readable only by the delivery worker, never returned by any route, never logged or audited, and deleted on unsubscribe, end, revoke, flag-off and installation end. It is the one new secret Envoi stores. The alternative is to decline both profiles.
4. **Verification cached for at most 3,600 s per principal and callback URL (chosen, E2)**, with the destination checks run on every request and the entry invalidated by expiry, a changed secret, URL or allowlist, and by ending (§2.6, `x-verification-cache`). The alternative is to verify on every renewal; the cost of the choice is that a callback that stops answering is noticed at the next expiry or event, not at every renewal.
5. **Grok sender ships as transport only; no processing claim until G1.** Whether a trusted bridge, the existing authenticated REST helper (which rejects scheduled polling) or no Grok route at all is selected is the owner's and Lane B's evidence-backed choice.
6. **No change to a5-presence labels.** A `202` or `2xx` never turns `on_demand` into automatic reachability; only a separately approved contract after countersigned closed-app evidence does.

### 6. Out of scope

Provider submission, plugin installation, account setup and real-account operations (their owner); changes to approved agent-remote-auth, http-wake or a5 bytes; any named-host pass.

### 7. Implementation notes (Lane A, informative)

New `src/provider-event-wake.js` over the http-wake service and queue; `/mcp` event methods behind the version check in `src/agent-mcp.js`; encrypted secret field in both storage backends; owner routes and flags in `src/server.js` and `src/onboarding-flags.js`. Dependent implementation starts only after Lane B's `CONTRACT-ACK` and the human's exact `CONTRACT-APPROVED`. Tests: the 49 fixtures with FileStore and PostgreSQL parity for the encrypted secret, derivation and flag-off deletion; the existing http-wake suites unchanged.

> Implementation-preparation receipt (2026-10-24): the publication below is human-approved at `3af8669a907c316b95ff92fa7031a50a654e1a18`, board #34 comment 6374090183. Its original publication-era status text is retained verbatim; the board approval and registry status govern. No new contract decision is made here.

## provider-connector-tools v1

**Contract:** `provider-connector-tools`, version 1 (Lane A backlog: reconcile Muse's reviewed-connector authorization and tool boundaries; Phase B backlog B-R4). **Status:** published, awaiting Lane B's `CONTRACT-ACK` and a version-specific `CONTRACT-APPROVED provider-connector-tools v1 @<publication sha>`. It adds **no tool, scope, route or flag** and changes no approved contract; it classifies what already exists so a reviewed provider connector can describe it truthfully.

**Fixtures:** [`test/contract-fixtures/provider-connector-tools/`](../../../test/contract-fixtures/provider-connector-tools/): `schemas.json` (tables `x-tool-classification`, `x-effect-classes`, `x-minimum-submission-set`, `x-visible-by-permission`, `x-rules`, `x-read-only-options`, `x-evidence-gates`, `x-codes`) and 6 cases. `test/contract-provider-connector-tools.test.js` imports the live `agentMcpTools` table and fails if the classification drifts from it.

**Owner:** Lane A. **Consumers:** Lane B (the Muse readiness packet, PR #204 `integrations/muse/CONNECTOR-SUBMISSION-READINESS.md`) and whoever submits to Meta. Provider submission, test accounts, portal operations and Meta's final classification stay with their owner.

### 1. What was reconciled

The Muse packet (#204 @35c279d) asked Lane A for "a versioned provider action/wake contract" and for a decision on a read-only OAuth choice. Against the approved contracts:

1. **Provider actions need no new contract.** The identity, snapshot, claim, renew, acknowledge, complete, fail and reply operations a reviewed connector needs are the `/mcp` tools of agent-registration v1 §6.6, reached by the `provider_connector` route of agent-remote-auth v1 §9. Their fences, idempotency keys and settlement rules are unchanged. What was missing is a **truthful classification** of those tools by effect and scope (this contract), because Meta classifies per tool.
2. **The grant is not read-only.** The required scope `envoi.agent` maps to `receive_agent_messages`, which includes claim and settlement authority (`envoi_claim_work`, `…renew…`, `…acknowledge…`, `…complete…`, `…fail…`). Submitting only read tools does not change what the OAuth grant allows. Sending needs the optional `envoi.send` (fixtures `tools-list-envoi-agent-only`, `tools-list-envoi-agent-and-send`, `send-without-send-scope`).
3. **Wake is not provided by this contract.** If Meta exposes a supported callback or trigger, it consumes `mcp-wake` v1 (declared origins) or `provider-event-wake` v1; otherwise Muse's background availability stays blocked (gate M4). Nothing here claims or implies it.

### 2. Classification (`x-tool-classification`)

Every one of the 19 tools has: the live `permission` and derived scope, an `effect` (`read`, `write`, `sensitive_write`), the state it changes, whether it has an outward effect, whether a per-use provider approval is proposed, whether it is lease fenced and whether it needs an idempotency key. In short:
- **Read:** `envoi_agent_info`, `envoi_list_cases`, `envoi_read_case`, `envoi_list_messages`, `envoi_list_assets`, `envoi_asset_download`. No state changes.
- **Write (this installation's own state):** `envoi_claim_work`, `…renew…`, `…acknowledge…`, `…complete…`, `…fail…` (work leases and settlement) and the asset upload tools. Work state is never presented as an inbox read.
- **Sensitive write (outward):** `envoi_send_message`, `envoi_start_case`, `envoi_send_proposal`, `envoi_send_decision`, `envoi_send_completion` and `envoi_grant_asset`. Meta makes the final classification; Envoi proposes the strictest.

### 3. Minimum submission set (`x-minimum-submission-set`)

Identity (`envoi_agent_info`), one snapshot (`envoi_list_cases`, `envoi_read_case`, `envoi_list_messages`), claim and settlement (the five work tools) and one reply (`envoi_send_message`, which needs a case and an exact recipient). Excluded from the first submission: starting new cases, proposals, decisions, completions, every asset tool and the wake tools. Any addition needs its own Meta review and a revision of this contract.

### 4. Rules (`x-rules`)

R1 a provider approval is never Envoi authority and never an argument (`send-provider-approval-field-refused`: closed arguments, `-32602`); R2 Envoi's own policy and human-decision checks apply regardless of any provider prompt, and a provider approval does not satisfy a required Envoi decision; R3 an outward effect is never called a read; R4 the queued receipt of a send, work settlement and the other agent's receipt are different facts; R5 lease tokens and idempotency keys stay mandatory (`claim-tools-need-lease-fence`) and a provider model never gets a general agent bearer or case-session token; R6 the grant is wider than the submitted tools and must not be described as read-only.

### 5. Read-only choice (decision for the human, gate M2)

- **A (Lane A's recommendation):** keep `envoi.agent`, describe it honestly, submit only the minimum set, and ask Meta whether that satisfies its read-only guidance. No approved contract changes.
- **B:** add a read-only permission and scope. That is a revision of agent-registration v1 (permissions) **and** agent-remote-auth v1 (`x-scopes`, consent display), each needing Lane B's ACK and the human's exact approval. It is not published here because Meta's requirement is not yet known.
- **C:** a second read-only provider client over such a permission: B's cost plus a second client record.

### 6. Open gates (`muse-evidence-gates`)

M1 Meta's final per-tool classification; M2 whether Meta requires a read-only offering; M3 the OAuth client type, redirect and credential behaviour Meta's reviewed connector actually uses; M4 a Meta-supported closed-app trigger and its callback origins; M5 per-use approval behaviour for a reply and whether unattended replies are possible. Each belongs to the account/provider owner. Muse stays UNPROVEN until all are recorded against one release.

### 7. Implementation notes (Lane A, informative)

No server change. The classification test keeps the table honest against `src/agent-mcp.js`. Lane B updates the Muse readiness packet to cite this table instead of its candidate inventory. Dependent work starts only after Lane B's `CONTRACT-ACK` and the human's exact `CONTRACT-APPROVED`.

## agent-remote-auth-cimd v1

**Contract:** `agent-remote-auth-cimd`, version 1. **Status:** human-approved in this chat on 2026-10-25 at exact publication `4859a22dcc2731929926a92bb2f880286efa89db` (PR #229), after client ACK board comment 6393378736. The direct human response was "Approve this contract and implementation here" to the question naming this exact contract/SHA and its scope/bounds. This is an agent-written receipt of that direct approval, not a new human board comment. This is an additive amendment of approved `agent-remote-auth v1` revision 4 section 3.1 only. The earlier approved contract and its fixtures retain their bytes and status. Before this amendment is approved, its accepted modern documents are proposals, not current runtime behavior. The original publication contained no dependent implementation; the approved implementation is a separate draft increment.

**Reason:** ChatGPT's public CIMD document observed on 2026-10-25 advertises `token_endpoint_auth_methods_supported: ["none", "private_key_jwt"]` and a legacy singular preference of `private_key_jwt`. Envoi's public-client validator and planner reject the singular preference. The [official OAuth guidance](https://developers.openai.com/plugins/build/auth) describes capability intersection and a legacy preference; the selected shared method can be `none`. The exact local reproduction is [board comment 6393097298](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6393097298). The actual account may have a callback-specific document; this snapshot proves no host installation or hosted gate.

**Scope:** replace only section 3.1's auth-method declaration rule for CIMD/public clients, after approval. Pre-registered clients keep their existing authentication rules. Authorization server metadata, endpoints, scopes, PKCE S256, exact client/redirect/issuer/resource binding, callback and metadata destination protection, cache policy, private custody, consent/activation, token exchange/refresh/replay, audience, flags and owner presence retain their existing contracts. There is no JWT client-auth implementation, JWKS fetch, new secret or fallback to an authenticated REST audience.

### 1. Method declaration and selection

A method identifier is a string of 1-128 visible ASCII characters (U+0021-U+007E). Whitespace, controls and non-strings are invalid. The new plural field, when present, must be an array of 1-16 unique such identifiers. Unknown names in this list are capabilities Envoi does not implement; they never enable another authentication method.

| Document fields | Required result |
| --- | --- |
| Plural field absent, singular absent or exactly `none` | Preserve the approved public-client default: select `none`. |
| Plural field absent, singular anything else | Refuse with existing internal `auth_method_not_none`; no legacy JWT or confidential-client bypass. |
| Plural field present, valid and contains `none` | Select `none`, independently of a different valid singular preference. The preference is not an authorization requirement. |
| Plural field present but malformed or lacks `none` | Refuse with `auth_method_not_none`, even if singular says `none`; no fallback that ignores the modern list. |
| Singular preference present but not a valid method string | Refuse with `auth_method_not_none` even if the capability list contains `none`. |

An absent plural field and a present null/empty/malformed field are different cases. If a singular preference names a method Envoi does not implement, it is not selected. A valid capability list containing `none` is still eligible. The resulting CIMD client remains public and its effective `tokenEndpointAuthMethod` is always exactly `none`.

All other current metadata document rules run unchanged. This amendment does not accept a mismatched `client_id`, unregistered redirect, bad client name, unsafe metadata URL, bad fetch result or changed scope. It creates no permission or grant by itself.

### 2. Authorization outcome and rollout

For a client that satisfies section 1 and every other existing authorization check, `GET /oauth/authorize` reaches the existing sealed owner-consent redirect. An invalid metadata method declaration retains the existing `302` to Envoi's own `/authorize-agent?error=invalid_client`, with existing no-store/referrer headers; it never redirects to an unchecked client URI. No new public error code or response shape is added.

The proposed bounds (16 methods, 128 characters each) are explicit review decisions within the existing 5,120-byte fetch cap. Approval of this amendment is approval of these bounds and the selection table. Nothing enables either remote route or proves ChatGPT/Dots account access.

After approval, update the isolated server metadata validator and the pure client planner to consume the same canonical fixtures, retain all existing security checks, and add local real-HTTP negotiation/PKCE/redirect/error regressions. Run the required client/server suites and exact-head CI. Return a separate implementation draft PR into `integration/agent-native`; integration, deployments, provider setup and hosted acceptance keep their existing human gates.

Rollback removes the implementation increment and returns to the old singular-only eligibility rule. There is no data migration, stored method expansion, credential rotation or automatic re-enrollment. Existing valid public clients remain public under either source version.

### 3. Executable publication fixtures

Canonical directory: `test/contract-fixtures/agent-remote-auth-cimd/`. `schemas.json` defines the amendment's auth-metadata acceptance and fixture/expected-result shapes. The 24 `kind: client-metadata` cases are negotiation vectors, not fabricated HTTP observations. Every non-auth document field is checked against the approved v1 schema after normalizing only auth-method fields; v1 fixtures are not copied or edited. `test/contract-agent-remote-auth-cimd.test.js` validates this proposal and its exact bounds without importing or changing runtime validators. Existing shared-fixture validation checks registration and schema consistency.

Fixtures: `legacy-default`, `legacy-none`, `legacy-private-key-jwt`, `legacy-client-secret-basic`, `modern-public-only`, `modern-no-preference`, `modern-chatgpt-preference`, `modern-future-preference`, `modern-no-public-method`, `modern-no-legacy-fallback`, `modern-empty-list`, `modern-string-list`, `modern-null-list`, `modern-duplicate-method`, `modern-non-string-method`, `modern-empty-method`, `modern-control-method`, `modern-max-method-count`, `modern-over-method-count`, `modern-max-method-length`, `modern-over-method-length`, `modern-null-preference`, `modern-number-preference`, `legacy-null-preference`.

### 4. Approval boundary

Publication and schema checks approve no runtime behavior. The human approves this exact amendment SHA after client review; the task's request to fix it in this chat assigns preparation ownership and does not silently approve an unpublished wire-contract amendment. Prior approved remote-auth, MCP events/wake, gateway and Hermes/OpenClaw gates remain credited.

---

## `provider-event-wake-discovery v1`

**Bounded amendment to `provider-event-wake v1` §2, approved by the human on 2026-10-25.** The direct approval and limited Lane A exception are attributed in [6402135050](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6402135050), for proposal SHA-256 `637ff3a31d2d0e0c86e8fbb761c6240394b9739cc9c0c034023f98d8467c1219`. Publication and implementation are draft PRs into `integration/agent-native`; a new-source deployment remains separate.

### 1. Complete discovery result

For a qualifying active installation using MCP protocol `2026-07-28`, `POST /mcp` with JSON-RPC method `server/discover` returns HTTP 200 and this result:

```json
{
  "resultType": "complete",
  "supportedVersions": ["2026-07-28"],
  "capabilities": { "tools": {}, "events": {} }
}
```

The JSON-RPC envelope retains `jsonrpc: "2.0"` and the request ID. The result is closed: the initialize-shaped `protocolVersion` and `serverInfo` fields are replaced by `resultType` and `supportedVersions` for this method. Legacy `initialize` negotiation and the 19 general tools retain their existing behavior. This matches the [current host discovery format](https://developers.openai.com/plugins/build/mcp-events).

This amendment supersedes only the response result in the original `provider-event-wake/discover-events-capability.json` vector. That original fixture remains byte-for-byte historical evidence; implementations and private Events clients consume the independently registered amendment vector instead. The base registry entry and every other approved fixture remain unchanged.

### 2. Existing authorization and delivery gates

The existing OAuth audience, installation, permission and MCP version checks still select who may discover events. Disabled or non-qualifying families and older protocols retain method-not-found behavior. Paused and revoked installations retain their transport-level denials. The event catalog, subscription arguments/storage/quotas, secret custody, signatures, callback origin/address/verification checks and all callback defaults retain their approved behavior.

Discovery creates no subscription or delivery authority. Callback origins remain empty until actual provider evidence is reviewed. A complete discovery response, successful catalog scan or HTTP 200 is not a closed-app execution or work-settlement result.

### 3. Publication and implementation checks

Canonical directory: `test/contract-fixtures/provider-event-wake-discovery/`. `schemas.json` defines the exact closed result and fixture envelope; `discover-events-capability.json` carries the HTTP request and amended response. Publication validation imports no runtime service and tests malformed, incompatible and authority-bearing results. The private Events client must consume this vector and reject incompatible envelopes without exposing remote messages or credentials.

Implementation checks cover the actual HTTP discovery response, unchanged legacy initialization/general tools, existing unavailable-family/version behavior, pause/revoke denial and private-client response validation. Existing subscription/delivery tests continue unchanged. Run both required lane suites and exact-head CI. Hosted catalog refresh, subscription/callback verification, private host work custody and closed-app execution remain separate acceptance work.

Rollback is a source rollback of the bounded discovery and private-client change. It needs no data migration, new grant, credential rotation, namespace change or database restore. No rollout flag or existing hosted acceptance is changed by this publication.


## provider-event-wake-request-metadata v1

Additive amendment of provider-event-wake v1 section 2 method parameters. The human directly approved proposal SHA-256 `1d91e9ecbfd3e3955cce371ebb21025f60d0835a469819da7fcb90bc5079ad34` and its bounded Lane A publication/implementation exception in this chat on 2026-10-25: "Approve contract and bounded fix here". This agent-written attribution is recorded in [6405202058](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6405202058). Integration and new-source deployment remain separate.

### 1. Common metadata and closed method arguments

For `events/list`, `events/subscribe` and `events/unsubscribe`, after existing authority and protocol gates, an optional own top-level `params._meta` must be a non-null JSON object, excluding arrays. Ignore it when applying the unchanged closed method schema. Its arbitrary JSON members are inert: never interpret, persist, log, audit, echo or use them as identity, permissions, callback, arguments, cursor, idempotency or delivery state. The existing complete MCP request cap remains 64 KiB; metadata creates no extra budget or execution path. Absent metadata and an empty object are valid. Present null, array, string, numeric or boolean metadata is the existing sanitized JSON-RPC `-32602 Invalid params`.

After removing only this own top-level field, list still accepts no method-specific keys and returns the identical two public definitions; cursor, limit and every other extra list key remain invalid. Subscribe/unsubscribe retain all required fields and nested closed schemas. Nested metadata inside arguments or delivery remains invalid. No metadata property can supply an omitted required field or relax a value check.

### 2. Existing protections and compatibility

Authentication, installation/audience/permission qualification, lifecycle denials, flags and protocol gates keep their existing order and outcomes. Disabled/unqualified/older-protocol methods remain missing; paused/revoked installations retain their transport denials. Deterministic subscription identity, secret custody, TTL/replay, quotas, destination allowlist/address/verification, cache, signatures, queue and end behavior are unchanged. Server discovery, legacy initialize, general tools and Grok do not change. This metadata rule is common to the three Events methods; only list rejection was observed in the diagnostic, and no unseen subscription traffic is claimed.

### 3. Executable publication and rollout

Independent synthetic parameter vectors and schemas are registered under `test/contract-fixtures/provider-event-wake-request-metadata/`. They cover inert/malformed metadata, unknown fields, nested metadata and retained list cursor/limit refusals; parent authority and callback vectors keep their original bytes and remain in force. These are parameter-acceptance vectors, not fabricated HTTP observations. Runtime tests must consume them, verify FileStore/PostgreSQL effects and metadata non-persistence, and exercise real HTTP parsing, size and unchanged method gates.

Publish the contract and implementation as separate draft PRs into integration/agent-native. A later exact source/image deployment needs its own reviewed window and authorization. The callback allowlist remains empty until real origin evidence is approved. Rollback removes the isolated implementation increment and restores metadata rejection without migration, rotation or data deletion. Catalog success alone is not hosted wake acceptance.

## phase-d v1

**Contract:** `phase-d`, version 1. **Status:** approved by pjsk02 on 2026-10-26 in [board #34 comment 6416305575](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6416305575), following [publication @4d8d00c4bb426b4b1ddff263037618bbe35d66e1](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6415432796) and the [consumer ACK](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6415457132). The same workstream owns both implementation lanes by Rachel's explicit direction. Existing PR #211 is a default-off draft; contract approval authorizes its dependent implementation corrections and required checks, but not integration, deployment, hosted tests or external interoperability acceptance. The registered schemas and four fixtures are in `test/contract-fixtures/phase-d/`. This version is frozen; contract changes require a new publication and approval.

### 1. Entry flags, data ownership and rollback

`ENVOI_RELATIONSHIPS_V2` and `ENVOI_A2A_GATEWAY` default to false. Relationships require `ENVOI_INSTALLATIONS_V2`; A2A requires both preceding flags and `ENVOI_PUBLIC_URL` at an HTTPS origin (loopback HTTP only for local tests). Invalid combinations fail startup. The server stores relationship and invitation records under the granting inbox and uses existing native identities, Cases, Assets, messages, audits and outbox; no second task or artifact store is permitted. Turning these flags off removes Phase D routes and extra authorization gates, but preserves stored records for a later reviewed re-enable. Rollback must not erase trust history, bypass existing Case/Asset controls, change credentials or retroactively undo delivered messages.

### 2. Directed relationships and trusted discovery

A relationship is one directional record `{id, inboxId, actorAgentId, targetAgentId, status, grants, createdAt, updatedAt, updatedByHumanId}`. Only a workspace administrator of the granting inbox may create or revoke it. Creation uses an exact target address, rechecks the active granting agent, verified active or paused target, current reciprocal blocks and target identity inside the mutation lock. Its nonempty distinct grants come from `shareAssets`, `autoAcceptSelectedTasks`, `richerProfileVisibility`, `allowInvitations`. Revocation sets `status: "revoked"` and clears `grants`; it never revokes a reverse grant or changes contact approval. A block on either side suppresses trust at read time, even for an earlier active relationship. These grants describe possible authority; they never execute a task or share an Asset by themselves.

The administrator routes are `POST /api/inboxes/{inboxId}/relationships` with `{actorAgentId,targetAddress,grants}`, `POST /api/inboxes/{inboxId}/relationships/{actorAgentId}/{targetAgentId}/revoke`, and `GET /api/inboxes/{inboxId}/discovery?address={exact}&actorAgentId={optional}`. Installed agents use `GET /api/agent/discovery?address={exact}` or `GET /api/agent/discovery?scope=organization&limit=1..50&after={inboxId}`. Organization pages only include current workspaces in the caller's organization; each target is rechecked before inclusion. No global directory, name-prefix search, guessed-ID lookup, or unauthenticated card endpoint is exposed. Exact-address discovery returns only a verified active or paused agent and `{agentId,address,trust,grants}`, with an `a2aCardUrl` only when A2A is enabled. Trust is selected in this order: active unblocked `relationship`, `approved_contact`, `same_organization`, `signed_invitation`, `exact_address`. An exact address without a trust grant may still be discoverable; native delivery and all action checks remain separate. A missing, unverified, revoked, blocked or inaccessible target is not returned. Clients must not infer global reachability from a 404.

An administrator issues a single recipient-bound invitation with `POST /api/inboxes/{inboxId}/discovery-invitations` and `{actorAgentId,recipientAddress}`. The result returns `{id,invitation,expiresAt}` once. The 24-hour signed payload binds issuer and recipient agent/inbox IDs, issue and expiry times; storage retains only its hash. `POST /api/inboxes/{inboxId}/discovery-invitations/{id}/revoke` makes it unusable. A recipient installation redeems through `POST /api/agent/discovery/invitation` with the token in the JSON body, never in a URL. Signature, hash, exact audience, expiry, issuer and recipient state, and reciprocal blocks are rechecked. A forged, expired, revoked or wrong-audience invitation reveals no issuer profile. Owner audit names are `relationship.granted`, `relationship.revoked`, `discovery_invitation.issued`, `discovery_invitation.revoked`; owner SSE consumers must include all four.

### 3. Authorization decision

`authorize({actorAgentId,installationId,action,relationshipId?,caseId?,resourceId?}, facts)` returns `{allowed,reason}`. The first failing gate wins in this order: request shape (`INVALID_REQUEST`), active identity (`IDENTITY_INACTIVE`), active installation or required installation (`INSTALLATION_INACTIVE` or `INSTALLATION_REQUIRED`), mapped permission (`PERMISSION_DENIED`), required directed grant and reciprocal block (`RELATIONSHIP_DENIED`), required Case membership (`CASE_MEMBERSHIP_DENIED` or `CASE_REQUIRED`), required current Asset/resource grant (`RESOURCE_DENIED` or `RESOURCE_REQUIRED`), policy (`POLICY_DENIED`), then human decision (`HUMAN_APPROVAL_REQUIRED`). Success is `{allowed:true,reason:"ALLOW"}`. Missing required facts deny. Discovery and A2A require `send_agent_messages`, Case actions require `execute_cases`, and Asset grant requires `create_assets`. The complete action map and reason order in `schemas.json` are frozen for v1; clients branch on stable reason strings, not messages.

When relationships are enabled, the existing agent Case create/event/policy/proposal/action/completion and Asset grant mutations load current facts inside their mutation locks and call the evaluator. Existing policy, human decision and Asset checks still apply. A2A send and polling re-evaluate on each request. Routes outside this migration retain their established checks. Revocation, pause, installation end, permission loss, block, Case control or Asset grant removal must take effect on the next attempted action; cached discovery never supplies authority.

### 4. A2A v1.0.1 direct-card subset

The authenticated exact-address discovery result points to `GET /api/agent/a2a/agents/{address}/card`. That address-specific card advertises HTTP+JSON protocol `1.0`, Bearer authentication and one text skill. It advertises streaming, push notifications and extended cards as unsupported. There is no public well-known card or directory. `POST /api/agent/a2a/agents/{address}/message:send` accepts `application/a2a+json`, one `ROLE_USER` text part, a nonempty message ID and `configuration.returnImmediately=true`. Continuations, extra parts, blocking sends and push config fail explicitly. A caller/target/message-ID scoped replay returns the original result without a second native send. Native message, Case, event and outbox must commit durably before wake or Task projection. An uncertain response is retried with the same message ID.

`GET /api/agent/a2a/agents/{address}/tasks/{caseId}` rechecks caller identity, installation, permission, Case membership and original caller/target A2A event, then projects the persisted Envoi Case state into a Task; it does not accept arbitrary Case IDs. A Task Artifact is a reference to a clean Envoi Asset with a current grant, through an authenticated content URL that rechecks access on download. Text send and Task read are the entire supported method set; streaming, push, multi-turn continuation, task mutation/cancel and unadvertised methods return explicit errors. No server response or card claims external peer compatibility until a real peer exchange is accepted.

### 5. Release evidence

Fixture consumers must cover directionality, grants and revoke, exact-address/organization/approved-contact/invitation trust, audience/expiry/block handling, ordered denial, flag-off rollback, owner audit replay, idempotent A2A send, persisted Task projection, scoped polling and clean authorized Artifact bytes. Both lane suites and exact PR-head CI must pass. A selected external A2A peer must then exchange card, text send, replay and Task/Artifact read against the approved hosted SHA, with failed and forbidden operations recorded. The human countersigns the resulting Phase D interoperability gate separately. No contract approval alone authorizes a merge, flag change, deployment, invitation or real provider operation.

## agent-remote-auth-message-access v1

Bounded additive amendment approved by the human in the Dots chat on 2026-11-05: "Approve this bounded contract and fix here". The human also authorized the task-specific server-work exception. Approved proposal SHA256: `9d26d35d561413ee525010fd03c265385f53196b09a487b048002ee14f42ca79`. This approval covers the following recovery behavior and metadata; deployment still requires the selected exact release decision.

Full authenticated OAuth agent connections gain `envoi_request_message_access`, with closed empty arguments, including when Send is missing. Legacy and scoped MCP-read credentials do not gain this tool. The operation is read-only, non-destructive and closed-world. It neither sends messages nor creates or changes an identity, grant, installation or subscription. Existing authentication, audience, installation, pause, expiry and revocation gates remain in force.

Under the human-approved revision2 below, the read-only recovery tool declares only its current-connection prerequisite `envoi.agent` in `securitySchemes` and matching `_meta.securitySchemes`. Its result requests broader owner consent separately. Existing general agent tools gain accurate boolean action annotations and, for OAuth credentials, scope declarations drawn from the approved scope registry. Discovery still filters privileged tools by their actual permissions. No grant is widened by discovery or metadata.

When effective Send is present, return the read-only `ready` result with the current address and permissions. When Send is absent and the current organization maximum disallows it, return `policy_blocked` without an OAuth challenge. Otherwise return HTTP200 JSON-RPC tool result with `isError:true`, `structuredContent.state:permission_required`, and `_meta["mcp/www_authenticate"]` containing one Bearer insufficient-scope challenge with the canonical resource metadata URL, fixed error description and scope `envoi.agent envoi.send`. The host owns the OAuth session; the owner chooses the same existing identity, reviews installation replacement and explicitly selects Send. Cancellation leaves access unchanged.

Existing forbidden send calls retain the approved HTTP403 INSUFFICIENT_SCOPE body and challenge byte shape. The new recovery result is a separate explicit operation, not a replacement response or an enforcement bypass. No authorization URL, code, verifier, token or callback secret is returned by this operation. Registry fixtures live in `test/contract-fixtures/agent-remote-auth-message-access/`.

Validation must cover missing access without mutation, successful broader same-identity approval, organization-policy refusal, invalid arguments, non-OAuth/scoped exclusion and unchanged legacy403. Real native owner reconsent and canonical message receipts remain hosted evidence, separate from local/CI results. Rollback removes this additive source without a database migration or grant change.

### Revision2: read-only recovery reachability

The human approved this metadata correction in the Dots chat on 2026-11-05: "Approve this recovery-metadata correction". Approved proposal SHA256: `25f66dfebcd992d459501199b60210b1b6d6c1c137862f646ea93f069c532767`. This supersedes only revision1's declared two-scope prerequisite for `envoi_request_message_access`.

The action checks the authenticated existing connection and therefore requires only `envoi.agent`. It must not declare the unavailable Send scope as a prerequisite for requesting that scope. A receive-only token must cover every scope declared for this read-only action. The returned insufficient-scope challenge remains exactly `envoi.agent envoi.send`; owner approval is still mandatory before Send is granted. Send-tool declarations and filtering, all identity/policy checks, existing403 envelopes and response fixtures remain unchanged. Local descriptor/token reachability checks establish the metadata invariant, not an assertion about the host's undocumented filtering internals. Native owner consent and the real message exchange remain hosted acceptance.
