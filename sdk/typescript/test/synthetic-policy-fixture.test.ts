import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { EnvoiConnector, type ConnectorSession, type SyntheticPolicyFixtureInput } from '../src/connector';

const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const expected={inboxId:'inbox_test',agentId:'agent_test',installationId:'installation_test',caseId:'case_test',workId:'msg_test',proposalId:'proposal_test',optionId:'option_test'};
function approval(overrides:Record<string,unknown>={}):SyntheticPolicyFixtureInput {
  const expiresAt=new Date(Date.now()+120000).toISOString();
  const decision={purpose:'phase-c-synthetic-expiry-fixture-execution',version:1,ownerApproved:true,
    policyApprovalSha256:'c'.repeat(64),fixtureId:'a'.repeat(64),windowId:'b'.repeat(64),expected:{...expected},expiresAt,
    notAfterUtc:new Date(Date.now()+600000).toISOString(),...overrides};
  const raw=JSON.stringify(decision);
  return {fixtureId:decision.fixtureId as string,windowId:decision.windowId as string,expected:{...expected},expiresAt,
    approvalDecisionRaw:raw,approvalSha256:digest(raw)};
}
function harness(options:{expired?:boolean;timeoutMs?:number;legacy?:boolean}={}) {
  let saved:ConnectorSession={agentId:expected.agentId,inboxId:expected.inboxId,address:'synthetic@example.invalid',
    agentApiToken:'PRIVATE_ACCESS',agentRefreshToken:'PRIVATE_REFRESH',cursor:null,
    agentTokenExpiresAt:new Date(Date.now()+(options.expired?-1000:3600000)).toISOString(),
    agentRefreshTokenExpiresAt:new Date(Date.now()+86400000).toISOString()};
  const calls:{url:string;init?:RequestInit}[]=[];
  let responder:((url:string,init?:RequestInit)=>Promise<Response>)|undefined;
  const fetcher=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{
    calls.push({url:String(url),init});
    if(responder)return responder(String(url),init);
    if(String(url).endsWith('/api/agent-token'))return Response.json({agentApiToken:'PRIVATE_ROTATED',agentRefreshToken:'PRIVATE_NEXT',
      agentTokenExpiresAt:new Date(Date.now()+3600000).toISOString(),agentRefreshTokenExpiresAt:new Date(Date.now()+86400000).toISOString()});
    if(String(url).endsWith('/status'))return status();
    const body=JSON.parse(String(init?.body));
    return Response.json({id:'policy_eval_test',actor:expected.agentId,requestedAction:'proposal.accept',decision:'needsHuman',expiresAt:body.expiresAt,privateExtra:'PRIVATE_RESPONSE'},{status:201});
  });
  const store={load:async()=>saved,save:async(next:ConnectorSession)=>{saved=structuredClone(next);}};
  const connector=new EnvoiConnector('https://envoi.example',store,{fetch:fetcher as typeof fetch,timeoutMs:options.timeoutMs,
    ...(options.legacy?{}:{caseSessionHandler:{admit:async()=>{},process:async()=>{}}})});
  return {connector,calls,fetcher,get saved(){return saved;},setResponder:(fn:typeof responder)=>{responder=fn;}};
}
const status=(overrides:Record<string,unknown>={})=>Response.json({state:'active',inboxId:expected.inboxId,agent:{id:expected.agentId},installation:{id:expected.installationId},...overrides});
const posts=(h:ReturnType<typeof harness>)=>h.calls.filter(c=>c.init?.method==='POST');

