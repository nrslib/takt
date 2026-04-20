import type { WorkflowState } from '../../models/types.js';

type WorkflowStateRoot = 'context' | 'structured' | 'effect';
interface ParsedWorkflowStateReference {
  root: WorkflowStateRoot;
  scope: string;
  path: string[];
}

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

function parseWorkflowStateReference(reference: string): ParsedWorkflowStateReference {
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

  if (root === 'effect' && path.length < 2) {
    throw new Error(
      `Effect references must use "effect.<step>.<type>.<field>" format: "${reference}"`,
    );
  }

  return { root, scope, path };
}

function expandPathToken(token: string, reference: string): string[] {
  const parts: string[] = [];
  let remaining = token;

  while (remaining.length > 0) {
    const bracketIndex = remaining.indexOf('[');
    if (bracketIndex < 0) {
      parts.push(remaining);
      break;
    }

    const field = remaining.slice(0, bracketIndex);
    if (field.length > 0) {
      parts.push(field);
    }

    const closingIndex = remaining.indexOf(']', bracketIndex);
    if (closingIndex < 0) {
      throw new Error(`Invalid workflow state reference "${reference}"`);
    }

    parts.push(remaining.slice(bracketIndex + 1, closingIndex));
    remaining = remaining.slice(closingIndex + 1);
  }

  return parts;
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
    if (item == null || typeof item !== 'object' || !(key in item)) {
      throw new Error(`Missing workflow state value "${reference}"`);
    }
    return (item as Record<string, unknown>)[key];
  });
}

export function resolveWorkflowStateReference(reference: string, state: WorkflowState): unknown {
  const { root, scope, path } = parseWorkflowStateReference(reference);

  let current: unknown = resolveWorkflowStateRoot(state, root).get(scope);
  if (current == null) {
    throw new Error(`Missing workflow state scope "${scope}" in ${root}`);
  }

  const tokens = path.flatMap((token) => expandPathToken(token, reference));
  for (const key of tokens) {
    if (!key) {
      throw new Error(`Invalid workflow state reference "${reference}"`);
    }

    if (Array.isArray(current)) {
      current = resolveArrayAccess(current, key, reference);
      continue;
    }

    if (typeof current !== 'object' || current == null || !(key in current)) {
      throw new Error(`Missing workflow state value "${reference}"`);
    }
    current = (current as Record<string, unknown>)[key];
  }

  return current;
}
