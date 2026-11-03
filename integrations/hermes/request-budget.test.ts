import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nativeWorkToken, RequestBudgetLedger, requestBudgetMeter, type ModelBudgetAmendment } from './request-budget';
import { continuationAllocation,continuationRequirements } from './continuation-plan';
import { bindNativeBudget, cumulativeBudgetReport } from './request-budget-binding';

const cleanups: Array<() => Promise<unknown>> = [];
const h = (value: string) => value.repeat(64);
const seed = () => ({ actualCalls: 30, actualHermesApiCalls: 24, openClawProviderRequestsReserved: 6,
  possibleHostMessageEffects: 22, canonicalEffects: 9, caseIds: ['a','b','c','d'], newInstallationsUsed: 5,
  priorUploadedAssets: 0, stopped: true, failure: 'LIVE_ASSERTION_FAILED', unfinishedJournalHashes: ['retained'] });
const defaultFlows = [{ id: 'private', role: 'je2' as const, requests: 6, workHash: h('c') },
  { id: 'asset', role: 'testowner' as const, requests: 6, workHash: null },
  { id: 'openclaw', role: 'openclaw' as const, requests: 6, workHash: h('d') }];
async function setup(flows = defaultFlows, bind = true, amendment?:ModelBudgetAmendment) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'envoi-request-budget-'));
  cleanups.push(async () => {
    const resolved = path.resolve(directory), parent = path.resolve(os.tmpdir()) + path.sep;
    if (!resolved.startsWith(parent) || !path.basename(resolved).startsWith('envoi-request-budget-')) throw Error('TEST_CLEANUP_REFUSED');
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const filename = path.join(directory, 'requests.jsonl');
  const prior = seed(), ledger = await RequestBudgetLedger.prepare(filename, prior, flows, h('a'),amendment);
  const tokens = { je2: h('b'), testowner: h('e'), openclaw: h('f') };
  const work = { je2: nativeWorkToken(tokens.je2, ledger.window, 'je2', 'native_private'),
    testowner: nativeWorkToken(tokens.testowner, ledger.window, 'testowner', 'native_asset'),
    openclaw: nativeWorkToken(tokens.openclaw, ledger.window, 'openclaw', 'native_oc') };
  for (const f of bind ? flows : []) {
    const token = ['private','asset','openclaw'].includes(f.id) ? work[f.role] : nativeWorkToken(tokens[f.role],ledger.window,f.role,'native_'+f.id);
    await ledger.bindWork(f.id, { canonicalWorkHash: f.workHash ?? h('1'), nativeToken: token, evidenceHash: h('2') });
  }
  return { directory, filename, ledger, prior, tokens, work };
}
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });

