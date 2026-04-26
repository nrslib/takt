import type { WorkflowConfig } from '../../../core/models/index.js';
import { getWorkflowStepKind } from '../../../core/models/workflow-step-kind.js';
import { getWorkflowSourcePath } from './workflowSourceMetadata.js';
import { getWorkflowTrustInfo, type WorkflowTrustInfo } from './workflowTrustSource.js';

type SystemStepLike = Parameters<typeof getWorkflowStepKind>[0] & {
  name: string;
  allowGitCommit?: boolean;
  parallel?: SystemStepLike[];
};

type PrivilegedCapability =
  | { step: SystemStepLike; reason: 'system' }
  | { step: SystemStepLike; reason: 'allow_git_commit' };

function hasPrivilegedRuntimePrepare(workflow: WorkflowConfig): boolean {
  return (workflow.runtime?.prepare?.length ?? 0) > 0;
}

function findPrivilegedAllowGitCommitStep(steps: SystemStepLike[]): SystemStepLike | undefined {
  for (const step of steps) {
    if (step.allowGitCommit === true) {
      return step;
    }
    const privilegedParallelStep = step.parallel
      ? findPrivilegedAllowGitCommitStep(step.parallel)
      : undefined;
    if (privilegedParallelStep) {
      return privilegedParallelStep;
    }
  }
  return undefined;
}

function findPrivilegedCapability(steps: SystemStepLike[]): PrivilegedCapability | undefined {
  const privilegedSystemStep = findPrivilegedSystemStep(steps);
  if (privilegedSystemStep) {
    return { step: privilegedSystemStep, reason: 'system' };
  }

  const privilegedAllowGitCommitStep = findPrivilegedAllowGitCommitStep(steps);
  if (privilegedAllowGitCommitStep) {
    return { step: privilegedAllowGitCommitStep, reason: 'allow_git_commit' };
  }

  return undefined;
}

function buildPrivilegedExecutionError(filePath: string, capability: PrivilegedCapability, scope: 'workflow' | 'project'): Error {
  if (capability.reason === 'system') {
    const subject = scope === 'project' ? 'Project workflow' : 'Workflow';
    return new Error(
      `${subject} "${filePath}" cannot use privileged system execution in step "${capability.step.name}" outside the project workflows root`,
    );
  }

  const subject = scope === 'project' ? 'Project workflow' : 'Workflow';
  return new Error(
    `${subject} "${filePath}" cannot use allow_git_commit in step "${capability.step.name}" outside the project workflows root`,
  );
}

function validateWorkflowExecutionTrustBoundaryInternal(
  workflow: WorkflowConfig,
  filePath: string,
  trustInfo: Pick<WorkflowTrustInfo, 'isProjectWorkflowRoot'>,
): void {
  const privilegedCapability = findPrivilegedCapability(workflow.steps);
  if (privilegedCapability && !trustInfo.isProjectWorkflowRoot) {
    throw buildPrivilegedExecutionError(filePath, privilegedCapability, 'workflow');
  }

  if (hasPrivilegedRuntimePrepare(workflow) && !trustInfo.isProjectWorkflowRoot) {
    throw new Error(
      `Workflow "${filePath}" cannot use workflow-level runtime.prepare outside the project workflows root`,
    );
  }
}

export function findPrivilegedSystemStep<T extends SystemStepLike>(steps: T[]): T | undefined {
  return steps.find((step) => getWorkflowStepKind(step) === 'system');
}

export function validateProjectWorkflowTrustBoundaryForSteps(
  steps: SystemStepLike[],
  filePath: string,
  trustInfo: Pick<WorkflowTrustInfo, 'isProjectWorkflowRoot'>,
): void {
  const privilegedCapability = findPrivilegedCapability(steps);
  if (!privilegedCapability) {
    return;
  }

  if (trustInfo.isProjectWorkflowRoot) {
    return;
  }

  if (privilegedCapability.reason === 'system') {
    throw new Error(
      `Project workflow "${filePath}" cannot use privileged system execution in step "${privilegedCapability.step.name}"`,
    );
  }

  throw new Error(
    `Project workflow "${filePath}" cannot use allow_git_commit in step "${privilegedCapability.step.name}"`,
  );
}

export function validateProjectWorkflowTrustBoundary(
  workflow: WorkflowConfig,
  filePath: string,
  projectCwd: string,
): void {
  const trustInfo = getWorkflowTrustInfo(workflow, projectCwd);
  if (!trustInfo.isProjectTrustRoot) {
    return;
  }

  validateProjectWorkflowTrustBoundaryForSteps(workflow.steps, filePath, trustInfo);
}

export function validateWorkflowExecutionTrustBoundary(
  workflow: WorkflowConfig,
  projectCwd: string,
): void {
  const filePath = getWorkflowSourcePath(workflow) ?? workflow.name;
  const trustInfo = getWorkflowTrustInfo(workflow, projectCwd);
  validateWorkflowExecutionTrustBoundaryInternal(workflow, filePath, trustInfo);
}

export function validateWorkflowCallTrustBoundary(
  parentTrustInfo: WorkflowTrustInfo,
  childWorkflow: WorkflowConfig,
  stepName: string,
  projectCwd: string,
): void {
  const childTrustInfo = getWorkflowTrustInfo(childWorkflow, projectCwd);
  const privilegedCapability = findPrivilegedCapability(childWorkflow.steps);
  const hasPrivilegedRuntime = hasPrivilegedRuntimePrepare(childWorkflow);
  if (!privilegedCapability && !hasPrivilegedRuntime) {
    return;
  }

  if (parentTrustInfo.isProjectWorkflowRoot && childTrustInfo.isProjectWorkflowRoot) {
    return;
  }

  throw new Error(`Workflow step "${stepName}" cannot call privileged workflow "${childWorkflow.name}" across trust boundary`);
}
