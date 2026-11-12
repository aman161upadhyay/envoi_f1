# Independent testnet verification (Lane C)

Checked on November 11, 2026, from a separate machine with read-only RPC calls only: no keys, no transactions. Everything below can be re-run by anyone.

## Accounts and key scopes

| Role | Account | Code hash | Access keys |
|---|---|---|---|
| Owner | `envoi-pr302-20261106.testnet` | none | 1 full access, 5 function-call keys for `set_policy` on the spending contract (browser devices) |
| Record contract | `record.envoi-pr302-20261106.testnet` | `FDvRgQSwfbocdwNRgdu53WhkXB39rYutZvohTd83ZK7s` | **1 full access** (`ed25519:81WnVeLpc7YenV6PMrDWkgUgFMhs6BaHtF9rgVzqd3Mo`), so the locked-contract check fails until the lock below |
| Spending contract | `spend.envoi-pr302-20261106.testnet` | `9cphtGL6zC4f3vsfozti28EqzUGVnGBLD5JqrnkTmUPt` | 1 full access |
| Agent (Milo) | `milo.envoi-pr302-20261106.testnet` | none | **only** a function-call key for `pay` on the spending contract |
| Publisher | `publisher.envoi-pr302-20261106.testnet` | none | 1 full access (custodian) and a function-call key for exactly `seal` and `register_evidence_key` on the record contract |
| Payee / attacker | `ledger.` / `attacker.envoi-pr302-20261106.testnet` | none | full access (test payees) |

The record code hash matches `docs/contracts.md` (source commit `be92054`). It is a locally compiled build; a reproducible container build and an independently rebuilt hash are still open.

## Receipts

| What | Transaction | Result |
|---|---|---|
| Seal, batch 4 | `6X5bHczCKB6Fn6U4jtAEHH9JS6WLGnrdAf5abNdEAy4F` | FINAL, success. Arguments match `root_of(4)`: root `ed5f3cbe…af1`, previous `32c37099…579`, count 1 |
| Seal, batch 2 | `GhmaBHFUYE6nojGAApmUiAT5tEjfqz3Aq1hNHNN8Po28` | FINAL, success, matches `root_of(2)` |
| Evidence key listing | `9sAFHJp8zuEyZ9xC8Dmn77mwU42F6hXZV3rpv2zWKMif` | FINAL; `evidence_key("ev-058eb7f671d64718bccb8cba")` is listed and not revoked |
| Refused payment, not a payee | `2h2wQZSp1zag8885oNvgdu7TphDaDkxtdtFgv7852nP9` | `refused` / `not_payee`, 20 NEAR to `attacker.…`. Vault 2.000000 NEAR before and after |
| Refused payment, over the limit | `DCAMevY3PQbpf4tXegKKuwo41RpMcDd2fKrWq499eAow` | `refused` / `over_max`, 1 NEAR to `ledger.…`. Vault 1.999999 NEAR before and after |
| Allowed payment | `DtQNV49zEph9EzbwxJXAhbaMvGhfb5jCCFaD2FRFsu6m` | `paid` to `ledger.…`. Vault 2.000000 → 1.999999 NEAR |

**Showing that a refusal moves nothing.** Read the owner's vault with `vault_of` from an archival node at the block just before the payment and a few blocks after, using `block_id`. Both refusals above read the same balance on both sides; the one allowed payment is the only change. This works for any payment, at any time after the fact:

```js
rpc('query', { request_type: 'call_function', block_id: <height - 1 | height + 5>,
  account_id: 'spend.envoi-pr302-20261106.testnet', method_name: 'vault_of',
  args_base64: base64('{"owner":"envoi-pr302-20261106.testnet"}') })
```

## RPC endpoints

- Views and new transactions: `https://test.rpc.fastnear.com`, then `https://rpc.testnet.near.org`.
- Transaction lookups: `https://archival-rpc.testnet.fastnear.com`, then `https://archival-rpc.testnet.near.org`.

Regular testnet nodes keep only a few days of transactions. On November 11 they already answered `UNKNOWN_TRANSACTION` for the November 7 seals, and waiting for `FINAL` on them timed out (that is the batch 4 timeout in the handoff). Archival nodes return them in about half a second. The checker now looks transactions up on archival nodes first, without waiting, and only reports a transaction as missing when no node has it (commit on `lane-c/20261111-03-archival-tx`). An unreachable NEAR gives "Not fully checked yet" (exit 2); a transaction nobody has gives "This record can't be trusted" (exit 1).

## Proposed lock (needs Rachel's approval)

Lock only `record.envoi-pr302-20261106.testnet`, after a successful dry run:

1. Confirm the code hash is still `FDvRgQSw…` (or the reproducible rebuild's hash, if it replaces it) and record it in `NEAR_RECORD_CODE_HASH`.
2. Confirm the contract can pay for storage on its own: today 2.404 NEAR balance, 1.948 NEAR locked by 194,812 bytes, **0.456 NEAR free**. A seal or evidence key listing costs about 0.002 NEAR, and the publisher's key can't attach a deposit. Top up to about 1 NEAR free first, because after the lock nobody can add a method to recover funds.
3. Confirm `publisher()` is `publisher.envoi-pr302-20261106.testnet` and that its limited key allows exactly `seal` and `register_evidence_key`.
4. Delete the record account's only full-access key, signed by that key:
   `near account delete-keys record.envoi-pr302-20261106.testnet public-keys ed25519:81WnVeLpc7YenV6PMrDWkgUgFMhs6BaHtF9rgVzqd3Mo network-config testnet sign-with-keychain send`
5. Verify: `view_access_key_list` is empty, the code hash is unchanged, and `npm run check -- <proof> --testnet` shows the locked-contract check passing.

This can't be undone: the contract has no upgrade or key-adding method. A fix after the lock means a new record account. Leave the spending contract unlocked for the rehearsal.

## Checker commands

```bash
npm run verify:deployment -- --seal 6X5bHczCKB6Fn6U4jtAEHH9JS6WLGnrdAf5abNdEAy4F --refusal 2h2wQZSp1zag8885oNvgdu7TphDaDkxtdtFgv7852nP9 --refusal DCAMevY3PQbpf4tXegKKuwo41RpMcDd2fKrWq499eAow
npm run check:run -- testnet-run.json   # every proof, plus an edited copy of each
```

On November 11 the first command passed every check except the lock ("not locked yet", exit 2).

```bash
npm run check -- genuine-proof.json --testnet          # envoi's key from the record contract
npm run check -- edited-proof.json --testnet           # expect exit 1, "This record can't be trusted."
npm run check -- genuine-proof.json trusted-evidence-keys.json --testnet   # optional pinned key map
```

Exit codes: 0 verified, 1 can't be trusted, 2 not fully checked, 3 usage or not a proof.

## Still open

- NEAR AI billing (HTTP 402) blocks the live rehearsal. This is an account and payment step for the team.
- The fresh genuine and edited proof verdicts follow once the rehearsal produces a proof.
- The reproducible Wasm hash needs a machine with Rust, `cargo-near` and Docker.
- The lock receipt comes after Rachel approves the sequence above.
