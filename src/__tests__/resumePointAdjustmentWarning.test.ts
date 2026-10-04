import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowResumePoint } from '../core/models/index.js';

const mockWarn = vi.hoisted(() => vi.fn());

vi.mock('../shared/ui/index.js', () => ({
  warn: mockWarn,
}));

import {
  warnIfResumePointAdjusted,
} from '../features/tasks/execute/resumePointAdjustmentWarning.js';

function resumePoint(steps: readonly string[]): WorkflowResumePoint {
  return {
    version: 2,
    stack: steps.map((step, index) => ({
      workflow: index === 0 ? 'root' : `child-${index}`,
      workflow_ref: index === 0 ? 'root' : `child-${index}`,
      step,
      kind: index === 0 ? 'workflow_call' : 'agent',
      occurrence: 1,
      ...(index === 0 ? { call_instance: 1 } : {}),
    })),
    iteration: 4,
    elapsed_ms: 1_000,
    workflow_call_invocations: {},
    workflow_step_participations: {},
  };
}

describe('warnIfResumePointAdjusted', () => {
  beforeEach(() => {
    mockWarn.mockClear();
  });

  it('trim時に元stack・採用stack・startStepを警告する', () => {
    const original = resumePoint(['delegate', 'review']);
    const accepted = {
      ...original,
      stack: original.stack.slice(0, 1),
    };

    warnIfResumePointAdjusted({
      context: 'task_reexecution',
      outputMode: 'terminal',
      workflow: 'root',
      original,
      accepted,
      startStep: 'delegate',
    });

    expect(mockWarn).toHaveBeenCalledWith(
      'Workflow resume point was adjusted for the current workflow: '
      + 'context="task_reexecution", workflow="root", '
      + `originalStack=${JSON.stringify(original.stack)}, `
      + `acceptedStack=${JSON.stringify(accepted.stack)}, `
      + 'startStep="delegate"',
    );
  });

  it('drop時も空の採用stackとfallback startStepを警告する', () => {
    const original = resumePoint(['removed-step']);

    warnIfResumePointAdjusted({
      context: 'direct_resume',
      outputMode: 'terminal',
      workflow: 'root',
      original,
      accepted: undefined,
      startStep: 'implement',
    });

    expect(mockWarn).toHaveBeenCalledWith(
      'Workflow resume point was adjusted for the current workflow: '
      + 'context="direct_resume", workflow="root", '
      + `originalStack=${JSON.stringify(original.stack)}, `
      + 'acceptedStack=[], startStep="implement"',
    );
  });

  it('同じprefixをそのまま採用した場合は警告しない', () => {
    const original = resumePoint(['delegate', 'review']);

    warnIfResumePointAdjusted({
      context: 'direct_resume',
      outputMode: 'terminal',
      workflow: 'root',
      original,
      accepted: original,
      startStep: 'delegate',
    });

    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('silent出力ではresume pointを調整してもUI警告を出さない', () => {
    const original = resumePoint(['delegate', 'review']);

    warnIfResumePointAdjusted({
      context: 'task_reexecution',
      outputMode: 'silent',
      workflow: 'root',
      original,
      accepted: {
        ...original,
        stack: original.stack.slice(0, 1),
      },
      startStep: 'delegate',
    });

    expect(mockWarn).not.toHaveBeenCalled();
  });
});
