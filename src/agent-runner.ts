import fs from 'fs';
import path from 'path';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { AGENT_TIMEOUT } from './config.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';

export interface AgentInput {
  prompt: string;
  groupFolder: string;
  chatJid: string;
}

export interface AgentOutput {
  status: 'success' | 'error';
  result: string | null;
  error?: string;
}

export async function runInProcessAgent(
  input: AgentInput,
  onOutput?: (output: AgentOutput) => Promise<void>,
): Promise<AgentOutput> {
  const groupDir = resolveGroupFolderPath(input.groupFolder);

  // Load CLAUDE.md from the group folder as system context
  const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
  const claudeMd = fs.existsSync(claudeMdPath)
    ? fs.readFileSync(claudeMdPath, 'utf-8')
    : undefined;

  logger.info(
    { group: input.groupFolder, jid: input.chatJid },
    'Starting in-process agent',
  );

  const agentWork = async (): Promise<AgentOutput> => {
    let lastOutput: AgentOutput = {
      status: 'error',
      result: null,
      error: 'No result received from agent',
    };

    try {
      for await (const message of query({
        prompt: input.prompt,
        options: {
          cwd: groupDir,
          // Restrict to Bash only — agent needs kubectl/etcdctl, nothing else for POC
          tools: ['Bash'],
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          // Append CLAUDE.md content as extra system context
          systemPrompt: claudeMd
            ? {
                type: 'preset' as const,
                preset: 'claude_code' as const,
                append: claudeMd,
              }
            : undefined,
          // Each alert runs fresh — no session resumption
          // (stale sessions from prior incidents inject confusing context)
          env: process.env as Record<string, string>,
        },
      })) {
        if (message.type === 'system' && message.subtype === 'init') {
          logger.info(
            { group: input.groupFolder, sessionId: message.session_id },
            'Agent session initialized',
          );
        }

        if (message.type === 'result') {
          if (message.subtype === 'success') {
            const output: AgentOutput = {
              status: 'success',
              result: message.result,
            };
            lastOutput = output;
            await onOutput?.(output);
          } else {
            // error_during_execution, error_max_turns, etc.
            logger.warn(
              { group: input.groupFolder, subtype: message.subtype },
              'Agent returned error result',
            );
            const output: AgentOutput = {
              status: 'error',
              result: null,
              error: message.subtype,
            };
            lastOutput = output;
            await onOutput?.(output);
          }
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error({ group: input.groupFolder, err }, 'Agent SDK threw an error');
      const output: AgentOutput = { status: 'error', result: null, error };
      await onOutput?.(output);
      return output;
    }

    return lastOutput;
  };

  const timeout = new Promise<AgentOutput>((_, reject) =>
    setTimeout(
      () => reject(new Error(`Agent timed out after ${AGENT_TIMEOUT}ms`)),
      AGENT_TIMEOUT,
    ),
  );

  try {
    return await Promise.race([agentWork(), timeout]);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ group: input.groupFolder, error }, 'Agent timed out');
    const output: AgentOutput = { status: 'error', result: null, error };
    await onOutput?.(output);
    return output;
  }
}
