import { describe, it, expect } from 'vitest';
import {
  TaskRecordSchema,
  TaskFileSchema,
  TaskExecutionConfigSchema,
  serializeTaskRecord,
} from '../infra/task/schema.js';
import { buildWorkflowCallInvocationIdentity } from '../core/workflow/workflow-call-invocation-index.js';
import { buildWorkflowCallInvocationRecordsFixture } from './helpers/workflow-resume-fixture.js';

function makePendingRecord() {
  return {
    name: 'test-task',
    status: 'pending' as const,
    content: 'task content',
    created_at: '2025-01-01T00:00:00.000Z',
    started_at: null,
    completed_at: null,
  };
}

function makeRunningRecord() {
  return {
    name: 'test-task',
    status: 'running' as const,
    content: 'task content',
    created_at: '2025-01-01T00:00:00.000Z',
    started_at: '2025-01-01T01:00:00.000Z',
    completed_at: null,
  };
}

function makeCompletedRecord() {
  return {
    name: 'test-task',
    status: 'completed' as const,
    content: 'task content',
    created_at: '2025-01-01T00:00:00.000Z',
    started_at: '2025-01-01T01:00:00.000Z',
    completed_at: '2025-01-01T02:00:00.000Z',
  };
}

function makeFailedRecord() {
  return {
    name: 'test-task',
    status: 'failed' as const,
    content: 'task content',
    created_at: '2025-01-01T00:00:00.000Z',
    started_at: '2025-01-01T01:00:00.000Z',
    completed_at: '2025-01-01T02:00:00.000Z',
    failure: { error: 'something went wrong' },
  };
}

function makePrFailedRecord() {
  return {
    name: 'test-task',
    status: 'pr_failed' as const,
    content: 'task content',
    created_at: '2025-01-01T00:00:00.000Z',
    started_at: '2025-01-01T01:00:00.000Z',
    completed_at: '2025-01-01T02:00:00.000Z',
    failure: { error: 'PR creation failed: Base ref must be a branch' },
  };
}

const taskIdFields = ['issue', 'pr_number', 'context_pr_number'] as const;
const invalidTaskIdValues = [
  ['zero', 0],
  ['negative', -1],
  ['decimal', 1.5],
  ['unsafe', Number.MAX_SAFE_INTEGER + 1],
] as const;

