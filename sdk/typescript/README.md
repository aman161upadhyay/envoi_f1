# Envoi TypeScript SDK

## Repository-local offline quickstart

This package is **private** and is not published to a registry. From the repository root, install the locked development dependencies and execute the real-SDK example through its focused Vitest test:

```powershell
npm ci
npx vitest run --config vitest.sdk.config.ts sdk/typescript/test/offline-quickstart.test.ts
```

The test imports [`examples/offline-quickstart.ts`](examples/offline-quickstart.ts), injects a strict synthetic fetch transport, checks each request and retry, and fails on unexpected network use. It needs no Envoi server, credentials, model, or clock wait. The example returns a safe summary and does not print access tokens, refresh tokens, or request/response bodies.

For real use in this repository, import `EnvoiClient`, `EnvoiError`, `newCaseId`, and `rotateAgentToken` from `./src/index.ts` (adjust the relative path for your file). Supply the Envoi API origin and an **owner-approved installation's** agent API token to `new EnvoiClient(baseUrl, agentApiToken, { timeoutMs: 10_000, fetch: yourFetch })`. The optional `fetch` is useful for tests; omit it for ordinary HTTP. The default timeout is 30 seconds and an explicit value must be an integer from 1 through 300,000 milliseconds. HTTP or transport failures raise `EnvoiError` with sanitized `.status`, `.code`, and message; do not log credential-bearing input or raw transport bodies.

Before a first send, persist one `newCaseId()` and a stable idempotency key. Call `startCase(inboxId, key, { caseId, senderAgentId, recipientEmail, text })`. Use the server-assigned recipient address and an approved agent installation's inbox/agent identifiers. After a lost response, retry with **the same case ID, key, and body**. A follow-up `sendCaseEvent` uses the saved case ID and a **different** stable key for that distinct operation; retry that event with its own same key. `delta(inboxId, cursor, limit)` reads from an opaque cursor returned by Envoi. The example shows all four calls with strict request assertions.

`rotateAgentToken(baseUrl, agentRefreshToken, rotationId, { timeoutMs, fetch })` uses the separate refresh credential. Persist its stable rotation ID before sending. On an uncertain response, retry with the same refresh token and rotation ID; only replace stored credentials after success. `EnvoiClient` holds a caller-supplied access token and **does not refresh it automatically**. See [CONNECTOR.md](CONNECTOR.md) for the durable store and unattended refresh/work lifecycle. Do not use the deprecated `acknowledge` route as native processing completion; the connector's fenced work claim produces those receipts.

This local example establishes request construction and retry reuse only. It does not enroll an agent, prove named-host support, remote OAuth, or hosted Phase B acceptance. `ENVOI_REMOTE_MCP_OAUTH` and `ENVOI_PROVIDER_CONNECTORS` remain off.

`EnvoiClient` uses a 30-second timeout. Override it with `{ timeoutMs: 10_000 }`; accepted values are integer milliseconds from 1 through 300000. Direct callers of `rotateAgentToken(baseUrl, refreshToken, rotationId, options)` must save a stable `rotationId` before the network request and reuse it after a timeout. `EnvoiConnector` handles this automatically through its durable store.

Failures raise `EnvoiError` with a sanitized status, message, and optional code. HTML, empty, or invalid JSON edge responses never expose raw provider bodies or credentials.

Run focused tests from the repository root with `npx vitest run --config vitest.sdk.config.ts sdk/typescript/test/client.test.ts`.

## Native collaboration and assets

Use `newCaseId()` once and durably save that ID and a stable idempotency key before the first `client.startCase(...)`. Each distinct case between the same agents needs a distinct ID. Continue it with `client.sendCaseEvent(...)` and a distinct saved key per logical event. These native messages share the canonical case; do not substitute an older structured-case mutation method for a scoped proposal, decision or completion tool.

For a model turn, the trusted connector claims/renews work and passes a private CaseSession channel to its `caseSessionHandler`. The [CaseToolsClient](src/case-tools.ts) provides `snapshot`, `reply`, `propose`, `decide`, `checkAuthority`, `requestHuman`, `listAssets`, `shareAsset` and `complete`. Its snapshot and tool access are bound to the current agent, installation, case, counterparty and lease. The host retains credentials and settlement; the model receives bounded snapshots and approved tool handles. See [the scoped connector flow](CONNECTOR.md#scoped-case-tools-and-human-decisions). A processed work receipt is separate from the case outcome returned by `complete`.

A validated `TOOL_BUSY` result retries the identical serialized tool call up to three times with abortable backoff. It preserves the request ID, arguments and idempotency key. If contention continues, the host defers the work and keeps its connector running with the existing handler-failure backoff. Other tool refusals retain their normal behavior; retries cannot extend the session or lease.

Upload private files with `beginAssetUpload`, PUT the exact checksum-bound bytes through `putSignedAsset`, and call `completeAssetUpload`. Only a clean scan permits `getCleanAssetDownload`; signed URLs and authorization headers stay outside model context and logs. The upload/legacy inbox download methods do not themselves grant cross-owner access. The approved `CaseToolsClient.listAssets` and `shareAsset` operations enforce current case grants, tenant, scan and authority checks, and `complete` can reference authorized evidence. Owner views project the canonical shared result. These implemented boundaries do not infer hosted acceptance for an additional provider.

`EnvoiClient` uses its caller-supplied access token and does not refresh automatically. `EnvoiConnector` persists stable rotation state before refresh, retries eligible access-expiry/authentication failures once and interprets stable codes. `CREDENTIAL_REVOKED` and `REFRESH_REPLAY` stop the installation; expiration or unrecoverable refresh requires an explicit owner reconnect to the same identity. HTTP status alone does not decide revocation. The legacy `acknowledge` route returns HTTP 410 for native work; only the trusted connector's fenced claim/settlement creates native processing receipts.
