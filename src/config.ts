import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile(['ASSISTANT_NAME']);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const POLL_INTERVAL = 2000;

// Absolute paths needed for group folder resolution
const PROJECT_ROOT = process.cwd();

export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

export const WEBHOOK_PORT = parseInt(process.env.WEBHOOK_PORT || '3000', 10);

export const AGENT_TIMEOUT = parseInt(
  process.env.AGENT_TIMEOUT || '600000',
  10,
); // 10 min default

// Alert-to-group mapping: alertname → group folder + display name
export const ALERT_GROUPS: Record<string, { folder: string; name: string }> = {
  etcdDatabaseHighFragmentationRatio: {
    folder: 'alerts',
    name: 'etcd-fragmentation',
  },
};

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for formatting message timestamps
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
