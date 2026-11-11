import type { ReactNode } from 'react';
import { CATEGORY_LABEL, TIER_LABEL, findHighlights, splitByHighlights } from './highlights';
import { FLAG_CATEGORY_LABEL, SEVERITY_LABEL, type ResolvedFlag } from './suggestions';

export function HighlightedText({ text, suggested, onDismiss }: { text: string; suggested?: ResolvedFlag[]; onDismiss?: (flag: ResolvedFlag) => void }) {
  const marks = findHighlights(text);
  if (!suggested?.length) return <Pieces text={text} marks={marks} />;
  // Suggested spans were already checked not to overlap a rule mark, so the two lists interleave cleanly.
  const all: (typeof marks[number] | (ResolvedFlag & { tier: 'suggested' }))[] = [...marks, ...suggested.map(flag => ({ ...flag, tier: 'suggested' as const }))].sort((a, b) => a.start - b.start);
  const nodes: ReactNode[] = [];
  let cursor = 0;
  all.forEach((mark, index) => {
    if (mark.start > cursor) nodes.push(<span key={`t${index}`}>{text.slice(cursor, mark.start)}</span>);
    const piece = text.slice(mark.start, mark.end);
    if (mark.tier === 'suggested') {
      const flag = mark as ResolvedFlag;
      const label = `Suggested: ${FLAG_CATEGORY_LABEL[flag.category]} (${SEVERITY_LABEL[flag.severity]}). ${flag.reason}`;
      nodes.push(<span key={`s${index}`} className="hl-suggest-wrap"><mark className="hl hl-suggested" tabIndex={0} title={label}>{piece}<span className="sr-only"> ({label})</span></mark>{onDismiss && <button type="button" className="hl-dismiss" title="Dismiss this suggestion" aria-label={`Dismiss suggestion: ${flag.reason}`} onClick={() => onDismiss(flag)}>Suggested ×</button>}</span>);
    } else {
      const rule = mark as typeof marks[number];
      const label = `${TIER_LABEL[rule.tier]}: ${CATEGORY_LABEL[rule.category]}. ${rule.reason}`;
      nodes.push(<mark key={`m${index}`} className={`hl hl-${rule.tier}`} tabIndex={0} title={label}>{piece}<span className="sr-only"> ({label})</span></mark>);
    }
    cursor = mark.end;
  });
  if (cursor < text.length) nodes.push(<span key="tail">{text.slice(cursor)}</span>);
  return <>{nodes}</>;
}

function Pieces({ text, marks }: { text: string; marks: ReturnType<typeof findHighlights> }) {
  const pieces = splitByHighlights(text, marks);
  return <>{pieces.map((piece, index) => {
    const mark = piece.highlight;
    if (!mark) return <span key={index}>{piece.text}</span>;
    const label = `${TIER_LABEL[mark.tier]}: ${CATEGORY_LABEL[mark.category]}. ${mark.reason}`;
    return <mark key={index} className={`hl hl-${mark.tier}`} tabIndex={0} title={label}>{piece.text}<span className="sr-only"> ({label})</span></mark>;
  })}</>;
}

export function HighlightLegend() {
  return <p className="hl-legend" aria-label="Highlight key"><mark className="hl hl-blocking">Needs your decision</mark><mark className="hl hl-review">Worth a look</mark><span>Hover or focus a highlight to see why.</span></p>;
}

export function HighlightSummary({ text, suggestedCount = 0 }: { text: string; suggestedCount?: number }) {
  const spans = findHighlights(text);
  if (!spans.length && !suggestedCount) return null;
  const blocking = spans.filter(span => span.tier === 'blocking').length;
  const review = spans.length - blocking;
  const jump = (target: EventTarget, tier: 'blocking' | 'review' | 'suggested') =>
    (target as HTMLElement).closest('.message-content')?.querySelector<HTMLElement>(`mark.hl-${tier}`)?.focus();
  return <div className="hl-summary" aria-label="Highlights in this message">
    {blocking > 0 && <button type="button" className="hl-chip hl-chip-blocking" onClick={event => jump(event.currentTarget, 'blocking')}>{blocking} {blocking === 1 ? 'needs' : 'need'} your decision</button>}
    {suggestedCount > 0 && <button type="button" className="hl-chip hl-chip-suggested" onClick={event => jump(event.currentTarget, 'suggested')}>{suggestedCount} suggested</button>}
    {review > 0 && <button type="button" className="hl-chip hl-chip-review" onClick={event => jump(event.currentTarget, 'review')}>{review} worth a look</button>}
  </div>;
}
