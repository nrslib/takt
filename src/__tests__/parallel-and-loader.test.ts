import { describe, it, expect } from 'vitest';
import {
  WorkflowConfigRawSchema,
  ParallelSubStepRawSchema,
  WorkflowStepRawSchema,
  LoopMonitorJudgeSchema,
} from '../core/models/index.js';
import {
  parseAggregateConditionArgs,
  parseAggregateConditionExpression,
  parseAiConditionExpression,
} from '../core/models/workflow-condition-expression.js';
import { parseWorkflowRuleCondition } from '../core/models/workflow-rule-condition.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';

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

  it('should return a failed parse result for an invalid parallel rule condition', () => {
    const result = ParallelSubStepRawSchema.safeParse({
      name: 'review',
      instruction: 'Review',
      rules: [{ condition: 'ai("route to plan")' }],
    });

    expect(result.success).toBe(false);
  });

  it.each([
    ['agent', { name: 'review', instruction: 'Review' }],
    ['workflow_call', { name: 'review', kind: 'workflow_call', call: 'shared/review' }],
  ] as const)('should reject aggregate conditions on a %s parallel sub-step', (_kind, subStep) => {
    for (const condition of ['all("approved")', 'any("needs_fix") && when(true)']) {
      const result = ParallelSubStepRawSchema.safeParse({
        ...subStep,
        rules: [{ condition, next: 'COMPLETE' }],
      });

      expect(result.success).toBe(false);
    }
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

  it('Given workflow_call fields on a parallel sub-step, When parsing, Then the schema preserves the call contract', () => {
    const raw = {
      name: 'delegate-review',
      kind: 'workflow_call',
      call: 'review-workflow',
      overrides: { provider: 'mock' },
      args: {
        review_policy: 'strict-review',
        evidence: ['plan-report', 'draft-report'],
      },
      rules: [
        { condition: 'COMPLETE', next: 'COMPLETE' },
        { condition: 'ABORT', next: 'ABORT' },
      ],
    };

    const result = ParallelSubStepRawSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    const parsed = result.data as Record<string, unknown>;
    expect(parsed.kind).toBe('workflow_call');
    expect(parsed.call).toBe('review-workflow');
    expect(parsed.overrides).toEqual({ provider: 'mock' });
    expect(parsed.args).toEqual({
      review_policy: 'strict-review',
      evidence: ['plan-report', 'draft-report'],
    });
  });

  it('Given a call-only workflow_call parallel sub-step, When parsing, Then the schema preserves the call contract', () => {
    const raw = {
      name: 'delegate-review',
      call: 'review-workflow',
      rules: [
        { condition: 'COMPLETE', next: 'COMPLETE' },
      ],
    };

    const result = ParallelSubStepRawSchema.safeParse(raw);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        name: 'delegate-review',
        call: 'review-workflow',
      });
    }
  });

  it('Given workflow_call sub-step uses a callable return condition, When parsing, Then the schema accepts the child return route', () => {
    const raw = {
      name: 'delegate-review',
      kind: 'workflow_call',
      call: 'review-workflow',
      rules: [
        { condition: 'retry_plan', next: 'fix-plan' },
      ],
    };

    const result = ParallelSubStepRawSchema.safeParse(raw);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rules?.[0]?.condition).toBe('retry_plan');
    }
  });

  it('Given workflow_call sub-step adds agent-only instruction, When parsing, Then only that invalid shape is rejected', () => {
    const validWorkflowCall = {
      name: 'delegate-review',
      kind: 'workflow_call',
      call: 'review-workflow',
      rules: [{ condition: 'COMPLETE', next: 'COMPLETE' }],
    };

    const validResult = ParallelSubStepRawSchema.safeParse(validWorkflowCall);
    const invalidResult = ParallelSubStepRawSchema.safeParse({
      ...validWorkflowCall,
      instruction: 'Review',
    });

    expect(validResult.success).toBe(true);
    expect(invalidResult.success).toBe(false);
    if (!invalidResult.success) {
      expect(invalidResult.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'invalid_union',
            errors: expect.arrayContaining([
              expect.arrayContaining([
                expect.objectContaining({ path: ['instruction'] }),
              ]),
            ]),
          }),
        ]),
      );
    }
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

  it('Given a workflow step with a parallel workflow_call sub-step, When parsing, Then the call shape is accepted at the workflow entrypoint', () => {
    const raw = {
      name: 'parallel-workflow-call',
      parallel: [
        {
          name: 'delegate-review',
          kind: 'workflow_call',
          call: 'shared/review',
          overrides: { provider: 'mock' },
          args: {
            review_policy: 'strict-review',
          },
          rules: [
            { condition: 'COMPLETE', next: 'COMPLETE' },
            { condition: 'ABORT', next: 'ABORT' },
          ],
        },
      ],
      rules: [
        { condition: 'all("COMPLETE")', next: 'COMPLETE' },
      ],
    };

    const result = WorkflowStepRawSchema.safeParse(raw);

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.parallel?.[0]).toMatchObject({
      name: 'delegate-review',
      kind: 'workflow_call',
      call: 'shared/review',
      overrides: { provider: 'mock' },
    });
  });

  it('Given a workflow step with a call-only parallel workflow_call sub-step, When parsing, Then the workflow entrypoint accepts the call shape', () => {
    const raw = {
      name: 'parallel-workflow-call',
      parallel: [
        {
          name: 'delegate-review',
          call: 'shared/review',
          rules: [
            { condition: 'COMPLETE', next: 'COMPLETE' },
          ],
        },
      ],
      rules: [
        { condition: 'all("COMPLETE")', next: 'COMPLETE' },
      ],
    };

    const result = WorkflowStepRawSchema.safeParse(raw);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.parallel?.[0]).toMatchObject({
        name: 'delegate-review',
        call: 'shared/review',
      });
    }
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

  it('should accept judge configuration with provider block', () => {
    const raw = {
      provider: {
        type: 'codex',
        model: 'gpt-5.2-codex',
        network_access: true,
      },
      rules: [{ condition: 'continue', next: 'ai_fix' }],
    };

    const result = LoopMonitorJudgeSchema.safeParse(raw);

    expect(result.success).toBe(true);
  });

  it('should reject empty judge model values', () => {
    const raw = {
      provider: 'codex',
      model: '',
      rules: [{ condition: 'continue', next: 'ai_fix' }],
    };

    const result = LoopMonitorJudgeSchema.safeParse(raw);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes('model'))).toBe(true);
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

  it('Given workflow YAML contains a parallel workflow_call sub-step, When normalizing, Then the sub-step remains a workflow_call', () => {
    const raw = {
      name: 'parallel-workflow-call-normalization',
      initial_step: 'review',
      max_steps: 2,
      steps: [
        {
          name: 'review',
          parallel: [
            {
              name: 'delegate-review',
              call: 'shared/review',
              overrides: {
                provider: 'codex',
                model: 'gpt-5-codex',
              },
              args: {
                review_policy: 'strict-review',
              },
              rules: [
                { condition: 'COMPLETE', next: 'COMPLETE' },
                { condition: 'ABORT', next: 'ABORT' },
              ],
            },
          ],
          rules: [
            { condition: 'all("COMPLETE")', next: 'COMPLETE' },
          ],
        },
      ],
    };

    const config = normalizeWorkflowConfig(raw, process.cwd());
    const subStep = config.steps[0]?.parallel?.[0];

    expect(subStep).toMatchObject({
      name: 'delegate-review',
      kind: 'workflow_call',
      call: 'shared/review',
      overrides: {
        provider: 'codex',
        model: 'gpt-5-codex',
      },
      args: {
        review_policy: 'strict-review',
      },
      instruction: '',
      personaDisplayName: 'delegate-review',
    });
  });

  it('should reject an unreachable aggregate sub-step condition during workflow loading', () => {
    expect(() => normalizeWorkflowConfig({
      name: 'invalid-parallel-child-aggregate',
      initial_step: 'review',
      steps: [{
        name: 'review',
        parallel: [{
          name: 'architecture',
          instruction: 'Review architecture',
          rules: [{ condition: 'all("approved")', next: 'COMPLETE' }],
        }],
        rules: [{ condition: 'all("approved")', next: 'COMPLETE' }],
      }],
    }, process.cwd())).toThrow(/parallel sub-step rules do not allow aggregate conditions/);
  });
});