describe('TaskExecutionConfigSchema', () => {
  it('should accept valid config with all optional fields', () => {
    const config = {
      worktree: true,
      branch: 'feature/test',
      workflow: 'unit-test',
      issue: 42,
      start_step: 'plan',
      retry_note: 'retry after fix',
      auto_pr: true,
      managed_pr: true,
    };
    expect(() => TaskExecutionConfigSchema.parse(config)).not.toThrow();
  });

  it('should reject managed_pr without auto_pr', () => {
    expect(() => TaskExecutionConfigSchema.parse({
      worktree: true,
      managed_pr: true,
    })).toThrow('managed_pr requires auto_pr to be true');
  });

  it('should reject managed_pr without worktree', () => {
    expect(() => TaskExecutionConfigSchema.parse({
      auto_pr: true,
      managed_pr: true,
    })).toThrow('managed_pr requires worktree to be enabled');
  });

  it('should accept empty config (all fields optional)', () => {
    expect(() => TaskExecutionConfigSchema.parse({})).not.toThrow();
  });

  it('should accept worktree as string', () => {
    expect(() => TaskExecutionConfigSchema.parse({ worktree: '/custom/path' })).not.toThrow();
  });

  it('should reject negative issue number', () => {
    expect(() => TaskExecutionConfigSchema.parse({ issue: -1 })).toThrow();
  });

  it('should reject non-integer issue number', () => {
    expect(() => TaskExecutionConfigSchema.parse({ issue: 1.5 })).toThrow();
  });

  it('should accept positive safe integer task id fields', () => {
    expect(() => TaskExecutionConfigSchema.parse({
      issue: Number.MAX_SAFE_INTEGER,
      pr_number: Number.MAX_SAFE_INTEGER,
      context_pr_number: Number.MAX_SAFE_INTEGER,
    })).not.toThrow();
  });

  it('should reject non-positive, decimal, and unsafe task id fields', () => {
    for (const field of taskIdFields) {
      for (const [, value] of invalidTaskIdValues) {
        expect(() => TaskExecutionConfigSchema.parse({ [field]: value })).toThrow();
      }
    }
  });

  it('should accept base_branch when provided in config', () => {
    expect(() => TaskExecutionConfigSchema.parse({ base_branch: 'feature/base' })).not.toThrow();
  });

  it('should accept workflow and start_step keys', () => {
    const config = TaskExecutionConfigSchema.parse({
      workflow: 'unit-test',
      start_step: 'plan',
    }) as Record<string, unknown>;

    expect(config.workflow).toBe('unit-test');
    expect(config.start_step).toBe('plan');
  });

  it('should accept resume point entries with omitted or positive integer step iterations', () => {
    const baseResumePoint = {
      version: 2,
      iteration: 3,
      elapsed_ms: 100,
      workflow_call_invocations: {},
      workflow_step_participations: {},
    };

    expect(() => TaskExecutionConfigSchema.parse({
      resume_point: {
        ...baseResumePoint,
        stack: [{ workflow: 'default', step: 'implement', kind: 'agent' }],
      },
    })).not.toThrow();
    expect(() => TaskExecutionConfigSchema.parse({
      resume_point: {
        ...baseResumePoint,
        stack: [{
          workflow: 'default',
          step: 'implement',
          kind: 'agent',
          step_iterations: { implement: 1, review: 4 },
        }],
      },
    })).not.toThrow();
  });

  it('should round-trip dynamic parallel resume selections', () => {
    const parsed = TaskExecutionConfigSchema.parse({
      resume_point: {
        version: 2,
        stack: [{ workflow: 'default', step: 'reviewers', kind: 'agent' }],
        iteration: 3,
        elapsed_ms: 100,
        dynamic_parallel_selections: {
          '{"workflow":"default","step":"reviewers","owners":[]}': {
            identity: '{"workflow":"default","step":"reviewers","owners":[]}',
            step_name: 'reviewers',
            round: 1,
            selected_pool_ids: ['frontend'],
            effective_selection_ids: ['architecture', 'frontend'],
          },
        },
        workflow_call_invocations: {},
        workflow_step_participations: {},
      },
    });

    expect(parsed.resume_point?.dynamic_parallel_selections).toBeDefined();
  });

  it('should round-trip started loop judge and pending fallback checkpoints', () => {
    const parsedJudge = TaskExecutionConfigSchema.parse({
      resume_point: {
        version: 2,
        stack: [{
          workflow: 'default',
          step: '_loop_judge_review_fix',
          kind: 'agent',
          step_iterations: { _loop_judge_review_fix: 1 },
        }],
        iteration: 4,
        elapsed_ms: 100,
        pending_loop_judge: {
          status: 'started',
          triggering_step: 'fix',
          cycle: ['review', 'fix'],
          cycle_count: 1,
          fallback_next_step: 'review',
          judge_step: '_loop_judge_review_fix',
          iteration: 4,
          step_iteration: 1,
        },
        workflow_call_invocations: {},
        workflow_step_participations: {},
      },
    });
    const parsedFallback = TaskExecutionConfigSchema.parse({
      resume_point: {
        version: 2,
        stack: [{ workflow: 'default', step: 'plan', kind: 'agent' }],
        iteration: 0,
        elapsed_ms: 100,
        pending_fallback: {
          context: {
            reason: 'rate_limited',
            reasonDetail: 'rate limit',
            originalIteration: 1,
            previousProvider: 'claude',
            previousModel: 'claude-sonnet',
            currentProvider: 'codex',
            currentModel: 'gpt-5',
            stepName: 'plan',
            reportDir: 'reports',
          },
          attempts: [
            { provider: 'claude', model: 'claude-sonnet' },
            { provider: 'codex', model: 'gpt-5' },
          ],
        },
        workflow_call_invocations: {},
        workflow_step_participations: {},
      },
    });

    expect(parsedJudge.resume_point?.pending_loop_judge).toMatchObject({ status: 'started' });
    expect(parsedFallback.resume_point?.pending_fallback?.attempts).toHaveLength(2);
  });

  it('should reject checkpoint owners that do not match pending execution state', () => {
    expect(() => TaskExecutionConfigSchema.parse({
      resume_point: {
        version: 2,
        stack: [{ workflow: 'default', step: 'fix', kind: 'agent' }],
        iteration: 4,
        elapsed_ms: 100,
        pending_loop_judge: {
          status: 'started',
          triggering_step: 'fix',
          cycle: ['review', 'fix'],
          cycle_count: 1,
          fallback_next_step: 'review',
          judge_step: '_loop_judge_review_fix',
          iteration: 4,
          step_iteration: 1,
        },
        workflow_call_invocations: {},
        workflow_step_participations: {},
      },
    })).toThrow('Pending loop judge owner must match terminal resume stack entry');
  });

  it('should reject a started loop judge whose iteration differs from the resume point', () => {
    expect(() => TaskExecutionConfigSchema.parse({
      resume_point: {
        version: 2,
        stack: [{
          workflow: 'default',
          step: '_loop_judge_review_fix',
          kind: 'agent',
          step_iterations: { _loop_judge_review_fix: 1 },
        }],
        iteration: 4,
        elapsed_ms: 100,
        pending_loop_judge: {
          status: 'started',
          triggering_step: 'fix',
          cycle: ['review', 'fix'],
          cycle_count: 1,
          fallback_next_step: 'review',
          judge_step: '_loop_judge_review_fix',
          iteration: 5,
          step_iteration: 1,
        },
        workflow_call_invocations: {},
        workflow_step_participations: {},
      },
    })).toThrow('Started loop judge iteration must match resume point iteration');
  });

  it('should reject a started loop judge whose terminal owner is not an agent step', () => {
    expect(() => TaskExecutionConfigSchema.parse({
      resume_point: {
        version: 2,
        stack: [{
          workflow: 'default',
          step: '_loop_judge_review_fix',
          kind: 'system',
          step_iterations: { _loop_judge_review_fix: 1 },
        }],
        iteration: 4,
        elapsed_ms: 100,
        pending_loop_judge: {
          status: 'started',
          triggering_step: 'fix',
          cycle: ['review', 'fix'],
          cycle_count: 1,
          fallback_next_step: 'review',
          judge_step: '_loop_judge_review_fix',
          iteration: 4,
          step_iteration: 1,
        },
        workflow_call_invocations: {},
        workflow_step_participations: {},
      },
    })).toThrow('Started loop judge owner must be an agent step');
  });

  it.each([
    ['is missing from', undefined],
    ['differs from', { _loop_judge_review_fix: 1 }],
  ])('should reject a started loop judge whose step iteration %s the resume stack', (_label, stepIterations) => {
    expect(() => TaskExecutionConfigSchema.parse({
      resume_point: {
        version: 2,
        stack: [{
          workflow: 'default',
          step: '_loop_judge_review_fix',
          kind: 'agent',
          ...(stepIterations === undefined ? {} : { step_iterations: stepIterations }),
        }],
        iteration: 4,
        elapsed_ms: 100,
        pending_loop_judge: {
          status: 'started',
          triggering_step: 'fix',
          cycle: ['review', 'fix'],
          cycle_count: 1,
          fallback_next_step: 'review',
          judge_step: '_loop_judge_review_fix',
          iteration: 4,
          step_iteration: 2,
        },
        workflow_call_invocations: {},
        workflow_step_participations: {},
      },
    })).toThrow('Started loop judge step iteration must match terminal resume stack entry');
  });

  it.each([
    {
      label: 'previous provider and model',
      attempts: [
        { provider: 'claude', model: 'claude-opus' },
        { provider: 'codex', model: 'gpt-5' },
      ],
      message: 'Pending fallback previous attempt must match fallback context',
    },
    {
      label: 'current provider and model',
      attempts: [
        { provider: 'claude', model: 'claude-sonnet' },
        { provider: 'cursor', model: 'cursor-default' },
      ],
      message: 'Pending fallback current attempt must match fallback context',
    },
  ])('should reject pending fallback attempts whose $label differ from the fallback context', ({ attempts, message }) => {
    expect(() => TaskExecutionConfigSchema.parse({
      resume_point: {
        version: 2,
        stack: [{ workflow: 'default', step: 'plan', kind: 'agent' }],
        iteration: 0,
        elapsed_ms: 100,
        pending_fallback: {
          context: {
            reason: 'rate_limited',
            reasonDetail: 'rate limit',
            originalIteration: 1,
            previousProvider: 'claude',
            previousModel: 'claude-sonnet',
            currentProvider: 'codex',
            currentModel: 'gpt-5',
            stepName: 'plan',
            reportDir: 'reports',
          },
          attempts,
        },
        workflow_call_invocations: {},
        workflow_step_participations: {},
      },
    })).toThrow(message);
  });

  it('should reject a pending fallback whose terminal owner is not an agent step', () => {
    expect(() => TaskExecutionConfigSchema.parse({
      resume_point: {
        version: 2,
        stack: [{ workflow: 'default', step: 'plan', kind: 'system' }],
        iteration: 0,
        elapsed_ms: 100,
        pending_fallback: {
          context: {
            reason: 'rate_limited',
            reasonDetail: 'rate limit',
            originalIteration: 1,
            previousProvider: 'claude',
            previousModel: 'claude-sonnet',
            currentProvider: 'codex',
            currentModel: 'gpt-5',
            stepName: 'plan',
            reportDir: 'reports',
          },
          attempts: [
            { provider: 'claude', model: 'claude-sonnet' },
            { provider: 'codex', model: 'gpt-5' },
          ],
        },
        workflow_call_invocations: {},
        workflow_step_participations: {},
      },
    })).toThrow('Pending fallback owner must be an agent step');
  });

  it('should round-trip the canonical workflow-call invocation index', () => {
    const invocationIdentity = buildWorkflowCallInvocationIdentity('default', 'delegate', []);
    const parsed = TaskExecutionConfigSchema.parse({
      resume_point: {
        version: 2,
        stack: [{
          workflow: 'default',
          step: 'delegate',
          kind: 'workflow_call',
          call_instance: 2,
        }],
        iteration: 3,
        elapsed_ms: 100,
        workflow_call_invocations: buildWorkflowCallInvocationRecordsFixture([{
          workflowReference: 'default',
          step: 'delegate',
          ownerPath: [],
          callInstance: 2,
          childWorkflowReference: 'child',
        }]),
        workflow_step_participations: {},
      },
    });

    expect(parsed.resume_point?.workflow_call_invocations).toEqual({
      [invocationIdentity]: {
        call_instance: 2,
        child_workflow_ref: 'child',
      },
    });
  });

  it('should canonicalize a version 2 iteration namespace with its call instance', () => {
    const invocationIdentity = buildWorkflowCallInvocationIdentity('default', 'delegate', []);

    const parsed = TaskExecutionConfigSchema.parse({
      resume_point: {
        version: 2,
        stack: [{
          workflow: 'default',
          step: 'delegate',
          kind: 'workflow_call',
          call_instance: 2,
        }],
        iteration: 3,
        elapsed_ms: 100,
        workflow_call_invocations: {
          [invocationIdentity]: {
            call_instance: 2,
            report_namespace_segment: 'iteration-3--step-delegate--workflow-child',
          },
        },
        workflow_step_participations: {},
      },
    });

    expect(parsed.resume_point?.workflow_call_invocations[invocationIdentity]).toEqual({
      call_instance: 2,
      child_workflow_ref: 'child',
    });
  });

  it('should normalize a legacy call-v1 record to the logical invocation record', () => {
    const invocationIdentity = buildWorkflowCallInvocationIdentity('default', 'delegate', []);

    const parsed = TaskExecutionConfigSchema.parse({
      resume_point: {
        version: 2,
        stack: [{
          workflow: 'default',
          step: 'delegate',
          kind: 'workflow_call',
          call_instance: 2,
        }],
        iteration: 3,
        elapsed_ms: 100,
        workflow_call_invocations: {
          [invocationIdentity]: {
            call_instance: 2,
            report_namespace_segment: 'call-v1-2!default!delegate!0!child',
          },
        },
        workflow_step_participations: {},
      },
    });

    expect(parsed.resume_point?.workflow_call_invocations[invocationIdentity]).toEqual({
      call_instance: 2,
      child_workflow_ref: 'child',
    });
  });

  it('should reject a non-canonical encoded legacy invocation namespace', () => {
    const invocationIdentity = buildWorkflowCallInvocationIdentity('default', 'delegate', []);

    expect(() => TaskExecutionConfigSchema.parse({
      resume_point: {
        version: 2,
        stack: [{
          workflow: 'default',
          step: 'delegate',
          kind: 'workflow_call',
          call_instance: 2,
        }],
        iteration: 3,
        elapsed_ms: 100,
        workflow_call_invocations: {
          [invocationIdentity]: {
            call_instance: 2,
            report_namespace_segment: 'iteration-3--step-delegate--workflow-child%2finner',
          },
        },
        workflow_step_participations: {},
      },
    })).toThrow('Invalid workflow-call report namespace segment');
  });

  it('should reject a resume stack invocation that differs from its canonical record', () => {
    const invocationIdentity = buildWorkflowCallInvocationIdentity('default', 'delegate', []);

    expect(() => TaskExecutionConfigSchema.parse({
      resume_point: {
        version: 2,
        stack: [{
          workflow: 'default',
          step: 'delegate',
          kind: 'workflow_call',
          call_instance: 3,
        }],
        iteration: 3,
        elapsed_ms: 100,
        workflow_call_invocations: {
          [invocationIdentity]: {
            call_instance: 2,
            child_workflow_ref: 'child',
          },
        },
        workflow_step_participations: {},
      },
    })).toThrow('invocation identity does not match resume entry');
  });

  it('should reject a resume stack child that differs from its logical invocation record', () => {
    const invocationIdentity = buildWorkflowCallInvocationIdentity('default', 'delegate', []);

    expect(() => TaskExecutionConfigSchema.parse({
      resume_point: {
        version: 2,
        stack: [
          {
            workflow: 'default',
            step: 'delegate',
            kind: 'workflow_call',
            call_instance: 2,
          },
          { workflow: 'child', step: 'review', kind: 'agent' },
        ],
        iteration: 3,
        elapsed_ms: 100,
        workflow_call_invocations: {
          [invocationIdentity]: {
            call_instance: 2,
            child_workflow_ref: 'other-child',
          },
        },
        workflow_step_participations: {},
      },
    })).toThrow('child reference does not match resume entry');
  });

  it.each([
    ['an empty key', { '': 1 }],
    ['zero', { implement: 0 }],
    ['a negative value', { implement: -1 }],
    ['a decimal value', { implement: 1.5 }],
  ])('should reject step iterations containing %s', (_name, stepIterations) => {
    expect(() => TaskExecutionConfigSchema.parse({
      resume_point: {
        version: 2,
        stack: [{
          workflow: 'default',
          step: 'implement',
          kind: 'agent',
          step_iterations: stepIterations,
        }],
        iteration: 3,
        elapsed_ms: 100,
        workflow_call_invocations: {},
        workflow_step_participations: {},
      },
    })).toThrow();
  });

  it.each(['workflow_call_invocations', 'workflow_step_participations'] as const)(
    'should reject version 2 resume points missing %s',
    (field) => {
      const completeResumePoint = {
        version: 2,
        stack: [{ workflow: 'default', step: 'implement', kind: 'agent' }],
        iteration: 3,
        elapsed_ms: 100,
        workflow_call_invocations: {},
        workflow_step_participations: {},
      };
      const resumePoint = Object.fromEntries(
        Object.entries(completeResumePoint).filter(([key]) => key !== field),
      );

      expect(() => TaskExecutionConfigSchema.parse({ resume_point: resumePoint })).toThrow();
    },
  );


  it('should reject conflicting start_step and start_movement values', () => {
    expect(() => TaskExecutionConfigSchema.parse({
      start_step: 'plan',
      start_movement: 'implement',
    })).toThrow('start_step and start_movement must match when both are set');
  });

  it('should return safeParse failure instead of throwing for conflicting start_step and start_movement values', () => {
    const input = {
      start_step: 'plan',
      start_movement: 'implement',
    };

    expect(() => TaskExecutionConfigSchema.safeParse(input)).not.toThrow();
    const result = TaskExecutionConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          message: 'start_step and start_movement must match when both are set',
          path: ['start_movement'],
        }),
      ]));
    }
  });

  it('should reject non-string start_movement values', () => {
    expect(() => TaskExecutionConfigSchema.parse({
      start_movement: 123,
    })).toThrow();
  });


  it('should serialize canonical task keys as workflow and start_movement', () => {
    const serialized = serializeTaskRecord({
      ...makePendingRecord(),
      workflow: 'unit-test',
      start_step: 'plan',
    } as ReturnType<typeof makePendingRecord> & { workflow: string; start_step: string });

    expect(serialized).toMatchObject({
      workflow: 'unit-test',
      start_movement: 'plan',
    });
  });

  it('should preserve managed_pr in task config serialization', () => {
    const serialized = serializeTaskRecord({
      ...makePendingRecord(),
      managed_pr: true,
    } as ReturnType<typeof makePendingRecord> & { managed_pr: boolean });

    expect(serialized).toMatchObject({
      managed_pr: true,
    });
  });
});

