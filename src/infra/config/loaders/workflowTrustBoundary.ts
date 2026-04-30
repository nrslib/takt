import type { WorkflowConfig } from '../../../core/models/index.js';
import { getWorkflowStepKind } from '../../../core/models/workflow-step-kind.js';
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

function findPrivilegedSystemStep<T extends SystemStepLike>(steps: T[]): T | undefined {
  return steps.find((step) => getWorkflowStepKind(step) === 'system');
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
