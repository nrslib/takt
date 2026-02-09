/**
 * Unit tests for RuleEvaluator
 *
 * Tests the evaluation pipeline: aggregate → tag detection → ai() → ai judge fallback.
 */

import { describe, it, expect, vi } from 'vitest';
import { RuleEvaluator, type RuleEvaluatorContext } from '../core/piece/evaluation/RuleEvaluator.js';
import type { PieceMovement, PieceState } from '../core/models/types.js';

function makeMovement(overrides: Partial<PieceMovement> = {}): PieceMovement {
  return {
    name: 'test-movement',
    personaDisplayName: 'tester',
    instructionTemplate: '',
    passPreviousResponse: false,
    ...overrides,
  };
}

function makeState(): PieceState {
  return {
    pieceName: 'test',
    currentMovement: 'test-movement',
    iteration: 1,
    movementOutputs: new Map(),
    userInputs: [],
    personaSessions: new Map(),
    movementIterations: new Map(),
    status: 'running',
  };
}

function makeContext(overrides: Partial<RuleEvaluatorContext> = {}): RuleEvaluatorContext {
  return {
    state: makeState(),
    cwd: '/tmp/test',
    detectRuleIndex: vi.fn().mockReturnValue(-1),
    callAiJudge: vi.fn().mockResolvedValue(-1),
    ...overrides,
  };
}

