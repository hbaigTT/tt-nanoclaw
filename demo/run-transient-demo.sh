#!/bin/bash
# tt-nanoclaw demo: transient crash loop that the agent RESOLVES by deleting the pod
#
# How it works:
#   - Pod starts clean (no PID file), runs normally
#   - We inject a stale PID file and crash the container
#   - Container restarts (same pod, same emptyDir) → finds PID file → crash loop
#   - Agent investigates → sees stale PID file error → deletes pod
#   - Replacement gets fresh emptyDir → no PID file → runs clean forever
#
# Key: the app does NOT create PID files during normal startup.
# The PID file only exists because we injected it (simulating unclean shutdown).
# So the replacement pod never encounters it.
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
sleep 3

echo ""
echo "=== Step 2: Deploy pod ==="
kubectl apply -f demo/transient-crashloop-deployment.yaml
echo "Waiting for pod to be ready..."
kubectl -n demo wait --for=condition=Ready pod -l app=demo-transient --timeout=30s

POD_NAME=$(kubectl -n demo get pods -l app=demo-transient -o jsonpath='{.items[0].metadata.name}')
echo "Pod: $POD_NAME (Running, healthy)"

echo ""
echo "=== Step 3: Inject stale PID file and crash the container ==="
kubectl -n demo exec "$POD_NAME" -- sh -c 'echo 99999 > /data/app.pid && echo "PID file injected"'
kubectl -n demo exec "$POD_NAME" -- sh -c 'kill 1' 2>/dev/null || true
echo "Container crashed. Waiting for CrashLoopBackOff..."
sleep 25

echo ""
echo "=== Step 4: Verify pod is crash looping ==="
kubectl -n demo get pods -l app=demo-transient
echo ""

# Verify it's the same pod (container restart, not pod replacement)
CURRENT_POD=$(kubectl -n demo get pods -l app=demo-transient -o jsonpath='{.items[0].metadata.name}')
if [ "$CURRENT_POD" = "$POD_NAME" ]; then
  echo "Same pod ($POD_NAME) — container restarted within the pod (as expected)"
else
  echo "WARNING: Pod was replaced ($POD_NAME → $CURRENT_POD)"
  echo "Using new pod name for the alert"
  POD_NAME="$CURRENT_POD"
fi

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
