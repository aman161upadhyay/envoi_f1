// agent-registration v1 §1: server-only Phase B flags, default off. Clients never read them;
// they read GET /api/onboarding/routes, built here from the same flags. case-session v1 §1 adds
// the Phase C sessions flag, which clients learn about from GET /api/agent/status. http-wake v1
// adds the HTTPS wake flag, which clients learn about from the same status route. agent-remote-auth
// v1 §1 adds the two remote route flags, which change only the routes body and their own endpoints.
export const onboardingFlagNames = ['ENVOI_INSTALLATIONS_V2', 'ENVOI_AGENT_REGISTRATION_V2', 'ENVOI_AUTHENTICATED_REST_ROUTE', 'ENVOI_CASE_SESSIONS_V1', 'ENVOI_HTTP_WAKE_V1', 'ENVOI_PROVIDER_BROWSER_POLL', 'ENVOI_REMOTE_MCP_OAUTH', 'ENVOI_PROVIDER_CONNECTORS', 'ENVOI_MCP_WAKE_V1', 'ENVOI_MCP_EVENTS_V1', 'ENVOI_GROK_TRIGGER_V1', 'ENVOI_PROVIDER_GATEWAY_NATIVE_V1', 'ENVOI_RELATIONSHIPS_V2', 'ENVOI_A2A_GATEWAY'];
// Internal capability, never accepted from a registration or activation HTTP body.
export const providerGatewayAuthority = Symbol('provider-browser-poll');
export const browserPollAvailable = flags => Boolean(flags.providerBrowserPoll && flags.registration && flags.installations && flags.authenticatedRest);
// Schema enum order, which the routes response must follow.
export const connectionRoutes = ['local_helper', 'remote_mcp_oauth', 'provider_connector', 'authenticated_rest'];
export const deliveryModes = ['envoi_link', 'webhook', 'provider', 'poll', 'on_demand', 'a2a'];

// Only the exact string "true" turns a flag on. Any other value set is refused, so a typo cannot
// look enabled to an operator while the server keeps it off.
export function onboardingFlagErrors(env = process.env) {
  const errors = [];
  for (const name of onboardingFlagNames) {
    if (env[name] !== undefined && env[name] !== '' && !['true', 'false'].includes(env[name])) errors.push(`${name} must be true or false`);
  }
  if (env.ENVOI_AGENT_REGISTRATION_V2 === 'true' && env.ENVOI_INSTALLATIONS_V2 !== 'true') errors.push('ENVOI_AGENT_REGISTRATION_V2 requires ENVOI_INSTALLATIONS_V2');
  // A session binds an installation.
  if (env.ENVOI_CASE_SESSIONS_V1 === 'true' && env.ENVOI_INSTALLATIONS_V2 !== 'true') errors.push('ENVOI_CASE_SESSIONS_V1 requires ENVOI_INSTALLATIONS_V2');
  // A wake subscription belongs to an installation.
  if (env.ENVOI_HTTP_WAKE_V1 === 'true' && env.ENVOI_INSTALLATIONS_V2 !== 'true') errors.push('ENVOI_HTTP_WAKE_V1 requires ENVOI_INSTALLATIONS_V2');
  if (env.ENVOI_PROVIDER_BROWSER_POLL === 'true' && ['ENVOI_INSTALLATIONS_V2', 'ENVOI_AGENT_REGISTRATION_V2', 'ENVOI_AUTHENTICATED_REST_ROUTE'].some(name => env[name] !== 'true')) errors.push('ENVOI_PROVIDER_BROWSER_POLL requires installation, registration and authenticated REST flags');
  if (env.ENVOI_RELATIONSHIPS_V2 === 'true' && env.ENVOI_INSTALLATIONS_V2 !== 'true') errors.push('ENVOI_RELATIONSHIPS_V2 requires ENVOI_INSTALLATIONS_V2');
  // agent-remote-auth §1, §2: both V2 flags, and an issuer built from ENVOI_PUBLIC_URL, never from Host.
  for (const name of ['ENVOI_REMOTE_MCP_OAUTH', 'ENVOI_PROVIDER_CONNECTORS']) {
    if (env[name] !== 'true') continue;
    if (env.ENVOI_AGENT_REGISTRATION_V2 !== 'true' || env.ENVOI_INSTALLATIONS_V2 !== 'true') errors.push(`${name} requires ENVOI_AGENT_REGISTRATION_V2 and ENVOI_INSTALLATIONS_V2`);
    if (!issuerOrigin(env.ENVOI_PUBLIC_URL)) errors.push(`${name} requires ENVOI_PUBLIC_URL to be an https origin (or http on 127.0.0.1 or [::1] for local tests)`);
  }
  if (env.ENVOI_A2A_GATEWAY === 'true' && (env.ENVOI_RELATIONSHIPS_V2 !== 'true' || env.ENVOI_INSTALLATIONS_V2 !== 'true')) errors.push('ENVOI_A2A_GATEWAY requires ENVOI_RELATIONSHIPS_V2 and ENVOI_INSTALLATIONS_V2');
  if (env.ENVOI_A2A_GATEWAY === 'true' && !issuerOrigin(env.ENVOI_PUBLIC_URL)) errors.push('ENVOI_A2A_GATEWAY requires ENVOI_PUBLIC_URL to be an https origin (or http on 127.0.0.1 or [::1] for local tests)');
  const dependencies = {
    ENVOI_MCP_WAKE_V1: ['ENVOI_HTTP_WAKE_V1', 'ENVOI_INSTALLATIONS_V2', 'ENVOI_AGENT_REGISTRATION_V2', 'ENVOI_PROVIDER_CONNECTORS'],
    ENVOI_MCP_EVENTS_V1: ['ENVOI_HTTP_WAKE_V1', 'ENVOI_INSTALLATIONS_V2', 'ENVOI_AGENT_REGISTRATION_V2'],
    ENVOI_GROK_TRIGGER_V1: ['ENVOI_HTTP_WAKE_V1', 'ENVOI_INSTALLATIONS_V2', 'ENVOI_AGENT_REGISTRATION_V2'],
    ENVOI_PROVIDER_GATEWAY_NATIVE_V1: ['ENVOI_PROVIDER_BROWSER_POLL', 'ENVOI_CASE_SESSIONS_V1', 'ENVOI_INSTALLATIONS_V2', 'ENVOI_AGENT_REGISTRATION_V2']
  };
  for (const [name, requires] of Object.entries(dependencies)) {
    if (env[name] !== 'true') continue;
    for (const required of requires) if (env[required] !== 'true') errors.push(`${name} requires ${required}`);
  }
  if (env.ENVOI_MCP_EVENTS_V1 === 'true' && env.ENVOI_REMOTE_MCP_OAUTH !== 'true' && env.ENVOI_PROVIDER_CONNECTORS !== 'true') errors.push('ENVOI_MCP_EVENTS_V1 requires ENVOI_REMOTE_MCP_OAUTH or ENVOI_PROVIDER_CONNECTORS');
  return errors;
}

