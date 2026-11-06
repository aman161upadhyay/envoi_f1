import { hashJson, publicHex, sign, verify } from '/packages/core/crypto.mjs';
import { displayPermission, formatNear } from '/packages/core/policy.mjs';

const $ = selector => document.querySelector(selector);
const state = await fetch('/demo-samples.json').then(response => response.json());
const onEvidence = location.pathname.startsWith('/permissions/evidence');
const settings = $('#settings');
const evidence = $('#evidence');
const sheet = $('#sheet');
const content = $('#sheet-content');
const status = $('#status');
const storageKey = 'envoi-guard-demo-permission';
let active = state.genuine.permission.document;
let signed;
let device;
const records = [...state.records];

function make(tag, text, attributes = {}) {
  const node = document.createElement(tag);
  node.textContent = text;
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

function open(title, ...children) {
  $('#sheet-title').textContent = title;
  content.replaceChildren(...children);
  if (!sheet.open) sheet.showModal();
}

function nearAmount(input) {
  const match = /^(\d{1,4})(?:\.(\d{1,6}))?$/.exec(input);
  if (!match) throw new Error('Enter a NEAR amount with up to six decimal places.');
  return String(BigInt(match[1]) * 10n ** 24n + BigInt((match[2] ?? '').padEnd(24, '0')));
}

function addPayee(payee = { label: '', account: '', maxPerPayment: '0' }) {
  const row = make('div', '', { class: 'payee' });
  const fields = [
    ['Name', 'label', payee.label], ['NEAR account', 'account', payee.account],
    ['Up to amount', 'max', formatNear(payee.maxPerPayment).split(' ')[0]]
  ];
  for (const [label, name, value] of fields) {
    const wrapper = make('label', label);
    const input = make('input', '', { name, required: '', ...(name === 'max' ? { inputmode: 'decimal' } : {}) });
    input.value = value;
    wrapper.append(input);
    row.append(wrapper);
  }
  const remove = make('button', 'Remove', { type: 'button' });
  remove.onclick = () => { row.remove(); markDirty(); };
  row.append(remove);
  $('#payees').append(row);
}

function populate() {
  const rules = active.rules;
  $('#send').value = rules.send_messages;
  $('#share').value = rules.share_files.default;
  $('#cap').value = formatNear(rules.spend_money.dailyCap).split(' ')[0];
  $('#payees').replaceChildren();
  for (const payee of rules.spend_money.payees) addPayee(payee);
  $('#version').textContent = 'Signed, version ' + active.version;
  $('#save').hidden = true;
}

function markDirty() {
  $('#save').hidden = false;
  status.textContent = 'Changes not signed yet';
}

async function readStored() {
  try {
    const entry = JSON.parse(sessionStorage.getItem(storageKey));
    if (entry && await verify(entry.publicKey, entry.signature, await hashJson(entry.document))) {
      active = entry.document;
      signed = entry;
    }
  } catch { /* Start with the original demo policy if browser storage is unavailable. */ }
}

await readStored();
settings.hidden = onEvidence;
evidence.hidden = !onEvidence;
document.querySelector('nav a[href="' + (onEvidence ? '/permissions/evidence' : '/permissions') + '"]').setAttribute('aria-current', 'page');
populate();
for (const input of [$('#send'), $('#share'), $('#limits')]) input.addEventListener('input', markDirty);
$('#add').onclick = () => { addPayee(); markDirty(); $('#payees').lastElementChild.querySelector('input').focus(); };
$('#discard').onclick = () => { populate(); status.textContent = ''; };
$('#keys').onclick = () => {
  const key = state.agentAccount.keys[0];
  const restricted = state.agentAccount.keys.length === 1 && key?.kind === 'function_call' &&
    key.receiver === 'local-spend' && key.methods.length === 1 && key.methods[0] === 'pay';
  open('Agent keys', make('p', state.agentAccount.account), make('p', 'Local demo account'),
    make('p', restricted ? 'Milo holds one key. It can only ask the spending contract to pay.' : 'Payment-only restriction could not be confirmed.'));
};
$('#limits').onsubmit = async event => {
  event.preventDefault();
  try {
    const payees = [...$('#payees').children].map(row => ({
      label: row.querySelector('[name=label]').value.trim(), account: row.querySelector('[name=account]').value.trim(),
      maxPerPayment: nearAmount(row.querySelector('[name=max]').value)
    }));
    const draft = {
      ...active, version: active.version + 1, previousHash: await hashJson(active), issuedAtMs: Date.now(),
      rules: { send_messages: $('#send').value, share_files: { default: $('#share').value, allow: [] },
        spend_money: { payees, dailyCap: nearAmount($('#cap').value), unit: 'yoctoNEAR' } }
    };
    draft.display = displayPermission(draft);
    const approve = make('button', 'Sign and save', { class: 'primary', type: 'button' });
    const note = make('p', 'Signing with Demo device (this browser). Saves this local demo policy.', { role: 'status' });
    open("Save Milo's permissions", ...draft.display.map(line => make('p', line)), note, approve);
    approve.onclick = async () => {
      approve.disabled = true;
      try {
        device ??= await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
        const hash = await hashJson(draft);
        const publicKey = await publicHex(device.publicKey);
        const signature = await sign(device.privateKey, hash);
        if (!await verify(publicKey, signature, hash)) throw new Error('Signature check failed');
        const next = { document: draft, publicKey, signature };
        sessionStorage.setItem(storageKey, JSON.stringify(next));
        signed = next;
        active = draft;
        populate();
        sheet.close();
        status.textContent = 'Saved and signed in this browser.';
      } catch {
        note.textContent = "Couldn't sign and save. Your previous local settings are still in force.";
        approve.disabled = false;
      }
    };
  } catch (error) { status.textContent = error.message; }
};

function renderRecords() {
  const filter = $('#filter').value;
  const search = $('#search').value.trim().toLowerCase();
  const items = [...records].reverse().map(entry => ({ ...entry.record, details: entry.details }));
  if (signed) items.unshift({ type: 'permission_changed', summary: 'Dana signed changes on the demo device.',
    createdAtMs: signed.document.issuedAtMs, display: signed.document.display });
  const visible = items.filter(item => (!filter || item.type.includes(filter)) && item.summary.toLowerCase().includes(search));
  const rows = visible.map(item => {
    const button = make('button', item.summary, { class: 'record', type: 'button' });
    button.append(make('span', item.display ? 'Signed locally' : 'Sealed locally (demo)', { class: 'chip' }));
    button.onclick = () => {
      const details = [make('p', item.summary), make('p', new Date(item.createdAtMs).toLocaleString())];
      if (item.display) details.push(...item.display.map(line => make('p', line)));
      if (item.details?.flaggedText) {
        details.push(make('h3', 'Flagged text'), make('p', item.details.flaggedText), make('h3', 'Hardware attestation'));
        details.push(make('p', 'Not checked. This demo uses local rules.'));
      }
      if (item.type === 'pay_refused') details.push(make('a', 'Check proof', { href: '/check' }));
      open('Evidence record', ...details);
    };
    const row = make('li', '');
    row.append(button);
    return row;
  });
  $('#records').replaceChildren(...(rows.length ? rows : [make('li', filter === 'block' ? 'Nothing blocked' : 'No matching evidence')]));
}
$('#filter').onchange = renderRecords;
$('#search').oninput = renderRecords;
renderRecords();
