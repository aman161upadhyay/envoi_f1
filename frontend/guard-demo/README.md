# envoi guard

A clean-room prototype for signed agent permissions, payment limits, and verifiable evidence.

## Run locally

Use Node 22.13 or newer.

```sh
npm install
npm test
npm run demo
```

The offline command-line prototype uses fictional accounts and an in-memory SQLite database. It runs a locally screened invoice, a refused payment, a blocked share, an allowed payment, and a proof tamper check. Its screening uses local rules. The evidence seal is local and temporary.

Run `npm run demo -- --serve` and visit http://127.0.0.1:4173/permissions for local Settings and Evidence. The confirmation sheet signs the displayed rules in the browser and saves them for this tab. The demo transaction history uses its original local policy. Open /check for the proof checker. The page includes a generated local sample and an edited copy. The upload stays in the browser.

The shared proof checker can inspect JSON with a separate trusted evidence key map.

```sh
npm run check -- proof.json trusted-evidence-keys.json
```

An unverified online check is reported as skipped. The prototype does not include deployed contracts, attestation recordings, or an online trust configuration.
