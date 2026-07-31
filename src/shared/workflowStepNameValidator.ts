type RawStep = Record<string, unknown>;

export interface DuplicateWorkflowStepName {
  name: string;
  parentName?: string;
  firstPath: readonly PropertyKey[];
  path: readonly PropertyKey[];
}

function isRecord(value: unknown): value is RawStep {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function enumerateParallelStepNames(
  parallel: unknown,
  parentPath: readonly PropertyKey[],
): Array<{ step: RawStep; path: readonly PropertyKey[] }> {
  if (Array.isArray(parallel)) {
    return parallel.flatMap((step, index) =>
      isRecord(step) ? [{ step, path: [...parentPath, index] }] : []);
  }
  if (!isRecord(parallel)) {
    return [];
  }
  return (['fixed', 'pool'] as const).flatMap((branch) => {
    const entries = parallel[branch];
    return Array.isArray(entries)
      ? entries.flatMap((step, index) =>
        isRecord(step) ? [{ step, path: [...parentPath, branch, index] }] : [])
      : [];
  });
}

export function findDuplicateWorkflowStepName(steps: readonly unknown[]): DuplicateWorkflowStepName | undefined {
  const stepNames = new Map<string, readonly PropertyKey[]>();
  for (const [stepIndex, step] of steps.entries()) {
    if (!isRecord(step) || typeof step.name !== 'string') continue;
    const stepPath = ['steps', stepIndex];
    const firstStepPath = stepNames.get(step.name);
    if (firstStepPath) return { name: step.name, firstPath: firstStepPath, path: stepPath };
    stepNames.set(step.name, stepPath);
    const subStepNames = new Map<string, readonly PropertyKey[]>();
    for (const { step: subStep, path: subStepPath } of enumerateParallelStepNames(
      step.parallel,
      ['steps', stepIndex, 'parallel'],
    )) {
      if (typeof subStep.name !== 'string') continue;
      const firstSubStepPath = subStepNames.get(subStep.name);
      if (firstSubStepPath) {
        return { name: subStep.name, parentName: step.name, firstPath: firstSubStepPath, path: subStepPath };
      }
      subStepNames.set(subStep.name, subStepPath);
    }
  }
  return undefined;
}
