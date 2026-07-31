import { describe, expect, it } from 'vitest';
import type { AgentResponse, WorkflowState, WorkflowStep } from '../core/models/types.js';
import { parseWorkflowRuleCondition, type WorkflowRuleCondition } from '../core/models/workflow-rule-condition.js';
import { AggregateEvaluator } from '../core/workflow/evaluation/AggregateEvaluator.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import { normalizeRule } from '../infra/config/loaders/workflowRuleNormalizer.js';

function aggregate(condition: string): Extract<WorkflowRuleCondition, { kind: 'aggregate' }> {
  const parsed = parseWorkflowRuleCondition(condition);
  if (parsed.kind !== 'aggregate') {
    throw new Error(`Expected aggregate condition: ${condition}`);
  }
  return parsed;
}

function child(name: string, conditions: string[] = ['approved', 'needs_fix']): WorkflowStep {
  return {
    name,
    personaDisplayName: name,
    instruction: '',
    passPreviousResponse: false,
    rules: conditions.map((condition) => normalizeRule({ condition, next: 'COMPLETE' })),
  };
}

function parent(conditions?: string[]): WorkflowStep {
  return {
    name: 'reviewers',
    personaDisplayName: 'reviewers',
    instruction: '',
    passPreviousResponse: false,
    parallel: [child('architecture', conditions), child('coding', conditions)],
  };
}

function state(indexes: Record<string, number>): WorkflowState {
  const stepOutputs = new Map<string, AgentResponse>(Object.entries(indexes).map(([name, matchedRuleIndex]) => [
    name,
    { persona: name, status: 'done', content: '', timestamp: new Date(), matchedRuleIndex },
  ]));
  return {
    workflowName: 'aggregate-evaluator',
    currentStep: 'reviewers',
    iteration: 1,
    status: 'running',
    stepOutputs,
    structuredOutputs: new Map(),
    systemContexts: new Map(),
    effectResults: new Map(),
    stepIterations: new Map(),
    restoredStepIterationNames: new Set(),
    dynamicParallelSelections: new Map(),
    resumedDynamicParallelSteps: new Set(),
    personaSessions: new Map(),
    userInputs: [],
  };
}

