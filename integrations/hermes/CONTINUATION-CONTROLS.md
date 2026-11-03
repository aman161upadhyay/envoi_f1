# Trusted pre-native checkpoints

`runPreNativeControl` is a trusted operator path on the existing connector and
credential store. It neither releases a native graph flow nor binds a native
token. The controller refuses native admissions and new flow releases while the
checkpoint is held. Its original window, cumulative ledger and charged history
remain authoritative.

The operator supplies an exact control ID, mode, role, case, work and canonical
receipt digest. The actual authenticated claim must match the canonical actor
and case. A previously submitted native work or an existing scoped journal is
ineligible. The callback receives the actual minted scope and snapshot, redacted
claim/session bytes, and a live accessor for the matching renewed lease expiry.
No lease or case-session token leaves the receiver.

The private channel accepts snapshot/list reads. Only `authority-expiry` may
register one exact `envoi_case_decide` denial probe after obtaining the new
opaque references. The trusted short-expiry fixture must independently verify
the real expiry and charge its allocated action before forwarding. Registration
alone grants no authority and proves no denial. The observer runs before the
same action-reservation callback and the one physical forwarding. A replay,
changed bytes, scope override or successful non-read result is refused. There
is no transport retry for this path and no model tool allowance is widened.

The callback must stop with a supported handler failure. The receiver retains
the actual end/fail responses, sanitized failure request, journal absence and
unchanged request counts. Its returned `stopped_before_native` value is capture
evidence only. The conductor must verify the exact denial, retryable settlement,
reoffer, and a higher-fence scope before a later separately admitted native turn.
No-action native policy remains unchanged.

For the original native turn, `nativeFacts(workId)` supplies the captured actual
native submission frame, current scoped journal and safe session to the trusted
transport observer. `observeNativeEnd` receives the stable completed journal,
actual scope-end response and actual processed response. These hooks expose no
private access token or second credential store. Caller-supplied callbacks and
test fixtures are not human approval or native-capability attestations.

`beforeFirstScopedSnapshot` runs after the actual claim/mint and before the
first snapshot reaches the server. It can dispatch the separately approved
one-shot REST fixture through the same connector, then return so the original
native input contains fresh policy. `scopedFacts(workId)` is available at this
point without pretending that a native frame/journal already exists. The gate's
same promise is retained on failure; retrying the snapshot cannot skip it. The
callback must not recursively request a scoped snapshot or wait for a later
human action, native completion, or database evidence.

OpenClaw defaults to refusing a multi-flow graph. The explicit owned-native
path requires a real opaque allocator authority before native admission, bound
to the actual canonical session/channel, target digest, process, personal
selection, source and window. The per-work capability hash comes from that
authority's immutable private pins. It is distinct from the generic
`factoryPolicySha256`; two children can have different capability receipts.
Resolver objects, callbacks returning JSON and capability metadata cannot mint
this authority. Bootstrap evidence remains `pending_first_harness`: the actual
child must obtain independent real harness/registry acknowledgement before any
physical request can be authorized by the meter.

An opaque `OwnedOpenClawFactory` may replace the obsolete saved-gateway startup
probe only after its actual source tree, child bytes and policy authorization
are revalidated. This starts no gateway, submits no prompt and invents no work
or case session. The bridge still validates the saved scoped configuration and
opens the same enrollment store. Without a genuine prepared factory, normal
gateway discovery/startup checks continue to run.
