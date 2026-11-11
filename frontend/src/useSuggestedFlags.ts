import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { cachedSuggestions, getSuggestionProvider, isDismissed, recordDismissal, resolveFlags, storeSuggestions, subscribeSuggestionProvider, type ResolvedFlag, type SuggestionResponse } from './suggestions';

type Message = { id: string; sender: string; text: string };
type Status = 'idle' | 'loading' | 'done' | 'error';

/** On demand suggested highlights for one case. Does nothing until a person asks, so no model is called in the background. */
export function useSuggestedFlags(caseId: string, objective: string, constraints: Record<string, unknown> | undefined, messages: Message[], enabled = true) {
  const provider = useSyncExternalStore(subscribeSuggestionProvider, getSuggestionProvider, getSuggestionProvider);
  const cacheKey = `${caseId}:${messages.length ? messages[messages.length - 1].id : 'none'}`;
  const latest = useRef({ messages, objective, constraints, enabled, cacheKey });
  latest.current = { messages, objective, constraints, enabled, cacheKey };
  const [status, setStatus] = useState<Status>('idle');
  const [response, setResponse] = useState<SuggestionResponse | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  useEffect(() => {
    const hit = enabled ? cachedSuggestions(cacheKey) : null;
    setResponse(hit ?? null);
    setStatus(hit ? 'done' : 'idle');
    setDismissed(new Set());
  }, [cacheKey, enabled]);

  const run = useCallback(async () => {
    if (!provider || !latest.current.enabled) return;
    setStatus('loading');
    try {
      const { messages: items, objective: goal, constraints: limits } = latest.current;
      const result = await provider({ caseId, objective: goal, constraints: limits, messages: items });
      if (!latest.current.enabled || latest.current.cacheKey !== cacheKey) return;
      storeSuggestions(cacheKey, result);
      setResponse(result);
      setStatus('done');
    } catch {
      if (latest.current.enabled && latest.current.cacheKey === cacheKey) setStatus('error');
    }
  }, [provider, caseId, cacheKey]);

  const resolved: ResolvedFlag[] = enabled && response ? resolveFlags(messages, response.flags).filter(flag => !dismissed.has(flag.key) && !isDismissed(caseId, flag)) : [];
  const dismiss = useCallback((flag: ResolvedFlag) => {
    if (!latest.current.enabled) return;
    recordDismissal(caseId, flag);
    setDismissed(previous => new Set(previous).add(flag.key));
  }, [caseId]);

  const byEvent = new Map<string, ResolvedFlag[]>();
  for (const flag of resolved) byEvent.set(flag.eventId, [...(byEvent.get(flag.eventId) || []), flag]);
  return { available: enabled && Boolean(provider), status, count: resolved.length, byEvent, run, dismiss };
}
