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

export function findDuplicateWorkflowStepName(steps: readonly unknown[]): DuplicateWorkflowStepName | undefined {
  const stepNames = new Map<string, readonly PropertyKey[]>();
  for (const [stepIndex, step] of steps.entries()) {
    if (!isRecord(step) || typeof step.name !== 'string') continue;
    const stepPath = ['steps', stepIndex];
    const firstStepPath = stepNames.get(step.name);
    if (firstStepPath) return { name: step.name, firstPath: firstStepPath, path: stepPath };
    stepNames.set(step.name, stepPath);
    if (!Array.isArray(step.parallel)) continue;

    const subStepNames = new Map<string, readonly PropertyKey[]>();
    for (const [subStepIndex, subStep] of step.parallel.entries()) {
      if (!isRecord(subStep) || typeof subStep.name !== 'string') continue;
      const subStepPath = ['steps', stepIndex, 'parallel', subStepIndex];
      const firstSubStepPath = subStepNames.get(subStep.name);
      if (firstSubStepPath) {
        return { name: subStep.name, parentName: step.name, firstPath: firstSubStepPath, path: subStepPath };
      }
      subStepNames.set(subStep.name, subStepPath);
    }
  }
  return undefined;
}
