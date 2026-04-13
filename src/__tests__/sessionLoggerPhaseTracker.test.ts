import { describe, expect, it } from 'vitest';
import { SessionLoggerPhaseTracker } from '../features/tasks/execute/sessionLoggerPhaseTracker.js';
import { buildPhaseExecutionId } from '../shared/utils/phaseExecutionId.js';

describe('SessionLoggerPhaseTracker', () => {
  it('同じ step/phase/iteration の重複開始でも phaseExecutionId と prompt を対応付ける', () => {
    const tracker = new SessionLoggerPhaseTracker();
    const firstPrompt = { systemPrompt: 'system-1', userInstruction: 'user-1' };
    const secondPrompt = { systemPrompt: 'system-2', userInstruction: 'user-2' };

    const firstId = tracker.trackStart({
      stepName: 'review',
      phase: 1,
      phaseExecutionId: undefined,
      iteration: 3,
      promptParts: firstPrompt,
      capturePrompt: true,
    });
    const secondId = tracker.trackStart({
      stepName: 'review',
      phase: 1,
      phaseExecutionId: undefined,
      iteration: 3,
      promptParts: secondPrompt,
      capturePrompt: true,
    });

    expect(firstId).toBe(buildPhaseExecutionId({
      step: 'review',
      iteration: 3,
      phase: 1,
      sequence: 1,
    }));
    expect(secondId).toBe(buildPhaseExecutionId({
      step: 'review',
      iteration: 3,
      phase: 1,
      sequence: 2,
    }));
    expect(tracker.trackCompletion({
      stepName: 'review',
      phase: 1,
      phaseExecutionId: firstId,
      iteration: 3,
      requirePrompt: true,
    })).toEqual({
      phaseExecutionId: firstId,
      promptParts: firstPrompt,
    });
    expect(tracker.trackCompletion({
      stepName: 'review',
      phase: 1,
      phaseExecutionId: secondId,
      iteration: 3,
      requirePrompt: true,
    })).toEqual({
      phaseExecutionId: secondId,
      promptParts: secondPrompt,
    });
  });

  it('iteration なしで phaseExecutionId を自動生成しようとしたら失敗する', () => {
    const tracker = new SessionLoggerPhaseTracker();

    expect(() => tracker.trackStart({
      stepName: 'review',
      phase: 1,
      phaseExecutionId: undefined,
      iteration: undefined,
      promptParts: { systemPrompt: 'system', userInstruction: 'user' },
      capturePrompt: true,
    })).toThrow('Missing iteration for phase execution id: review:1');
  });
});
