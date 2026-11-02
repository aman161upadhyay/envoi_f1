# Phase D v1 interoperability acceptance worksheet

Status: **SOURCE CANDIDATE; hosted gate unproven.** This worksheet is a reviewable execution record, not approval to enable a flag, deploy, invite a peer, merge PR #211, or run a provider. The approved contract is `phase-d` v1 at `4d8d00c4bb426b4b1ddff263037618bbe35d66e1`, [published on board #34](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6415432796), [ACKed](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6415457132), and [approved by pjsk02](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6416305575). The controlling source is `docs/architecture/agent-native-v2/handoffs.md#phase-d-v1` and the registered fixtures are in `test/contract-fixtures/phase-d/`.

## Source candidate

| Field | Receipt |
| --- | --- |
| Draft PR | [#211](https://github.com/rachelgonsalves821/Envoi/pull/211), `lane-b/phase-d` into `integration/agent-native` |
| Exact source SHA | Record after the final source/CI round. Do not infer this from an earlier green head. |
| Flag defaults | `ENVOI_RELATIONSHIPS_V2=false`; `ENVOI_A2A_GATEWAY=false` |
| Local peer evidence | Phase D HTTP, fixture, frontend event/API and SDK tests. The card, send response and direct Task parse with the official [A2A Python SDK 1.2.3](https://github.com/a2aproject/a2a-python/releases/tag/v1.2.3) protobuf models. Its `RestTransport` completed a disposable local card/send/poll exchange when the client supplied the contract's `Content-Type: application/a2a+json`. Its unconfigured `httpx` JSON default received HTTP 415; this is a client setup requirement, not a hosted PASS. |
| PR CI | Record the exact head and completed check URLs. |
| Hosted source / peer | **Not selected or authorized**. Proposed independent client: official A2A Python SDK 1.2.3 using its HTTP+JSON 1.0 binding; confirm peer/version, deployment SHA and time before execution. |

## Hosted run prerequisites

1. Obtain separate human authorization for the exact source to integrate/deploy, both Phase D flags, and one external peer test. Preserve existing owners, workspaces, inboxes, keys, namespaces, Dots history and protected paused Cases. Use disposable identities and a clearly identified peer account; keep credentials out of this worksheet.
2. Record the served build SHA, public HTTPS origin, peer implementation/version, owner/operator, and start time. Verify the served SHA equals the approved deployment SHA and that the two flags are in the intended state. Do not accept a local mock or a self-call as the external peer.
3. Capture redacted HTTP method/status/code, card fields, Case/Task/Asset identifiers, durable event and outbox receipts, and current access decisions for the rows below. Store sensitive raw traces only in the approved evidence store.
4. Return both flags to their prior state after the run; verify prior Cases and Assets remain readable by previously authorized parties. Record the rollback time and observed state.

## Acceptance matrix

All rows remain **UNPROVEN** until a hosted external peer run at one exact source SHA produces the indicated evidence. A local test or green CI must not be entered as a hosted PASS.

| Row | Passing observation | Evidence to record | Result |
| --- | --- | --- | --- |
| D-01 | Authenticated exact-address Agent Card advertises only HTTP+JSON 1.0, Bearer, immediate text send and Task read; unrelated callers cannot enumerate it | Card response and unauthorized/not-found status | UNPROVEN |
| D-02 | External peer sends one supported text message and polls its returned Task | Peer request/response, mapped canonical Case ID and final Task state | UNPROVEN |
| D-03 | Native message, Case, event and outbox commit before wake and projection | Durable store/audit timestamps and wake receipt for D-02 | UNPROVEN |
| D-04 | A clean scanned Asset with an explicit current grant appears as a Task Artifact; download checks current authority | Scan/grant/Task/download receipts and denied revoked download | UNPROVEN |
| D-05 | Reuse of the same message ID after an uncertain response returns the same Case/Task; conflicting reuse is denied | Two peer attempts, one native message/event, conflict code | UNPROVEN |
| D-06 | Pause, revoke, reciprocal block, cross-workspace access, expired/stale credentials and permission loss deny later send, poll and download as applicable | Status/code and unchanged store counts for each denial | UNPROVEN |
| D-07 | Streaming, push, continuation, blocking send and unsupported methods fail explicitly and are absent from the card | Peer negative requests and error codes | UNPROVEN |
| D-08 | Flags-off rollback removes Phase D routes while preserving earlier Cases/Assets, directed trust history and unrelated routes | Flag state, route responses, stored-record and prior-route checks | UNPROVEN |
| D-09 | Human countersigns D-01 through D-08 at the exact served SHA | Board #34 countersign comment URL, author, SHA and explicit scope | UNPROVEN |

## Decision and rollback

Hosted PASS requires D-01 through D-09 at the same served SHA. On any failed row, stop the peer run, restore both flags to their prior values, preserve all records for diagnosis, and post the exact observed mismatch to board #34. Rework returns through the existing draft PR and a new exact-head CI check. Contract changes require a new version publication, consumer ACK and pjsk02 approval. Until then, PR #211 remains draft and both flags remain off.
