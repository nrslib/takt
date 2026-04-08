/**
 * Unit tests for AggregateEvaluator
 *
 * Tests all()/any() aggregate condition evaluation against sub-step results.
 */

import { describe, it, expect } from 'vitest';
import { AggregateEvaluator } from '../core/workflow/evaluation/AggregateEvaluator.js';
import type { WorkflowStep, WorkflowState, AgentResponse } from '../core/models/types.js';

function makeState(outputs: Record<string, { matchedRuleIndex?: number }>): WorkflowState {
  const stepOutputs = new Map<string, AgentResponse>();
  for (const [name, data] of Object.entries(outputs)) {
    stepOutputs.set(name, {
      persona: name,
      status: 'done',
      content: '',
      timestamp: new Date(),
      matchedRuleIndex: data.matchedRuleIndex,
    });
  }
  return {
    workflowName: 'test',
    currentStep: 'parent',
    iteration: 1,
    stepOutputs,
    userInputs: [],
    personaSessions: new Map(),
    stepIterations: new Map(),
    status: 'running',
  };
}

function makeSubStep(name: string, conditions: string[]): WorkflowStep {
  return {
    name,
    personaDisplayName: name,
    instruction: '',
    passPreviousResponse: false,
    rules: conditions.map((c) => ({ condition: c })),
  };
}

function makeParentStep(
  parallel: WorkflowStep[],
  rules: WorkflowStep['rules'],
): WorkflowStep {
  return {
    name: 'parent',
    personaDisplayName: 'parent',
    instruction: '',
    passPreviousResponse: false,
    parallel,
    rules,
  };
}

