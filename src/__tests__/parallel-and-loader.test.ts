/**
 * Tests for parallel step execution and ai() condition loader
 *
 * Covers:
 * - Schema validation for parallel sub-steps
 * - Workflow loader normalization of ai() conditions and parallel steps
 * - Engine parallel step aggregation logic
 */

import { describe, it, expect } from 'vitest';
import { WorkflowConfigRawSchema, ParallelSubStepRawSchema, WorkflowStepRawSchema } from '../models/schemas.js';

describe('ParallelSubStepRawSchema', () => {
  it('should validate a valid parallel sub-step', () => {
    const raw = {
      name: 'arch-review',
      agent: '~/.takt/agents/default/reviewer.md',
      instruction_template: 'Review architecture',
    };

    const result = ParallelSubStepRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  it('should reject a sub-step without agent', () => {
    const raw = {
      name: 'no-agent-step',
      instruction_template: 'Do something',
    };

    const result = ParallelSubStepRawSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });

  it('should accept optional fields', () => {
    const raw = {
      name: 'full-sub-step',
      agent: '~/.takt/agents/default/coder.md',
      agent_name: 'Coder',
      allowed_tools: ['Read', 'Grep'],
      model: 'haiku',
      edit: false,
      instruction_template: 'Do work',
      report: '01-report.md',
      pass_previous_response: false,
    };

    const result = ParallelSubStepRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agent_name).toBe('Coder');
      expect(result.data.allowed_tools).toEqual(['Read', 'Grep']);
      expect(result.data.edit).toBe(false);
    }
  });

  it('should accept rules on sub-steps', () => {
    const raw = {
      name: 'reviewed',
      agent: '~/.takt/agents/default/reviewer.md',
      instruction_template: 'Review',
      rules: [
        { condition: 'No issues', next: 'COMPLETE' },
        { condition: 'Issues found', next: 'fix' },
      ],
    };

    const result = ParallelSubStepRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rules).toHaveLength(2);
    }
  });
});

describe('WorkflowStepRawSchema with parallel', () => {
  it('should accept a step with parallel sub-steps (no agent)', () => {
    const raw = {
      name: 'parallel-review',
      parallel: [
        { name: 'arch-review', agent: 'reviewer.md', instruction_template: 'Review arch' },
        { name: 'sec-review', agent: 'security.md', instruction_template: 'Review security' },
      ],
      rules: [
        { condition: 'All pass', next: 'COMPLETE' },
      ],
    };

    const result = WorkflowStepRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  it('should reject a step with neither agent nor parallel', () => {
    const raw = {
      name: 'orphan-step',
      instruction_template: 'Do something',
    };

    const result = WorkflowStepRawSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });

  it('should accept a step with agent (no parallel)', () => {
    const raw = {
      name: 'normal-step',
      agent: 'coder.md',
      instruction_template: 'Code something',
    };

    const result = WorkflowStepRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  it('should reject a step with empty parallel array', () => {
    const raw = {
      name: 'empty-parallel',
      parallel: [],
    };

    const result = WorkflowStepRawSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });
});

describe('WorkflowConfigRawSchema with parallel steps', () => {
  it('should validate a workflow with parallel step', () => {
    const raw = {
      name: 'test-parallel-workflow',
      steps: [
        {
          name: 'plan',
          agent: 'planner.md',
          rules: [{ condition: 'Plan complete', next: 'review' }],
        },
        {
          name: 'review',
          parallel: [
            { name: 'arch-review', agent: 'arch-reviewer.md', instruction_template: 'Review architecture' },
            { name: 'sec-review', agent: 'sec-reviewer.md', instruction_template: 'Review security' },
          ],
          rules: [
            { condition: 'All approved', next: 'COMPLETE' },
            { condition: 'Issues found', next: 'plan' },
          ],
        },
      ],
      initial_step: 'plan',
      max_iterations: 10,
    };

    const result = WorkflowConfigRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.steps).toHaveLength(2);
      expect(result.data.steps[1].parallel).toHaveLength(2);
    }
  });

  it('should validate a workflow mixing normal and parallel steps', () => {
    const raw = {
      name: 'mixed-workflow',
      steps: [
        { name: 'plan', agent: 'planner.md', rules: [{ condition: 'Done', next: 'implement' }] },
        { name: 'implement', agent: 'coder.md', rules: [{ condition: 'Done', next: 'review' }] },
        {
          name: 'review',
          parallel: [
            { name: 'arch', agent: 'arch.md' },
            { name: 'sec', agent: 'sec.md' },
          ],
          rules: [{ condition: 'All pass', next: 'COMPLETE' }],
        },
      ],
      initial_step: 'plan',
    };

    const result = WorkflowConfigRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.steps[0].agent).toBe('planner.md');
      expect(result.data.steps[2].parallel).toHaveLength(2);
    }
  });
});

