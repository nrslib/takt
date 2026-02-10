/**
 * Tests for parallel movement execution and ai() condition loader
 *
 * Covers:
 * - Schema validation for parallel sub-movements
 * - Piece loader normalization of ai() conditions and parallel movements
 * - Engine parallel movement aggregation logic
 */

import { describe, it, expect } from 'vitest';
import { PieceConfigRawSchema, ParallelSubMovementRawSchema, PieceMovementRawSchema } from '../core/models/index.js';

describe('ParallelSubMovementRawSchema', () => {
  it('should validate a valid parallel sub-movement', () => {
    const raw = {
      name: 'arch-review',
      persona: '~/.takt/agents/default/reviewer.md',
      instruction_template: 'Review architecture',
    };

    const result = ParallelSubMovementRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  it('should accept a sub-movement without persona (instruction_template only)', () => {
    const raw = {
      name: 'no-agent-step',
      instruction_template: 'Do something',
    };

    const result = ParallelSubMovementRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  it('should accept optional fields', () => {
    const raw = {
      name: 'full-sub-step',
      persona: '~/.takt/agents/default/coder.md',
      persona_name: 'Coder',
      allowed_tools: ['Read', 'Grep'],
      model: 'haiku',
      edit: false,
      instruction_template: 'Do work',
      report: '01-report.md',
      pass_previous_response: false,
    };

    const result = ParallelSubMovementRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.persona_name).toBe('Coder');
      expect(result.data.allowed_tools).toEqual(['Read', 'Grep']);
      expect(result.data.edit).toBe(false);
    }
  });

  it('should accept rules on sub-movements', () => {
    const raw = {
      name: 'reviewed',
      persona: '~/.takt/agents/default/reviewer.md',
      instruction_template: 'Review',
      rules: [
        { condition: 'No issues', next: 'COMPLETE' },
        { condition: 'Issues found', next: 'fix' },
      ],
    };

    const result = ParallelSubMovementRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rules).toHaveLength(2);
    }
  });
});

describe('PieceMovementRawSchema with parallel', () => {
  it('should accept a movement with parallel sub-movements (no agent)', () => {
    const raw = {
      name: 'parallel-review',
      parallel: [
        { name: 'arch-review', persona: 'reviewer.md', instruction_template: 'Review arch' },
        { name: 'sec-review', persona: 'security.md', instruction_template: 'Review security' },
      ],
      rules: [
        { condition: 'All pass', next: 'COMPLETE' },
      ],
    };

    const result = PieceMovementRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  it('should accept a movement with neither agent nor parallel (instruction_template only)', () => {
    const raw = {
      name: 'orphan-step',
      instruction_template: 'Do something',
    };

    const result = PieceMovementRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  it('should accept a movement with persona (no parallel)', () => {
    const raw = {
      name: 'normal-step',
      persona: 'coder.md',
      instruction_template: 'Code something',
    };

    const result = PieceMovementRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  it('should accept a movement with empty parallel array (no agent, no parallel content)', () => {
    const raw = {
      name: 'empty-parallel',
      parallel: [],
    };

    const result = PieceMovementRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });
});

describe('PieceConfigRawSchema with parallel movements', () => {
  it('should validate a piece with parallel movement', () => {
    const raw = {
      name: 'test-parallel-piece',
      movements: [
        {
          name: 'plan',
          persona: 'planner.md',
          rules: [{ condition: 'Plan complete', next: 'review' }],
        },
        {
          name: 'review',
          parallel: [
            { name: 'arch-review', persona: 'arch-reviewer.md', instruction_template: 'Review architecture' },
            { name: 'sec-review', persona: 'sec-reviewer.md', instruction_template: 'Review security' },
          ],
          rules: [
            { condition: 'All approved', next: 'COMPLETE' },
            { condition: 'Issues found', next: 'plan' },
          ],
        },
      ],
      initial_movement: 'plan',
      max_movements: 10,
    };

    const result = PieceConfigRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.movements).toHaveLength(2);
      expect(result.data.movements[1].parallel).toHaveLength(2);
    }
  });

  it('should validate a piece mixing normal and parallel movements', () => {
    const raw = {
      name: 'mixed-piece',
      movements: [
        { name: 'plan', persona: 'planner.md', rules: [{ condition: 'Done', next: 'implement' }] },
        { name: 'implement', persona: 'coder.md', rules: [{ condition: 'Done', next: 'review' }] },
        {
          name: 'review',
          parallel: [
            { name: 'arch', persona: 'arch.md' },
            { name: 'sec', persona: 'sec.md' },
          ],
          rules: [{ condition: 'All pass', next: 'COMPLETE' }],
        },
      ],
      initial_movement: 'plan',
    };

    const result = PieceConfigRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.movements[0].persona).toBe('planner.md');
      expect(result.data.movements[2].parallel).toHaveLength(2);
    }
  });
});

describe('ai() condition in PieceRuleSchema', () => {
  it('should accept ai() condition as a string', () => {
    const raw = {
      name: 'test-step',
      persona: 'agent.md',
      rules: [
        { condition: 'ai("All reviews approved")', next: 'COMPLETE' },
        { condition: 'ai("Issues detected")', next: 'fix' },
      ],
    };

    const result = PieceMovementRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rules?.[0].condition).toBe('ai("All reviews approved")');
      expect(result.data.rules?.[1].condition).toBe('ai("Issues detected")');
    }
  });

  it('should accept mixed regular and ai() conditions', () => {
    const raw = {
      name: 'mixed-rules',
      persona: 'agent.md',
      rules: [
        { condition: 'Regular condition', next: 'step-a' },
        { condition: 'ai("AI evaluated condition")', next: 'step-b' },
      ],
    };

    const result = PieceMovementRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });
});