describe('TaskFileSchema', () => {
  it('should accept valid task with required fields', () => {
    expect(() => TaskFileSchema.parse({ task: 'do something' })).not.toThrow();
  });

  it('should return safeParse failure instead of throwing for conflicting start_step and start_movement values', () => {
    const input = {
      task: 'do something',
      start_step: 'plan',
      start_movement: 'implement',
    };

    expect(() => TaskFileSchema.safeParse(input)).not.toThrow();
    const result = TaskFileSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          message: 'start_step and start_movement must match when both are set',
          path: ['start_movement'],
        }),
      ]));
    }
  });

  it('should reject empty task string', () => {
    expect(() => TaskFileSchema.parse({ task: '' })).toThrow();
  });

  it('should reject missing task field', () => {
    expect(() => TaskFileSchema.parse({})).toThrow();
  });

  it('should accept positive safe integer task id fields', () => {
    expect(() => TaskFileSchema.parse({
      task: 'do something',
      issue: Number.MAX_SAFE_INTEGER,
      pr_number: Number.MAX_SAFE_INTEGER,
      context_pr_number: Number.MAX_SAFE_INTEGER,
    })).not.toThrow();
  });

  it('should reject non-positive, decimal, and unsafe task id fields', () => {
    for (const field of taskIdFields) {
      for (const [, value] of invalidTaskIdValues) {
        expect(() => TaskFileSchema.parse({ task: 'do something', [field]: value })).toThrow();
      }
    }
  });
});

