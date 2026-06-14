import { describe, expect, it, vi } from 'vitest';
import { RuleEvaluator, type RuleEvaluatorContext } from '../core/workflow/evaluation/RuleEvaluator.js';
import { isDeterministicCondition } from '../core/workflow/evaluation/rule-utils.js';
import type { AgentResponse, WorkflowState } from '../core/models/types.js';
import { makeRule, makeStep } from './test-helpers.js';

type FindingsRuleContext = {
  findings: {
    open: {
      count: number;
      bySeverity: Record<string, number>;
        items: Array<{ id: string; severity: string; title: string }>;
      };
    resolved: {
      count: number;
    };
    conflicts: {
      count: number;
      items: Array<{ id: string; status: string; findingIds: string[]; rawFindingIds: string[]; description: string }>;
    };
  };
};

function makeStepOutput(persona: string, matchedRuleIndex: number): AgentResponse {
  return {
    persona,
    status: 'done',
    content: '',
    timestamp: new Date('2026-06-13T00:00:00.000Z'),
    matchedRuleIndex,
  };
}

function makeState(
  findings?: FindingsRuleContext['findings'],
  stepOutputs?: Record<string, number>,
): WorkflowState & Partial<FindingsRuleContext> {
  return {
    workflowName: 'finding-workflow',
    currentStep: 'peer-review',
    iteration: 1,
    stepOutputs: new Map(
      Object.entries(stepOutputs ?? {}).map(([persona, matchedRuleIndex]) => [
        persona,
        makeStepOutput(persona, matchedRuleIndex),
      ]),
    ),
    structuredOutputs: new Map(),
    systemContexts: new Map(),
    effectResults: new Map(),
    userInputs: [],
    personaSessions: new Map(),
    stepIterations: new Map(),
    status: 'running',
    ...(findings !== undefined ? { findings } : {}),
  };
}

function makeContext(state: WorkflowState): RuleEvaluatorContext {
  return {
    state,
    cwd: '/tmp/project',
    detectRuleIndex: vi.fn().mockReturnValue(-1),
    structuredCaller: {
      evaluateCondition: vi.fn().mockRejectedValue(new Error('AI judge should not run for findings rules')),
    } as RuleEvaluatorContext['structuredCaller'],
  };
}

