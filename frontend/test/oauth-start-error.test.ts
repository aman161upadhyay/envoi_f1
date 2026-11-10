import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { authorizationHandle, authorizationSignInPath, authorizationStartError } from '../src/onboarding/consent-state';
import { AuthorizeAgentPage } from '../src/onboarding/AuthorizeAgentPage';

describe('pre-consent OAuth errors', () => {
  it('shows fixed client guidance with no consent form or misleading expired-request text', () => {
    const search = '?error=invalid_client&error_description=DO_NOT_RENDER&code=DO_NOT_FORWARD';
    const html = renderToStaticMarkup(createElement(AuthorizeAgentPage, {
      humanId: 'owner', handle: authorizationHandle(search), startError: authorizationStartError(search),
      workspaces: [], agents: []
    }));
    expect(html).toContain('could not verify the assistant');
    expect(html).toContain('OAuth client configuration');
    expect(html).toContain('Back to workspace');
    expect(html).not.toContain('no longer available');
    expect(html).not.toContain('Approve access');
    expect(html).not.toContain('Refresh outcome');
    expect(html).not.toContain('DO_NOT_');
  });
  it('carries only one recognized error through sign-in without forwarding untrusted text or codes', () => {
    const path = authorizationSignInPath('/api/auth/workos/sign-in', '?error=invalid_client&error_description=DO_NOT_FORWARD&code=SECRET&state=SECRET');
    expect(new URL(path, 'https://www.envoi-agents.com').searchParams.get('returnTo')).toBe('/authorize-agent?error=invalid_client');
    expect(path).not.toContain('SECRET'); expect(path).not.toContain('DO_NOT_FORWARD');
    for (const search of ['?error=unknown', '?error=invalid_client&error=invalid_request', '?request=valid&error=invalid_client', '?error=__proto__']) {
      expect(authorizationStartError(search)).toBeNull();
    }
    expect(new URL(authorizationSignInPath('/api/auth/workos/sign-in', '?request=valid&error=invalid_client'), 'https://www.envoi-agents.com').searchParams.get('returnTo')).toBe('/authorize-agent?request=valid');
  });
});