describe('ai() condition in WorkflowRuleSchema', () => {
  it('should reject ai() conditions', () => {
    const raw = {
      name: 'test-step',
      persona: 'agent.md',
      rules: [
        { condition: 'ai("All reviews approved")', next: 'COMPLETE' },
        { condition: 'ai("Issues detected")', next: 'fix' },
      ],
    };

    const result = WorkflowStepRawSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });

  it('should reject ai() conditions mixed with valid conditions', () => {
    const raw = {
      name: 'mixed-rules',
      persona: 'agent.md',
      rules: [
        { condition: 'Regular condition', next: 'step-a' },
        { condition: 'ai("AI evaluated condition")', next: 'step-b' },
      ],
    };

    const result = WorkflowStepRawSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });

  it('should reject ai() conditions in loop monitor rules', () => {
    const result = LoopMonitorJudgeSchema.safeParse({
      rules: [{ condition: 'ai("Escalate")', next: 'fix' }],
    });

    expect(result.success).toBe(false);
  });
});

describe('ai() condition expression parsing', () => {
  it('should match simple ai() condition', () => {
    expect(parseAiConditionExpression('ai("No issues found")')).toEqual({
      text: 'No issues found',
    });
  });

  it('should match ai() with Japanese text', () => {
    expect(parseAiConditionExpression('ai("全てのレビューが承認している場合")')).toEqual({
      text: '全てのレビューが承認している場合',
    });
  });

  it('should not match regular condition text', () => {
    expect(parseAiConditionExpression('No issues found')).toBeUndefined();
  });

  it('should not match partial ai() pattern', () => {
    expect(parseAiConditionExpression('ai(missing quotes)')).toBeUndefined();
    expect(parseAiConditionExpression('ai("")')).toBeUndefined();
    expect(parseAiConditionExpression('not ai("text")')).toBeUndefined();
    expect(parseAiConditionExpression('ai("text") extra')).toBeUndefined();
  });

  it('should match ai() with special characters in text', () => {
    expect(parseAiConditionExpression('ai("Issues found (critical/high severity)")')).toEqual({
      text: 'Issues found (critical/high severity)',
    });
  });
});

