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
import type { PieceMovement, PieceState, PieceRule, AgentResponse } from '../core/models/index.js';
import { makeRule } from './test-helpers.js';

// --- Mocks ---

const mockCallAiJudge = vi.fn();

vi.mock('../infra/config/global/globalConfig.js', () => ({
  loadGlobalConfig: vi.fn().mockReturnValue({}),
  getLanguage: vi.fn().mockReturnValue('en'),
  getBuiltinPiecesEnabled: vi.fn().mockReturnValue(true),
}));

vi.mock('../infra/config/project/projectConfig.js', () => ({
  loadProjectConfig: vi.fn().mockReturnValue({}),
}));

// --- Imports (after mocks) ---

import { detectMatchedRule, evaluateAggregateConditions } from '../core/piece/index.js';
import { detectRuleIndex } from '../infra/claude/index.js';
import type { RuleMatch, RuleEvaluatorContext } from '../core/piece/index.js';

// --- Test helpers ---

function makeMovement(
  name: string,
  rules: PieceRule[],
  parallel?: PieceMovement[],
): PieceMovement {
  return {
    name,
    persona: 'test-agent',
    personaDisplayName: name,
    instructionTemplate: '{task}',
    passPreviousResponse: true,
    rules,
    parallel,
  };
}

function makeState(movementOutputs?: Map<string, AgentResponse>): PieceState {
  return {
    pieceName: 'it-test',
    currentMovement: 'test',
    iteration: 1,
    status: 'running',
    movementOutputs: movementOutputs ?? new Map(),
    lastOutput: undefined,
    movementIterations: new Map(),
    personaSessions: new Map(),
    userInputs: [],
  };
}

function makeCtx(movementOutputs?: Map<string, AgentResponse>): RuleEvaluatorContext {
  return {
    state: makeState(movementOutputs),
    cwd: '/tmp/test',
    detectRuleIndex,
    callAiJudge: mockCallAiJudge,
  };
}

