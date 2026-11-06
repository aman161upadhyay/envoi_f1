# envoi-record (NEAR contract)

The public record behind envoi evidence proofs: chained batch roots plus an append-only registry of signing-key fingerprints. The format is in [`docs/proof-format.md`](../../../docs/proof-format.md).

| Method | Who | What |
|---|---|---|
| `new({ publisher })` | deployer, once | Sets the only account allowed to write |
| `seal({ batch_id, root, previous_root, count })` | publisher | Next batch root. Must be `last + 1` and name the previous root |
| `register_key({ kind, key_ref, key_id, fingerprint, alg, prev_sig_ref })` | publisher | Lists a key fingerprint with the block time. `kind` is `envoi`, `owner` or `owner_demo` |
| `set_publisher({ next })` | publisher | Rotates the publisher account |
| `root_of({ batch_id })`, `keys_of({ key_ref })`, `last()`, `publisher()`, `key_count()` | anyone (view) | Read by `packages/verify` |

What is stored on chain: 32-byte roots, batch numbers, counts, salted owner references, key fingerprints and block times. No names, messages, files or workspace IDs.

## Build and test

Requires Rust (`rustup`), the `wasm32-unknown-unknown` target and `cargo-near`.

```bash
cargo test                      # unit tests in src/lib.rs
cargo near build non-reproducible-wasm
```

## Deploy (testnet first)

```bash
near account create-account sponsor-by-faucet-service envoi-record-dev.testnet autogenerate-new-keypair save-to-keychain network-config testnet create
cargo near deploy build-non-reproducible-wasm envoi-record-dev.testnet \
  with-init-call new json-args '{"publisher":"<publisher>.testnet"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
  network-config testnet sign-with-keychain send
```

Give the publisher account a **function-call key** limited to this contract and the methods `seal` and `register_key`. The server holds only that key (`NEAR_TESTNET_PUBLISHER_KEY`), so a leaked server key can't move funds or call anything else.

## Mainnet: lock it

1. Build reproducibly (`cargo near build reproducible-wasm`) and record the code hash in the top-level README.
2. Deploy to a dedicated account and call `new`.
3. Fund the contract account with about 1 NEAR for storage. Writers attach no deposit, so storage is paid from the contract's own balance.
4. **Delete every full-access key on the contract account.** After that nobody, including envoi, can change the code. Show it with `near account list-keys <account> network-config mainnet now`.

There is no upgrade method on purpose. A fix means a new account, listed in the key file.
