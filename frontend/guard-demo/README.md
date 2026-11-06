# envoi guard

A demo for signed agent permissions, payment limits, and verifiable evidence. Run commands from this directory with Node 22.13 or later.

## Run locally

```sh
npm install
npm test
npm run demo
npm run demo -- --serve
```

Open http://127.0.0.1:4173/permissions for Settings and Evidence, or /check for the proof checker. The terminal demo screens a fictional invoice with local rules, refuses one payment, permits another, and checks an edited proof. Browser changes in offline mode are saved for the current tab. The offline records are generated separately against the demo’s original rules.

## Rehearse on NEAR testnet

1. Build the contracts with `cargo build --locked --release --target wasm32-unknown-unknown --manifest-path contracts/near/Cargo.toml`. Deploy the resulting record and spend files to separate testnet accounts. Initialize the record with the testnet publisher account and initialize the spending contract. Save the published code hash for the checker. Keep the deployment keys with the testnet custodian while validating the run.
2. Have the owner register Milo on the spending contract with one yoctoNEAR attached and fund the owner’s testnet vault. Put a function-call key with only `pay` on the spending contract on Milo’s account. Put a function-call key with only `seal` on the record contract on the publisher’s account. Use testnet accounts for both payees, including the controlled attacker address. Keep full-access keys outside the demo.
3. Copy .env.example to .env and fill in the testnet IDs. Run `npm run demo:testnet`, then open http://127.0.0.1:4173/permissions in the browser you’ll sign from. Under **Agent keys**, copy the device’s public access key and registry key. Have the owner add the access key to their testnet account as a function-call key for `set_policy` only, restricted to the spending contract. Register the hex public key as a `demo_device` in the record contract with a storage deposit. The browser keeps the private key in its local device store.
4. In Settings, add the allowed payee, set a daily cap, and leave Share files off. Sign the displayed rules and download the confirmed signed policy into this directory as signed-policy.json. The screen reports success after reading the new version and hash back from testnet.
5. Install the verifier dependencies in an isolated Python environment with `python -m pip install -r adapters/nearai/requirements.txt`. Set NEAR_AI_PYTHON if needed, set the API key locally, and select a TEE model that returns provider signatures. Configure the scoped Milo and publisher credentials in the live runner environment and set NEAR_ENABLE_DEMO_PAYMENTS=yes.
6. Run `npm run demo:live`. The script requires a fully verified, flagged message before broadcasting. It reads each finalized outcome from testnet and then seals the evidence. It reserves a fresh output file before broadcasting. If execution stops partway, inspect the existing file and transaction hashes before deciding whether to retry. Set NEAR_EVIDENCE_RUN_FILE to the completed rehearsal file and restart the browser demo to inspect the testnet evidence and attestation rows.

The testnet proof CLI accepts an independently trusted evidence key map and checks contract state with `npm run check -- proof.json trusted-evidence-keys.json --testnet`. For this rehearsal, use the evidence key map from the trusted runner’s output. Keep the record account’s code hash in trusted configuration. A record contract with remaining access keys fails the locked-contract check. Offline CLI checks show skipped online checks.

The verifier requires a provider TEE signature, the exact request and response hashes, one matching attested signer, nonce binding, an up-to-date non-debug Intel TDX quote, and a matching NVIDIA verdict. The fixture tests exercise the application’s receipt handling. A live credentialed run is required to confirm compatibility with the selected model and deployed contracts.

### Setup and readiness commands

- `npm run testnet:prepare -- owner.testnet` creates a new ignored .env and two scoped runner key pairs. It prints public keys and derives the six subaccount IDs. It preserves any existing .env.
- `npm run testnet:preflight` checks the network, deployed Wasm hashes, accounts, key restrictions, vault, and signed policy with read-only RPC calls. The NEAR AI check confirms local configuration only.
- `npm run testnet:smoke` sends a deliberately refused testnet payment and seals a smoke record. It checks that the vault balance stays the same. This is a contract test. It does not call inference, transfer funds from the vault, or produce an attested demo proof.
- `npm run demo:live` is the full rehearsal. It holds both demo payments until a real inference receipt passes all checks. Use a fresh output filename after any partial run and inspect its recorded transaction IDs before retrying.

## Judge walkthrough

1. Run `npm ci --offline`, `npm test`, and `npm run demo -- --serve` from this directory. Open [Demo replay](http://127.0.0.1:4173/demo).
2. Send Ledger Co’s invoice. The timeline shows the locally screened message, the refusal, the blocked share, and the allowed invoice as you advance. The replay displays demo events and leaves the network untouched.
3. Open Evidence. Select **Money** to see both payment outcomes. Open the refused payment and download its proof or select **Check proof**. Select **Edited proof** to verify that the checker rejects a modified record.
4. In Settings, edit Milo’s daily cap and choose **Save changes**. The confirmation sheet shows exactly what the browser signs. In offline mode the browser saves that policy in the current tab.
5. After a credentialed testnet run, load its completed output using NEAR_EVIDENCE_RUN_FILE. Evidence offers individual proof downloads. The browser can check testnet transaction and contract data. Use the CLI for full inference-receipt verification.

For a fresh-clone dry run, start with Node 22.13+ and Git on a clean machine. Time the commands above and confirm the replay, refusal and modified-proof failure before reviewing the online artifacts.
