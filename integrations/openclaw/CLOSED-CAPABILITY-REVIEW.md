# Closed core Anthropic capability candidate — review only

This pure client validator is **unadopted**. It neither starts a native process nor opens
the multi-OpenClaw admission guard. Computing a digest, supplying fixture bytes, or returning
`closed_core_anthropic_observations_match` does not establish human approval, trustworthy
native observation provenance, physical egress enforcement, or a Phase C pass.

The proposed bounded capability uses existing supported OpenClaw selectors: built-in
`openclaw`, one exact Anthropic Messages model, one immutable per-work loopback proxy,
`models.mode: replace`, no fallback, explicit core runtime policy, `plugins.enabled: false`,
no plugin load paths/entries/slots, custom harness/runtime/provider stream, external native
tool route, background auxiliary route or inherited capability-changing selector. It keeps
the supported core summary and slug routes only when their observed transport is the same
pinned Anthropic transport. The validator deliberately rejects additions rather than
guessing they are safe. It creates no configuration and changes no model/provider/auth/TLS.

`validateClosedOpenClawCapability(expected, observed)` requires an externally reviewed
approval receipt hash, exact capability digest, selected client/native/artifact hashes,
process/config/state/workspace/agent-state/proxy/private-tool-channel pins, and independently
captured raw bytes for three observations. Every byte digest is explicitly pinned. No
`approved`, `safe`, `metered` or `isCore` boolean can replace these records.

The capability subject digest excludes both its own digest and `approvalReceiptSha256`;
the actual human receipt approves that independent subject. The caller must separately
supply the RAW purpose-specific decision with version `1`, purpose
`closed-openclaw-core-anthropic-capability`, `ownerApproved: true`, a bounded `capability_...`
approval identity, canonical UTC approval/expiry timestamps, and exact subject/window/client/
native-source pins. Its canonical-record hash must equal `approvalReceiptSha256`. The record
must currently be valid and span at most 90 minutes. This validity ceiling grants no new Phase C
interval, calls or host authority; the independent existing time/cap/graph/source controls
remain binding. Earlier approvals for those other purposes cannot approve this capability.

The raw decision must come from an independently trusted human-receipt source. Hash matching
is not cryptographic authentication or proof of human provenance. Computing a matching
synthetic record in a test supplies no real approval and cannot authorize adoption.

The trusted host must capture and independently establish the provenance/completeness of:

- The **effective native selector projection**, after includes, environment substitution,
  model/agent/provider policy precedence and owner selection. `binding.configurationSha256`
  separately pins the complete actual selected configuration; the projection must preserve
  every capability-affecting selector and report unsupported selectors, never silently omit
  them. Unknown projected keys refuse. Credentials stay private and outside these records.
- The actual inherited **capability-changing environment**: QA/runtime override, loader and
  preloads, provider/base URL, proxy/TLS, plugin discovery/source overlays and related native
  selectors. The candidate permits none; an omitted/unobservable selector is not evidence
  of absence. Reviewed state/config path selectors are bound through their canonical hashes.
- Actual **loaded native state**, distinct from configuration: selected built-in harness,
  lifecycle-owned model runtime, provider stream, selected model/fallbacks, complete API
  provider registrations with original artifact ownership, loaded/autoload plugin artifacts,
  and auxiliary/external-tool routes. Configuration alone cannot populate this record. The
  complete registry byte hash and every observed registration owner/source must match.
- The complete source artifact inventory and exact immutable process/path/channel binding.
  Missing, foreign, changed, custom or unobservable evidence must stop before native admission.

These record types are an internal input interface for a trusted observer, **not a new
native proof/signature protocol**. There is no live record producer or actual observation
in this change. A caller can fabricate arbitrary objects in any pure API; this validator
cannot authenticate that caller or turn its JSON into native attestation. The bootstrap
must use actual trusted observation sources and the human must review the concrete closed
policy and exact native/profile adoption. Existing target-selection approval alone does
not supply that new capability approval. The current native guard remains closed.

The remaining live evidence includes physical primary/summary/helper/retry routing and
meter reservations, missing/foreign/spoof/late refusal, source/config/registry drift refusal,
abort/deadline/pause/revoke behavior, pending-request drain, preserved upstream/auth/TLS and
owned process cleanup. The validator does not infer those results from a configuration hash.
Any required custom provider/plugin transport needs its own reviewed equivalent routing
proof or separately approved egress policy; it is refused by this core-only candidate.

The test fixture contains exact extracted native 2026.10.5 plugin activation functions,
their source/function hashes and original lines. Executing those functions inertly proves
that `plugins.enabled: false` disables activation, whereas an empty `plugins.allow` permits
default non-bundled activation. All capability observations and approval receipts in unit
tests are explicitly synthetic offline inputs. Tests touch no profile or real native host.
