# Phase D contract v1 — relationships, discovery, authorization, A2A

Status: draft implementation on `lane-b/phase-d`; the canonical `phase-d` v1 contract in [handoffs.md](handoffs.md#phase-d-v1) and `test/contract-fixtures/phase-d/` was approved by pjsk02 in [board #34 comment 6416305575](https://github.com/rachelgonsalves821/Envoi/issues/34#issuecomment-6416305575). Approval covers contract bytes and dependent source corrections, not hosted acceptance, integration or release. Phase A/B/C human acceptance remains historical evidence and does not certify Phase D.

## D0 — integration baseline and gates

PR [#203](https://github.com/rachelgonsalves821/Envoi/pull/203) and PR [#173](https://github.com/rachelgonsalves821/Envoi/pull/173) merged into `integration/agent-native` on 2026-10-23. This branch was reconciled with integration head `0fcd55f` in merge `2fd3a4b`. Phase D changes remain default off. No deploy, token, or Cloudflare operation is part of this contract.

`ENVOI_RELATIONSHIPS_V2=true` requires `ENVOI_INSTALLATIONS_V2=true`. `ENVOI_A2A_GATEWAY=true` additionally requires relationships and an `ENVOI_PUBLIC_URL` with an HTTPS origin (loopback HTTP is allowed for local tests). An invalid flag combination fails startup. The two Phase D flags are not enabled by this branch.

## D1 — directed relationships and trusted discovery

A relationship is a grant **from** one active agent **to** one exact-address agent. A workspace administrator creates or revokes it for the granting inbox. Its grants are distinct members of `shareAssets`, `autoAcceptSelectedTasks`, `richerProfileVisibility`, and `allowInvitations`. A relationship has `active` or `revoked` status; no reverse relationship is inferred. Creation locks both inboxes and rechecks identity, target verification, and reciprocal contact blocks. Discovery rechecks blocks, so a later block suppresses relationship trust. These grants are recorded capabilities; this release does not automatically execute a task or share an Asset from the grant alone.

| Caller | Route | Contract |
| --- | --- | --- |
| Workspace administrator | `POST /api/inboxes/{inboxId}/relationships` | Body: `actorAgentId`, exact `targetAddress`, `grants`; returns directed record. |
| Workspace administrator | `POST /api/inboxes/{inboxId}/relationships/{actorAgentId}/{targetAgentId}/revoke` | Revokes a directed record. |
| Workspace administrator | `GET /api/inboxes/{inboxId}/discovery?address=…&actorAgentId=…` | Exact-address lookup scoped to a manageable inbox. |
| Installed agent | `GET /api/agent/discovery?address=…` | Exact-address lookup. Response includes `agentId`, `address`, trust source and active grants. |
| Installed agent | `GET /api/agent/discovery?scope=organization&limit=1..50&after={inboxId}` | Paged list from the caller's organization workspaces only; rechecks target organization and reciprocal blocks. |
| Workspace administrator | `POST /api/inboxes/{inboxId}/discovery-invitations` | Body: issuer `actorAgentId`, exact `recipientAddress`; returns an audience-bound invitation and 24-hour expiry once. Stored record contains a token hash, never the token value. |
| Workspace administrator | `POST /api/inboxes/{inboxId}/discovery-invitations/{id}/revoke` | Revokes the invitation. |
| Installed recipient agent | `POST /api/agent/discovery/invitation` | Body: `{ "invitation": "…" }`; verifies signature, audience, expiry, stored hash, issuer state and blocks. The token is never put in a URL. |

The trust source is `relationship`, `approved_contact`, `same_organization`, `signed_invitation`, or `exact_address`. Active, verified agents only are returned. There is no global list or guessed-ID lookup. An exact address can still resolve without a trust grant; trust is contextual information, not a prerequisite for native message delivery. When the A2A gateway flag is on, discovery adds that agent's `a2aCardUrl` from the configured public origin.

## D2 — authorization migration

`authorize({ actorAgentId, installationId, action, relationshipId?, caseId?, resourceId? }, facts)` returns `{ allowed, reason }`. It checks in this order: active identity, active bound installation, action permission, optional directed relationship and block, required Case membership, required resource grant, policy, then human approval. A missing required fact denies. Actions map to existing agent permissions: Case work to `execute_cases`, Asset grant to `create_assets`, and discovery/A2A to `send_agent_messages`.

With `ENVOI_RELATIONSHIPS_V2=true`, agent mutations for Case create, events, policy evaluation, proposals, actions, receipt completion, and Asset grants call this evaluator using current facts inside their existing mutation locks. Their pre-existing policy, human approval, and Asset rules remain in force; this migration adds gates and does not loosen them. A2A send and polling use the same evaluator on each request. Existing nonmigrated routes keep their established checks.

## D3 — A2A edge over canonical Envoi work

The adapter implements an intentionally small [A2A v1.0.1](https://github.com/a2aproject/A2A/blob/v1.0.1/docs/specification.md) HTTP+JSON subset. It uses direct agent-card configuration: an authenticated exact-address discovery result supplies `/api/agent/a2a/agents/{address}/card`. The card identifies one verified agent, advertises Bearer authentication and text input/output, and declares streaming and push unsupported. There is no global card or agent directory.

| Route | Behavior |
| --- | --- |
| `GET /api/agent/a2a/agents/{address}/card` | Requires a current installed agent with discovery permission; returns an address-specific Agent Card. |
| `POST /api/agent/a2a/agents/{address}/message:send` | Requires `application/a2a+json`, one `ROLE_USER` text part and `returnImmediately: true`. Uses a caller/target/message-ID scoped idempotency key to submit a native Envoi message. The native route commits its message, Case, event and outbox before the adapter reads and projects the Case as a Task. |
| `GET /api/agent/a2a/agents/{address}/tasks/{caseId}` | Rechecks identity, installation, permission, Case membership and the original caller/target A2A event; projects the persisted Case state. |

Task artifacts are references to clean, authorized Envoi Assets. Their content URLs point to an authenticated Envoi Asset endpoint, which rechecks access on download. The adapter does not create a second task or artifact store. Multi-turn continuations, blocking sends, streaming, push and other A2A methods return explicit errors; they are not represented as supported capabilities. The gateway depends on the native message route's exact-address, policy, idempotency and delivery checks. Delivery wakes only after durable native writes.

## Verification and release boundary

Focused tests exercise directionality, revocation, reciprocal blocks, organization boundaries, invitation audience/expiry/revocation, ordered deny reasons, Case and Asset migration, A2A authentication, idempotent send, durable Case projection, scoped polling, authorized artifact bytes, and flag-off behavior. The build and full test suite are required before the review PR. Hosted behavior, external A2A interoperability, flag enablement and deployment need separate review and acceptance.
