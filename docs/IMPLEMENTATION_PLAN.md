# tt-nanoclaw Implementation Plan

## Context

tt-nanoclaw is a fork of [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw) repurposed for automated Kubernetes alert response. Instead of chat messages from humans, it receives Alertmanager webhooks and dispatches Claude agents to investigate and resolve alerts. The POC target is `etcdDatabaseHighFragmentationRatio` on the dev cluster (`ci-dev-cluster`).

The upstream codebase has ~15 source modules, most designed for personal assistant use cases (WhatsApp, container sandboxing, sender allowlists, scheduled tasks). We need to strip it down to the core message pipeline, add an Alertmanager webhook channel, and replace container-based agent execution with in-process Agent SDK calls.

---

## Phase 1: Clean Up — Remove Unused Code

**Goal**: Strip modules tt-nanoclaw doesn't need. Codebase compiles, retained tests pass.

### Delete files

| File | Why |
|------|-----|
| `src/remote-control.ts` + `.test.ts` | Interactive browser sessions |
| `src/sender-allowlist.ts` + `.test.ts` | Human sender filtering |
| `src/task-scheduler.ts` + `.test.ts` | Cron/interval scheduling |
| `src/mount-security.ts` | Container mount allowlists |
| `src/credential-proxy.ts` + `.test.ts` | Container credential injection |
| `src/container-runtime.ts` + `.test.ts` | Docker runtime abstraction |
| `src/container-runner.ts` + `.test.ts` | Docker container spawning |
| `container/` (entire directory) | Agent container image + runner |
| `setup/` (entire directory) | Interactive setup wizard |
| `src/whatsapp-auth.ts` (if exists) | WhatsApp auth |
| `src/ipc.ts` + `src/ipc-auth.test.ts` | IPC watcher for container agents (dead code with in-process runner) |

### Modify files

**`src/index.ts`** — the biggest change:
- Remove imports: `credential-proxy`, `container-runner`, `container-runtime`, `remote-control`, `sender-allowlist`, `task-scheduler`
- Remove functions: `ensureContainerSystemRunning()`, `handleRemoteControl()`, `getAvailableGroups()`
- Remove from `main()`: credential proxy startup, container system check, scheduler loop, remote control restore
- Stub out `runAgent()` → return `'error'` with log "agent runner not yet implemented"
- Keep: message loop, GroupQueue, channel registration

**`src/types.ts`** — remove:
- `AdditionalMount`, `MountAllowlist`, `AllowedRoot`, `ContainerConfig` interfaces
- `containerConfig` from `RegisteredGroup`
- `ScheduledTask`, `TaskRunLog` interfaces

**`src/config.ts`** — remove:
- `CONTAINER_IMAGE`, `CONTAINER_TIMEOUT`, `CONTAINER_MAX_OUTPUT_SIZE`, `CREDENTIAL_PROXY_PORT`
- `IDLE_TIMEOUT`, `MOUNT_ALLOWLIST_PATH`, `SENDER_ALLOWLIST_PATH`, `SCHEDULER_POLL_INTERVAL`
- Add: `WEBHOOK_PORT` (default 3000)

**`src/db.ts`** — remove:
- `scheduled_tasks` and `task_run_logs` table creation
- All task-related functions (`createTask`, `getTaskById`, `getAllTasks`, `getDueTasks`, etc.)

**`src/ipc.ts`** — delete entirely. The IPC watcher polls filesystem paths written by container agents via the MCP `send_message` tool. With in-process agents and `allowedTools: ['Bash']` only there's no MCP server and no IPC file writes — the watcher loop never fires. Remove `startIpcWatcher()` from `main()` and delete the file. Remove from `src/index.ts` as well.

