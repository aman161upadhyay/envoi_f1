# envoi guard

A demo for signed agent permissions, payment limits, and verifiable evidence. Run commands from this directory with Node 22.13 or later.

## Run locally

The offline Acme Q4 review replay signs a case policy and shows the resulting allow, deny and owner-review decisions. It uses fictional files and simulated slide changes. Case grants cover actions mediated by Envoi and the spending contract's limited key covers NEAR calls. Isolation of the agent's own computer is outside that scope.

```sh
npm install
npm test
npm run demo
npm run demo -- --serve
```

Open http://127.0.0.1:4173/permissions for Settings and Evidence, or /check for the proof checker. The terminal demo screens a fictional invoice with local rules, refuses one payment, permits another, and checks an edited proof. Browser changes in offline mode are saved for the current tab. The offline records are generated separately against the demo’s original rules.

## Envoi case-policy integration

Signed policies are opt-in per agent and case, including native group cases. To expose Case permissions, configure the Envoi server with `ENVOI_SIGNED_POLICY_NETWORK`, `ENVOI_SIGNED_POLICY_RECORD_CONTRACT`, `ENVOI_SIGNED_POLICY_RPC_URL`, and `ENVOI_SIGNED_POLICY_OWNER_ACCOUNTS`. The last setting maps Envoi human IDs to their verified NEAR owner accounts as a JSON object. Register the browser device's public key from the matching owner account before submitting a signed policy. Passkey verification additionally requires `ENVOI_SIGNED_POLICY_RP_ID` and `ENVOI_SIGNED_POLICY_ORIGINS`.

In group cases, each member's owner signs independently. Use `case.snapshot` with an empty target to allow that agent's group timeline, events, and assignments. A `group.message.send` grant binds the text, reply reference, sorted assignee IDs, and sorted IDs of all other group members. Group sends marked Ask first stay blocked until a matching Allowed grant is signed.

Use an isolated test environment for this setup. Enrolling a case makes uncovered actions unavailable, and expiring or revoking the signing key invalidates its grants. For agent case reads, use the scoped case session with a `case.snapshot` grant. Signed file grants bind the immutable file checksum and exact recipient for sharing. The asset HTTP routes consume signed Ask first approvals once. Set `ENVOI_OFFICE_EDIT_PYTHON=python3` in the container to enable Office revisions. Revision uploads name the original asset and checksum and the editable parts. The candidate must pass a saved-version comparison and the scanner before it can become visible.

For case payments, configure `ENVOI_NEAR_PAYMENT_RPC_URL`, `ENVOI_NEAR_PAYMENT_CONTRACT`, and `ENVOI_NEAR_PAYMENT_AGENT_ACCOUNTS` (a JSON map from Envoi agent IDs to their NEAR testnet accounts). The existing consequential-action flag must also be enabled. After approval, the agent can reserve one instruction using `POST /api/inboxes/:inboxId/cases/:caseId/near-payments` with its policy evaluation ID. The agent owns the pay-only key and submits the exact call before expiry. Confirm the finalized transaction using `POST /api/inboxes/:inboxId/cases/:caseId/near-payments/:paymentId/confirm` with `txRef`. Reconcile the original transaction before issuing any replacement payment.

`ENVOI_ENABLE_SENSITIVE_CASES=true` enables the one-way case label for pair-case owners. Set `ENVOI_CASE_TRACE_SIGNING_KEY` to a base64 PKCS#8 Ed25519 key to capture supported case audit steps. Ordinary steps stay in Envoi. Sensitive steps enter the durable seal queue. Workspace administrators can review and export them from Case evidence.

The optional testnet worker `node scripts/seal-case-traces.mjs` uses the existing Guard record transport. Set `NEAR_ENABLE_CASE_TRACE_SEALS=yes`, the testnet record and publisher settings, the verified code hash, and the publisher's scoped key. Give the worker the server's `DATABASE_URL`. For an offline FileStore rehearsal, stop the server and use `--once --offline-file-store` with `ENVOI_DATA_DIR`. Run one publishing service per record account so batch and transaction nonces remain ordered. The worker records finality and inclusion proofs for the Envoi trace format. The existing Guard checker verifies the original Guard proof format.

