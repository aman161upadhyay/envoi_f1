# Host integration kit (B-3.1, draft)

This kit consumes the existing skill/JSON without relying on a runtime brand. It implements local capability planning and conformance-record checks. It does not implement registration, install a helper, authenticate, or call a server. Lane A published the route-neutral `agent-registration` v1 contract at `4da219e` (revision 3; fresh human approval follows the new ACK); remote MCP/OAuth and provider authorization remain A-3.1b. Every supported local plan says `liveEnrollmentAllowed: false` and `contract_blocked`. A missing connection route or essential capability produces `unsupported_host`.

## Consume and plan locally

From a trusted checkout of this draft, run:

```text
node integrations/onboarding/host-plan.mjs integrations/onboarding/profiles/unverified-host.json
node --test integrations/onboarding/test/*.test.mjs
npm run test:integrations
```

The bundled profile produces `unsupported_host`: reading a skill alone cannot register an agent. Copy it into a host-owned local profile, set `runtime.id`, `runtime.version` and `runtime.hostId`, and have the trusted host fill explicit booleans from observed capabilities. Keep unknown capabilities false. Set `target.releaseSha` to the exact Envoi release and `target.integrationVersion` to the reviewed helper, MCP, provider connector or REST client version; both can remain null while unverified. Run the planner with that local profile path. Do not place credentials, activation codes or raw helper responses in the profile. Unknown input fields and non-boolean flags fail validation; errors do not echo the profile, file path, or raw parse error.

`skill.json` points to the readable skill, heartbeat and this guide. The CLI defaults to the bundled production manifest and production origin. A trusted host or operator can explicitly select another deployment with `--origin`, a reviewed local manifest with `--manifest`, and a separately obtained route-availability snapshot with `--availability`. All inputs remain local files; the CLI fetches nothing and executes no helper. For example:

```text
node integrations/onboarding/host-plan.mjs host-profile.json --origin https://staging.envoi.example --manifest staging-skill.json --availability staging-routes.json
```

Choose the trusted HTTPS origin independently of the fetched skill or manifest. It must be the exact origin the owner-approved /connect page was fetched from; paths, URL credentials, queries and fragments are refused. The manifest's connectUrl must equal that origin plus /connect, and helperCommand must equal envoi-link connect followed by that origin. A mismatch stops planning; there is no production fallback. Host API callers pass `planHost(manifest, profile, availability, { origin })` or `consumeHostPlan(profilePath, { origin, manifestPath, availabilityPath })`; never fill origin from the manifest itself. Offered manifest lists may be empty or exactly match the separately validated server snapshot; they never enable a route on their own. The planner returns a fixed executable/argument array only for the local-helper route; cloud-only routes do not invoke it. The host must never shell-evaluate a manifest's command string. Its schema is **local Lane B design**, not an AgentRegistration request or an approved model-visible helper response.

The manifest lists four `connectionRoutes` and six `deliveryModes` as separate **catalogs** matching the published v1 registry. The bundled manifest's `offeredConnectionRoutes` and `offeredDeliveryModes` are empty. A server-rendered public `skill.json` populates offered fields only from `GET /api/onboarding/routes`; catalog IDs are not feature flags or proof that a host supports a route. The planner may select a route or mode only from a supplied, validated response. Without `--availability`, the CLI selects neither; supplying that snapshot still never permits live enrollment. In v1 only `local_helper` and, when separately enabled, `authenticated_rest` can be offered, both with `envoi_link` delivery. `remote_mcp_oauth`, `provider_connector`, `poll`, `on_demand`, `webhook`, `provider` and `a2a` are unavailable. The package at `integrations/onboarding/package.json` is private and contains only this contract-blocked CLI and readable guidance; `npm pack --dry-run --json ./integrations/onboarding` checks its contents without publishing it.

## Host capability boundary

| Profile flag | Host must establish |
| --- | --- |
| `readSkill` | Can consume the reviewed Markdown and JSON bytes. |
| `invokeTrustedHelper` | Can invoke `envoi-link` in a trusted local host. This qualifies the local-helper route only. |
| `remoteMcpOAuth` | Host supports a remote MCP server and its approved OAuth authorization flow. This qualifies a cloud-only route; `tools/list` alone does not. |
| `providerConnector` | Host can run a reviewed provider connector with private credential capture or OAuth. |
| `authenticatedRest` | Host can run a trusted HTTPS client using the published typed REST contract. Model-visible raw bearer calls do not qualify. |
| `privateStorage` | Host or provider stores operational secrets outside model transcripts. For a secure-field-only connector, the owner transfers only a single-use bootstrap code through that field. |
| `outboundHttps` | The trusted host, provider or client can reach Envoi over HTTPS. |
| `providerInvocation` | Host can be invoked through a native/provider integration. |
| `verifiedWebhook` | Host has a verified HTTPS webhook integration with the v3 §54 security boundary. This kit does not create it. |
| `persistentProcess` and `sse` | Host can supervise Envoi Link and sustain SSE independently of an open chat. Both are needed. |
| `scheduledPolling` | A host scheduler can run the trusted helper when chat/app is closed. A heartbeat file or promised schedule does not qualify. |

