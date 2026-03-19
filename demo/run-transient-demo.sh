#!/bin/bash
# tt-nanoclaw demo: transient crash loop that the agent RESOLVES by deleting the pod
#
# Flow:
#   1. Deploy a pod that crashes because /config/app.conf is missing
#   2. Wait for CrashLoopBackOff
#   3. Patch the Deployment to mount the ConfigMap
#   4. Send alert — agent investigates, sees config is now available, deletes pod
#   5. Replacement pod mounts the ConfigMap and starts successfully
#
# Prerequisites:
#   - tt-nanoclaw is deployed and running
#   - Port-forward is active: kubectl -n monitoring port-forward svc/tt-nanoclaw 3000:3000

set -e

KUBECONFIG="${KUBECONFIG:-$HOME/.kube/ci-dev-cluster.yaml}"
export KUBECONFIG

echo "=== Step 1: Deploy crash-looping pod (missing config mount) ==="
kubectl apply -f demo/transient-crashloop-deployment.yaml
echo "Waiting for pod to enter CrashLoopBackOff..."
sleep 30

echo ""
echo "=== Step 2: Verify pod is crash looping ==="
kubectl -n demo get pods -l app=demo-transient
POD_NAME=$(kubectl -n demo get pods -l app=demo-transient -o jsonpath='{.items[0].metadata.name}')
echo "Pod: $POD_NAME"

echo ""
echo "=== Step 3: Patch deployment to mount ConfigMap (simulates fix becoming available) ==="
kubectl -n demo patch deployment demo-transient --type=json -p='[
  {"op":"add","path":"/spec/template/spec/volumes","value":[{"name":"config","configMap":{"name":"demo-app-config"}}]},
  {"op":"add","path":"/spec/template/spec/containers/0/volumeMounts","value":[{"name":"config","mountPath":"/config"}]}
]'
echo "ConfigMap mount added. The CURRENT pod is still crashing (old spec)."
echo "When the agent deletes it, the replacement will use the patched spec."

echo ""
echo "=== Step 4: Send alert to tt-nanoclaw ==="
# Get the current crashing pod name (it might have changed after patch)
POD_NAME=$(kubectl -n demo get pods -l app=demo-transient --field-selector=status.phase!=Succeeded -o jsonpath='{.items[0].metadata.name}')
FIXTURE=$(cat test/fixtures/demo-crashloop-alert.json | sed "s/REPLACE_WITH_ACTUAL_POD_NAME/$POD_NAME/g" | sed "s/demo-app/demo-transient/g")
echo "$FIXTURE" | curl -s -X POST http://localhost:3000/webhook/alertmanager \
  -H 'Content-Type: application/json' \
  -d @-
echo ""
echo "Alert sent. Watch the agent work:"
echo "  kubectl -n monitoring logs -f deploy/tt-nanoclaw"
echo ""
echo "Expected: agent investigates → sees config file error → sees ConfigMap exists →"
echo "          deletes pod → replacement mounts ConfigMap → Running"

echo ""
echo "=== Cleanup (run when done) ==="
echo "  kubectl delete -f demo/transient-crashloop-deployment.yaml"
