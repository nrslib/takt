import type { WorkflowStepKind } from './types.js';

export type WorkflowStepKindLike = {
  kind?: WorkflowStepKind;
  mode?: 'system';
  call?: string;
};

export function getWorkflowStepKind(step: WorkflowStepKindLike): WorkflowStepKind {
  if (step.kind) {
    return step.kind;
  }
  if (step.mode === 'system') {
    return 'system';
  }
  if (step.call) {
    return 'workflow_call';
  }
  return 'agent';
}
