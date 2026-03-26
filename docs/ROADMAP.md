# tt-nanoclaw Roadmap

## Current State (POC)

Single pod, single alert type (KubePodCrashLooping), in-process agents, investigation-only (no write operations in production), results logged to stdout. Alertmanager integration active on dev cluster. Alert configuration externalized to ConfigMap (`k8s/configmap.yaml`) — adding new alerts requires no code change or image rebuild.

---

## Priority 1: Agent Pods (Kubernetes Jobs)

**Goal**: Isolation, per-alert RBAC, scalability.

Current: orchestrator runs `query()` in-process. One stuck agent blocks the queue. OOM kills everything. All agents share one ServiceAccount.

Target: orchestrator creates a Kubernetes Job per alert. Each Job runs the Agent SDK with the MCP server, writes its result back, and terminates.

**What this gives you:**
- **Isolation**: one agent crashing doesn't affect others or the orchestrator
- **Per-alert RBAC**: etcd Job has a ServiceAccount with exec permission; crash loop Job has one with delete. Least privilege per alert type.
- **Resource control**: each Job has its own CPU/memory limits
- **Native scaling**: Kubernetes schedules Jobs across nodes. 10 simultaneous alerts = 10 Jobs on 10 nodes.
- **Observability**: Job duration, success/failure, resource usage are standard Kubernetes metrics
- **Cost tracking**: each Job's API usage is isolated and measurable

The orchestrator becomes thin — receive webhook, create Job with the right config, collect result when done.

---

## Priority 2: Result Persistence

**Goal**: Durable, queryable investigation history.

Currently results are in pod logs (ephemeral, lost on restart). Production needs:

- Store each investigation result in a database, Confluence page, or Jira ticket
- Each result includes: alertname, pod, namespace, timestamp, investigation summary, decision (resolved/escalated), suggested fix
- Queryable: "show me all investigations for KubePodCrashLooping in the last 30 days"
- Audit trail for compliance: what did the agent do, when, and why

Options:
- SQLite table (already have the database, simplest)
- Jira tickets (searchable, assignable, fits existing workflows)
- Confluence pages (documentation-oriented, good for sharing with teams)
- All of the above via pluggable output adapters

---

## Priority 3: Human-in-the-Loop for Write Operations

**Goal**: Agent investigates autonomously but gets approval before acting.

Flow:
1. Agent investigates, decides "this pod should be deleted"
2. Instead of deleting, posts a proposal to Slack: "I want to delete pod X because Y. Approve / Reject?"
3. Engineer clicks Approve → agent executes the delete and verifies
4. Engineer clicks Reject → agent logs the decision and moves on

This is critical for production trust. Investigation is safe (read-only). Write operations need a human confirming the agent's judgment.

Implementation: Slack interactive messages with approval buttons, or a simple web UI exposed via the existing HTTP server.

---

## Priority 4: Custom Resource Definitions (CRDs)

**Goal**: Kubernetes-native extensibility.

Instead of ConfigMaps, define a custom resource:

```yaml
apiVersion: nanoclaw.tenstorrent.com/v1
kind: AlertHandler
metadata:
  name: pod-crashloop
  namespace: monitoring
spec:
  alertname: KubePodCrashLooping
  runbook: |
    ## KubePodCrashLooping
    When you receive this alert...
  namespaces: [kube-system, arc-systems]
  tools:
    read: [kubectl_get, kubectl_describe, kubectl_logs]
    write: [kubectl_delete]
  writeApproval: auto  # or "manual" for human-in-the-loop
```

The tt-nanoclaw controller watches for `AlertHandler` resources and dynamically configures itself. Adding a new alert = `kubectl apply -f alert-handler.yaml`. No restart needed.

Enables GitOps — ArgoCD manages AlertHandler resources the same way it manages Deployments.

**When**: after 5+ alert types across multiple clusters. Before that, ConfigMaps are simpler.

---

## Priority 5: Metrics and Dashboard

**Goal**: Operational visibility into what the agent is doing.

Expose Prometheus metrics on `/metrics`:
- `tt_nanoclaw_alerts_received_total` (by alertname)
- `tt_nanoclaw_agents_dispatched_total` (by alertname)
- `tt_nanoclaw_resolutions_total` (by alertname, outcome: resolved/escalated)
- `tt_nanoclaw_agent_duration_seconds` (histogram by alertname)
- `tt_nanoclaw_api_cost_usd` (by alertname)
- `tt_nanoclaw_tool_calls_total` (by tool name)

Grafana dashboard showing:
- Alert response rate over time
- Mean time to investigation completion
- Resolution vs escalation ratio by alert type
- API cost per day/week
- Active agents

---

## Priority 6: Cost Controls

**Goal**: Prevent runaway API spend.

- Cap the number of agent invocations per hour (configurable per alert type)
- Set a dollar budget per day — stop dispatching agents when budget is exhausted
- Alert if API costs spike (meta-alert: tt-nanoclaw monitors itself)
- Use cheaper/faster models for initial triage ("is this alert worth investigating?") and full model for investigation
- Cache: if the same alert was escalated with the same root cause in the last 24 hours, skip re-investigation and reference the prior result

---

## Priority 7: Runbook Testing

**Goal**: Prevent broken runbooks from being deployed.

CI step that runs the agent against known alert fixtures and validates:
- Agent follows the expected investigation steps
- Agent produces output in the correct format (RESOLVED/ESCALATED)
- Agent uses only allowed tools for that alert type
- Output includes required fields (root cause, suggested fix, alert source)

When someone changes a runbook, CI catches regressions before deployment.

---

## Multi-Cluster Strategy

Deploy one tt-nanoclaw instance per cluster (simplest, strongest isolation):
- Same container image across all clusters
- Per-cluster ConfigMap for alert config, namespaces, tool permissions
- Per-cluster ServiceAccount and RBAC
- Per-cluster Alertmanager route
- Shared runbook library (mounted from a common ConfigMap or built into the image)

Central management via GitOps — one repo defines all cluster configs, ArgoCD syncs them.