describe('ai() condition in WorkflowRuleSchema', () => {
  it('should accept ai() condition as a string', () => {
    const raw = {
      name: 'test-step',
      agent: 'agent.md',
      rules: [
        { condition: 'ai("All reviews approved")', next: 'COMPLETE' },
        { condition: 'ai("Issues detected")', next: 'fix' },
      ],
    };

    const result = WorkflowStepRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rules?.[0].condition).toBe('ai("All reviews approved")');
      expect(result.data.rules?.[1].condition).toBe('ai("Issues detected")');
    }
  });

  it('should accept mixed regular and ai() conditions', () => {
    const raw = {
      name: 'mixed-rules',
      agent: 'agent.md',
      rules: [
        { condition: 'Regular condition', next: 'step-a' },
        { condition: 'ai("AI evaluated condition")', next: 'step-b' },
      ],
    };

    const result = WorkflowStepRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });
});

describe('ai() condition regex parsing', () => {
  // Test the regex pattern used in workflowLoader.ts
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

describe('all()/any() condition in WorkflowStepRawSchema', () => {
  it('should accept all() condition as a string', () => {
    const raw = {
      name: 'parallel-review',
      parallel: [
        { name: 'arch-review', agent: 'reviewer.md', instruction_template: 'Review' },
      ],
      rules: [
        { condition: 'all("approved")', next: 'COMPLETE' },
        { condition: 'any("rejected")', next: 'fix' },
      ],
    };

    const result = WorkflowStepRawSchema.safeParse(raw);
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
        { name: 'sub', agent: 'agent.md' },
      ],
      rules: [
        { condition: 'all("approved")', next: 'COMPLETE' },
        { condition: 'any("rejected")', next: 'fix' },
        { condition: 'ai("Difficult judgment")', next: 'manual-review' },
      ],
    };

    const result = WorkflowStepRawSchema.safeParse(raw);
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

  it('all(): true when all sub-steps match', () => {
    const subs: SubResult[] = [
      { name: 'a', matchedRuleIndex: 0, rules },
      { name: 'b', matchedRuleIndex: 0, rules },
    ];
    expect(evaluateAggregate('all', 'approved', subs)).toBe(true);
  });

  it('all(): false when some sub-steps do not match', () => {
    const subs: SubResult[] = [
      { name: 'a', matchedRuleIndex: 0, rules },
      { name: 'b', matchedRuleIndex: 1, rules },
    ];
    expect(evaluateAggregate('all', 'approved', subs)).toBe(false);
  });

  it('all(): false when sub-step has no matched rule', () => {
    const subs: SubResult[] = [
      { name: 'a', matchedRuleIndex: 0, rules },
      { name: 'b', matchedRuleIndex: undefined, rules },
    ];
    expect(evaluateAggregate('all', 'approved', subs)).toBe(false);
  });

  it('all(): false when sub-step has no rules', () => {
    const subs: SubResult[] = [
      { name: 'a', matchedRuleIndex: 0, rules },
      { name: 'b', matchedRuleIndex: 0, rules: undefined },
    ];
    expect(evaluateAggregate('all', 'approved', subs)).toBe(false);
  });

  it('all(): false with zero sub-steps', () => {
    expect(evaluateAggregate('all', 'approved', [])).toBe(false);
  });

  it('any(): true when one sub-step matches', () => {
    const subs: SubResult[] = [
      { name: 'a', matchedRuleIndex: 0, rules },
      { name: 'b', matchedRuleIndex: 1, rules },
    ];
    expect(evaluateAggregate('any', 'rejected', subs)).toBe(true);
  });

  it('any(): true when all sub-steps match', () => {
    const subs: SubResult[] = [
      { name: 'a', matchedRuleIndex: 1, rules },
      { name: 'b', matchedRuleIndex: 1, rules },
    ];
    expect(evaluateAggregate('any', 'rejected', subs)).toBe(true);
  });

  it('any(): false when no sub-steps match', () => {
    const subs: SubResult[] = [
      { name: 'a', matchedRuleIndex: 0, rules },
      { name: 'b', matchedRuleIndex: 0, rules },
    ];
    expect(evaluateAggregate('any', 'rejected', subs)).toBe(false);
  });

  it('any(): false with zero sub-steps', () => {
    expect(evaluateAggregate('any', 'rejected', [])).toBe(false);
  });

  it('any(): skips sub-steps without matched rule (does not count as match)', () => {
    const subs: SubResult[] = [
      { name: 'a', matchedRuleIndex: undefined, rules },
      { name: 'b', matchedRuleIndex: 1, rules },
    ];
    expect(evaluateAggregate('any', 'rejected', subs)).toBe(true);
  });

  it('any(): false when only unmatched sub-steps exist', () => {
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

describe('parallel step aggregation format', () => {
  it('should aggregate sub-step outputs in the expected format', () => {
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

  it('should handle single sub-step', () => {
    const subResults = [
      { name: 'only-step', content: 'Single result' },
    ];

    const aggregatedContent = subResults
      .map((r) => `## ${r.name}\n${r.content}`)
      .join('\n\n---\n\n');

    expect(aggregatedContent).toBe('## only-step\nSingle result');
    expect(aggregatedContent).not.toContain('---');
  });

  it('should handle empty content from sub-steps', () => {
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
