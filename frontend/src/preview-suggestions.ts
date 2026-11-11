import type { SuggestedFlag, SuggestionProvider } from './suggestions';

// Preview only (dev ?preview). A recorded reply in the shape a live model returns, so the demo
// needs no API key. Every quote below is checked against the message text at run time.

const flag = (eventId: string, quote: string, category: SuggestedFlag['category'], reason: string, severity: SuggestedFlag['severity'] = 'review'): SuggestedFlag =>
  ({ eventId, quote, category, reason, mandateRef: null, severity });

const recorded: Record<string, SuggestedFlag[]> = {
  conversation_planning_call: [
    flag('evt_planning_1', 'best overlap across both calendars', 'commitment', 'Confirm the proposed slot fits both calendars before sending an invitation.')
  ],
  conversation_research_brief: [
    flag('evt_brief_1', 'latest interview synthesis and source notes', 'scope', 'Check which source notes are approved for the launch team.', 'info')
  ]
};

export const recordedProvider: SuggestionProvider = async request => {
  await new Promise(resolve => setTimeout(resolve, 600));
  return { caseId: request.caseId, flags: recorded[request.caseId] || [] };
};
