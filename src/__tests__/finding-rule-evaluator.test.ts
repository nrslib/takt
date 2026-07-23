import { describe, expect, it } from 'vitest';
import type { WorkflowState } from '../core/models/types.js';
import { RuleEvaluator } from '../core/workflow/evaluation/RuleEvaluator.js';
import { evaluateWhenExpression } from '../core/workflow/evaluation/when-evaluator.js';
import { makeRule, makeStep } from './test-helpers.js';

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
      reviewerAnomalies: { count: 0, outstanding: 0, acknowledged: 0, budgetExhausted: false },
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
