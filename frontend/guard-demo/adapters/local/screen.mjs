const suspicious = /^(?:.*\b(?:pay|send|transfer|share)\b.*\b(?:before anything else|attacker|password)\b.*|.*\bignore (?:all |the )?(?:previous|prior) instructions\b.*)$/im;

export const messageScreen = {
  provider: 'local-rules',
  async check({ text }) {
    const quote = text.match(suspicious)?.[0];
    return {
      flagged: Boolean(quote),
      ...(quote ? { quote, kind: 'other' } : {}),
      evidence: { provider: 'local-rules' },
      checks: ['signed_text', 'signature', 'signer_attested', 'report_data', 'tdx_quote', 'gpu'].map(id => ({
        id, status: 'not_checked', detail: 'Offline local rules'
      }))
    };
  }
};
