import { randomUUID } from 'node:crypto';
import { ConnectorSetupError, type AdapterOptions } from '../connector/adapter';
import type { HermesConfiguration } from './config';

const headers = (config: HermesConfiguration) => ({ authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' });

export async function hermesRequest(config: HermesConfiguration, pathname: string, options: AdapterOptions, init: RequestInit = {}) {
  try {
    const response = await (options.fetch ?? fetch)(`${config.apiUrl}${pathname}`, {
      ...init, redirect: 'error', headers: { ...headers(config), ...init.headers },
      signal: AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(15_000)])
    });
    if (response.status === 401 || response.status === 403) throw new ConnectorSetupError('GATEWAY_AUTH_FAILED', 'Hermes rejected its local API Server key. Check the selected profile and restart its Gateway after key changes.');
    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel().catch(() => {});
      throw new ConnectorSetupError('GATEWAY_UNREACHABLE', 'Hermes API Server is temporarily unavailable. The saved connection will retry without another enrollment.');
    }
    return response;
  } catch (error) {
    if (error instanceof ConnectorSetupError) throw error;
    if (options.signal?.aborted) throw new ConnectorSetupError('SETUP_CANCELLED', 'Hermes setup was cancelled. Saved connection state can be resumed.');
    throw new ConnectorSetupError('GATEWAY_UNREACHABLE', 'Hermes API Server is unreachable. Start the selected profile Gateway in a separate terminal (hermes gateway start), then retry. Existing provider credentials are reused; do not substitute the Envoi token.');
  }
}

async function json(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new ConnectorSetupError('GATEWAY_TEST_FAILED', 'Hermes returned an invalid API response. Check its version and local diagnostics.'); }
}

/** Bounded real model run. No provider override; failures never expose upstream bodies. */
export async function boundedHermesRun(config: HermesConfiguration, input: string, options: AdapterOptions,
  limits: { timeoutMs?: number; pollMs?: number } = {}) {
  const signal = AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(limits.timeoutMs ?? 75_000)]);
  const boundedOptions = { ...options, signal };
  let runId: string | undefined;
  let finished = false;
  try {
    const created = await hermesRequest(config, '/v1/runs', boundedOptions, {
      method: 'POST', headers: { 'Idempotency-Key': `envoi-setup-${randomUUID()}` },
      body: JSON.stringify({ input, session_id: `envoi-setup-${randomUUID()}` })
    });
    if (created.status !== 202) throw new ConnectorSetupError('MODEL_NOT_READY', 'Hermes could not start a test run using its configured provider. Run hermes doctor and configure the selected profile model/provider locally; no enrollment token was needed for this test.');
    const payload = await json(created);
    if (typeof payload.run_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.run_id)) throw new ConnectorSetupError('GATEWAY_TEST_FAILED', 'Hermes returned no valid test run identity.');
    runId = payload.run_id;
    while (!signal.aborted) {
      const response = await hermesRequest(config, `/v1/runs/${encodeURIComponent(runId)}`, boundedOptions);
      if (!response.ok) throw new ConnectorSetupError('GATEWAY_TEST_FAILED', 'Hermes test run status could not be read.');
      const result = await json(response);
      if (result.run_id !== runId) throw new ConnectorSetupError('GATEWAY_TEST_FAILED', 'Hermes returned another test run identity.');
      if (result.status === 'completed') { finished = true; return; }
      if (['failed', 'cancelled', 'interrupted'].includes(String(result.status))) {
        finished = true;
        throw new ConnectorSetupError('MODEL_NOT_READY', 'Hermes test run failed with its configured provider. Inspect hermes doctor and local Gateway diagnostics; model-provider credentials are separate from the local API Server key.');
      }
      if (!['started', 'queued', 'running', 'stopping', 'waiting_for_approval'].includes(String(result.status))) throw new ConnectorSetupError('GATEWAY_TEST_FAILED', 'Hermes test run reported an unsupported status.');
      await new Promise<void>(resolve => {
        const complete = () => { clearTimeout(timer); signal.removeEventListener('abort', complete); resolve(); };
        const timer = setTimeout(complete, limits.pollMs ?? 500);
        signal.addEventListener('abort', complete, { once: true });
        if (signal.aborted) complete();
      });
    }
    throw new ConnectorSetupError('GATEWAY_TEST_FAILED', 'Hermes test run timed out. Check model/provider availability and tool approval prompts.');
  } catch (error) {
    if (options.signal?.aborted) throw new ConnectorSetupError('SETUP_CANCELLED', 'Hermes setup was cancelled.');
    if (signal.aborted) throw new ConnectorSetupError('GATEWAY_TEST_FAILED', 'Hermes test run timed out. Check model/provider availability and tool approval prompts.');
    throw error;
  } finally {
    if (runId && !finished) {
      try { await (options.fetch ?? fetch)(`${config.apiUrl}/v1/runs/${encodeURIComponent(runId)}/stop`, {
        method: 'POST', redirect: 'error', headers: headers(config), signal: AbortSignal.timeout(5_000)
      }); } catch { /* Best effort stop has its own deadline, independent of caller cancellation. */ }
    }
  }
}

export async function checkHermesCapabilities(config: HermesConfiguration, options: AdapterOptions) {
  const response = await hermesRequest(config, '/v1/capabilities', options);
  if (!response.ok) throw new ConnectorSetupError('GATEWAY_INCOMPATIBLE', 'Hermes does not expose the required Runs API. Update Hermes on its host before enrollment.');
  const payload = await json(response);
  const features = payload.features as Record<string, unknown> | undefined;
  if (!features || ['run_submission', 'run_status', 'run_stop'].some(name => features[name] !== true)) {
    throw new ConnectorSetupError('GATEWAY_INCOMPATIBLE', 'Hermes must support run submission, status and cancellation. Update Hermes before enrollment.');
  }
}

export async function preflightHermes(config: HermesConfiguration, options: AdapterOptions) {
  await checkHermesCapabilities(config, options);
  await boundedHermesRun(config, 'Envoi connection preflight. Reply with OK only. Do not use tools or change files.', options);
}
