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
import { formatMessages } from './router.js';
import { NewMessage, RegisteredGroup } from './types.js';
import crashloopPayload from '../test/fixtures/pod-crashloop-alert.json' with { type: 'json' };

vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  POLL_INTERVAL: 100,
  TIMEZONE: 'UTC',
  TRIGGER_PATTERN: /^@Andy\b/i,
  WEBHOOK_PORT: 0,
  AGENT_TIMEOUT: 30000,
  MAX_CONCURRENT_AGENTS: 5,
  STORE_DIR: '/tmp/tt-nanoclaw-test/store',
  GROUPS_DIR: '/tmp/tt-nanoclaw-test/groups',
  DATA_DIR: '/tmp/tt-nanoclaw-test/data',
  loadAlertConfig: () => ({
    alerts: {
      KubePodCrashLooping: {
        folder: 'alerts',
        name: 'pod-crashloop',
      },
    },
    namespaces: ['kube-system', 'demo'],
  }),
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
        registeredGroups: () => ({
          'alertmanager:KubePodCrashLooping': {
            name: 'pod-crashloop',
            folder: 'alerts',
            trigger: '',
            added_at: '',
            requiresTrigger: false,
          },
        }),
      },
      'https://hooks.slack.com/test',
      0,
      mockSlackSend,
    );
    await channel.connect();
  });

  afterEach(async () => {
    await channel.disconnect();
  });

  it('stores the alert as a NewMessage retrievable by getNewMessages', async () => {
    const port = getPort(channel);
    const res = await postJson(port, '/webhook/alertmanager', crashloopPayload);
    expect(res.status).toBe(200);

    expect(storedMessages).toHaveLength(1);
    const msg = storedMessages[0];
    expect(msg.chat_jid).toBe('alertmanager:KubePodCrashLooping');
    expect(msg.sender).toBe('alertmanager');
    expect(msg.content).toContain('ALERT FIRING');
    expect(msg.content).toContain('buildkitd-d56c8c85f-4s7kw');
    expect(msg.content).toContain('CrashLoopBackOff');

    const jid = 'alertmanager:KubePodCrashLooping';
    const { messages } = getNewMessages([jid], '', 'Andy');
    expect(messages).toHaveLength(1);
    expect(messages[0].chat_jid).toBe(jid);
    expect(messages[0].content).toContain('ALERT FIRING');
  });

  it('deduplicates repeated webhook deliveries', async () => {
    const port = getPort(channel);

    await postJson(port, '/webhook/alertmanager', crashloopPayload);
    await postJson(port, '/webhook/alertmanager', crashloopPayload);

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

    const jid = 'alertmanager:KubePodCrashLooping';
    registeredGroups[jid] = {
      name: 'pod-crashloop',
      folder: 'alerts',
      trigger: '',
      added_at: new Date().toISOString(),
      requiresTrigger: false,
    };
    setRegisteredGroup(jid, registeredGroups[jid]);

    queue = new GroupQueue();
    queue.setProcessMessagesFn(async (chatJid: string): Promise<boolean> => {
      const group = registeredGroups[chatJid];
      if (!group) return true;

      const messages = getMessagesSince(chatJid, '', 'Andy');
      if (messages.length === 0) return true;

      const prompt = formatMessages(messages, 'UTC');

      agentCalls.push({ prompt, groupFolder: group.folder, chatJid });

      const agentResult =
        'RESOLVED: KubePodCrashLooping\n\nPod buildkitd-d56c8c85f-4s7kw deleted. Replacement is Running.';
      await channel.sendMessage(chatJid, agentResult);

      return true;
    });

    channel = new AlertmanagerChannel(
      {
        onMessage: (_jid: string, msg: NewMessage) => {
          storeMessage(msg);
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

    const res = await postJson(port, '/webhook/alertmanager', crashloopPayload);
    expect(res.status).toBe(200);

    await vi.waitFor(
      () => {
        expect(agentCalls).toHaveLength(1);
      },
      { timeout: 2000 },
    );

    expect(agentCalls[0].groupFolder).toBe('alerts');
    expect(agentCalls[0].chatJid).toBe('alertmanager:KubePodCrashLooping');
    expect(agentCalls[0].prompt).toContain('buildkitd-d56c8c85f-4s7kw');

    expect(slackMessages).toHaveLength(1);
    expect(slackMessages[0]).toContain('RESOLVED');
    expect(slackMessages[0]).toContain('KubePodCrashLooping');
  });

  it('handles concurrent alerts for different alertnames', async () => {
    const port = getPort(channel);

    const secondJid = 'alertmanager:KubeNodeNotReady';
    registeredGroups[secondJid] = {
      name: 'node-not-ready',
      folder: 'alerts',
      trigger: '',
      added_at: new Date().toISOString(),
      requiresTrigger: false,
    };
    setRegisteredGroup(secondJid, registeredGroups[secondJid]);

    const secondPayload = {
      ...crashloopPayload,
      groupKey: 'different-group',
      alerts: [
        {
          status: 'firing' as const,
          labels: {
            alertname: 'KubeNodeNotReady',
            severity: 'critical',
            node: 'f06cs19',
          },
          annotations: { summary: 'Node is not ready' },
          startsAt: '2026-03-16T10:00:00.000Z',
          endsAt: '0001-01-01T00:00:00Z',
          generatorURL: 'http://prometheus/graph',
          fingerprint: 'fp-nodenotready-001',
        },
      ],
    };

    await postJson(port, '/webhook/alertmanager', crashloopPayload);
    await postJson(port, '/webhook/alertmanager', secondPayload);

    await vi.waitFor(
      () => {
        expect(agentCalls).toHaveLength(2);
      },
      { timeout: 3000 },
    );

    const jids = agentCalls.map((c) => c.chatJid).sort();
    expect(jids).toEqual([
      'alertmanager:KubeNodeNotReady',
      'alertmanager:KubePodCrashLooping',
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

  it('alert config produces correct registered groups', async () => {
    const { loadAlertConfig } = await import('./config.js');
    const config = loadAlertConfig();

    for (const [alertname, { folder, name }] of Object.entries(config.alerts)) {
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
    const jid = 'alertmanager:KubePodCrashLooping';
    expect(groups[jid]).toBeDefined();
    expect(groups[jid].folder).toBe('alerts');
    expect(groups[jid].name).toBe('pod-crashloop');
    expect(groups[jid].requiresTrigger).toBe(false);
  });
});
