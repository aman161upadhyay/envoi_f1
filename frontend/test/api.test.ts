import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_CHANGED_EVENT, ApiError, api, csrfHeaders, csrfToken, expectedHumanHeaders, request, safeDownloadUrl, setCsrfCookieName, setExpectedHuman, shouldNotifySessionExpired } from '../src/api';
import { invalidateSessionRequests } from '../src/session-lifecycle';

afterEach(() => {
  vi.unstubAllGlobals();
  setExpectedHuman(null);
  setCsrfCookieName('envoi_csrf');
});

describe('human API sessions', () => {
  it('sends Phase D owner actions to the exact-address and directed-grant routes', async () => {
    setExpectedHuman('human_owner');
    vi.stubGlobal('document', { cookie: 'envoi_csrf=owner-csrf' });
    const fetchMock = vi.fn(async (_url: string | URL | Request, _options?: RequestInit) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.discoverAgentForOwner('inbox one', 'peer+test@agents.envoi-agents.com', 'agent_one');
    await api.grantRelationship('inbox one', 'agent_one', 'peer+test@agents.envoi-agents.com', ['shareAssets']);
    await api.revokeRelationship('inbox one', 'agent_one', 'agent_peer');
    await api.issueDiscoveryInvitation('inbox one', 'agent_one', 'peer+test@agents.envoi-agents.com');
    await api.revokeDiscoveryInvitation('inbox one', 'invitation_one');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/inboxes/inbox%20one/discovery?address=peer%2Btest%40agents.envoi-agents.com&actorAgentId=agent_one',
      '/api/inboxes/inbox%20one/relationships',
      '/api/inboxes/inbox%20one/relationships/agent_one/agent_peer/revoke',
      '/api/inboxes/inbox%20one/discovery-invitations',
      '/api/inboxes/inbox%20one/discovery-invitations/invitation_one/revoke'
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body))).toEqual({ actorAgentId: 'agent_one', targetAddress: 'peer+test@agents.envoi-agents.com', grants: ['shareAssets'] });
    for (const [, options] of fetchMock.mock.calls.slice(1)) {
      expect(new Headers(options.headers).get('x-envoi-csrf')).toBe('owner-csrf');
      expect(new Headers(options.headers).get('x-envoi-expected-human')).toBe('human_owner');
    }
  });
  it('uses the last same-named CSRF cookie, matching the server parser', () => {
    expect(csrfToken('envoi_csrf=older; envoi_csrf=newer')).toBe('newer');
    expect(csrfToken('envoi_csrf=valid; envoi_csrf=%ZZ')).toBe('valid');
    expect(csrfToken('envoi_csrf=%ZZ')).toBeNull();
  });

  it('restores a missing CSRF cookie and retries a rejected write once', async () => {
    const cookieDocument = { cookie: '' };
    vi.stubGlobal('document', cookieDocument);
    setExpectedHuman('human_one');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'CSRF validation failed' }), { status: 403 }))
      .mockImplementationOnce(async () => {
        cookieDocument.cookie = 'envoi_csrf=restored';
        return new Response(JSON.stringify({ id: 'human_one' }), { status: 200 });
      })
      .mockResolvedValueOnce(new Response(JSON.stringify({ saved: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(request('/api/inboxes/one/cases/two/inbox-preferences', { method: 'POST', body: JSON.stringify({ archive: true }) })).resolves.toEqual({ saved: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toBe('/api/auth/me');
    expect(new Headers(fetchMock.mock.calls[2][1].headers).get('x-envoi-csrf')).toBe('restored');
    expect(new Headers(fetchMock.mock.calls[2][1].headers).get('x-envoi-expected-human')).toBe('human_one');
  });

  it.each([['human_one', 401], ['human_other', 200]])('never replays a write after failed or changed identity recovery (%s, %s)', async (id, status) => {
    setExpectedHuman('human_one');
    vi.stubGlobal('document', { cookie: 'envoi_csrf=existing' });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'CSRF validation failed' }), { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id }), { status }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(request('/api/write', { method: 'POST', body: '{}' })).rejects.toMatchObject({ status: status === 401 ? 401 : 409 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not repeatedly retry CSRF failures or recover ordinary authorization denials', async () => {
    vi.stubGlobal('document', { cookie: 'envoi_csrf=existing' });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'CSRF validation failed' }), { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'human_one' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'CSRF validation failed' }), { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.logout()).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockReset().mockResolvedValue(new Response(JSON.stringify({ error: 'Not authorized' }), { status: 403 }));
    await expect(request('/api/write', { method: 'POST', body: '{}' })).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('finishes idempotent logout after recovery clears an expired session', async () => {
    const cookieDocument = { cookie: '' };
    vi.stubGlobal('document', cookieDocument);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'CSRF validation failed' }), { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Authenticated human session required' }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ revoked: false, logoutUrl: null }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.logout()).resolves.toEqual({ revoked: false, logoutUrl: null });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('rejects a late 401 after a caller timeout without clearing a still-valid session', async () => {
    const browserWindow = new EventTarget(); const expired = vi.fn();
    browserWindow.addEventListener('envoi:session-expired', expired); vi.stubGlobal('window', browserWindow);
    let complete!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise<Response>(resolve => { complete = resolve; })));
    const controller = new AbortController();
    const rejected = expect(api.humanView('workspace', undefined, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); complete(new Response(JSON.stringify({ error: 'Denied' }), { status: 401 }));
    await rejected; expect(expired).not.toHaveBeenCalled();
  });

  it('rejects a late successful response after logout even when fetch ignores cancellation', async () => {
    let complete!: (value: Response) => void;
    const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>(resolve => { complete = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const pending = request('/api/inboxes/private/human-view');
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    invalidateSessionRequests();
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
    complete(new Response(JSON.stringify({ private: 'old workspace' }), { status: 200 }));
    await rejected;
  });

  it('ignores late 401 responses from a previous session instead of ending a new one', async () => {
    const browserWindow = new EventTarget();
    const expired = vi.fn();
    browserWindow.addEventListener('envoi:session-expired', expired);
    vi.stubGlobal('window', browserWindow);
    let complete!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise<Response>(resolve => { complete = resolve; })));
    const pending = request('/api/auth/me');
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    invalidateSessionRequests();
    complete(new Response(JSON.stringify({ error: 'SESSION_EXPIRED' }), { status: 401 }));
    await rejected;
    expect(expired).not.toHaveBeenCalled();
  });

  it('keeps temporary provider failures recoverable and never replays a mutation', async () => {
    const browserWindow = new EventTarget();
    const expired = vi.fn();
    browserWindow.addEventListener('envoi:session-expired', expired);
    vi.stubGlobal('window', browserWindow);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'AUTH_UNAVAILABLE', message: 'Try again shortly.' }), { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(request('/api/inboxes/private/cases/1/actions', { method: 'POST', body: '{}' })).rejects.toMatchObject({ status: 503, message: 'Try again shortly.' });
    expect(expired).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses same-origin cookies and never adds a bearer credential', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'human_1' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await request('/api/auth/me');

    expect(fetchMock).toHaveBeenCalledWith('/api/auth/me', expect.objectContaining({ credentials: 'same-origin' }));
    const options = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(options.headers).has('authorization')).toBe(false);
  });

  it('does not treat verification failures as an expired authenticated session', () => {
    expect(shouldNotifySessionExpired('/api/auth/phone/verify')).toBe(false);
    expect(shouldNotifySessionExpired('/api/auth/totp/verify')).toBe(false);
    expect(shouldNotifySessionExpired('/api/inboxes/inbox_1/human-view')).toBe(true);
  });

  it('notifies the app when an authenticated workspace request returns 401', async () => {
    const browserWindow = new EventTarget();
    const expired = vi.fn();
    browserWindow.addEventListener('envoi:session-expired', expired);
    vi.stubGlobal('window', browserWindow);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'SESSION_EXPIRED' }), { status: 401 })));

    await expect(request('/api/inboxes/inbox_1/human-view')).rejects.toMatchObject({ status: 401 });
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it('adds CSRF protection to mutations without replacing explicit headers', () => {
    expect(csrfToken('theme=light; envoi_csrf=csrf%20value')).toBe('csrf value');
    expect(csrfHeaders('POST', 'envoi_csrf=csrf-token')).toEqual({ 'x-envoi-csrf': 'csrf-token' });
    expect(csrfHeaders('GET', 'envoi_csrf=csrf-token')).toEqual({});
  });

  it('uses the CSRF cookie name returned by auth configuration', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ provider: 'workos', hosted: true, csrfCookieName: 'custom_csrf' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await api.authConfig();
    expect(csrfToken('envoi_csrf=wrong; custom_csrf=right')).toBe('right');
  });

  it('shows the server message rather than its generic error code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'REQUEST_FAILED', message: 'Existing second factor must be verified before replacement' }), { status: 403 })));
    await expect(request('/api/auth/totp/setup', { method: 'POST', body: '{}' })).rejects.toMatchObject({
      message: 'Existing second factor must be verified before replacement',
      code: 'REQUEST_FAILED',
      status: 403
    } satisfies Partial<ApiError>);
  });

  it('preserves the returning-human MFA setup decision', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ human: { id: 'human_1' }, secondFactorRequired: true, mfaSetupRequired: false }), { status: 200 })));
    await expect(api.phoneVerify('challenge_1', '000000')).resolves.toMatchObject({ mfaSetupRequired: false });
  });
});

