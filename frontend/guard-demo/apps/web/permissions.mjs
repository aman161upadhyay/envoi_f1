import { enrollPasskey, ownerPasskey, passkeySupported, signPermissionWithPasskey, verifySavedPermission } from '/owner-passkey.mjs';
import { demoDevice } from '/device.mjs';
import { applyTestnetPolicy, describeDevice, getTestnetPolicy, requireRegisteredSigner } from '/testnet.mjs';
import { hashJson, publicHex, sign, verify } from '/packages/core/crypto.mjs';
import { displayPermission, formatNear, validAccount } from '/packages/core/policy.mjs';

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
const signingMethod = $('#signing-method');
const ownerAccount = testnet?.owner ?? active.owner;
const records = [...(testnet ? state.testnetRecords : state.records)];
const sealStatus = $('#seal-status');
let filter = '';
let signingBusy = false;
sheet.addEventListener('cancel', event => { if (signingBusy) event.preventDefault(); });
const recordTitles = {
  pay_refused: 'Payment refused', paid: 'Payment made', share_blocked: 'File share blocked',
  screen_flagged: 'Hidden instructions found', screen_clear: 'Private check complete',
  permission_changed: 'Permissions changed', agent_paused: 'Agent paused', agent_resumed: 'Agent resumed'
};

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
  $('#version').textContent = testnet && !signed ? 'Review required' : 'Signed, version ' + active.version;
  $('#export').hidden = !testnet || !signed;
  $('#version').title = signed?.keyType === 'passkey' ? 'Signed by Dana with a passkey' : 'Signed by Dana on the demo device';
  updateRules();
  $('#save').hidden = true;
  sealStatus.textContent = testnet ? 'NEAR testnet' : 'Protected, sealed locally (demo)';
  sealStatus.removeAttribute('data-check');
}

function updateRules() {
  for (const input of [$('#send'), $('#share')]) input.dataset.rule = input.value;
}

function payeeInputs(row) {
  return {
    label: row.querySelector('[name=label]').value.trim(),
    account: row.querySelector('[name=account]').value.trim(),
    amount: row.querySelector('[name=max]').value
  };
}

function markDirty() {
  updateRules();
  const rules = active.rules;
  let changes = Number($('#send').value !== rules.send_messages) +
    Number($('#share').value !== rules.share_files.default) +
    Number($('#cap').value !== formatNear(rules.spend_money.dailyCap).split(' ')[0]);
  const old = new Map(rules.spend_money.payees.map(entry => [entry.account, entry]));
  for (const row of $('#payees').children) {
    const payee = payeeInputs(row);
    const previous = old.get(payee.account);
    if (!previous || payee.label !== previous.label || payee.amount !== formatNear(previous.maxPerPayment).split(' ')[0]) changes++;
    old.delete(payee.account);
  }
  changes += old.size;
  $('#change-count').textContent = changes + (changes === 1 ? ' change' : ' changes');
  $('#save').hidden = changes === 0;
  sealStatus.textContent = changes ? 'Changes not signed yet' : (testnet ? 'NEAR testnet' : 'Protected, sealed locally (demo)');
  if (changes) sealStatus.dataset.check = 'pending';
  else sealStatus.removeAttribute('data-check');
}

function openPayee() {
  const form = make('form', '', { class: 'payee-sheet' });
  const fields = [
    ['Name', 'label', { maxlength: '64' }], ['NEAR account', 'account', { maxlength: '64' }],
    ['Up to amount (NEAR)', 'amount', { inputmode: 'decimal' }]
  ];
  for (const [label, name, attributes] of fields) {
    const wrapper = make('label', label);
    wrapper.append(make('input', '', { name, required: '', ...attributes }));
    form.append(wrapper);
  }
  const message = make('p', '', { role: 'status' });
  form.append(message, make('button', 'Add payee', { type: 'submit', class: 'primary' }));
  form.onsubmit = event => {
    event.preventDefault();
    const data = new FormData(form);
    const account = data.get('account').trim();
    try {
      if (!validAccount(account)) throw new Error('Enter a valid NEAR account.');
      if ([...$('#payees').children].some(row => payeeInputs(row).account === account)) throw new Error('This account is already a payee.');
      const maxPerPayment = nearAmount(data.get('amount'));
      if (BigInt(maxPerPayment) <= 0n || BigInt(maxPerPayment) > BigInt(nearAmount($('#cap').value))) {
        throw new Error('Enter a positive amount within the daily limit.');
      }
      const label = data.get('label').trim();
      if (!label) throw new Error('Enter a name for this payee.');
      addPayee({ account, label, maxPerPayment });
      markDirty();
      sheet.close();
    } catch (error) { message.textContent = error.message; }
  };
  open('Add payee', form);
}

