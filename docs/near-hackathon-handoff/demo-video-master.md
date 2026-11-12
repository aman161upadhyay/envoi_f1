# Envoi · NEAR Hackathon demo video

**Recording owner:** Aman  
**Demo operator and release owner:** Rachel  
**NEAR receipts and independent proof check:** Je  
**Target length:** About 2 minutes 20 seconds

## Story

Dana delegates one procurement task to Milo for the fictional **Acme Q4 review**. Milo can buy data from Ledger Co within a signed spending cap and work on specific slides. An invoice includes hidden instructions to send money elsewhere, share a restricted file, and edit slide 9. Envoi shows which rule governs each action. The judge can then inspect the sensitive case’s evidence and see an edited proof fail.

## Shot list and narration

| Time | Show on screen | Suggested narration | Evidence needed |
|---|---|---|---|
| 0:00–0:12 | Open **Acme Q4 review** in chat. Keep Dana, Milo, and the sensitive-case label visible. | “Dana needs a client review deck. She gives Milo just enough access to buy the data and update the right slides.” | Fictional case ready in chat or in the offline replay. |
| 0:12–0:33 | Open **Case permissions**. Highlight Ledger Co, **1 NEAR per payment**, **2 NEAR per day**, slides **4–6**, and owner review for sending the deck. Show Dana signing and briefly show Milo’s **pay-only** key scope. | “Dana signs a policy that limits who Milo can pay, how much it can spend, and which slides it can edit. Milo’s key can call the spending contract’s pay method.” | Physical passkey and live key scope footage if verified. Otherwise show the labeled offline signing and scope flow. |
| 0:33–0:49 | Show Ledger Co’s **0.5 NEAR** invoice, the **Allowed** decision, and the corresponding payment outcome. | “Ledger Co is an approved payee. The amount is under the cap, so the payment goes through.” | Finalized allowed-payment receipt for a **NEAR testnet** label. The offline take shows the simulated payment. |
| 0:49–1:08 | Highlight the hidden instruction in the next message. Open the attestation panel and hold on the six checks if they passed. | “The invoice also carries instructions to redirect money, share a restricted file, and change a slide outside the case scope. Private screening flags the message.” | A verified live NEAR AI receipt with all six checks. If unavailable, show the local screening result with an **Offline replay** label. |
| 1:08–1:36 | Show the **20 NEAR** attempt to the outside account. Hold on the deciding rule and refusal. Then show the blocked May model share and denied slide 9 edit. Briefly show that slides 4–6 are allowed and the client send requires Dana’s review. | “The spending contract refuses the outside payee, and the vault balance stays the same. Envoi also blocks the file share and slide 9 edit. Sending the deck to the client requires Dana’s approval.” | A finalized refusal receipt and before/after vault balance for the live claim. In the offline take, show the corresponding local decisions. |
| 1:36–2:08 | Open **Evidence** and the refused payment. Show **Sealed on NEAR** only with a finalized seal. Open the original proof, then open the edited proof and hold on its failure. | “The sensitive case produces evidence a reviewer can check. Here’s the original proof. Change one character and the checker rejects it.” | Finalized seal and independently checked proof for live footage. Offline original should show local checks passed with online checks skipped. The edited sample should fail. |
| 2:08–2:20 | Close on the case timeline and show the public repository or branch link on screen. | “Envoi gives an agent room to work inside a policy the owner can inspect and sign. The public repo includes a replay you can run yourself.” | Confirm the public URL and exact submission branch before rendering the final card. |

## Record the offline take now

Run from the repository checkout on `codex/guard-v4-integration` with Node.js 22.13 or later.

```sh
cd frontend/guard-demo
npm ci --offline
npm test
npm run demo -- --serve
```

1. Open [Acme Q4 review](http://127.0.0.1:4173/demo). Click **Open the Acme Q4 review**, **Let Milo read the full message**, and **Review the deck update**.
2. Open **Evidence**, select **Money**, and show both payment outcomes. Return to the replay tab after each link.
3. Record [the genuine sample](http://127.0.0.1:4173/check?sample=genuine) and [the edited sample](http://127.0.0.1:4173/check?sample=edited) as separate close-ups.
4. In [Settings](http://127.0.0.1:4173/permissions), show the signed-policy confirmation sheet. The replay evidence reflects the original fictional scenario.

## Final edit and evidence checks

- Use the same case and stable shot order in the live and offline cuts. Label each shot **Offline replay** or **NEAR testnet** when switching between them. Keep rule text, outcomes, and the proof verdict readable long enough to follow.
- Show **all six attestation checks passed** only after Rachel verifies a live receipt. Show **Sealed on NEAR** only after the seal is finalized and independently checked. Describe the account as locked only when Je supplies the verified lock receipt.
- If billing is still blocked, use the labeled offline screening shot and keep the Security submission story. Use actual testnet payment and seal footage only for receipts the team can independently verify.
- Use fictional material and public receipt references. Close any terminal or browser tab that could expose credentials before recording.
- Deliver one video, a thumbnail or still, and an X post draft. The post should say it was built at NEAR HACKATHON, include `@NEARProtocol` and `#NEARHackathon`, and link the public repository. Rachel publishes it and uses its public link in the submission. [Official demo rules](https://nearhackathon.com/HACKATHON.md#procedure)