describe('agent credential controls', () => {
  it('revokes the selected agent with the human session and CSRF token', async () => {
    vi.stubGlobal('document', { cookie: 'envoi_csrf=csrf-revoke' });
    const response = { revoked: true, agentId: 'agent/1', credentialFamilyCount: 1, revokedAt: '2026-09-28T18:00:00.000Z' };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.revokeAgentCredentials('inbox one', 'agent/1')).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith('/api/inboxes/inbox%20one/agents/agent%2F1/credentials/revoke', expect.objectContaining({ method: 'POST', credentials: 'same-origin' }));
    const options = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(options.headers).get('x-envoi-csrf')).toBe('csrf-revoke');
    expect(new Headers(options.headers).has('authorization')).toBe(false);
  });

  it('sends newly approved permissions with a re-onboarding handoff', async () => {
    vi.stubGlobal('document', { cookie: 'envoi_csrf=csrf-reenroll' });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ agentId: 'agent_1', address: 'milo@agents.envoi-agents.com' }), { status: 201, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await api.reconnectAgentToken('inbox_1', 'agent_1', 'hermes', ['receive_agent_messages']);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/inboxes/inbox_1/agents/agent_1/credentials/reconnect-token');
    expect(JSON.parse(String(options.body))).toEqual({ runtime: 'hermes', permissions: ['receive_agent_messages'] });
    expect(new Headers(options.headers).get('x-envoi-csrf')).toBe('csrf-reenroll');
  });
});

