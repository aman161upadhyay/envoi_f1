/** Private trusted-host hook; never emitted as telemetry or sent to a model. */
export type NativeSubmissionGuard = (binding: Readonly<{
  workId: string; sessionId: string; deadlineUnixMs: number;
}>, signal: AbortSignal) => Promise<void>;

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
