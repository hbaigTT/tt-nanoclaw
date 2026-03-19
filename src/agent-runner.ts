import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { AGENT_TIMEOUT } from './config.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

/**
 * Extract a concise summary of an SDK message for logging.
 * INFO level: type + tool name (if tool call). DEBUG level: full content.
 */
function logSdkMessage(
  group: string,
  message: { type: string; [key: string]: unknown },
): void {
  const subtype = 'subtype' in message ? String(message.subtype) : '';

  if (message.type === 'assistant') {
    const msg = message as {
      type: string;
      message?: {
        content?: Array<{
          type: string;
          text?: string;
          name?: string;
          input?: unknown;
        }>;
      };
    };
    const content = msg.message?.content;
    if (content) {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          logger.debug({ group, text: block.text }, 'Agent thinking');
        } else if (block.type === 'tool_use') {
          logger.info(
            { group, tool: block.name, input: block.input },
            'Agent tool call',
          );
        }
      }
    } else {
      logger.debug({ group, type: message.type, subtype }, 'Agent SDK message');
    }
  } else if (message.type === 'user') {
    const msg = message as {
      type: string;
      message?: {
        content?: Array<{
          type: string;
          content?: string | Array<{ type: string; text?: string }>;
        }>;
      };
    };
    const content = msg.message?.content;
    if (content) {
      for (const block of content) {
        if (block.type === 'tool_result') {
          const text =
            typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content
                    .filter((c) => c.type === 'text')
                    .map((c) => c.text)
                    .join('\n')
                : '';
          logger.debug({ group, result: text.slice(0, 500) }, 'Tool result');
        }
      }
    }
  } else if (message.type === 'system') {
    logger.debug({ group, type: message.type, subtype }, 'Agent SDK message');
  } else {
    logger.debug({ group, type: message.type, subtype }, 'Agent SDK message');
  }
}

export async function runInProcessAgent(
  input: AgentInput,
  onOutput?: (output: AgentOutput) => Promise<void>,
): Promise<AgentOutput> {
  const groupDir = resolveGroupFolderPath(input.groupFolder);

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
      logger.info({ group: input.groupFolder }, 'Calling Agent SDK query()');
      for await (const message of query({
        prompt: input.prompt,
        options: {
          cwd: groupDir,
          tools: [],
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          mcpServers: {
            kubectl: {
              command: 'node',
              args: [path.join(__dirname, 'mcp', 'kubectl-server.js')],
              env: process.env as Record<string, string>,
            },
          },
          systemPrompt: claudeMd
            ? {
                type: 'preset' as const,
                preset: 'claude_code' as const,
                append: claudeMd,
              }
            : undefined,
          env: process.env as Record<string, string>,
        },
      })) {
        logSdkMessage(
          input.groupFolder,
          message as { type: string; [key: string]: unknown },
        );

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
      logger.error(
        { group: input.groupFolder, err },
        'Agent SDK threw an error',
      );
      const output: AgentOutput = { status: 'error', result: null, error };
      await onOutput?.(output);
      return output;
    }

    if (lastOutput.status === 'error') {
      logger.error(
        { group: input.groupFolder, error: lastOutput.error },
        'Agent finished with error status',
      );
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