describe('ai() condition regex parsing', () => {
  // Test the regex pattern used in pieceLoader.ts
  const AI_CONDITION_REGEX = /^ai\("(.+)"\)$/;

  it('should match simple ai() condition', () => {
    const match = 'ai("No issues found")'.match(AI_CONDITION_REGEX);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('No issues found');
  });

  it('should match ai() with Japanese text', () => {
    const match = 'ai("全てのレビューが承認している場合")'.match(AI_CONDITION_REGEX);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('全てのレビューが承認している場合');
  });

  it('should not match regular condition text', () => {
    const match = 'No issues found'.match(AI_CONDITION_REGEX);
    expect(match).toBeNull();
  });

  it('should not match partial ai() pattern', () => {
    expect('ai(missing quotes)'.match(AI_CONDITION_REGEX)).toBeNull();
    expect('ai("")'.match(AI_CONDITION_REGEX)).toBeNull(); // .+ requires at least 1 char
    expect('not ai("text")'.match(AI_CONDITION_REGEX)).toBeNull(); // must start with ai(
    expect('ai("text") extra'.match(AI_CONDITION_REGEX)).toBeNull(); // must end with )
  });

  it('should match ai() with special characters in text', () => {
    const match = 'ai("Issues found (critical/high severity)")'.match(AI_CONDITION_REGEX);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('Issues found (critical/high severity)');
  });
});

describe('all()/any() aggregate condition regex parsing', () => {
  const AGGREGATE_CONDITION_REGEX = /^(all|any)\("(.+)"\)$/;

  it('should match all() condition', () => {
    const match = 'all("approved")'.match(AGGREGATE_CONDITION_REGEX);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('all');
    expect(match![2]).toBe('approved');
  });

  it('should match any() condition', () => {
    const match = 'any("rejected")'.match(AGGREGATE_CONDITION_REGEX);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('any');
    expect(match![2]).toBe('rejected');
  });

  it('should match with Japanese text', () => {
    const match = 'all("承認済み")'.match(AGGREGATE_CONDITION_REGEX);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('all');
    expect(match![2]).toBe('承認済み');
  });

  it('should not match regular condition text', () => {
    expect('approved'.match(AGGREGATE_CONDITION_REGEX)).toBeNull();
  });

  it('should not match ai() condition', () => {
    expect('ai("something")'.match(AGGREGATE_CONDITION_REGEX)).toBeNull();
  });

  it('should not match invalid patterns', () => {
    expect('all(missing quotes)'.match(AGGREGATE_CONDITION_REGEX)).toBeNull();
    expect('all("")'.match(AGGREGATE_CONDITION_REGEX)).toBeNull();
    expect('not all("text")'.match(AGGREGATE_CONDITION_REGEX)).toBeNull();
    expect('all("text") extra'.match(AGGREGATE_CONDITION_REGEX)).toBeNull();
    expect('ALL("text")'.match(AGGREGATE_CONDITION_REGEX)).toBeNull();
  });

  it('should match with special characters in text', () => {
    const match = 'any("issues found (critical)")'.match(AGGREGATE_CONDITION_REGEX);
    expect(match).not.toBeNull();
    expect(match![2]).toBe('issues found (critical)');
  });
});

