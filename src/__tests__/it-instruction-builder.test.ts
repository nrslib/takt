/**
 * Instruction builder integration tests.
 *
 * Tests template variable expansion and auto-injection in buildInstruction().
 * Uses real workflow step configs (not mocked) against the buildInstruction function.
 *
 * Not mocked: buildInstruction, buildReportInstruction, buildStatusJudgmentInstruction
 */

import { describe, it, expect, vi } from 'vitest';
import type { WorkflowStep, WorkflowRule, AgentResponse } from '../core/models/index.js';

vi.mock('../infra/config/global/globalConfig.js', () => ({
  loadGlobalConfig: vi.fn().mockReturnValue({}),
  getLanguage: vi.fn().mockReturnValue('en'),
  getBuiltinWorkflowsEnabled: vi.fn().mockReturnValue(true),
}));

import { InstructionBuilder } from '../core/workflow/index.js';
import { ReportInstructionBuilder, type ReportInstructionContext } from '../core/workflow/index.js';
import { StatusJudgmentBuilder, type StatusJudgmentContext } from '../core/workflow/index.js';
import type { InstructionContext } from '../core/workflow/index.js';

// Function wrappers for test readability
function buildInstruction(step: WorkflowStep, ctx: InstructionContext): string {
  return new InstructionBuilder(step, ctx).build();
}
function buildReportInstruction(step: WorkflowStep, ctx: ReportInstructionContext): string {
  return new ReportInstructionBuilder(step, ctx).build();
}
function buildStatusJudgmentInstruction(step: WorkflowStep, ctx: StatusJudgmentContext): string {
  return new StatusJudgmentBuilder(step, ctx).build();
}

// --- Test helpers ---

function makeRule(condition: string, next: string, extra?: Partial<WorkflowRule>): WorkflowRule {
  return { condition, next, ...extra };
}

function makeStep(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    name: 'test-step',
    agent: 'test-agent',
    agentDisplayName: 'test-step',
    instructionTemplate: 'Do the work.',
    passPreviousResponse: false,
    rules: [
      makeRule('Done', 'COMPLETE'),
      makeRule('Not done', 'ABORT'),
    ],
    ...overrides,
  };
}

function makeContext(overrides: Partial<InstructionContext> = {}): InstructionContext {
  return {
    task: 'Test task description',
    iteration: 3,
    maxIterations: 30,
    stepIteration: 2,
    cwd: '/tmp/test-project',
    projectCwd: '/tmp/test-project',
    userInputs: [],
    language: 'en',
    ...overrides,
  };
}

