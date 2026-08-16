import { describe, expect, it } from 'vitest';
import { WorkflowConfigRawSchema } from '../core/models/workflow-schemas.js';
import { ReportInstructionBuilder } from '../core/workflow/instruction/ReportInstructionBuilder.js';
import type { ReportInstructionContext } from '../core/workflow/instruction/ReportInstructionBuilder.js';
import { StatusJudgmentBuilder } from '../core/workflow/instruction/StatusJudgmentBuilder.js';
import type { StatusJudgmentContext } from '../core/workflow/instruction/StatusJudgmentBuilder.js';
import { makeInstructionContext, makeRule, makeStep } from './test-helpers.js';

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
