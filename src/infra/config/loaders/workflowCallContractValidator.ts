import { dirname } from 'node:path';
import type { WorkflowConfig } from '../../../core/models/index.js';
import { validateWorkflowCallRulesAgainstChildReturns } from './workflowCallContracts.js';
import { getWorkflowSourcePath } from './workflowSourceMetadata.js';
import { getWorkflowTrustInfo, type WorkflowTrustInfo } from './workflowTrustSource.js';

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

  for (const step of workflow.steps) {
    if (step.kind !== 'workflow_call') {
      continue;
    }
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

    validateWorkflowCallContractsRecursive(
      childWorkflow,
      projectCwd,
      lookupCwd,
      visited,
      deps,
      allowPathBasedCalls,
    );
    validateWorkflowCallRulesAgainstChildReturns(step, childWorkflow);
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
