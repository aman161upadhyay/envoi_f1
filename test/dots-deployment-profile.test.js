import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validateOnboardingDeploymentProfile} from '../scripts/check-deployment.mjs';
import {readOnboardingFlags} from '../src/onboarding-flags.js';

const config=JSON.parse(await readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
const approved={ENVOI_INSTALLATIONS_V2:'true',ENVOI_AGENT_REGISTRATION_V2:'true',ENVOI_CASE_SESSIONS_V1:'true',
  ENVOI_HTTP_WAKE_V1:'true',ENVOI_REMOTE_MCP_OAUTH:'true',ENVOI_MCP_EVENTS_V1:'true',
  ENVOI_MCP_EVENTS_CALLBACK_ORIGINS:'https://connectors.api.openai.com'};

test('the deployable beta source retains all seven owner-approved live Dots values',()=>{
  for(const [name,value]of Object.entries(approved))assert.equal(config.env.beta.vars[name],value,name);
  assert.doesNotThrow(()=>validateOnboardingDeploymentProfile(config));
});
test('deployment validation rejects each regression to the former disabled profile',()=>{
  for(const name of Object.keys(approved)){
    const candidate=structuredClone(config);
    candidate.env.beta.vars[name]=name.endsWith('ORIGINS')?'':'false';
    assert.throws(()=>validateOnboardingDeploymentProfile(candidate),assert.AssertionError,name);
  }
});
test('syncing beta does not broaden unapproved routes or change server defaults',()=>{
  const candidate=structuredClone(config);
  candidate.env.beta.vars.ENVOI_PROVIDER_CONNECTORS='true';
  assert.throws(()=>validateOnboardingDeploymentProfile(candidate),assert.AssertionError);
  const defaults=readOnboardingFlags({});
  assert.equal(defaults.registration,false);assert.equal(defaults.installations,false);
  assert.equal(Boolean(defaults.remoteMcpOAuth),false);assert.equal(Boolean(defaults.mcpEvents),false);
});