async function readStored() {
  try {
    const entry = JSON.parse(sessionStorage.getItem(storageKey));
    if (entry && ['demo_device', 'passkey'].includes(entry.keyType ?? 'demo_device') && entry.document.agent === (testnet?.agent ?? active.agent) && entry.document.owner === (testnet?.owner ?? active.owner) && (entry.keyType === 'passkey'
      ? await verifySavedPermission(entry, await hashJson(entry.document))
      : await verify(entry.publicKey, entry.signature, await hashJson(entry.document)))) {
      active = entry.document;
      signed = entry;
    }
  } catch { /* Start with the original demo policy if browser storage is unavailable. */ }
}

function renderPasskeyStatus() {
  const key = ownerPasskey(ownerAccount);
  $('#setup-passkey').textContent = key ? 'Passkey details' : 'Create passkey';
  $('#passkey-status').textContent = key ? 'Passkey saved for this owner' :
    passkeySupported() ? 'No passkey on this browser' : 'Use localhost or HTTPS for passkeys';
}
function showPasskeyDetails(key) {
  const label = make('label', 'Public key to register', { class: 'public-key' });
  const input = make('input', '', { readonly: '' });
  input.value = key.publicKey;
  input.onclick = () => input.select();
  label.append(input);
  open('Passkey', make('p', 'Owner: ' + ownerAccount), label,
    make('p', testnet ? 'Register this public key as type passkey with the owner account on the record contract.' :
      'This passkey signs local demo permissions.'),
    make('p', testnet ? 'The scoped NEAR device key submits the spending update after you sign.' : 'Saved on ' + location.hostname));
}
$('#setup-passkey').onclick = async () => {
  try {
    const saved = ownerPasskey(ownerAccount);
    const key = saved ?? await enrollPasskey(ownerAccount);
    signingMethod.value = 'passkey';
    renderPasskeyStatus();
    showPasskeyDetails(key);
  } catch (error) {
    $('#passkey-status').textContent = error.name === 'NotAllowedError' ? 'Passkey setup cancelled. Try again when ready.' : error.message;
  }
};
signingMethod.onchange = renderPasskeyStatus;
renderPasskeyStatus();
await readStored();
if (signed?.keyType === 'passkey') signingMethod.value = 'passkey';
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
if (!testnet && state.vaultBalance) {
  $('#vault').textContent = 'Balance for agents · ' + formatNear(state.vaultBalance);
  $('#vault').hidden = false;
}
for (const input of [$('#send'), $('#share'), $('#limits')]) input.addEventListener('input', markDirty);
$('#add').onclick = openPayee;
$('#discard').onclick = () => { populate(); status.textContent = ''; };
$('#keys').onclick = async () => {
  if (testnet) {
    const loading = make('p', 'Opening your demo device…', { role: 'status' });
    open('Demo device', loading);
    try {
      const keys = await describeDevice(await demoDevice());
      if (!sheet.open || !content.contains(loading)) return;
      const fields = [['Limited access key', keys.accessKey], ['Registry public key', keys.hex]].map(([name, value]) => {
        const label = make('label', name, { class: 'public-key' });
        const field = make('input', '', { readonly: '' });
        field.value = value;
        field.onclick = () => field.select();
        label.append(field);
        return label;
      });
      open('Demo device', make('p', 'Owner: ' + testnet.owner), ...fields,
        make('p', 'Register this device with the owner account and give it access to set payment limits.'));
    } catch {
      loading.textContent = 'Could not open the demo device. Allow browser storage and try again.';
    }
    return;
  }
  const key = state.agentAccount.keys[0];
  const restricted = state.agentAccount.keys.length === 1 && key?.kind === 'function_call' &&
    key.receiver === 'local-spend' && key.methods.length === 1 && key.methods[0] === 'pay';
  const details = [make('p', state.agentAccount.account), make('p', 'Local demo account')];
  if (restricted) {
    details.push(make('p', 'Milo holds one key'));
    const list = make('ul', '', { class: 'signed-rules' });
    for (const line of ['Can call the spending contract (' + key.receiver + ')', 'Can only ask it to pay',
      "Can't send NEAR directly", "Can't change its own limits"]) list.append(make('li', line));
    details.push(list, make('p', 'Fee allowance left: ' + formatNear(key.allowance)));
  } else {
    details.push(make('p', state.agentAccount.keys.some(entry => entry.kind === 'full')
      ? 'This account has a key that can do anything' : 'Payment-only restriction could not be confirmed.'));
  }
  open('Agent keys', ...details);
};
function downloadJson(value, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  make('a', '', { href: url, download: filename }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('#export').onclick = () => { if (signed) downloadJson(signed, 'signed-policy.json'); };
if (testnet) $('#screen-mode').textContent = records.some(entry => entry.privateCheck?.provider === 'near-ai-cloud') ? 'NEAR AI Cloud' : 'Awaiting private-check rehearsal';
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
    const method = signingMethod.value;
    if (method === 'passkey' && !ownerPasskey(ownerAccount)) throw new Error('Create a passkey before saving with it.');
    const approve = make('button', 'Sign and save', { class: 'primary', type: 'button' });
    const note = make('p', 'Signing with ' + (method === 'passkey' ? 'Passkey' : 'Demo device (this browser)') +
      (testnet ? '. The scoped NEAR key will update the spending limits on testnet.' : '. Saves this local demo policy.'), { role: 'status' });
    const rules = make('ul', '', { class: 'signed-rules' });
    rules.append(...draft.display.map(line => make('li', line)));
    const cancel = make('button', 'Cancel', { type: 'button' });
    cancel.onclick = () => sheet.close();
    const actions = make('div', '', { class: 'actions sheet-actions' });
    actions.append(cancel, approve);
    open("Save Milo's permissions", rules, note, actions);
    approve.onclick = async () => {
      signingBusy = true;
      sheet.querySelector('.close').disabled = true;
      approve.disabled = true;
      cancel.disabled = true;
      note.textContent = 'Signing on this device…';
      try {
        const device = await demoDevice();
        const hash = await hashJson(draft);
        let signedPermission;
        if (method === 'passkey') {
          if (testnet) await requireRegisteredSigner(testnet,
            { ...ownerPasskey(ownerAccount), keyType: 'passkey' }, draft.issuedAtMs);
          signedPermission = await signPermissionWithPasskey(ownerAccount, hash);
        } else {
          const publicKey = await publicHex(device.publicKey);
          const signature = await sign(device.privateKey, hash);
          if (!await verify(publicKey, signature, hash)) throw new Error('Signature check failed');
          signedPermission = { keyType: 'demo_device', publicKey, signature };
        }
        const next = { document: draft, ...signedPermission };
        if (testnet) {
          note.textContent = 'Signed. Waiting for NEAR testnet…';
          await applyTestnetPolicy(testnet, device, draft, next);
        }
        try { sessionStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Policy may already be finalized. */ }
        signed = next;
        active = draft;
        populate();
        signingBusy = false;
        sheet.querySelector('.close').disabled = false;
        sheet.close();
        status.textContent = testnet ? 'Saved and signed on NEAR testnet.' : 'Saved and signed in this browser.';
      } catch (error) {
        signingBusy = false;
        sheet.querySelector('.close').disabled = false;
        note.textContent = error.name === 'NotAllowedError' ? 'Signing cancelled. Your previous permissions are still active.' : testnet ? error.message : "Couldn't sign and save. Your previous local settings are still in force.";
        approve.disabled = false;
        cancel.disabled = false;
        approve.textContent = 'Try again';
      }
    };
  } catch (error) { status.textContent = error.message; }
};

