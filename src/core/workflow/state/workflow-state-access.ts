import type { WorkflowState } from '../../models/types.js';
import {
  parseWorkflowStateReference,
  type WorkflowStateRoot,
} from '../../models/workflow-state-reference.js';

export function resolveWorkflowStateRoot(
  state: WorkflowState,
  root: Exclude<WorkflowStateRoot, 'findings' | 'companion'>,
): Map<string, Record<string, unknown>> {
  if (root === 'context') {
    return state.systemContexts;
  }
  if (root === 'structured') {
    return state.structuredOutputs;
  }
  return state.effectResults;
}

function resolveArrayAccess(current: unknown[], key: string, reference: string): unknown {
  if (key === 'length') {
    return current.length;
  }

  if (/^\d+$/.test(key)) {
    const index = Number(key);
    if (index < 0 || index >= current.length) {
      throw new Error(`Missing workflow state value "${reference}"`);
    }
    return current[index];
  }

  return current.map((item: unknown) => {
    if (item == null || typeof item !== 'object' || !Object.hasOwn(item, key)) {
      throw new Error(`Missing workflow state value "${reference}"`);
    }
    return (item as Record<string, unknown>)[key];
  });
}

export function resolveWorkflowStateReference(reference: string, state: WorkflowState): unknown {
  const { root, scope, path } = parseWorkflowStateReference(reference);

  let current: unknown;
  if (root === 'findings' || root === 'companion') {
    current = root === 'findings' ? state.findings : state.companion;
    if (current == null) {
      throw new Error(`Missing workflow ${root} state`);
    }
  } else {
    if (!scope) {
      throw new Error(`Invalid workflow state reference "${reference}"`);
    }
    current = resolveWorkflowStateRoot(state, root).get(scope);
  }
  if (current == null) {
    throw new Error(`Missing workflow state scope "${scope}" in ${root}`);
  }

  for (const key of path) {
    if (Array.isArray(current)) {
      current = resolveArrayAccess(current, key, reference);
      continue;
    }

    if (typeof current !== 'object' || current == null || !Object.hasOwn(current, key)) {
      throw new Error(`Missing workflow state value "${reference}"`);
    }
    current = (current as Record<string, unknown>)[key];
  }

  if (Array.isArray(current)) {
    return current.map((item) => (
      item !== null && typeof item === 'object' ? { ...item as Record<string, unknown> } : item
    ));
  }
  return current;
}
