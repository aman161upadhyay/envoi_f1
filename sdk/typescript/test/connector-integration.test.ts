import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateSync } from 'otplib';
import { newCaseId, EnvoiClient } from '@envoi/protocol';
import { enrollConnector, EnvoiConnector, type ConnectorSession, type ConnectorStore, type WorkHandler } from '@envoi/protocol/connector';
import { BrowserSession } from '../../../test/browser-session.js';

function memoryStore() {
  let value: ConnectorSession | null = null;
  const store: ConnectorStore = {
    load: async () => value,
    save: async next => { value = structuredClone(next); }
  };
  return { store, get: () => {
    if (!value) throw new Error('Agent was not enrolled');
    return value;
  } };
}

async function startServer() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'envoi-connector-'));
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: '', ENVOI_PORT: '0', ENVOI_AUTH_MODE: 'development', ENVOI_DATA_DIR: dataDir, ENVOI_AGENT_WORK_RETRY_BASE_MS: '50' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const baseUrl = await new Promise<string>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Server start timed out')), 10_000);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited with ${code}`)); });
    child.stdout?.on('data', chunk => {
      output += chunk.toString();
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
  });
  return { baseUrl, dataDir, child };
}

async function request(baseUrl: string, pathname: string, browser: BrowserSession, options: { token?: string; body?: Record<string, unknown> } = {}) {
  const method = options.body ? 'POST' : 'GET';
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(!options.token ? browser.headers(baseUrl, method) : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  browser.capture(response);
  return { status: response.status, payload: await response.json() as Record<string, any> };
}

async function owner(baseUrl: string, name: string, phoneNumber: string) {
  const browser = new BrowserSession();
  const started = await request(baseUrl, '/api/auth/phone/start', browser, { body: { displayName: name, phoneNumber } });
  expect(started.status).toBe(201);
  const verified = await request(baseUrl, '/api/auth/phone/verify', browser, { body: { challengeId: started.payload.challengeId, code: started.payload.developmentCode } });
  expect(verified.status).toBe(200);
  const setup = await request(baseUrl, '/api/auth/totp/setup', browser, { token: verified.payload.sessionToken, body: {} });
  expect(setup.status).toBe(201);
  const mfa = await request(baseUrl, '/api/auth/totp/verify', browser, { token: verified.payload.sessionToken, body: { code: generateSync({ secret: setup.payload.secret }) } });
  expect(mfa.status).toBe(200);
  const workspace = await request(baseUrl, '/api/inboxes', browser, { token: verified.payload.sessionToken, body: { name: `${name} workspace` } });
  expect(workspace.status).toBe(201);
  return { browser, humanToken: verified.payload.sessionToken as string, workspaceId: workspace.payload.id as string };
}

async function enroll(baseUrl: string, human: Awaited<ReturnType<typeof owner>>, name: string) {
  const code = await request(baseUrl, `/api/inboxes/${human.workspaceId}/agent-enrollment-tokens`, human.browser, {
    token: human.humanToken, body: { permissions: ['send_agent_messages', 'receive_agent_messages'] }
  });
  expect(code.status).toBe(201);
  const memory = memoryStore();
  await enrollConnector(baseUrl, code.payload.enrollmentToken, memory.store, { name });
  return memory;
}

async function eventually<T>(call: () => Promise<T | null>, timeoutMs = 7_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await call();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for local delivery');
}

describe('customer-hosted connector against the real local API', () => {
  const servers: Array<{ child: ChildProcess; dataDir: string }> = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise<void>(resolve => {
        if (server.child.exitCode !== null || server.child.signalCode !== null) return resolve();
        server.child.once('exit', () => resolve());
        server.child.kill('SIGTERM');
      });
      await rm(server.dataDir, { recursive: true, force: true });
    }
  });

  it('keeps identity and queued work through offline delivery and a recipient process restart', async () => {
    const server = await startServer();
    servers.push(server);
    const senderHuman = await owner(server.baseUrl, 'Connector sender owner', '+14165550141');
    const recipientHuman = await owner(server.baseUrl, 'Connector recipient owner', '+14165550142');
    const sender = await enroll(server.baseUrl, senderHuman, 'Sender agent');
    const recipient = await enroll(server.baseUrl, recipientHuman, 'Recipient agent');

    const sent = await new EnvoiClient(server.baseUrl, sender.get().agentApiToken).sendMessage(sender.get().inboxId, 'offline-message-1', {
      senderAgentId: sender.get().agentId, recipientEmail: recipient.get().address, text: 'Can we meet?'
    });
    expect(sent.id).toBeTruthy();
    await eventually(async () => {
      const messages = await request(server.baseUrl, `/api/inboxes/${recipient.get().inboxId}/messages`, recipientHuman.browser, { token: recipient.get().agentApiToken });
      return (messages.payload as any[]).find(message => message.id === sent.id && message.status === 'delivered') || null;
    });

    const processed: string[] = [];
    let processingAttempts = 0;
    const observedEvents: string[] = [];
    const identity = { agentId: recipient.get().agentId, inboxId: recipient.get().inboxId, address: recipient.get().address };
    const handler: WorkHandler = {
      admit: async message => { processed.push(`admitted:${message.id}`); },
      process: async (message, context) => {
        processingAttempts += 1;
        processed.push(`processed:${message.id}`);
        await context.reply('Yes, I can meet.', `reply:${message.id}:1`);
        if (processingAttempts === 1) throw new Error('simulated runtime crash after reply');
      }
    };
    let recipientConnector = new EnvoiConnector(server.baseUrl, recipient.store, { handler, onEvent: event => { observedEvents.push(event.id); } });
    await expect(recipientConnector.processWorkOnce()).rejects.toThrow('simulated runtime crash');
    // Recreate the process-facing connector over the saved session. The queued work
    // must be retried under the same identity, without another enrollment.
    recipientConnector = new EnvoiConnector(server.baseUrl, recipient.store, { handler, onEvent: event => { observedEvents.push(event.id); } });
    expect(recipient.get()).toMatchObject(identity);
    // Poll until the server permits the retry; scheduling can already consume the short test backoff.
    expect(await eventually(async () => await recipientConnector.processWorkOnce() || null)).toBe(true);
    expect(processed).toEqual([`admitted:${sent.id}`, `processed:${sent.id}`, `admitted:${sent.id}`, `processed:${sent.id}`]);
    const replayed = await recipientConnector.pollOnce();
    expect(replayed.count).toBeGreaterThan(0);
    expect(recipient.get().cursor).toBeTruthy();
    const observedBeforeResume = new Set(observedEvents);
    const observedCount = observedEvents.length;
    await recipientConnector.pollOnce();
    expect(observedEvents.slice(observedCount).some(id => observedBeforeResume.has(id))).toBe(false);

    const receipts = await request(server.baseUrl, `/api/inboxes/${recipient.get().inboxId}/delivery-receipts`, recipientHuman.browser, { token: recipient.get().agentApiToken });
    const matching = (receipts.payload as any[]).filter(receipt => receipt.messageId === sent.id);
    expect(matching.filter(receipt => receipt.state === 'acknowledged')).toHaveLength(1);
    expect(matching.filter(receipt => receipt.state === 'processed')).toHaveLength(1);

    await eventually(async () => {
      const messages = await request(server.baseUrl, `/api/inboxes/${sender.get().inboxId}/messages`, senderHuman.browser, { token: sender.get().agentApiToken });
      return (messages.payload as any[]).find(message => message.text === 'Yes, I can meet.' && message.status === 'delivered') || null;
    });
    const senderMessages = await request(server.baseUrl, `/api/inboxes/${sender.get().inboxId}/messages`, senderHuman.browser, { token: sender.get().agentApiToken });
    expect((senderMessages.payload as any[]).filter(message => message.text === 'Yes, I can meet.')).toHaveLength(1);
    const senderReceived: string[] = [];
    const senderConnector = new EnvoiConnector(server.baseUrl, sender.store, { handler: {
      admit: async message => { senderReceived.push(`admitted:${message.id}`); },
      process: async message => { senderReceived.push(`processed:${message.id}`); }
    } });
    expect(await senderConnector.processWorkOnce()).toBe(true);
    expect(senderReceived).toHaveLength(2);
    expect(await recipientConnector.processWorkOnce()).toBe(false);
  }, 30_000);

  it('keeps two cases between the same pair separate when the recipient connector restarts', async () => {
    const server = await startServer();
    servers.push(server);
    const senderHuman = await owner(server.baseUrl, 'Two-case sender', '+14165550151');
    const recipientHuman = await owner(server.baseUrl, 'Two-case recipient', '+14165550152');
    const sender = await enroll(server.baseUrl, senderHuman, 'Sender agent');
    const recipient = await enroll(server.baseUrl, recipientHuman, 'Recipient agent');
    const senderClient = new EnvoiClient(server.baseUrl, sender.get().agentApiToken);
    const caseIds = [newCaseId(), newCaseId()];
    const requests = await Promise.all(caseIds.map((caseId, index) => senderClient.startCase(sender.get().inboxId, `new-case-${index}`, {
      senderAgentId: sender.get().agentId, recipientEmail: recipient.get().address, caseId, text: `Question ${index + 1}`
    })));
    expect(requests[0].caseId).toBe(caseIds[0]);
    expect(requests[1].caseId).toBe(caseIds[1]);
    await eventually(async () => {
      const messages = await request(server.baseUrl, `/api/inboxes/${recipient.get().inboxId}/messages`, recipientHuman.browser, { token: recipient.get().agentApiToken });
      const delivered = (messages.payload as any[]).filter(item => requests.some(sent => sent.id === item.id && item.status === 'delivered'));
      return delivered.length === 2 ? delivered : null;
    });

    const durableReplies = new Map<string, string>();
    const processed: string[] = [];
    const handler = {
      admit: async (message: { id: string }) => { processed.push(`admit:${message.id}`); },
      process: async (message: { id: string; caseId?: string | null }, context: { reply(text: string, key: string): Promise<unknown> }) => {
        const reply = durableReplies.get(message.id) || `Reply to ${message.caseId}`;
        durableReplies.set(message.id, reply);
        await context.reply(reply, `reply:${message.id}:1`);
        processed.push(`process:${message.id}`);
      }
    };
    expect(await new EnvoiConnector(server.baseUrl, recipient.store, { handler }).processWorkOnce()).toBe(true);
    // A replacement connector instance reuses the stored session and this fixture's reply ledger.
    expect(await new EnvoiConnector(server.baseUrl, recipient.store, { handler }).processWorkOnce()).toBe(true);
    expect(durableReplies.size).toBe(2);
    expect(processed.filter(item => item.startsWith('process:'))).toHaveLength(2);

    await eventually(async () => {
      const messages = await request(server.baseUrl, `/api/inboxes/${sender.get().inboxId}/messages`, senderHuman.browser, { token: sender.get().agentApiToken });
      const replies = (messages.payload as any[]).filter(item => item.text?.startsWith('Reply to ') && item.status === 'delivered');
      return replies.length === 2 ? replies : null;
    });
    for (const caseId of caseIds) {
      const senderMessages = await senderClient.listCaseMessages(sender.get().inboxId, caseId);
      const recipientMessages = await new EnvoiClient(server.baseUrl, recipient.get().agentApiToken).listCaseMessages(recipient.get().inboxId, caseId);
      expect(senderMessages.map(item => item.caseId)).toEqual([caseId, caseId]);
      expect(recipientMessages.map(item => item.caseId)).toEqual([caseId, caseId]);
    }
  }, 30_000);
});
