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
  'demo',
];
const ALLOWED_DELETE_RESOURCES = ['pods'];

function validateNamespace(namespace: string): void {
  if (!ALLOWED_NAMESPACES.includes(namespace)) {
    throw new Error(
      `Namespace "${namespace}" not allowed. Allowed: ${ALLOWED_NAMESPACES.join(', ')}`,
    );
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
