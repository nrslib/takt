import { describe, expect, it } from 'vitest';
import { RuleDetectionExhaustedError } from '../core/workflow/evaluation/RuleDetectionExhaustedError.js';
import { RuleEvaluator, type RuleEvaluatorContext } from '../core/workflow/evaluation/RuleEvaluator.js';
import type { WorkflowState } from '../core/models/types.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';
import { evaluateWhenExpression } from '../core/workflow/evaluation/when-evaluator.js';
import { makeRule, makeStep } from './test-helpers.js';

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

function stateWithFindings(overrides: Record<string, unknown> = {}): WorkflowState {
  return {
    workflowName: 'finding-workflow',
    currentStep: 'final-gate',
    iteration: 1,
    status: 'running',
    stepOutputs: new Map(),
    stepIterations: new Map(),
    personaSessions: new Map(),
    userInputs: [],
    findings: {
      open: { count: 0, bySeverity: {}, items: [] },
      resolved: { count: 0 },
      waived: { count: 0 },
      invalidated: { count: 0 },
      superseded: { count: 0 },
      provisional: { count: 0, fixpoint: false, items: [] },
      rounds: { budgetExhausted: false },
      reviewerAnomalies: { count: 0, budgetExhausted: false },
      conflicts: { count: 0, items: [], unadjudicated: { count: 0 } },
      ...overrides,
    },
  } as WorkflowState;
}

describe('RuleEvaluator findings conditions', () => {
  it('uses the first matching machine rule before a later semantic rule', () => {
    const step = makeStep({
      rules: [
        makeRule('when(findings.provisional.count > 0)', 'replan'),
        makeRule('needs_fix', 'fix'),
      ],
    });
    const state = stateWithFindings({ provisional: { count: 1, fixpoint: false, items: [] } });

    expect(new RuleEvaluator(step, { state }).evaluate({ label: 'needs_fix', method: 'structured_output' }))
      .toEqual({ index: 0, method: 'auto_select' });
  });

  it('continues after a false semantic guard without selecting another label', () => {
    const step = makeStep({
      rules: [
        makeRule('needs_fix && when(findings.provisional.count > 0)', 'replan'),
        makeRule('needs_fix && when(findings.conflicts.count == 0)', 'fix'),
      ],
    });

    expect(new RuleEvaluator(step, { state: stateWithFindings() })
      .evaluate({ label: 'needs_fix', method: 'phase3_tag' }))
      .toEqual({ index: 1, method: 'phase3_tag' });
  });

  it('evaluates finding family membership without relying on array order', () => {
    const step = makeStep({
      rules: [
        makeRule(
          'when(exists(findings.open.items, contains(item.familyTags, "provider-e2e")))',
          'fix',
        ),
        makeRule('when(true)', 'COMPLETE'),
      ],
    });
    const withProviderE2e = stateWithFindings({
      open: {
        count: 2,
        bySeverity: { high: 1, medium: 1 },
        items: [
          {
            id: 'F-0001',
            severity: 'high',
            title: 'Provider E2E is incomplete',
            familyTags: ['architecture', 'provider-e2e'],
            unknownRawFindingIds: [],
          },
          {
            id: 'F-0002',
            severity: 'medium',
            title: 'Unit coverage is incomplete',
            familyTags: ['testing'],
            unknownRawFindingIds: [],
          },
        ],
      },
    });
    const withoutProviderE2e = stateWithFindings({
      open: {
        count: 2,
        bySeverity: { high: 1, medium: 1 },
        items: [
          {
            id: 'F-0001',
            severity: 'high',
            title: 'Provider E2E is incomplete',
            familyTags: ['architecture'],
            unknownRawFindingIds: [],
          },
          {
            id: 'F-0002',
            severity: 'medium',
            title: 'Unit coverage is incomplete',
            familyTags: ['testing'],
            unknownRawFindingIds: [],
          },
        ],
      },
    });

    expect(new RuleEvaluator(step, { state: withProviderE2e }).evaluate(undefined))
      .toEqual({ index: 0, method: 'auto_select' });
    expect(new RuleEvaluator(step, { state: withoutProviderE2e }).evaluate(undefined))
      .toEqual({ index: 1, method: 'auto_select' });
  });

  it('rejects malformed contains() arity instead of routing to another rule', () => {
    expect(() => evaluateWhenExpression(
      'exists(findings.open.items, contains(item.familyTags, "provider-e2e", "testing"))',
      stateWithFindings(),
    )).toThrow('contains() requires exactly two arguments');
  });

  it('decodes escaped string literals in contains()', () => {
    const state = stateWithFindings({
      open: {
        count: 1,
        bySeverity: { high: 1 },
        items: [{
          id: 'F-0001',
          severity: 'high',
          title: 'Quoted family',
          familyTags: ['tag"quote'],
          unknownRawFindingIds: [],
        }],
      },
    });

    expect(evaluateWhenExpression(
      String.raw`exists(findings.open.items, contains(item.familyTags, "tag\"quote"))`,
      state,
    )).toBe(true);
  });

  it('fails fast when a findings condition is evaluated without findings state', () => {
    const step = makeStep({ rules: [makeRule('when(findings.open.count == 0)', 'COMPLETE')] });
    const state = { ...stateWithFindings() } as WorkflowState;
    delete (state as { findings?: unknown }).findings;

    expect(() => new RuleEvaluator(step, { state }).evaluate(undefined)).toThrow('Missing workflow findings state');
  });
});
