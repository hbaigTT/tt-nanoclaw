#!/bin/bash
# tt-nanoclaw demo: transient crash loop that the agent RESOLVES by deleting the pod
#
# Flow:
#   1. Deploy a pod that crashes because /config/app.conf is missing
#   2. Wait for CrashLoopBackOff
#   3. Send alert — agent investigates, sees config file missing
#   4. While agent is investigating, patch Deployment to mount ConfigMap
#   5. Agent sees ConfigMap exists, deletes old pod
#   6. Replacement pod mounts ConfigMap and starts successfully
#
# Prerequisites:
#   - tt-nanoclaw is deployed and running
#   - Port-forward is active: kubectl -n monitoring port-forward svc/tt-nanoclaw 3000:3000

set -e

KUBECONFIG="${KUBECONFIG:-$HOME/.kube/ci-dev-cluster.yaml}"
export KUBECONFIG

echo "=== Step 1: Deploy crash-looping pod (missing config mount) ==="
kubectl apply -f demo/transient-crashloop-deployment.yaml

# Scale to 0 then back to 1 to ensure a fresh pod (no leftover from previous demo)
kubectl -n demo scale deployment demo-transient --replicas=0 2>/dev/null || true
sleep 2
kubectl -n demo scale deployment demo-transient --replicas=1
echo "Waiting for pod to enter CrashLoopBackOff..."
sleep 30

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
echo "Alert sent."

echo ""
echo "=== Step 4: Patch deployment to mount ConfigMap (simulates fix becoming available) ==="
sleep 3
kubectl -n demo patch deployment demo-transient --type=strategic -p '{
  "spec": {
    "template": {
      "spec": {
        "volumes": [{"name": "config", "configMap": {"name": "demo-app-config"}}],
        "containers": [{"name": "demo-transient", "volumeMounts": [{"name": "config", "mountPath": "/config"}]}]
      }
    }
  }
}'
# Immediately scale down the new rollout so Kubernetes doesn't replace the pod before the agent does
kubectl -n demo rollout pause deployment demo-transient 2>/dev/null || true
echo "ConfigMap mount patched. Rollout paused — agent must delete the old pod to trigger replacement."

echo ""
echo "Watch the agent work:"
echo "  kubectl -n monitoring logs -f deploy/tt-nanoclaw"
echo ""
echo "After agent deletes pod, resume rollout:"
echo "  kubectl -n demo rollout resume deployment demo-transient"

echo ""
echo "=== Cleanup (run when done) ==="
echo "  kubectl -n demo rollout resume deployment demo-transient 2>/dev/null"
echo "  kubectl delete -f demo/transient-crashloop-deployment.yaml"
