import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runGrok } from './run';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function configure() {
  const directory = await mkdtemp(path.join(tmpdir(), 'envoi-grok-entry-'));
  directories.push(directory);
  vi.stubEnv('ENVOI_API_URL', 'https://envoi.example');
  vi.stubEnv('ENVOI_STATE_DIR', directory);
  vi.stubEnv('XAI_API_KEY', 'test-key');
  vi.stubEnv('ENVOI_ENROLLMENT_TOKEN', undefined);
  return path.join(directory, 'connector.lock');
}

it('refuses a second bridge before reading or enrolling the connection', async () => {
  const lock = await configure();
  const owner = JSON.stringify({ pid: process.pid, nonce: 'live-owner' });
  await writeFile(lock, owner);

  await expect(runGrok()).rejects.toThrow('already running');
  await expect(readFile(lock, 'utf8')).resolves.toBe(owner);
});

it('releases its connection lock when startup fails', async () => {
  const lock = await configure();
  await expect(runGrok()).rejects.toThrow('ENVOI_ENROLLMENT_TOKEN is required');
  await expect(readFile(lock)).rejects.toMatchObject({ code: 'ENOENT' });
});
