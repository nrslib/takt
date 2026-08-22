import type { WorkflowAbortKind } from '../../../core/workflow/types.js';

export type WorkflowRunTerminalStatus =
  | 'completed'
  | 'failed'
  | 'cancelled';

export function resolveWorkflowRunTerminalStatus(input: {
  readonly success: boolean;
  readonly abortKind?: WorkflowAbortKind;
}): WorkflowRunTerminalStatus {
  if (input.success) {
    return 'completed';
  }
  if (input.abortKind === undefined) {
    return 'failed';
  }
  switch (input.abortKind) {
    case 'interrupt':
    case 'user_input_cancelled':
      return 'cancelled';
    case 'iteration_limit':
    case 'loop_detected':
    case 'blocked':
    case 'step_error':
    case 'rate_limited':
    case 'user_input_required':
    case 'step_transition':
    case 'runtime_error':
    case 'rule_no_match':
      return 'failed';
    default:
      return assertNever(input.abortKind);
  }
}

export function resolveWorkflowTerminalPublicationStatus(
  status: WorkflowRunTerminalStatus,
): 'completed' | 'aborted' | 'failed' {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'aborted';
    case 'failed':
      return 'failed';
  }
}

export function resolveWorkflowAbortPublicationStatus(
  abortKind: WorkflowAbortKind,
): 'aborted' | 'failed' {
  const status = resolveWorkflowRunTerminalStatus({
    success: false,
    abortKind,
  });
  return status === 'cancelled' ? 'aborted' : 'failed';
}

function assertNever(value: never): never {
  throw new Error(`Unknown workflow abort kind: ${String(value)}`);
}