describe('durable physical-attempt budget', () => {
  it('keeps default48 and requires explicit bounded approval before an expanded flow can be seeded',async()=>{
    await expect(setup([{id:'private',role:'je2',requests:19,workHash:h('c')}])).rejects.toThrow('FLOW_ALLOCATION_REFUSED');
    for(const amendment of [{purpose:'phase-c-decline-continuation',models:62,approvalReceiptSha256:''},
      {purpose:'other',models:62,approvalReceiptSha256:h('1')},{purpose:'phase-c-decline-continuation',models:65,approvalReceiptSha256:h('1')}])
      await expect(setup(defaultFlows,true,amendment as ModelBudgetAmendment)).rejects.toThrow('MODEL_BUDGET_APPROVAL_REQUIRED');
    expect((await setup()).ledger.modelCap).toBe(48);
  });
  it('charges all34 amended attempts and denies65 without changing other caps or historical use',async()=>{
    const proof={purpose:'phase-c-decline-continuation' as const,models:64,approvalReceiptSha256:h('7')};
    const s=await setup([{id:'private',role:'je2',requests:34,workHash:h('c')}],true,proof);
    await s.ledger.selectPhase('hermes',['private'],Date.now()+10000);
    for(let n=0;n<34;n++){const id=await s.ledger.reserve('je2',s.work.je2);await s.ledger.finish(id,'response');}
    await expect(s.ledger.reserve('je2',s.work.je2)).rejects.toThrow('MODEL_REQUEST_CAP_REACHED');
    const reopened=await RequestBudgetLedger.open(s.filename);
    expect(reopened.snapshot()).toMatchObject({chargedAttempts:64,modelCap:64,remainingModelAttempts:0,carriedMessageReservations:22,carriedNewInstallations:5});
    expect(JSON.parse((await fs.readFile(s.filename,'utf8')).split('\n')[0]).modelBudgetAmendment).toEqual(proof);
  });
  it('provides20 nominal,24 sequential and34 bounded attempts including decline resume and FIFO receipt review',()=>{
    expect(continuationRequirements()).toMatchObject({nominalBatched:20,sequential:24,contingency:10,sequentialTotalCap:54,boundedTotalCap:64,budgetApproved:false,executionAllowed:false});
    const flows=continuationAllocation('bounded-contingency');expect(flows.reduce((n,f)=>n+f.requests,0)).toBe(34);
    expect(flows.find(f=>f.id==='declined-resume')).toMatchObject({role:'testowner',requests:2});
    expect(flows.find(f=>f.id==='private-receipt-review')).toMatchObject({role:'je1',requests:2});
    expect(continuationAllocation('sequential').reduce((n,f)=>n+f.requests,0)).toBe(24);
  });
  it('binds the exact trusted canonical work through the before-submit hook and keeps one deadline',async()=>{
    const s=await setup(defaultFlows,false);const guard=bindNativeBudget({ledger:s.ledger,flowId:'asset',canonicalWorkId:'canonical_asset_work',canonicalReceiptSha256:h('3'),meterToken:s.tokens.testowner});
    const signal=new AbortController().signal;
    await expect(guard({workId:'other',sessionId:'native_asset',deadlineUnixMs:Date.now()+10000},signal)).rejects.toThrow('REVIEWED_CANONICAL_WORK_REQUIRED');
    await guard({workId:'canonical_asset_work',sessionId:'native_asset',deadlineUnixMs:Date.now()+10000},signal);
    await expect(guard({workId:'canonical_asset_work',sessionId:'native_asset',deadlineUnixMs:Date.now()+11000},signal)).rejects.toThrow('NATIVE_DEADLINE_CANNOT_RESET');
    expect(s.ledger.snapshot().chargedAttempts).toBe(30);
  });
  it('merges a current authoritative action inventory instead of reporting baselines as current',async()=>{
    const s=await setup();const current={conservativeMessages:28,canonicalEffects:12,cases:5,newInstallations:5,assets:1,inventorySha256:h('7')};
    expect(cumulativeBudgetReport(s.ledger,current)).toMatchObject({chargedAttempts:30,carriedMessageReservations:22,currentActionInventory:current});
    expect(()=>cumulativeBudgetReport(s.ledger,{...current,conservativeMessages:21})).toThrow();
  });
  it('refuses changed prefix bytes and a late previous-work request after a phase switch',async()=>{
    const s=await setup();await s.ledger.selectPhase('hermes',['private'],Date.now()+10000);
    await s.ledger.selectPhase('hermes',['asset'],Date.now()+10000);
    await expect(s.ledger.reserve('je2',s.work.je2)).rejects.toThrow('MODEL_REQUEST_CAP_REACHED');
    const raw=await fs.readFile(s.filename,'utf8');await fs.writeFile(s.filename,raw.replace('retained','modified'));
    await expect(s.ledger.reserve('testowner',s.work.testowner)).rejects.toThrow('REQUEST_LEDGER_WRITE_UNCERTAIN');
  });
  it('carries 30 calls, OC6, 22 reservations and all journals without mutating the seed', async () => {
    const s = await setup(); const original = JSON.stringify(s.prior);
    expect(s.ledger.snapshot()).toMatchObject({ chargedAttempts: 30, carriedMessageReservations: 22, carriedCanonicalEffects: 9, carriedCases: 4, carriedNewInstallations: 5, carriedAssets: 0 });
    const view = s.ledger.flows; view[0] = { ...view[0], requests: 100 };
    expect(s.ledger.flows[0].requests).toBe(6); expect(JSON.stringify(s.prior)).toBe(original);
  });
  it('charges 30 to 31 to 32 across reopen and approved new window without resetting history', async () => {
    const s = await setup(); await s.ledger.selectPhase('hermes', ['private'], Date.now()+10000);
    const first = await s.ledger.reserve('je2', s.work.je2); await s.ledger.finish(first, 'lost');
    const reopened = await RequestBudgetLedger.open(s.filename);
    await reopened.bindApprovedWindow(h('3'), { approvalReceiptHash: h('4'), allHostsStopped: true, canonicalLeasesZero: true, previousNativeTerminal: true, chargedAttempts: 31 });
    const newWorkToken = nativeWorkToken(s.tokens.openclaw,reopened.window,'openclaw','native_oc');
    await reopened.bindWork('openclaw',{canonicalWorkHash:h('d'),nativeToken:newWorkToken,evidenceHash:h('2')});
    await reopened.selectPhase('openclaw', ['openclaw'], Date.now()+10000);
    const second = await reopened.reserve('openclaw', newWorkToken); await reopened.finish(second, 'response');
    expect(reopened.snapshot()).toMatchObject({ chargedAttempts: 32, priorOpenClawCalls: 6, carriedMessageReservations: 22 });
  });
  it('refuses a fresh filename in the existing anchored accounting directory', async () => {
    const s = await setup(); const alternate = path.join(s.directory,'alternate.jsonl');
    await expect(RequestBudgetLedger.prepare(alternate, seed(), defaultFlows, h('9'))).rejects.toMatchObject({ code: 'EEXIST' });
    await expect(RequestBudgetLedger.open(alternate)).rejects.toThrow('CANONICAL_REQUEST_LEDGER_REQUIRED');
    expect((await RequestBudgetLedger.open(s.filename)).snapshot().chargedAttempts).toBe(30);
  });
  it('retains charged crash uncertainty and refuses a new meter or phase switch', async () => {
    const s = await setup(); await s.ledger.selectPhase('hermes',['private'],Date.now()+10000); await s.ledger.reserve('je2',s.work.je2);
    const reopened = await RequestBudgetLedger.open(s.filename); expect(reopened.snapshot()).toMatchObject({ chargedAttempts:31,pending:1 });
    await expect(reopened.selectPhase('openclaw',['openclaw'],Date.now()+10000)).rejects.toThrow('UNKNOWN_PROVIDER_ATTEMPT');
    await expect(requestBudgetMeter({ ledger:reopened, bindings:[{role:'je2',token:s.tokens.je2,models:['inert-model']}],signal:new AbortController().signal })).rejects.toThrow('UNKNOWN_PROVIDER_ATTEMPT');
  });
  it('does not forward after fsync failure and retains the uncertain written charge on reopen', async () => {
    const s = await setup(); await s.ledger.selectPhase('hermes',['private'],Date.now()+10000);
    const broken = await RequestBudgetLedger.open(s.filename,{syncFile:async()=>{throw Error('inert disk refusal');}});
    await expect(broken.reserve('je2',s.work.je2)).rejects.toThrow('REQUEST_LEDGER_WRITE_UNCERTAIN');
    expect((await RequestBudgetLedger.open(s.filename)).snapshot()).toMatchObject({chargedAttempts:31,pending:1});
    await expect(broken.reserve('je2',s.work.je2)).rejects.toThrow();
  });
  it('refuses partial journal tails, old seed resets, over-allocation and changed prefix bytes', async () => {
    const s=await setup(); await fs.appendFile(s.filename,'{"partial":');await expect(RequestBudgetLedger.open(s.filename)).rejects.toThrow('REQUEST_LEDGER_INCOMPLETE');
    const bad=seed();bad.openClawProviderRequestsReserved=0;
    await expect(RequestBudgetLedger.prepare(path.join(s.directory,'bad.jsonl'),bad,defaultFlows,h('a'))).rejects.toThrow('CARRIED_HISTORY_REQUIRED');
    await expect(RequestBudgetLedger.prepare(path.join(s.directory,'over.jsonl'),seed(),[{...defaultFlows[0],requests:19}],h('a'))).rejects.toThrow('FLOW_ALLOCATION_REFUSED');
  });
  it('binds exact canonical work and refuses changed or cross-flow work tokens', async()=>{
    const s=await setup(); await s.ledger.selectPhase('hermes',['private'],Date.now()+10000);
    await expect(s.ledger.reserve('je2',s.work.testowner)).rejects.toThrow('MODEL_REQUEST_CAP_REACHED');
    await expect(s.ledger.bindWork('private',{canonicalWorkHash:h('8'),nativeToken:s.work.je2,evidenceHash:h('2')})).rejects.toThrow('CANONICAL_WORK_BINDING_REQUIRED');
    await expect(s.ledger.bindWork('private',{canonicalWorkHash:h('c'),nativeToken:h('7'),evidenceHash:h('2')})).rejects.toThrow('CANONICAL_WORK_BINDING_CHANGED');
    expect(s.ledger.snapshot().chargedAttempts).toBe(30);
  });
  it('refuses ambiguous same-role active flows and never renews a native deadline', async()=>{
    const flows=[{id:'one',role:'je2' as const,requests:9,workHash:h('c')},{id:'two',role:'je2' as const,requests:9,workHash:h('d')}];
    const s=await setup(flows);
    await expect(s.ledger.selectPhase('hermes',['one','two'],Date.now()+10000)).rejects.toThrow('AMBIGUOUS_OR_UNBOUND_WORK');
    await s.ledger.selectPhase('hermes',['one'],Date.now()+10000);
    await expect(s.ledger.selectPhase('hermes',['one'],Date.now()+20000)).rejects.toThrow('NATIVE_DEADLINE_CANNOT_RESET');
  });
  it('serializes concurrent attempts and refuses request 49 before another charge', async()=>{
    const s=await setup([{id:'private',role:'je2',requests:18,workHash:h('c')}]);await s.ledger.selectPhase('hermes',['private'],Date.now()+10000);
    const results=await Promise.allSettled(Array.from({length:22},()=>s.ledger.reserve('je2',s.work.je2)));
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(18);expect(s.ledger.snapshot().chargedAttempts).toBe(48);
  });
});