describe('Rule Evaluation IT: Phase 3 tag detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCallAiJudge.mockResolvedValue(-1);
  });

  it('should detect rule from Phase 3 tag content', async () => {
    const step = makeMovement('plan', [
      makeRule('Clear', 'implement'),
      makeRule('Unclear', 'ABORT'),
    ]);

    const result = await detectMatchedRule(step, 'Agent output without tag.', '[PLAN:2]', makeCtx());

    expect(result).toEqual<RuleMatch>({ index: 1, method: 'phase3_tag' });
  });

  it('should prefer Phase 3 tag over Phase 1 tag', async () => {
    const step = makeMovement('plan', [
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
    const step = makeMovement('plan', [
      makeRule('Clear', 'implement'),
      makeRule('Unclear', 'ABORT'),
    ]);

    const result = await detectMatchedRule(step, '[PLAN:1] Requirements are clear.', '', makeCtx());

    expect(result).toEqual<RuleMatch>({ index: 0, method: 'phase1_tag' });
  });

  it('should detect last tag when multiple tags in Phase 1', async () => {
    const step = makeMovement('plan', [
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

  it('should match all("approved") when all sub-movements have "approved"', () => {
    const subStep1 = makeMovement('arch-review', [
      makeRule('approved', ''),
      makeRule('needs_fix', ''),
    ]);
    const subStep2 = makeMovement('security-review', [
      makeRule('approved', ''),
      makeRule('needs_fix', ''),
    ]);

    const parentStep = makeMovement('reviewers', [
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
      persona: 'arch', status: 'done', content: 'approved',
      timestamp: new Date(), matchedRuleIndex: 0,
    });
    outputs.set('security-review', {
      persona: 'security', status: 'done', content: 'approved',
      timestamp: new Date(), matchedRuleIndex: 0,
    });

    const result = evaluateAggregateConditions(parentStep, makeState(outputs));

    expect(result).toBe(0); // all("approved") is rule index 0
  });

  it('should match any("needs_fix") when one sub-movement has "needs_fix"', () => {
    const subStep1 = makeMovement('arch-review', [
      makeRule('approved', ''),
      makeRule('needs_fix', ''),
    ]);
    const subStep2 = makeMovement('security-review', [
      makeRule('approved', ''),
      makeRule('needs_fix', ''),
    ]);

    const parentStep = makeMovement('reviewers', [
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
      persona: 'arch', status: 'done', content: 'approved',
      timestamp: new Date(), matchedRuleIndex: 0,
    });
    outputs.set('security-review', {
      persona: 'security', status: 'done', content: 'needs_fix',
      timestamp: new Date(), matchedRuleIndex: 1,
    });

    const result = evaluateAggregateConditions(parentStep, makeState(outputs));

    expect(result).toBe(1); // any("needs_fix") is rule index 1
  });

  it('should return -1 when no aggregate condition matches', () => {
    const subStep1 = makeMovement('review-a', [
      makeRule('approved', ''),
      makeRule('needs_fix', ''),
    ]);
    const subStep2 = makeMovement('review-b', [
      makeRule('approved', ''),
      makeRule('needs_fix', ''),
    ]);

    const parentStep = makeMovement('reviews', [
      makeRule('all("approved")', 'done', {
        isAggregateCondition: true,
        aggregateType: 'all',
        aggregateConditionText: 'approved',
      }),
    ], [subStep1, subStep2]);

    const outputs = new Map<string, AgentResponse>();
    outputs.set('review-a', {
      persona: 'a', status: 'done', content: 'approved',
      timestamp: new Date(), matchedRuleIndex: 0,
    });
    outputs.set('review-b', {
      persona: 'b', status: 'done', content: 'needs_fix',
      timestamp: new Date(), matchedRuleIndex: 1,
    });

    const result = evaluateAggregateConditions(parentStep, makeState(outputs));

    expect(result).toBe(-1);
  });

  it('should return -1 for non-parallel movement', () => {
    const step = makeMovement('step', [
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

    const step = makeMovement('step', [
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
    const step = makeMovement('plan', [
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

    const step = makeMovement('review', [
      makeRule('Approved', 'COMPLETE'),
      makeRule('Rejected', 'fix'),
    ]);

    // No tag in content, no ai() rules → goes to fallback
    const result = await detectMatchedRule(step, 'The code looks fine, approved.', '', makeCtx());

    expect(result).toEqual<RuleMatch>({ index: 0, method: 'ai_judge_fallback' });
  });

  it('should throw when no rule matches (AI judge returns -1 for all phases)', async () => {
    mockCallAiJudge.mockResolvedValue(-1);

    const step = makeMovement('review', [
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
    const subStep = makeMovement('sub', [makeRule('ok', '')]);
    const parentStep = makeMovement('parent', [
      makeRule('all("ok")', 'COMPLETE', {
        isAggregateCondition: true,
        aggregateType: 'all',
        aggregateConditionText: 'ok',
      }),
    ], [subStep]);

    const outputs = new Map<string, AgentResponse>();
    outputs.set('sub', {
      persona: 'sub', status: 'done', content: 'ok',
      timestamp: new Date(), matchedRuleIndex: 0,
    });

    const result = evaluateAggregateConditions(parentStep, makeState(outputs));
    expect(result).toBe(0);
    // Method verified via detectMatchedRule in engine integration
  });

  it('should record method as "phase3_tag" for Phase 3 matches', async () => {
    const step = makeMovement('step', [
      makeRule('Done', 'COMPLETE'),
    ]);

    const result = await detectMatchedRule(step, 'content', '[STEP:1]', makeCtx());
    expect(result?.method).toBe('phase3_tag');
  });

  it('should record method as "phase1_tag" for Phase 1 fallback matches', async () => {
    const step = makeMovement('step', [
      makeRule('Done', 'COMPLETE'),
    ]);

    const result = await detectMatchedRule(step, '[STEP:1] Done.', '', makeCtx());
    expect(result?.method).toBe('phase1_tag');
  });
});

describe('Rule Evaluation IT: movements without rules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return undefined for movement with no rules', async () => {
    const step: PieceMovement = {
      name: 'step',
      persona: 'agent',
      personaDisplayName: 'step',
      instructionTemplate: '{task}',
      passPreviousResponse: true,
    };

    const result = await detectMatchedRule(step, 'content', '', makeCtx());
    expect(result).toBeUndefined();
  });

  it('should return undefined for movement with empty rules array', async () => {
    const step = makeMovement('step', []);

    const result = await detectMatchedRule(step, 'content', '', makeCtx());
    expect(result).toBeUndefined();
  });
});
