import type { z } from 'zod/v4';
import { WorkflowConfigRawSchema } from '../../../core/models/index.js';
import { isWorkflowParamReference } from './workflowCallableParamRef.js';
import { withWorkflowConfigErrorPath as withWorkflowStepErrorPath } from '../../../core/workflow/workflow-config-error.js';
import { enumerateParallelSubSteps } from './workflowParallelTraversal.js';

type RawWorkflowConfig = z.output<typeof WorkflowConfigRawSchema>;

const RESERVED_WORKFLOW_CALL_RESULTS = new Set(['COMPLETE', 'ABORT']);

export function assertNoParamReferences(steps: RawWorkflowConfig['steps'], parentPath: readonly PropertyKey[] = ['steps']): void {
  for (const [stepIndex, step] of steps.entries()) {
    assertNoParamReferencesInStep(step, [...parentPath, stepIndex]);
  }
}

function assertNoParamReferencesInStep(
  step: RawWorkflowConfig['steps'][number],
  stepPath: readonly PropertyKey[],
): void {
    assertNoParamReferencesInFacetField(step.name, 'policy', step.policy, stepPath);
    assertNoParamReferencesInFacetField(step.name, 'knowledge', step.knowledge, stepPath);
    if (isWorkflowParamReference(step.persona)) {
      throw withWorkflowStepErrorPath(new Error(`Step "${step.name}" cannot use $param in persona outside a callable subworkflow`), [...stepPath, 'persona']);
    }
    if (isWorkflowParamReference(step.instruction)) {
      throw withWorkflowStepErrorPath(new Error(`Step "${step.name}" cannot use $param in instruction outside a callable subworkflow`), [...stepPath, 'instruction']);
    }
    const assertNoParamReferencesInSelector = (
      selector: { persona?: unknown; instruction?: unknown } | undefined,
      selectorPath: readonly PropertyKey[],
    ): void => {
      for (const field of ['persona', 'instruction'] as const) {
        if (!isWorkflowParamReference(selector?.[field])) {
          continue;
        }
        throw withWorkflowStepErrorPath(
          new Error(`Step "${step.name}" cannot use $param in selector.${field} outside a callable subworkflow`),
          [...selectorPath, field],
        );
      }
    };
    assertNoParamReferencesInSelector(
      step.dynamic_facets?.selector,
      [...stepPath, 'dynamic_facets', 'selector'],
    );
    if (step.parallel !== undefined && !Array.isArray(step.parallel)) {
      assertNoParamReferencesInSelector(
        step.parallel.selection.selector,
        [...stepPath, 'parallel', 'selection', 'selector'],
      );
    }
    if (isWorkflowParamReference(step.companion)) {
      throw withWorkflowStepErrorPath(new Error(`Step "${step.name}" cannot use $param in companion outside a callable subworkflow`), [...stepPath, 'companion']);
    }
    if (isWorkflowParamReference(step.call)) {
      throw withWorkflowStepErrorPath(new Error(`Step "${step.name}" cannot use $param in call outside a callable subworkflow`), [...stepPath, 'call']);
    }
    for (const [argName, value] of Object.entries(step.args ?? {})) {
      if (isWorkflowParamReference(value)) {
        throw withWorkflowStepErrorPath(new Error(`Step "${step.name}" cannot use $param in args.${argName} outside a callable subworkflow`), [...stepPath, 'args', argName]);
      }
    }
    for (const [reportIndex, report] of (step.output_contracts?.report ?? []).entries()) {
      if (isWorkflowParamReference(report.format)) {
        throw withWorkflowStepErrorPath(new Error(`Step "${step.name}" cannot use $param in output_contracts.report.${report.name}.format outside a callable subworkflow`), [...stepPath, 'output_contracts', 'report', reportIndex, 'format']);
      }
    }
    if (step.parallel) {
      for (const { subStep, path } of enumerateParallelSubSteps(step.parallel, [...stepPath, 'parallel'])) {
        assertNoParamReferencesInStep(subStep as RawWorkflowConfig['steps'][number], path);
      }
    }
}

function assertNoParamReferencesInFacetField(
  stepName: string,
  fieldName: 'policy' | 'knowledge',
  value: RawWorkflowConfig['steps'][number]['policy'] | RawWorkflowConfig['steps'][number]['knowledge'],
  stepPath: readonly PropertyKey[],
): void {
  const values = Array.isArray(value) ? value : [value];
  for (const [index, entry] of values.entries()) {
    if (!isWorkflowParamReference(entry)) {
      continue;
    }
    const path = Array.isArray(value)
      ? [...stepPath, fieldName, index]
      : [...stepPath, fieldName];
    throw withWorkflowStepErrorPath(
      new Error(`Step "${stepName}" cannot use $param in ${fieldName} outside a callable subworkflow`),
      path,
    );
  }
}

export function validateReturnRules(
  steps: RawWorkflowConfig['steps'],
  isCallable: boolean,
  declaredReturns: Set<string>,
  insideParallel = false,
  parentPath: readonly PropertyKey[] = ['steps'],
): void {
  for (const [stepIndex, step] of steps.entries()) {
    validateReturnRulesInStep(step, [...parentPath, stepIndex], isCallable, declaredReturns, insideParallel);
  }
}

function validateReturnRulesInStep(
  step: RawWorkflowConfig['steps'][number],
  stepPath: readonly PropertyKey[],
  isCallable: boolean,
  declaredReturns: Set<string>,
  insideParallel: boolean,
): void {
    for (const [ruleIndex, rule] of (step.rules ?? []).entries()) {
      const rulePath = [...stepPath, 'rules', ruleIndex];
      if (rule.return !== undefined && rule.next !== undefined) {
        throw withWorkflowStepErrorPath(new Error(`Step "${step.name}" cannot declare both next and return in the same rule`), rulePath);
      }
      if (rule.return === undefined) {
        continue;
      }
      if (insideParallel) {
        throw withWorkflowStepErrorPath(new Error(`Parallel sub-step "${step.name}" cannot use return`), rulePath);
      }
      if (!isCallable) {
        throw withWorkflowStepErrorPath(new Error(`Step "${step.name}" cannot use return outside a callable subworkflow`), rulePath);
      }
      if (RESERVED_WORKFLOW_CALL_RESULTS.has(rule.return)) {
        throw withWorkflowStepErrorPath(new Error(`Step "${step.name}" cannot return reserved value "${rule.return}"`), rulePath);
      }
      if (!declaredReturns.has(rule.return)) {
        throw withWorkflowStepErrorPath(new Error(`Step "${step.name}" returns undeclared value "${rule.return}"`), rulePath);
      }
    }

    if (step.parallel) {
      for (const { subStep, path } of enumerateParallelSubSteps(step.parallel, [...stepPath, 'parallel'])) {
        validateReturnRulesInStep(
          subStep as RawWorkflowConfig['steps'][number],
          path,
          isCallable,
          declaredReturns,
          true,
        );
      }
    }
}
