import { dirname } from 'node:path';
import type { WorkflowConfig } from '../../../core/models/index.js';
import { canonicalJson } from '../../../shared/utils/canonical-json.js';
import { validateWorkflowCallRulesAgainstChildReturns } from './workflowCallContracts.js';
import { getWorkflowSourcePath } from './workflowSourceMetadata.js';
import { getWorkflowTrustInfo, type WorkflowTrustInfo } from './workflowTrustSource.js';
import { withWorkflowConfigErrorPath as withWorkflowStepErrorPath } from '../../../core/workflow/workflow-config-error.js';
import { findWorkflowStepLocation } from '../../../core/workflow/workflow-step-location.js';
import { annotateWorkflowConfigFragmentError } from './workflowRawParser.js';
import { collectWorkflowCallSteps } from './workflowParallelTraversal.js';

interface WorkflowCallValidationLookupOptions {
  basePath?: string;
  callableArgs?: Record<string, string | string[]>;
  lookupCwd: string;
  parentTrustInfo?: WorkflowTrustInfo;
  skipWorkflowCallContractValidation?: boolean;
}

interface ValidateWorkflowCallContractsDeps {
  isWorkflowPath: (identifier: string) => boolean;
  loadWorkflowByIdentifierForWorkflowCall: (
    identifier: string,
    projectCwd: string,
    options: WorkflowCallValidationLookupOptions,
  ) => WorkflowConfig | null;
}

interface WorkflowCallContractValidationOptions {
  allowPathBasedCalls?: boolean;
  lookupCwd?: string;
}

interface WorkflowCallContractValidationTraversal {
  active: Set<string>;
  completed: Set<string>;
}

function getWorkflowCallInvocationIdentity(
  call: string,
  args: Record<string, string | string[]> | undefined,
): string {
  return canonicalJson({ call, args: args ?? {} });
}

function getWorkflowCallValidationKey(
  workflow: WorkflowConfig,
  lookupCwd: string,
  inheritedFindingContractAvailable: boolean,
  invocationIdentity: string,
): string {
  const sourcePath = getWorkflowSourcePath(workflow);
  const workflowKey = sourcePath ?? `${lookupCwd}:${workflow.name}`;
  return canonicalJson({
    findingContractAvailable: inheritedFindingContractAvailable,
    invocation: invocationIdentity,
    workflow: workflowKey,
  });
}

function validateWorkflowCallContractsRecursive(
  workflow: WorkflowConfig,
  projectCwd: string,
  lookupCwd: string,
  traversal: WorkflowCallContractValidationTraversal,
  deps: ValidateWorkflowCallContractsDeps,
  allowPathBasedCalls: boolean,
  inheritedFindingContractAvailable: boolean,
  invocationIdentity: string,
): void {
  const validationKey = getWorkflowCallValidationKey(
    workflow,
    lookupCwd,
    inheritedFindingContractAvailable,
    invocationIdentity,
  );
  if (traversal.completed.has(validationKey)) {
    return;
  }
  if (traversal.active.has(validationKey)) {
    throw new Error(
      `Configuration error: recursive workflow_call cycle detected at workflow "${workflow.name}"`,
    );
  }
  traversal.active.add(validationKey);

  try {
    const parentSourcePath = getWorkflowSourcePath(workflow);
    const basePath = parentSourcePath ? dirname(parentSourcePath) : lookupCwd;
    const parentTrustInfo = getWorkflowTrustInfo(workflow, projectCwd);

    for (const step of collectWorkflowCallSteps(workflow.steps)) {
      const stepPath = findWorkflowStepLocation(workflow, step);
      if (!allowPathBasedCalls && deps.isWorkflowPath(step.call)) {
        continue;
      }

      const childWorkflow = deps.loadWorkflowByIdentifierForWorkflowCall(step.call, projectCwd, {
        basePath,
        lookupCwd,
        callableArgs: step.args,
        parentTrustInfo,
        skipWorkflowCallContractValidation: true,
      });

      if (!childWorkflow) {
        continue;
      }

      const parentProvidesFindingContract = inheritedFindingContractAvailable
        || workflow.findingContract !== undefined
        || workflow.subworkflow?.requiresFindingContract === true;
      if (childWorkflow.subworkflow?.requiresFindingContract === true && !parentProvidesFindingContract) {
        const error = new Error(
          `Configuration error: workflow_call step "${step.name}" calls workflow "${childWorkflow.name}", `
          + 'which requires a finding_contract inherited from its caller, but the calling workflow does not provide one',
        );
        throw annotateWorkflowConfigFragmentError(
          stepPath ? withWorkflowStepErrorPath(error, [...stepPath, 'call']) : error,
          workflow,
        );
      }

      validateWorkflowCallContractsRecursive(
        childWorkflow,
        projectCwd,
        lookupCwd,
        traversal,
        deps,
        allowPathBasedCalls,
        parentProvidesFindingContract,
        getWorkflowCallInvocationIdentity(step.call, step.args),
      );
      try {
        validateWorkflowCallRulesAgainstChildReturns(step, childWorkflow, stepPath);
      } catch (error) {
        throw annotateWorkflowConfigFragmentError(error, workflow);
      }
    }
    traversal.completed.add(validationKey);
  } finally {
    traversal.active.delete(validationKey);
  }
}

export function validateWorkflowCallContracts(
  workflow: WorkflowConfig,
  projectCwd: string,
  deps: ValidateWorkflowCallContractsDeps,
  options?: WorkflowCallContractValidationOptions,
): void {
  validateWorkflowCallContractsRecursive(
    workflow,
    projectCwd,
    options?.lookupCwd ?? projectCwd,
    { active: new Set<string>(), completed: new Set<string>() },
    deps,
    options?.allowPathBasedCalls !== false,
    false,
    canonicalJson({ root: true }),
  );
}
