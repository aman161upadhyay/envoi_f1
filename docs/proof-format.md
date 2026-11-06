# envoi proof format v1 (`envoi.proof/v1`)

Status: draft for the NEAR HACKATHON build. Lane C owns this file; changes need a heads-up to the server lane because the server produces these bundles.
Machine-readable schema: `protocol/envoi-proof-v1.schema.json`. Reference implementation: `packages/verify/`.

A proof lets anyone check one evidence record without an envoi account and without trusting envoi. It answers four questions:
1. Did envoi sign this record, with a key listed on NEAR?
2. Was the rule in force signed by the owner's device, and was that device listed on NEAR before they signed?
3. Is the record unchanged since it was recorded?
4. Is it part of a batch whose root is on NEAR, and since when?

Everything except reading NEAR happens offline in the checker.

---

## 1. Encodings

| Thing | Encoding |
|---|---|
| Hash | SHA-256, lowercase hex, 64 chars, no prefix |
| Salt | 32 random bytes, lowercase hex |
| Signature (Ed25519) | base64url, no padding |
| Public key | JWK. Ed25519: `{kty:"OKP", crv:"Ed25519", x}`. P-256: `{kty:"EC", crv:"P-256", x, y}` |
| Key fingerprint | `sha256(canonical(jwk))` over the JWK members above only (no `alg`, `kid`, `use`) |
| Time | RFC 3339 UTC string with `Z` |
| Canonical JSON | RFC 8785 (JCS): keys sorted by UTF-16 code units, no whitespace, ECMAScript number and string serialization. `undefined`, `NaN`, `Infinity` and non-plain objects are rejected |

`canonical(x)` below means the UTF-8 bytes of the JCS string.

---

## 2. Record hash

```
detailsHash = details == null && redacted ? <kept from before redaction>
            : sha256( hex2bytes(detailsSalt) || canonical(details) )
record_hash = sha256( canonical({
  schema: "envoi.evidence/v1",
  id, workspaceId, seq, type, agentId, caseId,
  summary, detailsHash, ruleVersionHash, privateCheckHash, chainRef,
  occurrences, firstAt, lastAt, salt, previousHash
}) )
envoiSignature = Ed25519.sign(envoiKey, hex2bytes(record_hash))
```

- Every field above is present; use `null` when it does not apply (`caseId`, `ruleVersionHash`, `privateCheckHash`, `chainRef`, `previousHash` for `seq` 1).
- `ruleVersionHash` is the `documentHash` of the permission version in force. It binds the record to that version, so a proof can't be paired with a different signed version.
- `privateCheckHash = sha256(canonical(privateCheck))` when a private check is attached.
- `previousHash` is the `record_hash` of `seq - 1` in the same workspace.

## 3. Batch tree (RFC 6962 Merkle tree hash)

```
leaf(h)      = sha256( 0x00 || hex2bytes(h) )
node(l, r)   = sha256( 0x01 || l || r )
MTH([])      = sha256("")              (never published)
MTH([d])     = leaf(d)
MTH(D[0:n])  = node( MTH(D[0:k]), MTH(D[k:n]) ),  k = largest power of two < n
```

Leaves are ordered by `(workspaceId, seq)`. The inclusion proof is the RFC 6962 audit path, listed bottom-up with an explicit `side` (`left` or `right`) per sibling. The checker recomputes the sides from `leafIndex` and `count` and rejects a proof whose sides don't match.

The published root is chained: each batch stores the previous batch's root, and the contract only accepts `batchId == last + 1` and `previousRoot == lastRoot`.

## 4. Permission version and owner signature

```
documentHash = sha256( canonical(document) )      // document.schema == "envoi.permissions/v1"
```