describe('Instruction Builder IT: task auto-injection', () => {
  it('should auto-inject task as "User Request" section when template has no {task}', () => {
    const step = makeStep({ instructionTemplate: 'Do the work.' });
    const ctx = makeContext({ task: 'Build the login page' });

    const result = buildInstruction(step, ctx);

    expect(result).toContain('## User Request');
    expect(result).toContain('Build the login page');
  });

  it('should NOT auto-inject task section when template contains {task}', () => {
    const step = makeStep({ instructionTemplate: 'Here is the task: {task}' });
    const ctx = makeContext({ task: 'Build the login page' });

    const result = buildInstruction(step, ctx);

    // Should not have separate User Request section
    const userRequestCount = (result.match(/## User Request/g) || []).length;
    expect(userRequestCount).toBe(0);
    // But task should still appear inline
    expect(result).toContain('Build the login page');
  });
});

describe('Instruction Builder IT: previous_response auto-injection', () => {
  it('should auto-inject previous response when passPreviousResponse is true', () => {
    const step = makeStep({
      passPreviousResponse: true,
      instructionTemplate: 'Continue the work.',
    });
    const previousOutput: AgentResponse = {
      agent: 'previous-agent',
      status: 'done',
      content: 'Previous agent completed step A.',
      timestamp: new Date(),
    };
    const ctx = makeContext({ previousOutput });

    const result = buildInstruction(step, ctx);

    expect(result).toContain('## Previous Response');
    expect(result).toContain('Previous agent completed step A.');
  });

  it('should NOT inject previous response when passPreviousResponse is false', () => {
    const step = makeStep({
      passPreviousResponse: false,
      instructionTemplate: 'Do fresh work.',
    });
    const previousOutput: AgentResponse = {
      agent: 'previous-agent',
      status: 'done',
      content: 'Previous output.',
      timestamp: new Date(),
    };
    const ctx = makeContext({ previousOutput });

    const result = buildInstruction(step, ctx);

    expect(result).not.toContain('## Previous Response');
    expect(result).not.toContain('Previous output.');
  });

  it('should NOT auto-inject when template contains {previous_response}', () => {
    const step = makeStep({
      passPreviousResponse: true,
      instructionTemplate: '## Context\n{previous_response}\n\nDo work.',
    });
    const previousOutput: AgentResponse = {
      agent: 'prev', status: 'done', content: 'Prior work done.', timestamp: new Date(),
    };
    const ctx = makeContext({ previousOutput });

    const result = buildInstruction(step, ctx);

    // Should not have separate Previous Response section
    const prevCount = (result.match(/## Previous Response/g) || []).length;
    expect(prevCount).toBe(0);
    // But content should be inline
    expect(result).toContain('Prior work done.');
  });
});

describe('Instruction Builder IT: user_inputs auto-injection', () => {
  it('should auto-inject user inputs section', () => {
    const step = makeStep();
    const ctx = makeContext({ userInputs: ['Fix the typo', 'Use TypeScript'] });

    const result = buildInstruction(step, ctx);

    expect(result).toContain('## Additional User Inputs');
    expect(result).toContain('Fix the typo');
    expect(result).toContain('Use TypeScript');
  });

  it('should NOT auto-inject when template contains {user_inputs}', () => {
    const step = makeStep({ instructionTemplate: 'Inputs: {user_inputs}' });
    const ctx = makeContext({ userInputs: ['Input A'] });

    const result = buildInstruction(step, ctx);

    const count = (result.match(/## Additional User Inputs/g) || []).length;
    expect(count).toBe(0);
    expect(result).toContain('Input A');
  });
});

describe('Instruction Builder IT: iteration variables', () => {
  it('should replace {iteration}, {max_iterations}, {step_iteration} in template', () => {
    const step = makeStep({
      instructionTemplate: 'Iter: {iteration}/{max_iterations}, step iter: {step_iteration}',
    });
    const ctx = makeContext({ iteration: 5, maxIterations: 30, stepIteration: 2 });

    const result = buildInstruction(step, ctx);

    expect(result).toContain('Iter: 5/30, step iter: 2');
  });

  it('should include iteration in Workflow Context section', () => {
    const step = makeStep();
    const ctx = makeContext({ iteration: 7, maxIterations: 20, stepIteration: 3 });

    const result = buildInstruction(step, ctx);

    expect(result).toContain('Iteration: 7/20');
    expect(result).toContain('Step Iteration: 3');
  });
});

describe('Instruction Builder IT: report_dir expansion', () => {
  it('should replace {report_dir} in template', () => {
    const step = makeStep({
      instructionTemplate: 'Read the plan from {report_dir}/00-plan.md',
    });
    const ctx = makeContext({ reportDir: '/tmp/test-project/.takt/reports/20250126-task' });

    const result = buildInstruction(step, ctx);

    expect(result).toContain('Read the plan from /tmp/test-project/.takt/reports/20250126-task/00-plan.md');
  });

  it('should replace {report:filename} with full path', () => {
    const step = makeStep({
      instructionTemplate: 'Read {report:00-plan.md} for the plan.',
    });
    const ctx = makeContext({ reportDir: '/tmp/reports' });

    const result = buildInstruction(step, ctx);

    expect(result).toContain('Read /tmp/reports/00-plan.md for the plan.');
  });
});

describe('Instruction Builder IT: status output rules injection', () => {
  it('should inject status rules for steps with tag-based rules', () => {
    const step = makeStep({
      name: 'plan',
      rules: [
        makeRule('Requirements clear', 'implement'),
        makeRule('Requirements unclear', 'ABORT'),
      ],
    });
    const ctx = makeContext();

    const result = buildInstruction(step, ctx);

    // Should contain status rules section with the tag format
    expect(result).toContain('[PLAN:');
    expect(result).toContain('Requirements clear');
    expect(result).toContain('Requirements unclear');
  });

  it('should NOT inject status rules for steps with only ai() conditions', () => {
    const step = makeStep({
      name: 'review',
      rules: [
        makeRule('ai("approved")', 'COMPLETE', { isAiCondition: true, aiConditionText: 'approved' }),
        makeRule('ai("rejected")', 'ABORT', { isAiCondition: true, aiConditionText: 'rejected' }),
      ],
    });
    const ctx = makeContext();

    const result = buildInstruction(step, ctx);

    // Should NOT contain tag-based status rules
    expect(result).not.toContain('[REVIEW:');
  });
});

describe('Instruction Builder IT: edit permission in execution context', () => {
  it('should include edit permission rules when edit is true', () => {
    const step = makeStep({ edit: true });
    const ctx = makeContext();

    const result = buildInstruction(step, ctx);

    // Should mention editing is allowed
    expect(result).toMatch(/edit|Edit|ファイル/i);
  });

  it('should indicate read-only when edit is false', () => {
    const step = makeStep({ edit: false });
    const ctx = makeContext();

    const result = buildInstruction(step, ctx);

    // Should contain the "Editing is DISABLED" execution rule
    expect(result).toContain('Editing is DISABLED');
    expect(result).not.toContain('Editing is ENABLED');
  });
});

describe('Instruction Builder IT: buildReportInstruction', () => {
  it('should build report instruction with report context', () => {
    const step = makeStep({
      name: 'plan',
      report: { name: '00-plan.md', format: '# Plan\n{step_iteration}' },
    });

    const result = buildReportInstruction(step, {
      cwd: '/tmp/test',
      reportDir: '/tmp/test/.takt/reports/test-dir',
      stepIteration: 1,
      language: 'en',
    });

    expect(result).toContain('00-plan.md');
    expect(result).toContain('/tmp/test/.takt/reports/test-dir');
    expect(result).toContain('report');
  });

  it('should throw for step without report config', () => {
    const step = makeStep({ report: undefined });

    expect(() =>
      buildReportInstruction(step, {
        cwd: '/tmp',
        reportDir: '/tmp/reports',
        stepIteration: 1,
      }),
    ).toThrow(/no report config/);
  });
});

describe('Instruction Builder IT: buildStatusJudgmentInstruction', () => {
  it('should build Phase 3 instruction with status rules', () => {
    const step = makeStep({
      name: 'plan',
      rules: [
        makeRule('Clear', 'implement'),
        makeRule('Unclear', 'ABORT'),
      ],
    });

    const result = buildStatusJudgmentInstruction(step, { language: 'en' });

    expect(result).toContain('[PLAN:');
    expect(result).toContain('Clear');
    expect(result).toContain('Unclear');
  });

  it('should throw for step without rules', () => {
    const step = makeStep({ rules: undefined });

    expect(() =>
      buildStatusJudgmentInstruction(step, { language: 'en' }),
    ).toThrow(/no rules/);
  });
});

describe('Instruction Builder IT: template injection prevention', () => {
  it('should escape curly braces in task content', () => {
    const step = makeStep();
    const ctx = makeContext({ task: 'Use {variable} in code' });

    const result = buildInstruction(step, ctx);

    // Braces should be escaped to prevent template re-injection
    expect(result).not.toContain('{variable}');
    expect(result).toContain('｛variable｝');
  });

  it('should escape curly braces in previous response content', () => {
    const step = makeStep({
      passPreviousResponse: true,
      instructionTemplate: 'Continue.',
    });
    const ctx = makeContext({
      previousOutput: {
        agent: 'prev', status: 'done',
        content: 'Use {template} syntax', timestamp: new Date(),
      },
    });

    const result = buildInstruction(step, ctx);

    expect(result).not.toContain('{template}');
    expect(result).toContain('｛template｝');
  });
});
