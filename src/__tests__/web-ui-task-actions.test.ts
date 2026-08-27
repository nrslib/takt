import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  getCentralTaskActions,
  projectCentralTaskStatus,
} from '../features/web-ui/task-actions.js';
import type {
  CentralTaskLaunchDecision,
  CentralTaskRecord,
  CentralTaskRepository,
} from '../infra/task/centralStateRepository.js';
import type { WebTaskActionClaim } from '../features/web-ui/chat.js';
import { executeCentralTaskAction } from '../features/web-ui/task-actions.js';
import { resolveTaskRetryStartOwnership } from '../features/tasks/list/taskRetryStartSelection.js';

const timestamp = '2026-08-27T00:00:00.000Z';

function makeTask(
  status: CentralTaskRecord['status'],
  failure?: CentralTaskRecord['failure'],
): CentralTaskRecord {
  return {
    taskId: randomUUID(),
    generation: 0,
    status,
    origin: 'web',
    attempt: 1,
    task: 'task',
    workflow: 'default',
    worktree: true,
    worktreePath: '/tmp/takt-worktree',
    branch: 'takt/task',
    createdAt: timestamp,
    updatedAt: timestamp,
    runId: 'run-1',
    runIds: ['run-1'],
    ...(failure === undefined ? {} : { failure }),
  };
}

function makeDrainingTask(withReservation = false): CentralTaskRecord {
  const task = makeTask('failed', {
    code: 'force_failed',
    message: 'stopped',
    at: timestamp,
  });
  return {
    ...task,
    generation: 1,
    drainingExecution: {
      executionId: randomUUID(),
      runId: 'run-1',
      ownerTokenHash: 'a'.repeat(64),
      pid: 1234,
      startTime: timestamp,
      startedAt: timestamp,
      generation: 0,
      markedAt: timestamp,
    },
    ...(withReservation
      ? { requeueAfterDrain: { task: 'next task', requestedAt: timestamp } }
      : {}),
  };
}