describe('enforced human controls', () => {
  it('uses exact protected routes for case actions, pause, native block, and file access', async () => {
    vi.stubGlobal('document', { cookie: 'envoi_csrf=csrf-controls' });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ case: {}, action: {} }), { status: 201, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'agent/1', status: 'paused', paused: true }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ agentId: 'agent/peer', blocked: true }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ object: { id: 'asset/1' }, download: { url: '/download/once', method: 'GET' } }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await api.action('inbox one', 'case/1', 'approveOnce', { policyEvaluationId: 'policy_1' });
    await api.setAgentPaused('inbox one', 'agent/1', true);
    await api.setNativeContactBlocked('inbox one', 'agent/peer', true);
    await api.downloadAsset('inbox one', 'asset/1');

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/inboxes/inbox%20one/cases/case%2F1/actions',
      '/api/inboxes/inbox%20one/agents/agent%2F1/pause',
      '/api/inboxes/inbox%20one/contacts/agent%2Fpeer/block',
      '/api/inboxes/inbox%20one/assets/asset%2F1/download'
    ]);
    for (const [, options] of fetchMock.mock.calls.slice(0, 3)) {
      expect((options as RequestInit).method).toBe('POST');
      expect(new Headers((options as RequestInit).headers).get('x-envoi-csrf')).toBe('csrf-controls');
    }
    expect(new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers).get('idempotency-key')).toMatch(/^approveOnce-case\/1-/);
    expect((fetchMock.mock.calls[3][1] as RequestInit).method).toBeUndefined();
  });
});

describe('signed downloads', () => {
  it('allows relative, http development, and https provider URLs', () => {
    expect(safeDownloadUrl('/api/object-storage/local-download/token', 'http://127.0.0.1:8787/')).toBe('http://127.0.0.1:8787/api/object-storage/local-download/token');
    expect(safeDownloadUrl('https://storage.example/file?signature=1', 'https://app.example/')).toBe('https://storage.example/file?signature=1');
  });

  it('rejects active-content, credentialed, and downgrade URLs', () => {
    expect(safeDownloadUrl('javascript:alert(1)', 'https://app.example/')).toBeNull();
    expect(safeDownloadUrl('https://user:secret@storage.example/file', 'https://app.example/')).toBeNull();
    expect(safeDownloadUrl('http://storage.example/file', 'https://app.example/')).toBeNull();
  });
});

