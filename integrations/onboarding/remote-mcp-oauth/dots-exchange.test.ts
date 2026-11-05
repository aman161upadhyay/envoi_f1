import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

// Keep the real local OAuth regression in the normal integrations/CI runner.
// The child harness uses synthetic FileStore data and never a configured database.
it('reconsents a receive-only OAuth identity and exchanges exactly-once messages between two local owners', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['--test', '--test-reporter=tap', 'integrations/onboarding/remote-mcp-oauth/dots-exchange.test.mjs'], {
    cwd: fileURLToPath(new URL('../../../', import.meta.url)), env: { ...process.env, DATABASE_URL: '' }, timeout: 90000
  });
  expect(stdout).toContain('# pass 1');
  expect(stdout).toContain('# fail 0');
}, 95000);
