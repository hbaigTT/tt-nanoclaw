#!/bin/bash
# tt-nanoclaw demo: transient crash loop that the agent RESOLVES by deleting the pod
#
# How it works:
#   - Pod starts clean, runs normally (no PID file)
#   - We create a "crash trigger" file inside the pod
#   - App detects trigger, writes PID file, crashes
#   - Container restarts (same pod, same emptyDir) → finds PID file → crash loop
#   - Agent investigates → sees stale PID file error → deletes pod
#   - Replacement gets fresh emptyDir → no PID file, no trigger → runs clean forever
#
# Why this works: the app polls for /data/crash-trigger. Creating it makes the
# app crash and leave a PID file behind. Container restarts see the PID file
# and crash immediately. Deleting the pod = fresh emptyDir = clean start.
#
# Prerequisites:
#   - tt-nanoclaw is deployed and running
#   - Port-forward is active: kubectl -n monitoring port-forward svc/tt-nanoclaw 3000:3000

set -e

KUBECONFIG="${KUBECONFIG:-$HOME/.kube/ci-dev-cluster.yaml}"
export KUBECONFIG

echo "=== Step 1: Clean up any previous demo ==="
kubectl delete deployment demo-transient -n demo 2>/dev/null || true
kubectl delete configmap demo-transient-scripts -n demo 2>/dev/null || true
kubectl -n demo wait --for=delete pod -l app=demo-transient --timeout=30s 2>/dev/null || true

echo ""
echo "=== Step 2: Deploy pod ==="
kubectl apply -f demo/transient-crashloop-deployment.yaml
echo "Waiting for pod to be ready..."
kubectl -n demo wait --for=condition=Ready pod -l app=demo-transient --timeout=60s

POD_NAME=$(kubectl -n demo get pods -l app=demo-transient -o jsonpath='{.items[0].metadata.name}')
echo "Pod: $POD_NAME (Running, healthy)"

echo ""
echo "=== Step 3: Trigger crash (creates stale PID file + crashes) ==="
kubectl -n demo exec "$POD_NAME" -- touch /data/crash-trigger
echo "Crash trigger created. App will detect it within 1 second..."
sleep 2
echo "Waiting for CrashLoopBackOff..."
sleep 25

echo ""
echo "=== Step 4: Verify pod is crash looping ==="
kubectl -n demo get pods -l app=demo-transient
POD_NAME=$(kubectl -n demo get pods -l app=demo-transient -o jsonpath='{.items[0].metadata.name}')
echo "Pod: $POD_NAME"

echo ""
echo "=== Step 5: Send alert to tt-nanoclaw ==="
FINGERPRINT="demo-$(date +%s)-$$"
FIXTURE=$(cat test/fixtures/demo-crashloop-alert.json | sed "s/REPLACE_WITH_ACTUAL_POD_NAME/$POD_NAME/g" | sed "s/demo-app/demo-transient/g" | sed "s/demo-crashloop-001/$FINGERPRINT/g")
echo "$FIXTURE" | curl -s -X POST http://localhost:3000/webhook/alertmanager \
  -H 'Content-Type: application/json' \
  -d @-
echo ""
echo "Alert sent. Watch the agent:"
echo "  kubectl -n monitoring logs -f deploy/tt-nanoclaw"
echo ""
echo "Expected: agent sees 'stale PID file' → deletes pod → replacement starts clean → Running"

echo ""
echo "=== Cleanup (run when done) ==="
echo "  kubectl delete -f demo/transient-crashloop-deployment.yaml"
