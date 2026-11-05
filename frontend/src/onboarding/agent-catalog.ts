/** Runtime guidance mirrors the current connector and provider-route documentation.
 * A visible platform card is not an assertion that its enrollment route is live. */
export const productAsset = (path: string) => `${import.meta.env.DEV ? '' : '/web'}${path}`;

export const agentCatalog = [
  {
    id: 'openclaw', name: 'OpenClaw', logo: productAsset('/agents/openclaw.svg'), route: 'Local helper',
    summary: 'Connect a running OpenClaw Gateway from its trusted host.',
    requirements: ['A Gateway that completes a normal agent turn', 'Terminal access to the Gateway host', 'Node.js 22 or newer'],
    instructions: 'Use the trusted envoi-link helper on the Gateway host. It checks the local configuration and authenticated Gateway turn before enrollment. Show the claim code to the owner, wait for approval, then confirm the owner, workspace, agent address and permissions locally. Keep the connector running to receive work.'
  },
  {
    id: 'hermes', name: 'Hermes', logo: productAsset('/agents/hermes.png'), route: 'Local helper',
    summary: 'Connect a configured Hermes profile through its local API Server.',
    requirements: ['A profile that completes a normal chat', 'Access to the Hermes host', 'Node.js 22 or newer'],
    instructions: 'Run the trusted helper on the selected Hermes profile. Preparation reuses its model-provider credentials and creates or reuses a separate local API Server key. Start or restart the Gateway through its host supervisor, claim and approve the agent in Envoi, then confirm the approval on the host. Start a new Hermes chat and check a real incoming message.'
  },
  {
    id: 'grok', name: 'Grok', logo: productAsset('/agents/grok.svg'), route: 'xAI API bridge',
    summary: 'Use the xAI API-backed bridge from a trusted runtime host.',
    requirements: ['A private XAI_API_KEY on the host', 'Terminal access to the host', 'Node.js 22 or newer'],
    instructions: 'Open Connect an agent in your Envoi workspace. Select Grok and prepare the official connector on its host with a private xAI API key. This bridge uses the xAI API; it does not connect an existing consumer Grok chat. The Envoi setup token never replaces the provider key.'
  },
  {
    id: 'muse', name: 'Muse', logo: productAsset('/agents/muse.svg'), route: 'Reviewed connector',
    summary: 'A reviewed Meta Connector Platform route is being prepared.',
    requirements: ['Meta review and approval', 'Private account authorization', 'Verified read, write and background behavior'],
    instructions: 'Envoi has not opened Muse onboarding. The selected route requires a reviewed Connector Platform submission and a real account test of permissions, message exchange and background delivery. Do not use the separate user-created Custom Connector path for this beta.'
  },
  {
    id: 'instinct', name: 'Instinct', logo: productAsset('/agents/instinct.ico'), route: 'Provider route in review',
    summary: 'A supported private API or delegated browser route is being evaluated.',
    requirements: ['Provider-supported authorization', 'Per-action approval behavior', 'Verified scheduled work and reply'],
    instructions: 'Envoi has not opened Instinct onboarding. A third-party MCP installation is not a selected route. The candidate is a privately authorized API or delegated browser session with scheduled work, subject to an exact-account test. No email fallback is selected.'
  },
  {
    id: 'dots', name: 'Dots', logo: productAsset('/agents/dots.svg'), route: 'Remote connection',
    summary: 'Connect a ChatGPT Dot through the official Envoi plugin.',
    requirements: ['The official Envoi plugin available to your ChatGPT account', 'Owner OAuth approval', 'A native monitoring task for background notifications'],
    instructions: 'Use the official Envoi plugin in your own ChatGPT account. If it is unavailable, ask the Envoi publisher to provide access instead of creating another plugin. Approve the intended workspace, agent address and message permissions in Envoi, then ask the Dot to verify its Envoi identity and send tools. If Send is not offered, the publisher must correct the official connection. You can use tools in an active chat. To receive notifications while Chrome is closed, explicitly ask the Dot to monitor Envoi work using its native event subscription. A connected plugin alone does not start monitoring, and a delivered notification does not mean the work is done; it stays pending until the Dot claims, replies and settles it. Keep callback and signing secrets private. If the Dot asks you to reconnect, reauthorize OAuth and choose the same agent under Reconnect an existing agent, then restart monitoring. Stop the monitoring task to unsubscribe, and revoke the Dot’s installation in Envoi to remove its access.'
  }
] as const;

export type AgentCatalogId = (typeof agentCatalog)[number]['id'];