describe('central Web UI task action policy', () => {
  it('exposes the terminal action matrix including conversation actions', () => {
    const cases: ReadonlyArray<[
      CentralTaskRecord,
      readonly string[],
    ]> = [
      [makeTask('pending'), ['delete']],
      [makeTask('starting'), ['force_fail']],
      [makeTask('running'), ['force_fail']],
      [makeTask('failed'), ['requeue', 'retry', 'create_pr', 'delete']],
      [makeTask('failed', { code: 'iteration_exceeded', message: 'limit', at: timestamp }), ['requeue', 'delete']],
      [makeTask('completed'), ['diff', 'instruct', 'create_pr', 'sync', 'pull', 'try', 'merge', 'delete']],
      [makeTask('failed', { code: 'pr_failed', message: 'provider', at: timestamp }), ['diff', 'instruct', 'sync', 'pull', 'try', 'merge', 'delete']],
      [makeDrainingTask(), ['requeue']],
      [makeDrainingTask(true), []],
    ];

    for (const [task, expected] of cases) {
      expect(getCentralTaskActions(task)).toEqual(expected);
    }
  });

  it('does not expose branch operations for worktree=false tasks', () => {
    const task = { ...makeTask('completed'), worktree: false, worktreePath: undefined, branch: undefined };
    expect(getCentralTaskActions(task)).toEqual(['delete']);
    expect(getCentralTaskActions({
      ...task,
      status: 'failed',
      failure: { code: 'workflow_failed', message: 'failed', at: timestamp },
    })).toEqual(['requeue', 'delete']);
  });

  it('projects concrete failure codes to the server display status', () => {
    expect(projectCentralTaskStatus(makeTask('failed', {
      code: 'iteration_exceeded',
      message: 'step limit',
      at: timestamp,
    }))).toBe('exceeded');
    expect(projectCentralTaskStatus(makeTask('failed', {
      code: 'pr_failed',
      message: 'pull request failed',
      at: timestamp,
    }))).toBe('pr_failed');
    expect(projectCentralTaskStatus(makeTask('failed', {
      code: 'workflow_failed',
      message: 'workflow failed',
      at: timestamp,
    }))).toBe('failed');
  });

  it('resolves retry option ids on the server and preserves the task id for the next run', async () => {
    const task = makeTask('failed');
    const resumedTask: CentralTaskRecord = {
      ...task,
      generation: task.generation + 2,
      status: 'starting',
      attempt: 2,
      runId: 'run-2',
      runIds: ['run-1', 'run-2'],
      activeExecution: {
        executionId: randomUUID(),
        runId: 'run-2',
        ownerTokenHash: 'a'.repeat(64),
        pid: 0,
        startTime: timestamp,
        startedAt: timestamp,
      },
    };
    const requeueTask = vi.fn(async (): Promise<CentralTaskLaunchDecision> => ({
      kind: 'started',
      task: resumedTask,
      ownerToken: 'owner-token',
      executionId: resumedTask.activeExecution!.executionId,
      runId: resumedTask.runId,
    }));
    const repository = {
      readTask: vi.fn(async () => task),
      requeueTask,
      state: { stateId: 'state-1' },
      globalConfigDirectory: '/global',
    } as unknown as CentralTaskRepository;
    const resumePoint = {
      version: 2 as const,
      stack: [{
        workflow: 'default',
        workflow_ref: 'default',
        step: 'plan',
        kind: 'agent' as const,
        occurrence: 1,
      }],
      iteration: 1,
      elapsed_ms: 10,
      workflow_call_invocations: {},
      workflow_step_participations: {},
    };
    const claim: WebTaskActionClaim = {
      reservationToken: 'reservation-retry',
      context: {
        taskId: task.taskId,
        action: 'retry',
        projectId: 'project-1',
        stateId: 'state-1',
        projectDirectory: '/project',
        task: task.task,
        workflow: task.workflow,
        workflowInitialStep: 'plan',
        status: 'failed',
        attempt: task.attempt,
        runIds: task.runIds,
        generation: task.generation,
        runId: task.runId,
        sourceRunId: task.runId,
        worktreePath: task.worktreePath,
      },
      retrySelection: { kind: 'resume', resumePoint },
    };

    const result = await executeCentralTaskAction({
      globalConfigDirectory: '/global',
      projectDirectory: '/project',
      projectId: 'project-1',
      repository,
      task,
      action: 'retry',
      input: 'retry with the corrected fixture',
      conversationId: 'conversation-1',
      taskActionClaim: claim,
      spawnDecision: async () => ({ pid: 123, disposition: 'started' as const, mode: 'run' as const }),
    });

    expect(result).toMatchObject({ action: 'retry', taskId: task.taskId, status: 'accepted' });
    expect(requeueTask).toHaveBeenCalledWith(task.taskId, {
      task: 'retry with the corrected fixture',
      executionRequest: {
        resumeMode: 'retry',
        sourceRunSlug: 'run-1',
        resumePoint,
        retryNote: 'retry with the corrected fixture',
      },
    });
  });

  it('uses the workflow initial step only for retry ownership resolution', () => {
    const resumePoint = {
      version: 2 as const,
      stack: [{
        workflow: 'default',
        workflow_ref: 'default',
        step: 'plan',
        kind: 'agent' as const,
        occurrence: 1,
      }],
      iteration: 1,
      elapsed_ms: 10,
      workflow_call_invocations: {},
      workflow_step_participations: {},
    };
    const restartPoint = {
      stack: [{
        workflow: 'default',
        workflow_ref: 'default',
        step: 'plan',
        kind: 'agent' as const,
      }],
    };

    expect(resolveTaskRetryStartOwnership(
      { kind: 'resume', resumePoint },
      { initialStep: 'plan' },
    )).toEqual({ resumePoint });
    expect(resolveTaskRetryStartOwnership(
      { kind: 'resume', resumePoint },
      { initialStep: 'implement' },
    )).toEqual({ startStep: 'plan', resumePoint });
    expect(resolveTaskRetryStartOwnership(
      { kind: 'restart', restartPoint },
      { initialStep: 'plan' },
    )).toEqual({ restartPoint });
  });

  it('creates an instruct execution request without exposing retry checkpoints', async () => {
    const task = makeTask('completed');
    const requeueTask = vi.fn(async (): Promise<CentralTaskLaunchDecision> => ({
      kind: 'reused',
      task,
      active: undefined,
    }));
    const repository = {
      readTask: vi.fn(async () => task),
      requeueTask,
      state: { stateId: 'state-1' },
      globalConfigDirectory: '/global',
    } as unknown as CentralTaskRepository;
    const claim: WebTaskActionClaim = {
      reservationToken: 'reservation-instruct',
      context: {
        taskId: task.taskId,
        action: 'instruct',
        projectId: 'project-1',
        stateId: 'state-1',
        projectDirectory: '/project',
        task: task.task,
        workflow: task.workflow,
        status: 'completed',
        attempt: task.attempt,
        runIds: task.runIds,
        generation: task.generation,
        runId: task.runId,
        sourceRunId: task.runId,
        worktreePath: task.worktreePath,
      },
    };

    await executeCentralTaskAction({
      globalConfigDirectory: '/global',
      projectDirectory: '/project',
      projectId: 'project-1',
      repository,
      task,
      action: 'instruct',
      input: 'also update the documentation',
      conversationId: 'conversation-2',
      taskActionClaim: claim,
      spawnDecision: async () => ({ pid: 0, disposition: 'reused' as const, mode: 'run' as const }),
    });

    expect(requeueTask).toHaveBeenCalledWith(task.taskId, {
      task: 'also update the documentation',
      executionRequest: { resumeMode: 'instruct', sourceRunSlug: 'run-1' },
    });
  });

  it('reports the target task status when requeue starts another pending task first', async () => {
    const target = makeTask('failed');
    const otherPending = makeTask('pending');
    const requeueTask = vi.fn(async (): Promise<CentralTaskLaunchDecision> => ({
      kind: 'started',
      task: otherPending,
      ownerToken: 'owner-token',
      executionId: randomUUID(),
      runId: 'run-other',
    }));
    const targetAfterSpawn: CentralTaskRecord = { ...target, status: 'pending' };
    const readTask = vi.fn()
      .mockResolvedValueOnce(target)
      .mockResolvedValueOnce(targetAfterSpawn);
    const repository = {
      readTask,
      requeueTask,
      state: { stateId: 'state-1' },
      globalConfigDirectory: '/global',
    } as unknown as CentralTaskRepository;

    const result = await executeCentralTaskAction({
      globalConfigDirectory: '/global',
      projectDirectory: '/project',
      repository,
      task: target,
      action: 'requeue',
      spawnDecision: async () => ({ pid: 123, disposition: 'started' as const, mode: 'run' as const }),
    });

    expect(result).toMatchObject({
      action: 'requeue',
      taskId: target.taskId,
      taskStatus: 'pending',
    });
    expect(result.taskStatus).not.toBe('running');
    expect(requeueTask).toHaveBeenCalledWith(target.taskId);
  });
});
