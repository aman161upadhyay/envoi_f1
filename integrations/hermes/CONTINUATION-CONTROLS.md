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

OpenClaw's existing multi-flow refusal remains closed until a separately
reviewed owned-child authority proves the actual installed native enforcement
and target/source/window/receipt binding. Resolver objects and capability JSON
alone do not satisfy it.
