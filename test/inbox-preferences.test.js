import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileStore } from '../src/storage.js';
import {
  caseReadMarker,
  clearCaseInboxPreferences,
  createInboxFolder,
  deleteInboxFolder,
  getCaseInboxPreferences,
  getPrefsForCases,
  listInboxFolders,
  updateCaseInboxPreferences,
  updateInboxFolder
} from '../src/inbox-preferences.js';

const folderScope = { scopeMode: 'personal', organizationId: 'org_one', humanId: 'human_one' };
const caseScope = { ...folderScope, inboxId: 'inbox_one', caseId: 'case_one' };
const invalidInput = error => error.statusCode === 400;
const missingFolder = error => error.statusCode === 404;

async function createStore(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'envoi-inbox-preferences-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileStore(root);
  await store.init();
  return store;
}

function createCase(store) {
  const createdAt = store.now();
  return {
    id: caseScope.caseId,
    state: 'waitingForHuman',
    updatedAt: createdAt,
    events: [{ id: 'evt_one', createdAt, type: 'message' }],
    policyEvaluations: [{ id: 'policy_one', decision: 'needsHuman' }],
    authorityRefs: ['grant_one']
  };
}

test('folder retries deduplicate normalized names even under concurrency', async context => {
  const store = await createStore(context);
  const names = ['  Travel   Plans  ', 'travel plans', 'ＴＲＡＶＥＬ plans'];
  const folders = await Promise.all(names.map(name => createInboxFolder(store, folderScope, { name })));
  assert.equal(new Set(folders.map(folder => folder.id)).size, 1);
  assert.match(folders[0].id, /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
  assert.equal(folders[0].name, 'Travel Plans');
  assert.deepEqual(await listInboxFolders(store, folderScope), [folders[0]]);
});

test('folders and annotations survive a new store instance', async context => {
  const store = await createStore(context);
  const caseRecord = createCase(store);
  const folder = await createInboxFolder(store, folderScope, { name: 'Travel' });
  const saved = await updateCaseInboxPreferences(store, caseScope, caseRecord, {
    folderId: folder.id, read: true, archive: true
  });
  const restarted = new FileStore(store.root);
  await restarted.init();
  assert.deepEqual(await listInboxFolders(restarted, folderScope), [folder]);
  assert.deepEqual(await getCaseInboxPreferences(restarted, caseScope, caseRecord), saved);
  assert.equal(saved.read, true);
  assert.equal(saved.archived, true);
  assert.equal(saved.readThrough, caseReadMarker(caseRecord));
  assert.equal(saved.revision, caseReadMarker(caseRecord));
});

test('human, organization, inbox and case annotations stay isolated', async context => {
  const store = await createStore(context);
  const caseRecord = createCase(store);
  const folder = await createInboxFolder(store, folderScope, { name: 'Travel' });
  await updateCaseInboxPreferences(store, caseScope, caseRecord, { folderId: folder.id, read: true, archive: true });
  for (const scope of [
    { ...caseScope, humanId: 'human_two' },
    { ...caseScope, organizationId: 'org_two' },
    { ...caseScope, inboxId: 'inbox_two' },
    { ...caseScope, caseId: 'case_two' }
  ]) {
    const otherCase = { ...caseRecord, id: scope.caseId };
    const preferences = await getCaseInboxPreferences(store, scope, otherCase);
    assert.equal(preferences.read, false);
    assert.equal(preferences.archived, false);
    assert.equal(preferences.folderId, null);
  }
  for (const scope of [
    { ...folderScope, humanId: 'human_two' },
    { ...folderScope, organizationId: 'org_two' }
  ]) {
    assert.deepEqual(await listInboxFolders(store, scope), []);
    await assert.rejects(() => updateCaseInboxPreferences(store, { ...caseScope, ...scope }, caseRecord, { folderId: folder.id }), missingFolder);
  }
});

test('new equal-time or backdated events become unread; stale acknowledgements stay unread', async context => {
  const store = await createStore(context);
  const caseRecord = createCase(store);
  const originalCursor = caseReadMarker(caseRecord);
  await updateCaseInboxPreferences(store, caseScope, caseRecord, { read: true });
  const sameTimeCase = { ...caseRecord, events: [...caseRecord.events, { id: 'evt_two', createdAt: caseRecord.events[0].createdAt, type: 'message' }] };
  assert.notEqual(caseReadMarker(sameTimeCase), originalCursor);
  assert.equal((await getCaseInboxPreferences(store, caseScope, sameTimeCase)).read, false);
  const stale = await updateCaseInboxPreferences(store, caseScope, sameTimeCase, { read: true, readThrough: originalCursor });
  assert.equal(stale.read, false);
  await updateCaseInboxPreferences(store, caseScope, sameTimeCase, { read: true });
  const backdatedCase = { ...sameTimeCase, events: [...sameTimeCase.events, {
    id: 'evt_three', type: 'message',
    createdAt: new Date(Date.parse(caseRecord.events[0].createdAt) - 1000).toISOString()
  }] };
  assert.equal((await getCaseInboxPreferences(store, caseScope, backdatedCase)).read, false);
});

test('empty cases can be read and their first event makes them unread', async context => {
  const store = await createStore(context);
  const caseRecord = createCase(store);
  const emptyCase = { ...caseRecord, events: [] };
  assert.equal(typeof caseReadMarker(emptyCase), 'string');
  assert.equal((await getCaseInboxPreferences(store, caseScope, emptyCase)).read, false);
  assert.equal((await updateCaseInboxPreferences(store, caseScope, emptyCase, { read: true })).read, true);
  assert.equal((await getCaseInboxPreferences(store, caseScope, emptyCase)).read, true);
  assert.equal((await getCaseInboxPreferences(store, caseScope, caseRecord)).read, false);
});

test('Done and move-back preserve the protocol case, folder and read acknowledgement', async context => {
  const store = await createStore(context);
  const caseRecord = createCase(store);
  const original = structuredClone(caseRecord);
  const relative = `inboxes/${caseScope.inboxId}/cases/${caseScope.caseId}.json`;
  await store.putJson(relative, caseRecord);
  const folder = await createInboxFolder(store, folderScope, { name: 'Travel' });
  const done = await updateCaseInboxPreferences(store, caseScope, caseRecord, { folderId: folder.id, read: true, archive: true });
  const changedCase = { ...caseRecord, events: [...caseRecord.events, { id: 'evt_two', createdAt: store.now(), type: 'message' }] };
  const stillDone = await getCaseInboxPreferences(store, caseScope, changedCase);
  assert.equal(stillDone.archived, true);
  assert.equal(stillDone.read, false);
  const restored = await updateCaseInboxPreferences(store, caseScope, changedCase, { archive: false });
  assert.equal(restored.archived, false);
  assert.equal(restored.folderId, folder.id);
  assert.equal(restored.readThrough, done.readThrough);
  assert.deepEqual(caseRecord, original);
  assert.deepEqual(await store.getJson(relative), original);
  const cleared = await updateCaseInboxPreferences(store, caseScope, changedCase, { folderId: null, read: false });
  assert.equal(cleared.folderId, null);
  assert.equal(cleared.readThrough, null);
});

test('unchanged requests preserve timestamps and concurrent patches preserve distinct fields', async context => {
  const store = await createStore(context);
  const caseRecord = createCase(store);
  const initial = await updateCaseInboxPreferences(store, caseScope, caseRecord, { read: true });
  store.now = () => new Date(Date.parse(initial.updatedAt) + 1000).toISOString();
  assert.deepEqual(await updateCaseInboxPreferences(store, caseScope, caseRecord, { read: true }), initial);
  const folder = await createInboxFolder(store, folderScope, { name: 'Travel' });
  await Promise.all([
    updateCaseInboxPreferences(store, caseScope, caseRecord, { folderId: folder.id }),
    updateCaseInboxPreferences(store, caseScope, caseRecord, { archive: true })
  ]);
  const saved = await getCaseInboxPreferences(store, caseScope, caseRecord);
  assert.equal(saved.folderId, folder.id);
  assert.equal(saved.archived, true);
  assert.equal(saved.read, true);
});

test('invalid folder names, unsafe scope and malformed patches reject without partial mutation', async context => {
  const store = await createStore(context);
  const caseRecord = createCase(store);
  for (const name of ['', '  ', 'x'.repeat(81), 'Travel\u0000', 42, null]) {
    await assert.rejects(() => createInboxFolder(store, folderScope, { name }), invalidInput);
  }
  assert.deepEqual(await listInboxFolders(store, folderScope), []);
  for (const field of ['organizationId', 'humanId', 'inboxId', 'caseId']) {
    await assert.rejects(() => getCaseInboxPreferences(store, { ...caseScope, [field]: '../escape' }, caseRecord), invalidInput);
  }
  await assert.rejects(() => updateCaseInboxPreferences(store, caseScope, { ...caseRecord, id: 'case_other' }, { archive: true }), invalidInput);
  const baseline = await getCaseInboxPreferences(store, caseScope, caseRecord);
  for (const patch of [
    null, [], { read: 'true' }, { archive: 1 }, { folderId: 42 },
    { folderId: '../escape' }, { state: 'completed' },
    { readThrough: caseReadMarker(caseRecord) }, { read: false, readThrough: caseReadMarker(caseRecord) },
    { read: true, readThrough: 'invented-future-token', archive: true },
    { read: true, readThrough: 'x'.repeat(513) }
  ]) {
    await assert.rejects(() => updateCaseInboxPreferences(store, caseScope, caseRecord, patch), invalidInput);
    assert.deepEqual(await getCaseInboxPreferences(store, caseScope, caseRecord), baseline);
  }
  await assert.rejects(() => updateCaseInboxPreferences(store, caseScope, caseRecord, { folderId: 'folder_missing', archive: true }), missingFolder);
  assert.deepEqual(await getCaseInboxPreferences(store, caseScope, caseRecord), baseline);
});

test('HumanView exposes observed revisions without marking cases read and includes latest messages', async context => {
  const store = await createStore(context);
  const caseRecord = createCase(store);
  const folder = await createInboxFolder(store, folderScope, { name: 'Travel' });
  const view = await getPrefsForCases(store, { ...caseScope, cases: [caseRecord] });
  assert.deepEqual(view.folders, [{ id: folder.id, name: folder.name }]);
  assert.deepEqual(view.inboxPreferences[caseRecord.id], {
    read: false, archived: false, folderId: null, readThrough: null,
    revision: caseReadMarker(caseRecord)
  });
  const changedCase = { ...caseRecord, messages: [{ id: 'msg_one', text: 'New message', createdAt: store.now() }] };
  assert.notEqual(caseReadMarker(changedCase), view.inboxPreferences[caseRecord.id].revision);
  const restarted = new FileStore(store.root);
  await restarted.init();
  const stale = await updateCaseInboxPreferences(restarted, caseScope, changedCase, {
    read: true, readThrough: view.inboxPreferences[caseRecord.id].revision
  });
  assert.equal(stale.read, false);
  const refreshed = await getPrefsForCases(restarted, { ...caseScope, cases: [changedCase] });
  assert.equal(refreshed.inboxPreferences[caseRecord.id].read, false);
  const viewed = await updateCaseInboxPreferences(restarted, caseScope, changedCase, {
    read: true, readThrough: refreshed.inboxPreferences[caseRecord.id].revision
  });
  assert.equal(viewed.read, true);
});

test('PostgreSQL preference projection reads all visible cases in one snapshot', async () => {
  const cases = Array.from({ length: 50 }, (_, index) => ({ id: `case_${index}`, events: [], messages: [] }));
  const folderPath = 'human-inbox-preferences/org_one/personal/human_one/folders.json';
  const annotationPath = `${folderPath.slice(0, -'folders.json'.length)}inboxes/inbox_one/cases/case_0.json`;
  let reads = 0;
  const store = {
    getJsonBatch: async paths => {
      reads += 1;
      assert.equal(paths.length, 51);
      return new Map([
        [folderPath, { folders: [{ id: 'folder_one', name: 'Travel' }] }],
        [annotationPath, { folderId: 'folder_one', archived: true, readThrough: caseReadMarker(cases[0]) }]
      ]);
    },
    withTransaction: () => { throw new Error('Read-only projection acquired case locks'); }
  };
  const view = await getPrefsForCases(store, { ...caseScope, cases });
  assert.equal(reads, 1);
  assert.deepEqual(view.folders, [{ id: 'folder_one', name: 'Travel' }]);
  assert.equal(view.inboxPreferences.case_0.read, true);
  assert.equal(view.inboxPreferences.case_0.archived, true);
  assert.equal(view.inboxPreferences.case_49.read, false);
});

test('case revision is stable across object key order and changes when latest content changes', () => {
  const createdAt = new Date().toISOString();
  const event = { id: 'evt_one', createdAt, payload: { text: 'First message' } };
  const caseRecord = { id: 'case_one', createdAt, updatedAt: createdAt, events: [event] };
  const reordered = { events: [{ payload: { text: 'First message' }, createdAt, id: 'evt_one' }], updatedAt: createdAt, createdAt, id: 'case_one' };
  assert.equal(caseReadMarker(caseRecord), caseReadMarker(reordered));
  assert.notEqual(caseReadMarker(caseRecord), caseReadMarker({ ...caseRecord, events: [{ ...event, payload: { text: 'Edited message' } }] }));
  assert.notEqual(caseReadMarker(caseRecord), caseReadMarker({ ...caseRecord, updatedAt: new Date(Date.parse(createdAt) + 1000).toISOString() }));
});

test('scope mode is mandatory and shared annotations are isolated by organization and workspace', async context => {
  const store = await createStore(context);
  const caseRecord = createCase(store);
  const shared = { scopeMode: 'shared', organizationId: 'org_one', inboxId: 'inbox_one', caseId: 'case_one' };
  const folder = await createInboxFolder(store, shared, { name: 'Shared work' });
  await updateCaseInboxPreferences(store, { ...shared, humanId: 'human_one' }, caseRecord, { folderId: folder.id, read: true, archive: true });
  const colleague = await getCaseInboxPreferences(store, { ...shared, humanId: 'human_two' }, caseRecord);
  assert.equal(colleague.folderId, folder.id);
  assert.equal(colleague.read, true);
  assert.equal(colleague.archived, true);
  const restarted = new FileStore(store.root);
  await restarted.init();
  assert.deepEqual(await getCaseInboxPreferences(restarted, shared, caseRecord), colleague);
  for (const scope of [caseScope, { ...shared, organizationId: 'org_two' }, { ...shared, inboxId: 'inbox_two' }]) {
    assert.deepEqual(await listInboxFolders(store, scope), []);
    assert.equal((await getCaseInboxPreferences(store, scope, caseRecord)).archived, false);
    await assert.rejects(() => updateCaseInboxPreferences(store, scope, caseRecord, { folderId: folder.id }), missingFolder);
  }
  for (const scope of [
    { ...caseScope, scopeMode: undefined }, { ...caseScope, scopeMode: 'ambiguous' },
    { ...caseScope, humanId: undefined }, { ...shared, inboxId: undefined }
  ]) {
    await assert.rejects(() => listInboxFolders(store, scope), invalidInput);
  }
});

test('projection performs no writes and unknown valid digests simply leave the case unread', async context => {
  const store = await createStore(context);
  const caseRecord = createCase(store);
  const putJson = store.putJson.bind(store);
  let writes = 0;
  store.putJson = async (...args) => { writes += 1; return putJson(...args); };
  for (let iteration = 0; iteration < 3; iteration += 1) {
    await getCaseInboxPreferences(store, caseScope, caseRecord);
    await getPrefsForCases(store, { ...caseScope, cases: [caseRecord] });
    await listInboxFolders(store, folderScope);
  }
  assert.equal(writes, 0);
  const unknownRevision = 'a'.repeat(64);
  const saved = await updateCaseInboxPreferences(store, caseScope, caseRecord, { read: true, readThrough: unknownRevision });
  assert.equal(saved.readThrough, unknownRevision);
  assert.equal(saved.read, false);
  const records = await store.listJson('human-inbox-preferences/org_one/personal/human_one/inboxes/inbox_one/cases');
  assert.deepEqual(Object.keys(records[0]).sort(), ['archived', 'folderId', 'readThrough', 'updatedAt']);
  const writesAfterMutation = writes;
  await getPrefsForCases(store, { ...caseScope, cases: [caseRecord] });
  assert.equal(writes, writesAfterMutation);
});

test('folder rename/delete and annotation reset support both modes without changing cases', async context => {
  const store = await createStore(context);
  const caseRecord = createCase(store);
  const original = structuredClone(caseRecord);
  for (const scope of [caseScope, { ...caseScope, scopeMode: 'shared' }]) {
    const folder = await createInboxFolder(store, scope, { name: 'Travel' });
    const other = await createInboxFolder(store, scope, { name: 'Other' });
    const renamed = await updateInboxFolder(store, scope, folder.id, { name: ' Trips ' });
    assert.equal(renamed.id, folder.id);
    assert.equal(renamed.name, 'Trips');
    await assert.rejects(() => updateInboxFolder(store, scope, folder.id, { name: 'OTHER' }), error => error.statusCode === 409);
    await updateCaseInboxPreferences(store, scope, caseRecord, { folderId: folder.id, read: true, archive: true });
    assert.deepEqual(await deleteInboxFolder(store, scope, folder.id), { deleted: true });
    assert.deepEqual(await deleteInboxFolder(store, scope, folder.id), { deleted: false });
    const unfiled = await getCaseInboxPreferences(store, scope, caseRecord);
    assert.equal(unfiled.folderId, null);
    assert.equal(unfiled.archived, true);
    assert.equal(unfiled.read, true);
    assert.deepEqual((await listInboxFolders(store, scope)).map(item => item.id), [other.id]);
    const cleared = await clearCaseInboxPreferences(store, scope, caseRecord);
    assert.equal(cleared.folderId, null);
    assert.equal(cleared.read, false);
    assert.equal(cleared.archived, false);
    assert.equal(cleared.readThrough, null);
    assert.deepEqual(caseRecord, original);
  }
});

test('maximum safe identifiers use bounded transaction keys and rejected writes roll back', async context => {
  const store = await createStore(context);
  const scope = {
    scopeMode: 'personal', organizationId: 'o'.repeat(128), humanId: 'h'.repeat(128),
    inboxId: 'i'.repeat(128), caseId: 'c'.repeat(128)
  };
  const caseRecord = { ...createCase(store), id: scope.caseId };
  const withTransaction = store.withTransaction.bind(store);
  store.withTransaction = (keys, operation) => {
    assert.ok(keys.every(key => key.length <= 512));
    return withTransaction(keys, operation);
  };
  const folder = await createInboxFolder(store, scope, { name: 'Travel' });
  const saved = await updateCaseInboxPreferences(store, scope, caseRecord, { folderId: folder.id, archive: true });
  const putJson = store.putJson.bind(store);
  store.putJson = async (...args) => {
    await putJson(...args);
    throw new Error('Injected storage failure');
  };
  await assert.rejects(() => updateCaseInboxPreferences(store, scope, caseRecord, { read: true, archive: false }), /Injected storage failure/);
  assert.deepEqual(await getCaseInboxPreferences(store, scope, caseRecord), saved);
});

test('latest-message and timeline-only case projections contribute to revisions', () => {
  const createdAt = new Date().toISOString();
  const caseRecord = { id: 'case_one', createdAt, updatedAt: createdAt };
  const withTimeline = { ...caseRecord, timeline: [{ id: 'evt_one', createdAt, summary: 'A message arrived' }] };
  assert.notEqual(caseReadMarker(caseRecord), caseReadMarker(withTimeline));
  assert.notEqual(caseReadMarker(caseRecord), caseReadMarker({ ...caseRecord, latestMessage: { id: 'msg_one', createdAt, text: 'New message' } }));
  assert.equal(caseReadMarker(caseRecord), caseReadMarker({ ...caseRecord, needsAttention: true, state: 'completed', inboxPreference: { read: true } }));
});

test('queued mutations recheck authorization after lock-backed revocation commits', async context => {
  const store = await createStore(context);
  const caseRecord = createCase(store);
  const accessPath = 'fixture/access.json';
  const accessKey = 'fixture:access';
  await store.putJson(accessPath, { active: true });
  let releaseRevocation;
  let revocationEntered;
  const release = new Promise(resolve => { releaseRevocation = resolve; });
  const entered = new Promise(resolve => { revocationEntered = resolve; });
  const revocation = store.withTransaction([accessKey], async () => {
    revocationEntered();
    await release;
    await store.putJson(accessPath, { active: false });
  });
  await entered;
  let authorizations = 0;
  const mutation = updateCaseInboxPreferences(store, caseScope, caseRecord, { archive: true }, {
    lockKeys: [accessKey],
    authorize: async () => {
      authorizations += 1;
      assert.ok(store.currentTransaction().keys.has(accessKey));
      if (!(await store.getJson(accessPath)).active) throw Object.assign(new Error('Fixture access revoked'), { statusCode: 403 });
    }
  });
  assert.equal(authorizations, 0);
  releaseRevocation();
  await revocation;
  await assert.rejects(() => mutation, error => error.statusCode === 403);
  assert.equal(authorizations, 1);
  assert.equal((await getCaseInboxPreferences(store, caseScope, caseRecord)).archived, false);
});
