import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from 'vitest';
import { runPortableRestCli } from '../portable-rest-cli';

test('private REST host command refuses token arguments and uncompleted work without a network call', async () => {
  const directory = await mkdtemp(path.join(process.cwd(), '.envoi-rest-package-test-'));
  const stateDirectory = path.join(directory, 'envoi-rest-host');
  await mkdir(stateDirectory);
  const configFile = path.join(stateDirectory, 'host.json');
  const handlerModule = path.join(stateDirectory, 'handler.mjs');
  const projections: Array<Record<string, unknown>> = [];
  try {
    expect(await runPortableRestCli(['connect', configFile, '--token', 'envoi_agent_access_PRIVATE'], result => projections.push(result))).toBe(false);
    expect(JSON.stringify(projections)).not.toContain('envoi_agent_access_PRIVATE');
    await writeFile(handlerModule, 'export function createWorkHandler() { return { admit: async () => {}, process: async () => {} }; }');
    await writeFile(configFile, JSON.stringify({ schemaVersion: 'portable-rest-host-v1', origin: 'https://www.envoi-agents.com',
      stateDirectory, handlerModule, runtime: { type: 'generic_https', version: '1.0.0' }, requestedName: 'Generic host' }));
    expect(await runPortableRestCli(['run', configFile], result => projections.push(result))).toBe(false);
    expect(projections.at(-1)).toMatchObject({ state: 'needs_help', reachability: 'not_verified_closed_app' });
    expect(JSON.stringify(projections)).not.toMatch(/envoi_agent_|handler\.mjs|stateDirectory/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('REST status does not import the provider handler or initialize a model', async () => {
  const directory = await mkdtemp(path.join(process.cwd(), '.envoi-rest-status-test-'));
  const stateDirectory = path.join(directory, 'envoi-rest-host');
  await mkdir(stateDirectory);
  const configFile = path.join(stateDirectory, 'host.json');
  const handlerModule = path.join(stateDirectory, 'status-handler.mjs');
  const projections: Array<Record<string, unknown>> = [];
  try {
    await writeFile(handlerModule, 'throw new Error("provider handler must not load for status");');
    await writeFile(configFile, JSON.stringify({ schemaVersion: 'portable-rest-host-v1', origin: 'https://www.envoi-agents.com',
      stateDirectory, handlerModule, runtime: { type: 'generic_https', version: '1.0.0' }, requestedName: 'Generic host' }));
    expect(await runPortableRestCli(['status', configFile], result => projections.push(result))).toBe(true);
    expect(projections.at(-1)).toMatchObject({ state: 'needs_help' });
    expect(await runPortableRestCli(['resume', configFile], result => projections.push(result))).toBe(false);
    expect(JSON.stringify(projections)).not.toMatch(/provider handler must not load|handler\.mjs|stateDirectory/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