describe('all()/any() aggregate condition expression parsing', () => {
  it('should parse aggregate condition arguments through all supported quoting styles', () => {
    expect(parseAggregateConditionArgs('approved, needs_fix')).toEqual(['approved', 'needs_fix']);
    expect(parseAggregateConditionArgs('"approved", "needs_fix"')).toEqual(['approved', 'needs_fix']);
    expect(parseAggregateConditionArgs(String.raw`\"approved\", \"needs_fix\"`)).toEqual(['approved', 'needs_fix']);
  });

  it('should reject malformed aggregate condition arguments', () => {
    expect(() => parseAggregateConditionArgs('')).toThrow('Invalid aggregate condition format');
    expect(() => parseAggregateConditionArgs('""')).toThrow('Invalid aggregate condition format');
    expect(() => parseAggregateConditionArgs('"   "')).toThrow('Invalid aggregate condition format');
    expect(() => parseAggregateConditionArgs('"approved", ""')).toThrow('Invalid aggregate condition format');
    expect(() => parseAggregateConditionArgs('"approved", "   "')).toThrow('Invalid aggregate condition format');
    expect(() => parseAggregateConditionArgs('approved,')).toThrow('Invalid aggregate condition format');
    expect(() => parseAggregateConditionArgs('"approved",')).toThrow('Invalid aggregate condition format');
    expect(() => parseAggregateConditionArgs(String.raw`\"   \"`)).toThrow('Invalid aggregate condition format');
    expect(() => parseAggregateConditionArgs(String.raw`\"approved\",`)).toThrow('Invalid aggregate condition format');
    expect(() => parseAggregateConditionArgs('"unterminated')).toThrow('Invalid aggregate condition format');
  });

  it('should match all() condition', () => {
    expect(parseAggregateConditionExpression('all("approved")')).toEqual({
      type: 'all',
      argsText: '"approved"',
    });
  });

  it('should match any() condition', () => {
    expect(parseAggregateConditionExpression('any("rejected")')).toEqual({
      type: 'any',
      argsText: '"rejected"',
    });
  });

  it('should match with Japanese text', () => {
    expect(parseAggregateConditionExpression('all("承認済み")')).toEqual({
      type: 'all',
      argsText: '"承認済み"',
    });
  });

  it('should only parse a standalone aggregate condition', () => {
    expect(parseAggregateConditionExpression('all("approved") && findings.open.count == 0')).toBeUndefined();
    expect(parseAggregateConditionExpression('all("approved") && && when(findings.open.count == 0)')).toBeUndefined();
    expect(parseAggregateConditionExpression('all("approved") && when(findings.open.count == 0)')).toBeUndefined();
  });

  it('should reject a composite condition when locating escaped aggregate arguments', () => {
    expect(parseAggregateConditionExpression('any("approved with \\"quoted ) text\\"") && when(findings.open.count == 0)')).toBeUndefined();
  });

  it('should reject a composite condition after an even backslash run', () => {
    expect(parseAggregateConditionExpression(String.raw`any("path ends with \\") && when(findings.open.count == 0)`)).toBeUndefined();
  });

  it('should not match regular condition text', () => {
    expect(parseAggregateConditionExpression('approved')).toBeUndefined();
  });

  it('should not match ai() condition', () => {
    expect(parseAggregateConditionExpression('ai("something")')).toBeUndefined();
  });

  it('should preserve aggregate argument text and reject malformed boundaries', () => {
    expect(parseAggregateConditionExpression('all(missing quotes)')).toEqual({
      type: 'all',
      argsText: 'missing quotes',
    });
    expect(parseAggregateConditionExpression('all("")')).toEqual({
      type: 'all',
      argsText: '""',
    });
    expect(parseAggregateConditionExpression('not all("text")')).toBeUndefined();
    expect(parseAggregateConditionExpression('all("text") extra')).toBeUndefined();
    expect(parseAggregateConditionExpression('ALL("text")')).toBeUndefined();
  });

  it('should match with special characters in text', () => {
    expect(parseAggregateConditionExpression('any("issues found (critical)")')).toEqual({
      type: 'any',
      argsText: '"issues found (critical)"',
    });
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

  it('should reject ai() conditions mixed with aggregate conditions', () => {
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
    expect(result.success).toBe(false);
  });

  it.each(['all', 'any'] as const)(
    'should normalize every supported child condition in %s()',
    (aggregate) => {
      const children = [
        ' approved ',
        'when( true )',
        'needs_fix && when( findings.open.count > 0 )',
      ];
      const source = `${aggregate}(${children.map((child) => JSON.stringify(child)).join(', ')})`;

      expect(parseWorkflowRuleCondition(source)).toEqual({
        kind: 'aggregate',
        aggregate,
        targetConditions: [
          { kind: 'semantic', label: 'approved' },
          { kind: 'when', expression: 'true' },
          {
            kind: 'and',
            left: { kind: 'semantic', label: 'needs_fix' },
            right: { kind: 'when', expression: 'findings.open.count > 0' },
          },
        ],
      });
    },
  );

  it.each(['all', 'any'] as const)(
    'should reject invalid child conditions in %s() at the workflow schema boundary',
    (aggregate) => {
      const invalidChildren = [
        'ai("legacy")',
        'when()',
        'when(unclosed',
        'all("approved")',
        'any("needs_fix") && when(true)',
      ];

      for (const child of invalidChildren) {
        const result = WorkflowStepRawSchema.safeParse({
          name: 'parallel-review',
          parallel: [
            { name: 'review', persona: 'reviewer.md', instruction: 'Review' },
          ],
          rules: [
            { condition: `${aggregate}(${JSON.stringify(child)})`, next: 'COMPLETE' },
          ],
        });

        expect(result.success).toBe(false);
      }
    },
  );

  describe.each([
    ['normal agent', { name: 'agent', instruction: 'Work' }],
    ['system', { name: 'system', kind: 'system' }],
    [
      'arpeggio',
      {
        name: 'batch',
        arpeggio: { source: 'csv', source_path: 'input.csv', template: 'prompt.md' },
      },
    ],
    ['team_leader', { name: 'team', team_leader: { max_parts: 2 }, instruction: 'Lead' }],
    ['empty parallel parent', { name: 'empty-parallel', parallel: [] }],
  ] as const)('%s step', (_label, step) => {
    it.each([
      'all("approved")',
      'any("needs_fix") && when(true)',
    ])('should reject unreachable aggregate condition %s', (condition) => {
      expect(WorkflowStepRawSchema.safeParse({
        ...step,
        rules: [{ condition: 'approved', next: 'COMPLETE' }],
      }).success).toBe(true);

      const result = WorkflowStepRawSchema.safeParse({
        ...step,
        rules: [{ condition, next: 'COMPLETE' }],
      });

      expect(result.success).toBe(false);
    });
  });

  it.each([
    'all("approved")',
    'any("needs_fix") && when(true)',
  ])('should reject aggregate condition %s in a loop monitor judge', (condition) => {
    expect(LoopMonitorJudgeSchema.safeParse({
      rules: [{ condition: 'approved', next: 'COMPLETE' }],
    }).success).toBe(true);

    const result = LoopMonitorJudgeSchema.safeParse({
      rules: [{ condition, next: 'COMPLETE' }],
    });

    expect(result.success).toBe(false);
  });
});

describe('when expression syntax at the raw workflow boundary', () => {
  const invalidWhen = 'when(findings.open.count ==)';
  const validWhen = 'when(findings.open.count == 0)';

  const makeAgentStep = (condition: string) => ({
    name: 'review',
    instruction: 'Review',
    rules: [{ condition, next: 'COMPLETE' }],
  });
  const makeParallelStep = (condition: string) => ({
    name: 'parallel-review',
    parallel: [{ name: 'architecture', instruction: 'Review architecture' }],
    rules: [{ condition, next: 'COMPLETE' }],
  });
  const makeLoopMonitorWorkflow = (condition: string) => ({
    name: 'loop-monitor-workflow',
    steps: [
      { name: 'review', instruction: 'Review' },
      { name: 'fix', instruction: 'Fix' },
    ],
    loop_monitors: [{
      cycle: ['review', 'fix'],
      judge: { rules: [{ condition, next: 'ABORT' }] },
    }],
  });

  it.each([
    [
      'normal step rule',
      (condition: string) => ({ name: 'normal', steps: [makeAgentStep(condition)] }),
      (condition: string) => condition,
    ],
    [
      'semantic and when rule',
      (condition: string) => ({ name: 'compound', steps: [makeAgentStep(condition)] }),
      (condition: string) => `approved && ${condition}`,
    ],
    [
      'aggregate target rule',
      (condition: string) => ({ name: 'aggregate', steps: [makeParallelStep(condition)] }),
      (condition: string) => `all(${JSON.stringify(condition)})`,
    ],
    [
      'loop monitor rule',
      makeLoopMonitorWorkflow,
      (condition: string) => condition,
    ],
  ])('should reject an invalid predicate in a %s', (_label, makeWorkflow, makeCondition) => {
    const validResult = WorkflowConfigRawSchema.safeParse(makeWorkflow(makeCondition(validWhen)));
    const invalidResult = WorkflowConfigRawSchema.safeParse(makeWorkflow(makeCondition(invalidWhen)));

    expect(validResult.success).toBe(true);
    expect(invalidResult.success).toBe(false);
    if (!invalidResult.success) {
      expect(invalidResult.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining('Invalid when operand') }),
      ]));
    }
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
