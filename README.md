# tt-nanoclaw

Automated Kubernetes alert response for Tenstorrent CI infrastructure. Receives alerts from Prometheus Alertmanager via webhook, dispatches Claude agents to investigate and resolve them, and reports outcomes to Slack.

Fork of [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw), adapted from a personal AI assistant into an infrastructure automation tool.

## How It Works

```
Alertmanager (dev cluster)
  │
  │ POST /webhook/alertmanager
  ▼
tt-nanoclaw pod (monitoring namespace)
  │
  ├── Parses alert payload, deduplicates by fingerprint
  ├── Matches alertname to registered group + runbook
  ├── Runs Claude Agent SDK in-process with MCP kubectl tools
  │
  ▼
Agent investigates → decides: auto-resolve | escalate
  │
  ├── Auto-resolve: executes fix, verifies, posts to Slack
  └── Escalate: posts structured diagnosis to Slack
```

No container nesting. The agent runs directly in the tt-nanoclaw pod. The agent has **no Bash access** — all cluster interaction goes through 4 MCP tools (`kubectl_get`, `kubectl_describe`, `kubectl_logs`, `kubectl_delete`) with structured, validated parameters. `kubectl_delete` is restricted to pods only. RBAC is the second enforcement layer.

## Current Scope (POC)

The first alert being automated is **`KubePodCrashLooping`**:
- Fires when a pod is repeatedly crashing and restarting
- Agent investigates (events, logs, pod state), decides transient vs structural
- Transient: deletes pod to trigger fresh restart, verifies replacement is Running
- Structural: escalates with diagnosis and recommended next steps

## Project Structure

```
src/
├── index.ts                         # Orchestrator: message loop, agent invocation
├── agent-runner.ts                  # In-process Claude Agent SDK wrapper
├── mcp/
│   └── kubectl-server.ts            # MCP server: validated kubectl verb tools
├── channels/
│   ├── registry.ts                  # Channel self-registration
│   └── alertmanager/
│       ├── index.ts                 # Webhook server + Slack outbound
│       └── types.ts                 # Alertmanager payload types
├── group-queue.ts                   # Per-group concurrency control
├── db.ts                            # SQLite (messages, groups, sessions)
├── router.ts                        # Message formatting
├── config.ts                        # Configuration (ports, timeouts, alert groups)
└── types.ts                         # Core interfaces (Channel, NewMessage, RegisteredGroup)

groups/alerts/CLAUDE.md              # SRE agent persona + KubePodCrashLooping runbook
k8s/                                 # Kubernetes manifests
test/fixtures/                       # Alertmanager payload fixtures
```

## Development

```bash
npm install
npm run build
npm test            # 104 tests (unit + integration)
npm run dev         # Run with hot reload
```

### Local end-to-end test

```bash
ANTHROPIC_API_KEY=sk-... \
KUBECONFIG=~/.kube/ci-dev-cluster.yaml \
npm run dev

# In another terminal:
curl -X POST http://localhost:3000/webhook/alertmanager \
  -H 'Content-Type: application/json' \
  -d @test/fixtures/pod-crashloop-alert.json
```

`SLACK_WEBHOOK_URL` is optional — if not set, agent output is logged to stdout.

### Image tags

| Tag | Trigger | Purpose |
|-----|---------|---------|
| `dev` | Push to main | Dev cluster default |
| `pr-<number>` | Pull request | Preview before merge |
| `v1.0.0` | Git tag | Production release |

Images are pushed to `ghcr.io` by GitHub Actions on every push/PR.

## Deployment

Deployed as a Kubernetes Deployment in the `monitoring` namespace of the dev cluster (`ci-dev-cluster`).

### Required resources

- **Deployment** — tt-nanoclaw pod running Node.js + Claude Agent SDK
- **Service** — ClusterIP on port 3000
- **ServiceAccount** — in `monitoring` namespace
- **RBAC** — Role + RoleBinding in kube-system, arc-systems, buildkit, harbor (get/list/delete pods, get pods/log)
- **Secret** — `ANTHROPIC_API_KEY` (required), `SLACK_WEBHOOK_URL` (optional)

### Apply manifests

```bash
kubectl apply -f k8s/serviceaccount.yaml
kubectl apply -f k8s/rbac.yaml
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/deployment.yaml
```

### Alertmanager configuration

Configured in the [github-ci-infra](https://github.com/tenstorrent/github-ci-infra) repo. The webhook receiver and route are added to the kube-prometheus-stack Helm values:

```yaml
receivers:
  - name: 'nanoclaw'
    webhook_configs:
      - url: 'http://tt-nanoclaw.monitoring.svc.cluster.local:3000/webhook/alertmanager'
        send_resolved: true

routes:
  - receiver: 'nanoclaw'
    matchers:
      - alertname = "KubePodCrashLooping"
    continue: true
```

## License

MIT
