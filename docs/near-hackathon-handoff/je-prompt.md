# Je · NEAR AI billing, contracts, and checker

Own the live NEAR prerequisites and independent proof verification on `lane-c/20261106-02-near-record`. Your existing record contract and original checker are already integrated. Send Rachel any targeted Lane C changes required for the rehearsal.

## Features and checks to finish

1. **Unblock billing first.** The last readiness probe returned HTTP 402 for the rehearsal key. Enable funded inference and a spending cap in NEAR AI Cloud, or use a separate funded NEAR Builders key. Configure the runner’s local `NEAR_AI_API_KEY` privately and tell Rachel when it is ready. Rachel will run the six-check readiness probe.
2. **Confirm the testnet deployment.** Provide the disposable spending and record account IDs, reproducible Wasm hash, agent key scope for `pay`, publisher scope for `seal` and `register_evidence_key`, and a reliable RPC endpoint. Confirm how to demonstrate that the refused payment leaves the vault balance unchanged.
3. **Verify receipt lookup.** Batch 4’s public root and count matched, but the last transaction lookup timed out for `6X5bHczCKB6Fn6U4jtAEHH9JS6WLGnrdAf5abNdEAy4F`. Verify the receipt through a reliable testnet RPC. If a checker change is needed, keep it narrow and test that unavailable RPC data and invalid proof data produce distinct outcomes.
4. **Lock and verify.** After a successful dry run, propose the exact disposable record account and lock sequence for Rachel’s approval. Return the final lock receipt after the authorized lock. Independently verify the fresh genuine proof, then change one field and confirm the checker rejects the edited copy.

## Handoff to Rachel

- Funding ready status, public testnet account IDs, code hash, publisher scope, and RPC endpoint.
- Finalized payment and seal receipts, record-lock receipt, exact checker commands, and genuine and edited proof verdicts.
- Any targeted Lane C commit and its test results. Keep keys in local configuration.

Rachel owns server integration, passkeys, batching, and the live rehearsal. Aman owns chat and the video. [NEAR AI Cloud](https://cloud.near.ai/dashboard/keys) · [NEAR Builders](https://nearbuilders.org/dashboard)
