import { enrollConnector } from '../../sdk/typescript/src/connector';
import { FileBridgeStore } from '../agent-bridges/file-store';
import { createGrokBridge } from './runtime';
import { migrateConnectionDirectory } from '../connector/migrate';
import { acquireConnectorLock, privateDirectory } from '../connector/store';
import { pathToFileURL } from 'node:url';

export async function runGrok() {
  const apiUrl = process.env.ENVOI_API_URL;
  const requested = process.env.ENVOI_STATE_DIR;
  const apiKey = process.env.XAI_API_KEY;
  if (!apiUrl || !requested || !apiKey) throw new Error('ENVOI_API_URL, ENVOI_STATE_DIR and XAI_API_KEY are required');
  const stateDir = await migrateConnectionDirectory(requested);
  await privateDirectory(stateDir);
  const unlock = await acquireConnectorLock(stateDir);
  try {
    const store = new FileBridgeStore(stateDir);
    await store.init();
    if (!await store.load()) {
      const code = process.env.ENVOI_ENROLLMENT_TOKEN;
      if (!code) throw new Error('ENVOI_ENROLLMENT_TOKEN is required for first enrollment');
      await enrollConnector(apiUrl, code, store, { name: process.env.ENVOI_AGENT_NAME || 'Grok bridge' });
    }
    delete process.env.ENVOI_ENROLLMENT_TOKEN;
    const bridge = await createGrokBridge({ apiUrl, stateDir, apiKey, model: process.env.XAI_MODEL || 'grok-4.7' });
    const stop = new AbortController();
    const onStop = () => stop.abort();
    process.once('SIGINT', onStop);
    process.once('SIGTERM', onStop);
    try { await bridge.connector.run(stop.signal); }
    finally {
      process.removeListener('SIGINT', onStop);
      process.removeListener('SIGTERM', onStop);
      await bridge.close();
    }
  } finally { await unlock(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runGrok().catch(() => {
  process.stderr.write('Grok bridge stopped; inspect local configuration, provider health and credential status.\n');
  process.exitCode = 1;
});