function renderRecords() {
  const search = $('#search').value.trim().toLowerCase();
  const items = [...records].reverse().map(entry => ({ ...entry.record, details: entry.details, privateCheck: entry.privateCheck, sealState: entry.sealState }));
  if (signed) items.unshift({ type: 'permission_changed', summary: signed.keyType === 'passkey' ? 'Dana signed changes with a passkey.' : 'Dana signed changes on the demo device.',
    createdAtMs: signed.document.issuedAtMs, display: signed.document.display });
  const categories = {
    pay: ['paid', 'pay_refused'], block: ['share_blocked', 'pay_refused'],
    screen: ['screen_flagged', 'screen_clear'], permission: ['permission_changed', 'agent_paused', 'agent_resumed']
  };
  const visible = items.filter(item => (!filter || categories[filter]?.includes(item.type)) &&
    item.summary.toLowerCase().includes(search));
  const rows = [];
  let previousDay;
  for (const item of visible) {
    const day = new Date(item.createdAtMs).toDateString();
    if (day !== previousDay) {
      rows.push(make('li', new Date(item.createdAtMs).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }),
        { class: 'evidence-day' }));
      previousDay = day;
    }
    const button = make('button', '', { class: 'record', type: 'button' });
    const summary = make('span', item.summary);
    summary.append(make('small', new Date(item.createdAtMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })));
    button.append(summary);
    const sealLabel = testnet && item.sealState && !['final', 'local'].includes(item.sealState)
      ? (item.sealState === 'blocked' ? 'Needs review' : item.sealState === 'retrying' ? 'Retrying' : 'Sealing') : null;
    button.append(make('span', sealLabel ?? (item.display ? (testnet ? 'Signed on testnet' : 'Signed locally') : (testnet ? 'Sealed on testnet' : 'Sealed locally (demo)')), { class: 'chip' }));
    button.onclick = () => {
      if (item.id) {
        history.replaceState(null, '', '/permissions/evidence/' + encodeURIComponent(item.id));
      }
      showRecord(item);
    };
    const row = make('li', '');
    row.append(button);
    rows.push(row);
  }
  const empty = testnet && !items.length ? 'No testnet evidence yet. Run the testnet rehearsal to see its records here.' :
    filter === 'block' && !search ? 'Nothing blocked' : 'No matching evidence';
  const emptyRow = make('li', empty, { class: 'empty' });
  if (empty === 'Nothing blocked') emptyRow.append(make('p', 'Your agents stayed inside their permissions.'));
  $('#records').replaceChildren(...(rows.length ? rows : [emptyRow]));
}