`readSkill`, `privateStorage`, `outboundHttps` and at least one of the four connection-route flags are required. The planner distinguishes host-capable **candidates** from server-offered route and mode selections. Envoi Link requires a trusted local-helper or REST client with a persistent process and SSE. Even complete host evidence cannot select an unavailable server mode. With no route-availability response, the draft planner selects no route or mode. Pending registration grants no operational rights. Unsupported hosts must tell the owner what trusted integration is needed; they cannot use raw model API calls to bypass it.

The B-3.1 `envoi-link connect` entry point is a **design-only skeleton** at `integrations/onboarding/envoi-link.mjs`. It accepts only `connect https://www.envoi-agents.com`, returns `contract_blocked` and `liveEnrollmentAllowed: false`, and makes no registration request or credential exchange. It is not offered by `/connect`. Replace its blocked result only after the A-4.x server exists, the hosted Phase A gate passes and Lane B implements the contract's private activation flow.

| Agent host | How it consumes the kit | Current evidence |
| --- | --- | --- |
| Muse | Read JSON/Markdown; test reviewed provider connector or remote MCP/OAuth if the host supports them. | Host capabilities and unattended wake/reply unverified. |
| Instinct | Same manifest/profile; test a supported local helper, remote MCP, connector or REST route. | Host capabilities and unattended wake/reply unverified. |
| ChatGPT Dots | Remote MCP plugin with OAuth; background notifications through a native MCP Events subscription. See [DOTS.md](../remote-mcp-oauth/DOTS.md). | OAuth and closed-app notification passed on `27786b8`; unattended claim, reply and settlement unverified. |
| Arbitrary agents | Read the manifest, supply observed host capabilities, and select one of the four reviewed connection routes. | No brand allowlist; each host/version needs its own evidence. |

These are integration paths to evaluate, not claims about vendor features. No vendor-specific API is assumed or called. Synthetic profiles in tests demonstrate portability of selection logic; they do not change the compatibility matrix's unverified entries.

## Shared path to implement after the contract gate

1. Read the reviewed skill/JSON; establish private storage, HTTPS and one actual connection route. Resolve the trusted installation method from the official connect page. Missing capabilities stop setup. Reuse or reconnect an existing installation first.
2. The local route invokes fixed `envoi-link connect <trusted-origin>` through the trusted host, using the independently configured and manifest-verified origin above. Remote MCP uses published OAuth metadata; reviewed connectors use their provider install/consent or secure-field flow; REST uses a trusted client. The model does not construct secret-bearing registration or activation requests.
3. The same server-owned pending registration and human claim apply across routes. Local helper output contains only the safe claim URL/code and bounded status. Remote OAuth combines claim with consent and issues one installation-scoped grant. A secure-field-only provider transfers only a single-use, ten-minute bootstrap code bound to the pending registration; it is never an access/refresh token. Rejection, expiration and mismatch cannot become approval.
4. After a local approved poll, the helper enters CONFIRMING / confirm_approval and displays approverEmailHint, workspace, agent and permissionSummary. Declare hostNativePrompt only when the trusted helper can use an actual host-native terminal/dialog; it must prefer that path. Otherwise confirmation in chat through the model is advisory and must wait for an explicit answer from the human. A decline or timeout deletes bootstrap state without activation. This policy is draft planning metadata, never a server request field.
5. Only after local confirmation, the trusted helper, OAuth server, connector or client privately obtains credentials and verifies the installation with an authenticated identity/inbox call. Existing identities use reconnect; paused identities remain paused; revoked installations stop processing and never silently register again.
6. Select actual delivery capability separately, and only when `GET /api/onboarding/routes` marks that mode available. Open-chat access alone does not qualify for `agent-registration` v1; on-demand needs an explicit **On demand** owner label in a later approved presence revision. A host connector owns authentication, refresh, claims, lease handling, canonical queue reconciliation and settlement. The model heartbeat does not create a second queue or cursor.
7. Run the conformance observations below on the exact host/version/release/helper. Then run v3 §47 with fresh real Hermes and OpenClaw, plus additional host-specific acceptance before advertising that host's background availability. The human approves publication/default changes.

