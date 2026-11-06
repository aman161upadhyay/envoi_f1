# @envoi/verify

Checks an envoi evidence proof (`envoi.proof/v1`) without an envoi account and without trusting envoi. Everything runs locally (Node 22+ or a modern browser) except reading the record contract on NEAR over public RPC. Spec: [`docs/proof-format.md`](../../docs/proof-format.md).

## Try it (no keys needed)

1. `npm run samples:proofs` → writes `samples/proofs/genuine-blocked-share.json`, `tampered-summary.json` and the local record they were sealed on.
2. `npm run verify:proof -- samples/proofs/genuine-blocked-share.json --local-store samples/proofs/local-record.json` → six ✓ lines, then "This record is genuine and unchanged.", exit code 0.
3. `npm run verify:proof -- samples/proofs/tampered-summary.json --local-store samples/proofs/local-record.json` → "✗ This record was changed after it was recorded." and "This record can't be trusted.", exit code 1.
4. Run step 2 without `--local-store` → "Couldn't reach the public record" and "Not fully checked yet.", exit code 2. It never says genuine when it couldn't check.

Proofs sealed on NEAR need no flags; the CLI reads `near-testnet` or `near-mainnet` RPC itself (override with `--rpc-testnet` / `--rpc-mainnet`).

Exit codes: 0 genuine, 1 can't be trusted, 2 not fully checked or not sealed yet, 3 not a proof file.

## Checks

| Code | Passes when |
|---|---|
| `envoi_signature` | Ed25519 signature over the record hash, by a key listed on the record contract under `envoi` |
| `owner_signature` | WebAuthn ES256 assertion whose challenge is the permission document hash, right origin and RP ID, user present |
| `owner_key_listed` | That device's fingerprint is listed under the owner reference, with the right kind (`owner` or `owner_demo`), no later than the document's `issuedAt` (2 minute clock skew) |
| `unchanged` | Record hash, details hash, private-check hash, permission document hash and the record-to-rule binding all recompute |
| `in_batch` | RFC 6962 inclusion path, with sides matching the leaf index, leads to the batch root |
| `on_chain` | `root_of(batch_id)` on each sealing network returns the same root, previous root and count |
| `private_check` | (when present) the TEE's secp256k1 signature over the signed text recovers the attested address, and the text binds the request and response hashes |

## For the server lane (producing proofs)

Use the same code the checker uses, so the two sides can't drift:

```js
import { buildRecord, signRecordHash, buildBatch, assembleProof, signPermissionVersion,
         keyFingerprint, createDemoDevice } from '../packages/verify/src/index.js';
import { createPublicRecords } from '../src/public-record/index.js';

const built = await buildRecord({ id, workspaceId, seq, type, agentId, caseId, summary,
  ruleVersionHash, previousHash, firstAt, lastAt, details, privateCheck });   // -> { record, recordHash, detailsSalt, ... }
const envoiSignature = await signRecordHash(built.recordHash, { keyId, privateJwk, publicJwk });
// batcher:
const batch = await buildBatch({ batchId, recordHashes, previousRoot });
for (const chain of await createPublicRecords()) await chain.publish({ batchId, root: batch.root, previousRoot, count: batch.count });
// proof download:
const proof = await assembleProof({ built, envoiSignature, permissionVersion, batch, leafIndex, seals });
```

- Store `record`, `recordHash`, `detailsSalt`, `envoiSignature`, `batch_id` and `leaf_index` per record; `assembleProof` rebuilds the path from the batch's record hashes.
- Owner passkeys: convert the COSE key from `@simplewebauthn/server` to a P-256 JWK, then `registerKey({ kind: 'owner', keyRef: ownerRef, keyId: credentialId, fingerprint: await keyFingerprint(jwk), alg: 'ES256' })` **before** the owner signs anything with it.
- Demo device: `createDemoDevice()` gives a software authenticator; list it with `kind: 'owner_demo'` and sign with `method: 'demo_device'`. The checker refuses a demo key presented as a passkey.
- Use the browser's `issuedAt` in the permission document and compute `documentHash` in the browser from the staged rules (what you see is what you sign).
