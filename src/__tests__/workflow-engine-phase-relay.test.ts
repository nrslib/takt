import { describe, expect, it, vi } from 'vitest';
import type { WorkflowStep } from '../core/models/types.js';
import { createWorkflowPhaseRelay } from '../core/workflow/engine/WorkflowEnginePhaseRelay.js';

describe('WorkflowEnginePhaseRelay activity', () => {
  it('試行開始・phase完了・judge stage をそれぞれ活動として記録する', () => {
    const recordActivity = vi.fn();
    const relay = createWorkflowPhaseRelay(vi.fn(), () => [{
      workflow: 'test-workflow',
      workflow_ref: 'test-workflow',
      step: 'coding-review',
      kind: 'agent',
      occurrence: 1,
    }], recordActivity);
    const step = { name: 'coding-review', rules: [] } as WorkflowStep;
    const promptParts = { systemPrompt: 'system', userInstruction: 'review' };

    relay.onPhaseStart(step, 1, 'execute', 'review', promptParts, 'attempt-2', 1);
    relay.onPhaseComplete(step, 1, 'execute', 'approved', 'done', undefined, 'attempt-2', 1);
    relay.onPhaseStart(step, 3, 'judge', 'judge', promptParts, 'judge-1', 1);
    relay.onJudgeStage(step, 3, 'judge', {
      stage: 1,
      method: 'structured_output',
      status: 'done',
      instruction: 'judge',
      response: 'approved',
    }, 'judge-1', 1);

    expect(recordActivity).toHaveBeenCalledTimes(4);
  });
});
