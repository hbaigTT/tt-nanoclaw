import http from 'http';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { AlertmanagerChannel } from './index.js';
import type { AlertmanagerPayload } from './types.js';

// Port 0 lets the OS assign a free port for each test
const TEST_PORT = 0;

const mockSendFn = vi.fn().mockResolvedValue(undefined);

function makeMockOpts() {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn().mockReturnValue({}),
  };
}

function makeChannel(opts = makeMockOpts()) {
  return new AlertmanagerChannel(
    opts,
    'https://hooks.slack.com/services/test',
    TEST_PORT,
    mockSendFn,
  );
}

function firingPayload(
  overrides: Partial<AlertmanagerPayload> = {},
): AlertmanagerPayload {
  return {
    version: '4',
    groupKey: 'test-group-key',
    status: 'firing',
    receiver: 'nanoclaw',
    groupLabels: { alertname: 'TestAlert' },
    commonLabels: { alertname: 'TestAlert', severity: 'warning' },
    commonAnnotations: {},
    externalURL: 'http://alertmanager:9093',
    alerts: [
      {
        status: 'firing',
        labels: {
          alertname: 'TestAlert',
          severity: 'warning',
          namespace: 'kube-system',
          pod: 'etcd-f06cs15',
        },
        annotations: {
          summary: 'Test summary',
          description: 'Test description',
        },
        startsAt: '2026-03-16T10:00:00.000Z',
        endsAt: '0001-01-01T00:00:00Z',
        generatorURL: 'http://prometheus/graph',
        fingerprint: 'fp-0001',
      },
    ],
    ...overrides,
  };
}

// Helper: POST JSON to the channel's HTTP server
async function postWebhook(
  port: number,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: body !== undefined ? 'POST' : 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let responseBody = '';
        res.on('data', (chunk: Buffer) => {
          responseBody += chunk.toString();
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: responseBody }),
        );
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function getPort(channel: AlertmanagerChannel): number {
  const addr = (channel as unknown as { server: http.Server }).server.address();
  return typeof addr === 'object' && addr ? addr.port : 0;
}

describe('AlertmanagerChannel', () => {
  let channel: AlertmanagerChannel;
  let opts: ReturnType<typeof makeMockOpts>;

  beforeEach(async () => {
    vi.clearAllMocks();
    opts = makeMockOpts();
    channel = new AlertmanagerChannel(
      opts,
      'https://hooks.slack.com/services/test',
      TEST_PORT,
      mockSendFn,
    );
    await channel.connect();
  });

  afterEach(async () => {
    await channel.disconnect();
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns alertmanager: JIDs', () => {
      expect(channel.ownsJid('alertmanager:SomeAlert')).toBe(true);
      expect(
        channel.ownsJid('alertmanager:etcdDatabaseHighFragmentationRatio'),
      ).toBe(true);
    });

    it('does not own other JIDs', () => {
      expect(channel.ownsJid('123@g.us')).toBe(false);
      expect(channel.ownsJid('tg:abc')).toBe(false);
      expect(channel.ownsJid('')).toBe(false);
    });
  });

  // --- /healthz ---

  it('responds 200 to GET /healthz', async () => {
    const port = getPort(channel);
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/healthz', method: 'GET' },
      (res) => {
        expect(res.statusCode).toBe(200);
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString()));
        res.on('end', () => {
          expect(JSON.parse(body)).toEqual({ status: 'ok' });
        });
      },
    );
    await new Promise<void>((resolve, reject) => {
      req.on('error', reject);
      req.end();
      req.on('response', (res) => {
        res.resume();
        res.on('end', resolve);
      });
    });
  });

  // --- Payload parsing ---

  it('returns 400 for invalid JSON', async () => {
    const port = getPort(channel);
    const result = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/webhook/alertmanager',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        (res) => {
          res.resume();
          resolve({ status: res.statusCode ?? 0 });
        },
      );
      req.on('error', reject);
      req.write('not-json');
      req.end();
    });
    expect(result.status).toBe(400);
  });

  it('returns 200 and calls onMessage for valid firing payload', async () => {
    const port = getPort(channel);
    const res = await postWebhook(
      port,
      '/webhook/alertmanager',
      firingPayload(),
    );
    expect(res.status).toBe(200);
    expect(opts.onMessage).toHaveBeenCalledOnce();

    const [jid, msg] = opts.onMessage.mock.calls[0];
    expect(jid).toBe('alertmanager:TestAlert');
    expect(msg.chat_jid).toBe('alertmanager:TestAlert');
    expect(msg.content).toContain('ALERT FIRING: TestAlert');
    expect(msg.content).toContain('Pod: etcd-f06cs15');
  });

  // --- JID generation ---

  it('derives JID from alertname label', async () => {
    const port = getPort(channel);
    const payload = firingPayload({
      alerts: [
        {
          ...firingPayload().alerts[0],
          labels: {
            ...firingPayload().alerts[0].labels,
            alertname: 'etcdDatabaseHighFragmentationRatio',
          },
          fingerprint: 'fp-etcd',
        },
      ],
    });
    await postWebhook(port, '/webhook/alertmanager', payload);
    expect(opts.onMessage).toHaveBeenCalledOnce();
    expect(opts.onMessage.mock.calls[0][0]).toBe(
      'alertmanager:etcdDatabaseHighFragmentationRatio',
    );
  });

  // --- Resolved payloads ignored ---

  it('does not call onMessage for resolved payloads', async () => {
    const port = getPort(channel);
    const payload: AlertmanagerPayload = {
      ...firingPayload(),
      status: 'resolved',
      alerts: [{ ...firingPayload().alerts[0], status: 'resolved' }],
    };
    const res = await postWebhook(port, '/webhook/alertmanager', payload);
    expect(res.status).toBe(200);
    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  // --- Deduplication ---

  it('skips alerts with the same fingerprint within TTL', async () => {
    const port = getPort(channel);
    const payload = firingPayload(); // fingerprint: fp-0001

    await postWebhook(port, '/webhook/alertmanager', payload);
    expect(opts.onMessage).toHaveBeenCalledTimes(1);

    // Same fingerprint — should be deduped
    await postWebhook(port, '/webhook/alertmanager', payload);
    expect(opts.onMessage).toHaveBeenCalledTimes(1);
  });

  it('passes through alerts with different fingerprints', async () => {
    const port = getPort(channel);

    await postWebhook(port, '/webhook/alertmanager', firingPayload());
    const second = firingPayload({
      alerts: [{ ...firingPayload().alerts[0], fingerprint: 'fp-different' }],
    });
    await postWebhook(port, '/webhook/alertmanager', second);

    expect(opts.onMessage).toHaveBeenCalledTimes(2);
  });

  it('re-fires an alert after TTL expires', async () => {
    const port = getPort(channel);
    vi.useFakeTimers();

    const payload = firingPayload();
    await postWebhook(port, '/webhook/alertmanager', payload);
    expect(opts.onMessage).toHaveBeenCalledTimes(1);

    // Advance past the 15-minute TTL
    vi.advanceTimersByTime(16 * 60 * 1000);

    await postWebhook(port, '/webhook/alertmanager', payload);
    expect(opts.onMessage).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  // --- sendMessage routes to Slack ---

  it('sendMessage calls the Slack send function', async () => {
    await channel.sendMessage('alertmanager:SomeAlert', 'test output');
    expect(mockSendFn).toHaveBeenCalledOnce();
    expect(mockSendFn).toHaveBeenCalledWith(
      'https://hooks.slack.com/services/test',
      'test output',
    );
  });
});
