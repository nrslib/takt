import { dirname } from 'node:path';
import type { WorkflowConfig } from '../../../core/models/index.js';
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

function getWorkflowCallValidationKey(workflow: WorkflowConfig, lookupCwd: string): string {
  const sourcePath = getWorkflowSourcePath(workflow);
  if (sourcePath) {
    return sourcePath;
  }
  return `${lookupCwd}:${workflow.name}`;
}

function validateWorkflowCallContractsRecursive(
  workflow: WorkflowConfig,
  projectCwd: string,
  lookupCwd: string,
  visited: Set<string>,
  deps: ValidateWorkflowCallContractsDeps,
  allowPathBasedCalls: boolean,
): void {
  const validationKey = getWorkflowCallValidationKey(workflow, lookupCwd);
  if (visited.has(validationKey)) {
    return;
  }
  visited.add(validationKey);

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

    const parentProvidesFindingContract = workflow.findingContract !== undefined
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
      visited,
      deps,
      allowPathBasedCalls,
    );
    try {
      validateWorkflowCallRulesAgainstChildReturns(step, childWorkflow, stepPath);
    } catch (error) {
      throw annotateWorkflowConfigFragmentError(error, workflow);
    }
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
    new Set<string>(),
    deps,
    options?.allowPathBasedCalls !== false,
  );
}
