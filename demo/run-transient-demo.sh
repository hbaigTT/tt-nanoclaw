#!/bin/bash
# tt-nanoclaw demo: transient crash loop that the agent RESOLVES by deleting the pod
#
# How it works:
#   - Pod starts, creates PID file in /data (emptyDir), runs normally
#   - We kill the container process (simulating unclean shutdown)
#   - Kubernetes restarts the container (same pod = same emptyDir)
#   - Restart finds stale PID file → "Cannot acquire lock" → exit 1
#   - Every subsequent restart: same → CrashLoopBackOff
#   - Agent investigates, sees stale PID file error, deletes the pod
#   - Replacement gets fresh emptyDir → no PID file → starts clean
#
# Prerequisites:
#   - tt-nanoclaw is deployed and running
#   - Port-forward is active: kubectl -n monitoring port-forward svc/tt-nanoclaw 3000:3000

set -e

KUBECONFIG="${KUBECONFIG:-$HOME/.kube/ci-dev-cluster.yaml}"
export KUBECONFIG

echo "=== Step 1: Deploy pod ==="
kubectl apply -f demo/transient-crashloop-deployment.yaml
kubectl -n demo scale deployment demo-transient --replicas=0 2>/dev/null || true
sleep 2
kubectl -n demo scale deployment demo-transient --replicas=1
echo "Waiting for pod to start..."
sleep 10

echo ""
echo "=== Step 2: Simulate unclean shutdown (kill the container process) ==="
POD_NAME=$(kubectl -n demo get pods -l app=demo-transient -o jsonpath='{.items[0].metadata.name}')
echo "Pod: $POD_NAME"
# Kill PID 1 in the container — simulates a crash, leaves PID file behind
kubectl -n demo exec "$POD_NAME" -- kill 1 2>/dev/null || true
echo "Container killed. PID file left behind in emptyDir."
echo "Waiting for CrashLoopBackOff..."
sleep 30

echo ""
echo "=== Step 3: Verify pod is crash looping ==="
kubectl -n demo get pods -l app=demo-transient
POD_NAME=$(kubectl -n demo get pods -l app=demo-transient -o jsonpath='{.items[0].metadata.name}')
echo "Pod: $POD_NAME"

echo ""
echo "=== Step 4: Send alert to tt-nanoclaw ==="
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
