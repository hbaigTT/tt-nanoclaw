# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/channels/alertmanager/` | **Alertmanager webhook channel (new for this fork)** |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `groups/alerts/CLAUDE.md` | **Alert response agent context (new for this fork)** |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |
| `container/skills/etcd-defrag.md` | **etcd defragmentation runbook (new for this fork)** |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate channel fork, not bundled in core. Run `/add-whatsapp` (or `git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git && git fetch whatsapp main && (git merge whatsapp/main || { git checkout --theirs package-lock.json && git add package-lock.json && git merge --continue; }) && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.

---

## tt-nanoclaw: Kubernetes Alert Auto-Resolution

This is a fork of [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw) adapted for proactive Kubernetes alert monitoring at Tenstorrent. Instead of receiving chat messages from humans, this instance receives alerts from Prometheus Alertmanager via webhook and dispatches Claude agents to investigate and resolve them.

### What This Fork Changes

Upstream nanoclaw listens on messaging channels (WhatsApp, Telegram, Slack, Discord). This fork adds a new input source: **Alertmanager webhooks**. The core orchestrator (`src/index.ts`), container runner, and agent SDK integration remain unchanged — we only add a new channel plugin and alert-specific skills.

### Architecture

```
Alertmanager (dev cluster)
  │
  │ POST /webhook/alertmanager
  ▼
tt-nanoclaw pod (in-cluster, monitoring namespace)
  │
  ├── Parses alert payload
  ├── Matches alertname to configured runbook
  ├── Runs Claude Agent SDK directly in-pod with:
  │     - kubectl access (via pod ServiceAccount)
  │     - Alert context (labels, annotations, generatorURL)
  │     - Runbook for this alert type
  │
  ▼
Agent (Claude Agent SDK, in-process)
  │
  ├── Investigates (kubectl commands, log checks, metric queries)
  ├── Decides: auto-resolve | escalate | ignore
  │
  ├── Auto-resolve: executes fix, verifies, reports via sendMessage()
  ├── Escalate: posts structured diagnosis via sendMessage()
  └── Ignore: logs as false positive, no notification
```

**No container nesting.** Upstream nanoclaw runs agents in Docker/Apple Container sandboxes to protect the host filesystem. In-cluster, RBAC already scopes what the agent can do — the ServiceAccount limits kubectl access regardless of isolation. The agent runs directly in the tt-nanoclaw pod.

### POC Scope

The first alert to automate is `etcdDatabaseHighFragmentationRatio`:
- Fires when etcd fragmentation ratio exceeds threshold
- Resolution: `etcdctl defrag --cluster` using RKE2 TLS certs at `/var/lib/rancher/rke2/server/tls/etcd/`
- Recurs every 2-3 months, always the same fix
- Agent verifies fragmentation ratio drops after defrag, posts before/after to Slack

See [docs/POC.md](docs/POC.md) for the full implementation spec.

### Deployment

Deployed as a Kubernetes Deployment in the `monitoring` namespace of the dev cluster (`ci-dev-cluster`). Image pushed to `ghcr.io/tenstorrent/tt-nanoclaw`. Managed by an Ansible role in the [github-ci-infra](https://github.com/tenstorrent/github-ci-infra) repo, same pattern as other monitoring components.

Required Kubernetes resources:
- **Deployment**: tt-nanoclaw pod running the Node.js orchestrator + Claude Agent SDK
- **Service**: ClusterIP exposing the webhook endpoint on port 3000
- **ServiceAccount + RBAC**: scoped permissions for agent kubectl access (get/list/exec pods in kube-system)
- **Secret**: `ANTHROPIC_API_KEY`

All outbound messages (resolution reports, escalations) route through nanoclaw's `sendMessage()` to Slack — no direct webhook calls from the agent.

### Alertmanager Integration

Alertmanager is configured in `github-ci-infra` repo at `ansible/playbooks/roles/kube_prometheus_stack/tasks/main.yaml`. The webhook receiver and route are added to the Helm values there, not in this repo.

### Testing

```bash
# Unit tests
npm test

# Manual webhook test (send a fake alert payload)
curl -X POST http://localhost:3000/webhook/alertmanager \
  -H 'Content-Type: application/json' \
  -d @test/fixtures/etcd-fragmentation-alert.json
```

### Upstream Sync

To pull upstream changes:
```bash
git remote add upstream https://github.com/qwibitai/nanoclaw.git
git fetch upstream main
git merge upstream/main
```

Keep fork-specific changes in `src/channels/alertmanager/`, `container/skills/`, and `groups/alerts/` to minimize merge conflicts. Avoid modifying upstream core files directly.
