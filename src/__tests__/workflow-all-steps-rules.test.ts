import { describe, expect, it } from 'vitest';
import { WorkflowConfigRawSchema } from '../core/models/workflow-schemas.js';
import { InstructionBuilder } from '../core/workflow/instruction/InstructionBuilder.js';
import {
  buildGitRules,
  type InstructionContext,
} from '../core/workflow/instruction/instruction-context.js';
import { renderWorkflowWideRules } from '../core/workflow/instruction/workflow-wide-rules.js';
import { ReportInstructionBuilder } from '../core/workflow/instruction/ReportInstructionBuilder.js';
import type { ReportInstructionContext } from '../core/workflow/instruction/ReportInstructionBuilder.js';
import { StatusJudgmentBuilder } from '../core/workflow/instruction/StatusJudgmentBuilder.js';
import type { StatusJudgmentContext } from '../core/workflow/instruction/StatusJudgmentBuilder.js';
import { mergeWorkflowWideRules } from '../core/workflow/engine/workflow-wide-rule-merge.js';
import { renderTaskReviewScope } from '../core/workflow/review-scope.js';
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
    ...makeInstructionContext({ language, workflowName: 'rules-test' }),
    workflowRules: rules,
  };
}

describe('all_steps.rules schema', () => {
  it('accepts supported rule references and rejects unsupported shapes', () => {
    const result = WorkflowConfigRawSchema.safeParse({
      name: 'rules-schema',
      all_steps: {
        rules: ['first-rule', { ref: 'second-rule', position: 'before_instruction' }],
      },
      steps: [{ name: 'step', instruction: 'work' }],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.all_steps?.rules).toEqual([
        'first-rule',
        { ref: 'second-rule', position: 'before_instruction' },
      ]);
    }

    expect(WorkflowConfigRawSchema.safeParse({
      name: 'invalid-position',
      all_steps: { rules: [{ ref: 'rule', position: 'after_task' }] },
      steps: [{ name: 'step', instruction: 'work' }],
    }).success).toBe(false);
  });
});

