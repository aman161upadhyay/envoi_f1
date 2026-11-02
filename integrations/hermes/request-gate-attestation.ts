import { createHmac, timingSafeEqual } from 'node:crypto';

/** Trusted private operator expectations; never part of a model prompt or saved enrollment. */
export type NativeRequestGateExpectation = Readonly<{
  policySha256: string; moduleSha256: string; factoriesSha256: string; profileHash: string;
  window: string; role: 'je1' | 'je2' | 'testowner'; meterToken: string;
}>;
export function verifyNativeGateAttestation(value: unknown, expected: NativeRequestGateExpectation,
  instanceId: string, challenge: string) {
  const failure = () => { throw Object.assign(new Error('Required native request gate was not proven on this gateway'), { code: 'HERMES_REQUEST_GATE_NOT_PROVEN' }); };
  if (!value || typeof value !== 'object') return failure();
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || v.required !== true || v.ready !== true || !Array.isArray(v.fields) || v.fields.length !== 11
    || typeof v.mac !== 'string' || !/^[a-f0-9]{64}$/.test(v.mac)) return failure();
  const fields = v.fields;
  if (fields[0] !== 1 || fields[1] !== instanceId || fields[2] !== challenge || fields[3] !== expected.policySha256
    || fields[4] !== expected.moduleSha256 || fields[5] !== expected.factoriesSha256 || fields[6] !== expected.profileHash
    || fields[7] !== expected.window || fields[8] !== expected.role || typeof fields[9] !== 'number'
    || !Number.isSafeInteger(fields[9]) || fields[9] <= Date.now() || fields[10] !== true
    || !/^[a-f0-9]{64}$/.test(expected.meterToken)) return failure();
  const mac = createHmac('sha256', Buffer.from(expected.meterToken, 'hex')).update(JSON.stringify(fields)).digest();
  if (!timingSafeEqual(mac, Buffer.from(v.mac, 'hex'))) return failure();
  return Object.freeze({ instanceId, policySha256: expected.policySha256, moduleSha256: expected.moduleSha256,
    factoriesSha256: expected.factoriesSha256, ready: true, deadlineUnixMs: fields[9] });
}
