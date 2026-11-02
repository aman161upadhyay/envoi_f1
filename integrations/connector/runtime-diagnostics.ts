import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { privateJson } from './store';

export type RuntimePhase = 'starting' | 'service_check' | 'runtime_check' | 'tool_verification'
  | 'ready' | 'retry_wait' | 'stopped' | 'failed';

export interface RuntimeDiagnostic {
  version: 1;
  phase: RuntimePhase;
  startedAt: string;
  updatedAt: string;
  runtimeChecks: 'pending' | 'passed' | 'deferred_while_paused';
  errorCode?: string;
  retryAt?: string;
}

const phases = new Set<RuntimePhase>(['starting', 'service_check', 'runtime_check', 'tool_verification',
  'ready', 'retry_wait', 'stopped', 'failed']);
const checks = new Set<RuntimeDiagnostic['runtimeChecks']>(['pending', 'passed', 'deferred_while_paused']);
const timestamp = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));

/** Persist only fixed fields and stable codes, never an exception message or runtime configuration. */
export async function writeRuntimeDiagnostic(directory: string, value: RuntimeDiagnostic) {
  await privateJson(path.join(directory, 'runtime-diagnostic.json'), value);
}

export async function readRuntimeDiagnostic(directory: string): Promise<RuntimeDiagnostic | null> {
  const filename = path.join(directory, 'runtime-diagnostic.json');
  const stat = await lstat(filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2048) return null;
  try {
    const value = JSON.parse(await readFile(filename, 'utf8')) as RuntimeDiagnostic;
    if (!value || value.version !== 1 || !phases.has(value.phase) || !checks.has(value.runtimeChecks)
      || !timestamp(value.startedAt) || !timestamp(value.updatedAt)
      || value.errorCode !== undefined && !/^[A-Z][A-Z0-9_]{0,119}$/.test(value.errorCode)
      || value.retryAt !== undefined && !timestamp(value.retryAt)
      || Object.keys(value).some(key => !['version', 'phase', 'startedAt', 'updatedAt', 'runtimeChecks', 'errorCode', 'retryAt'].includes(key))) return null;
    return value;
  } catch { return null; }
}
