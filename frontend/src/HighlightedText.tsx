import { CATEGORY_LABEL, TIER_LABEL, findHighlights, splitByHighlights } from './highlights';

export function HighlightedText({ text }: { text: string }) {
  const pieces = splitByHighlights(text, findHighlights(text));
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

export function HighlightSummary({ text }: { text: string }) {
  const spans = findHighlights(text);
  if (!spans.length) return null;
  const blocking = spans.filter(span => span.tier === 'blocking').length;
  const review = spans.length - blocking;
  const jump = (target: EventTarget, tier: 'blocking' | 'review') =>
    (target as HTMLElement).closest('.message-content')?.querySelector<HTMLElement>(`mark.hl-${tier}`)?.focus();
  return <div className="hl-summary" aria-label="Highlights in this message">
    {blocking > 0 && <button type="button" className="hl-chip hl-chip-blocking" onClick={event => jump(event.currentTarget, 'blocking')}>{blocking} {blocking === 1 ? 'needs' : 'need'} your decision</button>}
    {review > 0 && <button type="button" className="hl-chip hl-chip-review" onClick={event => jump(event.currentTarget, 'review')}>{review} worth a look</button>}
  </div>;
}
