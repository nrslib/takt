import { dirname } from 'node:path';
import { isScopeRef } from 'faceted-prompting';
import type { WorkflowCallStep, WorkflowConfig } from '../../../core/models/index.js';
import { getAttachedWorkflowTrustInfo, getWorkflowSourcePath } from './workflowSourceMetadata.js';
import { validateWorkflowCallRulesAgainstChildReturns } from './workflowCallContracts.js';
import { getWorkflowTrustInfo, type WorkflowTrustInfo } from './workflowTrustSource.js';
import { loadWorkflowByIdentifierForWorkflowCall, isWorkflowPath } from './workflowResolver.js';
import { validateWorkflowCallTrustBoundary } from './workflowTrustBoundary.js';
import { annotateWorkflowConfigFragmentError } from './workflowRawParser.js';
import { withWorkflowConfigErrorPath as withWorkflowStepErrorPath } from '../../../core/workflow/workflow-config-error.js';
import { findWorkflowStepLocation } from '../../../core/workflow/workflow-step-location.js';

export interface WorkflowCallParentContext {
  sourcePath?: string;
  trustInfo?: WorkflowTrustInfo;
  resourceRoot?: string;
}

function hasUnsafeNamedWorkflowSegments(identifier: string): boolean {
  return identifier.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..');
}

function validateWorkflowCallNamedIdentifier(identifier: string, stepName: string): void {
  if (hasUnsafeNamedWorkflowSegments(identifier)) {
    throw new Error(`Workflow step "${stepName}" cannot call invalid workflow identifier "${identifier}"`);
  }
}

export function resolveWorkflowCallTarget(
  parentWorkflow: WorkflowConfig,
  parentStep: WorkflowCallStep,
  projectCwd: string,
  lookupCwd = projectCwd,
  parentContext?: WorkflowCallParentContext,
): WorkflowConfig | null {
  const stepPath = findWorkflowStepLocation(parentWorkflow, parentStep);
  const decorateParentError = (error: unknown): Error => {
    const located = stepPath ? withWorkflowStepErrorPath(error, [...stepPath, 'call']) : error;
    return annotateWorkflowConfigFragmentError(located, parentWorkflow);
  };

  const stepName = parentStep.name;
  const identifier = parentStep.call;
  if (!isScopeRef(identifier) && !isWorkflowPath(identifier)) {
    try {
      validateWorkflowCallNamedIdentifier(identifier, stepName);
    } catch (error) {
      throw decorateParentError(error);
    }
  }

  const parentSourcePath = getWorkflowSourcePath(parentWorkflow) ?? parentContext?.sourcePath;
  const basePath = parentSourcePath ? dirname(parentSourcePath) : lookupCwd;
  const parentTrustInfo = getAttachedWorkflowTrustInfo(parentWorkflow)
    ?? parentContext?.trustInfo
    ?? getWorkflowTrustInfo(parentWorkflow, projectCwd);
  const childWorkflow = loadWorkflowByIdentifierForWorkflowCall(identifier, projectCwd, {
    basePath,
    lookupCwd,
    callableArgs: parentStep.args,
    parentTrustInfo,
    skipWorkflowCallContractValidation: true,
    resourceRoot: parentContext?.resourceRoot,
  });

  if (!childWorkflow) return null;

  try {
    validateWorkflowCallTrustBoundary(parentTrustInfo, childWorkflow, stepName, projectCwd);
    validateWorkflowCallRulesAgainstChildReturns(parentStep, childWorkflow, stepPath);
    return childWorkflow;
  } catch (error) {
    throw decorateParentError(error);
  }
}
