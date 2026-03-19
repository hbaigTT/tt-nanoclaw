# tt-nanoclaw

Automated Kubernetes alert response. See [README.md](README.md) for overview and deployment.

## Quick Context

Single Node.js process. Alertmanager webhooks arrive on port 3000, get stored in SQLite, polled by a message loop, and dispatched to the Claude Agent SDK running in-process with MCP kubectl tools. No containers, no Bash — the agent can only call validated kubectl verb tools.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/agent-runner.ts` | In-process Claude Agent SDK wrapper (MCP, no Bash) |
| `src/mcp/kubectl-server.ts` | MCP server: kubectl_get, kubectl_describe, kubectl_logs, kubectl_delete |
| `src/channels/alertmanager/index.ts` | Webhook server (inbound) + Slack/log output (outbound) |
| `src/channels/registry.ts` | Channel self-registration |
| `src/config.ts` | Ports, timeouts, ALERT_GROUPS mapping |
| `src/group-queue.ts` | Per-group concurrency control |
| `src/db.ts` | SQLite operations |
| `groups/alerts/CLAUDE.md` | SRE agent persona + KubePodCrashLooping runbook |
| `k8s/` | Kubernetes manifests (Deployment, Service, RBAC, ServiceAccount) |

## Development

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
npm test             # 104 tests (unit + integration)
```

## Adding a New Alert Type

1. Add the alertname to `ALERT_GROUPS` in `src/config.ts`
2. Expand allowlists in `src/mcp/kubectl-server.ts` if the alert needs access to new namespaces or resource types
3. Add a runbook to `groups/alerts/CLAUDE.md`
4. Add RBAC Role+RoleBinding in any new namespaces (`k8s/rbac.yaml`)
5. Add the Alertmanager route in `github-ci-infra`