describe('all()/any() condition in PieceMovementRawSchema', () => {
  it('should accept all() condition as a string', () => {
    const raw = {
      name: 'parallel-review',
      parallel: [
        { name: 'arch-review', persona: 'reviewer.md', instruction_template: 'Review' },
      ],
      rules: [
        { condition: 'all("approved")', next: 'COMPLETE' },
        { condition: 'any("rejected")', next: 'fix' },
      ],
    };

    const result = PieceMovementRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rules?.[0].condition).toBe('all("approved")');
      expect(result.data.rules?.[1].condition).toBe('any("rejected")');
    }
  });

  it('should accept mixed regular, ai(), and all()/any() conditions', () => {
    const raw = {
      name: 'mixed-rules',
      parallel: [
        { name: 'sub', persona: 'agent.md' },
      ],
      rules: [
        { condition: 'all("approved")', next: 'COMPLETE' },
        { condition: 'any("rejected")', next: 'fix' },
        { condition: 'ai("Difficult judgment")', next: 'manual-review' },
      ],
    };

    const result = PieceMovementRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });
});

describe('aggregate condition evaluation logic', () => {
  // Simulate the evaluation logic from engine.ts
  type SubResult = { name: string; matchedRuleIndex?: number; rules?: { condition: string }[] };

  function evaluateAggregate(
    aggregateType: 'all' | 'any',
    targetCondition: string,
    subSteps: SubResult[],
  ): boolean {
    if (subSteps.length === 0) return false;

    if (aggregateType === 'all') {
      return subSteps.every((sub) => {
        if (sub.matchedRuleIndex == null || !sub.rules) return false;
        const matchedRule = sub.rules[sub.matchedRuleIndex];
        return matchedRule?.condition === targetCondition;
      });
    }
    // 'any'
    return subSteps.some((sub) => {
      if (sub.matchedRuleIndex == null || !sub.rules) return false;
      const matchedRule = sub.rules[sub.matchedRuleIndex];
      return matchedRule?.condition === targetCondition;
    });
  }

  const rules = [
    { condition: 'approved' },
    { condition: 'rejected' },
  ];

  it('all(): true when all sub-movements match', () => {
    const subs: SubResult[] = [
      { name: 'a', matchedRuleIndex: 0, rules },
      { name: 'b', matchedRuleIndex: 0, rules },
    ];
    expect(evaluateAggregate('all', 'approved', subs)).toBe(true);
  });

  it('all(): false when some sub-movements do not match', () => {
    const subs: SubResult[] = [
      { name: 'a', matchedRuleIndex: 0, rules },
      { name: 'b', matchedRuleIndex: 1, rules },
    ];
    expect(evaluateAggregate('all', 'approved', subs)).toBe(false);
  });

  it('all(): false when sub-movement has no matched rule', () => {
    const subs: SubResult[] = [
      { name: 'a', matchedRuleIndex: 0, rules },
      { name: 'b', matchedRuleIndex: undefined, rules },
    ];
    expect(evaluateAggregate('all', 'approved', subs)).toBe(false);
  });

  it('all(): false when sub-movement has no rules', () => {
    const subs: SubResult[] = [
      { name: 'a', matchedRuleIndex: 0, rules },
      { name: 'b', matchedRuleIndex: 0, rules: undefined },
    ];
    expect(evaluateAggregate('all', 'approved', subs)).toBe(false);
  });

  it('all(): false with zero sub-movements', () => {
    expect(evaluateAggregate('all', 'approved', [])).toBe(false);
  });

  it('any(): true when one sub-movement matches', () => {
    const subs: SubResult[] = [
      { name: 'a', matchedRuleIndex: 0, rules },
      { name: 'b', matchedRuleIndex: 1, rules },
    ];
    expect(evaluateAggregate('any', 'rejected', subs)).toBe(true);
  });

  it('any(): true when all sub-movements match', () => {
    const subs: SubResult[] = [
      { name: 'a', matchedRuleIndex: 1, rules },
      { name: 'b', matchedRuleIndex: 1, rules },
    ];
    expect(evaluateAggregate('any', 'rejected', subs)).toBe(true);
  });

  it('any(): false when no sub-movements match', () => {
    const subs: SubResult[] = [
      { name: 'a', matchedRuleIndex: 0, rules },
      { name: 'b', matchedRuleIndex: 0, rules },
    ];
    expect(evaluateAggregate('any', 'rejected', subs)).toBe(false);
  });

  it('any(): false with zero sub-movements', () => {
    expect(evaluateAggregate('any', 'rejected', [])).toBe(false);
  });

  it('any(): skips sub-movements without matched rule (does not count as match)', () => {
    const subs: SubResult[] = [
      { name: 'a', matchedRuleIndex: undefined, rules },
      { name: 'b', matchedRuleIndex: 1, rules },
    ];
    expect(evaluateAggregate('any', 'rejected', subs)).toBe(true);
  });

  it('any(): false when only unmatched sub-movements exist', () => {
    const subs: SubResult[] = [
      { name: 'a', matchedRuleIndex: undefined, rules },
      { name: 'b', matchedRuleIndex: undefined, rules },
    ];
    expect(evaluateAggregate('any', 'rejected', subs)).toBe(false);
  });

  it('evaluation priority: first matching aggregate rule wins', () => {
    const parentRules = [
      { type: 'all' as const, condition: 'approved' },
      { type: 'any' as const, condition: 'rejected' },
    ];
    const subs: SubResult[] = [
      { name: 'a', matchedRuleIndex: 0, rules },
      { name: 'b', matchedRuleIndex: 0, rules },
    ];

    // Find the first matching rule
    let matchedIndex = -1;
    for (let i = 0; i < parentRules.length; i++) {
      const r = parentRules[i]!;
      if (evaluateAggregate(r.type, r.condition, subs)) {
        matchedIndex = i;
        break;
      }
    }

    expect(matchedIndex).toBe(0); // all("approved") matches first
  });
});

