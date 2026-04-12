/**
 * Unit tests for RuleEvaluator
 *
 * Tests the evaluation pipeline: aggregate → tag detection → ai() → ai judge fallback.
 */

import { describe, it, expect, vi } from 'vitest';
import { RuleEvaluator, type RuleEvaluatorContext } from '../core/workflow/evaluation/RuleEvaluator.js';
import type { WorkflowState } from '../core/models/types.js';
import { makeStep } from './test-helpers.js';

function makeState(): WorkflowState {
  return {
    workflowName: 'test',
    currentStep: 'test-step',
    iteration: 1,
    stepOutputs: new Map(),
    structuredOutputs: new Map(),
    systemContexts: new Map(),
    effectResults: new Map(),
    userInputs: [],
    personaSessions: new Map(),
    stepIterations: new Map(),
    status: 'running',
  };
}

function makeContext(overrides: Partial<RuleEvaluatorContext> = {}): RuleEvaluatorContext {
  return {
    state: makeState(),
    cwd: '/tmp/test',
    detectRuleIndex: vi.fn().mockReturnValue(-1),
    structuredCaller: {
      evaluateCondition: vi.fn().mockResolvedValue(-1),
    } as RuleEvaluatorContext['structuredCaller'],
    ...overrides,
  };
}

describe('RuleEvaluator', () => {
  describe('evaluate', () => {
    it('should return undefined when step has no rules', async () => {
      const step = makeStep({ rules: undefined });
      const ctx = makeContext();
      const evaluator = new RuleEvaluator(step, ctx);

      const result = await evaluator.evaluate('agent output', 'tag output');
      expect(result).toBeUndefined();
    });

    it('should return undefined when rules array is empty', async () => {
      const step = makeStep({ rules: [] });
      const ctx = makeContext();
      const evaluator = new RuleEvaluator(step, ctx);

      const result = await evaluator.evaluate('agent output', 'tag output');
      expect(result).toBeUndefined();
    });

    it('should detect rule via Phase 3 tag output', async () => {
      const step = makeStep({
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
      expect(detectRuleIndex).toHaveBeenCalledWith('tag content with [TEST-MOVEMENT:1]', 'test-step');
    });

    it('should fallback to Phase 1 tag when Phase 3 tag not found', async () => {
      const step = makeStep({
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
      const step = makeStep({
        rules: [
          { condition: 'user-fix', next: 'fix', interactiveOnly: true },
          { condition: 'auto-fix', next: 'autofix' },
        ],
      });
      // Tag detection returns index 0 (interactiveOnly rule)
      const detectRuleIndex = vi.fn().mockReturnValue(0);
      const structuredCaller = { evaluateCondition: vi.fn().mockResolvedValue(-1) };
      const ctx = makeContext({ detectRuleIndex, structuredCaller, interactive: false });
      const evaluator = new RuleEvaluator(step, ctx);

      // Should skip interactive-only rule and eventually throw
      await expect(evaluator.evaluate('content', 'tag')).rejects.toThrow('no rule matched');
    });

    it('should allow interactiveOnly rules in interactive mode', async () => {
      const step = makeStep({
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
      const step = makeStep({
        rules: [
          { condition: 'approved', next: 'implement', isAiCondition: true, aiConditionText: 'is it approved?' },
          { condition: 'rejected', next: 'review', isAiCondition: true, aiConditionText: 'is it rejected?' },
        ],
      });
      const structuredCaller = { evaluateCondition: vi.fn().mockResolvedValue(0) };
      const ctx = makeContext({ structuredCaller });
      const evaluator = new RuleEvaluator(step, ctx);

      const result = await evaluator.evaluate('agent output', '');
      expect(result).toEqual({ index: 0, method: 'ai_judge' });
      expect(structuredCaller.evaluateCondition).toHaveBeenCalledWith(
        'agent output',
        [
          { index: 0, text: 'is it approved?' },
          { index: 1, text: 'is it rejected?' },
        ],
        { cwd: '/tmp/test', provider: undefined },
      );
    });

    it('should prefer ai() conditions over a later when:true fallback', async () => {
      const step = makeStep({
        rules: [
          { condition: 'approved', next: 'implement', isAiCondition: true, aiConditionText: 'is it approved?' },
          { condition: 'true', next: 'fallback' },
        ],
      });
      const structuredCaller = { evaluateCondition: vi.fn().mockResolvedValue(0) };
      const ctx = makeContext({ structuredCaller });
      const evaluator = new RuleEvaluator(step, ctx);

      const result = await evaluator.evaluate('agent output', '');

      expect(result).toEqual({ index: 0, method: 'ai_judge' });
      expect(structuredCaller.evaluateCondition).toHaveBeenCalledOnce();
    });

    it('should prefer an earlier deterministic rule over a later ai() rule', async () => {
      const state = makeState();
      state.systemContexts.set('route_context', { task: { exists: true } });
      const step = makeStep({
        name: 'route_context',
        rules: [
          { condition: 'context.route_context.task.exists == true', next: 'skip' },
          { condition: 'approved', next: 'implement', isAiCondition: true, aiConditionText: 'is it approved?' },
        ],
      });
      const structuredCaller = { evaluateCondition: vi.fn().mockResolvedValue(1) };
      const ctx = makeContext({ state, structuredCaller });
      const evaluator = new RuleEvaluator(step, ctx);

      const result = await evaluator.evaluate('agent output', '');

      expect(result).toEqual({ index: 0, method: 'auto_select' });
      expect(structuredCaller.evaluateCondition).not.toHaveBeenCalled();
    });

    it('should prefer an earlier ai() rule over a later deterministic rule', async () => {
      const state = makeState();
      state.systemContexts.set('route_context', { task: { exists: true } });
      const step = makeStep({
        name: 'route_context',
        rules: [
          { condition: 'approved', next: 'implement', isAiCondition: true, aiConditionText: 'is it approved?' },
          { condition: 'context.route_context.task.exists == true', next: 'skip' },
        ],
      });
      const structuredCaller = { evaluateCondition: vi.fn().mockResolvedValue(0) };
      const ctx = makeContext({ state, structuredCaller });
      const evaluator = new RuleEvaluator(step, ctx);

      const result = await evaluator.evaluate('agent output', '');

      expect(result).toEqual({ index: 0, method: 'ai_judge' });
      expect(structuredCaller.evaluateCondition).toHaveBeenCalledOnce();
    });

    it('should prefer ai() conditions over an earlier when:true rule', async () => {
      const step = makeStep({
        rules: [
          { condition: 'true', next: 'fallback' },
          { condition: 'approved', next: 'implement', isAiCondition: true, aiConditionText: 'is it approved?' },
        ],
      });
      const structuredCaller = { evaluateCondition: vi.fn().mockResolvedValue(1) };
      const ctx = makeContext({ structuredCaller });
      const evaluator = new RuleEvaluator(step, ctx);

      const result = await evaluator.evaluate('agent output', '');

      expect(result).toEqual({ index: 1, method: 'ai_judge' });
      expect(structuredCaller.evaluateCondition).toHaveBeenCalledOnce();
    });

    it('should prefer a middle deterministic rule over a later ai() rule when an earlier tag rule does not match', async () => {
      const state = makeState();
      state.systemContexts.set('route_context', { task: { exists: true } });
      const step = makeStep({
        name: 'route_context',
        rules: [
          { condition: 'approved', next: 'implement' },
          { condition: 'context.route_context.task.exists == true', next: 'skip' },
          { condition: 'rejected', next: 'review', isAiCondition: true, aiConditionText: 'is it rejected?' },
        ],
      });
      const structuredCaller = { evaluateCondition: vi.fn().mockResolvedValue(2) };
      const detectRuleIndex = vi.fn().mockReturnValue(-1);
      const ctx = makeContext({ state, structuredCaller, detectRuleIndex });
      const evaluator = new RuleEvaluator(step, ctx);

      const result = await evaluator.evaluate('agent output', '');

      expect(result).toEqual({ index: 1, method: 'auto_select' });
      expect(detectRuleIndex).toHaveBeenCalledTimes(1);
      expect(structuredCaller.evaluateCondition).toHaveBeenCalledOnce();
    });

    it('should prefer phase3 tags over a later when:true fallback', async () => {
      const step = makeStep({
        rules: [
          { condition: 'approved', next: 'implement' },
          { condition: 'true', next: 'fallback' },
        ],
      });
      const detectRuleIndex = vi.fn().mockReturnValue(0);
      const ctx = makeContext({ detectRuleIndex });
      const evaluator = new RuleEvaluator(step, ctx);

      const result = await evaluator.evaluate('agent output', '[TEST-STEP:1]');

      expect(result).toEqual({ index: 0, method: 'phase3_tag' });
    });

    it('should prefer phase3 tags over an earlier when:true rule', async () => {
      const step = makeStep({
        rules: [
          { condition: 'true', next: 'fallback' },
          { condition: 'approved', next: 'implement' },
        ],
      });
      const detectRuleIndex = vi.fn().mockReturnValue(1);
      const ctx = makeContext({ detectRuleIndex });
      const evaluator = new RuleEvaluator(step, ctx);

      const result = await evaluator.evaluate('agent output', '[TEST-STEP:2]');

      expect(result).toEqual({ index: 1, method: 'phase3_tag' });
    });

    it('should prefer an earlier phase3 tag over a later deterministic rule', async () => {
      const state = makeState();
      state.systemContexts.set('route_context', { task: { exists: true } });
      const step = makeStep({
        name: 'route_context',
        rules: [
          { condition: 'approved', next: 'implement' },
          { condition: 'context.route_context.task.exists == true', next: 'skip' },
        ],
      });
      const detectRuleIndex = vi.fn().mockReturnValue(0);
      const ctx = makeContext({ state, detectRuleIndex });
      const evaluator = new RuleEvaluator(step, ctx);

      const result = await evaluator.evaluate('agent output', '[ROUTE_CONTEXT:1]');

      expect(result).toEqual({ index: 0, method: 'phase3_tag' });
      expect(detectRuleIndex).toHaveBeenCalledOnce();
    });

    it('should prefer an earlier deterministic rule over a later phase3 tag', async () => {
      const state = makeState();
      state.systemContexts.set('route_context', { task: { exists: true } });
      const step = makeStep({
        name: 'route_context',
        rules: [
          { condition: 'context.route_context.task.exists == true', next: 'skip' },
          { condition: 'approved', next: 'implement' },
        ],
      });
      const detectRuleIndex = vi.fn().mockReturnValue(1);
      const ctx = makeContext({ state, detectRuleIndex });
      const evaluator = new RuleEvaluator(step, ctx);

      const result = await evaluator.evaluate('agent output', '[ROUTE_CONTEXT:2]');

      expect(result).toEqual({ index: 0, method: 'auto_select' });
      expect(detectRuleIndex).not.toHaveBeenCalled();
    });

    it('should prefer a later deterministic rule over ai_judge_fallback when earlier ai() rules do not match', async () => {
      const state = makeState();
      state.systemContexts.set('route_context', { task: { exists: true } });
      const step = makeStep({
        name: 'route_context',
        rules: [
          { condition: 'approved', next: 'implement', isAiCondition: true, aiConditionText: 'is it approved?' },
          { condition: 'context.route_context.task.exists == true', next: 'skip' },
          { condition: 'rejected', next: 'review' },
        ],
      });
      const structuredCaller = { evaluateCondition: vi.fn().mockResolvedValueOnce(-1).mockResolvedValueOnce(2) };
      const ctx = makeContext({ state, structuredCaller });
      const evaluator = new RuleEvaluator(step, ctx);

      const result = await evaluator.evaluate('agent output', '');

      expect(result).toEqual({ index: 1, method: 'auto_select' });
      expect(structuredCaller.evaluateCondition).toHaveBeenCalledOnce();
    });

    it('should use ai_judge_fallback when no other method matches', async () => {
      const step = makeStep({
        rules: [
          { condition: 'approved', next: 'implement' },
          { condition: 'rejected', next: 'review' },
        ],
      });
      const structuredCaller = { evaluateCondition: vi.fn().mockResolvedValue(1) };
      const ctx = makeContext({ structuredCaller });
      const evaluator = new RuleEvaluator(step, ctx);

      const result = await evaluator.evaluate('agent output', '');
      expect(result).toEqual({ index: 1, method: 'ai_judge_fallback' });
    });

    it('should prefer ai_judge_fallback over an earlier when:true rule', async () => {
      const step = makeStep({
        rules: [
          { condition: 'true', next: 'fallback' },
          { condition: 'approved', next: 'implement' },
          { condition: 'rejected', next: 'review' },
        ],
      });
      const structuredCaller = { evaluateCondition: vi.fn().mockResolvedValue(2) };
      const ctx = makeContext({ structuredCaller });
      const evaluator = new RuleEvaluator(step, ctx);

      const result = await evaluator.evaluate('agent output', '');

      expect(result).toEqual({ index: 2, method: 'ai_judge_fallback' });
    });

    it('should throw when no rule matches after all detection phases', async () => {
      const step = makeStep({
        rules: [
          { condition: 'approved', next: 'implement' },
          { condition: 'rejected', next: 'review' },
        ],
      });
      const ctx = makeContext();
      const evaluator = new RuleEvaluator(step, ctx);

      await expect(evaluator.evaluate('', '')).rejects.toThrow(
        'Status not found for step "test-step": no rule matched after all detection phases',
      );
    });

    it('should reject out-of-bounds tag detection index', async () => {
      const step = makeStep({
        rules: [
          { condition: 'approved', next: 'implement' },
        ],
      });
      // Tag detection returns index 5 (out of bounds)
      const detectRuleIndex = vi.fn().mockReturnValue(5);
      const structuredCaller = { evaluateCondition: vi.fn().mockResolvedValue(-1) };
      const ctx = makeContext({ detectRuleIndex, structuredCaller });
      const evaluator = new RuleEvaluator(step, ctx);

      await expect(evaluator.evaluate('content', 'tag')).rejects.toThrow('no rule matched');
    });

    it('should skip ai() conditions for interactiveOnly rules in non-interactive mode', async () => {
      const step = makeStep({
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
      const structuredCaller = { evaluateCondition: vi.fn().mockResolvedValue(1) };
      const ctx = makeContext({ structuredCaller, interactive: false });
      const evaluator = new RuleEvaluator(step, ctx);

      const result = await evaluator.evaluate('output', '');
      expect(result).toEqual({ index: 1, method: 'ai_judge_fallback' });
    });
  });
});
