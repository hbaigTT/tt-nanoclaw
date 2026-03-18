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
  ├── Runs Claude Agent SDK in-process with kubectl access
  │
  ▼
Agent investigates → decides: auto-resolve | escalate
  │
  ├── Auto-resolve: executes fix, verifies, posts to Slack
  └── Escalate: posts structured diagnosis to Slack
```

No container nesting. The agent runs directly in the tt-nanoclaw pod. RBAC scopes what kubectl can do — the ServiceAccount limits access regardless of isolation.

## Current Scope (POC)

The first alert being automated is **`etcdDatabaseHighFragmentationRatio`**:
- Fires when etcd fragmentation ratio exceeds threshold
- Resolution: `etcdctl defrag` on each cluster member
- Recurs every 2-3 months, always the same fix
- Agent verifies fragmentation drops after defrag, posts before/after to Slack

## Project Structure

```
src/
├── index.ts                         # Orchestrator: message loop, agent invocation
├── agent-runner.ts                  # In-process Claude Agent SDK wrapper
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

groups/alerts/CLAUDE.md              # SRE agent persona + etcd defrag runbook
k8s/                                 # Kubernetes manifests
test/fixtures/                       # Alertmanager payload fixtures
```

## Development

```bash
npm install
npm run build
npm test            # 88 tests (unit + integration)
npm run dev         # Run with hot reload
```

### Local end-to-end test

```bash
ANTHROPIC_API_KEY=sk-... \
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/... \
KUBECONFIG=~/.kube/ci-dev-cluster.yaml \
npm run dev

# In another terminal:
curl -X POST http://localhost:3000/webhook/alertmanager \
  -H 'Content-Type: application/json' \
  -d @test/fixtures/etcd-fragmentation-alert.json
```

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
- **RBAC** — Role + RoleBinding in `kube-system` (get/list pods, create pods/exec)
- **Secret** — `ANTHROPIC_API_KEY` and `SLACK_WEBHOOK_URL`

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
      - alertname = "etcdDatabaseHighFragmentationRatio"
    continue: true
```

## Upstream Sync

To pull upstream nanoclaw changes:

```bash
git remote add upstream https://github.com/qwibitai/nanoclaw.git
git fetch upstream main
git merge upstream/main
```

Fork-specific changes are in `src/channels/alertmanager/`, `src/agent-runner.ts`, `groups/alerts/`, and `k8s/` to minimize merge conflicts.

## License

MIT
