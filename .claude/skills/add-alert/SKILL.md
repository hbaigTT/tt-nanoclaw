---
name: add-alert
description: Add a new alert type to tt-nanoclaw. Guides you through creating the runbook, updating the ConfigMap, and adding RBAC if needed. Use when adding a new Prometheus alertname for the agent to investigate.
argument-hint: [alertname]
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(kubectl *), Bash(npm run build), Bash(npm test)
---

# Add a New Alert Type

You are helping the developer add a new Prometheus alert type to tt-nanoclaw so the agent can investigate it.

## Step 1: Gather Information

If an alertname was provided as an argument, use it. Otherwise, ask the developer:

1. **What is the Prometheus alertname?** (exact string, e.g., `KubePodNotReady`)
2. **What namespaces does this alert fire in?** (Check if they're already in the allowlist)
3. **What does this alert indicate?** (Brief description of the problem)
4. **What should the agent look for when investigating?** (Events, logs, pod state, dependencies, metrics)
5. **Can the agent auto-resolve it?** If yes, what action? If no, what should the escalation include?

If the developer isn't sure about investigation steps, suggest a reasonable investigation workflow based on the alert type.

## Step 2: Check Existing Configuration

Read the current state:
- `k8s/configmap.yaml` — current alerts and namespaces
- `groups/alerts/runbooks/` — existing runbook files for reference
- `k8s/rbac.yaml` — current namespace RBAC

Verify:
- The alertname isn't already configured
- The required namespaces are in the allowlist (if not, they'll need to be added)

## Step 3: Create the Runbook

Create `groups/alerts/runbooks/<alert-identifier>.md` following the pattern in existing runbooks.

The runbook should include:
- Title and description of the alert
- Step-by-step investigation using the available MCP tools (kubectl_get, kubectl_describe, kubectl_logs, kubectl_top, kubectl_rollout_history)
- What patterns to look for in events, logs, and resource state
- Clear decision criteria: when to resolve vs when to escalate
- If auto-resolve is enabled: the action to take and how to verify
- The agent should always trace dependency chains if errors point to another service

Use the MCP tool call format from the existing runbooks:
```
kubectl_get(resource="pods", name="<pod-name>", namespace="<namespace>", output="wide")
kubectl_describe(resource="pod", name="<pod-name>", namespace="<namespace>")
kubectl_logs(pod="<pod-name>", namespace="<namespace>", previous=true, tail=200)
```

## Step 4: Update the ConfigMap

Edit `k8s/configmap.yaml` to add the new alert under `alerts:`:

```yaml
alerts:
  ExistingAlert:
    folder: alerts
    name: existing-alert
    runbook: runbooks/existing-alert.md
  NewAlertName:                              # Add this
    folder: alerts
    name: <alert-identifier>
    runbook: runbooks/<alert-identifier>.md
```

If new namespaces are needed, add them under `namespaces:`.

## Step 5: Update the Default Config

Edit `src/alert-config.ts` to add the same alert entry to `DEFAULT_CONFIG.alerts` so local dev works without the ConfigMap.

## Step 6: Add RBAC (if new namespaces)

If the alert requires namespaces not already in `k8s/rbac.yaml`, copy an existing Role+RoleBinding block, change the namespace, and add it. Each namespace needs:
- `pods`: get, list, delete
- `pods/log`: get
- `events`: list
- `deployments`, `replicasets` (apps API): get, list
- `pods` (metrics.k8s.io API): get, list

The ServiceAccount subject is always `tt-nanoclaw` in namespace `monitoring`.

## Step 7: Build and Test

```bash
npm run build
npm test
```

Verify the build passes and no tests break.

## Step 8: Summary

Show the developer what was created/modified:
- Runbook file path
- ConfigMap changes
- RBAC changes (if any)
- How to deploy: `kubectl apply -f k8s/configmap.yaml && kubectl -n monitoring rollout restart deploy/tt-nanoclaw`
- How to test: send a matching alert fixture via curl

## Important Notes

- The general agent context (`groups/alerts/CLAUDE.md`) does NOT need to be modified — the runbook is loaded automatically based on the ConfigMap entry
- Alerts without a runbook still work — the agent uses general investigation skills and escalates
- The runbook is baked into the container image — changes require a push + image rebuild + pod restart
- The ConfigMap change can be applied immediately with kubectl