describe('parallel movement aggregation format', () => {
  it('should aggregate sub-movement outputs in the expected format', () => {
    // Mirror the aggregation logic from engine.ts
    const subResults = [
      { name: 'arch-review', content: 'Architecture looks good.\n## Result: APPROVE' },
      { name: 'sec-review', content: 'No security issues.\n## Result: APPROVE' },
    ];

    const aggregatedContent = subResults
      .map((r) => `## ${r.name}\n${r.content}`)
      .join('\n\n---\n\n');

    expect(aggregatedContent).toContain('## arch-review');
    expect(aggregatedContent).toContain('Architecture looks good.');
    expect(aggregatedContent).toContain('---');
    expect(aggregatedContent).toContain('## sec-review');
    expect(aggregatedContent).toContain('No security issues.');
  });

  it('should handle single sub-movement', () => {
    const subResults = [
      { name: 'only-step', content: 'Single result' },
    ];

    const aggregatedContent = subResults
      .map((r) => `## ${r.name}\n${r.content}`)
      .join('\n\n---\n\n');

    expect(aggregatedContent).toBe('## only-step\nSingle result');
    expect(aggregatedContent).not.toContain('---');
  });

  it('should handle empty content from sub-movements', () => {
    const subResults = [
      { name: 'step-a', content: '' },
      { name: 'step-b', content: 'Has content' },
    ];

    const aggregatedContent = subResults
      .map((r) => `## ${r.name}\n${r.content}`)
      .join('\n\n---\n\n');

    expect(aggregatedContent).toContain('## step-a\n');
    expect(aggregatedContent).toContain('## step-b\nHas content');
  });
});
