import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RuleEvaluator } from '../core/workflow/evaluation/RuleEvaluator.js';
import type { WorkflowState } from '../core/models/types.js';
import { makeStep } from './test-helpers.js';

function makeState(): WorkflowState {
  return {
    workflowName: 'test',
    currentStep: 'review',
    iteration: 1,
    stepOutputs: new Map(),
    userInputs: [],
    personaSessions: new Map(),
    stepIterations: new Map(),
    status: 'running',
  };
}

describe('RuleEvaluator with structuredCaller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should delegate ai() condition evaluation to structuredCaller instead of the removed legacy judge path', async () => {
    const structuredCaller = {
      evaluateCondition: vi.fn().mockResolvedValue(1),
    };
    const step = makeStep({
      name: 'review',
      rules: [
        { condition: 'approved', next: 'COMPLETE', isAiCondition: true, aiConditionText: 'is it approved?' },
        { condition: 'needs_fix', next: 'fix', isAiCondition: true, aiConditionText: 'does it need fixes?' },
      ],
    });

    const evaluator = new RuleEvaluator(
      step,
      {
        state: makeState(),
        cwd: '/tmp/project',
        detectRuleIndex: vi.fn().mockReturnValue(-1),
        structuredCaller,
      } as ConstructorParameters<typeof RuleEvaluator>[1] & {
        structuredCaller: { evaluateCondition: typeof structuredCaller.evaluateCondition };
      },
    );

    const result = await evaluator.evaluate('agent output', '');

    expect(result).toEqual({ index: 1, method: 'ai_judge' });
    expect(structuredCaller.evaluateCondition).toHaveBeenCalledWith(
      'agent output',
      [
        { index: 0, text: 'is it approved?' },
        { index: 1, text: 'does it need fixes?' },
      ],
      { cwd: '/tmp/project', provider: undefined },
    );
  });

  it('should pass resolvedProvider and resolvedModel to evaluateCondition for ai() judge (#556)', async () => {
    const structuredCaller = {
      evaluateCondition: vi.fn().mockResolvedValue(0),
    };
    const step = makeStep({
      name: 'review',
      rules: [
        { condition: 'approved', next: 'COMPLETE', isAiCondition: true, aiConditionText: 'is it approved?' },
      ],
    });

    const evaluator = new RuleEvaluator(
      step,
      {
        state: makeState(),
        cwd: '/tmp/project',
        provider: 'codex',
        resolvedProvider: 'codex',
        resolvedModel: 'gpt-5.2-codex',
        detectRuleIndex: vi.fn().mockReturnValue(-1),
        structuredCaller,
      } as ConstructorParameters<typeof RuleEvaluator>[1] & {
        structuredCaller: { evaluateCondition: typeof structuredCaller.evaluateCondition };
        resolvedProvider?: string;
        resolvedModel?: string;
      },
    );

    await evaluator.evaluate('agent output', '');

    expect(structuredCaller.evaluateCondition).toHaveBeenCalledWith(
      'agent output',
      [{ index: 0, text: 'is it approved?' }],
      expect.objectContaining({
        cwd: '/tmp/project',
        provider: 'codex',
        resolvedProvider: 'codex',
        resolvedModel: 'gpt-5.2-codex',
      }),
    );
  });

  it('should delegate final fallback evaluation to structuredCaller instead of the removed legacy judge path', async () => {
    const structuredCaller = {
      evaluateCondition: vi.fn().mockResolvedValue(1),
    };
    const step = makeStep({
      name: 'review',
      rules: [
        { condition: 'approved', next: 'COMPLETE' },
        { condition: 'needs_fix', next: 'fix' },
      ],
    });

    const evaluator = new RuleEvaluator(
      step,
      {
        state: makeState(),
        cwd: '/tmp/project',
        detectRuleIndex: vi.fn().mockReturnValue(-1),
        structuredCaller,
      } as ConstructorParameters<typeof RuleEvaluator>[1] & {
        structuredCaller: { evaluateCondition: typeof structuredCaller.evaluateCondition };
      },
    );

    const result = await evaluator.evaluate('agent output', '');

    expect(result).toEqual({ index: 1, method: 'ai_judge_fallback' });
    expect(structuredCaller.evaluateCondition).toHaveBeenCalledWith(
      'agent output',
      [
        { index: 0, text: 'approved' },
        { index: 1, text: 'needs_fix' },
      ],
      { cwd: '/tmp/project', provider: undefined },
    );
  });

  it('should pass identical judge options to evaluateCondition for ai() path and fallback path (DRY contract)', async () => {
    const structuredCaller = {
      evaluateCondition: vi.fn().mockResolvedValueOnce(99).mockResolvedValueOnce(1),
    };
    const step = makeStep({
      name: 'review',
      rules: [
        { condition: 'approved', next: 'COMPLETE', isAiCondition: true, aiConditionText: 'is it approved?' },
        { condition: 'needs_fix', next: 'fix' },
      ],
    });

    const evaluator = new RuleEvaluator(
      step,
      {
        state: makeState(),
        cwd: '/tmp/project',
        provider: 'codex',
        resolvedProvider: 'codex',
        resolvedModel: 'gpt-5.2-codex',
        detectRuleIndex: vi.fn().mockReturnValue(-1),
        structuredCaller,
      } as ConstructorParameters<typeof RuleEvaluator>[1] & {
        structuredCaller: { evaluateCondition: typeof structuredCaller.evaluateCondition };
        resolvedProvider?: string;
        resolvedModel?: string;
      },
    );

    const result = await evaluator.evaluate('agent output', '');

    expect(result).toEqual({ index: 1, method: 'ai_judge_fallback' });
    expect(structuredCaller.evaluateCondition).toHaveBeenCalledTimes(2);
    const firstOpts = structuredCaller.evaluateCondition.mock.calls[0]?.[2];
    const secondOpts = structuredCaller.evaluateCondition.mock.calls[1]?.[2];
    expect(firstOpts).toEqual(secondOpts);
    expect(firstOpts).toEqual(
      expect.objectContaining({
        cwd: '/tmp/project',
        provider: 'codex',
        resolvedProvider: 'codex',
        resolvedModel: 'gpt-5.2-codex',
      }),
    );
  });

  it('should pass resolvedProvider and resolvedModel to evaluateCondition for AI judge fallback (#556)', async () => {
    const structuredCaller = {
      evaluateCondition: vi.fn().mockResolvedValue(1),
    };
    const step = makeStep({
      name: 'review',
      rules: [
        { condition: 'approved', next: 'COMPLETE' },
        { condition: 'needs_fix', next: 'fix' },
      ],
    });

    const evaluator = new RuleEvaluator(
      step,
      {
        state: makeState(),
        cwd: '/tmp/project',
        provider: 'codex',
        resolvedProvider: 'codex',
        resolvedModel: 'gpt-5.2-codex',
        detectRuleIndex: vi.fn().mockReturnValue(-1),
        structuredCaller,
      } as ConstructorParameters<typeof RuleEvaluator>[1] & {
        structuredCaller: { evaluateCondition: typeof structuredCaller.evaluateCondition };
        resolvedProvider?: string;
        resolvedModel?: string;
      },
    );

    await evaluator.evaluate('agent output', '');

    expect(structuredCaller.evaluateCondition).toHaveBeenCalledWith(
      'agent output',
      [
        { index: 0, text: 'approved' },
        { index: 1, text: 'needs_fix' },
      ],
      expect.objectContaining({
        cwd: '/tmp/project',
        provider: 'codex',
        resolvedProvider: 'codex',
        resolvedModel: 'gpt-5.2-codex',
      }),
    );
  });
});
