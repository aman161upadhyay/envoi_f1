# Rachel · Integration and submission

Own the submission candidate on `codex/guard-v4-integration`, starting at `d4222d2`. The judge README and offline replay are ready. A fresh local clone passed all 47 Guard tests and the terminal demo on Node 22 with networking disabled. The browser showed the payment and file decisions, both payment outcomes, and the expected proof verdicts.

## Integration work

1. **Receive focused handoffs.** Review Aman’s UI changes and Je’s contract or checker changes. Bring over the reviewed commits and record the exact candidate SHA. Rerun affected frontend, backend, and Guard checks. Keep the submission branch and any future `main` merge on separate review paths.
2. **Run live readiness.** After Je supplies funded inference and the verified testnet configuration, run `npm run testnet:preflight` and `npm run testnet:readiness` from `frontend/guard-demo`. Confirm all six attestation checks using fictional input. Treat the record lock as a separate check.
3. **Capture the payment and proof loop.** Run the approved testnet rehearsal with the existing runner. Capture the refused payment and unchanged vault balance, the allowed payment, the finalized sensitive-case seal, and the exported proof. Confirm the physical-browser passkey flow if it will be shown. Have Je independently check the original and edited proofs. Give Aman the receipts and footage for the [master video plan](demo-video-master.md).
4. **Prepare the public release.** Review the candidate for secrets and confirm the team-approved license. Publish the approved submission branch. Clone that exact public branch anonymously and follow its README. Make the baseline diff and exact submission commit easy for judges to find.
5. **Submit once.** Review the public repository link, the public X video with `@NEARProtocol` and `#NEARHackathon`, selected tracks, team details, and mainnet NEAR payout account. Submit the reviewed entry and save confirmation. Use Security as the primary track. Add Privacy only if the live attestation evidence is ready.

## Evidence to keep together

Candidate SHA, fresh-clone result, attestation results, refusal and success receipts, seal and lock receipts, both proof verdicts, public demo URL, and submission confirmation. The existing team target is November 14 at 1:00 a.m. Toronto time. [Official rules](https://nearhackathon.com/HACKATHON.md)
