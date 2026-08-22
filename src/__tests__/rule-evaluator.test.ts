import { describe, expect, it } from 'vitest';
import { RuleDetectionExhaustedError } from '../core/workflow/evaluation/RuleDetectionExhaustedError.js';
import { RuleEvaluator, type RuleEvaluatorContext } from '../core/workflow/evaluation/RuleEvaluator.js';
import type { WorkflowState } from '../core/models/types.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';
import { makeStep } from './test-helpers.js';

function createState(): WorkflowState {
  return {
    workflowName: 'rule-evaluator',
    currentStep: 'review',
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

function createContext(overrides: Partial<RuleEvaluatorContext> = {}): RuleEvaluatorContext {
  return {
    state: createState(),
    ...overrides,
  };
}

describe('RuleEvaluator', () => {
  it('returns undefined when the step has no rules', () => {
    const evaluator = new RuleEvaluator(makeStep({ rules: undefined }), createContext());

    expect(evaluator.evaluate(undefined)).toBeUndefined();
  });

  it('uses a true when() rule at its YAML position instead of deferring it behind a later semantic tag', () => {
    const step = makeStep({
      rules: [
        normalizeRule({ condition: 'when(true)', next: 'wait_before_next_scan' }),
        normalizeRule({ condition: 'approved', next: 'COMPLETE' }),
      ],
    });

    const result = new RuleEvaluator(step, createContext()).evaluate({ label: 'approved', method: 'phase3_tag' });

    expect(result).toMatchObject({ index: 0 });
  });

  it('continues to the later rule when the selected semantic label has a false guard', () => {
    const step = makeStep({
      rules: [
        normalizeRule({ condition: 'needs_fix && when(false)', next: 'need_replan' }),
        normalizeRule({ condition: 'needs_fix', next: 'fix' }),
      ],
    });

    const result = new RuleEvaluator(step, createContext()).evaluate({ label: 'needs_fix', method: 'ai_judge' });

    expect(result).toMatchObject({ index: 1 });
  });

  it('fails closed when no condition matches instead of invoking an all-condition AI fallback', () => {
    const step = makeStep({
      rules: [normalizeRule({ condition: 'when(false)', next: 'COMPLETE' })],
    });

    expect(() => new RuleEvaluator(step, createContext()).evaluate(undefined))
      .toThrow(RuleDetectionExhaustedError);
  });
});
