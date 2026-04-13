import type { WorkflowConfig } from '../../../core/models/index.js';
import { getWorkflowStepKind } from '../../../core/models/workflow-step-kind.js';
import { getWorkflowSourcePath } from './workflowSourceMetadata.js';
import { getWorkflowTrustInfo, type WorkflowTrustInfo } from './workflowTrustSource.js';

type SystemStepLike = Parameters<typeof getWorkflowStepKind>[0] & {
  name: string;
};

function hasPrivilegedRuntimePrepare(workflow: WorkflowConfig): boolean {
  return (workflow.runtime?.prepare?.length ?? 0) > 0;
}

function validateWorkflowExecutionTrustBoundaryInternal(
  workflow: WorkflowConfig,
  filePath: string,
  trustInfo: Pick<WorkflowTrustInfo, 'isProjectWorkflowRoot'>,
): void {
  const privilegedStep = findPrivilegedSystemStep(workflow.steps);
  if (privilegedStep && !trustInfo.isProjectWorkflowRoot) {
    throw new Error(
      `Workflow "${filePath}" cannot use privileged system execution in step "${privilegedStep.name}" outside the project workflows root`,
    );
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
  const privilegedStep = findPrivilegedSystemStep(steps);
  if (!privilegedStep) {
    return;
  }

  if (trustInfo.isProjectWorkflowRoot) {
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
  const privilegedStep = findPrivilegedSystemStep(childWorkflow.steps);
  const hasPrivilegedRuntime = hasPrivilegedRuntimePrepare(childWorkflow);
  if (!privilegedStep && !hasPrivilegedRuntime) {
    return;
  }

  if (parentTrustInfo.isProjectWorkflowRoot && childTrustInfo.isProjectWorkflowRoot) {
    return;
  }

  throw new Error(`Workflow step "${stepName}" cannot call privileged workflow "${childWorkflow.name}" across trust boundary`);
}
