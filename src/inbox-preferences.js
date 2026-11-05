import { assertSafeIdentifier } from './path-safety.js';
import { semanticDigest } from './idempotency.js';

const PATCH_FIELDS = new Set(['folderId', 'read', 'archive', 'readThrough']);
const invalid = message => Object.assign(new TypeError(message), { statusCode: 400 });
const lockKey = documentPath => `human-inbox-preferences:${semanticDigest(documentPath)}`;

function preferencePaths(scope, includeCase = false) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw invalid('Preference scope is required');
  const organizationId = assertSafeIdentifier(scope.organizationId, 'organizationId');
  if (!['personal', 'shared'].includes(scope.scopeMode)) throw invalid('scopeMode must explicitly be personal or shared');
  const namespace = scope.scopeMode === 'personal'
    ? `personal/${assertSafeIdentifier(scope.humanId, 'humanId')}`
    : `shared/workspaces/${assertSafeIdentifier(scope.inboxId, 'inboxId')}`;
  const root = `human-inbox-preferences/${organizationId}/${namespace}`;
  const folders = `${root}/folders.json`;
  if (!includeCase) return { folders };
  const inboxId = assertSafeIdentifier(scope.inboxId, 'inboxId');
  const caseId = assertSafeIdentifier(scope.caseId, 'caseId');
  return { folders, annotation: `${root}/inboxes/${inboxId}/cases/${caseId}.json` };
}

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${name} must be an object`);
}

function normalizedFolderName(input) {
  requireObject(input, 'Folder input');
  if (Object.keys(input).some(key => key !== 'name')) throw invalid('Folder input contains an unknown field');
  if (typeof input.name !== 'string' || [...input.name].length > 80 || /[\u0000-\u001f\u007f]/.test(input.name)) {
    throw invalid('Folder name must be a string of at most 80 characters without control characters');
  }
  const name = input.name.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!name || [...name].length > 80) throw invalid('Folder name must contain 1 to 80 characters');
  return { name, normalizedName: name.toLowerCase() };
}

export function caseReadMarker(workCase) {
  requireObject(workCase, 'Case');
  assertSafeIdentifier(workCase.id, 'caseId');
  const events = workCase.events ?? workCase.timeline ?? [];
  const messages = workCase.messages ?? [];
  if (!Array.isArray(events) || !Array.isArray(messages)) throw invalid('Case events and messages must be arrays');
  return semanticDigest({
    caseId: workCase.id,
    createdAt: workCase.createdAt ?? null,
    updatedAt: workCase.updatedAt ?? null,
    events,
    messages,
    latestMessage: workCase.latestMessage ?? null
  });
}

function validatedCaseMarker(scope, workCase) {
  const revision = caseReadMarker(workCase);
  if (workCase.id !== scope.caseId) throw invalid('Case does not match preference scope');
  return revision;
}

function validatePatch(patch) {
  requireObject(patch, 'Preference patch');
  if (Object.keys(patch).some(key => !PATCH_FIELDS.has(key))) throw invalid('Preference patch contains an unknown field');
  for (const field of ['read', 'archive']) {
    if (Object.hasOwn(patch, field) && typeof patch[field] !== 'boolean') throw invalid(`${field} must be a boolean`);
  }
  if (Object.hasOwn(patch, 'folderId') && patch.folderId !== null) assertSafeIdentifier(patch.folderId, 'folderId');
  if (Object.hasOwn(patch, 'readThrough')) {
    if (patch.read !== true || typeof patch.readThrough !== 'string' || !/^[a-f0-9]{64}$/.test(patch.readThrough)) {
      throw invalid('readThrough requires read:true and a lowercase SHA-256 revision');
    }
  }
}

function emptyAnnotation() {
  return { folderId: null, archived: false, readThrough: null, updatedAt: null };
}

function projectAnnotation(annotation, revision, folders) {
  return {
    folderId: folders.some(folder => folder.id === annotation.folderId) ? annotation.folderId : null,
    read: annotation.readThrough !== null && annotation.readThrough === revision,
    archived: annotation.archived,
    readThrough: annotation.readThrough,
    revision,
    updatedAt: annotation.updatedAt
  };
}

export async function listInboxFolders(store, scope) {
  const { folders } = preferencePaths(scope);
  return store.withTransaction([lockKey(folders)], async () => (await store.getJson(folders))?.folders ?? []);
}

export async function createInboxFolder(store, scope, input, { lockKeys = [], authorize } = {}) {
  const { folders } = preferencePaths(scope);
  const { name, normalizedName } = normalizedFolderName(input);
  if (!Array.isArray(lockKeys)) throw invalid('lockKeys must be an array');
  if (authorize !== undefined && typeof authorize !== 'function') throw invalid('authorize must be a function');
  return store.withTransaction([lockKey(folders), ...lockKeys], async () => {
    if (authorize) await authorize();
    const record = await store.getJson(folders) ?? { folders: [] };
    const existing = record.folders.find(folder => folder.normalizedName === normalizedName);
    if (existing) return existing;
    const folder = { id: assertSafeIdentifier(store.id('folder'), 'folderId'), name, normalizedName, createdAt: store.now() };
    record.folders.push(folder);
    await store.putJson(folders, record);
    return folder;
  });
}

export async function getCaseInboxPreferences(store, scope, workCase) {
  const { folders, annotation } = preferencePaths(scope, true);
  const revision = validatedCaseMarker(scope, workCase);
  return store.withTransaction([lockKey(folders), lockKey(annotation)], async () => {
    const record = await store.getJson(annotation) ?? emptyAnnotation();
    const folderRecords = (await store.getJson(folders))?.folders ?? [];
    return projectAnnotation(record, revision, folderRecords);
  });
}

export async function updateCaseInboxPreferences(store, scope, workCase, patch, { lockKeys = [], authorize } = {}) {
  const { folders, annotation } = preferencePaths(scope, true);
  validatedCaseMarker(scope, workCase);
  validatePatch(patch);
  if (!Array.isArray(lockKeys)) throw invalid('lockKeys must be an array');
  if (authorize !== undefined && typeof authorize !== 'function') throw invalid('authorize must be a function');
  return store.withTransaction([lockKey(folders), lockKey(annotation), ...lockKeys], async () => {
    const authorized = authorize ? await authorize() : null;
    const revision = validatedCaseMarker(scope, authorized?.workCase ?? workCase);
    const current = await store.getJson(annotation) ?? emptyAnnotation();
    const folderRecords = (await store.getJson(folders))?.folders ?? [];
    if (Object.hasOwn(patch, 'folderId') && patch.folderId !== null) {
      if (!folderRecords.some(folder => folder.id === patch.folderId)) {
        throw Object.assign(new Error('Folder not found in this preference scope'), { statusCode: 404 });
      }
    }
    const next = { ...current, folderId: projectAnnotation(current, revision, folderRecords).folderId };
    if (Object.hasOwn(patch, 'folderId')) next.folderId = patch.folderId;
    if (Object.hasOwn(patch, 'archive')) next.archived = patch.archive;
    if (patch.read === false) next.readThrough = null;
    if (patch.read === true) {
      next.readThrough = patch.readThrough ?? revision;
    }
    const changed = next.folderId !== current.folderId || next.archived !== current.archived || next.readThrough !== current.readThrough;
    if (changed) next.updatedAt = store.now();
    if (changed) await store.putJson(annotation, next);
    return projectAnnotation(next, revision, folderRecords);
  });
}

export async function getPrefsForCases(store, scope) {
  const { folders } = preferencePaths(scope);
  assertSafeIdentifier(scope.inboxId, 'inboxId');
  if (!Array.isArray(scope.cases)) throw invalid('Cases must be an array');
  const entries = scope.cases.map(workCase => {
    requireObject(workCase, 'Case');
    const caseScope = { ...scope, caseId: workCase.id };
    const { annotation } = preferencePaths(caseScope, true);
    return { caseId: workCase.id, annotation, revision: validatedCaseMarker(caseScope, workCase) };
  });
  if (new Set(entries.map(entry => entry.caseId)).size !== entries.length) throw invalid('Cases must have unique identifiers');
  if (typeof store.getJsonBatch === 'function') {
    // PostgreSQL reads all preference documents in one MVCC snapshot. Folder
    // mutations and annotation mutations are transactional, so a read-only
    // projection does not need to acquire a lock for every visible case.
    const paths = [folders, ...entries.map(entry => entry.annotation)];
    const documents = await store.getJsonBatch(paths);
    const folderRecords = documents.get(folders)?.folders ?? [];
    const preferences = entries.map(entry => {
      const annotation = documents.get(entry.annotation) ?? emptyAnnotation();
      const { updatedAt, ...projected } = projectAnnotation(annotation, entry.revision, folderRecords);
      return [entry.caseId, projected];
    });
    return {
      folders: folderRecords.map(({ id, name }) => ({ id, name })),
      inboxPreferences: Object.fromEntries(preferences)
    };
  }
  return store.withTransaction([lockKey(folders), ...entries.map(entry => lockKey(entry.annotation))], async () => {
    const folderRecords = (await store.getJson(folders))?.folders ?? [];
    const preferences = [];
    for (const entry of entries) {
      const annotation = await store.getJson(entry.annotation) ?? emptyAnnotation();
      const { updatedAt, ...projected } = projectAnnotation(annotation, entry.revision, folderRecords);
      preferences.push([entry.caseId, projected]);
    }
    return {
      folders: folderRecords.map(({ id, name }) => ({ id, name })),
      inboxPreferences: Object.fromEntries(preferences)
    };
  });
}

export async function updateInboxFolder(store, scope, folderId, input) {
  const { folders } = preferencePaths(scope);
  assertSafeIdentifier(folderId, 'folderId');
  const { name, normalizedName } = normalizedFolderName(input);
  return store.withTransaction([lockKey(folders)], async () => {
    const record = await store.getJson(folders) ?? { folders: [] };
    const folder = record.folders.find(item => item.id === folderId);
    if (!folder) throw Object.assign(new Error('Folder not found in this preference scope'), { statusCode: 404 });
    if (record.folders.some(item => item.id !== folderId && item.normalizedName === normalizedName)) {
      throw Object.assign(new Error('Folder name already exists in this preference scope'), { statusCode: 409 });
    }
    if (folder.name !== name) {
      Object.assign(folder, { name, normalizedName, updatedAt: store.now() });
      await store.putJson(folders, record);
    }
    return folder;
  });
}

export async function deleteInboxFolder(store, scope, folderId, { lockKeys = [], authorize } = {}) {
  const { folders } = preferencePaths(scope);
  assertSafeIdentifier(folderId, 'folderId');
  if (!Array.isArray(lockKeys)) throw invalid('lockKeys must be an array');
  if (authorize !== undefined && typeof authorize !== 'function') throw invalid('authorize must be a function');
  return store.withTransaction([lockKey(folders), ...lockKeys], async () => {
    if (authorize) await authorize();
    const record = await store.getJson(folders) ?? { folders: [] };
    const remaining = record.folders.filter(folder => folder.id !== folderId);
    if (remaining.length === record.folders.length) return { deleted: false };
    await store.putJson(folders, { folders: remaining });
    return { deleted: true };
  });
}

export async function clearCaseInboxPreferences(store, scope, workCase) {
  return updateCaseInboxPreferences(store, scope, workCase, { folderId: null, read: false, archive: false });
}
