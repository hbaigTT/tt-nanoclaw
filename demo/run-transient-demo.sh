#!/bin/bash
# tt-nanoclaw demo: transient crash loop that the agent RESOLVES by deleting the pod
#
# Flow:
#   1. Deploy pod with initContainer that seeds a stale lock file
#   2. Main container sees lock → crashes → CrashLoopBackOff
#   3. Patch out the initContainer (so replacement won't get a lock)
#   4. Send alert → agent investigates → sees stale lock → deletes pod
#   5. Replacement pod has no initContainer → no lock → starts clean → Running
#
# Prerequisites:
#   - tt-nanoclaw is deployed and running
#   - Port-forward is active: kubectl -n monitoring port-forward svc/tt-nanoclaw 3000:3000

set -e

KUBECONFIG="${KUBECONFIG:-$HOME/.kube/ci-dev-cluster.yaml}"
export KUBECONFIG

echo "=== Step 1: Deploy crash-looping pod ==="
kubectl apply -f demo/transient-crashloop-deployment.yaml
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
echo "=== Step 3: Remove initContainer so replacement starts clean ==="
kubectl -n demo patch deployment demo-transient --type=json \
  -p='[{"op":"remove","path":"/spec/template/spec/initContainers"}]'
# Pause rollout so K8s doesn't replace the pod before the agent does
kubectl -n demo rollout pause deployment demo-transient
echo "initContainer removed, rollout paused."

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
echo "Expected: agent sees 'stale lock file' → deletes pod → replacement starts clean → Running"
echo ""
echo "After agent deletes the pod, resume rollout:"
echo "  kubectl -n demo rollout resume deployment demo-transient"

echo ""
echo "=== Cleanup (run when done) ==="
echo "  kubectl -n demo rollout resume deployment demo-transient 2>/dev/null"
echo "  kubectl delete -f demo/transient-crashloop-deployment.yaml"
