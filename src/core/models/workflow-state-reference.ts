export type WorkflowStateRoot = 'context' | 'structured' | 'effect' | 'findings';

export interface ParsedWorkflowStateReference {
  root: WorkflowStateRoot;
  scope?: string;
  path: string[];
}

function assertPathSegments(reference: string, segments: readonly string[]): void {
  if (segments.some((segment) => segment.length === 0)) {
    throw new Error(`Invalid workflow state reference "${reference}"`);
  }
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
    if (field.length > 0) parts.push(field);
    const closingIndex = remaining.indexOf(']', bracketIndex);
    if (closingIndex < 0) {
      throw new Error(`Invalid workflow state reference "${reference}"`);
    }

    const bracketValue = remaining.slice(bracketIndex + 1, closingIndex);
    if (!/^\d+$/.test(bracketValue)) {
      throw new Error(`Invalid workflow state reference "${reference}"`);
    }
    parts.push(bracketValue);
    remaining = remaining.slice(closingIndex + 1);
    if (remaining.length > 0 && !remaining.startsWith('[')) {
      throw new Error(`Invalid workflow state reference "${reference}"`);
    }
  }

  return parts;
}

function parsePath(reference: string, segments: readonly string[]): string[] {
  assertPathSegments(reference, segments);
  return segments.flatMap((segment) => expandPathToken(segment, reference));
}

export function parseWorkflowStateReference(reference: string): ParsedWorkflowStateReference {
  const segments = reference.split('.');
  if (segments.length < 2) {
    throw new Error(`Invalid workflow state reference "${reference}"`);
  }

  const [root, scope, ...path] = segments;
  if (root !== 'context' && root !== 'structured' && root !== 'effect' && root !== 'findings') {
    throw new Error(`Unsupported workflow state root "${root}"`);
  }
  if (root === 'findings') {
    const findingsPath = segments.slice(1);
    return { root, path: parsePath(reference, findingsPath) };
  }
  if (!scope) {
    throw new Error(`Invalid workflow state reference "${reference}"`);
  }

  const parsedPath = parsePath(reference, path);
  if (root === 'effect' && path.length < 2) {
    throw new Error(
      `Effect references must use "effect.<step>.<type>.<field>" format: "${reference}"`,
    );
  }

  return { root, scope, path: parsedPath };
}
