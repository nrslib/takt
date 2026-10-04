export interface WorkflowTargetContext {
  workflowName?: string;
}

export function resolveWorkflowStepTarget<T>(
  targets: Record<string, T> | undefined,
  stepName: string | undefined,
  workflowName: string | undefined,
): T | undefined {
  if (targets === undefined || stepName === undefined) {
    return undefined;
  }
  const qualifiedName = workflowName === undefined
    ? undefined
    : `${workflowName}/${stepName}`;
  if (qualifiedName !== undefined && Object.hasOwn(targets, qualifiedName)) {
    return targets[qualifiedName];
  }
  return Object.hasOwn(targets, stepName) ? targets[stepName] : undefined;
}

export function withWorkflowTargetContext<T extends object>(
  config: T | undefined,
  workflowName: string,
): (T & WorkflowTargetContext) | undefined {
  return config === undefined ? undefined : { ...config, workflowName };
}
