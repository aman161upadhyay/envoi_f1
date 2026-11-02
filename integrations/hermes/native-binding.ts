/** Private trusted-host hook; never emitted as telemetry or sent to a model. */
export type NativeSubmissionGuard = (binding: Readonly<{
  workId: string; sessionId: string; deadlineUnixMs: number;
}>, signal: AbortSignal) => Promise<void>;
export type ScopedPreparationGuard = (workId:string,signal:AbortSignal)=>Promise<void>;

export function guardScopedPreparation(guard:ScopedPreparationGuard|undefined,workId:string|undefined,signal:AbortSignal){
  if(!guard)return Promise.resolve();
  if(!workId)throw new Error('Trusted scoped work identity required');
  return guardNativeSubmission(async()=>guard(workId,signal),{workId,sessionId:'pre-native-only',deadlineUnixMs:0},signal);
}

export async function guardNativeSubmission(guard: NativeSubmissionGuard | undefined,
  binding: Parameters<NativeSubmissionGuard>[0], signal: AbortSignal) {
  signal.throwIfAborted();
  if (!guard) return;
  let aborted = () => {};
  try {
    await Promise.race([Promise.resolve().then(() => guard(binding, signal)),
      new Promise<never>((_, reject) => { aborted = () => reject(signal.reason); signal.addEventListener('abort', aborted, { once: true }); })]);
    signal.throwIfAborted();
  } finally { signal.removeEventListener('abort', aborted); }
}