describe('RuleEvaluator', () => {
  describe('evaluate', () => {
    it('should return undefined when movement has no rules', async () => {
      const step = makeMovement({ rules: undefined });
      const ctx = makeContext();
      const evaluator = new RuleEvaluator(step, ctx);

      const result = await evaluator.evaluate('agent output', 'tag output');
      expect(result).toBeUndefined();
    });

    it('should return undefined when rules array is empty', async () => {
      const step = makeMovement({ rules: [] });
      const ctx = makeContext();
      const evaluator = new RuleEvaluator(step, ctx);

      const result = await evaluator.evaluate('agent output', 'tag output');
      expect(result).toBeUndefined();
    });

    it('should detect rule via Phase 3 tag output', async () => {
      const step = makeMovement({
        rules: [
          { condition: 'approved', next: 'implement' },
          { condition: 'rejected', next: 'review' },
        ],
      });
      const detectRuleIndex = vi.fn().mockReturnValue(0);
      const ctx = makeContext({ detectRuleIndex });
      const evaluator = new RuleEvaluator(step, ctx);

      const result = await evaluator.evaluate('agent content', 'tag content with [TEST-MOVEMENT:1]');
      expect(result).toEqual({ index: 0, method: 'phase3_tag' });
      expect(detectRuleIndex).toHaveBeenCalledWith('tag content with [TEST-MOVEMENT:1]', 'test-movement');
    });

    it('should fallback to Phase 1 tag when Phase 3 tag not found', async () => {
      const step = makeMovement({
        rules: [
          { condition: 'approved', next: 'implement' },
          { condition: 'rejected', next: 'review' },
        ],
      });
      // Phase 3 tagContent is non-empty but detectRuleIndex returns -1 (no match)
      // Phase 1 agentContent check: detectRuleIndex returns 1
      const detectRuleIndex = vi.fn()
        .mockReturnValueOnce(-1) // Phase 3 tag not found
        .mockReturnValueOnce(1); // Phase 1 tag found
      const ctx = makeContext({ detectRuleIndex });
      const evaluator = new RuleEvaluator(step, ctx);

      const result = await evaluator.evaluate('agent content', 'phase3 content');
      expect(result).toEqual({ index: 1, method: 'phase1_tag' });
    });

    it('should skip interactiveOnly rules in non-interactive mode', async () => {
      const step = makeMovement({
        rules: [
          { condition: 'user-fix', next: 'fix', interactiveOnly: true },
          { condition: 'auto-fix', next: 'autofix' },
        ],
      });
      // Tag detection returns index 0 (interactiveOnly rule)
      const detectRuleIndex = vi.fn().mockReturnValue(0);
      const callAiJudge = vi.fn().mockResolvedValue(-1);
      const ctx = makeContext({ detectRuleIndex, callAiJudge, interactive: false });
      const evaluator = new RuleEvaluator(step, ctx);

      // Should skip interactive-only rule and eventually throw
      await expect(evaluator.evaluate('content', 'tag')).rejects.toThrow('no rule matched');
    });

    it('should allow interactiveOnly rules in interactive mode', async () => {
      const step = makeMovement({
        rules: [
          { condition: 'user-fix', next: 'fix', interactiveOnly: true },
          { condition: 'auto-fix', next: 'autofix' },
        ],
      });
      const detectRuleIndex = vi.fn().mockReturnValue(0);
      const ctx = makeContext({ detectRuleIndex, interactive: true });
      const evaluator = new RuleEvaluator(step, ctx);

      const result = await evaluator.evaluate('content', 'tag');
      expect(result).toEqual({ index: 0, method: 'phase3_tag' });
    });

    it('should evaluate ai() conditions via AI judge', async () => {
      const step = makeMovement({
        rules: [
          { condition: 'approved', next: 'implement', isAiCondition: true, aiConditionText: 'is it approved?' },
          { condition: 'rejected', next: 'review', isAiCondition: true, aiConditionText: 'is it rejected?' },
        ],
      });
      // callAiJudge returns 0 (first ai condition matched)
      const callAiJudge = vi.fn().mockResolvedValue(0);
      const ctx = makeContext({ callAiJudge });
      const evaluator = new RuleEvaluator(step, ctx);

      const result = await evaluator.evaluate('agent output', '');
      expect(result).toEqual({ index: 0, method: 'ai_judge' });
      expect(callAiJudge).toHaveBeenCalledWith(
        'agent output',
        [
          { index: 0, text: 'is it approved?' },
          { index: 1, text: 'is it rejected?' },
        ],
        { cwd: '/tmp/test' },
      );
    });

    it('should use ai_judge_fallback when no other method matches', async () => {
      const step = makeMovement({
        rules: [
          { condition: 'approved', next: 'implement' },
          { condition: 'rejected', next: 'review' },
        ],
      });
      // No rules have isAiCondition, so evaluateAiConditions returns -1 without calling callAiJudge.
      // evaluateAllConditionsViaAiJudge is the only caller of callAiJudge.
      const callAiJudge = vi.fn().mockResolvedValue(1);
      const ctx = makeContext({ callAiJudge });
      const evaluator = new RuleEvaluator(step, ctx);

      const result = await evaluator.evaluate('agent output', '');
      expect(result).toEqual({ index: 1, method: 'ai_judge_fallback' });
    });

    it('should throw when no rule matches after all detection phases', async () => {
      const step = makeMovement({
        rules: [
          { condition: 'approved', next: 'implement' },
          { condition: 'rejected', next: 'review' },
        ],
      });
      const ctx = makeContext();
      const evaluator = new RuleEvaluator(step, ctx);

      await expect(evaluator.evaluate('', '')).rejects.toThrow(
        'Status not found for movement "test-movement": no rule matched after all detection phases',
      );
    });

    it('should reject out-of-bounds tag detection index', async () => {
      const step = makeMovement({
        rules: [
          { condition: 'approved', next: 'implement' },
        ],
      });
      // Tag detection returns index 5 (out of bounds)
      const detectRuleIndex = vi.fn().mockReturnValue(5);
      const callAiJudge = vi.fn().mockResolvedValue(-1);
      const ctx = makeContext({ detectRuleIndex, callAiJudge });
      const evaluator = new RuleEvaluator(step, ctx);

      await expect(evaluator.evaluate('content', 'tag')).rejects.toThrow('no rule matched');
    });

    it('should skip ai() conditions for interactiveOnly rules in non-interactive mode', async () => {
      const step = makeMovement({
        rules: [
          {
            condition: 'user confirms',
            next: 'fix',
            interactiveOnly: true,
            isAiCondition: true,
            aiConditionText: 'did the user confirm?',
          },
          { condition: 'auto proceed', next: 'COMPLETE' },
        ],
      });
      // In non-interactive mode, interactiveOnly rules are filtered out from ai judge.
      // evaluateAiConditions skips the interactiveOnly ai() rule, returning -1.
      // evaluateAllConditionsViaAiJudge filters to only non-interactive rules,
      // passing conditions=[{index: 1, text: 'auto proceed'}] to judge.
      // The judge returns 0 (first condition in filtered array).
      const callAiJudge = vi.fn().mockResolvedValue(0);
      const ctx = makeContext({ callAiJudge, interactive: false });
      const evaluator = new RuleEvaluator(step, ctx);

      const result = await evaluator.evaluate('output', '');
      // Returns the judge result index (0) directly — it's the index into the filtered conditions array
      expect(result).toEqual({ index: 0, method: 'ai_judge_fallback' });
    });
  });
});
