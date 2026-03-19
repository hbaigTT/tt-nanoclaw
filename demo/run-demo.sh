#!/bin/bash
# tt-nanoclaw demo: trigger a crash-looping pod and watch the agent investigate
#
# Prerequisites:
#   - tt-nanoclaw is deployed and running in the monitoring namespace
#   - RBAC for the demo namespace is applied
#   - Port-forward is active: kubectl -n monitoring port-forward svc/tt-nanoclaw 3000:3000

set -e

KUBECONFIG="${KUBECONFIG:-$HOME/.kube/ci-dev-cluster.yaml}"
export KUBECONFIG

echo "=== Step 1: Deploy crash-looping pod ==="
kubectl apply -f demo/crashloop-deployment.yaml
echo "Waiting for pod to enter CrashLoopBackOff..."
sleep 30

echo ""
echo "=== Step 2: Get pod name ==="
POD_NAME=$(kubectl -n demo get pods -l app=demo-app -o jsonpath='{.items[0].metadata.name}')
echo "Pod: $POD_NAME"

echo ""
echo "=== Step 3: Verify pod is crash looping ==="
kubectl -n demo get pods -l app=demo-app
echo ""

echo "=== Step 4: Send alert to tt-nanoclaw ==="
# Create fixture with actual pod name
FINGERPRINT="demo-$(date +%s)-$$"
FIXTURE=$(cat test/fixtures/demo-crashloop-alert.json | sed "s/REPLACE_WITH_ACTUAL_POD_NAME/$POD_NAME/g" | sed "s/demo-crashloop-001/$FINGERPRINT/g")
echo "$FIXTURE" | curl -s -X POST http://localhost:3000/webhook/alertmanager \
  -H 'Content-Type: application/json' \
  -d @-
echo ""
echo "Alert sent. Watch the agent work:"
echo "  kubectl -n monitoring logs -f deploy/tt-nanoclaw"

echo ""
echo "=== Cleanup (run when done) ==="
echo "  kubectl delete -f demo/crashloop-deployment.yaml"