To screen native Envoi messages before delivery, set `ENVOI_ENABLE_PRIVATE_MESSAGE_SCREENING=true`, `NEAR_AI_API_KEY`, and `NEAR_AI_MODEL`. Install the verifier dependencies in a Python environment and point `NEAR_AI_PYTHON` to its executable. The stock Envoi container includes the verifier source and needs a Python runtime with those dependencies when screening is enabled. Use a server encryption key for the stored receipts. Drain existing native delivery queues before enabling screening. The screening check applies to new native pair and group submissions, including direct case events. Text-only unsigned pair messages can be redacted. Group messages, signed actions, and structured submissions that flag an instruction are blocked. Chat shows the six verified checks, while raw receipts are kept in encrypted server storage. File comments and external email are outside this screening path.

## Rehearse on NEAR testnet

1. Build the contracts with `cargo build --locked --release --target wasm32-unknown-unknown --manifest-path contracts/near/Cargo.toml`. Deploy the resulting record and spend files to separate testnet accounts. Initialize the record with the testnet publisher account and initialize the spending contract. Save the published code hash for the checker. Keep the deployment keys with the testnet custodian while validating the run.
2. Have the owner register Milo on the spending contract with one yoctoNEAR attached and fund the owner’s testnet vault. Put a function-call key with only `pay` on the spending contract on Milo’s account. Put a function-call key with exactly `seal` and `register_evidence_key` on the record contract on the publisher’s account. Use testnet accounts for both payees, including the controlled attacker address. Keep full-access keys outside the demo.
3. Copy .env.example to .env and fill in the testnet IDs. Run `npm run demo:testnet`, then open http://127.0.0.1:4173/permissions in the browser you’ll sign from. Under **Agent keys**, copy the device’s public access key and registry key. Have the owner add the access key to their testnet account as a function-call key for `set_policy` only, restricted to the spending contract. Register the hex public key as a `demo_device` in the record contract with a storage deposit. The browser keeps the private key in its local device store.
4. In Settings, add the allowed payee, set a daily cap, and leave Share files off. Sign the displayed rules and download the confirmed signed policy into this directory as signed-policy.json. The screen reports success after reading the new version and hash back from testnet.
5. Install the verifier dependencies in an isolated Python environment with `python -m pip install -r adapters/nearai/requirements.txt`. Set NEAR_AI_PYTHON if needed, set the API key locally, and select a TEE model that returns provider signatures. Configure the scoped Milo and publisher credentials in the live runner environment and set NEAR_ENABLE_DEMO_PAYMENTS=yes.
6. Run `npm run demo:live`. The script requires a fully verified, flagged message before broadcasting. It reads each finalized outcome from testnet and then seals the evidence. It reserves a fresh output file before broadcasting. If execution stops partway, inspect the existing file and transaction hashes before deciding whether to retry. Set NEAR_EVIDENCE_RUN_FILE to the completed rehearsal file and restart the browser demo to inspect the testnet evidence and attestation rows.

The testnet proof CLI accepts an independently trusted evidence key map and checks contract state with `npm run check -- proof.json trusted-evidence-keys.json --testnet`. Use `--mainnet` for mainnet contracts and `--json` for machine-readable output. For this rehearsal, use the evidence key map from the trusted runner’s output. Keep the record account’s code hash in trusted configuration. A record contract with remaining access keys fails the locked-contract check. Offline CLI checks show skipped online checks.

The CLI prints one plain line per check and exits with **0** when every check passed, **1** when the record can't be trusted, **2** when signatures check out but some checks were skipped or NEAR couldn't be reached, and **3** for a usage error or a file that isn't an envoi proof. A NEAR outage is reported as "Couldn't reach the public record" and never counts as passed or failed. RPC calls use FastNEAR first and fall back to the near.org endpoint; set `NEAR_RPC_URL` to use one endpoint only.

The verifier requires a provider TEE signature, the exact request and response hashes, one matching attested signer, nonce binding, an up-to-date non-debug Intel TDX quote, and a matching NVIDIA verdict. The fixture tests exercise the application’s receipt handling. A live credentialed run is required to confirm compatibility with the selected model and deployed contracts.

### Setup and readiness commands

