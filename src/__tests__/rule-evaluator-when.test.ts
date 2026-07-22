import { describe, expect, it } from 'vitest';
import { evaluateWhenExpression } from '../core/workflow/evaluation/when-evaluator.js';
import { RuleEvaluator, type RuleEvaluatorContext } from '../core/workflow/evaluation/RuleEvaluator.js';
import type { WorkflowState } from '../core/models/types.js';
import { makeRule, makeStep } from './test-helpers.js';

function makeState(): WorkflowState {
  return {
    workflowName: 'system-workflow',
    currentStep: 'route_context',
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

function makeContext(state: WorkflowState): RuleEvaluatorContext {
  return { state };
}


describe('when expression empty clauses', () => {
  it.each([
    ['and', 'context.a.exists == true && && context.b.exists == true'],
    ['or', 'context.a.exists == true || || context.b.exists == true'],
    ['exists-inner', 'exists(findings.open.items, item.severity == "high" && && item.id == "F-1")'],
  ])('should throw on empty clauses in %s expressions at evaluation time', (_label, expression) => {
    const state = {
      context: { a: { exists: true }, b: { exists: true } },
      findings: {
        open: {
          count: 1,
          bySeverity: { critical: 0, high: 1, medium: 0, low: 0 },
          items: [{ id: 'F-1', severity: 'high', title: 't', reviewers: [] }],
        },
        resolved: { count: 0 },
        waived: { count: 0 },
        conflicts: { count: 0, items: [] },
      },
    } as never;
    expect(() => evaluateWhenExpression(expression, state)).toThrow('contains an empty clause');
  });
});

describe('RuleEvaluator with when conditions', () => {
  it('context 参照の真偽式を AI judge なしで評価できる', () => {
    const state = makeState() as WorkflowState & {
      systemContexts: Map<string, unknown>;
    };
    state.systemContexts = new Map([
      ['route_context', { pr: { exists: false }, issue: { exists: true } }],
    ]);

    const step = makeStep({
      name: 'route_context',
      rules: [
        makeRule('when(context.route_context.pr.exists == false && context.route_context.issue.exists == true)', 'plan_from_issue'),
      ],
    });

    const evaluator = new RuleEvaluator(step, makeContext(state));
    const result = evaluator.evaluate(undefined);

    expect(result?.index).toBe(0);
  });

  it('context 参照で継承プロパティを状態値として扱わない', () => {
    const state = makeState();
    state.systemContexts.set('route_context', {});

    expect(() => evaluateWhenExpression(
      'context.route_context.toString == context.route_context.toString',
      state,
    )).toThrow('Missing workflow state value "context.route_context.toString"');
  });

  it('structured と effect の参照を組み合わせて評価できる', () => {
    const state = makeState() as WorkflowState & {
      structuredOutputs: Map<string, unknown>;
      effectResults: Map<string, unknown>;
    };
    state.structuredOutputs = new Map([
      ['plan_from_issue', { action: 'enqueue_new_task' }],
    ]);
    state.effectResults = new Map([
      ['enqueue_from_issue', { enqueue_task: { success: true } }],
    ]);

    const step = makeStep({
      name: 'enqueue_from_issue',
      rules: [
        makeRule('when(structured.plan_from_issue.action == "enqueue_new_task" && effect.enqueue_from_issue.enqueue_task.success == true)', 'COMPLETE'),
      ],
    });

    const evaluator = new RuleEvaluator(step, makeContext(state));
    const result = evaluator.evaluate(undefined);

    expect(result?.index).toBe(0);
  });

  it('数値比較演算子を deterministic に評価できる', () => {
    const state = makeState() as WorkflowState & {
      systemContexts: Map<string, unknown>;
    };
    state.systemContexts = new Map([
      ['wait_before_next_scan', { queue: { running_count: 1, pending_count: 0 } }],
    ]);

    const step = makeStep({
      name: 'wait_before_next_scan',
      rules: [
        makeRule('when(context.wait_before_next_scan.queue.running_count > 0 && context.wait_before_next_scan.queue.pending_count <= 0)', 'wait_before_next_scan'),
      ],
    });

    const evaluator = new RuleEvaluator(step, makeContext(state));
    const result = evaluator.evaluate(undefined);

    expect(result?.index).toBe(0);
  });

  it('配列の length と index 参照を deterministic に評価できる', () => {
    const state = makeState() as WorkflowState & {
      systemContexts: Map<string, unknown>;
    };
    state.systemContexts = new Map([
      ['route_context', {
        prs: [
          { number: 42, draft: false, author: 'nrslib' },
          { number: 41, draft: true, author: 'octocat' },
        ],
      }],
    ]);

    const step = makeStep({
      name: 'route_context',
      rules: [
        makeRule('when(context.route_context.prs.length > 1 && context.route_context.prs[0].number == 42 && context.route_context.prs[1].draft == true)', 'plan_from_existing_pr'),
      ],
    });

    const evaluator = new RuleEvaluator(step, makeContext(state));
    const result = evaluator.evaluate(undefined);

    expect(result?.index).toBe(0);
  });

  it('配列の field 射影参照を deterministic に評価できる', () => {
    const state = makeState() as WorkflowState & {
      systemContexts: Map<string, unknown>;
    };
    state.systemContexts = new Map([
      ['route_context', {
        prs: [
          { number: 42, draft: false, author: 'nrslib' },
          { number: 41, draft: true, author: 'octocat' },
        ],
      }],
    ]);

    const step = makeStep({
      name: 'route_context',
      rules: [
        makeRule('when(context.route_context.prs.author.length == 2 && context.route_context.prs.author[0] == "nrslib" && context.route_context.prs.number[1] == 41)', 'plan_from_existing_pr'),
      ],
    });

    const evaluator = new RuleEvaluator(step, makeContext(state));
    const result = evaluator.evaluate(undefined);

    expect(result?.index).toBe(0);
  });

  it('配列の field 射影で継承プロパティを状態値として扱わない', () => {
    const state = makeState();
    state.systemContexts.set('route_context', { items: [{}] });

    expect(() => evaluateWhenExpression(
      'context.route_context.items.toString.length == 1',
      state,
    )).toThrow('Missing workflow state value "context.route_context.items.toString.length"');
  });

  it('exists(...) で配列要素条件を deterministic に評価できる', () => {
    const state = makeState() as WorkflowState & {
      systemContexts: Map<string, unknown>;
    };
    state.systemContexts = new Map([
      ['wait_before_next_scan', {
        queue: {
          items: [
            { kind: 'running', pr: 42 },
            { kind: 'pending', pr: null },
          ],
        },
      }],
    ]);

    const step = makeStep({
      name: 'wait_before_next_scan',
      rules: [
        makeRule('when(exists(context.wait_before_next_scan.queue.items, item.kind == "running" && item.pr == 42))', 'wait_before_next_scan'),
      ],
    });

    const evaluator = new RuleEvaluator(step, makeContext(state));
    const result = evaluator.evaluate(undefined);

    expect(result?.index).toBe(0);
  });

  it('exists(...) で配列要素の継承プロパティを値として扱わない', () => {
    const state = makeState();
    state.systemContexts.set('route_context', { items: [{}] });

    expect(() => evaluateWhenExpression(
      'exists(context.route_context.items, item.constructor == item.constructor)',
      state,
    )).toThrow('Unsupported exists() operand "item.constructor"');
  });

  it('step 修飾のない effect 参照を condition の parse 時に reject する', () => {
    expect(() => makeRule(
      'when(effect.comment_pr.success == true)',
      'COMPLETE',
    )).toThrow(
      'Effect references must use "effect.<step>.<type>.<field>" format: "effect.comment_pr.success"',
    );
  });

  it('同じ effect type でも step 修飾で意図した結果だけを参照できる', () => {
    const state = makeState() as WorkflowState & {
      effectResults: Map<string, unknown>;
    };
    state.effectResults = new Map([
      ['comment_first', { comment_pr: { success: false } }],
      ['comment_second', { comment_pr: { success: true } }],
    ]);

    const step = makeStep({
      name: 'route_context',
      rules: [
        makeRule('when(effect.comment_second.comment_pr.success == true && effect.comment_first.comment_pr.success == false)', 'COMPLETE'),
      ],
    });

    const evaluator = new RuleEvaluator(step, makeContext(state));
    const result = evaluator.evaluate(undefined);

    expect(result?.index).toBe(0);
  });

  it('semantic selection を使い、先行する machine rule が不成立なら YAML 順で一致する rule を返す', () => {
    const state = makeState() as WorkflowState & {
      systemContexts: Map<string, unknown>;
    };
    state.systemContexts = new Map([
      ['route_context', { task: { exists: false } }],
    ]);
    const step = makeStep({
      name: 'mixed-step',
      rules: [
        makeRule('when(context.route_context.task.exists == true)', 'skip'),
        makeRule('all("done")', 'aggregate'),
        makeRule('manual approval', 'approved'),
        makeRule('interactive manual check', 'interactive', { interactiveOnly: true }),
      ],
    });

    const evaluator = new RuleEvaluator(step, {
      ...makeContext(state),
    });
    const result = evaluator.evaluate({ label: 'manual approval', method: 'phase3_tag' });

    expect(result).toEqual({ index: 2, method: 'phase3_tag' });
  });
});

describe('operators inside string literals', () => {
  it('should not split exists() predicates on operators inside quoted strings', () => {
    const state = makeState() as WorkflowState & { structuredOutputs: Map<string, unknown> };
    state.structuredOutputs.set('scan', { items: [{ note: 'a == b' }] });

    expect(evaluateWhenExpression('exists(structured.scan.items, "a == b" == item.note)', state)).toBe(true);
  });


  it('should not split on operators that appear inside quoted strings', () => {
    const state = makeState() as WorkflowState & { structuredOutputs: Map<string, unknown> };
    state.structuredOutputs.set('plan', { note: 'a == b' });

    expect(evaluateWhenExpression('structured.plan.note == "a == b"', state)).toBe(true);
  });

  it('should compare decoded quote and backslash escapes with state values', () => {
    const state = makeState();
    state.structuredOutputs.set('scan', { note: 'a"b\\c' });

    expect(evaluateWhenExpression(
      String.raw`structured.scan.note == "a\"b\\c"`,
      state,
    )).toBe(true);
  });

  it('should compare decoded string escapes in exists predicates', () => {
    const state = makeState();
    state.structuredOutputs.set('scan', {
      items: [{ title: 'a"b', location: 'C:\\tmp' }],
    });

    expect(evaluateWhenExpression(
      String.raw`exists(structured.scan.items, item.title == "a\"b" && item.location == "C:\\tmp")`,
      state,
    )).toBe(true);
  });
});
