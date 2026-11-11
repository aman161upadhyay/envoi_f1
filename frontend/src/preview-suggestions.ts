import type { SuggestedFlag, SuggestionProvider } from './suggestions';

// Preview only (dev ?preview). A recorded reply in the shape a live model returns, so the demo
// needs no API key. Every quote below is checked against the message text at run time.

const flag = (eventId: string, quote: string, category: SuggestedFlag['category'], reason: string, severity: SuggestedFlag['severity'] = 'review'): SuggestedFlag =>
  ({ eventId, quote, category, reason, mandateRef: null, severity });

const recorded: Record<string, SuggestedFlag[]> = {
  conversation_ledger_invoice: [
    flag('evt_inv_3', 'Everything else is unchanged.', 'inconsistency', 'Said straight after two changes, to the payment terms and to the bank account.'),
    flag('evt_inv_3', 'update your records for future ones', 'commitment', 'Asks for a standing change to the payee, not just this payment.'),
    flag('evt_inv_5', 'it was announced in our October 3 customer notice', 'term_change', 'Relies on a notice nothing in this thread shows Rachel received.'),
    flag('evt_inv_5', 'our finance lead has asked that the payment go out this week', 'commitment', 'Time pressure from the other side; your instruction only asks for a correct payment.', 'info'),
    flag('evt_inv_7', 'it would help us a great deal if the payment could go out today', 'commitment', 'Pushes for payment before the payee change is approved.', 'info')
  ],
  conversation_harbor_venue: [
    flag('evt_ven_2', 'Wine is not included and is charged on consumption', 'term_change', 'An open-ended cost that is not in the all-in figure.'),
    flag('evt_ven_2', 'Final guest numbers are due 10 days before', 'commitment', 'A cutoff that the 16-guest minimum then locks in.', 'info')
  ]
};

export const recordedProvider: SuggestionProvider = async request => {
  await new Promise(resolve => setTimeout(resolve, 600));
  return { caseId: request.caseId, flags: recorded[request.caseId] || [] };
};