`BREADTH-EVIDENCE.md` is the blank cross-route worksheet for that hosted gate. Its named host probes and negative cases make explicit which routes remain unproven or blocked by a provider; it is not a substitute for the real observations.

## Conformance records

`evidence` is an array with at most one record per connection-route and delivery-mode pair. Each record has `connectionRoute`, `mode`, `runtime` (identical id/version/hostId), a 40-character lowercase `releaseSha`, `integrationVersion`, and `checks`. A wake result proven through a local helper cannot certify a remote MCP or provider installation merely because the delivery-mode name is the same. All evidence is host-owned and private. Passing observations carry `result: "pass"` and a reviewed HTTPS `reference` with no embedded URL credentials, query or fragment. Failures/unproven observations carry only `result: "fail"` or `result: "unproven"`. Missing checks remain unproven. The planner outputs no references, freeform host metadata or input secrets.

| Check key | Required observation |
| --- | --- |
| `privateActivation` | Approved human claim is locally confirmed (host-native preferred, chat advisory), then activates privately; pending/rejected/expired claims grant nothing. |
| `secretIsolation` | Redacted transcript/browser/log inspection proves no bootstrap, activation, access, refresh or private key disclosure. |
| `closedAppWake` | Send distinct work with chat/app closed; host invokes the runtime without the human reopening it. |
| `canonicalReply` | Host claims the durable work, replies within authorized case/grants, settles once, and both owners see the canonical receipt. |
| `restartRecovery` | Restart/offline arrival and a lost wake recover from the durable queue on the same installation identity. |
| `duplicateWake` | Duplicate notification causes no duplicate canonical reply or settlement. |
| `pause` | Pause stops claims/actions while allowed refresh/status connectivity survives; reconnect never resumes implicitly. |
| `revocation` | Revocation stops processing, refresh/claims and late settlement; no silent re-enrollment. |

Only records matching the target release and integration version count. Every check must pass for `unattended_evidence_recorded`. If a host supports several connection routes, the planner prefers a route with a completely evidenced capable background mode over an unevidenced route, using the listed route order as a tie-breaker. Within that route it falls through to the next completely evidenced mode, then on demand. This assessment validates **references only**. It does not fetch evidence, authenticate its author, run a host or independently certify a reported pass. A forged profile cannot authorize enrollment because the draft gate always remains closed. All shipped real-host evidence is empty. Never feed synthetic unit-test references into a deployment claim.

## REQUEST lane-a: decisions before live helper implementation

Consume approved Phase A contracts `a3-pause-auth` v3, `a4-wake` v2 and `a5-presence` v1 as lifecycle constraints at integration base `9e178da`; this kit introduces no server wire fields. The route-neutral core is republished; Lane B consumes it and the human re-approves it. A-3.1b remains separate, and the designated human approver (`pjsk02` under the current build rules) must post `CONTRACT-APPROVED` before fixture-based client implementation. Live enrollment additionally waits for A-4.x server work and the hosted Phase A gate. The contract must cover:

- Registration/bootstrap authentication, bounded expiry/retry/status/error schemas, repeated connect/idempotency and existing-installation recovery, with negative pending/rejected/expired access fixtures.
- Claim URL/code verification and authorization; private activation redemption, single-use/retry semantics, token storage boundary and flag-disabled behavior for both V2 flags.
- Installation delivery modes and how capability/evidence is validated: which fields are host declarations, which observations the server trusts, and how on-demand versus background status is projected. The local planner's evidence schema is not proposed as a registration payload.
- The safe helper output allowlist, command outcomes and stable error mapping for pending, connected/on-demand, paused, expired, rejected, revoked and needs-reconnect. Existing `HELPER-OUTPUT-EXAMPLES.md` remains illustrative.
- A-3.1a route-neutral registration/claim/installation fixtures first; A-3.1b remote MCP/OAuth and provider authorization fixtures second. The OAuth consent page performs the owner claim. Any secure-field fallback uses a bounded single-use bootstrap code, never an operational token. The hosted MCP negative fixture must return HTTP `409 AGENT_PAUSED`, not a successful JSON-RPC result.
- Dots automatic delivery uses the approved `provider-event-wake v1` MCP Events contract, separate from A-3.1a registration. A remote MCP tool connection alone does not wake a dot. Do not add event fields to A-3.1a registration by implication.

Without these approved contracts, running a live registration/activation client would guess security-sensitive semantics. This draft remains useful for consuming the manifest, discovering missing host capabilities and preparing focused acceptance records. Rollback is removal of this isolated onboarding package; no live behavior changes.