**`src/group-queue.ts`** — replace `GroupState` with a minimal model:
```typescript
interface GroupState {
  active: boolean;    // agent currently running for this group
  pending: boolean;   // message arrived while agent was active
  retryCount: number;
}
```
Remove: `ChildProcess` import, `process`/`containerName`/`groupFolder` fields, `registerProcess()`, `sendMessage()`, `closeStdin()`, `notifyIdle()`, idle-waiting logic.
Keep: concurrency control, retry logic, `enqueueMessageCheck()`. The `fn: () => Promise<'success'|'error'>` callback shape is unchanged — `runInProcessAgent()` returns the same shape.

**`package.json`** — remove:
- `cron-parser` from dependencies
- `"setup"` and `"auth"` scripts
- Add: `@anthropic-ai/claude-agent-sdk` dependency

### Test

```bash
npm run build        # Must compile clean
npm test             # db, group-folder, group-queue, routing, formatting, timezone tests pass
```

---

## Phase 2: Alertmanager Webhook Channel

**Goal**: HTTP server receives Alertmanager payloads, injects them as `NewMessage` objects into the pipeline.

### How outbound Slack routing works

The NanoClaw channel abstraction routes outbound messages like this:

```
agent produces result
  → orchestrator calls findChannel(jid).sendMessage(jid, text)
    → alertmanager channel owns alertmanager:* JIDs
      → alertmanager channel's sendMessage() posts to Slack
```

The alertmanager channel IS the channel for all `alertmanager:*` JIDs. Its `sendMessage()` implementation posts to Slack — this IS going through nanoclaw's sendMessage abstraction, not bypassing it. The abstraction is the `Channel` interface; Slack delivery is the implementation detail of this specific channel.

`SLACK_WEBHOOK_URL` points to a **separate** incoming webhook from what Alertmanager already uses. For the POC, it points to `#tt-nanoclaw` (private testing channel). Do not reuse Alertmanager's webhook — tt-nanoclaw's output is agent-generated prose, not raw alert payloads.

### Create files

