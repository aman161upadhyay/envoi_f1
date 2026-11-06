import { demoDevice } from '/device.mjs';
import { applyTestnetPolicy, describeDevice, getTestnetPolicy } from '/testnet.mjs';
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
const storageKey = 'envoi-guard-demo-permission-' + (state.testnet?.spendContract ?? 'local');
let active = state.genuine.permission.document;
let signed;
const testnet = state.testnet;
const records = [...(testnet ? state.testnetRecords : state.records)];

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
    if (entry && entry.document.agent === (testnet?.agent ?? active.agent) && entry.document.owner === (testnet?.owner ?? active.owner) && await verify(entry.publicKey, entry.signature, await hashJson(entry.document))) {
      active = entry.document;
      signed = entry;
    }
  } catch { /* Start with the original demo policy if browser storage is unavailable. */ }
}

await readStored();
if (testnet) {
  $('#seal-status').textContent = 'NEAR testnet';
  try {
    const current = await getTestnetPolicy(testnet);
    if (!signed || current.policy_hash !== await hashJson(signed.document) || current.version !== signed.document.version) {
      signed = undefined;
      const seed = state.genuine.permission.document;
      const spend = seed.rules.spend_money;
      active = { ...seed, owner: testnet.owner, agent: testnet.agent, version: current.version, rules: {
        ...seed.rules, spend_money: { ...spend, dailyCap: current.daily_cap, payees: current.payees.map(payee => ({
          account: payee.account, label: payee.account, maxPerPayment: payee.max_per_payment
        })) }
      } };
      status.textContent = 'Review and sign the testnet policy on this device.';
    }
  } catch (error) { signed = undefined; status.textContent = error.message; }
}
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
    const current = testnet ? await getTestnetPolicy(testnet) : null;
    const draft = {
      ...active, owner: testnet?.owner ?? active.owner, agent: testnet?.agent ?? active.agent,
      version: (current?.version ?? active.version) + 1,
      previousHash: current?.policy_hash ?? await hashJson(active), issuedAtMs: Date.now(),
      rules: { send_messages: $('#send').value, share_files: { default: $('#share').value, allow: [] },
        spend_money: { payees, dailyCap: nearAmount($('#cap').value), unit: 'yoctoNEAR' } }
    };
    draft.display = displayPermission(draft);
    const approve = make('button', 'Sign and save', { class: 'primary', type: 'button' });
    const note = make('p', testnet ? 'Signing with Demo device (this browser). This also updates Milo’s limits on NEAR testnet.' : 'Signing with Demo device (this browser). Saves this local demo policy.', { role: 'status' });
    open("Save Milo's permissions", ...draft.display.map(line => make('p', line)), note, approve);
    approve.onclick = async () => {
      approve.disabled = true;
      try {
        const device = await demoDevice();
        const hash = await hashJson(draft);
        const publicKey = await publicHex(device.publicKey);
        const signature = await sign(device.privateKey, hash);
        if (!await verify(publicKey, signature, hash)) throw new Error('Signature check failed');
        const next = { document: draft, publicKey, signature };
        if (testnet) await applyTestnetPolicy(testnet, device, draft);
        try { sessionStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Policy may already be finalized. */ }
        signed = next;
        active = draft;
        populate();
        sheet.close();
        status.textContent = testnet ? 'Saved and signed on NEAR testnet.' : 'Saved and signed in this browser.';
      } catch (error) {
        note.textContent = testnet ? error.message : "Couldn't sign and save. Your previous local settings are still in force.";
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
    button.append(make('span', item.display ? (testnet ? 'Signed on testnet' : 'Signed locally') : (testnet ? 'Sealed on testnet' : 'Sealed locally (demo)'), { class: 'chip' }));
    button.onclick = () => {
      const details = [make('p', item.summary), make('p', new Date(item.createdAtMs).toLocaleString())];
      if (item.display) details.push(...item.display.map(line => make('p', line)));
      if (item.details?.flaggedText) {
        details.push(make('h3', 'Flagged text'), make('p', item.details.flaggedText), make('h3', 'Hardware attestation'));
        const checks = {
          signed_text: 'Answer matches what was signed', signature: 'Response signature matches',
          signer_attested: 'Signer belongs to the attested hardware', report_data: 'Attestation matches this signer and request',
          tdx_quote: 'Intel TDX hardware verified', gpu: 'NVIDIA GPU verified'
        };
        for (const check of item.details.checks ?? []) {
          details.push(make('p', checks[check.id] + ' · ' + ({ passed: 'Passed', failed: 'Failed', not_checked: 'Not checked' })[check.status]));
        }
      }
      if (!testnet && item.type === 'pay_refused') details.push(make('a', 'Check proof', { href: '/check' }));
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
