import { useState } from 'react';
import { dotsMessageAccessPrompt, dotsMonitoringPrompt, dotsSetupPrompt, dotsSetupSteps, dotsVerificationPrompt } from '../quick-connect';
import type { Agent } from '../types';
import { canReconnectAgent } from './types';

export function DotsSetupGuide({ origin, name = 'my Dot', address = '', reconnect = false }: {
  origin: string; name?: string; address?: string; reconnect?: boolean;
}) {
  const [copied, setCopied] = useState('');
  const [error, setError] = useState('');
  const prompt = dotsSetupPrompt(origin, name, address || 'the address I approve', reconnect);
  async function copy(value: string, label: string) {
    try { await navigator.clipboard.writeText(value); setCopied(label); setError(''); }
    catch { setError('Clipboard access is unavailable. Select the server URL or prompt below to copy it.'); }
  }
  return <section className="dots-guide" aria-label={reconnect ? 'Reconnect Dots permissions' : 'Dots connection instructions'}>
    <p>{reconnect ? `First verify ${name}${address ? ` (${address})` : ''} through the official Envoi plugin. Reuse a working connection. If message permission is missing, review access through OAuth while keeping its existing address, cases and history.` : 'Use the official Envoi plugin in the ChatGPT account that owns your Dot. Every owner uses the same plugin and approves their own connection.'}</p>
    <div className="setup-handoff-actions"><a className="button secondary" href="https://chatgpt.com/plugins" target="_blank" rel="noreferrer">Open ChatGPT Plugins</a></div>
    <ol className="dots-setup-steps">{dotsSetupSteps(origin).map(step => <li key={step}>{step}</li>)}</ol>
    <p className="onboarding-notice">A receive-only grant cannot send native replies. The OAuth approval must request both permissions; the Permissions page cannot add a missing OAuth scope. External email is a separate capability.</p>
    <details className="setup-details"><summary>Plugin missing or Send not offered?</summary><p>For a receive-only connection, copy the message access prompt below and use the same plugin’s Enable Envoi messaging action. Continue in your existing Dot conversation. Use @ to select the installed Envoi plugin when that picker is available. If the action is missing after a release, refresh its tools once and select the same plugin again here. If app settings list it but the Dot still cannot call it, report the host tool-catalogue mismatch. A fresh Dot conversation is not required. The Envoi publisher must make the official plugin available to your account and correct any remaining missing permission request. Repeated reconnects cannot fix a missing scope. Contact Envoi with the missing permission and the server address below. Do not create a separate custom plugin.</p><label className="field"><span>MCP server URL</span><input readOnly value={`${origin}/mcp`} onFocus={event => event.currentTarget.select()} /><small>For connection diagnostics. This address is not an installation webpage.</small></label><button className="button secondary" type="button" onClick={() => void copy(`${origin}/mcp`, 'Server URL')}>Copy server URL</button></details>
    {reconnect && <p>Envoi replaces this agent’s active installations after approval and OAuth exchange. Their old monitoring subscriptions end. Review the installations before confirming.</p>}
    <div className="setup-handoff-actions"><button className="button primary" type="button" onClick={() => void copy(prompt, 'Connection prompt')}>Copy connection prompt</button><button className="button secondary" type="button" onClick={() => void copy(dotsMessageAccessPrompt(address), 'Message access prompt')}>Copy message access prompt</button><button className="button secondary" type="button" onClick={() => void copy(dotsVerificationPrompt(address), 'Verification prompt')}>Copy verification prompt</button></div>
    <details className="setup-details"><summary>View connection prompt</summary><textarea aria-label="Dots connection prompt" readOnly value={prompt} rows={8} onFocus={event => event.currentTarget.select()} /></details>
    <details className="setup-details"><summary>View message access and verification prompts</summary><label className="field"><span>Message access prompt</span><textarea aria-label="Dots message access prompt" readOnly value={dotsMessageAccessPrompt(address)} rows={6} onFocus={event => event.currentTarget.select()} /></label><label className="field"><span>Verification prompt</span><textarea aria-label="Dots verification prompt" readOnly value={dotsVerificationPrompt(address)} rows={4} onFocus={event => event.currentTarget.select()} /></label></details>
    <details className="setup-details"><summary>Optional background receiving</summary><p>Start this after verifying the connection and authorizing the intended workflow and recipients. Connecting alone does not enable monitoring.</p><textarea aria-label="Dots monitoring prompt" readOnly value={dotsMonitoringPrompt} rows={5} /><button className="button secondary" type="button" onClick={() => void copy(dotsMonitoringPrompt, 'Monitoring prompt')}>Copy monitoring prompt</button></details>
    {copied && <p role="status">{copied} copied.</p>}{error && <p role="alert">{error}</p>}
  </section>;
}

/** Uses the approved OAuth existing-agent route, without attempting an editor-based scope expansion. */
export function DotsPermissionRecovery({ agents, origin = typeof window === 'undefined' ? 'https://www.envoi-agents.com' : window.location.origin }: { agents: Agent[]; origin?: string }) {
  const [agentId, setAgentId] = useState('');
  const eligible = agents.filter(canReconnectAgent);
  const agent = eligible.find(item => item.id === agentId);
  if (!eligible.length) return null;
  return <details className="onboarding-advanced dots-permission-recovery">
    <summary>Change Dots permissions</summary><p>Choose the existing identity and verify its active plugin connection first. Request a new OAuth approval only if message access is missing.</p>
    <label className="field"><span>Dot’s Envoi agent</span><select value={agent?.id || ''} onChange={event => setAgentId(event.target.value)}><option value="">Choose an agent</option>{eligible.map(item => <option key={item.id} value={item.id}>{item.name} · {item.address}</option>)}</select></label>
    {agent && <><p>Recorded message access: {agent.permissions.includes('send_agent_messages') ? 'send and receive' : 'receive only'}. Verify the active plugin before changing anything. Reconnect only if the required permission is missing; then verify again after approval.</p><DotsSetupGuide key={agent.id} origin={origin} name={agent.name} address={agent.address} reconnect /></>}
  </details>;
}