function issuerOrigin(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) return null;
  if (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) return url.origin;
  return null;
}

// Fails closed at startup in every mode.
export function readOnboardingFlags(env = process.env) {
  const errors = onboardingFlagErrors(env);
  if (errors.length) throw new Error(`Invalid onboarding flags:\n- ${errors.join('\n- ')}`);
  return {
    installations: env.ENVOI_INSTALLATIONS_V2 === 'true',
    registration: env.ENVOI_AGENT_REGISTRATION_V2 === 'true',
    authenticatedRest: env.ENVOI_AUTHENTICATED_REST_ROUTE === 'true',
    caseSessions: env.ENVOI_CASE_SESSIONS_V1 === 'true',
    httpWake: env.ENVOI_HTTP_WAKE_V1 === 'true',
    ...(env.ENVOI_PROVIDER_BROWSER_POLL === 'true' ? { providerBrowserPoll: true } : {}),
    ...(env.ENVOI_REMOTE_MCP_OAUTH === 'true' ? { remoteMcpOAuth: true } : {}),
    ...(env.ENVOI_PROVIDER_CONNECTORS === 'true' ? { providerConnectors: true } : {}),
    ...(env.ENVOI_MCP_WAKE_V1 === 'true' ? { mcpWake: true } : {}),
    ...(env.ENVOI_MCP_EVENTS_V1 === 'true' ? { mcpEvents: true } : {}),
    ...(env.ENVOI_GROK_TRIGGER_V1 === 'true' ? { grokTrigger: true } : {}),
    ...(env.ENVOI_PROVIDER_GATEWAY_NATIVE_V1 === 'true' ? { providerGatewayNative: true } : {}),
    ...(env.ENVOI_RELATIONSHIPS_V2 === 'true' ? { relationships: true } : {}),
    ...(env.ENVOI_A2A_GATEWAY === 'true' ? { a2aGateway: true } : {})
  };
}

// The public registration and activation routes. They never offer the agent-remote-auth routes or
// on_demand, whatever the flags (agent-registration §14.0, agent-remote-auth §11).
export const routeAvailable = (flags, route) => flags.registration && flags.installations && (route === 'local_helper' || (route === 'authenticated_rest' && flags.authenticatedRest));
export const deliveryModeAvailable = (flags, mode) => flags.registration && flags.installations && mode === 'envoi_link';
// agent-remote-auth §1: available through that contract's own flow (consent or a bootstrap code).
export const remoteRouteAvailable = (flags, route) => Boolean(flags.registration && flags.installations
  && ((route === 'remote_mcp_oauth' && flags.remoteMcpOAuth) || (route === 'provider_connector' && flags.providerConnectors)));
const remoteModeAvailable = (flags, mode) => mode === 'on_demand' && (remoteRouteAvailable(flags, 'remote_mcp_oauth') || remoteRouteAvailable(flags, 'provider_connector'));

export function routeAvailability(flags, asOf = new Date().toISOString()) {
  return {
    asOf,
    contract: { id: 'agent-registration', version: 1 },
    registrationEnabled: flags.registration,
    installationsEnabled: flags.installations,
    routes: connectionRoutes.map(connectionRoute => ({ connectionRoute, available: routeAvailable(flags, connectionRoute) || remoteRouteAvailable(flags, connectionRoute) })),
    deliveryModes: deliveryModes.map(deliveryMode => ({ deliveryMode, available: deliveryModeAvailable(flags, deliveryMode) || remoteModeAvailable(flags, deliveryMode) }))
  };
}
