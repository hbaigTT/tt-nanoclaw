/**
 * Integration tests — verify the pipeline components work together.
 *
 * These tests wire up real components (HTTP server, SQLite, GroupQueue)
 * with a mocked agent runner to verify the end-to-end flow without
 * calling the real Claude API or Slack.
 */
import http from 'http';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  _initTestDatabase,
  getAllRegisteredGroups,
  getMessagesSince,
  getNewMessages,
  setRegisteredGroup,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { AlertmanagerChannel } from './channels/alertmanager/index.js';
import { GroupQueue } from './group-queue.js';
import { formatMessages, findChannel } from './router.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import fixturePayload from '../test/fixtures/etcd-fragmentation-alert.json' with { type: 'json' };

// Mock config — tests need controlled values
vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  POLL_INTERVAL: 100,
  TIMEZONE: 'UTC',
  TRIGGER_PATTERN: /^@Andy\b/i,
  WEBHOOK_PORT: 0,
  AGENT_TIMEOUT: 30000,
  MAX_CONCURRENT_CONTAINERS: 5,
  STORE_DIR: '/tmp/tt-nanoclaw-test/store',
  GROUPS_DIR: '/tmp/tt-nanoclaw-test/groups',
  DATA_DIR: '/tmp/tt-nanoclaw-test/data',
  ALERT_GROUPS: {
    etcdDatabaseHighFragmentationRatio: {
      folder: 'alerts',
      name: 'etcd-fragmentation',
    },
  },
}));

// --- Helpers ---

const mockSlackSend = vi.fn().mockResolvedValue(undefined);

function getPort(channel: AlertmanagerChannel): number {
  const addr = (channel as unknown as { server: http.Server }).server.address();
  return typeof addr === 'object' && addr ? addr.port : 0;
}

async function postJson(
  port: number,
  path: string,
  body: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let responseBody = '';
        res.on('data', (chunk: Buffer) => (responseBody += chunk.toString()));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: responseBody }),
        );
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// -------------------------------------------------------------------
// Test 1: Webhook → SQLite roundtrip
// -------------------------------------------------------------------

describe('integration: webhook → DB roundtrip', () => {
  let channel: AlertmanagerChannel;
  let storedMessages: NewMessage[];

  beforeEach(async () => {
    _initTestDatabase();
    storedMessages = [];
    mockSlackSend.mockClear();

    channel = new AlertmanagerChannel(
      {
        onMessage: (_jid: string, msg: NewMessage) => {
          storedMessages.push(msg);
          storeMessage(msg);
          storeChatMetadata(
            msg.chat_jid,
            msg.timestamp,
            undefined,
            'alertmanager',
            true,
          );
        },
        onChatMetadata: (jid, ts, name, ch, isGroup) =>
          storeChatMetadata(jid, ts, name, ch, isGroup),
        registeredGroups: () => ({}),
      },
      'https://hooks.slack.com/test',
      0, // OS-assigned port
      mockSlackSend,
    );
    await channel.connect();
  });

  afterEach(async () => {
    await channel.disconnect();
  });

  it('stores the alert as a NewMessage retrievable by getNewMessages', async () => {
    const port = getPort(channel);
    const res = await postJson(port, '/webhook/alertmanager', fixturePayload);
    expect(res.status).toBe(200);

    // Verify the message was stored
    expect(storedMessages).toHaveLength(1);
    const msg = storedMessages[0];
    expect(msg.chat_jid).toBe(
      'alertmanager:etcdDatabaseHighFragmentationRatio',
    );
    expect(msg.sender).toBe('alertmanager');
    expect(msg.content).toContain('ALERT FIRING');
    expect(msg.content).toContain('etcd-f06cs15');
    expect(msg.content).toContain('etcd-f11-ci-infra-01');
    expect(msg.content).toContain('etcd-f11-ci-infra-02');

    // Verify SQLite retrieval works for this JID
    const jid = 'alertmanager:etcdDatabaseHighFragmentationRatio';
    const { messages } = getNewMessages([jid], '', 'Andy');
    expect(messages).toHaveLength(1);
    expect(messages[0].chat_jid).toBe(jid);
    expect(messages[0].content).toContain('ALERT FIRING');
  });

  it('deduplicates repeated webhook deliveries', async () => {
    const port = getPort(channel);

    await postJson(port, '/webhook/alertmanager', fixturePayload);
    await postJson(port, '/webhook/alertmanager', fixturePayload);

    // Same fingerprints → only 1 message stored
    expect(storedMessages).toHaveLength(1);
  });
});

// -------------------------------------------------------------------
// Test 2: Full pipeline — webhook → queue → agent → sendMessage
// -------------------------------------------------------------------