describe('AggregateEvaluator', () => {
  describe('all() with single condition', () => {
    it('should match when all sub-steps have matching condition', () => {
      const sub1 = makeSubStep('review-a', ['approved', 'rejected']);
      const sub2 = makeSubStep('review-b', ['approved', 'rejected']);

      const step = makeParentStep([sub1, sub2], [
        {
          condition: 'all approved',
          isAggregateCondition: true,
          aggregateType: 'all',
          aggregateConditionText: 'approved',
          next: 'COMPLETE',
        },
      ]);

      // Both sub-steps matched rule index 0 ("approved")
      const state = makeState({
        'review-a': { matchedRuleIndex: 0 },
        'review-b': { matchedRuleIndex: 0 },
      });

      const evaluator = new AggregateEvaluator(step, state);
      expect(evaluator.evaluate()).toBe(0);
    });

    it('should not match when one sub-step has different condition', () => {
      const sub1 = makeSubStep('review-a', ['approved', 'rejected']);
      const sub2 = makeSubStep('review-b', ['approved', 'rejected']);

      const step = makeParentStep([sub1, sub2], [
        {
          condition: 'all approved',
          isAggregateCondition: true,
          aggregateType: 'all',
          aggregateConditionText: 'approved',
          next: 'COMPLETE',
        },
      ]);

      // sub1 matched "approved" (index 0), sub2 matched "rejected" (index 1)
      const state = makeState({
        'review-a': { matchedRuleIndex: 0 },
        'review-b': { matchedRuleIndex: 1 },
      });

      const evaluator = new AggregateEvaluator(step, state);
      expect(evaluator.evaluate()).toBe(-1);
    });

    it('should not match when sub-step has no matched rule', () => {
      const sub1 = makeSubStep('review-a', ['approved', 'rejected']);
      const sub2 = makeSubStep('review-b', ['approved', 'rejected']);

      const step = makeParentStep([sub1, sub2], [
        {
          condition: 'all approved',
          isAggregateCondition: true,
          aggregateType: 'all',
          aggregateConditionText: 'approved',
          next: 'COMPLETE',
        },
      ]);

      // sub2 has no matched rule
      const state = makeState({
        'review-a': { matchedRuleIndex: 0 },
        'review-b': {},
      });

      const evaluator = new AggregateEvaluator(step, state);
      expect(evaluator.evaluate()).toBe(-1);
    });
  });

  describe('all() with multiple conditions (order-based)', () => {
    it('should match when each sub-step matches its corresponding condition', () => {
      const sub1 = makeSubStep('review-a', ['approved', 'rejected']);
      const sub2 = makeSubStep('review-b', ['approved', 'rejected']);

      const step = makeParentStep([sub1, sub2], [
        {
          condition: 'A approved, B rejected',
          isAggregateCondition: true,
          aggregateType: 'all',
          aggregateConditionText: ['approved', 'rejected'],
          next: 'COMPLETE',
        },
      ]);

      const state = makeState({
        'review-a': { matchedRuleIndex: 0 }, // "approved"
        'review-b': { matchedRuleIndex: 1 }, // "rejected"
      });

      const evaluator = new AggregateEvaluator(step, state);
      expect(evaluator.evaluate()).toBe(0);
    });

    it('should not match when condition count differs from sub-step count', () => {
      const sub1 = makeSubStep('review-a', ['approved']);

      const step = makeParentStep([sub1], [
        {
          condition: 'mismatch',
          isAggregateCondition: true,
          aggregateType: 'all',
          aggregateConditionText: ['approved', 'rejected'],
          next: 'COMPLETE',
        },
      ]);

      const state = makeState({
        'review-a': { matchedRuleIndex: 0 },
      });

      const evaluator = new AggregateEvaluator(step, state);
      expect(evaluator.evaluate()).toBe(-1);
    });
  });

  describe('any() with single condition', () => {
    it('should match when at least one sub-step has matching condition', () => {
      const sub1 = makeSubStep('review-a', ['approved', 'rejected']);
      const sub2 = makeSubStep('review-b', ['approved', 'rejected']);

      const step = makeParentStep([sub1, sub2], [
        {
          condition: 'any approved',
          isAggregateCondition: true,
          aggregateType: 'any',
          aggregateConditionText: 'approved',
          next: 'fix',
        },
      ]);

      // Only sub1 matched "approved"
      const state = makeState({
        'review-a': { matchedRuleIndex: 0 },
        'review-b': { matchedRuleIndex: 1 },
      });

      const evaluator = new AggregateEvaluator(step, state);
      expect(evaluator.evaluate()).toBe(0);
    });

    it('should not match when no sub-step has matching condition', () => {
      const sub1 = makeSubStep('review-a', ['approved', 'rejected']);
      const sub2 = makeSubStep('review-b', ['approved', 'rejected']);

      const step = makeParentStep([sub1, sub2], [
        {
          condition: 'any approved',
          isAggregateCondition: true,
          aggregateType: 'any',
          aggregateConditionText: 'approved',
          next: 'fix',
        },
      ]);

      // Both matched "rejected" (index 1)
      const state = makeState({
        'review-a': { matchedRuleIndex: 1 },
        'review-b': { matchedRuleIndex: 1 },
      });

      const evaluator = new AggregateEvaluator(step, state);
      expect(evaluator.evaluate()).toBe(-1);
    });
  });

  describe('any() with multiple conditions', () => {
    it('should match when any sub-step matches any of the conditions', () => {
      const sub1 = makeSubStep('review-a', ['approved', 'rejected', 'needs-work']);
      const sub2 = makeSubStep('review-b', ['approved', 'rejected', 'needs-work']);

      const step = makeParentStep([sub1, sub2], [
        {
          condition: 'any approved or needs-work',
          isAggregateCondition: true,
          aggregateType: 'any',
          aggregateConditionText: ['approved', 'needs-work'],
          next: 'fix',
        },
      ]);

      // sub1 matched "rejected" (index 1), sub2 matched "needs-work" (index 2)
      const state = makeState({
        'review-a': { matchedRuleIndex: 1 },
        'review-b': { matchedRuleIndex: 2 },
      });

      const evaluator = new AggregateEvaluator(step, state);
      expect(evaluator.evaluate()).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('should return -1 when step has no rules', () => {
      const step = makeParentStep([], undefined);
      const state = makeState({});
      const evaluator = new AggregateEvaluator(step, state);
      expect(evaluator.evaluate()).toBe(-1);
    });

    it('should return -1 when step has no parallel sub-steps', () => {
      const step: WorkflowStep = {
        name: 'test-step',
        personaDisplayName: 'tester',
        instruction: '',
        passPreviousResponse: false,
        rules: [
          {
            condition: 'all approved',
            isAggregateCondition: true,
            aggregateType: 'all',
            aggregateConditionText: 'approved',
          },
        ],
      };
      const state = makeState({});
      const evaluator = new AggregateEvaluator(step, state);
      expect(evaluator.evaluate()).toBe(-1);
    });

    it('should return -1 when rules exist but none are aggregate conditions', () => {
      const sub1 = makeSubStep('review-a', ['approved']);
      const step = makeParentStep([sub1], [
        { condition: 'approved', next: 'COMPLETE' },
      ]);
      const state = makeState({ 'review-a': { matchedRuleIndex: 0 } });
      const evaluator = new AggregateEvaluator(step, state);
      expect(evaluator.evaluate()).toBe(-1);
    });

    it('should evaluate multiple rules and return first matching index', () => {
      const sub1 = makeSubStep('review-a', ['approved', 'rejected']);
      const sub2 = makeSubStep('review-b', ['approved', 'rejected']);

      const step = makeParentStep([sub1, sub2], [
        {
          condition: 'all approved',
          isAggregateCondition: true,
          aggregateType: 'all',
          aggregateConditionText: 'approved',
          next: 'COMPLETE',
        },
        {
          condition: 'any rejected',
          isAggregateCondition: true,
          aggregateType: 'any',
          aggregateConditionText: 'rejected',
          next: 'fix',
        },
      ]);

      // sub1: approved, sub2: rejected → first rule (all approved) fails, second (any rejected) matches
      const state = makeState({
        'review-a': { matchedRuleIndex: 0 },
        'review-b': { matchedRuleIndex: 1 },
      });

      const evaluator = new AggregateEvaluator(step, state);
      expect(evaluator.evaluate()).toBe(1);
    });

    it('should skip sub-steps missing from state outputs', () => {
      const sub1 = makeSubStep('review-a', ['approved']);
      const sub2 = makeSubStep('review-b', ['approved']);

      const step = makeParentStep([sub1, sub2], [
        {
          condition: 'all approved',
          isAggregateCondition: true,
          aggregateType: 'all',
          aggregateConditionText: 'approved',
          next: 'COMPLETE',
        },
      ]);

      // review-b is missing from state
      const state = makeState({
        'review-a': { matchedRuleIndex: 0 },
      });

      const evaluator = new AggregateEvaluator(step, state);
      expect(evaluator.evaluate()).toBe(-1);
    });
  });
});