- `npm run testnet:prepare -- owner.testnet` creates a new ignored .env and two scoped runner key pairs. It prints public keys and derives the six subaccount IDs. It preserves any existing .env.
- `npm run testnet:preflight` checks the network, deployed Wasm hashes, accounts, key restrictions, vault, and signed policy with read-only RPC calls. The NEAR AI check confirms local configuration only.
- `npm run testnet:smoke` sends a deliberately refused testnet payment and seals a smoke record. It checks that the vault balance stays the same. This is a contract test. It does not call inference, transfer funds from the vault, or produce an attested demo proof.
- `npm run demo:live` is the full rehearsal. It holds both demo payments until a real inference receipt passes all checks. Use a fresh output filename after any partial run and inspect its recorded transaction IDs before retrying.

### Record contract: passkeys and envoi's evidence key

The record contract (`contracts/near/record`) lists two kinds of signing key, so a proof can be checked against NEAR without trusting a file from envoi:

| Method | Caller | What it does |
|---|---|---|
| `register_owner_key({ key_type, public_key, label })` | the owner's own account, with a storage deposit | `key_type` is `demo_device` (Ed25519, 32-byte hex) or `passkey` (WebAuthn P-256, uncompressed `04…` hex, 130 characters) |
| `revoke_owner_key({ public_key })` | the owner | Rules signed after revocation stop verifying |
| `register_evidence_key({ key_id, public_key })` | the publisher | Lists one of envoi's Ed25519 evidence keys. Key IDs are lowercase letters, digits and dashes, and are never reused |
| `revoke_evidence_key({ key_id })` | the publisher | Records created after revocation stop verifying |
| `evidence_key({ key_id })`, `owner_keys({ owner })`, `root_of`, `last`, `publisher` | anyone (view) | Read by the checker |

Evidence keys use their own storage prefix, so this code can replace the deployed record contract without migrating its state; already-listed demo keys and sealed batches stay. After redeploying, update `NEAR_RECORD_CODE_HASH`. The publisher's limited key needs `register_evidence_key` added to its method list, or the custodian makes that one call with a full-access key. Then list the runner's evidence key once, before sealing anything signed with it.

With envoi's key listed, `npm run check -- proof.json --testnet` needs no key map. A key map passed as the second argument still overrides the contract.

