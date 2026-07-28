import type {
  SystemWorkflowStep,
  WorkflowCallStep,
  WorkflowResumeFrameKind,
  WorkflowStep,
} from '../models/types.js';
import {
  getWorkflowStepKind as getRawWorkflowStepKind,
  type WorkflowStepKindLike,
} from '../models/workflow-step-kind.js';

export function getWorkflowStepKind(step: WorkflowStepKindLike) {
  return getRawWorkflowStepKind(step);
}

export function getWorkflowResumeFrameKind(
  step: WorkflowStep,
): WorkflowResumeFrameKind {
  const kind = getWorkflowStepKind(step);
  if (kind !== 'agent') {
    return kind;
  }
  return step.parallel !== undefined && step.parallel.length > 0
    ? 'parallel'
    : 'agent';
}

export function isDelegatedWorkflowStep(step: WorkflowStepKindLike & Pick<WorkflowStep, 'parallel' | 'arpeggio' | 'teamLeader'>): boolean {
  const kind = getWorkflowStepKind(step);
  return (
    kind === 'system'
    || kind === 'workflow_call'
    || (step.parallel?.length ?? 0) > 0
    || step.arpeggio !== undefined
    || step.teamLeader !== undefined
  );
}

export function isSystemWorkflowStep(step: WorkflowStep): step is SystemWorkflowStep {
  return getWorkflowStepKind(step) === 'system';
}

export function isWorkflowCallStep(step: WorkflowStep): step is WorkflowCallStep {
  return getWorkflowStepKind(step) === 'workflow_call';
}