describe('RuleEvaluator findings conditions', () => {
  it('should classify findings references as deterministic conditions', () => {
    expect(isDeterministicCondition('findings.open.count == 0')).toBe(true);
    expect(isDeterministicCondition('findings.open.bySeverity.high > 0')).toBe(true);
  });

  it('should evaluate finding count and severity without AI judge', async () => {
    const state = makeState({
      open: {
        count: 2,
        bySeverity: { high: 1, medium: 1, low: 0 },
        items: [
          { id: 'F-0001', severity: 'high', title: 'Blocks release' },
          { id: 'F-0002', severity: 'medium', title: 'Needs cleanup' },
        ],
      },
      resolved: { count: 0 },
      conflicts: { count: 0, items: [] },
    });
    const step = makeStep({
      name: 'peer-review',
      rules: [
        { condition: 'findings.open.count == 0', next: 'COMPLETE' },
        { condition: 'findings.open.bySeverity.high > 0', next: 'fix' },
      ],
    });
    const ctx = makeContext(state);

    const result = await new RuleEvaluator(step, ctx).evaluate('', '');

    expect(result).toEqual({ index: 1, method: 'auto_select' });
    expect(ctx.structuredCaller.evaluateCondition).not.toHaveBeenCalled();
  });

  it('should evaluate exists() over open finding items', async () => {
    const state = makeState({
      open: {
        count: 1,
        bySeverity: { high: 1 },
        items: [{ id: 'F-0001', severity: 'high', title: 'Blocks release' }],
      },
      resolved: { count: 0 },
      conflicts: { count: 0, items: [] },
    });
    const step = makeStep({
      name: 'peer-review',
      rules: [
        { condition: 'exists(findings.open.items, item.severity == "high" && item.id == "F-0001")', next: 'fix' },
      ],
    });

    const result = await new RuleEvaluator(step, makeContext(state)).evaluate('', '');

    expect(result).toEqual({ index: 0, method: 'auto_select' });
  });

  it('should use AI adjudication when conflicts exist with open findings', async () => {
    const evaluateCondition = vi.fn().mockResolvedValue(2);
    const state = makeState({
      open: {
        count: 1,
        bySeverity: { high: 1, medium: 0, low: 0 },
        items: [{ id: 'F-0001', severity: 'high', title: 'Blocks release' }],
      },
      resolved: { count: 1 },
      conflicts: {
        count: 1,
        items: [
          {
            id: 'C-1CA24A220BC7',
            status: 'active',
            findingIds: ['F-0001'],
            rawFindingIds: ['raw-security-review-1'],
            description: 'Security and pure review disagree about resolution.',
          },
        ],
      },
    });
    const step = makeStep({
      name: 'peer-review',
      rules: [
        { condition: 'findings.open.count == 0 && findings.conflicts.count == 0', next: 'COMPLETE' },
        { condition: 'findings.conflicts.count == 0 && findings.open.count > 0', next: 'fix' },
        makeRule('ai("adjudicate active findings conflicts")', 'fix', {
          isAiCondition: true,
          aiConditionText: 'adjudicate active findings conflicts',
        }),
        { condition: 'findings.conflicts.count > 0', return: 'need_replan' },
      ],
    });
    const ctx = makeContext(state);
    ctx.structuredCaller.evaluateCondition = evaluateCondition;

    const result = await new RuleEvaluator(step, ctx).evaluate('', '');

    expect(result).toEqual({ index: 2, method: 'ai_judge' });
    expect(evaluateCondition).toHaveBeenCalled();
  });

  it('should route needs_fix aggregate to fix even when findings are empty', async () => {
    const state = makeState(
      {
        open: {
          count: 0,
          bySeverity: { high: 0, medium: 0, low: 0 },
          items: [],
        },
        resolved: { count: 0 },
        conflicts: { count: 0, items: [] },
      },
      {
        'coding-review': 1,
        'security-review': 0,
      },
    );
    const codingReview = makeStep({
      name: 'coding-review',
      rules: [{ condition: 'approved' }, { condition: 'needs_fix' }],
    });
    const securityReview = makeStep({
      name: 'security-review',
      rules: [{ condition: 'approved' }, { condition: 'needs_fix' }],
    });
    const step = makeStep({
      name: 'peer-review',
      parallel: [codingReview, securityReview],
      rules: [
        {
          condition: 'all("approved") && findings.open.count == 0 && findings.conflicts.count == 0',
          next: 'COMPLETE',
          isAggregateCondition: true,
          aggregateType: 'all',
          aggregateConditionText: 'approved',
          aggregateGuardCondition: 'findings.open.count == 0 && findings.conflicts.count == 0',
        },
        {
          condition: 'any("needs_fix") && findings.conflicts.count == 0',
          next: 'fix',
          isAggregateCondition: true,
          aggregateType: 'any',
          aggregateConditionText: 'needs_fix',
          aggregateGuardCondition: 'findings.conflicts.count == 0',
        },
      ],
    });
    const ctx = makeContext(state);

    const result = await new RuleEvaluator(step, ctx).evaluate('', '');

    expect(result).toEqual({ index: 1, method: 'aggregate' });
    expect(ctx.structuredCaller.evaluateCondition).not.toHaveBeenCalled();
  });

  it('should fail fast when findings state is absent for a findings rule', async () => {
    const step = makeStep({
      name: 'peer-review',
      rules: [{ condition: 'findings.open.count == 0', next: 'COMPLETE' }],
    });

    await expect(new RuleEvaluator(step, makeContext(makeState())).evaluate('', '')).rejects.toThrow(
      'Missing workflow findings state',
    );
  });

  it('should fail fast when findings state is absent for a findings aggregate guard', async () => {
    const reviewStep = makeStep({
      name: 'review',
      rules: [{ condition: 'approved' }],
    });
    const step = makeStep({
      name: 'peer-review',
      parallel: [reviewStep],
      rules: [
        {
          condition: 'all("approved")',
          next: 'COMPLETE',
          isAggregateCondition: true,
          aggregateType: 'all',
          aggregateConditionText: 'approved',
          aggregateGuardCondition: 'findings.open.count == 0',
        },
      ],
    });

    await expect(new RuleEvaluator(step, makeContext(makeState(undefined, { review: 0 }))).evaluate('', '')).rejects.toThrow(
      'Missing workflow findings state',
    );
  });

  it('should not treat findings text inside ai conditions as a findings rule', async () => {
    const evaluateCondition = vi.fn().mockResolvedValue(0);
    const step = makeStep({
      name: 'peer-review',
      rules: [
        makeRule('ai("mention findings.open.count")', 'COMPLETE', {
          isAiCondition: true,
          aiConditionText: 'mention findings.open.count',
        }),
      ],
    });
    const ctx: RuleEvaluatorContext = {
      ...makeContext(makeState()),
      structuredCaller: {
        evaluateCondition,
      } as RuleEvaluatorContext['structuredCaller'],
    };

    const result = await new RuleEvaluator(step, ctx).evaluate('output', '');

    expect(result).toEqual({ index: 0, method: 'ai_judge' });
    expect(evaluateCondition).toHaveBeenCalledOnce();
  });
});