describe('workflow-wide rule inheritance merging', () => {
  const sharedRule: ResolvedWorkflowRule = {
    ref: 'shared-rule',
    position: 'before_instruction',
    content: 'SHARED_RULE_CONTENT',
  };

  it('keeps one parent occurrence when a child declares the same rule', () => {
    const merged = mergeWorkflowWideRules([sharedRule], [{ ...sharedRule }]);

    expect(merged).toEqual([sharedRule]);
    expect(merged[0]).toBe(sharedRule);
  });

  it('keeps one occurrence through a three-level workflow_call chain', () => {
    const childRules = mergeWorkflowWideRules([sharedRule], [{ ...sharedRule }]);
    const grandchildRules = mergeWorkflowWideRules(childRules, [{ ...sharedRule }]);

    expect(grandchildRules).toEqual([sharedRule]);
  });

  it('keeps rules with the same ref when their content differs', () => {
    const childRule = {
      ...sharedRule,
      content: 'CHILD_SPECIFIC_CONTENT',
    };

    expect(mergeWorkflowWideRules([sharedRule], [childRule])).toEqual([
      sharedRule,
      childRule,
    ]);
  });

  it('keeps rules with the same ref when their positions differ', () => {
    const childRule = {
      ...sharedRule,
      position: 'after_execution_rules' as const,
    };

    expect(mergeWorkflowWideRules([sharedRule], [childRule])).toEqual([
      sharedRule,
      childRule,
    ]);
  });

  it('preserves duplicate declarations within one workflow', () => {
    const duplicate = { ...sharedRule };

    expect(mergeWorkflowWideRules(undefined, [sharedRule, duplicate])).toEqual([
      sharedRule,
      duplicate,
    ]);
    expect(mergeWorkflowWideRules([sharedRule, duplicate], undefined)).toEqual([
      sharedRule,
      duplicate,
    ]);
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
    const instructionMarker = 'TEST_STEP_INSTRUCTION';
    const prompt = new InstructionBuilder(
      makeStep({
        name: 'work',
        instruction: instructionMarker,
        allowGitCommit: false,
      }),
      workflowRuleContext(rules),
    ).build();

    expect(prompt).toContain('RULE_EXECUTION_FIRST');
    expect(prompt).toContain('RULE_EXECUTION_SECOND');
    expect(prompt).toContain('RULE_INSTRUCTION_FIRST');
    expect(prompt.indexOf('RULE_EXECUTION_FIRST')).toBeLessThan(prompt.indexOf('RULE_EXECUTION_SECOND'));
    expect(prompt.indexOf('RULE_EXECUTION_SECOND')).toBeLessThan(prompt.indexOf('RULE_INSTRUCTION_FIRST'));
    expect(prompt.indexOf('RULE_INSTRUCTION_FIRST')).toBeLessThan(prompt.indexOf(instructionMarker));
    const gitRules = buildGitRules(false, 'en', 'phase1');
    expect(gitRules).not.toBe('');
    expect(prompt).toContain(gitRules);
    expect(prompt.indexOf(gitRules)).toBeLessThan(prompt.indexOf('RULE_EXECUTION_FIRST'));
    const { noticeAfterExecutionRules } = renderWorkflowWideRules(
      rules,
      'en',
      makeStep({ name: 'work', instruction: instructionMarker }),
      workflowRuleContext(rules),
    );
    expect(prompt.split(noticeAfterExecutionRules)).toHaveLength(2);
    for (const rule of rules) {
      expect(prompt.split(rule.content).length - 1).toBe(1);
    }
  });

  it.each(['en', 'ja'] as const)('does not change the prompt for %s when workflow-wide rules are absent', (language) => {
    for (const edit of [undefined, true, false] as const) {
      const instructionMarker = 'TEST_STEP_INSTRUCTION';
      const withoutRules = new InstructionBuilder(
        makeStep({
          name: 'work',
          instruction: instructionMarker,
          ...(edit === undefined ? {} : { edit }),
        }),
        makeInstructionContext({ language, workflowName: 'rules-test' }),
      ).build();
      const withEmptyRules = new InstructionBuilder(
        makeStep({
          name: 'work',
          instruction: instructionMarker,
          ...(edit === undefined ? {} : { edit }),
        }),
        workflowRuleContext([], language),
      ).build();

      expect(withoutRules).toContain(instructionMarker);
      expect(withEmptyRules).toBe(withoutRules);
    }
  });

  it.each(['en', 'ja'] as const)('resolves workflow-wide rule placeholders in %s', (language) => {
    const rules: readonly ResolvedWorkflowRule[] = [{
      ref: 'contextual-rule',
      position: 'before_instruction',
      content: 'mode={var:review_mode}; iteration={step_iteration}; scope={review_scope}',
    }];
    const context = workflowRuleContext(rules, language);
    context.stepIteration = 3;
    context.workflowCallVars = { review_mode: 'follow_up' };
    context.reviewScope = {
      kind: 'collected',
      paths: ['src/changed.ts'],
      source: { kind: 'working_tree', baseRange: { kind: 'base_branch_head' } },
    };

    const prompt = new InstructionBuilder(
      makeStep({ name: 'review', instruction: 'STEP_INSTRUCTION' }),
      context,
    ).build();

    expect(prompt).toContain('mode=follow_up');
    expect(prompt).toContain('iteration=3');
    expect(prompt).toContain('src/changed.ts');
    expect(prompt).not.toContain('{var:review_mode}');
    expect(prompt).not.toContain('{step_iteration}');
    expect(prompt).not.toContain('{review_scope}');
  });

  it.each(['en', 'ja'] as const)('renders the review scope block once in %s', (language) => {
    const reviewScope = {
      kind: 'collected' as const,
      paths: ['src/changed.ts'],
      source: { kind: 'working_tree' as const, baseRange: { kind: 'base_branch_head' as const } },
    };
    const scopeControl = language === 'ja'
      ? 'レビュー作業だけに適用する範囲制御:'
      : 'Scope control for review work only:';
    const rules: readonly ResolvedWorkflowRule[] = [{
      ref: 'scope-owner',
      position: 'before_instruction',
      content: `${scopeControl}\n{review_scope}`,
    }];
    const context = workflowRuleContext(rules, language);
    context.reviewScope = reviewScope;

    const prompt = new InstructionBuilder(
      makeStep({ name: 'review', instruction: 'STEP_INSTRUCTION' }),
      context,
    ).build();
    const renderedScope = renderTaskReviewScope(reviewScope, language);

    expect(prompt.split(renderedScope)).toHaveLength(2);
    expect(prompt.split(scopeControl)).toHaveLength(2);
    expect(prompt).not.toContain('{review_scope}');
  });
});

describe('workflow-wide rule phase boundaries', () => {
  it('does not pass Phase 1 rules into report or status-judgment instructions', () => {
    const marker = 'dynamic-phase-one-rule';
    const step = makeStep({
      name: 'review',
      rules: [makeRule('approved', 'COMPLETE')],
      outputContracts: [{ name: 'report.md', format: 'report' }],
    });
    const context = {
      ...makeInstructionContext({ workflowName: 'rules-boundary' }),
      workflowRules: [{
        ref: 'phase-1-only',
        position: 'after_execution_rules' as const,
        content: marker,
      }],
    };

    const phase2 = new ReportInstructionBuilder(step, {
      ...context,
      reportDir: '/tmp/reports',
      stepIteration: 1,
      task: 'dynamic task',
    } as unknown as ReportInstructionContext).build();
    const phase3 = new StatusJudgmentBuilder(step, {
      ...context,
      reportContent: 'dynamic report',
      inputSource: 'report',
    } as unknown as StatusJudgmentContext).build();

    expect(phase2).not.toContain(marker);
    expect(phase3).not.toContain(marker);
  });
});
