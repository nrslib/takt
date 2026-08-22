import { dirname } from 'node:path';
import type {
  WorkflowCallArgValue,
  WorkflowConfig,
} from '../../../core/models/index.js';
import { canonicalJson } from '../../../shared/utils/canonical-json.js';
import { validateWorkflowCallRulesAgainstChildReturns } from './workflowCallContracts.js';
import { getWorkflowSourcePath } from './workflowSourceMetadata.js';
import { getWorkflowTrustInfo, type WorkflowTrustInfo } from './workflowTrustSource.js';
import { findWorkflowStepLocation } from '../../../core/workflow/workflow-step-location.js';
import { annotateWorkflowConfigFragmentError } from './workflowRawParser.js';
import { collectWorkflowCallSteps } from './workflowParallelTraversal.js';

interface WorkflowCallValidationLookupOptions {
  basePath?: string;
  callableArgs?: Record<string, WorkflowCallArgValue>;
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
  args: Record<string, WorkflowCallArgValue> | undefined,
): string {
  return canonicalJson({ call, args: args ?? {} });
}

function getWorkflowCallValidationKey(
  workflow: WorkflowConfig,
  lookupCwd: string,
  invocationIdentity: string,
): string {
  const workflowKey = getWorkflowSourcePath(workflow) ?? `${lookupCwd}:${workflow.name}`;
  return canonicalJson({ invocation: invocationIdentity, workflow: workflowKey });
}

function validateWorkflowCallContractsRecursive(
  workflow: WorkflowConfig,
  projectCwd: string,
  lookupCwd: string,
  traversal: WorkflowCallContractValidationTraversal,
  deps: ValidateWorkflowCallContractsDeps,
  allowPathBasedCalls: boolean,
  invocationIdentity: string,
): void {
  const validationKey = getWorkflowCallValidationKey(workflow, lookupCwd, invocationIdentity);
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

      validateWorkflowCallContractsRecursive(
        childWorkflow,
        projectCwd,
        lookupCwd,
        traversal,
        deps,
        allowPathBasedCalls,
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
    canonicalJson({ root: true }),
  );
}