describe('agent connection invitations', () => {
  it('loads invitations and sends accept or decline decisions to the exact workspace routes', async () => {
    const invitation = {
      id: 'invite/1',
      fromAddress: 'sender@envoi.example',
      toAddress: 'recipient@envoi.example',
      senderAgentId: 'agent_sender',
      recipientAgentId: 'agent_recipient',
      direction: 'incoming',
      actionable: true,
      state: 'pending',
      createdAt: '2026-09-27T19:00:00.000Z',
      updatedAt: '2026-09-27T19:00:00.000Z'
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([invitation]), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ invitation: { ...invitation, state: 'accepted', conversationId: 'conversation_1' } }), { status: 201, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...invitation, state: 'declined' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const invitations = await api.invitations('inbox one');
    const accepted = await api.acceptInvitation('inbox one', 'invite/1');
    const declined = await api.declineInvitation('inbox one', 'invite/1');

    expect(invitations).toEqual([invitation]);
    expect(accepted.invitation).toMatchObject({ state: 'accepted', conversationId: 'conversation_1' });
    expect(declined).toMatchObject({ state: 'declined' });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/inboxes/inbox%20one/invitations',
      '/api/inboxes/inbox%20one/invitations/invite%2F1/accept',
      '/api/inboxes/inbox%20one/invitations/invite%2F1/decline'
    ]);
    expect(fetchMock.mock.calls.slice(1).map(([, options]) => (options as RequestInit).method)).toEqual(['POST', 'POST']);
  });
});

describe('approved external contacts', () => {
  it('approves and blocks an exact email address with cookie and CSRF protection', async () => {
    vi.stubGlobal('document', { cookie: 'envoi_csrf=csrf-contact' });
    const contact = { id: 'external_contact_123', email: 'friend@example.com', displayName: 'Friend', direction: 'both', approved: true, blocked: false, updatedAt: '2026-09-27T19:00:00.000Z' };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(contact), { status: 201, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...contact, blocked: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await api.approveExternalContact('inbox one', { email: contact.email, displayName: contact.displayName, direction: 'both' });
    await api.setExternalContactBlocked('inbox one', contact.id, true);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/inboxes/inbox%20one/external-contacts',
      '/api/inboxes/inbox%20one/external-contacts/external_contact_123/block'
    ]);
    for (const [, options] of fetchMock.mock.calls) {
      expect((options as RequestInit).method).toBe('POST');
      expect(new Headers((options as RequestInit).headers).get('x-envoi-csrf')).toBe('csrf-contact');
    }
  });
});

describe('expected account on writes', () => {
  it('names the displayed account on writes only, never on reads or auth routes', () => {
    expect(expectedHumanHeaders('POST', '/api/inboxes', 'human_a')).toEqual({ 'x-envoi-expected-human': 'human_a' });
    expect(expectedHumanHeaders('delete', '/api/inboxes/x', 'human_a')).toEqual({ 'x-envoi-expected-human': 'human_a' });
    expect(expectedHumanHeaders('GET', '/api/inboxes', 'human_a')).toEqual({});
    expect(expectedHumanHeaders('POST', '/api/auth/logout', 'human_a')).toEqual({});
    expect(expectedHumanHeaders('POST', '/api/inboxes', null)).toEqual({});
  });

  it('sends the header from request() and announces an account change reported by the server', async () => {
    const browserWindow = new EventTarget(); const changed = vi.fn();
    browserWindow.addEventListener(ACCOUNT_CHANGED_EVENT, changed); vi.stubGlobal('window', browserWindow);
    setExpectedHuman('human_a');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Changed', code: 'ACCOUNT_CHANGED' }), { status: 409 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(request('/api/inboxes', { method: 'POST', body: '{}' })).rejects.toMatchObject({ status: 409, code: 'ACCOUNT_CHANGED' });
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ 'x-envoi-expected-human': 'human_a' });
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('does not announce an ordinary 409', async () => {
    const browserWindow = new EventTarget(); const changed = vi.fn();
    browserWindow.addEventListener(ACCOUNT_CHANGED_EVENT, changed); vi.stubGlobal('window', browserWindow);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Busy', code: 'CASE_CONTROLLED' }), { status: 409 })));
    await expect(request('/api/inboxes', { method: 'POST', body: '{}' })).rejects.toMatchObject({ status: 409 });
    expect(changed).not.toHaveBeenCalled();
  });
});
