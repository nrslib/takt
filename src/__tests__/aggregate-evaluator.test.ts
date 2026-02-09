/**
 * Unit tests for AggregateEvaluator
 *
 * Tests all()/any() aggregate condition evaluation against sub-movement results.
 */

import { describe, it, expect } from 'vitest';
import { AggregateEvaluator } from '../core/piece/evaluation/AggregateEvaluator.js';
import type { PieceMovement, PieceState, AgentResponse } from '../core/models/types.js';

function makeState(outputs: Record<string, { matchedRuleIndex?: number }>): PieceState {
  const movementOutputs = new Map<string, AgentResponse>();
  for (const [name, data] of Object.entries(outputs)) {
    movementOutputs.set(name, {
      persona: name,
      status: 'done',
      content: '',
      timestamp: new Date(),
      matchedRuleIndex: data.matchedRuleIndex,
    });
  }
  return {
    pieceName: 'test',
    currentMovement: 'parent',
    iteration: 1,
    movementOutputs,
    userInputs: [],
    personaSessions: new Map(),
    movementIterations: new Map(),
    status: 'running',
  };
}

function makeSubMovement(name: string, conditions: string[]): PieceMovement {
  return {
    name,
    personaDisplayName: name,
    instructionTemplate: '',
    passPreviousResponse: false,
    rules: conditions.map((c) => ({ condition: c })),
  };
}

function makeParentMovement(
  parallel: PieceMovement[],
  rules: PieceMovement['rules'],
): PieceMovement {
  return {
    name: 'parent',
    personaDisplayName: 'parent',
    instructionTemplate: '',
    passPreviousResponse: false,
    parallel,
    rules,
  };
}

describe('AggregateEvaluator', () => {
  describe('all() with single condition', () => {
    it('should match when all sub-movements have matching condition', () => {
      const sub1 = makeSubMovement('review-a', ['approved', 'rejected']);
      const sub2 = makeSubMovement('review-b', ['approved', 'rejected']);

      const step = makeParentMovement([sub1, sub2], [
        {
          condition: 'all approved',
          isAggregateCondition: true,
          aggregateType: 'all',
          aggregateConditionText: 'approved',
          next: 'COMPLETE',
        },
      ]);

      // Both sub-movements matched rule index 0 ("approved")
      const state = makeState({
        'review-a': { matchedRuleIndex: 0 },
        'review-b': { matchedRuleIndex: 0 },
      });

      const evaluator = new AggregateEvaluator(step, state);
      expect(evaluator.evaluate()).toBe(0);
    });

    it('should not match when one sub-movement has different condition', () => {
      const sub1 = makeSubMovement('review-a', ['approved', 'rejected']);
      const sub2 = makeSubMovement('review-b', ['approved', 'rejected']);

      const step = makeParentMovement([sub1, sub2], [
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

    it('should not match when sub-movement has no matched rule', () => {
      const sub1 = makeSubMovement('review-a', ['approved', 'rejected']);
      const sub2 = makeSubMovement('review-b', ['approved', 'rejected']);

      const step = makeParentMovement([sub1, sub2], [
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
    it('should match when each sub-movement matches its corresponding condition', () => {
      const sub1 = makeSubMovement('review-a', ['approved', 'rejected']);
      const sub2 = makeSubMovement('review-b', ['approved', 'rejected']);

      const step = makeParentMovement([sub1, sub2], [
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

    it('should not match when condition count differs from sub-movement count', () => {
      const sub1 = makeSubMovement('review-a', ['approved']);

      const step = makeParentMovement([sub1], [
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
    it('should match when at least one sub-movement has matching condition', () => {
      const sub1 = makeSubMovement('review-a', ['approved', 'rejected']);
      const sub2 = makeSubMovement('review-b', ['approved', 'rejected']);

      const step = makeParentMovement([sub1, sub2], [
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

    it('should not match when no sub-movement has matching condition', () => {
      const sub1 = makeSubMovement('review-a', ['approved', 'rejected']);
      const sub2 = makeSubMovement('review-b', ['approved', 'rejected']);

      const step = makeParentMovement([sub1, sub2], [
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
    it('should match when any sub-movement matches any of the conditions', () => {
      const sub1 = makeSubMovement('review-a', ['approved', 'rejected', 'needs-work']);
      const sub2 = makeSubMovement('review-b', ['approved', 'rejected', 'needs-work']);

      const step = makeParentMovement([sub1, sub2], [
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
      const step = makeParentMovement([], undefined);
      const state = makeState({});
      const evaluator = new AggregateEvaluator(step, state);
      expect(evaluator.evaluate()).toBe(-1);
    });

    it('should return -1 when step has no parallel sub-movements', () => {
      const step: PieceMovement = {
        name: 'test-movement',
        personaDisplayName: 'tester',
        instructionTemplate: '',
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
      const sub1 = makeSubMovement('review-a', ['approved']);
      const step = makeParentMovement([sub1], [
        { condition: 'approved', next: 'COMPLETE' },
      ]);
      const state = makeState({ 'review-a': { matchedRuleIndex: 0 } });
      const evaluator = new AggregateEvaluator(step, state);
      expect(evaluator.evaluate()).toBe(-1);
    });

    it('should evaluate multiple rules and return first matching index', () => {
      const sub1 = makeSubMovement('review-a', ['approved', 'rejected']);
      const sub2 = makeSubMovement('review-b', ['approved', 'rejected']);

      const step = makeParentMovement([sub1, sub2], [
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

    it('should skip sub-movements missing from state outputs', () => {
      const sub1 = makeSubMovement('review-a', ['approved']);
      const sub2 = makeSubMovement('review-b', ['approved']);

      const step = makeParentMovement([sub1, sub2], [
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