**`src/channels/alertmanager/index.ts`** — implements `Channel` interface:
- `connect()`: Start `http.createServer()` on `WEBHOOK_PORT` (3000)
- Route: `POST /webhook/alertmanager` — parse `AlertmanagerPayload`, extract firing alerts
- Route: `GET /healthz` — return HTTP 200 `{"status":"ok"}` (needed for K8s liveness/readiness probes)
- JID scheme: `alertmanager:<alertname>` (e.g., `alertmanager:etcdDatabaseHighFragmentationRatio`)
- Deduplication: TTL map keyed by `fingerprint` alone (Alertmanager's fingerprint is already a hash of the full label set including alertname), skip repeats within 15 min
- `status: "resolved"` payloads: log and return HTTP 200, do NOT inject into the pipeline. The agent already reported the outcome; a second invocation with resolved context is confusing.
- For each firing alert: call `opts.onMessage(jid, newMessage)` with formatted alert context
- `sendMessage(jid, text)`: POST to Slack incoming webhook URL from `SLACK_WEBHOOK_URL` env
- `ownsJid(jid)`: return `jid.startsWith('alertmanager:')`
- `isConnected()`: return `true` if HTTP server listening
- Factory: check `SLACK_WEBHOOK_URL` env, return `null` if missing (log warning)
- Register via `registerChannel('alertmanager', factory)`

**`src/channels/alertmanager/types.ts`** — Alertmanager webhook payload types:
- `AlertmanagerPayload` (version, groupKey, status, receiver, alerts[])
- `Alert` (status, labels, annotations, startsAt, endsAt, generatorURL, fingerprint)

**`test/fixtures/etcd-fragmentation-alert.json`** — realistic payload with 3 etcd members. Must include `"pod": "etcd-f06cs15"` (or real pod name) in the alert labels so Phase 4 end-to-end testing exercises the pod-name-from-labels path that the runbook relies on.

**`src/channels/alertmanager/alertmanager.test.ts`** — unit tests:
- Payload parsing (valid/invalid)
- Deduplication (same alert within TTL skipped)
- JID generation
- Only firing alerts processed
- `ownsJid()` correctness

### Modify files

**`src/channels/index.ts`** — add: `import './alertmanager/index.js';`

**`src/config.ts`** — add `WEBHOOK_PORT`:
```typescript
export const WEBHOOK_PORT = parseInt(process.env.WEBHOOK_PORT || '3000', 10);
```

### Test

```bash
npm run build && npm test

# Manual integration test:
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/... npm run dev &
curl -X POST http://localhost:3000/webhook/alertmanager \
  -H 'Content-Type: application/json' \
  -d @test/fixtures/etcd-fragmentation-alert.json

# Verify logs show:
# 1. HTTP 200 response
# 2. "New messages" from message loop
# 3. Queue tries to process but hits the runAgent stub → logged error
```

---

## Phase 3: In-Process Agent Runner

**Goal**: Replace Docker container spawning with direct Claude Agent SDK calls.

### Key reference

The existing container agent runner at `container/agent-runner/src/index.ts` (deleted in Phase 1 but studied here) imports from `@anthropic-ai/claude-agent-sdk` and calls `query()` with:
- `prompt`: async iterable of user messages
- `options.cwd`: working directory (group folder)
- `options.resume`: session ID for continuity
- `options.systemPrompt`: preset + appended CLAUDE.md
- `options.allowedTools`: tool list
- `options.permissionMode`: `'bypassPermissions'`
- `options.env`: environment variables including API key

For tt-nanoclaw, we simplify: single-turn per alert (no MessageStream, no IPC polling), no MCP server needed.

### kubectl authentication note

**In production (in-cluster)**: Do NOT set `KUBECONFIG`. kubectl automatically uses the ServiceAccount token at `/var/run/secrets/kubernetes.io/serviceaccount/token` and the cluster endpoint from `/var/run/secrets/kubernetes.io/serviceaccount/...`. The RBAC Role limits what the agent can actually do regardless of how it authenticates.

**In local dev (Phase 4 test)**: Set `KUBECONFIG=~/.kube/ci-dev-cluster.yaml` explicitly. This is dev-only — the kubeconfig gives broader access than the in-cluster ServiceAccount.

### Create files

**`src/agent-runner.ts`**:
```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

export interface AgentInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
}

export interface AgentOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export async function runInProcessAgent(
  input: AgentInput,
  onOutput?: (output: AgentOutput) => Promise<void>,
): Promise<AgentOutput> { ... }
```

Key implementation details:
- Resolve group folder via `resolveGroupFolderPath(input.groupFolder)`
- Read `CLAUDE.md` from group folder for system prompt
- Call `query()` with `cwd` = group folder, `allowedTools: ['Bash']` (minimal for POC — agent only needs kubectl/etcdctl)
- **Do not resume sessions**: set `resume: undefined`. Each alert invocation is independent. Resuming a session from a months-old prior incident injects stale context and confuses the agent.
- Iterate async generator: capture `session_id` from `system/init`, emit `result` messages via `onOutput`
- `ANTHROPIC_API_KEY` from `process.env` directly (no credential proxy)
- Wrap in try/catch, return error status on failure
- Add timeout via `Promise.race` with configurable `AGENT_TIMEOUT` (default 10 min)

### Modify files

**`src/index.ts`** — replace `runAgent()` stub:
- Import `runInProcessAgent` from `./agent-runner.js`
- Rewrite `runAgent()` to call `runInProcessAgent()` with the formatted prompt
- `onOutput` callback: call `channel.sendMessage(chatJid, text)` for each result
- Remove session tracking — each alert runs fresh, no resume
- Remove `registerProcess` callback (no ChildProcess)
- Remove `startIpcWatcher()` call (deleted in Phase 1)

**`src/config.ts`** — add:
```typescript
export const AGENT_TIMEOUT = parseInt(process.env.AGENT_TIMEOUT || '600000', 10); // 10 min
```

### Test

```bash
npm run build && npm test

# Start with a real API key (agent will fail kubectl but proves SDK integration):
ANTHROPIC_API_KEY=sk-... SLACK_WEBHOOK_URL=https://... npm run dev &
curl -X POST http://localhost:3000/webhook/alertmanager \
  -H 'Content-Type: application/json' \
  -d @test/fixtures/etcd-fragmentation-alert.json

# Verify:
# 1. Agent SDK initializes (session ID logged)
# 2. Agent attempts kubectl (fails locally — expected)
# 3. Agent output appears in #tt-nanoclaw Slack channel
```

---

## Phase 4: Alert Group Registration + End-to-End Local Test

**Goal**: Auto-register alert groups at startup, wire everything together, test the full pipeline locally.

### Create files

**`groups/alerts/CLAUDE.md`** — SRE agent persona with etcd defrag runbook:
- Agent identity and behavior rules
- etcd defrag investigation steps with exact kubectl + etcdctl commands
- **Pod name**: extract from alert labels (e.g. `labels.pod`), present in the alert context message
- **etcdctl path**: `/var/lib/rancher/rke2/bin/etcdctl` (not in default PATH on RKE2)
- **No `sh -c` wrapping**: RKE2 etcd pods are distroless (no shell). Use direct exec: `kubectl exec -n kube-system <pod> -- /var/lib/rancher/rke2/bin/etcdctl ...`
- TLS cert paths: `/var/lib/rancher/rke2/server/tls/etcd/`
- Verification steps (check fragmentation ratio before and after)
- Reporting format (RESOLVED / ESCALATED with before/after metrics)
- Escalation message template (structured, no @mentions, no tickets for POC)

### Modify files

**`src/config.ts`** — add alert-to-group mapping:
```typescript
export const ALERT_GROUPS: Record<string, { folder: string; name: string }> = {
  'etcdDatabaseHighFragmentationRatio': { folder: 'alerts', name: 'etcd-fragmentation' },
};
```

**`src/index.ts`** — in `main()`, after `loadState()`:
- Iterate `ALERT_GROUPS`, auto-register each as a `RegisteredGroup` with `requiresTrigger: false`
- JID: `alertmanager:<alertname>`, folder from config

### Test

```bash
# Full end-to-end with cluster access:
ANTHROPIC_API_KEY=sk-... \
SLACK_WEBHOOK_URL=https://... \
KUBECONFIG=~/.kube/ci-dev-cluster.yaml \
npm run dev &

curl -X POST http://localhost:3000/webhook/alertmanager \
  -H 'Content-Type: application/json' \
  -d @test/fixtures/etcd-fragmentation-alert.json

# Agent should:
# 1. Receive alert, load CLAUDE.md runbook
# 2. Run kubectl to check etcd status on dev cluster
# 3. Run etcdctl defrag --cluster (or escalate if fragmentation isn't actually high)
# 4. Post structured result to #tt-nanoclaw Slack channel
```

---

## Phase 5: Dockerize + K8s Manifests

**Goal**: Container image on ghcr.io, Kubernetes manifests for dev cluster deployment.

### Create files

**`Dockerfile`** (root level) — multi-stage build:
- Stage 1 (builder): `node:20-slim`, `npm ci`, `npm run build`
- Stage 2 (runtime): `node:20-slim`, install `kubectl`, copy `dist/` + `node_modules/` + `groups/`
- The `@anthropic-ai/claude-agent-sdk` is a regular npm dependency — it's in `node_modules/`, no global install needed
- No `KUBECONFIG` env var set — pod uses in-cluster ServiceAccount auth automatically
- Expose port 3000, `CMD ["node", "dist/index.js"]`

**`k8s/deployment.yaml`** — Deployment in `monitoring` namespace:
- Image: `ghcr.io/tenstorrent/tt-nanoclaw:latest`
- Env from Secret `tt-nanoclaw`: `ANTHROPIC_API_KEY`, `SLACK_WEBHOOK_URL`
- Liveness/readiness probes on `GET /healthz` port 3000 (added in Phase 2)
- No `KUBECONFIG` env var (in-cluster auth is automatic)

**`k8s/service.yaml`** — ClusterIP on port 3000

**`k8s/rbac.yaml`** — ServiceAccount lives in `monitoring` (where the pod runs). Role and RoleBinding must be in `kube-system` (where the etcd pods are) — a Role in `monitoring` cannot authorize access to `kube-system` resources:
```yaml
kind: Role
metadata:
  name: tt-nanoclaw
  namespace: kube-system      # must be kube-system, not monitoring
rules:
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "list"]
- apiGroups: [""]
  resources: ["pods/exec"]
  verbs: ["create"]
---
kind: RoleBinding
metadata:
  name: tt-nanoclaw
  namespace: kube-system      # kube-system
subjects:
- kind: ServiceAccount
  name: tt-nanoclaw
  namespace: monitoring       # ServiceAccount lives here
roleRef:
  kind: Role
  name: tt-nanoclaw
  apiGroup: rbac.authorization.k8s.io
```

**`k8s/secret.yaml`** — template (values filled by Ansible/CI, not committed):
```yaml
apiVersion: v1
kind: Secret
metadata:
  name: tt-nanoclaw
  namespace: monitoring
stringData:
  ANTHROPIC_API_KEY: "sk-..."
  SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/..."  # points to #tt-nanoclaw (dev testing)
  # prod will point to #github-ci-infra-alerts
```

Note: `SLACK_WEBHOOK_URL` is a separate incoming webhook from what Alertmanager already uses. Create a new webhook app in Slack for `#tt-nanoclaw`.

**`.github/workflows/build.yaml`** — build + push to ghcr.io on push to `main`. Required, not optional: deploying to the cluster needs an image in the registry, and switching from manual push to CI mid-phase adds unnecessary friction.

### Test

```bash
# Build image locally
docker build -t tt-nanoclaw:dev .

# Run with local kubeconfig mounted (dev testing only — in-cluster won't have this):
docker run -p 3000:3000 \
  -e ANTHROPIC_API_KEY=sk-... \
  -e SLACK_WEBHOOK_URL=https://... \
  -e KUBECONFIG=/root/.kube/config \
  -v ~/.kube/ci-dev-cluster.yaml:/root/.kube/config:ro \
  tt-nanoclaw:dev

curl -X POST http://localhost:3000/webhook/alertmanager \
  -H 'Content-Type: application/json' \
  -d @test/fixtures/etcd-fragmentation-alert.json
```

---

## Phase 6: Deploy to Dev Cluster + Real Alert Test

**Goal**: Running in-cluster, Alertmanager routing configured, validated with real etcd fragmentation alert.

### Steps

1. Push image to `ghcr.io/tenstorrent/tt-nanoclaw`
2. Apply K8s manifests to dev cluster (`monitoring` namespace)
3. Add Alertmanager webhook receiver + route in `github-ci-infra` repo (Ansible)
4. Validate with manual port-forward + curl
5. Trigger real alert by writing/deleting etcd keys
6. Verify end-to-end: Prometheus fires → Alertmanager routes → agent resolves → Slack reports

### Alertmanager config change (in github-ci-infra)

Add to `ansible/playbooks/roles/kube_prometheus_stack/tasks/main.yaml`:
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
    continue: true  # also send to existing Slack receiver
```

### Test

```bash
# 1. Verify pod is running
KUBECONFIG=~/.kube/ci-dev-cluster.yaml kubectl -n monitoring get pods -l app=tt-nanoclaw

# 2. Check logs on startup
KUBECONFIG=~/.kube/ci-dev-cluster.yaml kubectl -n monitoring logs -f deploy/tt-nanoclaw

# 3. Manual webhook test via port-forward (sanity check before real alert)
KUBECONFIG=~/.kube/ci-dev-cluster.yaml kubectl -n monitoring port-forward svc/tt-nanoclaw 3000:3000
curl -X POST http://localhost:3000/webhook/alertmanager \
  -H 'Content-Type: application/json' \
  -d @test/fixtures/etcd-fragmentation-alert.json

# 4. Trigger real alert (write + delete etcd keys to cause fragmentation)
# Note: RKE2 etcd pods are distroless — no sh. Run each command as direct exec.
# Repeat put/delete in a loop from your local machine (not inside the pod):
for i in $(seq 1 200); do
  KUBECONFIG=~/.kube/ci-dev-cluster.yaml kubectl exec -n kube-system etcd-f06cs15 -- \
    /var/lib/rancher/rke2/bin/etcdctl put /nanoclaw-test/key-$i "$(head -c 512 /dev/urandom | base64)"
done
KUBECONFIG=~/.kube/ci-dev-cluster.yaml kubectl exec -n kube-system etcd-f06cs15 -- \
  /var/lib/rancher/rke2/bin/etcdctl del /nanoclaw-test/ --prefix

# 5. Validate Prometheus fired the alert
# Open http://prometheus.dev.tenstorrent.net/alerts
# Confirm etcdDatabaseHighFragmentationRatio shows as "Firing"

# 6. Validate Alertmanager received and routed it
# Open http://alertmanager.dev.tenstorrent.net/#/alerts
# Confirm alert appears and nanoclaw receiver is listed in routing

# 7. Validate nanoclaw received it
KUBECONFIG=~/.kube/ci-dev-cluster.yaml \
  kubectl -n monitoring logs deploy/tt-nanoclaw | grep "etcdDatabaseHighFragmentationRatio"

# 8. Success criteria
# - Agent ran etcdctl defrag --cluster (visible in pod logs)
# - Fragmentation ratio dropped (agent reports before/after)
# - RESOLVED or ESCALATED message posted to #tt-nanoclaw
# - Alert resolves in Alertmanager within a few minutes
```

---

## Key Files Reference

| File | Role |
|------|------|
| `src/index.ts` | Orchestrator — message loop, agent invocation, channel init |
| `src/channels/alertmanager/index.ts` | **NEW** — webhook server (inbound) + Slack poster (outbound) |
| `src/agent-runner.ts` | **NEW** — in-process Claude Agent SDK wrapper |
| `src/channels/registry.ts` | Channel self-registration pattern (keep as-is) |
| `src/group-queue.ts` | Per-group concurrency control (simplify) |
| `src/db.ts` | SQLite — messages, groups, sessions (remove task tables) |
| `src/router.ts` | Message formatting + channel routing (keep as-is) |
| `src/types.ts` | Core interfaces — Channel, NewMessage, RegisteredGroup |
| `src/config.ts` | Configuration — add WEBHOOK_PORT, ALERT_GROUPS, AGENT_TIMEOUT |
| `groups/alerts/CLAUDE.md` | **NEW** — SRE agent persona + etcd defrag runbook |
| `Dockerfile` | **NEW** — orchestrator pod image (root level) |
| `k8s/` | **NEW** — Deployment, Service, RBAC, Secret template |

## Files added to delete list (Phase 1)

- `src/ipc.ts` + `src/ipc-auth.test.ts` — dead code once container agents are gone; agents run in-process with no MCP server and never write IPC files. Delete both or `npm test` fails on the orphaned test.

## Existing code to reuse (not recreate)

- `registerChannel()` / `getChannelFactory()` from `src/channels/registry.ts`
- `storeMessage()` / `getNewMessages()` / `getMessagesSince()` from `src/db.ts`
- `GroupQueue.enqueueMessageCheck()` concurrency control from `src/group-queue.ts`
- `formatMessages()` / `formatOutbound()` / `findChannel()` from `src/router.ts`
- `resolveGroupFolderPath()` from `src/group-folder.ts`
- `query()` SDK call pattern from `container/agent-runner/src/index.ts` (read before deleting in Phase 1)
