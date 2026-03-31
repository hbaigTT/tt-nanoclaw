---
name: investigate
description: Trigger an on-demand investigation of a Kubernetes resource. Constructs an alert payload, sends it to the running tt-nanoclaw instance, and shows the agent's investigation results. Use when you want to investigate why a pod, deployment, or node is unhealthy without waiting for Alertmanager.
argument-hint: [pod/resource-name] [namespace]
allowed-tools: Read, Grep, Glob, Bash(kubectl *), Bash(curl *), Bash(cat *), Bash(kill *)
---

# On-Demand Investigation

You are helping the developer trigger an investigation of a Kubernetes resource using the running tt-nanoclaw agent.

## Step 1: Determine what to investigate

If arguments were provided, parse them:
- `/investigate harbor-jobservice-xxx harbor` → pod `harbor-jobservice-xxx` in namespace `harbor`
- `/investigate harbor-jobservice harbor` → pod matching prefix `harbor-jobservice` in namespace `harbor`
- `/investigate KubePodCrashLooping` → investigate using this alertname, ask for pod/namespace

If no arguments, ask the developer:
1. **What resource is having issues?** (pod name or prefix)
2. **What namespace?**

Then use kubectl to find the exact resource:
```bash
KUBECONFIG=${KUBECONFIG:-~/.kube/ci-dev-cluster.yaml} kubectl get pods -n <namespace> | grep <name>
```

If multiple matches, show them and ask the developer to pick one.

## Step 2: Determine the alertname

Map the issue to a Prometheus alertname. Common mappings:
- Pod in CrashLoopBackOff → `KubePodCrashLooping`
- Pod not ready → `KubePodNotReady`
- Deployment replicas mismatch → `KubeDeploymentReplicasMismatch`
- Node not ready → `KubeNodeNotReady`

If unsure, check the pod status:
```bash
KUBECONFIG=${KUBECONFIG:-~/.kube/ci-dev-cluster.yaml} kubectl get pod <pod-name> -n <namespace> -o wide
```

If the pod is in CrashLoopBackOff, use `KubePodCrashLooping`. If it's Pending or not Ready, use `KubePodNotReady`. If the developer just wants a general investigation, use `KubePodCrashLooping` as the default — the agent investigates broadly regardless of alertname.

## Step 3: Check tt-nanoclaw is reachable

Check if port-forward is already running:
```bash
curl -s http://localhost:3000/healthz 2>/dev/null
```

If it returns `{"status":"ok"}`, proceed. If not, start port-forward:
```bash
KUBECONFIG=${KUBECONFIG:-~/.kube/ci-dev-cluster.yaml} kubectl -n monitoring port-forward svc/tt-nanoclaw 3000:3000 &
sleep 2
```

## Step 4: Construct and send the alert payload

Build a payload matching the Alertmanager webhook format:

```bash
FINGERPRINT="investigate-$(date +%s)-$$"
PAYLOAD=$(cat <<ALERT_EOF
{
  "version": "4",
  "groupKey": "investigate/${ALERTNAME}",
  "truncatedAlerts": 0,
  "status": "firing",
  "receiver": "nanoclaw",
  "groupLabels": {"alertname": "${ALERTNAME}"},
  "commonLabels": {"alertname": "${ALERTNAME}", "severity": "warning"},
  "commonAnnotations": {"summary": "On-demand investigation triggered by developer"},
  "externalURL": "http://localhost:3000",
  "alerts": [{
    "status": "firing",
    "labels": {
      "alertname": "${ALERTNAME}",
      "namespace": "${NAMESPACE}",
      "pod": "${POD_NAME}",
      "severity": "warning"
    },
    "annotations": {
      "description": "On-demand investigation of ${POD_NAME} in ${NAMESPACE}",
      "summary": "Developer-triggered investigation"
    },
    "startsAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "endsAt": "0001-01-01T00:00:00Z",
    "generatorURL": "http://localhost:3000/investigate",
    "fingerprint": "${FINGERPRINT}"
  }]
}
ALERT_EOF
)

echo "$PAYLOAD" | curl -s -X POST http://localhost:3000/webhook/alertmanager \
  -H 'Content-Type: application/json' \
  -d @-
```

Replace `${ALERTNAME}`, `${NAMESPACE}`, `${POD_NAME}`, and `${FINGERPRINT}` with the actual values.

## Step 5: Show the results

Tail the tt-nanoclaw logs and wait for the investigation to complete:

```bash
KUBECONFIG=${KUBECONFIG:-~/.kube/ci-dev-cluster.yaml} kubectl -n monitoring logs -f deploy/tt-nanoclaw --since=10s
```

Watch for the `investigation_complete` log line. Once it appears, extract and display:
- **Outcome**: resolved or escalated
- **Duration**: how long the investigation took
- **Tool calls**: how many kubectl commands the agent ran
- **Full output**: the agent's investigation report

Tell the developer the investigation is complete and show them the agent's full report.

## Step 6: Clean up

If you started a port-forward in step 3, inform the developer it's still running and how to stop it:
```
Port-forward is still running in the background. Stop it with: kill %1
```

## Notes

- The investigation uses a unique fingerprint so it won't be deduplicated against real alerts
- The alertname determines which runbook the agent loads — if no runbook exists for that alert, the agent uses general investigation skills
- The agent's output goes to pod logs (and Slack if configured)
- This skill requires tt-nanoclaw to be deployed and running in the cluster
