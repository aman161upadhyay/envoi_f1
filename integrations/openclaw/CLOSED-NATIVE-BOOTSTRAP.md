# Exact native observer and one-work process candidate

This implementation prepares a new reviewed native pair from OpenClaw **2026.10.5**. It
uses the real stock Gateway. It does not substitute a direct model-library agent. No
installed native bytes, profiles, enrollment, journal, credentials or website are changed
by importing the client modules. The source patcher returns bytes and never writes files.

The original Gateway has no supported observer for its private ModelRegistry lifecycle;
`getApiProviders()` hides registration owner IDs and the server startup handle exposes no
model-registry owner. Public `AiTransportHost` APIs can wrap physical fetch, but they cannot
prove which private runtime the Gateway actually selected. The candidate therefore adds
one tiny install-once native observer module and modifies exactly two pinned native files:

- `model-registry-Bc1CKDx-.mjs`: records actual API registration source arguments and actual
  owner/runtime/registry objects, and uses public `createNodeLlmRuntime` with the immutable
  host policy. Legacy behavior remains when the new observer is not installed.
- `selection-BCmRjyeC.mjs`: passes the actual selected harness and actual ModelRegistry owner
  before a native attempt begins. It never sends prompts, auth or model headers as evidence.

`prepareNativeObserverPatch` verifies complete original hashes before returning the two new
files plus observer module. Apply these bytes only to a separate reviewed package copy.
The original installation stays intact. The code-only test fixture contains the exact MIT
native source bytes so CI can reproduce the patch without installing or launching a host.

`startClosedNativeGateway` runs **inside a new owned native child**. Its exact supported state
and config paths must already be selected through native environment options and must match
the reviewed canonical path hashes. It authorizes source/target adoption, hashes every critical
native module, finishes both native host installers, checks actual native configuration,
installs the immutable observer/physical host, starts the real `startGatewayServer`, and checks
that dynamic server loading did not replace the gate. It calls actual native config and plugin
registry readers in that same process. It never creates an Envoi connector or credential store.

Preparation copies and audits the **complete detached code tree before the live window**.
The execution owner seals that exact copy, remains its sole writer, and makes no package
changes during execution. Each child hashes all 26 pinned files before its first native
import: the nine bootstrap/observer modules and all 17 closed-capability package, ingress,
agent, provider, registry, selector, policy, transport, summary and slug source seams. Missing
or changed individual hashes refuse before import. The full-tree digest remains a static
preparation/source pin; a child does not rescan thousands of unrelated package files inside
the immutable 120-second native deadline. Full factory preflight remains outside the window.
This strategy does not authenticate an adversarial external filesystem writer; any concurrent
writer or uncertainty about the sealed copy requires stopping and repeating detached review.
An older complete-tree preparation manifest may retain its nine bootstrap keys unchanged:
a fresh full-tree audit must match it before the extra selector hashes are pinned in RAM.

Bootstrap readiness honestly reports `pending_first_harness`. No loaded-runtime proof is
invented from a configuration file. A runtime observation exists only after the two actual
native callbacks identify the actual registered core APIs, owner and selected core harness.
Every physical Anthropic request (including startup, helper, summary, retry or uncertain
attempt) either encounters that same fixed gate or is refused before upstream dispatch.
The gate refuses until actual harness/registry evidence is parent-acknowledged, checks current
config/plugin/registry drift, exact model/origin/path/body and deadline, authorizes each
physical request, preserves native fetch/auth/TLS, and waits for response body drain/cancel.
Unknown work cannot be attributed to another process: the closure binds one immutable work.

`startOwnedClosedNativeProcess` is the parent allocator. It verifies the exact child entry and
native source manifest, invokes trusted source/capability/personal-target authorization, and
owns a dedicated Node child handle and IPC channel. It alone mints the private-WeakMap branded
`OwnedClosedNativeAuthority`. Plain JSON/readiness callbacks cannot mint authority.

`assertOwnedClosedNativeAuthority(authority, expectedPins, signal)` checks the live exact child,
deadline and all required pins: window, work, case, canonical session, private tool channel,
process, client/native sources, capability, personal target selection and target digest.
The allocator acknowledges actual harness evidence only after the parent's verifier returns,
and acknowledges physical dispatch only after the parent's native body commitment authorization succeeds.
IPC messages are bound to the exact owned child/nonce, use unique request IDs and expose no
tokens or prompts. Shutdown requires the child cleanup acknowledgement and actual process exit;
crash/unknown cleanup refuses completion. Only the owned child handle is stopped.

## Exactly one durable physical meter

`authorizePhysical` does **not** reserve or finish model budget. It creates an out-of-band
one-use intent from the actual owned child: intent ID, exact raw body SHA256, immutable
work/process/channel and proxy route. Only the allocator's authenticated IPC handler stages
the intent, after a full harness/registry acknowledgement. The row has a private WeakMap
channel brand: supplying copied JSON, even with a process authority, cannot stage a permit.
The allocator exposes only a frozen consumption/outcome facade. `NativePhysicalIntents` accepts that verified-channel
intent, then the exact per-work proxy consumes its matching raw body commitment **after**
private proxy authentication and **before** the existing request meter's single reservation.
No header alone supplies native provenance, and no new native ownership header is added.
The returned `physicalIntents.takeForMeter({role,nativeToken,window,bodySha256,deadlineUnixMs},
signal)` matches the existing request meter's callback exactly. It verifies the immutable
meter token/window/original deadline and consumes one ticket, without another reservation.

The proxy remains the sole durable `reserve → dispatched → response/lost/abort finish` owner.
Its actual events carry the same intent ID and reservation ID back to the intent tracker.
Child `recordPhysicalOutcome` records headers and body-drained/lost/aborted on the actual
owned channel; it never finishes that durable reservation a second time. A completed
request requires both native terminal outcome and authoritative proxy terminal event.
Unconsumed uncertain intents are retained as orphans and block cleanup until explicitly
reconciled conservatively against the same meter. They are never silently cleared/retried.

The receiving private operator must compose this ticket consumer into its per-work proxy
before forwarding. Calling both the native authorizer and an existing charging proxy as
independent budget reservations would be incorrect. The regression test composes one
verified child intent, one body consumption and exactly one fake durable reservation, and
rejects foreign bytes, repeated body consumption and mismatched/out-of-order outcomes.

The child entry must be bundled for Node from `closed-native-child.ts` and its exact bytes
reviewed before launch. The parent supplies only the selected child environment and existing
native-owned credential configuration. No helper reads/displays a key or copies an Envoi
session. Prepare fresh native state/config/workspace/agent-state copies privately; apply the
native patch only to the reviewed package copy. No original profile or saved authority is
rewritten. The receiving adapter continues using the one canonical connector/journal store.

The restricted effective policy is explicit and default-closed: native plugins disabled,
one Anthropic model and provider, no fallback/custom runtime/CLI backend, no native external
tool families, config hot reload off, no unsupported selector environment. Real native
client-function compatibility, private provider authentication, readiness, physical routing,
pause/revoke/expiry and cleanup still require the actual bounded host run. Offline tests are
not native execution evidence and never approve a new interval or additional model calls.

The real policy approval is recorded in the existing workflow. Exact source adoption, native
pair CI/review, actual per-work personal receipts and a current guarded interval remain
separate prerequisites. This source does not repeat onboarding, sends, approvals or claims.
