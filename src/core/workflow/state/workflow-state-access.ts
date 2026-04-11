import type { WorkflowState } from '../../models/types.js';

type WorkflowStateRoot = 'context' | 'structured' | 'effect';

export function resolveWorkflowStateRoot(
  state: WorkflowState,
  root: WorkflowStateRoot,
): Map<string, Record<string, unknown>> {
  if (root === 'context') {
    return state.systemContexts;
  }
  if (root === 'structured') {
    return state.structuredOutputs;
  }
  return state.effectResults;
}

export function resolveWorkflowStateReference(reference: string, state: WorkflowState): unknown {
  const segments = reference.split('.');
  if (segments.length < 2) {
    throw new Error(`Invalid workflow state reference "${reference}"`);
  }

  const [root, scope, ...path] = segments;
  if (root !== 'context' && root !== 'structured' && root !== 'effect') {
    throw new Error(`Unsupported workflow state root "${root}"`);
  }
  if (!scope) {
    throw new Error(`Invalid workflow state reference "${reference}"`);
  }

  let current: unknown = resolveWorkflowStateRoot(state, root).get(scope);
  if (current == null) {
    throw new Error(`Missing workflow state scope "${scope}" in ${root}`);
  }

  for (const key of path) {
    if (!key) {
      throw new Error(`Invalid workflow state reference "${reference}"`);
    }
    if (typeof current !== 'object' || current == null || Array.isArray(current) || !(key in current)) {
      throw new Error(`Missing workflow state value "${reference}"`);
    }
    current = (current as Record<string, unknown>)[key];
  }

  return current;
}
