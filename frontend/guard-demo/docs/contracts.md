# Testnet record deployment

Verified on November 7, 2026.

| Field | Value |
| --- | --- |
| Network | NEAR testnet |
| Record contract | `record.envoi-pr302-20261106.testnet` |
| Publisher | `publisher.envoi-pr302-20261106.testnet` |
| Code hash (NEAR base58 SHA-256) | `FDvRgQSwfbocdwNRgdu53WhkXB39rYutZvohTd83ZK7s` |
| Contract source commit | `be92054` |
| Upgrade transaction | `FWo2zuCQDRzNvGqvHop5T5vvvhWgn2WPzszsgiqQbynJ` |
| NEAR SDK | `5.17.2`, dependencies pinned by Cargo.lock |
| Rust toolchain | `stable-x86_64-pc-windows-gnu`, Rust 1.99.1 |
| Build command | `cargo build --locked --release --manifest-path contracts/near/Cargo.toml --target wasm32-unknown-unknown` |

The new code was deployed without calling `new` again. Every existing batch root, the last batch pointer, owner-key registrations and publisher identity were compared before and after the upgrade and matched.

The publisher's limited key now permits exactly `seal` and `register_evidence_key`. The deployment account retains access keys while testing, so the checker's locked-contract check will fail. Removing deployment keys requires separate approval.

This is a locally compiled testnet build. A reproducible container build and a matching independently rebuilt hash remain part of release acceptance.

The deployment verification registered an evidence key in transaction `9sAFHJp8zuEyZ9xC8Dmn77mwU42F6hXZV3rpv2zWKMif`, then signed a record and sealed it in transaction `GhmaBHFUYE6nojGAApmUiAT5tEjfqz3Aq1hNHNN8Po28`. The checker passed the envoi signature using the public evidence registry, content, owner signature, owner registry, displayed rules, spending policy, batch inclusion and seal. The locked-contract check failed because the testnet deployment keys remain.
