import { execFile } from 'node:child_process';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const compare = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/verify-office-edit.py', import.meta.url));
const formats = new Map([
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx']
]);

export function officeRevisionFormat(mimeType) {
  return formats.get(mimeType);
}

export async function verifyOfficeRevision({ executable, format, previous, candidate, parts }) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'envoi-office-edit-'));
  const before = path.join(workspace, 'before');
  const after = path.join(workspace, 'after');
  try {
    await writeFile(before, previous);
    await writeFile(after, candidate);
    const { stdout } = await compare(executable, [script, format, before, after, ...parts.map(part => `--part=${part}`)], {
      timeout: 5_000, maxBuffer: 32_768, windowsHide: true, encoding: 'utf8', cwd: workspace,
      env: Object.fromEntries(['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'].filter(name => process.env[name]).map(name => [name, process.env[name]]))
    });
    const result = JSON.parse(stdout);
    if (!Array.isArray(result?.changedParts) || !result.changedParts.length) throw Object.assign(new Error('The Office revision does not change any granted parts.'), { statusCode: 422, code: 'OFFICE_EDIT_UNCHANGED' });
    return result.changedParts;
  } catch (error) {
    if (error.statusCode) throw error;
    if (error.code === 1 && error.stderr?.startsWith('Office edit rejected:')) {
      throw Object.assign(new Error('The Office revision changes content outside its signed scope or is invalid.'), { statusCode: 422, code: 'OFFICE_EDIT_OUT_OF_SCOPE' });
    }
    throw Object.assign(new Error('Office revision verification is unavailable.'), { statusCode: 503, code: 'OFFICE_EDIT_VERIFIER_UNAVAILABLE' });
  } finally {
    await Promise.allSettled([unlink(before), unlink(after)]);
    await rmdir(workspace).catch(() => {});
  }
}