describe('TaskRecordSchema', () => {
  describe('pending status', () => {
    it('should accept valid pending record', () => {
      expect(() => TaskRecordSchema.parse(makePendingRecord())).not.toThrow();
    });

    it('should return safeParse failure instead of throwing for conflicting start_step and start_movement values', () => {
      const input = {
        ...makePendingRecord(),
        start_step: 'plan',
        start_movement: 'implement',
      };

      expect(() => TaskRecordSchema.safeParse(input)).not.toThrow();
      const result = TaskRecordSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toEqual(expect.arrayContaining([
          expect.objectContaining({
            message: 'start_step and start_movement must match when both are set',
            path: ['start_movement'],
          }),
        ]));
      }
    });

    it('should reject pending record with started_at', () => {
      const record = { ...makePendingRecord(), started_at: '2025-01-01T01:00:00.000Z' };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });

    it('should reject pending record with completed_at', () => {
      const record = { ...makePendingRecord(), completed_at: '2025-01-01T02:00:00.000Z' };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });

    it('should reject pending record with failure', () => {
      const record = { ...makePendingRecord(), failure: { error: 'fail' } };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });

    it('should reject pending record with owner_pid', () => {
      const record = { ...makePendingRecord(), owner_pid: 1234 };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });
  });

  describe('running status', () => {
    it('should accept valid running record', () => {
      expect(() => TaskRecordSchema.parse(makeRunningRecord())).not.toThrow();
    });

    it('should accept running record with run_slug', () => {
      const record = { ...makeRunningRecord(), run_slug: '20260409-running-task' };
      expect(() => TaskRecordSchema.parse(record)).not.toThrow();
    });

    it('should reject running record without started_at', () => {
      const record = { ...makeRunningRecord(), started_at: null };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });

    it('should reject running record with completed_at', () => {
      const record = { ...makeRunningRecord(), completed_at: '2025-01-01T02:00:00.000Z' };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });

    it('should reject running record with failure', () => {
      const record = { ...makeRunningRecord(), failure: { error: 'fail' } };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });

    it('should accept running record with owner_pid', () => {
      const record = { ...makeRunningRecord(), owner_pid: 5678 };
      expect(() => TaskRecordSchema.parse(record)).not.toThrow();
    });
  });

  describe('completed status', () => {
    it('should accept valid completed record', () => {
      expect(() => TaskRecordSchema.parse(makeCompletedRecord())).not.toThrow();
    });

    it('should reject completed record without started_at', () => {
      const record = { ...makeCompletedRecord(), started_at: null };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });

    it('should reject completed record without completed_at', () => {
      const record = { ...makeCompletedRecord(), completed_at: null };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });

    it('should reject completed record with failure', () => {
      const record = { ...makeCompletedRecord(), failure: { error: 'fail' } };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });

    it('should reject completed record with owner_pid', () => {
      const record = { ...makeCompletedRecord(), owner_pid: 1234 };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });
  });

  describe('pr_failed status', () => {
    it('should accept valid pr_failed record with failure', () => {
      expect(() => TaskRecordSchema.parse(makePrFailedRecord())).not.toThrow();
    });

    it('should accept pr_failed record without failure (optional)', () => {
      const record = { ...makePrFailedRecord(), failure: undefined };
      expect(() => TaskRecordSchema.parse(record)).not.toThrow();
    });

    it('should reject pr_failed record without started_at', () => {
      const record = { ...makePrFailedRecord(), started_at: null };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });

    it('should reject pr_failed record without completed_at', () => {
      const record = { ...makePrFailedRecord(), completed_at: null };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });

    it('should reject pr_failed record with owner_pid', () => {
      const record = { ...makePrFailedRecord(), owner_pid: 1234 };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });
  });

  it('should serialize run_slug when present', () => {
    const serialized = serializeTaskRecord({
      ...makeRunningRecord(),
      run_slug: '20260409-running-task',
    });

    expect(serialized).toMatchObject({
      run_slug: '20260409-running-task',
    });
  });

  describe('failed status', () => {
    it('should accept valid failed record', () => {
      expect(() => TaskRecordSchema.parse(makeFailedRecord())).not.toThrow();
    });

    it('should reject failed record without started_at', () => {
      const record = { ...makeFailedRecord(), started_at: null };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });

    it('should reject failed record without completed_at', () => {
      const record = { ...makeFailedRecord(), completed_at: null };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });

    it('should reject failed record without failure', () => {
      const record = { ...makeFailedRecord(), failure: undefined };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });

    it('should reject failed record with owner_pid', () => {
      const record = { ...makeFailedRecord(), owner_pid: 1234 };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });
  });

  describe('content requirement', () => {
    it('should accept record with content', () => {
      expect(() => TaskRecordSchema.parse(makePendingRecord())).not.toThrow();
    });

    it('should accept record with content_file', () => {
      const record = { ...makePendingRecord(), content: undefined, content_file: './task.md' };
      expect(() => TaskRecordSchema.parse(record)).not.toThrow();
    });

    it('should accept record with task_dir', () => {
      const record = { ...makePendingRecord(), content: undefined, task_dir: '.takt/tasks/20260201-000000-task' };
      expect(() => TaskRecordSchema.parse(record)).not.toThrow();
    });

    it('should reject record with neither content, content_file, nor task_dir', () => {
      const record = { ...makePendingRecord(), content: undefined };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });

    it('should reject record with both content and task_dir', () => {
      const record = { ...makePendingRecord(), task_dir: '.takt/tasks/20260201-000000-task' };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });

    it('should reject record with invalid task_dir format', () => {
      const record = { ...makePendingRecord(), content: undefined, task_dir: '.takt/reports/invalid' };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });

    it('should reject record with parent-directory task_dir', () => {
      const record = { ...makePendingRecord(), content: undefined, task_dir: '.takt/tasks/..' };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });

    it('should reject record with empty content', () => {
      const record = { ...makePendingRecord(), content: '' };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });

    it('should reject record with empty content_file', () => {
      const record = { ...makePendingRecord(), content: undefined, content_file: '' };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });
  });

  it('should accept base_branch when task record uses config-only fields', () => {
    expect(() => TaskRecordSchema.parse({
      ...makePendingRecord(),
      content: undefined,
      task_dir: '.takt/tasks/feat-bugfix',
      base_branch: 'release/main',
    })).not.toThrow();
  });

  it('should accept and serialize auto_requeue_count when present', () => {
    const parsed = TaskRecordSchema.parse({
      ...makeFailedRecord(),
      auto_requeue_count: 2,
    }) as Record<string, unknown>;
    const serialized = serializeTaskRecord(parsed as never);

    expect(parsed.auto_requeue_count).toBe(2);
    expect(serialized).toMatchObject({
      auto_requeue_count: 2,
    });
  });

  it('should reject invalid auto_requeue_count values', () => {
    expect(() => TaskRecordSchema.parse({
      ...makeFailedRecord(),
      auto_requeue_count: -1,
    })).toThrow();
    expect(() => TaskRecordSchema.parse({
      ...makeFailedRecord(),
      auto_requeue_count: 1.5,
    })).toThrow();
  });

  it('should accept positive safe integer task id fields', () => {
    expect(() => TaskRecordSchema.parse({
      ...makePendingRecord(),
      issue: Number.MAX_SAFE_INTEGER,
      pr_number: Number.MAX_SAFE_INTEGER,
      context_pr_number: Number.MAX_SAFE_INTEGER,
    })).not.toThrow();
  });

  it('should reject non-positive, decimal, and unsafe task id fields', () => {
    for (const field of taskIdFields) {
      for (const [, value] of invalidTaskIdValues) {
        expect(() => TaskRecordSchema.parse({ ...makePendingRecord(), [field]: value })).toThrow();
      }
    }
  });
});
