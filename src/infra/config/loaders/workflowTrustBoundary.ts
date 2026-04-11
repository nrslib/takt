import { resolve } from 'node:path';
import type { WorkflowConfig } from '../../../core/models/index.js';
import { getProjectWorkflowsDir, isPathSafe } from '../paths.js';

interface SystemStepLike {
  name: string;
  mode?: string;
}

export function findPrivilegedSystemStep<T extends SystemStepLike>(steps: T[]): T | undefined {
  return steps.find((step) => step.mode === 'system');
}

export function validateProjectWorkflowTrustBoundaryForSteps(
  steps: SystemStepLike[],
  filePath: string,
  projectCwd: string,
): void {
  const privilegedStep = findPrivilegedSystemStep(steps);
  if (!privilegedStep) {
    return;
  }

  const resolvedProjectWorkflowsDir = resolve(getProjectWorkflowsDir(projectCwd));
  const resolvedPath = resolve(filePath);
  if (isPathSafe(resolvedProjectWorkflowsDir, resolvedPath)) {
    return;
  }

  throw new Error(
    `Project workflow "${filePath}" cannot use privileged system execution in step "${privilegedStep.name}"`,
  );
}

export function validateProjectWorkflowTrustBoundary(
  workflow: WorkflowConfig,
  filePath: string,
  projectCwd: string,
): void {
  const resolvedProjectCwd = resolve(projectCwd);
  const resolvedPath = resolve(filePath);
  if (!isPathSafe(resolvedProjectCwd, resolvedPath)) {
    return;
  }

  validateProjectWorkflowTrustBoundaryForSteps(workflow.steps, filePath, projectCwd);
}
