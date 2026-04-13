export interface WorkflowStepScopeEntry {
  workflow: string;
  workflow_ref?: string;
  step: string;
  kind: 'agent' | 'system' | 'workflow_call';
}

function normalizeWorkflowStepScope(
  stack: ReadonlyArray<WorkflowStepScopeEntry> | undefined,
): WorkflowStepScopeEntry[] {
  return (stack ?? []).map((entry) => ({
    workflow: entry.workflow,
    ...(entry.workflow_ref ? { workflow_ref: entry.workflow_ref } : {}),
    step: entry.step,
    kind: entry.kind,
  }));
}

export function buildWorkflowStepScopeKey(
  step: string,
  stack: ReadonlyArray<WorkflowStepScopeEntry> | undefined,
): string {
  return JSON.stringify({
    step,
    stack: normalizeWorkflowStepScope(stack),
  });
}
