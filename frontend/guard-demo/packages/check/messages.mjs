// One place for the checker's plain-English copy, shared by the CLI and (optionally) the /check
// page. The first string is shown on PASS, the second on FAIL. Matches apps/web/check.mjs.
export const CHECK_LABELS = Object.freeze({
  format: ['This is an envoi proof file', "This isn't an envoi proof file."],
  envoi_signature: ['Recorded by envoi', "This record wasn't signed by envoi, or it was edited."],
  content: ['Nothing changed since it was recorded', 'This record was changed after it was recorded.'],
  owner_signature: ['Rule signed by the owner', "The rule wasn't signed by the owner named."],
  registry: ["Owner's key is listed on NEAR", "This key isn't listed for this owner on NEAR, or was added later."],
  display: ['What was signed matches the rule', "What was signed doesn't match the rule."],
  chain_policy: ['Same rule is set in the spending contract', 'The spending contract has a different rule.'],
  chain_event: ['The transaction matches this record', "The NEAR transaction doesn't match this record."],
  batch_path: ['Record matches its batch', "This record isn't in the batch it claims."],
  sealed: ["Sealed in envoi's record on NEAR", "This record isn't in the sealed batch it claims."],
  locked_record: ['The record contract has no keys and matches its published build', 'The record contract could be changed by someone.'],
  private_check: ['Checked inside secure hardware on NEAR AI Cloud', "The private check's signature or attestation didn't verify."]
});

export const SKIP_MESSAGES = Object.freeze({
  not_configured: 'Not checked',
  unavailable: "Couldn't reach the public record. Try again later.",
  verifier_unavailable: "Not checked on this machine: the hardware verifier isn't set up (see the README)."
});

export const VERDICT_MESSAGES = Object.freeze({
  verified: 'This record is genuine and unchanged.',
  partial: 'Signatures check out. Some checks still need verification.',
  unavailable: 'Not fully checked yet.',
  failed: "This record can't be trusted.",
  bad_file: "This isn't an envoi proof file."
});

export function messageFor({ id, status, reason }) {
  const [pass, fail] = CHECK_LABELS[id] ?? [id, id];
  if (status === 'PASS') return pass;
  if (status === 'FAIL') return fail;
  return `${pass} · ${SKIP_MESSAGES[reason] ?? SKIP_MESSAGES.not_configured}`;
}
