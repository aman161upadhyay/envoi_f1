# Aman · Chat UI and demo video

Own the judge-facing browser experience and video for Envoi’s NEAR Hackathon submission. Start from the integration commit Rachel shares. The chat and inbox work from your branches is already integrated. Use the Acme Q4 review as the single case for the walkthrough.

## Features to finish

1. **Signed policy and key scope.** Make it easy to see the Ledger Co payee, spending caps, slides 4–6, file-share limits, and actions that require owner review. Show what Dana signs and where the judge can inspect Milo’s key restricted to the spending contract’s `pay` method.
2. **Case timeline.** Show the decision and the deciding rule for the allowed payment, refused payment, blocked share, and out-of-scope edit. Keep the owner-review step visible. The demo can end that step at a pending request if the approval or send has not been rehearsed.
3. **Evidence and proof.** Make Evidence easy to reach from chat. Show the attestation panel when a verified receipt is available. Display a final NEAR seal only after finality. Make the original proof and edited proof easy to open and compare. Label fixture results **Offline replay** and actual testnet receipts **NEAR testnet**.
4. **Video and post.** Follow the [master video plan](demo-video-master.md). Record the offline take now. Replace individual shots when Rachel and Je provide verified live evidence. Deliver the video, a thumbnail or still, and an X draft that mentions NEAR HACKATHON and includes `@NEARProtocol` and `#NEARHackathon`.

## Acceptance and handoff

- One browser walkthrough goes from signed case scope to a visible decision, Evidence, and both proof verdicts.
- Send Rachel the branch or commit, a short list of UI changes, the recording, and any shots waiting on live receipts.
- Your lane owns chat, inbox, and the video. Rachel owns the integration branch, README, rehearsal, and publication. Je owns NEAR AI billing, contracts, and the independent checker.
