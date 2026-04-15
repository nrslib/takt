import { dirname } from 'node:path';
import { isScopeRef } from 'faceted-prompting';
import type { WorkflowCallStep, WorkflowConfig } from '../../../core/models/index.js';
import { isWorkflowCallStep } from '../../../core/workflow/step-kind.js';
import { getAttachedWorkflowTrustInfo, getWorkflowSourcePath } from './workflowSourceMetadata.js';
import { validateWorkflowCallRulesAgainstChildReturns } from './workflowCallContracts.js';
import { getWorkflowTrustInfo, type WorkflowTrustInfo } from './workflowTrustSource.js';
import { loadWorkflowByIdentifierForWorkflowCall, isWorkflowPath } from './workflowResolver.js';
import { validateWorkflowCallTrustBoundary } from './workflowTrustBoundary.js';

export interface WorkflowCallParentContext {
  sourcePath?: string;
  trustInfo?: WorkflowTrustInfo;
}

function hasUnsafeNamedWorkflowSegments(identifier: string): boolean {
  return identifier.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..');
}

function validateWorkflowCallNamedIdentifier(identifier: string, stepName: string): void {
  if (hasUnsafeNamedWorkflowSegments(identifier)) {
    throw new Error(`Workflow step "${stepName}" cannot call invalid workflow identifier "${identifier}"`);
  }
}

function getParentWorkflowCallStep(parentWorkflow: WorkflowConfig, stepName: string): WorkflowCallStep {
  const step = parentWorkflow.steps.find((candidate) => candidate.name === stepName);
  if (!step || !isWorkflowCallStep(step)) {
    throw new Error(`workflow_call step "${stepName}" was not found in workflow "${parentWorkflow.name}"`);
  }
  return step;
}

export function resolveWorkflowCallTarget(
  parentWorkflow: WorkflowConfig,
  identifier: string,
  stepName: string,
  projectCwd: string,
  lookupCwd = projectCwd,
  parentContext?: WorkflowCallParentContext,
): WorkflowConfig | null {
  if (!isScopeRef(identifier) && !isWorkflowPath(identifier)) {
    validateWorkflowCallNamedIdentifier(identifier, stepName);
  }

  const parentStep = getParentWorkflowCallStep(parentWorkflow, stepName);
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
  });

  if (!childWorkflow) {
    return null;
  }

  validateWorkflowCallTrustBoundary(
    parentTrustInfo,
    childWorkflow,
    stepName,
    projectCwd,
  );
  validateWorkflowCallRulesAgainstChildReturns(parentStep, childWorkflow);
  return childWorkflow;
}
