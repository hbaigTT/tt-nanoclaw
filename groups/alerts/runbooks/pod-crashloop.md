# Runbook: KubePodCrashLooping

This alert fires when a pod is repeatedly crashing and restarting. Sometimes a simple restart fixes transient issues (OOM spike, dependency that was temporarily down). Other times the crash is structural and a restart won't help.

## Step 1: Get the pod details

The alert labels contain `pod` and `namespace`. Get the pod's current state:
```
kubectl_get(resource="pods", name="<pod-name>", namespace="<namespace>", output="wide")
```

## Step 2: Check events

```
kubectl_describe(resource="pod", name="<pod-name>", namespace="<namespace>")
```

Look for:
- **OOMKilled** — the container ran out of memory. A restart may help if it was a transient spike.
- **ImagePullBackOff** — the image can't be pulled. Do NOT restart — this is structural.
- **CrashLoopBackOff** with exit code — check what the exit code means.
- **Pending PVC / volume mount errors** — structural, do NOT restart.
- **Missing ConfigMap or Secret** — structural, do NOT restart.

## Step 3: Check logs

Get the logs from the previous crashed container:
```
kubectl_logs(pod="<pod-name>", namespace="<namespace>", previous=true, tail=200)
```

Also get current logs if the container is in a restart cycle:
```
kubectl_logs(pod="<pod-name>", namespace="<namespace>", tail=200)
```

Look for the root cause: connection refused errors (transient), config errors (structural), out of memory (transient), missing dependencies (structural).

## Step 4: Trace dependencies

If the logs show the pod can't reach a dependency (connection refused, DNS failure, timeout):
1. Identify the dependency from the error (e.g., `harbor-core:80`, `db.demo.svc:5432`)
2. Check the dependency's pods: `kubectl_get(resource="pods", namespace="<ns>", labels="<app-label>")`
3. If the dependency is also failing, investigate it — describe it, check its logs and events
4. Continue tracing until you find the root cause (it may be 2-3 levels deep)

## Step 5: Decide

**Delete the pod (transient issues):**
- OOMKilled and the memory limit looks reasonable
- Connection refused to a dependency that is now healthy
- Race condition or startup ordering issue
- Pod has restarted many times and error looks intermittent

**Escalate (structural issues):**
- ImagePullBackOff — image doesn't exist or registry is unreachable
- Missing ConfigMap, Secret, or PVC
- Every restart produces the exact same error with no variation
- Configuration error in the container spec
- Pod is Pending (not crash looping — waiting for resources)

## Step 6: Act

If deleting:
```
kubectl_delete(resource="pods", name="<pod-name>", namespace="<namespace>")
```

Then wait a few seconds and verify the replacement pod:
```
kubectl_get(resource="pods", name="<pod-name-prefix>", namespace="<namespace>")
```

Note: the new pod will have a different name (the Deployment/StatefulSet creates a new one). Look for a pod with the same prefix in Running state.
