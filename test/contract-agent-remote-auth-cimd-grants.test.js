import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const read = async file => JSON.parse(await readFile(new URL(file, import.meta.url), 'utf8'));
const registry = await read('./contract-fixtures/index.json');
const entry = registry.contracts.find(row => row.id === 'agent-remote-auth-cimd-grants');
const [schema, original] = await Promise.all([
  read('./contract-fixtures/agent-remote-auth-cimd-grants/schemas.json'),
  read('./contract-fixtures/agent-remote-auth/schemas.json')
]);
const ajv = new Ajv({ allErrors: true, strict: false }); addFormats(ajv);
ajv.addSchema(schema); ajv.addSchema(original);
const validate = ajv.getSchema(schema.$id + '#/definitions/clientGrantMetadata');
const oldDocument = ajv.getSchema(original.$id + '#/definitions/clientMetadataDocument');
const rows = await Promise.all(entry.fixtures.map(file => read('./contract-fixtures/' + entry.dir + '/' + file)));

test('grant amendment is additive, approved and leaves server grant support unchanged', () => {
  assert.equal(entry.version, 1); assert.equal(entry.status, 'approved');
  assert.equal(rows.length, 21);
  assert.deepEqual(schema['x-server-grants'], ['authorization_code', 'refresh_token']);
  assert.equal(registry.contracts.find(row => row.id === 'agent-remote-auth').status, 'approved');
});
for (const row of rows) test('CIMD grant publication: ' + row.id, () => {
  assert.equal(validate(row.document), row.expected.valid, ajv.errorsText(validate.errors));
  const normalized = { ...row.document, grant_types: ['authorization_code'], token_endpoint_auth_method: 'none' };
  delete normalized.token_endpoint_auth_methods_supported;
  assert.equal(oldDocument(normalized), true, ajv.errorsText(oldDocument.errors));
});
test('public ChatGPT observation demonstrates the old contract rejection', () => {
  const row = rows.find(row => row.id === 'current-chatgpt-extra-grant');
  assert.equal(oldDocument(row.document), false);
  assert.equal(validate(row.document), true);
  assert.ok(row.document.grant_types.includes('urn:ietf:params:oauth:grant-type:jwt-bearer'));
});
