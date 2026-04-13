import { dirname } from 'node:path';
import { isScopeRef } from 'faceted-prompting';
import type { WorkflowConfig } from '../../../core/models/index.js';
import { getAttachedWorkflowTrustInfo, getWorkflowSourcePath } from './workflowSourceMetadata.js';
import { getWorkflowTrustInfo, type WorkflowTrustInfo } from './workflowTrustSource.js';
import { loadWorkflowByIdentifier, isWorkflowPath } from './workflowResolver.js';
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

  const parentSourcePath = getWorkflowSourcePath(parentWorkflow) ?? parentContext?.sourcePath;
  const basePath = parentSourcePath ? dirname(parentSourcePath) : lookupCwd;
  const parentTrustInfo = getAttachedWorkflowTrustInfo(parentWorkflow)
    ?? parentContext?.trustInfo
    ?? getWorkflowTrustInfo(parentWorkflow, projectCwd);
  const childWorkflow = loadWorkflowByIdentifier(identifier, projectCwd, {
    basePath,
    lookupCwd,
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
  return childWorkflow;
}
