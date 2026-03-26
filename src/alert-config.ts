import fs from 'fs';

import YAML from 'yaml';

import { logger } from './logger.js';

export interface AlertGroupConfig {
  folder: string;
  name: string;
}

export interface AlertConfig {
  alerts: Record<string, AlertGroupConfig>;
  namespaces: string[];
}

const DEFAULT_CONFIG: AlertConfig = {
  alerts: {
    KubePodCrashLooping: {
      folder: 'alerts',
      name: 'pod-crashloop',
    },
  },
  namespaces: ['kube-system', 'arc-systems', 'buildkit', 'harbor', 'demo'],
};

const CONFIG_PATH = process.env.ALERTS_CONFIG_PATH || '/config/alerts.yaml';

let cached: AlertConfig | null = null;

export function loadAlertConfig(): AlertConfig {
  if (cached) return cached;

  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = YAML.parse(raw) as Partial<AlertConfig>;

    cached = {
      alerts: parsed.alerts || DEFAULT_CONFIG.alerts,
      namespaces: parsed.namespaces || DEFAULT_CONFIG.namespaces,
    };

    logger.info(
      {
        alertCount: Object.keys(cached.alerts).length,
        namespaces: cached.namespaces,
        source: CONFIG_PATH,
      },
      'Alert config loaded from file',
    );
  } catch {
    cached = DEFAULT_CONFIG;
    logger.info(
      {
        alertCount: Object.keys(cached.alerts).length,
        namespaces: cached.namespaces,
        source: 'defaults',
      },
      'Alert config file not found, using defaults',
    );
  }

  return cached;
}
