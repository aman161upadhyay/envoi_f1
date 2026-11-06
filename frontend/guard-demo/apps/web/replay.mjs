const timeline = document.querySelector('#timeline');
const advance = document.querySelector('#advance');
const nextLink = document.querySelector('#next-link');
const reset = document.querySelector('#reset');
const stepLabel = document.querySelector('#step');
const state = await fetch('/demo-samples.json').then(response => response.json());
const records = new Map(state.records.map(entry => [entry.record.type, entry]));
const steps = [
  { label: 'Send Ledger Co’s invoice', entries: [
    ['Ledger Co requested 0.5 NEAR for invoice 1042.'],
    [records.get('screen_flagged').record.summary],
    ['Milo received the invoice with the flagged line removed. Local screening was used for this replay.']
  ] },
  { label: 'Let Milo read the full message', entries: [
    ['Demo only. Milo can now see the hidden instructions.', true],
    [records.get('screen_flagged').details.flaggedText, true],
    [records.get('pay_refused').record.summary],
    [records.get('share_blocked').record.summary]
  ] },
  { label: 'Pay the real invoice', entries: [[records.get('paid').record.summary], ['Sealed locally (demo).']] },
  { label: 'Open evidence', href: '/permissions/evidence' },
  { label: 'Check the refused payment', href: '/check?sample=genuine' }
];

let index = 0;
function render() {
  const step = steps[index];
  stepLabel.textContent = step ? 'Step ' + (index + 1) + ' of ' + steps.length : 'Replay complete';
  reset.hidden = index === 0;
  advance.hidden = !step || Boolean(step.href);
  nextLink.hidden = !step?.href;
  if (!step) return;
  advance.textContent = step.label;
  if (step.href) {
    nextLink.href = step.href;
    nextLink.textContent = step.label;
  }
}
function move() {
  index += 1;
  render();
  if (!advance.hidden) advance.focus();
  else if (!nextLink.hidden) nextLink.focus();
  else reset.focus();
}
advance.onclick = () => {
  if (index === 0) timeline.replaceChildren();
  for (const [text, warning] of steps[index].entries) {
    const row = document.createElement('li');
    row.textContent = text;
    if (warning) row.dataset.warning = '';
    timeline.append(row);
  }
  move();
};
nextLink.onclick = () => {
  // Keep the replay open while reviewers inspect the evidence or proof.
  const url = nextLink.href;
  window.open(url, '_blank', 'noopener');
  move();
  return false;
};
reset.onclick = () => {
  index = 0;
  const row = document.createElement('li');
  row.textContent = 'Waiting for Ledger Co’s invoice.';
  timeline.replaceChildren(row);
  render();
  advance.focus();
};