function showRecord(item) {
  const details = [make('p', item.summary), make('p', new Date(item.createdAtMs).toLocaleString())];
  if (item.sealState === 'blocked') details.push(make('p', 'This batch needs review before sealing can continue.'));
  if (item.caseRef === 'invoice-1042') {
    details.push(make('a', 'Invoice 1042 from Ledger Co', { href: '/cases/invoice-1042' }));
  } else if (item.caseRef === 'acme-q4-review') {
    details.push(make('a', 'Acme Q4 review', { href: '/cases/acme-q4-review' }));
    details.push(make('p', 'Milo: ' + item.agent));
  }
  if (item.type === 'pay_refused' && item.details?.reason === 'not_payee') {
    details.push(make('p', "Refused by the spending contract because it isn't one of Milo's payees."));
    const flagged = records.find(entry => entry.record.type === 'screen_flagged' && entry.record.caseRef === item.caseRef);
    if (flagged) details.push(make('a', "Asked by Ledger Co's agent in a hidden instruction",
      { href: '/permissions/evidence/' + encodeURIComponent(flagged.record.id) }));
  }
  if (item.display) details.push(...item.display.map(line => make('p', line)));
  if (item.details?.flaggedText) {
    details.push(make('h3', 'Flagged text'), make('p', item.details.flaggedText),
      make('h3', 'What happened'), make('p', 'Milo got the message with this text removed.'),
      make('h3', item.privateCheck ? 'Private check on NEAR AI Cloud' : 'Hardware attestation'));
    const checks = {
      signed_text: 'Answer matches what was signed', signature: 'Response signature matches',
      signer_attested: 'Signer belongs to the attested hardware', report_data: 'Attestation matches this signer and request',
      tdx_quote: 'Intel TDX hardware verified', gpu: 'NVIDIA GPU verified'
    };
    const statuses = { passed: 'Passed', failed: 'Failed', not_checked: 'Not checked' };
    const list = make('ul', '', { class: 'attestation-checks' });
    for (const check of item.details.checks ?? []) {
      if (!Object.hasOwn(checks, check.id)) continue;
      const status = Object.hasOwn(statuses, check.status) ? check.status : 'not_checked';
      const row = make('li', '');
      row.append(make('span', checks[check.id]), make('span', statuses[status], { class: 'chip', 'data-check': status }));
      list.append(row);
    }
    if (list.children.length) details.push(list);
    if (item.privateCheck?.provider === 'near-ai-cloud') {
      details.push(make('p', 'Model: ' + item.privateCheck.model));
      const download = make('button', 'Download attestation', { type: 'button' });
      download.onclick = () => downloadJson(item.privateCheck, 'attestation-' + item.id + '.json');
      details.push(download);
    } else {
      details.push(make('p', 'This replay used local screening.'));
    }
  }
  const proof = testnet ? state.testnetProofs?.find(entry => entry.record.id === item.id)
    : state.genuine.record.id === item.id ? state.genuine : null;
  if (proof) {
    if (proof.permission?.document?.display && !item.display) {
      const rules = make('ul', '', { class: 'signed-rules' });
      rules.append(...proof.permission.document.display.map(line => make('li', line)));
      details.push(make('h3', 'Rule in force'), rules);
    }
    if (testnet) {
      const explorer = 'https://explorer.testnet.near.org/transactions/';
      const refs = [['View payment transaction', proof.chainEvent?.txRef], ['View evidence seal', proof.seal?.txRef]];
      const links = make('div', '', { class: 'actions' });
      for (const [label, tx] of refs) {
        if (typeof tx === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(tx)) {
          links.append(make('a', label, { href: explorer + tx, target: '_blank', rel: 'noopener noreferrer' }));
        }
      }
      if (links.children.length) details.push(links);
    }
    const actions = make('div', '', { class: 'actions' });
    const download = make('button', 'Download proof', { type: 'button' });
    download.onclick = () => downloadJson(proof, 'proof-' + proof.record.id + '.json');
    actions.append(download, make('a', 'Check proof', {
      href: testnet ? '/check?record=' + encodeURIComponent(item.id) : '/check?sample=genuine'
    }));
    details.push(actions);
    const metadata = make('details', '', { class: 'record-metadata' });
    metadata.append(make('summary', 'More details'), make('p', 'Record number: ' + item.seq),
      make('p', 'Batch number: ' + proof.batch.batchId));
    if (/^[a-f0-9]{64}$/.test(proof.recordHash)) {
      const fingerprint = make('p', 'Fingerprint: ' + proof.recordHash.slice(0, 8) + '...' + proof.recordHash.slice(-8));
      const copy = make('button', 'Copy fingerprint', { type: 'button' });
      const result = make('span', '', { role: 'status' });
      copy.onclick = async () => {
        try { await navigator.clipboard.writeText(proof.recordHash); result.textContent = 'Copied'; }
        catch { result.textContent = 'Could not copy. Download the proof to get the full fingerprint.'; }
      };
      metadata.append(fingerprint, copy, result);
    }
    if (testnet) metadata.append(make('p', 'Record contract: ' + proof.seal.contract));
    details.push(metadata);
  }
  open(recordTitles[item.type] ?? 'Evidence record', ...details);
}
for (const button of document.querySelectorAll('[data-filter]')) {
  button.onclick = () => {
    filter = button.dataset.filter;
    for (const choice of document.querySelectorAll('[data-filter]')) choice.setAttribute('aria-pressed', String(choice === button));
    renderRecords();
  };
}
document.addEventListener('keydown', event => {
  if (onEvidence && event.key === '/' && !sheet.open && !event.target.matches('input, textarea, select, [contenteditable]')) {
    event.preventDefault();
    $('#search').focus();
  }
});
$('#search').oninput = renderRecords;
renderRecords();
if (onEvidence) {
  const id = location.pathname.split('/')[3] || new URLSearchParams(location.search).get('record');
  if (id) {
    const entry = records.find(row => row.record.id === id);
    if (entry) showRecord({ ...entry.record, details: entry.details, privateCheck: entry.privateCheck, sealState: entry.sealState });
    else status.textContent = 'This evidence record is unavailable in the current rehearsal.';
  }
  sheet.addEventListener('close', () => {
    const url = new URL(location.href);
    if (url.pathname === '/permissions/evidence' && !url.searchParams.has('record')) return;
    history.replaceState(null, '', '/permissions/evidence');
  });
}
