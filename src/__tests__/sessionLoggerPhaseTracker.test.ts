import { describe, expect, it } from 'vitest';
import { SessionLoggerPhaseTracker } from '../features/tasks/execute/sessionLoggerPhaseTracker.js';
import { buildPhaseExecutionId, parsePhaseExecutionId } from '../shared/utils/phaseExecutionId.js';

describe('phaseExecutionId', () => {
  it.each(['child:review', '%', '/', '日本語'])('任意のstep名を可逆に保持する: %s', (step) => {
    const workflowStack = [
      { workflow: 'root', step: 'parallel-a', kind: 'agent' as const },
      {
        workflow: 'root',
        workflow_ref: 'project:sha256:root',
        step: 'delegate',
        kind: 'workflow_call' as const,
        call_instance: 2,
      },
      { workflow: 'child', step: 'prepare', kind: 'system' as const },
    ];
    const id = buildPhaseExecutionId({ step, iteration: 7, phase: 3, sequence: 4, workflowStack });

    expect(parsePhaseExecutionId(id)).toEqual({
      step,
      iteration: 7,
      phase: 3,
      sequence: 4,
      workflowStack,
      scopeKey: id.slice('scope-'.length, id.indexOf(':')),
    });
  });

  it.each([
    ['孤立high surrogate', '\uD800'],
    ['孤立low surrogate', '\uDC00'],
  ])('schema-validな%sを含むstep名を可逆に保持する', (_label, step) => {
    const id = buildPhaseExecutionId({ step, iteration: 1, phase: 1, sequence: 1 });

    expect(parsePhaseExecutionId(id)).toEqual({
      step,
      iteration: 1,
      phase: 1,
      sequence: 1,
    });
  });

  it.each([
    ['iteration', { iteration: Number.MAX_SAFE_INTEGER, sequence: 1 }],
    ['sequence', { iteration: 1, sequence: Number.MAX_SAFE_INTEGER }],
  ])('%sの安全な最大整数をbuild/parse間で可逆に保持する', (_field, values) => {
    const id = buildPhaseExecutionId({ step: 'review', phase: 1, ...values });

    expect(parsePhaseExecutionId(id)).toEqual({ step: 'review', phase: 1, ...values });
  });

  it.each([
    ['iteration', { iteration: Number.MAX_SAFE_INTEGER + 1, sequence: 1 }],
    ['sequence', { iteration: 1, sequence: Number.MAX_SAFE_INTEGER + 1 }],
  ])('%sの非安全整数をbuilderで拒否する', (_field, values) => {
    expect(() => buildPhaseExecutionId({ step: 'review', phase: 1, ...values })).toThrow();
  });

  it('scopedとunscoped、およびphaseとsequenceを衝突させない', () => {
    const base = { step: 'child:review', iteration: 2 } as const;
    const unscoped = buildPhaseExecutionId({ ...base, phase: 1, sequence: 1 });
    const scoped = buildPhaseExecutionId({
      ...base,
      phase: 1,
      sequence: 1,
      workflowStack: [{ workflow: 'root', step: 'parallel', kind: 'agent' }],
    });

    expect(new Set([
      unscoped,
      scoped,
      buildPhaseExecutionId({ ...base, phase: 2, sequence: 1 }),
      buildPhaseExecutionId({ ...base, phase: 1, sequence: 2 }),
    ])).toHaveLength(4);
  });

  it.each([
    'child%3areview:2:1:1',
    'child%ZZreview:2:1:1',
    'child%3Areview:2:0:1',
    'child%3Areview:2:4:1',
    'child%3Areview:02:1:1',
  ])('非正準または不正なIDを拒否する: %s', (id) => {
    expect(parsePhaseExecutionId(id)).toBeUndefined();
  });
});

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
      workflowStack: undefined,
      promptParts: firstPrompt,
      capturePrompt: true,
    });
    const secondId = tracker.trackStart({
      stepName: 'review',
      phase: 1,
      phaseExecutionId: undefined,
      iteration: 3,
      workflowStack: undefined,
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
      workflowStack: undefined,
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
      workflowStack: undefined,
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
      workflowStack: undefined,
      promptParts: { systemPrompt: 'system', userInstruction: 'user' },
      capturePrompt: true,
    })).toThrow('Missing iteration for phase execution id: review:1');
  });

  it('同名 child step を workflow call instance ごとに独立して追跡する', () => {
    const tracker = new SessionLoggerPhaseTracker();
    const firstStack = [{
      workflow: 'parent',
      step: 'delegate',
      kind: 'workflow_call' as const,
      call_instance: 1,
    }];
    const secondStack = [{
      workflow: 'parent',
      step: 'delegate',
      kind: 'workflow_call' as const,
      call_instance: 2,
    }];

    const firstId = tracker.trackStart({
      stepName: 'review',
      phase: 1,
      phaseExecutionId: undefined,
      iteration: 3,
      workflowStack: firstStack,
      promptParts: { systemPrompt: 'system-1', userInstruction: 'user-1' },
      capturePrompt: true,
    });
    const secondId = tracker.trackStart({
      stepName: 'review',
      phase: 1,
      phaseExecutionId: undefined,
      iteration: 3,
      workflowStack: secondStack,
      promptParts: { systemPrompt: 'system-2', userInstruction: 'user-2' },
      capturePrompt: true,
    });

    expect(firstId).not.toBe(secondId);
    expect(tracker.trackCompletion({
      stepName: 'review',
      phase: 1,
      phaseExecutionId: undefined,
      iteration: 3,
      workflowStack: secondStack,
      requirePrompt: true,
    }).promptParts?.userInstruction).toBe('user-2');
    expect(tracker.trackCompletion({
      stepName: 'review',
      phase: 1,
      phaseExecutionId: undefined,
      iteration: 3,
      workflowStack: firstStack,
      requirePrompt: true,
    }).promptParts?.userInstruction).toBe('user-1');
  });
});