describe('authenticated physical request meter with a mocked fixed HTTPS upstream',()=>{
  async function meter(options: { deadlineMs?:number; upstream?:typeof fetch;allowWork?:(role:string,token:string)=>boolean;authorizePhysical?:Parameters<typeof requestBudgetMeter>[0]['authorizePhysical'] }={}) {
    const s=await setup();await s.ledger.selectPhase('hermes',['private'],Date.now()+(options.deadlineMs??10000));const controller=new AbortController();let current=true;
    const upstream=options.upstream??vi.fn(async(url,init)=>{
      expect(url).toBe('https://api.anthropic.com/v1/messages');expect(init?.redirect).toBe('error');expect(s.ledger.snapshot().chargedAttempts).toBeGreaterThan(30);
      expect((await fs.readFile(s.filename,'utf8')).includes('"kind":"attempt"')).toBe(true);return Response.json({id:'inert'});
    });
    const server=await requestBudgetMeter({ledger:s.ledger,bindings:[{role:'je2',token:s.tokens.je2,models:['inert-model']}],active:()=>current,signal:controller.signal,fetch:upstream,allowWork:options.allowWork,authorizePhysical:options.authorizePhysical});
    cleanups.push(async()=>{controller.abort();await server.close();});
    const send=(headers:Record<string,string>={},body=JSON.stringify({model:'inert-model',messages:[]}))=>fetch(server.origin+'/v1/messages',{method:'POST',headers:{'content-type':'application/json','x-phase-c-meter':s.tokens.je2,'x-envoi-meter-role':'je2','x-envoi-meter-window':s.ledger.window,'x-envoi-meter-work':s.work.je2,...headers},body});
    return {...s,server,controller,upstream,send,stop:()=>{current=false;}};
  }
  it('authenticates and fsyncs exactly one charge before the fixed upstream sees bytes',async()=>{
    const s=await meter();expect((await s.send()).status).toBe(200);await vi.waitFor(()=>expect(s.ledger.snapshot().pending).toBe(0));expect(s.ledger.snapshot().chargedAttempts).toBe(31);expect(s.upstream).toHaveBeenCalledTimes(1);
  });
  it('consumes one actual native body commitment before exactly one durable reservation',async()=>{
    let consumed=false;const observed:any[]=[];
    const s=await meter({authorizePhysical:async(request)=>{observed.push(request);if(consumed)throw Error('NO_NATIVE_INTENT');consumed=true;
      expect(request.bodySha256).toBe(createHash('sha256').update(JSON.stringify({model:'inert-model',messages:[]})).digest('hex'));
      expect(s.ledger.snapshot().chargedAttempts).toBe(30);}});
    expect((await s.send()).status).toBe(200);await vi.waitFor(()=>expect(s.ledger.snapshot().pending).toBe(0));
    expect((await s.send()).status).toBe(503);expect(s.ledger.snapshot().chargedAttempts).toBe(31);expect(s.upstream).toHaveBeenCalledTimes(1);
    expect(observed[0]).toMatchObject({role:'je2',nativeToken:s.work.je2,window:s.ledger.window,deadlineUnixMs:s.ledger.snapshot().activeDeadline});
  });
  it('refuses headers alone or changed body bytes without any charge/upstream dispatch',async()=>{
    const commitment=createHash('sha256').update(JSON.stringify({model:'inert-model',messages:[]})).digest('hex');
    const s=await meter({authorizePhysical:async request=>{if(request.bodySha256!==commitment)throw Error('UNOBSERVED_BODY');}});
    expect((await s.send({},JSON.stringify({model:'inert-model',messages:[{role:'user',content:'changed'}]}))).status).toBe(503);
    expect(s.ledger.snapshot().chargedAttempts).toBe(30);expect(s.upstream).not.toHaveBeenCalled();
  });
  it('bounds an unresponsive native authorizer by the original control signal',async()=>{
    let arrive=()=>{};const arrived=new Promise<void>(r=>{arrive=r;});
    const s=await meter({authorizePhysical:async()=>{arrive();await new Promise(()=>{});}});
    const pending=s.send();await arrived;s.controller.abort();expect((await pending).status).toBe(503);
    expect(s.ledger.snapshot().chargedAttempts).toBe(30);expect(s.upstream).not.toHaveBeenCalled();
  });
  it('reports the same consumed ticket and exact fsynced reservation through actual response drain',async()=>{
    const events:any[]=[];const s=await meter({authorizePhysical:async()=>({onMeterEvent:event=>{events.push(event);}})});
    expect((await s.send()).status).toBe(200);await vi.waitFor(()=>expect(events.map(e=>e.phase)).toEqual(['reserved','dispatched','response']));
    expect(new Set(events.map(e=>e.reservationId)).size).toBe(1);expect(s.ledger.snapshot()).toMatchObject({chargedAttempts:31,pending:0});
  });
  it('keeps actual unknown and not-forwarded meter events distinct, with one charge each',async()=>{
    const lost:any[]=[];const s=await meter({upstream:vi.fn(async()=>{throw Error('LOST');}),authorizePhysical:async()=>({onMeterEvent:e=>{lost.push(e);}})});
    expect((await s.send()).status).toBe(503);await vi.waitFor(()=>expect(lost.map(e=>e.phase)).toEqual(['reserved','lost']));
    const stopped:any[]=[];const t=await meter({authorizePhysical:async()=>({onMeterEvent:e=>{stopped.push(e);if(e.phase==='reserved')t.stop();}})});
    expect((await t.send()).status).toBe(503);await vi.waitFor(()=>expect(stopped.map(e=>e.phase)).toEqual(['reserved','not_forwarded']));
    expect(t.upstream).not.toHaveBeenCalled();expect(s.ledger.snapshot().chargedAttempts).toBe(31);expect(t.ledger.snapshot().chargedAttempts).toBe(31);
  });
  it('never double-finishes the durable ledger if a terminal observer fails after fsync',async()=>{
    const events:string[]=[];const s=await meter({authorizePhysical:async()=>({onMeterEvent:e=>{events.push(e.phase);if(e.phase==='response')throw Error('OBSERVER_FAILED');}})});
    await(await s.send()).text();await vi.waitFor(()=>expect(events).toEqual(['reserved','dispatched','response']));
    expect(s.ledger.snapshot()).toMatchObject({chargedAttempts:31,pending:0});expect(s.upstream).toHaveBeenCalledTimes(1);
    const rows=(await fs.readFile(s.filename,'utf8')).trim().split('\n').map(s=>JSON.parse(s));expect(rows.filter(r=>r.kind==='finished')).toHaveLength(1);
  });
  it('denies a closed work fence even while another cohort flow keeps the model phase live',async()=>{
    let allowed=true;const s=await meter({allowWork:()=>allowed});
    expect((await s.send()).status).toBe(200);await vi.waitFor(()=>expect(s.ledger.snapshot().pending).toBe(0));allowed=false;
    expect((await s.send()).status).toBe(403);expect(s.ledger.snapshot().chargedAttempts).toBe(31);expect(s.upstream).toHaveBeenCalledTimes(1);
  });
  it('rejects wrong role/token/window/model and cross-work calls without forwarding',async()=>{
    const s=await meter();for(const headers of [{'x-phase-c-meter':h('9')},{'x-envoi-meter-window':h('9')},{'x-envoi-meter-role':'testowner'},{'x-envoi-meter-work':s.work.testowner}])expect((await s.send(headers)).status).toBeGreaterThanOrEqual(400);
    expect((await s.send({},'{"model":"other","messages":[]}')).status).toBe(403);expect(s.ledger.snapshot().chargedAttempts).toBe(30);expect(s.upstream).not.toHaveBeenCalled();
  });
  it('retains the charge for a lost response and requires another charge for a retry',async()=>{
    const upstream=vi.fn(async()=>{throw Error('inert lost response');});const s=await meter({upstream});
    expect((await s.send()).status).toBe(503);await vi.waitFor(()=>expect(s.ledger.snapshot().pending).toBe(0));expect((await s.send()).status).toBe(503);await vi.waitFor(()=>expect(s.ledger.snapshot().pending).toBe(0));expect(s.ledger.snapshot().chargedAttempts).toBe(32);expect(upstream).toHaveBeenCalledTimes(2);
  });
  it('aborts an in-flight upstream request at hard stop',async()=>{
    let aborted=false,arrive=()=>{};const arrived=new Promise<void>(resolve=>{arrive=resolve;});
    const s=await meter({upstream:vi.fn(async(_url,init)=>new Promise<Response>((_,reject)=>{
      init?.signal?.addEventListener('abort',()=>{aborted=true;reject(Error('inert aborted'));},{once:true});arrive();
    }))});
    const response=s.send();await arrived;
    // Advance the existing absolute deadline only after real upstream admission.
    // This tests the in-flight boundary instead of racing fixture startup time.
    vi.spyOn(Date,'now').mockReturnValue(s.ledger.snapshot().activeDeadline!+1);
    expect((await response).status).toBe(503);expect(aborted).toBe(true);expect(s.ledger.snapshot().chargedAttempts).toBe(31);
  });
  it('stops before forwarding on a host guard refusal and preserves all history',async()=>{
    const s=await meter();s.stop();expect((await s.send()).status).toBe(503);expect(s.upstream).not.toHaveBeenCalled();expect(s.ledger.snapshot().chargedAttempts).toBe(30);
  });
  it('keeps a proven not-forwarded charge separate from a provider dispatch',async()=>{
    const s=await meter();const original=s.ledger.reserve.bind(s.ledger);
    vi.spyOn(s.ledger,'reserve').mockImplementationOnce(async(...args)=>{const id=await original(...args);s.stop();return id;});
    expect((await s.send()).status).toBe(503);await vi.waitFor(()=>expect(s.ledger.snapshot().pending).toBe(0));
    expect(s.upstream).not.toHaveBeenCalled();expect(s.ledger.snapshot()).toMatchObject({chargedAttempts:31,carriedActualCalls:30,knownDispatchedRequests:0,unresolvedDispatches:0});
  });
  it('preserves original API-key and OAuth routing metadata and strips private meter headers',async()=>{
    const s=await meter();await s.send({'x-api-key':'inert-api-key','anthropic-version':'inert-version'});
    await vi.waitFor(()=>expect(s.ledger.snapshot().pending).toBe(0));
    await s.send({'authorization':'Bearer inert-oauth','x-app':'cli','user-agent':'claude-code/inert','anthropic-beta':'inert-beta'});
    await vi.waitFor(()=>expect(s.ledger.snapshot().pending).toBe(0));
    const calls=vi.mocked(s.upstream).mock.calls;const first=new Headers(calls[0][1]?.headers),second=new Headers(calls[1][1]?.headers);
    expect(first.get('x-api-key')).toBe('inert-api-key');expect(second.get('x-app')).toBe('cli');expect(second.get('authorization')).toBe('Bearer inert-oauth');expect(second.get('anthropic-beta')).toBe('inert-beta');expect(second.has('x-phase-c-meter')).toBe(false);expect(second.has('x-envoi-meter-work')).toBe(false);
  });
  it('does not let an old meter accept calls after the window hash changes',async()=>{
    const s=await meter();await s.ledger.bindApprovedWindow(h('9'),{approvalReceiptHash:h('8'),allHostsStopped:true,canonicalLeasesZero:true,previousNativeTerminal:true,chargedAttempts:30});
    expect((await s.send()).status).toBe(503);expect(s.upstream).not.toHaveBeenCalled();expect(s.ledger.snapshot().chargedAttempts).toBe(30);
  });
});
