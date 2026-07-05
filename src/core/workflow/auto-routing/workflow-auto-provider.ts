import type { WorkflowCallStep, WorkflowConfig, WorkflowStep } from '../../models/types.js';
import type { ProviderTypeOrAuto } from '../../models/config-types.js';
import type { WorkflowCallResolver } from '../types.js';
import { getWorkflowReference } from '../workflow-reference.js';

interface WorkflowUsesAutoProviderInput {
  workflowConfig: WorkflowConfig;
  effectiveProvider: ProviderTypeOrAuto | undefined;
  cliProvider: ProviderTypeOrAuto | undefined;
  projectCwd: string;
  lookupCwd: string;
  workflowCallResolver: WorkflowCallResolver | undefined;
  visited?: ReadonlySet<string>;
}

function getParallelSteps(step: WorkflowStep): WorkflowStep[] {
  return 'parallel' in step && Array.isArray(step.parallel)
    ? step.parallel as WorkflowStep[]
    : [];
}

export function workflowStepUsesAutoProvider(step: WorkflowStep): boolean {
  if (step.provider === 'auto' && step.providerSpecified !== false) {
    return true;
  }
  if (step.kind === 'workflow_call' && step.overrides?.provider === 'auto') {
    return true;
  }
  return getParallelSteps(step).some(workflowStepUsesAutoProvider);
}

function resolveWorkflowCallChild(
  workflowConfig: WorkflowConfig,
  step: WorkflowCallStep,
  projectCwd: string,
  lookupCwd: string,
  resolver: WorkflowCallResolver | undefined,
): WorkflowConfig | undefined {
  if (!resolver) {
    return undefined;
  }
  const childWorkflow = resolver({
    parentWorkflow: workflowConfig,
    step,
    projectCwd,
    lookupCwd,
  });
  return childWorkflow ?? undefined;
}

function workflowCallChildUsesAutoProvider(
  input: WorkflowUsesAutoProviderInput,
  step: WorkflowStep,
  nextVisited: ReadonlySet<string>,
): boolean {
  if (step.kind !== 'workflow_call') {
    return false;
  }
  const workflowCallStep = step as WorkflowCallStep;
  const childWorkflow = resolveWorkflowCallChild(
    input.workflowConfig,
    workflowCallStep,
    input.projectCwd,
    input.lookupCwd,
    input.workflowCallResolver,
  );
  if (!childWorkflow) {
    return false;
  }

  const childEffectiveProvider = workflowCallStep.overrides?.provider
    ?? childWorkflow.provider
    ?? input.effectiveProvider;
  return workflowUsesAutoProvider({
    ...input,
    workflowConfig: childWorkflow,
    effectiveProvider: childEffectiveProvider,
    cliProvider: undefined,
    visited: nextVisited,
  });
}

function workflowStepTreeUsesAutoProvider(
  input: WorkflowUsesAutoProviderInput,
  step: WorkflowStep,
  nextVisited: ReadonlySet<string>,
): boolean {
  return workflowStepUsesAutoProvider(step)
    || workflowCallChildUsesAutoProvider(input, step, nextVisited)
    || getParallelSteps(step).some((subStep) =>
      workflowStepTreeUsesAutoProvider(input, subStep, nextVisited)
    );
}

export function workflowUsesAutoProvider(input: WorkflowUsesAutoProviderInput): boolean {
  const workflowReference = getWorkflowReference(input.workflowConfig);
  if (input.visited?.has(workflowReference)) {
    return false;
  }
  const nextVisited = new Set(input.visited);
  nextVisited.add(workflowReference);

  return input.effectiveProvider === 'auto'
    || input.workflowConfig.steps.some((step) => workflowStepTreeUsesAutoProvider(input, step, nextVisited))
    || input.cliProvider === 'auto';
}
