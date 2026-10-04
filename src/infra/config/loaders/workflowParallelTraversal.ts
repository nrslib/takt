import type { WorkflowCallStep, WorkflowConfig, WorkflowStep } from '../../../core/models/types.js';
import { isWorkflowCallStep } from '../../../core/workflow/step-kind.js';

export interface ParallelSubStepEntry<T> {
  readonly subStep: T;
  readonly path: readonly PropertyKey[];
}

export function enumerateRawParallelSubSteps(
  parallel: unknown,
  parallelPath: readonly PropertyKey[],
): ParallelSubStepEntry<unknown>[] {
  if (Array.isArray(parallel)) {
    return parallel.map((subStep, index) => ({ subStep, path: [...parallelPath, index] }));
  }
  if (typeof parallel !== 'object' || parallel === null) {
    return [];
  }
  const dynamic = parallel as Record<string, unknown>;
  return (['fixed', 'pool'] as const).flatMap((branch) => {
    const entries = dynamic[branch];
    return Array.isArray(entries)
      ? entries.map((subStep, index) => ({ subStep, path: [...parallelPath, branch, index] }))
      : [];
  });
}

type DynamicParallelLike = {
  readonly fixed: readonly unknown[];
  readonly pool: readonly unknown[];
};

type ParallelSubStep<T> = T extends readonly (infer Element)[]
  ? Element
  : T extends DynamicParallelLike
    ? T['fixed'][number] | T['pool'][number]
    : never;

export function enumerateParallelSubSteps<T extends readonly unknown[] | DynamicParallelLike>(
  parallel: T,
  parallelPath: readonly PropertyKey[],
): ParallelSubStepEntry<ParallelSubStep<T>>[] {
  if (Array.isArray(parallel)) {
    return parallel.map((subStep, index) => ({
      subStep: subStep as ParallelSubStep<T>,
      path: [...parallelPath, index],
    }));
  }

  const dynamicParallel = parallel as DynamicParallelLike;
  return (['fixed', 'pool'] as const).flatMap((branch) => dynamicParallel[branch].map((subStep, index) => ({
    subStep: subStep as ParallelSubStep<T>,
    path: [...parallelPath, branch, index],
  })));
}

export function collectWorkflowCallSteps(
  steps: readonly WorkflowStep[],
): WorkflowCallStep[] {
  const calls: WorkflowCallStep[] = [];
  const pending = [...steps];
  while (pending.length > 0) {
    const step = pending.shift()!;
    if (isWorkflowCallStep(step)) {
      calls.push(step);
    }
    if (step.parallel !== undefined) {
      pending.unshift(...enumerateParallelSubSteps(step.parallel, []).map(({ subStep }) => subStep));
    }
  }
  return calls;
}

export function collectReachableSteps(workflow: WorkflowConfig): WorkflowStep[] {
  const stepsByName = new Map(workflow.steps.map((step) => [step.name, step]));
  const visited = new Set<string>();
  const pending = [workflow.initialStep];
  const reachable: WorkflowStep[] = [];
  while (pending.length > 0) {
    const name = pending.shift();
    if (name === undefined || visited.has(name)) continue;
    visited.add(name);
    const step = stepsByName.get(name);
    if (step === undefined) continue;
    reachable.push(step);
    for (const next of step.rules?.map((rule) => rule.next) ?? []) {
      if (next !== undefined && stepsByName.has(next) && !visited.has(next)) pending.push(next);
    }
    for (const monitor of workflow.loopMonitors ?? []) {
      if (!monitor.cycle.includes(name)) continue;
      for (const rule of monitor.judge.rules) {
        if (stepsByName.has(rule.next) && !visited.has(rule.next)) pending.push(rule.next);
      }
    }
  }
  return reachable;
}

export function collectReachableWorkflowCallSteps(workflow: WorkflowConfig): WorkflowCallStep[] {
  return collectWorkflowCallSteps(collectReachableSteps(workflow));
}
