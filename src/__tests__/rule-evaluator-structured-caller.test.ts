import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RuleEvaluator } from '../core/piece/evaluation/RuleEvaluator.js';
import type { PieceState } from '../core/models/types.js';
import { makeMovement } from './test-helpers.js';

function makeState(): PieceState {
  return {
    pieceName: 'test',
    currentMovement: 'review',
    iteration: 1,
    movementOutputs: new Map(),
    userInputs: [],
    personaSessions: new Map(),
    movementIterations: new Map(),
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
    const step = makeMovement({
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

  it('should delegate final fallback evaluation to structuredCaller instead of the removed legacy judge path', async () => {
    const structuredCaller = {
      evaluateCondition: vi.fn().mockResolvedValue(1),
    };
    const step = makeMovement({
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
});
