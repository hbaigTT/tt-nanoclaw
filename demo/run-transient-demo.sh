#!/bin/bash
# tt-nanoclaw demo: transient crash loop that the agent RESOLVES by deleting the pod
#
# How it works:
#   - Pod starts, creates a lock file in /tmp, runs for 5s, then crashes
#   - On restart (same pod = same /tmp), lock file persists → immediate crash
#   - This creates a CrashLoopBackOff — every restart fails due to stale lock
#   - Agent investigates, sees "stale lock file" in logs, deletes the pod
#   - Replacement pod gets a fresh /tmp (no lock) → starts successfully
#   - After 5s the replacement also crashes, but the demo is done by then
#
# Prerequisites:
#   - tt-nanoclaw is deployed and running
#   - Port-forward is active: kubectl -n monitoring port-forward svc/tt-nanoclaw 3000:3000

set -e

KUBECONFIG="${KUBECONFIG:-$HOME/.kube/ci-dev-cluster.yaml}"
export KUBECONFIG

echo "=== Step 1: Deploy pod (will crash loop due to stale lock file) ==="
kubectl apply -f demo/transient-crashloop-deployment.yaml
kubectl -n demo scale deployment demo-transient --replicas=0 2>/dev/null || true
sleep 2
kubectl -n demo scale deployment demo-transient --replicas=1
echo "Waiting for CrashLoopBackOff..."
sleep 40

echo ""
echo "=== Step 2: Verify pod is crash looping ==="
kubectl -n demo get pods -l app=demo-transient
POD_NAME=$(kubectl -n demo get pods -l app=demo-transient -o jsonpath='{.items[0].metadata.name}')
echo "Pod: $POD_NAME"

echo ""
echo "=== Step 3: Send alert to tt-nanoclaw ==="
FINGERPRINT="demo-$(date +%s)-$$"
FIXTURE=$(cat test/fixtures/demo-crashloop-alert.json | sed "s/REPLACE_WITH_ACTUAL_POD_NAME/$POD_NAME/g" | sed "s/demo-app/demo-transient/g" | sed "s/demo-crashloop-001/$FINGERPRINT/g")
echo "$FIXTURE" | curl -s -X POST http://localhost:3000/webhook/alertmanager \
  -H 'Content-Type: application/json' \
  -d @-
echo ""
echo "Alert sent. Watch the agent:"
echo "  kubectl -n monitoring logs -f deploy/tt-nanoclaw"
echo ""
echo "Expected: agent sees 'stale lock file' → deletes pod → replacement starts clean → Running"

echo ""
echo "=== Cleanup (run when done) ==="
echo "  kubectl delete -f demo/transient-crashloop-deployment.yaml"
