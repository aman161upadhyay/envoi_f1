import {afterEach,describe,expect,it,vi} from 'vitest';
import {EnvoiConnector,type ConnectorSession} from '../src/connector';
import {CaseToolError} from '../src/case-tools';
import {EnvoiError} from '../src/index';

afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});

async function harness(error: unknown, scoped=true){
 vi.useFakeTimers();vi.spyOn(Math,'random').mockReturnValue(0.5);
 let saved:ConnectorSession={agentId:'agent_example',inboxId:'inbox_example',address:'example@envoi.mail',
  agentApiToken:'PRIVATE_ACCESS',agentRefreshToken:'PRIVATE_REFRESH',cursor:null,
  agentTokenExpiresAt:new Date(Date.now()+3600000).toISOString(),
  agentRefreshTokenExpiresAt:new Date(Date.now()+86400000).toISOString()};
 const controller=new AbortController();
 const transitions:string[]=[];
 const handler={admit:async()=>{},process:async()=>{}};
 const connector=new EnvoiConnector('https://envoi.example',{load:async()=>saved,save:async value=>{saved=structuredClone(value);if(value.lifecycle)transitions.push(value.lifecycle.state);}},
  {...(scoped?{caseSessionHandler:handler}:{handler}),fetch:async input=>{
   if(String(input).endsWith('/status'))return Response.json({state:'active',inboxId:saved.inboxId,agent:{id:saved.agentId},caseSessions:{available:true,version:1}});
   let closed=false;
   return new Response(new ReadableStream({start(stream){controller.signal.addEventListener('abort',()=>{if(!closed){closed=true;stream.close();}},{once:true});},cancel(){closed=true;}}),
    {headers:{'content-type':'text/event-stream'}});
  }});
 const work=vi.spyOn(connector,'processWorkOnce').mockRejectedValueOnce(error).mockResolvedValue(false);
 const running=connector.run(controller.signal);void running.catch(()=>{});
 await vi.advanceTimersByTimeAsync(0);
 return {connector,controller,running,work,transitions,session:()=>saved};
}

describe('scoped busy-tool work-loop recovery',()=>{
 it('keeps the connector alive after a deferred busy turn and retries after durable backoff',async()=>{
  const h=await harness(new CaseToolError('TOOL_BUSY',true));
  try{
   expect(h.work).toHaveBeenCalledTimes(1);
   expect(h.transitions).toContain('DEGRADED');
   // The healthy stream may already have restored RUNNING. Its success must
   // not clear the tool retry floor (750ms with the existing jitter policy).
   expect((await h.connector.lifecycle()).state).not.toBe('STOPPED');
   await vi.advanceTimersByTimeAsync(749);expect(h.work).toHaveBeenCalledTimes(1);
   await vi.advanceTimersByTimeAsync(1);expect(h.work).toHaveBeenCalledTimes(2);
   expect(h.session()).toMatchObject({agentId:'agent_example',inboxId:'inbox_example',agentApiToken:'PRIVATE_ACCESS',agentRefreshToken:'PRIVATE_REFRESH'});
   expect((await h.connector.lifecycle()).state).not.toBe('STOPPED');
  }finally{h.controller.abort();await vi.advanceTimersByTimeAsync(0);await h.running;}
  expect(vi.getTimerCount()).toBe(0);
 });
 it.each([
  ['unvalidated code',()=>new EnvoiError('Busy',undefined,'TOOL_BUSY'),true],
  ['nonretryable tool',()=>new CaseToolError('TOOL_BUSY',false),true],
  ['authority refusal',()=>new CaseToolError('AUTHORITY_DENIED',false),true],
  ['legacy handler',()=>new CaseToolError('TOOL_BUSY',true),false]
 ] as const)('does not turn %s into an automatic retry',async(_label,error,scoped)=>{
  const h=await harness(error(),scoped);
  try{
   await expect(h.running).rejects.toMatchObject({code:_label==='authority refusal'?'AUTHORITY_DENIED':'TOOL_BUSY'});
   expect(h.work).toHaveBeenCalledTimes(1);
   expect((await h.connector.lifecycle()).state).toBe('STOPPED');
  }finally{h.controller.abort();await vi.advanceTimersByTimeAsync(0);await h.running.catch(()=>{});}
  expect(vi.getTimerCount()).toBe(0);
 });
 it('cancels a deferred turn without a new claim when the owner stops the connector',async()=>{
  const h=await harness(new CaseToolError('TOOL_BUSY',true));
  h.controller.abort();await vi.advanceTimersByTimeAsync(10000);await h.running;
  expect(h.work).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
 });
});
