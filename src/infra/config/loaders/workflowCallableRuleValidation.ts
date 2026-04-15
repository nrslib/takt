import type { z } from 'zod/v4';
import { WorkflowConfigRawSchema } from '../../../core/models/index.js';
import { isWorkflowParamReference } from './workflowCallableParamRef.js';

type RawWorkflowConfig = z.output<typeof WorkflowConfigRawSchema>;

const RESERVED_WORKFLOW_CALL_RESULTS = new Set(['COMPLETE', 'ABORT']);

export function assertNoParamReferences(steps: RawWorkflowConfig['steps']): void {
  for (const step of steps) {
    if (isWorkflowParamReference(step.policy)) {
      throw new Error(`Step "${step.name}" cannot use $param in policy outside a callable subworkflow`);
    }
    if (isWorkflowParamReference(step.knowledge)) {
      throw new Error(`Step "${step.name}" cannot use $param in knowledge outside a callable subworkflow`);
    }
    if (isWorkflowParamReference(step.instruction)) {
      throw new Error(`Step "${step.name}" cannot use $param in instruction outside a callable subworkflow`);
    }
    for (const report of step.output_contracts?.report ?? []) {
      if (isWorkflowParamReference(report.format)) {
        throw new Error(`Step "${step.name}" cannot use $param in output_contracts.report.${report.name}.format outside a callable subworkflow`);
      }
    }
    if (step.parallel) {
      assertNoParamReferences(step.parallel as RawWorkflowConfig['steps']);
    }
  }
}

export function validateReturnRules(
  steps: RawWorkflowConfig['steps'],
  isCallable: boolean,
  declaredReturns: Set<string>,
  insideParallel = false,
): void {
  for (const step of steps) {
    for (const rule of step.rules ?? []) {
      if (rule.return !== undefined && rule.next !== undefined) {
        throw new Error(`Step "${step.name}" cannot declare both next and return in the same rule`);
      }
      if (rule.return === undefined) {
        continue;
      }
      if (insideParallel) {
        throw new Error(`Parallel sub-step "${step.name}" cannot use return`);
      }
      if (!isCallable) {
        throw new Error(`Step "${step.name}" cannot use return outside a callable subworkflow`);
      }
      if (RESERVED_WORKFLOW_CALL_RESULTS.has(rule.return)) {
        throw new Error(`Step "${step.name}" cannot return reserved value "${rule.return}"`);
      }
      if (!declaredReturns.has(rule.return)) {
        throw new Error(`Step "${step.name}" returns undeclared value "${rule.return}"`);
      }
    }

    if (step.parallel) {
      validateReturnRules(step.parallel as RawWorkflowConfig['steps'], isCallable, declaredReturns, true);
    }
  }
}
