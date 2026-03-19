import http from 'http';
import https from 'https';
import { URL } from 'url';

import { WEBHOOK_PORT } from '../../config.js';
import { logger } from '../../logger.js';
import { Channel, NewMessage } from '../../types.js';
import { ChannelOpts, registerChannel } from '../registry.js';
import { Alert, AlertmanagerPayload } from './types.js';

const DEDUP_TTL_MS = 15 * 60 * 1000; // 15 minutes

export class AlertmanagerChannel implements Channel {
  readonly name = 'alertmanager';
  private server: http.Server | null = null;
  private dedupMap = new Map<string, number>(); // fingerprint → expiry timestamp
  private opts: ChannelOpts;
  private slackWebhookUrl: string | null;
  private port: number;
  private sendFn: (url: string, text: string) => Promise<void>;

  constructor(
    opts: ChannelOpts,
    slackWebhookUrl: string | null,
    port = WEBHOOK_PORT,
    sendFn: (url: string, text: string) => Promise<void> = postToSlack,
  ) {
    this.opts = opts;
    this.slackWebhookUrl = slackWebhookUrl;
    this.port = port;
    this.sendFn = sendFn;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          logger.error({ err }, 'Alertmanager request handler error');
          res.writeHead(500);
          res.end('Internal Server Error');
        });
      });

      this.server.listen(this.port, () => {
        const addr = this.server!.address();
        const boundPort =
          typeof addr === 'object' && addr ? addr.port : this.port;
        logger.info({ port: boundPort }, 'Alertmanager webhook listening');
        resolve();
      });

      this.server.on('error', reject);
    });
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (req.method === 'POST' && req.url === '/webhook/alertmanager') {
      const body = await readBody(req);
      let payload: AlertmanagerPayload;
      try {
        payload = JSON.parse(body);
      } catch {
        logger.warn('Failed to parse Alertmanager payload as JSON');
        res.writeHead(400);
        res.end('Bad Request');
        return;
      }

      this.processPayload(payload);
      res.writeHead(200);
      res.end('OK');
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  }

  processPayload(payload: AlertmanagerPayload): void {
    if (!payload || !Array.isArray(payload.alerts)) {
      logger.warn(
        'Malformed Alertmanager payload — missing or invalid alerts array',
      );
      return;
    }

    if (payload.status === 'resolved') {
      logger.info(
        { groupKey: payload.groupKey },
        'Alertmanager resolved payload received — ignoring (agent already reported outcome)',
      );
      return;
    }

    const now = Date.now();

    // Evict expired dedup entries
    for (const [fp, expiry] of this.dedupMap) {
      if (expiry < now) this.dedupMap.delete(fp);
    }

    // Filter to firing alerts not yet seen within TTL
    const newAlerts = payload.alerts.filter((alert) => {
      if (!alert?.labels?.alertname || !alert?.fingerprint) return false;
      if (alert.status !== 'firing') return false;
      const expiry = this.dedupMap.get(alert.fingerprint);
      if (expiry && expiry > now) {
        logger.debug(
          { fingerprint: alert.fingerprint },
          'Dedup: skipping already-seen alert',
        );
        return false;
      }
      this.dedupMap.set(alert.fingerprint, now + DEDUP_TTL_MS);
      return true;
    });

    if (newAlerts.length === 0) return;

    // Group new alerts by alertname, then emit one message per alertname
    const byAlertname = new Map<string, Alert[]>();
    for (const alert of newAlerts) {
      const alertname = alert.labels.alertname || 'UnknownAlert';
      const existing = byAlertname.get(alertname);
      if (existing) {
        existing.push(alert);
      } else {
        byAlertname.set(alertname, [alert]);
      }
    }

    for (const [alertname, alerts] of byAlertname) {
      const jid = `alertmanager:${alertname}`;
      const timestamp = new Date().toISOString();

      this.opts.onChatMetadata(jid, timestamp, alertname, 'alertmanager', true);

      const content = formatAlerts(alertname, alerts);
      const msg: NewMessage = {
        id: `${alertname}-${alerts[0].fingerprint}-${timestamp}`,
        chat_jid: jid,
        sender: 'alertmanager',
        sender_name: 'Alertmanager',
        content,
        timestamp,
        is_from_me: false,
        is_bot_message: false,
      };

      logger.info(
        { alertname, alertCount: alerts.length },
        'Alertmanager: new firing alert',
      );
      this.opts.onMessage(jid, msg);
    }
  }

  async sendMessage(_jid: string, text: string): Promise<void> {
    logger.info({ output: text }, 'Agent output');
    if (this.slackWebhookUrl) {
      try {
        await this.sendFn(this.slackWebhookUrl, text);
        logger.info('Posted to Slack');
      } catch (err) {
        logger.error(
          { err },
          'Failed to post to Slack — output was logged above',
        );
      }
    }
  }

  isConnected(): boolean {
    return this.server?.listening ?? false;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('alertmanager:');
  }

  async disconnect(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
  }
}

function formatAlerts(alertname: string, alerts: Alert[]): string {
  const lines: string[] = [`ALERT FIRING: ${alertname}`, ''];

  for (let i = 0; i < alerts.length; i++) {
    const { labels, annotations, startsAt, generatorURL } = alerts[i];

    if (labels.severity) lines.push(`Severity: ${labels.severity}`);
    if (labels.namespace) lines.push(`Namespace: ${labels.namespace}`);
    if (labels.pod) lines.push(`Pod: ${labels.pod}`);
    if (annotations.summary) lines.push('', `Summary: ${annotations.summary}`);
    if (annotations.description)
      lines.push('', `Description: ${annotations.description}`);
    lines.push('', `Started: ${startsAt}`);
    if (generatorURL) lines.push(`Source: ${generatorURL}`);
    lines.push('', `Labels: ${JSON.stringify(labels)}`);

    if (i < alerts.length - 1) lines.push('', '---', '');
  }

  return lines.join('\n').trim();
}

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB — normal Alertmanager payloads are a few KB

const BODY_TIMEOUT_MS = 30000; // 30 seconds

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    let done = false;

    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        req.destroy();
        reject(new Error('Request body read timed out'));
      }
    }, BODY_TIMEOUT_MS);

    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        done = true;
        clearTimeout(timer);
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      body += chunk.toString();
    });
    req.on('end', () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(body);
      }
    });
    req.on('error', (err) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

async function postToSlack(webhookUrl: string, text: string): Promise<void> {
  const url = new URL(webhookUrl);
  const body = JSON.stringify({ text });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Slack webhook returned HTTP ${res.statusCode}`));
          return;
        }
        resolve();
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

registerChannel('alertmanager', (opts: ChannelOpts): Channel | null => {
  const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL || null;
  if (!slackWebhookUrl) {
    logger.warn(
      'SLACK_WEBHOOK_URL not set — agent output will be logged but not posted to Slack',
    );
  }
  return new AlertmanagerChannel(opts, slackWebhookUrl);
});
