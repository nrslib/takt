import type { WorkflowRuleCondition } from '../../models/workflow-rule-condition.js';
import {
  aggregateConditionsOf,
  dynamicParallelAggregateTargetLabel,
  semanticLabelsOf,
} from '../../models/workflow-rule-condition.js';
import type {
  DynamicParallelSubSteps,
  WorkflowStep,
} from '../../models/types.js';
import { isNormalAgentWorkflowStep } from '../../models/types.js';
import { withWorkflowConfigErrorPath } from '../workflow-config-error.js';

type DynamicParallelRole = 'fixed' | 'pool';

function fail(message: string, path: readonly PropertyKey[]): never {
  throw withWorkflowConfigErrorPath(new Error(message), path);
}

function validateParticipant(
  step: WorkflowStep,
  role: DynamicParallelRole,
  parentName: string,
  path: readonly PropertyKey[],
): void {
  if (!isNormalAgentWorkflowStep(step)) {
    fail(
      `Configuration error: dynamic parallel ${role} sub-step "${step.name}" `
      + `of step "${parentName}" must be a normal agent step`,
      path,
    );
  }
  if (role === 'pool' && (typeof step.description !== 'string' || step.description.trim() === '')) {
    fail(
      `Configuration error: dynamic parallel pool sub-step "${step.name}" `
      + `of step "${parentName}" requires a non-empty description`,
      [...path, 'description'],
    );
  }
}

function validateParticipantNames(
  parallel: DynamicParallelSubSteps,
  parentName: string,
  parallelPath: readonly PropertyKey[],
): void {
  const names = new Map<string, readonly PropertyKey[]>();
  for (const role of ['fixed', 'pool'] as const) {
    for (const [index, step] of parallel[role].entries()) {
      const path = [...parallelPath, role, index];
      if (names.has(step.name)) {
        fail(
          `Configuration error: dynamic parallel step "${parentName}" `
          + `contains duplicate sub-step name "${step.name}"`,
          path,
        );
      }
      names.set(step.name, path);
    }
  }
}

function aggregateTargetLabels(
  condition: WorkflowRuleCondition,
  path: readonly PropertyKey[],
): string[] {
  return aggregateConditionsOf(condition).map((aggregate) => {
    const label = dynamicParallelAggregateTargetLabel(aggregate);
    if (label === undefined) {
      fail(
        'Dynamic parallel aggregate conditions require exactly one bare result label',
        path,
      );
    }
    return label;
  });
}

function validateAggregateContracts(
  step: WorkflowStep,
  parallel: DynamicParallelSubSteps,
  stepPath: readonly PropertyKey[],
): void {
  const requiredLabels = new Set((step.rules ?? []).flatMap((rule, index) =>
    aggregateTargetLabels(rule.condition, [...stepPath, 'rules', index, 'condition'])));
  for (const role of ['fixed', 'pool'] as const) {
    for (const [index, subStep] of parallel[role].entries()) {
      const labels = new Set((subStep.rules ?? []).flatMap((rule) => semanticLabelsOf(rule.condition)));
      const missingLabel = [...requiredLabels].find((label) => !labels.has(label));
      if (missingLabel !== undefined) {
        fail(
          `Dynamic parallel step "${step.name}" requires sub-step "${subStep.name}" `
          + `to define result label "${missingLabel}"`,
          [...stepPath, 'parallel', role, index, 'rules'],
        );
      }
    }
  }
}

function validateDynamicParallel(
  step: WorkflowStep,
  parallel: DynamicParallelSubSteps,
  stepPath: readonly PropertyKey[],
): void {
  const parallelPath = [...stepPath, 'parallel'];
  if (!Array.isArray(parallel.fixed)) {
    fail(`Configuration error: dynamic parallel step "${step.name}" requires fixed to be an array`, [
      ...parallelPath,
      'fixed',
    ]);
  }
  if (!Array.isArray(parallel.pool) || parallel.pool.length === 0) {
    fail(`Configuration error: dynamic parallel step "${step.name}" requires at least one pool sub-step`, [
      ...parallelPath,
      'pool',
    ]);
  }
  if (
    typeof parallel.selection !== 'object'
    || parallel.selection === null
    || (parallel.selection.mode !== 'replace' && parallel.selection.mode !== 'cumulative')
  ) {
    fail(
      `Configuration error: dynamic parallel step "${step.name}" selection.mode `
      + 'must be "replace" or "cumulative"',
      [...parallelPath, 'selection', 'mode'],
    );
  }
  for (const [index, fixed] of parallel.fixed.entries()) {
    validateParticipant(fixed, 'fixed', step.name, [...parallelPath, 'fixed', index]);
  }
  for (const [index, pool] of parallel.pool.entries()) {
    validateParticipant(pool, 'pool', step.name, [...parallelPath, 'pool', index]);
  }
  validateParticipantNames(parallel, step.name, parallelPath);
  validateAggregateContracts(step, parallel, stepPath);
}

export function validateDynamicParallelContracts(
  steps: readonly WorkflowStep[],
  parentPath: readonly PropertyKey[],
): void {
  for (const [index, step] of steps.entries()) {
    const stepPath = [...parentPath, index];
    if (step.parallel === undefined) {
      continue;
    }
    if (Array.isArray(step.parallel)) {
      validateDynamicParallelContracts(step.parallel, [...stepPath, 'parallel']);
      continue;
    }
    if (step.parallel.kind !== 'dynamic') {
      fail(`Configuration error: parallel step "${step.name}" has an invalid object form`, [
        ...stepPath,
        'parallel',
      ]);
    }
    validateDynamicParallel(step, step.parallel, stepPath);
  }
}
