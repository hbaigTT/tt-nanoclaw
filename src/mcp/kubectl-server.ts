/**
 * MCP stdio server exposing kubectl verb tools with structured, validated parameters.
 *
 * The agent cannot run arbitrary commands — only the kubectl operations defined here.
 * Each tool validates parameters against allowlists before constructing and executing
 * the kubectl command. RBAC is the second enforcement layer.
 *
 * Launched by the Agent SDK as a child process communicating via stdio.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

// --- Validation allowlists ---
// Expand these when adding new alert types. Each expansion is a reviewable PR.

const ALLOWED_NAMESPACES = ['kube-system', 'arc-systems', 'buildkit', 'harbor'];

const ALLOWED_DELETE_RESOURCES = ['pods'];

// --- Helpers ---

function validateNamespace(namespace: string): void {
  if (!ALLOWED_NAMESPACES.includes(namespace)) {
    throw new Error(
      `Namespace "${namespace}" not allowed. Allowed: ${ALLOWED_NAMESPACES.join(', ')}`,
    );
  }
}

function validateDeleteResource(resource: string): void {
  if (!ALLOWED_DELETE_RESOURCES.includes(resource)) {
    throw new Error(
      `Resource "${resource}" not allowed for deletion. Allowed: ${ALLOWED_DELETE_RESOURCES.join(', ')}`,
    );
  }
}

async function runKubectl(
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('kubectl', args, {
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout, stderr };
  } catch (err: unknown) {
    const execErr = err as {
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return {
      stdout: execErr.stdout || '',
      stderr: execErr.stderr || execErr.message || 'kubectl command failed',
    };
  }
}

function formatResult(
  stdout: string,
  stderr: string,
): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  const parts: string[] = [];
  if (stdout.trim()) parts.push(stdout.trim());
  if (stderr.trim()) parts.push(`STDERR:\n${stderr.trim()}`);
  const text = parts.join('\n\n') || '(no output)';
  return {
    content: [{ type: 'text' as const, text }],
    isError: stderr.trim().length > 0 && stdout.trim().length === 0,
  };
}

// --- MCP Server ---

const server = new McpServer({
  name: 'kubectl',
  version: '1.0.0',
});

server.tool(
  'kubectl_get',
  'Get Kubernetes resources. Read-only.',
  {
    resource: z
      .string()
      .describe('Resource type: pods, nodes, events, services, etc.'),
    name: z.string().optional().describe('Specific resource name'),
    namespace: z
      .string()
      .default('kube-system')
      .describe('Namespace (validated against allowlist)'),
    labels: z
      .string()
      .optional()
      .describe('Label selector, e.g. component=etcd'),
    field: z.string().optional().describe('Field selector'),
    output: z
      .enum(['wide', 'json', 'yaml', 'name'])
      .optional()
      .describe('Output format'),
  },
  async ({ resource, name, namespace, labels, field, output }) => {
    validateNamespace(namespace);

    const args = ['get', resource];
    if (name) args.push(name);
    args.push('-n', namespace);
    if (labels) args.push('-l', labels);
    if (field) args.push('--field-selector', field);
    if (output) args.push('-o', output);

    const { stdout, stderr } = await runKubectl(args);
    return formatResult(stdout, stderr);
  },
);

server.tool(
  'kubectl_describe',
  'Describe a Kubernetes resource in detail. Read-only.',
  {
    resource: z.string().describe('Resource type: pod, node, service, etc.'),
    name: z.string().describe('Resource name'),
    namespace: z
      .string()
      .default('kube-system')
      .describe('Namespace (validated against allowlist)'),
  },
  async ({ resource, name, namespace }) => {
    validateNamespace(namespace);

    const args = ['describe', resource, name, '-n', namespace];
    const { stdout, stderr } = await runKubectl(args);
    return formatResult(stdout, stderr);
  },
);

server.tool(
  'kubectl_logs',
  'Get logs from a pod. Read-only.',
  {
    pod: z.string().describe('Pod name'),
    namespace: z
      .string()
      .default('kube-system')
      .describe('Namespace (validated against allowlist)'),
    tail: z.number().default(200).describe('Number of lines from the end'),
    container: z
      .string()
      .optional()
      .describe('Container name (if multi-container pod)'),
    previous: z
      .boolean()
      .default(false)
      .describe('Get logs from previous container instance'),
  },
  async ({ pod, namespace, tail, container, previous }) => {
    validateNamespace(namespace);

    const args = ['logs', pod, '-n', namespace, '--tail', String(tail)];
    if (container) args.push('-c', container);
    if (previous) args.push('--previous');

    const { stdout, stderr } = await runKubectl(args);
    return formatResult(stdout, stderr);
  },
);

server.tool(
  'kubectl_delete',
  'Delete a Kubernetes resource. Restricted to allowed resource types only (pods).',
  {
    resource: z.string().describe('Resource type (only "pods" is allowed)'),
    name: z.string().describe('Resource name'),
    namespace: z
      .string()
      .default('kube-system')
      .describe('Namespace (validated against allowlist)'),
  },
  async ({ resource, name, namespace }) => {
    validateNamespace(namespace);
    validateDeleteResource(resource);

    const args = ['delete', resource, name, '-n', namespace];
    const { stdout, stderr } = await runKubectl(args);
    return formatResult(stdout, stderr);
  },
);

// --- Start ---

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`kubectl MCP server failed: ${err}\n`);
  process.exit(1);
});
