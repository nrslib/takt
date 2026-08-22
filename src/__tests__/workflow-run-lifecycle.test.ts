import { describe, expect, it } from 'vitest';
import {
  resolveWorkflowRunTerminalStatus,
} from '../features/tasks/execute/workflowTerminalStatus.js';

describe('workflow run lifecycle composition', () => {
  it('maps workflow results to file terminal states', () => {
    expect(resolveWorkflowRunTerminalStatus({ success: true })).toBe('completed');
    expect(resolveWorkflowRunTerminalStatus({
      success: false,
      abortKind: 'interrupt',
    })).toBe('cancelled');
    expect(resolveWorkflowRunTerminalStatus({
      success: false,
      abortKind: 'user_input_cancelled',
    })).toBe('cancelled');
    expect(resolveWorkflowRunTerminalStatus({
      success: false,
      abortKind: 'step_error',
    })).toBe('failed');
    expect(resolveWorkflowRunTerminalStatus({
      success: false,
      abortKind: 'blocked',
    })).toBe('failed');
    expect(resolveWorkflowRunTerminalStatus({
      success: false,
      abortKind: 'user_input_required',
    })).toBe('failed');
  });
});
