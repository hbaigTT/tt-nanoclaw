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
  runbookPath?: string; // path to alert-specific runbook file
}

export interface AgentOutput {
  status: 'success' | 'error';
  result: string | null;
  error?: string;
  sessionId?: string;
  toolCalls: number;
  durationMs: number;
}

/**
 * Extract a concise summary of an SDK message for logging.
 * INFO level: type + tool name (if tool call). DEBUG level: full content.
 */
function logSdkMessage(
  group: string,
  message: { type: string; [key: string]: unknown },
): { toolCalls: number } {
  let toolCalls = 0;
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
          toolCalls++;
          logger.info(
            { group, tool: block.name, input: block.input },
            'Agent tool call',
          );
        }
      }
    } else {
      logger.debug({ group, type: message.type, subtype }, 'Agent SDK message');
    }
    return { toolCalls };
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
  return { toolCalls: 0 };
}

export async function runInProcessAgent(
  input: AgentInput,
  onOutput?: (output: AgentOutput) => Promise<void>,
): Promise<AgentOutput> {
  const groupDir = resolveGroupFolderPath(input.groupFolder);

  // Load general context (always)
  const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
  let claudeMd = fs.existsSync(claudeMdPath)
    ? fs.readFileSync(claudeMdPath, 'utf-8')
    : undefined;

  // Append alert-specific runbook if available
  if (input.runbookPath) {
    const runbookFullPath = path.join(groupDir, input.runbookPath);
    if (fs.existsSync(runbookFullPath)) {
      const runbook = fs.readFileSync(runbookFullPath, 'utf-8');
      claudeMd = claudeMd ? `${claudeMd}\n\n---\n\n${runbook}` : runbook;
      logger.info(
        { group: input.groupFolder, runbook: input.runbookPath },
        'Loaded alert-specific runbook',
      );
    } else {
      logger.warn(
        { group: input.groupFolder, runbook: input.runbookPath },
        'Alert-specific runbook not found, using general context only',
      );
    }
  }

  logger.info(
    { group: input.groupFolder, jid: input.chatJid },
    'Starting in-process agent',
  );

  const startTime = Date.now();
  let totalToolCalls = 0;
  let sessionId: string | undefined;

  const agentWork = async (): Promise<AgentOutput> => {
    let lastOutput: AgentOutput = {
      status: 'error',
      result: null,
      error: 'No result received from agent',
      toolCalls: 0,
      durationMs: 0,
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
        const msgStats = logSdkMessage(
          input.groupFolder,
          message as { type: string; [key: string]: unknown },
        );
        totalToolCalls += msgStats.toolCalls;

        if (message.type === 'system' && message.subtype === 'init') {
          sessionId = message.session_id;
          logger.info(
            { group: input.groupFolder, sessionId },
            'Agent session initialized',
          );
        }

        if (message.type === 'result') {
          if (message.subtype === 'success') {
            const output: AgentOutput = {
              status: 'success',
              result: message.result,
              sessionId,
              toolCalls: totalToolCalls,
              durationMs: Date.now() - startTime,
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
              sessionId,
              toolCalls: totalToolCalls,
              durationMs: Date.now() - startTime,
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
      const output: AgentOutput = {
        status: 'error',
        result: null,
        error,
        sessionId,
        toolCalls: totalToolCalls,
        durationMs: Date.now() - startTime,
      };
      await onOutput?.(output);
      return output;
    }

    lastOutput.toolCalls = totalToolCalls;
    lastOutput.durationMs = Date.now() - startTime;
    lastOutput.sessionId = sessionId;

    if (lastOutput.status === 'error') {
      logger.error(
        { group: input.groupFolder, error: lastOutput.error },
        'Agent finished with error status',
      );
    }

    return lastOutput;
  };

  let timeoutHandle: ReturnType<typeof setTimeout>;
  const timeout = new Promise<AgentOutput>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`Agent timed out after ${AGENT_TIMEOUT}ms`)),
      AGENT_TIMEOUT,
    );
  });

  try {
    const result = await Promise.race([agentWork(), timeout]);
    clearTimeout(timeoutHandle!);
    return result;
  } catch (err) {
    clearTimeout(timeoutHandle!);
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ group: input.groupFolder, error }, 'Agent timed out');
    const output: AgentOutput = {
      status: 'error',
      result: null,
      error,
      sessionId,
      toolCalls: totalToolCalls,
      durationMs: Date.now() - startTime,
    };
    await onOutput?.(output);
    return output;
  }
}
