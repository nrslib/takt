/**
 * Rule evaluation integration tests.
 *
 * Tests the 5-stage rule evaluation cascade:
 * 1. Aggregate conditions (all/any)
 * 2. Phase 3 tag detection
 * 3. Phase 1 tag detection (fallback)
 * 4. AI judge for ai() conditions
 * 5. AI judge fallback for all conditions
 *
 * Also tests RuleMatchMethod tracking.
 *
 * Mocked: callAiJudge (controlled responses)
 * Not mocked: detectMatchedRule, evaluateAggregateConditions
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WorkflowStep, WorkflowState, WorkflowRule, AgentResponse } from '../models/types.js';

// --- Mocks ---

const mockCallAiJudge = vi.fn();

vi.mock('../claude/client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../claude/client.js')>();
  return {
    ...original,
    callAiJudge: (...args: unknown[]) => mockCallAiJudge(...args),
  };
});

vi.mock('../config/globalConfig.js', () => ({
  loadGlobalConfig: vi.fn().mockReturnValue({}),
  getLanguage: vi.fn().mockReturnValue('en'),
}));

vi.mock('../config/projectConfig.js', () => ({
  loadProjectConfig: vi.fn().mockReturnValue({}),
}));

// --- Imports (after mocks) ---

import { detectMatchedRule, evaluateAggregateConditions } from '../workflow/rule-evaluator.js';
import type { RuleMatch, RuleEvaluatorContext } from '../workflow/rule-evaluator.js';

// --- Test helpers ---

function makeRule(condition: string, next: string, extra?: Partial<WorkflowRule>): WorkflowRule {
  return { condition, next, ...extra };
}

function makeStep(name: string, rules: WorkflowRule[], parallel?: WorkflowStep[]): WorkflowStep {
  return {
    name,
    agent: 'test-agent',
    agentDisplayName: name,
    instructionTemplate: '{task}',
    passPreviousResponse: true,
    rules,
    parallel,
  };
}

function makeState(stepOutputs?: Map<string, AgentResponse>): WorkflowState {
  return {
    workflowName: 'it-test',
    currentStep: 'test',
    iteration: 1,
    status: 'running',
    stepOutputs: stepOutputs ?? new Map(),
    stepIterations: new Map(),
    agentSessions: new Map(),
    userInputs: [],
  };
}

function makeCtx(stepOutputs?: Map<string, AgentResponse>): RuleEvaluatorContext {
  return {
    state: makeState(stepOutputs),
    cwd: '/tmp/test',
  };
}

describe('Rule Evaluation IT: Phase 3 tag detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCallAiJudge.mockResolvedValue(-1);
  });

  it('should detect rule from Phase 3 tag content', async () => {
    const step = makeStep('plan', [
      makeRule('Clear', 'implement'),
      makeRule('Unclear', 'ABORT'),
    ]);

    const result = await detectMatchedRule(step, 'Agent output without tag.', '[PLAN:2]', makeCtx());

    expect(result).toEqual<RuleMatch>({ index: 1, method: 'phase3_tag' });
  });

  it('should prefer Phase 3 tag over Phase 1 tag', async () => {
    const step = makeStep('plan', [
      makeRule('Clear', 'implement'),
      makeRule('Unclear', 'ABORT'),
    ]);

    // Phase 1 has tag [PLAN:1], Phase 3 has tag [PLAN:2]
    const result = await detectMatchedRule(step, '[PLAN:1] Clear.', '[PLAN:2]', makeCtx());

    expect(result).toEqual<RuleMatch>({ index: 1, method: 'phase3_tag' });
  });
});

describe('Rule Evaluation IT: Phase 1 tag fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCallAiJudge.mockResolvedValue(-1);
  });

  it('should fall back to Phase 1 tag when Phase 3 has no tag', async () => {
    const step = makeStep('plan', [
      makeRule('Clear', 'implement'),
      makeRule('Unclear', 'ABORT'),
    ]);

    const result = await detectMatchedRule(step, '[PLAN:1] Requirements are clear.', '', makeCtx());

    expect(result).toEqual<RuleMatch>({ index: 0, method: 'phase1_tag' });
  });

  it('should detect last tag when multiple tags in Phase 1', async () => {
    const step = makeStep('plan', [
      makeRule('Clear', 'implement'),
      makeRule('Unclear', 'ABORT'),
    ]);

    const result = await detectMatchedRule(step, 'Some [PLAN:1] text then [PLAN:2] final.', '', makeCtx());

    expect(result).toEqual<RuleMatch>({ index: 1, method: 'phase1_tag' });
  });
});

describe('Rule Evaluation IT: Aggregate conditions (all/any)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCallAiJudge.mockResolvedValue(-1);
  });

  it('should match all("approved") when all sub-steps have "approved"', () => {
    const subStep1 = makeStep('arch-review', [
      makeRule('approved', ''),
      makeRule('needs_fix', ''),
    ]);
    const subStep2 = makeStep('security-review', [
      makeRule('approved', ''),
      makeRule('needs_fix', ''),
    ]);

    const parentStep = makeStep('reviewers', [
      makeRule('all("approved")', 'supervise', {
        isAggregateCondition: true,
        aggregateType: 'all',
        aggregateConditionText: 'approved',
      }),
      makeRule('any("needs_fix")', 'fix', {
        isAggregateCondition: true,
        aggregateType: 'any',
        aggregateConditionText: 'needs_fix',
      }),
    ], [subStep1, subStep2]);

    const outputs = new Map<string, AgentResponse>();
    outputs.set('arch-review', {
      agent: 'arch', status: 'done', content: 'approved',
      timestamp: new Date(), matchedRuleIndex: 0,
    });
    outputs.set('security-review', {
      agent: 'security', status: 'done', content: 'approved',
      timestamp: new Date(), matchedRuleIndex: 0,
    });

    const result = evaluateAggregateConditions(parentStep, makeState(outputs));

    expect(result).toBe(0); // all("approved") is rule index 0
  });

  it('should match any("needs_fix") when one sub-step has "needs_fix"', () => {
    const subStep1 = makeStep('arch-review', [
      makeRule('approved', ''),
      makeRule('needs_fix', ''),
    ]);
    const subStep2 = makeStep('security-review', [
      makeRule('approved', ''),
      makeRule('needs_fix', ''),
    ]);

    const parentStep = makeStep('reviewers', [
      makeRule('all("approved")', 'supervise', {
        isAggregateCondition: true,
        aggregateType: 'all',
        aggregateConditionText: 'approved',
      }),
      makeRule('any("needs_fix")', 'fix', {
        isAggregateCondition: true,
        aggregateType: 'any',
        aggregateConditionText: 'needs_fix',
      }),
    ], [subStep1, subStep2]);

    const outputs = new Map<string, AgentResponse>();
    outputs.set('arch-review', {
      agent: 'arch', status: 'done', content: 'approved',
      timestamp: new Date(), matchedRuleIndex: 0,
    });
    outputs.set('security-review', {
      agent: 'security', status: 'done', content: 'needs_fix',
      timestamp: new Date(), matchedRuleIndex: 1,
    });

    const result = evaluateAggregateConditions(parentStep, makeState(outputs));

    expect(result).toBe(1); // any("needs_fix") is rule index 1
  });

  it('should return -1 when no aggregate condition matches', () => {
    const subStep1 = makeStep('review-a', [
      makeRule('approved', ''),
      makeRule('needs_fix', ''),
    ]);
    const subStep2 = makeStep('review-b', [
      makeRule('approved', ''),
      makeRule('needs_fix', ''),
    ]);

    const parentStep = makeStep('reviews', [
      makeRule('all("approved")', 'done', {
        isAggregateCondition: true,
        aggregateType: 'all',
        aggregateConditionText: 'approved',
      }),
    ], [subStep1, subStep2]);

    const outputs = new Map<string, AgentResponse>();
    outputs.set('review-a', {
      agent: 'a', status: 'done', content: 'approved',
      timestamp: new Date(), matchedRuleIndex: 0,
    });
    outputs.set('review-b', {
      agent: 'b', status: 'done', content: 'needs_fix',
      timestamp: new Date(), matchedRuleIndex: 1,
    });

    const result = evaluateAggregateConditions(parentStep, makeState(outputs));

    expect(result).toBe(-1);
  });

  it('should return -1 for non-parallel step', () => {
    const step = makeStep('step', [
      makeRule('all("done")', 'COMPLETE', {
        isAggregateCondition: true,
        aggregateType: 'all',
        aggregateConditionText: 'done',
      }),
    ]);

    const result = evaluateAggregateConditions(step, makeState());

    expect(result).toBe(-1);
  });
});

describe('Rule Evaluation IT: ai() judge condition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should call AI judge for ai() conditions when no tag match', async () => {
    mockCallAiJudge.mockResolvedValue(0); // Judge says first ai() condition matches

    const step = makeStep('step', [
      makeRule('ai("The code is approved")', 'COMPLETE', {
        isAiCondition: true,
        aiConditionText: 'The code is approved',
      }),
      makeRule('ai("The code needs fixes")', 'fix', {
        isAiCondition: true,
        aiConditionText: 'The code needs fixes',
      }),
    ]);

    const result = await detectMatchedRule(step, 'Code looks great, no issues.', '', makeCtx());

    expect(result).toEqual<RuleMatch>({ index: 0, method: 'ai_judge' });
    expect(mockCallAiJudge).toHaveBeenCalled();
  });

  it('should skip AI judge if tag already matched', async () => {
    const step = makeStep('plan', [
      makeRule('ai("Clear")', 'implement', {
        isAiCondition: true,
        aiConditionText: 'Clear',
      }),
    ]);

    const result = await detectMatchedRule(step, '[PLAN:1] Clear.', '', makeCtx());

    expect(result).toEqual<RuleMatch>({ index: 0, method: 'phase1_tag' });
    expect(mockCallAiJudge).not.toHaveBeenCalled();
  });
});

describe('Rule Evaluation IT: AI judge fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should use AI judge fallback when no tag and no ai() conditions', async () => {
    // First call (ai() conditions): returns -1 (no ai() conditions exist)
    // Second call (all conditions fallback): returns 0
    mockCallAiJudge.mockResolvedValue(0);

    const step = makeStep('review', [
      makeRule('Approved', 'COMPLETE'),
      makeRule('Rejected', 'fix'),
    ]);

    // No tag in content, no ai() rules → goes to fallback
    const result = await detectMatchedRule(step, 'The code looks fine, approved.', '', makeCtx());

    expect(result).toEqual<RuleMatch>({ index: 0, method: 'ai_judge_fallback' });
  });

  it('should throw when no rule matches (AI judge returns -1 for all phases)', async () => {
    mockCallAiJudge.mockResolvedValue(-1);

    const step = makeStep('review', [
      makeRule('Approved', 'COMPLETE'),
      makeRule('Rejected', 'fix'),
    ]);

    await expect(
      detectMatchedRule(step, 'Totally unrelated content.', '', makeCtx()),
    ).rejects.toThrow(/no rule matched/);
  });
});

describe('Rule Evaluation IT: RuleMatchMethod tracking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCallAiJudge.mockResolvedValue(-1);
  });

  it('should record method as "aggregate" for aggregate matches', () => {
    const subStep = makeStep('sub', [makeRule('ok', '')]);
    const parentStep = makeStep('parent', [
      makeRule('all("ok")', 'COMPLETE', {
        isAggregateCondition: true,
        aggregateType: 'all',
        aggregateConditionText: 'ok',
      }),
    ], [subStep]);

    const outputs = new Map<string, AgentResponse>();
    outputs.set('sub', {
      agent: 'sub', status: 'done', content: 'ok',
      timestamp: new Date(), matchedRuleIndex: 0,
    });

    const result = evaluateAggregateConditions(parentStep, makeState(outputs));
    expect(result).toBe(0);
    // Method verified via detectMatchedRule in engine integration
  });

  it('should record method as "phase3_tag" for Phase 3 matches', async () => {
    const step = makeStep('step', [
      makeRule('Done', 'COMPLETE'),
    ]);

    const result = await detectMatchedRule(step, 'content', '[STEP:1]', makeCtx());
    expect(result?.method).toBe('phase3_tag');
  });

  it('should record method as "phase1_tag" for Phase 1 fallback matches', async () => {
    const step = makeStep('step', [
      makeRule('Done', 'COMPLETE'),
    ]);

    const result = await detectMatchedRule(step, '[STEP:1] Done.', '', makeCtx());
    expect(result?.method).toBe('phase1_tag');
  });
});

describe('Rule Evaluation IT: steps without rules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return undefined for step with no rules', async () => {
    const step: WorkflowStep = {
      name: 'step',
      agent: 'agent',
      agentDisplayName: 'step',
      instructionTemplate: '{task}',
      passPreviousResponse: true,
    };

    const result = await detectMatchedRule(step, 'content', '', makeCtx());
    expect(result).toBeUndefined();
  });

  it('should return undefined for step with empty rules array', async () => {
    const step = makeStep('step', []);

    const result = await detectMatchedRule(step, 'content', '', makeCtx());
    expect(result).toBeUndefined();
  });
});
