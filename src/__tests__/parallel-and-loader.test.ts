import { describe, it, expect } from 'vitest';
import {
  WorkflowConfigRawSchema,
  ParallelSubStepRawSchema,
  WorkflowStepRawSchema,
  LoopMonitorJudgeSchema,
} from '../core/models/index.js';

describe('ParallelSubStepRawSchema', () => {
  it('should validate a valid parallel sub-step', () => {
    const raw = {
      name: 'arch-review',
      persona: '~/.takt/agents/default/reviewer.md',
      instruction: 'Review architecture',
    };

    const result = ParallelSubStepRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  it('should accept a sub-step without persona', () => {
    const raw = {
      name: 'no-agent-step',
      instruction: 'Do something',
    };

    const result = ParallelSubStepRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  it('should accept a sub-step with instruction field', () => {
    const raw = {
      name: 'no-agent-step',
      instruction: 'Do something',
    };

    const result = ParallelSubStepRawSchema.safeParse(raw);

    expect(result.success).toBe(true);
  });

  it('should reject a sub-step when instruction_template is provided', () => {
    const raw = {
      name: 'dual-field-sub-step',
      instruction_template: 'Legacy instruction',
    };

    const result = ParallelSubStepRawSchema.safeParse(raw);

    expect(result.success).toBe(false);
  });

  it('should accept optional fields', () => {
    const raw = {
      name: 'full-sub-step',
      persona: '~/.takt/agents/default/coder.md',
      persona_name: 'Coder',
      provider_options: {
        claude: {
          allowed_tools: ['Read', 'Grep'],
        },
      },
      model: 'haiku',
      edit: false,
      instruction: 'Do work',
      report: '01-report.md',
      pass_previous_response: false,
    };

    const result = ParallelSubStepRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.persona_name).toBe('Coder');
      expect(result.data.provider_options?.claude?.allowed_tools).toEqual(['Read', 'Grep']);
      expect(result.data.edit).toBe(false);
    }
  });

  it('should accept provider block in parallel sub-step', () => {
    const raw = {
      name: 'provider-block-sub-step',
      provider: {
        type: 'codex',
        model: 'gpt-5.3',
        network_access: true,
      },
      instruction: 'Review',
    };

    const result = ParallelSubStepRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  it('should reject invalid provider block options in parallel sub-step', () => {
    const raw = {
      name: 'invalid-provider-block-sub-step',
      provider: {
        type: 'claude',
        network_access: true,
      },
      instruction: 'Review',
    };

    const result = ParallelSubStepRawSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });

  it('should accept rules on sub-steps', () => {
    const raw = {
      name: 'reviewed',
      persona: '~/.takt/agents/default/reviewer.md',
      instruction: 'Review',
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

  it('should reject step-level allowed_tools on sub-step', () => {
    const raw = {
      name: 'invalid-sub-step',
      allowed_tools: ['Read'],
      instruction: 'Review',
    };

    const result = ParallelSubStepRawSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });
});

describe('WorkflowStepRawSchema with parallel', () => {
  it('should accept a step with parallel sub-steps (no agent)', () => {
    const raw = {
      name: 'parallel-review',
      parallel: [
        { name: 'arch-review', persona: 'reviewer.md', instruction: 'Review arch' },
        { name: 'sec-review', persona: 'security.md', instruction: 'Review security' },
      ],
      rules: [
        { condition: 'All pass', next: 'COMPLETE' },
      ],
    };

    const result = WorkflowStepRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  it('should accept a step with neither agent nor parallel', () => {
    const raw = {
      name: 'orphan-step',
      instruction: 'Do something',
    };

    const result = WorkflowStepRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  it('should accept a step with instruction only', () => {
    const raw = {
      name: 'orphan-step',
      instruction: 'Do something',
    };

    const result = WorkflowStepRawSchema.safeParse(raw);

    expect(result.success).toBe(true);
  });

  it('should reject a step when instruction_template is provided', () => {
    const raw = {
      name: 'orphan-step',
      instruction_template: 'Legacy step instruction',
    };

    const result = WorkflowStepRawSchema.safeParse(raw);

    expect(result.success).toBe(false);
  });

  it('should accept a step with persona (no parallel)', () => {
    const raw = {
      name: 'normal-step',
      persona: 'coder.md',
      instruction: 'Code something',
    };

    const result = WorkflowStepRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  it('should accept a step with empty parallel array (no agent, no parallel content)', () => {
    const raw = {
      name: 'empty-parallel',
      parallel: [],
    };

    const result = WorkflowStepRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  it('should accept provider string in parallel sub-step', () => {
    const raw = {
      name: 'parallel-provider-string',
      parallel: [
        {
          name: 'arch-review',
          provider: 'codex',
          instruction: 'Review architecture',
        },
      ],
    };

    const result = WorkflowStepRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
  });
});

describe('LoopMonitorJudgeSchema', () => {
  it('should accept judge configuration with instruction field', () => {
    const raw = {
      persona: 'reviewer',
      instruction: 'Judge loop health',
      rules: [{ condition: 'continue', next: 'ai_fix' }],
    };

    const result = LoopMonitorJudgeSchema.safeParse(raw);

    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as unknown as Record<string, unknown>).instruction).toBe('Judge loop health');
    }
  });

  it('should reject judge configuration when instruction_template exists', () => {
    const raw = {
      persona: 'reviewer',
      instruction_template: 'legacy judge instruction',
      rules: [{ condition: 'continue', next: 'ai_fix' }],
    };

    const result = LoopMonitorJudgeSchema.safeParse(raw);

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
          persona: 'planner.md',
          rules: [{ condition: 'Plan complete', next: 'review' }],
        },
        {
          name: 'review',
          parallel: [
            { name: 'arch-review', persona: 'arch-reviewer.md', instruction: 'Review architecture' },
            { name: 'sec-review', persona: 'sec-reviewer.md', instruction: 'Review security' },
          ],
          rules: [
            { condition: 'All approved', next: 'COMPLETE' },
            { condition: 'Issues found', next: 'plan' },
          ],
        },
      ],
      initial_step: 'plan',
      max_steps: 10,
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
      initial_step: 'plan',
    };

    const result = WorkflowConfigRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.steps[0].persona).toBe('planner.md');
      expect(result.data.steps[2].parallel).toHaveLength(2);
    }
  });
});

describe('ai() condition in WorkflowRuleSchema', () => {
  it('should accept ai() condition as a string', () => {
    const raw = {
      name: 'test-step',
      persona: 'agent.md',
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
      persona: 'agent.md',
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
  // Test the regex pattern used in workflowParser.ts
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
        { name: 'arch-review', persona: 'reviewer.md', instruction: 'Review' },
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
        { name: 'sub', persona: 'agent.md' },
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
