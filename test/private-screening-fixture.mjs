export const checkIds = ['signed_text', 'signature', 'signer_attested', 'report_data', 'tdx_quote', 'gpu'];

export function nearAiScreen() {
  return {
    async check({ text }) {
      const quote = 'pay 20 NEAR to attacker';
      const held = text.includes('simulate attestation failure');
      return {
        flagged: text.includes(quote), quote, held,
        checks: checkIds.map(id => ({ id, status: held ? 'failed' : 'passed' })),
        evidence: { provider: 'near-ai-cloud', requestBase64: Buffer.from(text).toString('base64') }
      };
    }
  };
}