describe('one-attempt owner-approved synthetic authority fixture',()=>{
  it('uses the canonical credential owner and fixed one-time route/body, returning only safe result fields',async()=>{
    const h=harness(),input=approval();
    expect(await h.connector.evaluateSyntheticPolicyFixtureOnce(input)).toEqual({id:'policy_eval_test',actor:expected.agentId,
      requestedAction:'proposal.accept',decision:'needsHuman',expiresAt:input.expiresAt});
    expect(h.calls).toHaveLength(2);
    expect(posts(h)[0].url).toBe('https://envoi.example/api/inboxes/inbox_test/cases/case_test/policy-evaluations');
    expect(JSON.parse(String(posts(h)[0].init?.body))).toEqual({requestedAction:'proposal.accept',actionPayload:{proposalId:'proposal_test',optionId:'option_test'},expiresAt:input.expiresAt,grantType:'oneTime'});
    for(const c of h.calls){expect(c.init).toMatchObject({credentials:'omit',redirect:'error'});expect(new Headers(c.init?.headers).get('authorization')).toBe('Bearer PRIVATE_ACCESS');}
    await expect(h.connector.currentAccessToken()).rejects.toMatchObject({code:'LEGACY_MODEL_ACCESS_DISABLED'});
  });
  it('performs a needed rotation through the existing saved refresh owner before the one POST',async()=>{
    const h=harness({expired:true});await h.connector.evaluateSyntheticPolicyFixtureOnce(approval());
    expect(h.calls.map(c=>new URL(c.url).pathname)).toEqual(['/api/agent-token','/api/agent/status','/api/inboxes/inbox_test/cases/case_test/policy-evaluations']);
    expect(h.saved.agentRefreshToken).toBe('PRIVATE_NEXT');
    expect(new Headers(posts(h).at(-1)?.init?.headers).get('authorization')).toBe('Bearer PRIVATE_ROTATED');
  });
  it.each([
    ['wrong purpose',{purpose:'phase-c-model-budget-approval'}],['unapproved',{ownerApproved:false}],
    ['old window',{windowId:'e'.repeat(64)}],['different subject',{expected:{...expected,workId:'msg_other'}}],
    ['extra authority',{arbitraryWrite:true}],['past expiry',{expiresAt:new Date(Date.now()-1000).toISOString()}],
    ['unbounded deadline',{notAfterUtc:new Date(Date.now()+1800000).toISOString()}],
  ])('rejects %s before any request',async(_name,change)=>{
    const h=harness(),input=approval(change);
    // Keep the caller's original work/window/expiry pins while altering its decision.
    input.windowId='b'.repeat(64);
    await expect(h.connector.evaluateSyntheticPolicyFixtureOnce(input)).rejects.toBeDefined();expect(h.calls).toHaveLength(0);
  });
  it('rejects a wrong exact-byte approval hash and any legacy connector',async()=>{
    const input=approval();input.approvalSha256='f'.repeat(64);
    const h=harness();await expect(h.connector.evaluateSyntheticPolicyFixtureOnce(input)).rejects.toMatchObject({code:'SYNTHETIC_FIXTURE_APPROVAL_REQUIRED'});expect(h.calls).toHaveLength(0);
    const legacy=harness({legacy:true});await expect(legacy.connector.evaluateSyntheticPolicyFixtureOnce(approval())).rejects.toBeDefined();expect(legacy.calls).toHaveLength(0);
  });
  it.each([{installation:{id:'installation_other'}},{agent:{id:'agent_other'}},{inboxId:'inbox_other'},{state:'paused'}])('refuses actual identity/status mismatch %j without a write',async(mismatch)=>{
    const h=harness();h.setResponder(async()=>status(mismatch));
    await expect(h.connector.evaluateSyntheticPolicyFixtureOnce(approval())).rejects.toMatchObject({code:'SYNTHETIC_FIXTURE_IDENTITY_MISMATCH'});expect(posts(h)).toHaveLength(0);
  });
  it('snapshots every caller dispatch/approval field before the digest await',async()=>{
    const h=harness(),input=approval(),expiry=input.expiresAt;
    const promise=h.connector.evaluateSyntheticPolicyFixtureOnce(input);
    input.fixtureId='d'.repeat(64);input.approvalSha256='0'.repeat(64);input.expiresAt='2099-01-01T00:00:00.000Z';input.expected.caseId='case_attacker';
    expect((await promise).expiresAt).toBe(expiry);expect(posts(h)[0].url).toContain('/cases/case_test/');
  });
  it('burns the fixture reservation atomically before any concurrent request',async()=>{
    const h=harness(),input=approval();const results=await Promise.allSettled([h.connector.evaluateSyntheticPolicyFixtureOnce(input),h.connector.evaluateSyntheticPolicyFixtureOnce(input)]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(posts(h)).toHaveLength(1);
    expect((results.find(r=>r.status==='rejected') as PromiseRejectedResult).reason.code).toBe('SYNTHETIC_FIXTURE_ALREADY_ATTEMPTED');
  });
  it.each([401,500])('does not refresh or replay a dispatched POST after HTTP %s',async(code)=>{
    const h=harness(),input=approval();h.setResponder(async(url)=>url.endsWith('/status')?status():Response.json({code:code===401?'ACCESS_TOKEN_EXPIRED':'INTERNAL_SERVER_ERROR',message:'PRIVATE_ERROR'},{status:code}));
    await expect(h.connector.evaluateSyntheticPolicyFixtureOnce(input)).rejects.not.toThrow('PRIVATE_ERROR');
    await expect(h.connector.evaluateSyntheticPolicyFixtureOnce(input)).rejects.toMatchObject({code:'SYNTHETIC_FIXTURE_ALREADY_ATTEMPTED'});
    expect(posts(h)).toHaveLength(1);expect(h.calls.some(c=>c.url.endsWith('/api/agent-token'))).toBe(false);
  });
  it('quarantines a lost response without reusing the same fixture',async()=>{
    const h=harness(),input=approval();h.setResponder(async(url)=>{if(url.endsWith('/status'))return status();throw new Error('PRIVATE_NETWORK');});
    await expect(h.connector.evaluateSyntheticPolicyFixtureOnce(input)).rejects.toMatchObject({code:'SYNTHETIC_FIXTURE_RESULT_UNKNOWN'});
    await expect(h.connector.evaluateSyntheticPolicyFixtureOnce(input)).rejects.toMatchObject({code:'SYNTHETIC_FIXTURE_ALREADY_ATTEMPTED'});expect(posts(h)).toHaveLength(1);
  });
  it('observes pause between the read and POST',async()=>{
    const h=harness();h.setResponder(async()=>{await h.connector.observeEvent({agentId:expected.agentId,type:'agent.paused'});return status();});
    await expect(h.connector.evaluateSyntheticPolicyFixtureOnce(approval())).rejects.toBeDefined();expect(posts(h)).toHaveLength(0);
  });
  it('bounds an upstream that ignores cancellation and never replays a possibly committed request',async()=>{
    const h=harness({timeoutMs:30}),input=approval();h.setResponder(async(url)=>url.endsWith('/status')?status():new Promise<Response>(()=>{}));
    await expect(h.connector.evaluateSyntheticPolicyFixtureOnce(input)).rejects.toMatchObject({code:'REQUEST_CANCELLED'});expect(posts(h)).toHaveLength(1);
    await expect(h.connector.evaluateSyntheticPolicyFixtureOnce(input)).rejects.toMatchObject({code:'SYNTHETIC_FIXTURE_ALREADY_ATTEMPTED'});
  });
  it('cancels a stalled response body within the original request timeout',async()=>{
    const h=harness({timeoutMs:30});let cancelled=false;
    h.setResponder(async(url)=>url.endsWith('/status')?status():new Response(new ReadableStream({cancel(){cancelled=true;} }),{status:201}));
    await expect(h.connector.evaluateSyntheticPolicyFixtureOnce(approval())).rejects.toMatchObject({code:'REQUEST_CANCELLED'});expect(cancelled).toBe(true);
  });
  it('rejects oversized or inconsistent results without exposing body fields',async()=>{
    for(const result of ['x'.repeat(65537),JSON.stringify({id:'policy_eval_test',actor:'agent_other'})]){
      const h=harness();h.setResponder(async(url)=>url.endsWith('/status')?status():new Response(result,{status:201}));
      await expect(h.connector.evaluateSyntheticPolicyFixtureOnce(approval())).rejects.toMatchObject({code:'SYNTHETIC_FIXTURE_RESULT_UNKNOWN'});expect(posts(h)).toHaveLength(1);
    }
  });
});