The owner signs with WebAuthn (`navigator.credentials.get`) using `challenge = hex2bytes(documentHash)`. The checker verifies:
1. `clientDataJSON.type == "webauthn.get"` and `clientDataJSON.challenge == base64url(hex2bytes(documentHash))`.
2. `clientDataJSON.origin` equals `rpOrigin` in the proof, and `authenticatorData[0..32] == sha256(rpId)`.
3. Flags: user present (bit 0) is set. User verified (bit 2) is reported.
4. ES256 signature (DER) over `authenticatorData || sha256(clientDataJSON)` with `ownerPublicKey`.
5. `fingerprint(ownerPublicKey)` is listed in the NEAR key registry under `ownerRef` with kind `owner` (or `owner_demo` for the demo device), at a block time at or before `document.issuedAt`.

## 5. Bundle

```json
{
  "format": "envoi.proof/v1",
  "record": { "schema": "envoi.evidence/v1", "id": "...", "workspaceId": "...", "seq": 12, "type": "permission_blocked",
              "agentId": "...", "caseId": null, "summary": "...", "detailsHash": "hex", "ruleVersionHash": "hex",
              "privateCheckHash": null, "chainRef": null, "occurrences": 1, "firstAt": "...", "lastAt": "...",
              "salt": "hex", "previousHash": "hex" },
  "details": { "...": "optional" }, "detailsSalt": "hex (only when details is present)",
  "recordHash": "hex",
  "envoiSignature": { "keyId": "ev-2026-11", "alg": "Ed25519", "signature": "base64url", "publicKey": { "kty": "OKP", "crv": "Ed25519", "x": "..." } },
  "permissionVersion": {
    "document": { "...": "permission document in force" },
    "documentHash": "hex",
    "method": "passkey | demo_device",
    "ownerRef": "hex (salted owner reference, as listed on chain)",
    "ownerName": "Rachel Gonsalves",
    "rpId": "envoi-agents.com", "rpOrigin": "https://envoi-agents.com",
    "ownerPublicKey": { "kty": "EC", "crv": "P-256", "x": "...", "y": "..." },
    "assertion": { "authenticatorData": "base64url", "clientDataJSON": "base64url", "signature": "base64url (DER)" }
  },
  "privateCheck": { "...": "optional, see section 6" },
  "batch": { "batchId": 1042, "root": "hex", "previousRoot": "hex|null", "count": 37, "leafIndex": 12,
             "siblings": [ { "hash": "hex", "side": "left" } ] },
  "seals": [ { "network": "near-mainnet", "contractId": "record.envoi.near", "batchId": 1042, "txRef": "...", "explorerUrl": "..." } ]
}
```

`ownerName` is shown to the person checking but is not trusted; the trust anchor is `ownerRef` plus the key registry.

## 6. Private check (optional)

`privateCheck = { verdict, reason, model, chatId, requestHash, responseHash, signatureKind, signedText, signature, signingAddress, attestation: { nonce, checkedAt, checks: [{name, ok}] }, mock }`

The checker verifies `privateCheckHash` and that `signature` (Ethereum personal-sign, secp256k1) over `signedText` recovers `signingAddress`, and that `signedText` contains `requestHash` and `responseHash`. Attestation results are reported as checked by envoi at `checkedAt`, not re-run.

## 7. NEAR contract interface used by the checker (read only)

Contract `envoi-record` (see `contracts/near/envoi-record/`):
- `root_of({ batch_id })` returns `{ root, previous_root, count, block_ts }` or `null`. `block_ts` is nanoseconds as a string.
- `keys_of({ key_ref })` returns `[{ kind, key_ref, key_id, fingerprint, alg, prev_sig_ref, block_ts }]`.
- `last()` returns `[batch_id, root]`.

## 8. Checker results

Each check returns `ok`, `fail`, `warn` (couldn't reach the network) or `pending` (not sealed yet), with a stable `code`:

| code | Meaning |
|---|---|
| `envoi_signature` | Record signed by a listed envoi key |
| `owner_signature` | Rule signed by the owner's device |
| `owner_key_listed` | Owner device listed on NEAR before signing |
| `unchanged` | Record hash, details hash, private check hash and rule binding all recompute |
| `in_batch` | Inclusion path leads to the batch root |
| `on_chain` | Root found on NEAR at that batch ID |
| `private_check` | Private-check signature recovers the attested signer |

The overall verdict is `genuine` only if every check present is `ok`.