describe('AggregateEvaluator', () => {
  it('all() は全sub-stepの確定ラベルが一致するときだけ真になる', () => {
    expect(new AggregateEvaluator(parent(), state({ architecture: 0, coding: 0 }))
      .evaluateCondition(aggregate('all("approved")'))).toBe(true);
    expect(new AggregateEvaluator(parent(), state({ architecture: 0, coding: 1 }))
      .evaluateCondition(aggregate('all("approved")'))).toBe(false);
  });

  it('any() はいずれかのsub-stepの確定ラベルが一致するとき真になる', () => {
    expect(new AggregateEvaluator(parent(), state({ architecture: 0, coding: 1 }))
      .evaluateCondition(aggregate('any("needs_fix")'))).toBe(true);
  });

  it('uses the active canonical dynamic selection instead of another snapshot with the same step name', () => {
    const reviewers = parent();
    const candidates = reviewers.parallel!;
    reviewers.parallel = {
      kind: 'dynamic',
      fixed: [candidates[0]!],
      pool: [candidates[1]!],
      selection: { mode: 'replace' as const },
    };
    const evaluatedState = {
      ...state({ architecture: 0, coding: 1 }),
      activeDynamicParallelSelectionIdentity: 'parent:delegate > child:reviewers',
      dynamicParallelSelections: new Map([
        ['other:reviewers', {
          identity: 'other:reviewers',
          step_name: 'reviewers',
          round: 1,
          selected_pool_ids: ['coding'],
          effective_selection_ids: ['architecture', 'coding'],
        }],
        ['parent:delegate > child:reviewers', {
          identity: 'parent:delegate > child:reviewers',
          step_name: 'reviewers',
          round: 1,
          selected_pool_ids: [],
          effective_selection_ids: ['architecture'],
        }],
      ]),
    };

    expect(new AggregateEvaluator(reviewers, evaluatedState)
      .evaluateCondition(aggregate('all("approved")'))).toBe(true);
  });

  it.each(['all', 'any'] as const)(
    'should evaluate dynamic %s() against semantic labels from compound matched rules',
    (aggregateType) => {
      const reviewers = normalizeWorkflowConfig({
        name: 'dynamic-compound-result-rules',
        initial_step: 'reviewers',
        max_steps: 1,
        steps: [{
          name: 'reviewers',
          parallel: {
            fixed: [{
              name: 'architecture',
              instruction: 'Review architecture',
              rules: [{ condition: 'approved && when(true)', next: 'COMPLETE' }],
            }],
            pool: [{
              name: 'coding',
              description: 'Review code',
              instruction: 'Review code',
              rules: [{ condition: 'approved && when(true)', next: 'COMPLETE' }],
            }],
          },
          rules: [{ condition: `${aggregateType}("approved")`, next: 'COMPLETE' }],
        }],
      }, process.cwd()).steps[0];
      if (reviewers === undefined) {
        throw new Error('Normalized dynamic step is missing');
      }
      const identity = 'workflow:reviewers';
      const evaluatedState = {
        ...state({ architecture: 0, coding: 0 }),
        activeDynamicParallelSelectionIdentity: identity,
        dynamicParallelSelections: new Map([
          [identity, {
            identity,
            step_name: 'reviewers',
            round: 1,
            selected_pool_ids: ['coding'],
            effective_selection_ids: ['architecture', 'coding'],
          }],
        ]),
      };

      expect(new AggregateEvaluator(reviewers, evaluatedState)
        .evaluateCondition(aggregate(`${aggregateType}("approved")`))).toBe(true);
    },
  );

  it('should reject a dynamic aggregate when the active selection identity is missing', () => {
    const reviewers = parent();
    const candidates = reviewers.parallel!;
    reviewers.parallel = {
      kind: 'dynamic',
      fixed: [candidates[0]!],
      pool: [candidates[1]!],
      selection: { mode: 'replace' },
    };

    expect(() => new AggregateEvaluator(reviewers, state({ architecture: 0, coding: 0 }))
      .evaluateCondition(aggregate('all("approved")')))
      .toThrow('requires an active selection identity');
  });

  it('should reject a dynamic aggregate when the active snapshot identity does not match', () => {
    const reviewers = parent();
    const candidates = reviewers.parallel!;
    reviewers.parallel = {
      kind: 'dynamic',
      fixed: [candidates[0]!],
      pool: [candidates[1]!],
      selection: { mode: 'replace' },
    };
    const evaluatedState = {
      ...state({ architecture: 0, coding: 0 }),
      activeDynamicParallelSelectionIdentity: 'active',
      dynamicParallelSelections: new Map([
        ['active', {
          identity: 'different',
          step_name: 'reviewers',
          round: 1,
          selected_pool_ids: ['coding'],
          effective_selection_ids: ['architecture', 'coding'],
        }],
      ]),
    };

    expect(() => new AggregateEvaluator(reviewers, evaluatedState)
      .evaluateCondition(aggregate('all("approved")')))
      .toThrow('requires a matching selection snapshot');
  });

  it('does not apply a dynamic selection snapshot to a legacy parallel step', () => {
    const evaluatedState = {
      ...state({ architecture: 0, coding: 1 }),
      activeDynamicParallelSelectionIdentity: 'nested:reviewers',
      dynamicParallelSelections: new Map([
        ['nested:reviewers', {
          identity: 'nested:reviewers',
          step_name: 'reviewers',
          round: 1,
          selected_pool_ids: [],
          effective_selection_ids: ['architecture'],
        }],
      ]),
    };

    expect(new AggregateEvaluator(parent(), evaluatedState)
      .evaluateCondition(aggregate('all("approved")'))).toBe(false);
  });

  it('順序付きall() は各sub-stepのラベル列が一致しなければ偽になる', () => {
    expect(new AggregateEvaluator(parent(), state({ architecture: 1, coding: 0 }))
      .evaluateCondition(aggregate('all("approved", "needs_fix")'))).toBe(false);
  });

  it('順序付きall() は各sub-stepの確定conditionが同じ順序で一致するとき真になる', () => {
    expect(new AggregateEvaluator(parent(), state({ architecture: 0, coding: 1 }))
      .evaluateCondition(aggregate('all("approved", "needs_fix")'))).toBe(true);
  });

  it('順序付きall() はcondition数とsub-step数が異なるとき偽になる', () => {
    expect(new AggregateEvaluator(parent(), state({ architecture: 0, coding: 1 }))
      .evaluateCondition(aggregate('all("approved", "needs_fix", "blocked")'))).toBe(false);
  });

  it.each([
    'when(true)',
    'approved && when(true)',
  ])('all() はsub-stepで確定した非semantic condition %s の全体と照合する', (condition) => {
    expect(new AggregateEvaluator(parent([condition]), state({ architecture: 0, coding: 0 }))
      .evaluateCondition(aggregate(`all(${JSON.stringify(condition)})`))).toBe(true);
  });

  it('any() はsub-stepで確定した非semantic conditionの全体と照合する', () => {
    expect(new AggregateEvaluator(parent(['when(true)', 'approved']), state({ architecture: 0, coding: 1 }))
      .evaluateCondition(aggregate('any("when(true)")'))).toBe(true);
  });

  it.each([
    { aggregateCondition: 'all("when( true )")', indexes: { architecture: 0, coding: 0 } },
    { aggregateCondition: 'all("when( true )", "approved")', indexes: { architecture: 0, coding: 1 } },
    { aggregateCondition: 'any("when( true )")', indexes: { architecture: 0, coding: 1 } },
  ])('$aggregateCondition はsub-step conditionと同じ標準形で照合する', ({ aggregateCondition, indexes }) => {
    expect(new AggregateEvaluator(parent(['when(true)', 'approved']), state(indexes))
      .evaluateCondition(aggregate(aggregateCondition))).toBe(true);
  });

  it.each(['all', 'any'] as const)('%s() は確定conditionがないsub-stepを一致扱いしない', (aggregateType) => {
    expect(new AggregateEvaluator(parent(), state({}))
      .evaluateCondition(aggregate(`${aggregateType}("approved")`))).toBe(false);
  });

  it('aggregate以外のconditionとparallelを持たないstepは偽になる', () => {
    const nonParallel = parent();
    nonParallel.parallel = undefined;

    expect(new AggregateEvaluator(parent(), state({ architecture: 0, coding: 0 }))
      .evaluateCondition(parseWorkflowRuleCondition('approved'))).toBe(false);
    expect(new AggregateEvaluator(nonParallel, state({ architecture: 0, coding: 0 }))
      .evaluateCondition(aggregate('all("approved")'))).toBe(false);
  });
});
