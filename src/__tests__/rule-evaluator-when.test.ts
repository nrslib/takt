import { describe, expect, it, vi } from 'vitest';
import { RuleEvaluator, type RuleEvaluatorContext } from '../core/workflow/evaluation/RuleEvaluator.js';
import type { WorkflowState } from '../core/models/types.js';
import { makeStep } from './test-helpers.js';

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
  return {
    state,
    cwd: '/tmp/test',
    detectRuleIndex: vi.fn().mockReturnValue(-1),
    structuredCaller: {
      evaluateCondition: vi.fn().mockRejectedValue(new Error('AI judge should not run for when conditions')),
    } as RuleEvaluatorContext['structuredCaller'],
  };
}

describe('RuleEvaluator with when conditions', () => {
  it('context 参照の真偽式を AI judge なしで評価できる', async () => {
    const state = makeState() as WorkflowState & {
      systemContexts: Map<string, unknown>;
    };
    state.systemContexts = new Map([
      ['route_context', { pr: { exists: false }, issue: { exists: true } }],
    ]);

    const step = makeStep({
      name: 'route_context',
      rules: [
        {
          condition: 'context.route_context.pr.exists == false && context.route_context.issue.exists == true',
          next: 'plan_from_issue',
        },
      ],
    });

    const evaluator = new RuleEvaluator(step, makeContext(state));
    const result = await evaluator.evaluate('', '');

    expect(result?.index).toBe(0);
  });

  it('structured と effect の参照を組み合わせて評価できる', async () => {
    const state = makeState() as WorkflowState & {
      structuredOutputs: Map<string, unknown>;
      effectResults: Map<string, unknown>;
    };
    state.structuredOutputs = new Map([
      ['plan_from_issue', { action: 'enqueue_new_task' }],
    ]);
    state.effectResults = new Map([
      ['enqueue_task', { success: true }],
    ]);

    const step = makeStep({
      name: 'enqueue_from_issue',
      rules: [
        {
          condition: 'structured.plan_from_issue.action == "enqueue_new_task" && effect.enqueue_task.success == true',
          next: 'COMPLETE',
        },
      ],
    });

    const evaluator = new RuleEvaluator(step, makeContext(state));
    const result = await evaluator.evaluate('', '');

    expect(result?.index).toBe(0);
  });

  it('数値比較演算子を deterministic に評価できる', async () => {
    const state = makeState() as WorkflowState & {
      systemContexts: Map<string, unknown>;
    };
    state.systemContexts = new Map([
      ['wait_before_next_scan', { queue: { running_count: 1, pending_count: 0 } }],
    ]);

    const step = makeStep({
      name: 'wait_before_next_scan',
      rules: [
        {
          condition: 'context.wait_before_next_scan.queue.running_count > 0 && context.wait_before_next_scan.queue.pending_count <= 0',
          next: 'wait_before_next_scan',
        },
      ],
    });

    const evaluator = new RuleEvaluator(step, makeContext(state));
    const result = await evaluator.evaluate('', '');

    expect(result?.index).toBe(0);
  });

  it('deterministic rule を含む mixed rules でも AI judge fallback の元 rule index を返す', async () => {
    const state = makeState() as WorkflowState & {
      systemContexts: Map<string, unknown>;
    };
    state.systemContexts = new Map([
      ['route_context', { task: { exists: false } }],
    ]);
    const evaluateCondition = vi.fn().mockResolvedValue(2);
    const step = makeStep({
      name: 'mixed-step',
      rules: [
        { condition: 'context.route_context.task.exists == true', next: 'skip' },
        { condition: 'all("done")', next: 'aggregate', isAggregateCondition: true, aggregateType: 'all', aggregateConditionText: 'done' },
        { condition: 'manual approval', next: 'approved' },
        { condition: 'interactive manual check', next: 'interactive', interactiveOnly: true },
      ],
    });

    const evaluator = new RuleEvaluator(step, {
      ...makeContext(state),
      structuredCaller: { evaluateCondition } as RuleEvaluatorContext['structuredCaller'],
    });
    const result = await evaluator.evaluate('fallback content', '');

    expect(result).toEqual({ index: 2, method: 'ai_judge_fallback' });
    expect(evaluateCondition).toHaveBeenCalledWith(
      'fallback content',
      [{ index: 2, text: 'manual approval' }],
      expect.any(Object),
    );
  });
});
