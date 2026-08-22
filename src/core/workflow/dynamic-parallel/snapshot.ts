import type { DynamicParallelSelectionSnapshot, DynamicParallelSubSteps, WorkflowStep } from '../../models/types.js';

export function cloneDynamicParallelSelectionSnapshot(
  snapshot: DynamicParallelSelectionSnapshot,
): DynamicParallelSelectionSnapshot {
  return {
    ...snapshot,
    selected_pool_ids: [...snapshot.selected_pool_ids],
    effective_selection_ids: [...snapshot.effective_selection_ids],
  };
}

export function cloneDynamicParallelSelections(
  selections: ReadonlyMap<string, DynamicParallelSelectionSnapshot>,
): Map<string, DynamicParallelSelectionSnapshot> {
  return new Map([...selections].map(([identity, snapshot]) => [
    identity,
    cloneDynamicParallelSelectionSnapshot(snapshot),
  ]));
}

export function resolveDynamicParallelSelection(
  parallel: DynamicParallelSubSteps,
  snapshot: DynamicParallelSelectionSnapshot,
): WorkflowStep[] {
  if (new Set(snapshot.selected_pool_ids).size !== snapshot.selected_pool_ids.length) {
    throw new Error(`Dynamic parallel selection snapshot for "${snapshot.step_name}" contains duplicate pool IDs`);
  }
  const poolIds = new Set(parallel.pool.map((subStep) => subStep.name));
  const unknownPoolId = snapshot.selected_pool_ids.find((id) => !poolIds.has(id));
  if (unknownPoolId !== undefined) {
    throw new Error(`Dynamic parallel selection snapshot for "${snapshot.step_name}" contains unknown pool ID "${unknownPoolId}"`);
  }
  const selected = new Set(snapshot.selected_pool_ids);
  const effective = [...parallel.fixed, ...parallel.pool.filter((subStep) => selected.has(subStep.name))];
  if (effective.length === 0) {
    throw new Error(`Dynamic parallel selection snapshot for "${snapshot.step_name}" has an empty effective selection`);
  }
  if (effective.length !== snapshot.effective_selection_ids.length
    || effective.some((subStep, index) => subStep.name !== snapshot.effective_selection_ids[index])) {
    throw new Error(`Dynamic parallel selection snapshot for "${snapshot.step_name}" has an inconsistent effective selection`);
  }
  return effective;
}

export function createDynamicParallelSelectionSnapshot(
  identity: string,
  stepName: string,
  round: number,
  parallel: DynamicParallelSubSteps,
  selectedPoolIds: readonly string[],
): DynamicParallelSelectionSnapshot {
  const selected = new Set(selectedPoolIds);
  const effective = [...parallel.fixed, ...parallel.pool.filter((subStep) => selected.has(subStep.name))];
  if (effective.length === 0) {
    throw new Error(`Dynamic parallel step "${stepName}" selected no executable sub-steps`);
  }
  return {
    identity,
    step_name: stepName,
    round,
    selected_pool_ids: parallel.pool.filter((subStep) => selected.has(subStep.name)).map((subStep) => subStep.name),
    effective_selection_ids: effective.map((subStep) => subStep.name),
  };
}
