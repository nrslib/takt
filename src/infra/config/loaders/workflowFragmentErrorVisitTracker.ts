const visitedContexts = new WeakMap<Error, Set<string>>();

export type WorkflowFragmentErrorVisitKind = 'raw' | 'normalized';

function contextKey(kind: WorkflowFragmentErrorVisitKind, workflowPath: string): string {
  return `${kind}:${workflowPath}`;
}

export function hasVisitedWorkflowErrorContext(
  error: Error,
  kind: WorkflowFragmentErrorVisitKind,
  workflowPath: string,
): boolean {
  return visitedContexts.get(error)?.has(contextKey(kind, workflowPath)) === true;
}

export function markVisitedWorkflowErrorContext(
  source: Error | undefined,
  target: Error,
  kind: WorkflowFragmentErrorVisitKind,
  workflowPath: string,
): void {
  const contexts = new Set(source === undefined ? undefined : visitedContexts.get(source));
  contexts.add(contextKey(kind, workflowPath));
  visitedContexts.set(target, contexts);
}
