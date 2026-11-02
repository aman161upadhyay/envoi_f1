import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyNativeGateAttestation } from './request-gate-attestation';

const expected = { policySha256:'a'.repeat(64), moduleSha256:'b'.repeat(64), factoriesSha256:'c'.repeat(64),
  profileHash:'d'.repeat(64), window:'e'.repeat(64), role:'je1' as const, meterToken:'f'.repeat(64) };
function proof(fields: unknown[] = [1,'instance','1'.repeat(32),expected.policySha256,expected.moduleSha256,
  expected.factoriesSha256,expected.profileHash,expected.window,expected.role,Date.now()+60000,true]) {
  return {version:1,required:true,ready:true,fields,mac:createHmac('sha256',Buffer.from(expected.meterToken,'hex')).update(JSON.stringify(fields)).digest('hex')};
}
describe('same loaded gateway request-gate proof',()=>{
  it('accepts a current process, policy, source, profile and fresh challenge',()=>{
    expect(verifyNativeGateAttestation(proof(),expected,'instance','1'.repeat(32))).toMatchObject({ready:true,instanceId:'instance'});
  });
  it.each([0,1,2,3,4,5,6,7,8,9,10])('denies signed but mismatching binding field %s',index=>{
    const p=proof(); p.fields[index]=index===9?Date.now()-1:index===10?false:'foreign';
    expect(()=>verifyNativeGateAttestation(proof(p.fields),expected,'instance','1'.repeat(32))).toThrow();
  });
  it('denies old/unarmed runtime and missing, replayed or tampered proof',()=>{
    for(const p of [undefined,{}, {version:1,required:false,ready:false}, {...proof(),mac:'0'.repeat(64)}])
      expect(()=>verifyNativeGateAttestation(p,expected,'instance','1'.repeat(32))).toThrow();
    expect(()=>verifyNativeGateAttestation(proof(),expected,'replacement-instance','1'.repeat(32))).toThrow();
    expect(()=>verifyNativeGateAttestation(proof(),expected,'instance','2'.repeat(32))).toThrow();
  });
});
