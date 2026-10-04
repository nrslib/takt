import {
  getAllParallelSubSteps,
  type WorkflowConfig,
  type WorkflowStep,
} from '../../../core/models/index.js';
import { getWorkflowStepKind } from '../../../core/models/workflow-step-kind.js';
import { getWorkflowTrustInfo, type WorkflowTrustInfo } from './workflowTrustSource.js';

type PrivilegedCapability =
  | { step: WorkflowStep; reason: 'system' }
  | { step: WorkflowStep; reason: 'allow_git_commit' };

function hasPrivilegedRuntimePrepare(workflow: WorkflowConfig): boolean {
  return (workflow.runtime?.prepare?.length ?? 0) > 0;
}

function findPrivilegedAllowGitCommitStep(steps: readonly WorkflowStep[]): WorkflowStep | undefined {
  for (const step of steps) {
    if (step.allowGitCommit === true) {
      return step;
    }
    const privilegedParallelStep = step.parallel === undefined
      ? undefined
      : findPrivilegedAllowGitCommitStep(getAllParallelSubSteps(step.parallel));
    if (privilegedParallelStep) {
      return privilegedParallelStep;
    }
  }
  return undefined;
}

function findPrivilegedCapability(steps: readonly WorkflowStep[]): PrivilegedCapability | undefined {
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

function findPrivilegedSystemStep<T extends WorkflowStep>(steps: readonly T[]): T | undefined {
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