describe('integration: webhook → queue → agent → sendMessage', () => {
  let channel: AlertmanagerChannel;
  let queue: GroupQueue;
  let agentCalls: Array<{
    prompt: string;
    groupFolder: string;
    chatJid: string;
  }>;
  let slackMessages: string[];
  const registeredGroups: Record<string, RegisteredGroup> = {};

  beforeEach(async () => {
    _initTestDatabase();
    agentCalls = [];
    slackMessages = [];
    mockSlackSend.mockClear();
    mockSlackSend.mockImplementation(async (_url: string, text: string) => {
      slackMessages.push(text);
    });

    // Register the alert group
    const jid = 'alertmanager:etcdDatabaseHighFragmentationRatio';
    registeredGroups[jid] = {
      name: 'etcd-fragmentation',
      folder: 'alerts',
      trigger: '',
      added_at: new Date().toISOString(),
      requiresTrigger: false,
    };
    setRegisteredGroup(jid, registeredGroups[jid]);

    // Set up queue with a processing function that mimics processGroupMessages
    queue = new GroupQueue();
    queue.setProcessMessagesFn(async (chatJid: string): Promise<boolean> => {
      const group = registeredGroups[chatJid];
      if (!group) return true;

      const messages = getMessagesSince(chatJid, '', 'Andy');
      if (messages.length === 0) return true;

      const prompt = formatMessages(messages, 'UTC');

      // Record the agent call (instead of calling real agent SDK)
      agentCalls.push({ prompt, groupFolder: group.folder, chatJid });

      // Simulate agent returning a success result
      const agentResult =
        'RESOLVED: etcdDatabaseHighFragmentationRatio\n\nDefragmentation completed successfully.';
      await channel.sendMessage(chatJid, agentResult);

      return true;
    });

    // Create channel wired to store messages and trigger queue
    channel = new AlertmanagerChannel(
      {
        onMessage: (_jid: string, msg: NewMessage) => {
          storeMessage(msg);
          // Trigger queue processing (replaces the message loop's role)
          queue.enqueueMessageCheck(msg.chat_jid);
        },
        onChatMetadata: (jid, ts, name, ch, isGroup) =>
          storeChatMetadata(jid, ts, name, ch, isGroup),
        registeredGroups: () => registeredGroups,
      },
      'https://hooks.slack.com/test',
      0,
      mockSlackSend,
    );
    await channel.connect();
  });

  afterEach(async () => {
    await queue.shutdown(1000);
    await channel.disconnect();
  });

  it('processes an alert end-to-end: webhook → agent → slack', async () => {
    const port = getPort(channel);

    // POST the alert webhook
    const res = await postJson(port, '/webhook/alertmanager', fixturePayload);
    expect(res.status).toBe(200);

    // Wait for async queue processing to complete
    await vi.waitFor(
      () => {
        expect(agentCalls).toHaveLength(1);
      },
      { timeout: 2000 },
    );

    // Verify the agent was called with the right group and JID
    expect(agentCalls[0].groupFolder).toBe('alerts');
    expect(agentCalls[0].chatJid).toBe(
      'alertmanager:etcdDatabaseHighFragmentationRatio',
    );

    // Verify the prompt contains the alert details
    expect(agentCalls[0].prompt).toContain('etcd-f06cs15');

    // Verify the agent's output was sent to Slack
    expect(slackMessages).toHaveLength(1);
    expect(slackMessages[0]).toContain('RESOLVED');
    expect(slackMessages[0]).toContain('etcdDatabaseHighFragmentationRatio');
  });

  it('handles concurrent alerts for different alertnames', async () => {
    const port = getPort(channel);

    // Register a second alert group
    const secondJid = 'alertmanager:KubeProxyDown';
    registeredGroups[secondJid] = {
      name: 'kube-proxy-down',
      folder: 'alerts',
      trigger: '',
      added_at: new Date().toISOString(),
      requiresTrigger: false,
    };
    setRegisteredGroup(secondJid, registeredGroups[secondJid]);

    // Send two different alerts
    const secondPayload = {
      ...fixturePayload,
      groupKey: 'different-group',
      alerts: [
        {
          status: 'firing' as const,
          labels: {
            alertname: 'KubeProxyDown',
            severity: 'critical',
            namespace: 'kube-system',
          },
          annotations: { summary: 'KubeProxy is down' },
          startsAt: '2026-03-16T10:00:00.000Z',
          endsAt: '0001-01-01T00:00:00Z',
          generatorURL: 'http://prometheus/graph',
          fingerprint: 'fp-kubeproxy-001',
        },
      ],
    };

    await postJson(port, '/webhook/alertmanager', fixturePayload);
    await postJson(port, '/webhook/alertmanager', secondPayload);

    await vi.waitFor(
      () => {
        expect(agentCalls).toHaveLength(2);
      },
      { timeout: 3000 },
    );

    const jids = agentCalls.map((c) => c.chatJid).sort();
    expect(jids).toEqual([
      'alertmanager:KubeProxyDown',
      'alertmanager:etcdDatabaseHighFragmentationRatio',
    ]);
  });
});

// -------------------------------------------------------------------
// Test 3: Alert group auto-registration
// -------------------------------------------------------------------

describe('integration: alert group auto-registration', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('ALERT_GROUPS config produces correct registered groups', async () => {
    // Simulate what main() does: iterate ALERT_GROUPS and register
    const { ALERT_GROUPS } = await import('./config.js');

    for (const [alertname, { folder, name }] of Object.entries(ALERT_GROUPS)) {
      const jid = `alertmanager:${alertname}`;
      setRegisteredGroup(jid, {
        name,
        folder,
        trigger: '',
        added_at: new Date().toISOString(),
        requiresTrigger: false,
      });
    }

    const groups = getAllRegisteredGroups();
    const jid = 'alertmanager:etcdDatabaseHighFragmentationRatio';
    expect(groups[jid]).toBeDefined();
    expect(groups[jid].folder).toBe('alerts');
    expect(groups[jid].name).toBe('etcd-fragmentation');
    expect(groups[jid].requiresTrigger).toBe(false);
  });
});
