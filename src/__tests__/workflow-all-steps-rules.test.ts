import { describe, expect, it } from 'vitest';
import { WorkflowConfigRawSchema } from '../core/models/workflow-schemas.js';
import { InstructionBuilder } from '../core/workflow/instruction/InstructionBuilder.js';
import type { InstructionContext } from '../core/workflow/instruction/instruction-context.js';
import { ReportInstructionBuilder } from '../core/workflow/instruction/ReportInstructionBuilder.js';
import type { ReportInstructionContext } from '../core/workflow/instruction/ReportInstructionBuilder.js';
import { StatusJudgmentBuilder } from '../core/workflow/instruction/StatusJudgmentBuilder.js';
import type { StatusJudgmentContext } from '../core/workflow/instruction/StatusJudgmentBuilder.js';
import { makeInstructionContext, makeRule, makeStep } from './test-helpers.js';

type ResolvedWorkflowRule = {
  readonly ref: string;
  readonly position: 'after_execution_rules' | 'before_instruction';
  readonly content: string;
};

type WorkflowRuleInstructionContext = InstructionContext & {
  readonly workflowRules?: readonly ResolvedWorkflowRule[];
};

function workflowRuleContext(
  rules: readonly ResolvedWorkflowRule[],
  language: 'en' | 'ja' = 'en',
): WorkflowRuleInstructionContext {
  return {
    ...makeInstructionContext({
      language,
      workflowName: 'rules-test',
    }),
    workflowRules: rules,
  };
}

describe('all_steps.rules schema', () => {
  it('accepts string refs and before_instruction entries in declaration order', () => {
    const result = WorkflowConfigRawSchema.safeParse({
      name: 'rules-schema',
      all_steps: {
        rules: [
          'first-rule',
          { ref: 'second-rule', position: 'before_instruction' },
        ],
      },
      steps: [{ name: 'step', instruction: 'Work' }],
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    const parsed = result.data as {
      readonly all_steps?: {
        readonly rules?: unknown;
      };
    };
    expect(parsed.all_steps?.rules).toEqual([
      'first-rule',
      { ref: 'second-rule', position: 'before_instruction' },
    ]);
  });

  it('rejects unsupported positions, unknown all_steps keys, and a top-level rules key', () => {
    expect(WorkflowConfigRawSchema.safeParse({
      name: 'invalid-position',
      all_steps: { rules: [{ ref: 'rule', position: 'after_task' }] },
      steps: [{ name: 'step', instruction: 'Work' }],
    }).success).toBe(false);

    expect(WorkflowConfigRawSchema.safeParse({
      name: 'unknown-all-steps-key',
      all_steps: { rules: [], other: true },
      steps: [{ name: 'step', instruction: 'Work' }],
    }).success).toBe(false);

    expect(WorkflowConfigRawSchema.safeParse({
      name: 'top-level-rules',
      rules: ['rule'],
      steps: [{ name: 'step', instruction: 'Work' }],
    }).success).toBe(false);
  });
});

describe('workflow-wide Phase 1 rule rendering', () => {
  const rules: readonly ResolvedWorkflowRule[] = [
    {
      ref: 'execution-first',
      position: 'after_execution_rules',
      content: 'RULE_EXECUTION_FIRST',
    },
    {
      ref: 'instruction-first',
      position: 'before_instruction',
      content: 'RULE_INSTRUCTION_FIRST',
    },
    {
      ref: 'execution-second',
      position: 'after_execution_rules',
      content: 'RULE_EXECUTION_SECOND',
    },
  ];

  it('injects each rule once, keeps declaration order within each position, and emits one applicability notice', () => {
    const prompt = new InstructionBuilder(
      makeStep({
        name: 'work',
        instruction: 'Do the requested work.',
        allowGitCommit: false,
      }),
      workflowRuleContext(rules),
    ).build();

    expect(prompt).toContain('RULE_EXECUTION_FIRST');
    expect(prompt).toContain('RULE_EXECUTION_SECOND');
    expect(prompt).toContain('RULE_INSTRUCTION_FIRST');
    expect(prompt.indexOf('RULE_EXECUTION_FIRST')).toBeLessThan(prompt.indexOf('RULE_EXECUTION_SECOND'));
    expect(prompt.indexOf('RULE_EXECUTION_SECOND')).toBeLessThan(prompt.indexOf('RULE_INSTRUCTION_FIRST'));
    expect(prompt.indexOf('RULE_INSTRUCTION_FIRST')).toBeLessThan(prompt.indexOf('Do the requested work.'));
    expect(prompt.indexOf('Do NOT run git commit')).toBeLessThan(prompt.indexOf('RULE_EXECUTION_FIRST'));
    expect(prompt.indexOf('RULE_EXECUTION_FIRST')).toBeLessThan(prompt.indexOf('Do the requested work.'));
    expect(prompt.match(/all steps in this workflow/gi)).toHaveLength(1);
    for (const rule of rules) {
      expect(prompt.split(rule.content).length - 1).toBe(1);
    }
  });

  it.each([
    ['en', 'Note: This section is metadata. Follow the language used in the rest of the prompt.', 2],
    ['ja', '## 判断ルール', 3],
  ] as const)('keeps the pre-rules prompt spacing for %s', (language, followingSection, expectedNewlines) => {
    for (const edit of [undefined, true, false] as const) {
      const withoutRules = new InstructionBuilder(
        makeStep({
          name: 'work',
          instruction: 'Do the requested work.',
          ...(edit === undefined ? {} : { edit }),
        }),
        makeInstructionContext({ language, workflowName: 'rules-test' }),
      ).build();
      const withEmptyRules = new InstructionBuilder(
        makeStep({
          name: 'work',
          instruction: 'Do the requested work.',
          ...(edit === undefined ? {} : { edit }),
        }),
        workflowRuleContext([], language),
      ).build();

      const followingSectionIndex = withoutRules.indexOf(followingSection);
      expect(followingSectionIndex).toBeGreaterThan(0);
      const precedingNewlines = withoutRules
        .slice(0, followingSectionIndex)
        .match(/\n+$/)?.[0].length;
      expect(precedingNewlines).toBe(expectedNewlines);
      expect(withoutRules).toContain('## Instructions\nDo the requested work.');
      expect(withoutRules).not.toContain('## Instructions\n\nDo the requested work.');
      expect(withEmptyRules).toBe(withoutRules);
    }
  });
});

describe('workflow-wide rule phase boundaries', () => {
  it('keeps workflow-wide rules out of Phase 2 and Phase 3 builders', () => {
    const step = makeStep({
      name: 'review',
      rules: [makeRule('approved', 'COMPLETE')],
      outputContracts: [{ name: 'report.md', format: 'Report' }],
    });
    const marker = 'RULE_MUST_STAY_IN_PHASE_1';
    const workflowRule = {
      ref: 'phase-1-only',
      position: 'after_execution_rules' as const,
      content: marker,
    };

    const phase2 = new ReportInstructionBuilder(step, {
      ...workflowRuleContext([workflowRule]),
      reportDir: '/tmp/test/reports',
      stepIteration: 1,
      task: 'Write the report.',
    } as unknown as ReportInstructionContext).build();
    const phase3 = new StatusJudgmentBuilder(step, {
      ...workflowRuleContext([workflowRule]),
      reportContent: 'The report is complete.',
      inputSource: 'report',
    } as unknown as StatusJudgmentContext).build();

    expect(phase2).not.toContain(marker);
    expect(phase3).not.toContain(marker);
  });
});