Passkeys in the browser: `packages/core/passkey.mjs` has `createPasskey()` (returns the hex key to list with `register_owner_key`) and `signWithPasskey({ credentialId, hash })` (returns the proof's `permission.signature`). Set `permission.keyType = 'passkey'` and `permission.rpId`. WebAuthn needs `https` or `http://localhost`; it refuses `127.0.0.1`.

Contract unit tests live in `contracts/near/record/src/lib.rs`. To run them, add `near-sdk = { workspace = true, features = ["unit-testing"] }` under `[dev-dependencies]` in `contracts/near/record/Cargo.toml`, run `cargo test --manifest-path contracts/near/Cargo.toml -p envoi-record` once with network access, and commit the updated `Cargo.lock` together with that line so `--locked` builds keep working.

## Judge walkthrough

1. Run `npm ci --offline`, `npm test`, and `npm run demo -- --serve` from this directory. Open [Demo replay](http://127.0.0.1:4173/demo).
2. Send Ledger Co’s invoice. The timeline shows the locally screened message, the refusal, the blocked share, and the allowed invoice as you advance. The replay displays demo events and leaves the network untouched.
3. Open Evidence. Select **Money** to see both payment outcomes. Open the refused payment and download its proof or select **Check proof**. Select **Edited proof** to verify that the checker rejects a modified record.
4. In Settings, edit Milo’s daily cap and choose **Save changes**. The confirmation sheet shows exactly what the browser signs. In offline mode the browser saves that policy in the current tab.
5. After a credentialed testnet run, load its completed output using NEAR_EVIDENCE_RUN_FILE. Evidence offers individual proof downloads. The browser can check testnet transaction and contract data. Use the CLI for full inference-receipt verification.

For a fresh-clone dry run, start with Node 22.13+ and Git on a clean machine. Time the commands above and confirm the replay, refusal and modified-proof failure before reviewing the online artifacts.

## Sign permissions with a passkey

Open the demo at http://localhost:4173/permissions, select **Create passkey**, and complete the device prompt. The public credential information is saved for this origin and owner. The passkey stays with the authenticator.

For a testnet update, use **Passkey details** to obtain the public key and register it as type `passkey` from the owner account on the updated record contract. The browser also needs its separate Ed25519 device key authorized on the owner account for `set_policy` only, with a 0.2 NEAR gas allowance for the rehearsal. The passkey signs the displayed permission document. The limited NEAR key then submits that document�s hash and spending limits.

Select **Passkey** under **Signing with**, edit the limits, and review the confirmation sheet. Cancellation, an unregistered passkey, a revoked key, or an unsuitable NEAR access key keeps the previous active policy. Success appears after the browser reads back the confirmed version, hash, payees, and daily limit. **Download signed policy** includes `keyType`, `rpId`, the passkey public key and the WebAuthn assertion.


## Evidence-key setup

The publisher's function-call key is limited to `seal` and `register_evidence_key` on the record contract. The live runner creates a unique evidence key ID for each run and reserves the output file before registration. It waits for the registration to be readable from testnet before signing records. Record timestamps are at least the registration timestamp, and every record carries the registered key ID. Sealing uses the same limited publisher key.

`npm run testnet:evidence` registers a verification key, signs and seals one deployment-verification record, and checks the resulting proof through the public evidence registry. It makes no payments or inference calls. The command is restricted to the disposable PR302 deployment. An unlocked record contract remains a failing locked-contract check even when registration, signatures and sealing pass.

The deployed record code hash is documented in [docs/contracts.md](docs/contracts.md). Keep the matching value in the ignored local .env.

## Durable evidence and batching

The live runner accepts both older Ed25519 demo-device files and passkey-signed files. Set NEAR_PASSKEY_ORIGINS to a comma-separated list of exact trusted origins. The default is http://localhost:4173. The origin comes from trusted configuration, and the passkey assertion must match the permission document, owner registry, and active spending policy.

Evidence records and their signed permissions are stored in NEAR_EVIDENCE_DB, which defaults to data/evidence.sqlite. Records have durable event IDs, a global sequence and previous-record links. A repeated event ID returns the existing record only when its content matches. A database is bound to its network, record contract and publisher.

Run `npm run evidence:batch` alongside the testnet demo to check for seal work every 30 seconds. The normal interval is ten minutes, or two minutes with DEMO_MODE=1. Refused payments, blocked shares and flagged messages trigger earlier sealing. `npm run evidence:batch -- --once --force` attempts one pending batch immediately and exits.

The batcher saves the exact signed transaction before broadcasting. On retry or restart it first checks the public record, then reuses that same submission. Evidence shows Sealing or Retrying until a final root and transaction match. A conflicting public batch or a known failed transaction blocks the batch for review. Operator reconciliation is needed for a blocked batch or an expired transaction. The worker never replays payments.

The Settings/Evidence server reads this database in testnet mode when it exists. Refresh Evidence to see persisted records and their batch state. Downloaded final proofs use the original stored signed permission, including passkey metadata. Proof export is unavailable while a record is waiting for final sealing.

A failed full rehearsal can leave durable records awaiting a seal. Recover them with the batch worker. Payment replay remains guarded by the run-output file, which must be reviewed before starting a new rehearsal.

API-free validation on November 7 also used a virtual browser authenticator to sign the disposable owner’s real testnet policy, then submitted it with a separate scoped NEAR key. The runner validated that confirmed version 2 policy. The local rehearsal now reads the ignored signed-policy-passkey.json file. A physical-device acceptance run remains outstanding.

The persistent batcher registered a new evidence key and sealed a record using the passkey-signed permission in transaction `6X5bHczCKB6Fn6U4jtAEHH9JS6WLGnrdAf5abNdEAy4F`. Signature, owner registry, policy, batch inclusion and seal checks passed. The record account still has deployment keys, so the locked-contract check remains a failure.

## NEAR AI account readiness

A successful configuration preflight confirms that a key and model are present. The workspace must also have usable credits and a spending limit. NEAR AI currently rejects inference for the supplied hackathon key with HTTP 402 and the message "No spending limit configured. Please contact support to set up credits." The live runner stops before registering a new evidence key or submitting either demo payment.

Use a canonical model ID while x-no-aliasing is enabled. The provider identified z-ai/glm-5.3-flash as the canonical replacement for the earlier GLM alias during the November 8 check; that value is pinned in the ignored local configuration.
