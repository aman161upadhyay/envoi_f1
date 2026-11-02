import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('runs pinned native factory and transport refusal regressions with no provider dependency',()=>{
  const script=fileURLToPath(new URL('./vendor-request-gate/test_request_gate.py',import.meta.url));
  const result=spawnSync(process.env.ENVOI_INERT_TEST_PYTHON ?? (process.platform==='win32'?'python':'python3'),[script],
    {encoding:'utf8',windowsHide:true,timeout:25000,env:{...process.env,ANTHROPIC_API_KEY:'',ANTHROPIC_AUTH_TOKEN:'',ANTHROPIC_BASE_URL:''}});
  expect({error:result.error?.message,status:result.status,output:result.stdout+result.stderr}).toMatchObject({error:undefined,status:0});
});
