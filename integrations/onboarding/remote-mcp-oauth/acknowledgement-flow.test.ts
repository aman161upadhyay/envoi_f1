import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('processes an approved acknowledgement before a request without a reply loop or unrelated settlement', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['--test', '--test-reporter=tap', 'integrations/onboarding/remote-mcp-oauth/acknowledgement-flow.test.mjs'], {
    cwd: fileURLToPath(new URL('../../../', import.meta.url)),
    env: { ...process.env, DATABASE_URL: '' }, windowsHide: true, timeout: 90000
  });
  expect(stdout).toContain('# pass 1');
  expect(stdout).toContain('# fail 0');
}, 95000);
