#!/bin/bash
# tt-nanoclaw demo: crash loop that the agent investigates and deletes the pod
#
# Flow:
#   1. Deploy a pod that crashes because /config/app.conf is missing (ConfigMap not mounted)
#   2. Wait for CrashLoopBackOff
#   3. Send alert — agent investigates, sees "config not found" + ConfigMap exists
#   4. Agent deletes the pod
#   5. After agent acts, YOU patch the Deployment to add the mount and verify
#
# Prerequisites:
#   - tt-nanoclaw is deployed and running
#   - Port-forward is active: kubectl -n monitoring port-forward svc/tt-nanoclaw 3000:3000

set -e

KUBECONFIG="${KUBECONFIG:-$HOME/.kube/ci-dev-cluster.yaml}"
export KUBECONFIG

echo "=== Step 1: Deploy crash-looping pod (ConfigMap exists but not mounted) ==="
kubectl apply -f demo/transient-crashloop-deployment.yaml

# Ensure a fresh pod
kubectl -n demo scale deployment demo-transient --replicas=0 2>/dev/null || true
sleep 2
kubectl -n demo scale deployment demo-transient --replicas=1
echo "Waiting for CrashLoopBackOff..."
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
echo "Alert sent. Watch the agent:"
echo "  kubectl -n monitoring logs -f deploy/tt-nanoclaw"
echo ""
echo "=== After the agent deletes the pod, fix the Deployment: ==="
echo ""
echo "  kubectl -n demo patch deployment demo-transient --type=strategic -p '{"
echo '    "spec": {"template": {"spec": {'
echo '      "volumes": [{"name": "config", "configMap": {"name": "demo-app-config"}}],'
echo '      "containers": [{"name": "demo-transient", "volumeMounts": [{"name": "config", "mountPath": "/config"}]}]'
echo "    }}}'"
echo ""
echo "  Then verify: kubectl -n demo get pods -l app=demo-transient"
echo ""
echo "=== Cleanup ==="
echo "  kubectl delete -f demo/transient-crashloop-deployment.yaml"
