import { describe, expect, it } from 'vitest';
import {
  buildTaskActionDialogModel,
  buildTaskActionRequest,
  taskActionCanRestart,
  taskActionFinalizationState,
  taskActionGoState,
  taskActionButtonModel,
  taskActionNeedsConfirmation,
  taskActionSurfaceModel,
  taskActionSurfaceWithState,
  taskInstructionRoute,
} from '../../web-ui/public/task-action-ui.js';

describe('Web UI task action presentation helpers', () => {
  it('keeps action buttons bound to the task id and translated label key', () => {
    expect(taskActionButtonModel({ taskId: 'task-1' }, 'delete')).toEqual({
      taskId: 'task-1',
      action: 'delete',
      labelKey: 'task.action.delete',
    });
  });

  it('requires confirmation only for destructive or root-mutating actions', () => {
    expect(['delete', 'force_fail', 'try', 'merge'].every(taskActionNeedsConfirmation)).toBe(true);
    expect(taskActionNeedsConfirmation('requeue')).toBe(false);
    expect(taskActionNeedsConfirmation('diff')).toBe(false);
  });

  it('builds the authenticated action payload without dropping optional input', () => {
    expect(buildTaskActionRequest('project-1', 'task/1', 'requeue', 'next instruction')).toEqual({
      path: '/api/tasks/task%2F1/actions/requeue',
      body: { projectId: 'project-1', input: 'next instruction' },
    });
    expect(buildTaskActionRequest('project-1', 'task-1', 'delete', undefined)).toEqual({
      path: '/api/tasks/task-1/actions/delete',
      body: { projectId: 'project-1' },
    });
    expect(buildTaskActionRequest(
      'project-1',
      'task-1',
      'retry',
      'retry note',
      'conversation-1',
      'resume:plan',
    )).toEqual({
      path: '/api/tasks/task-1/actions/retry',
      body: {
        projectId: 'project-1',
        input: 'retry note',
        conversationId: 'conversation-1',
        taskActionOptionId: 'resume:plan',
      },
    });
  });

  it('keeps retry checkpoint data server-owned while exposing only the option id', () => {
    const surface = taskActionSurfaceModel({
      workflow: 'default',
      mode: 'assistant',
      id: 'conversation-1',
      intro: '',
      provider: 'mock',
      taskAction: {
        sessionId: 'conversation-1',
        taskId: 'task-1',
        action: 'retry',
        generation: 4,
        retryStartOptions: {
          defaultId: 'resume:plan',
          options: [
            { id: 'resume:plan', label: 'plan', selectable: true },
            { id: 'restart:plan', label: 'restart', selectable: true },
            { id: 'internal', label: 'hidden', selectable: false },
          ],
        },
      },
    }, {
      taskId: 'task-1',
      status: 'failed',
      workflow: 'default',
      branch: 'takt/task-1',
      runs: [{ slug: 'run-4' }],
    });
    expect(surface).toMatchObject({
      taskId: 'task-1',
      action: 'retry',
      generation: 4,
      selectedOptionId: 'resume:plan',
      canFinalizeRetry: true,
      finalizationState: 'active' as const,
      snapshot: {
        taskId: 'task-1',
        status: 'failed',
        latestRun: 'run-4',
        branch: 'takt/task-1',
        workflow: 'default',
      },
    });
    expect(surface?.retryStartOptions).toEqual([
      { id: 'resume:plan', label: 'plan', selectable: true },
      { id: 'restart:plan', label: 'restart', selectable: true },
    ]);
    expect(surface?.retryStartOptions[0]).not.toHaveProperty('selection');
  });

  it('blocks task-action submission while finalizing or after acceptance', () => {
    const unavailable = {
      action: 'retry',
      canFinalizeRetry: false,
      selectedOptionId: undefined,
      finalizationState: 'active' as const,
    };
    expect(taskActionGoState(unavailable, '相談を確定 /go')).toEqual({
      goCommand: true,
      canSubmit: false,
      reasonKey: 'app.retryOptionRequired',
    });
    expect(taskActionGoState(unavailable, '続けて確認')).toEqual({
      goCommand: false,
      canSubmit: true,
    });
    expect(taskActionGoState({
      action: 'retry',
      canFinalizeRetry: true,
      selectedOptionId: 'resume:plan',
      finalizationState: 'active',
    }, '/go')).toEqual({
      goCommand: true,
      canSubmit: true,
      taskActionOptionId: 'resume:plan',
    });
    expect(taskActionGoState({
      action: 'instruct',
      canFinalizeRetry: true,
      finalizationState: 'accepted',
    }, '/go')).toEqual({
      goCommand: true,
      canSubmit: false,
      reasonKey: 'app.taskActionAccepted',
    });
    expect(taskActionGoState({
      action: 'instruct',
      canFinalizeRetry: true,
      finalizationState: 'accepted',
    }, '追加の相談')).toEqual({
      goCommand: false,
      canSubmit: false,
      reasonKey: 'app.taskActionAccepted',
    });
    expect(taskActionGoState({
      action: 'instruct',
      canFinalizeRetry: true,
      finalizationState: 'finalizing',
    }, '/go')).toEqual({
      goCommand: true,
      canSubmit: false,
      reasonKey: 'app.taskActionFinalizing',
    });
    expect(taskActionGoState({
      action: 'instruct',
      canFinalizeRetry: true,
      finalizationState: 'finalizing',
    }, '追加の相談')).toEqual({
      goCommand: false,
      canSubmit: false,
      reasonKey: 'app.taskActionFinalizing',
    });
  });

  it('allows a task-action conversation to restart only while active or failed', () => {
    const surface = { action: 'instruct', finalizationState: 'active' as const };
    expect(taskActionCanRestart(surface)).toBe(true);
    expect(taskActionCanRestart(taskActionSurfaceWithState(surface, 'failed'))).toBe(true);
    expect(taskActionCanRestart(taskActionSurfaceWithState(surface, 'finalizing'))).toBe(false);
    expect(taskActionCanRestart(taskActionSurfaceWithState(surface, 'accepted'))).toBe(false);
    expect(taskActionFinalizationState(taskActionSurfaceWithState(surface, 'failed'))).toBe('failed');
  });

  it('keeps normal task instructions on the new-task path and task actions on their action path', () => {
    const normalReply = { kind: 'task_instruction', task: 'new task' };
    expect(taskInstructionRoute({}, normalReply)).toEqual({
      kind: 'new-task',
      task: 'new task',
    });

    const actionReference = {
      sessionId: 'conversation-1',
      taskId: 'task-1',
      action: 'retry',
    };
    expect(taskInstructionRoute({ taskAction: actionReference }, {
      kind: 'task_instruction',
      task: 'revised task',
      taskAction: actionReference,
      taskActionOptionId: 'resume:plan',
    })).toEqual({
      kind: 'task-action',
      task: 'revised task',
      taskAction: actionReference,
      taskActionOptionId: 'resume:plan',
    });
    expect(taskInstructionRoute({}, {
      kind: 'task_instruction',
      task: 'unexpected action',
      taskAction: actionReference,
    })).toEqual({ kind: 'invalid' });
  });

  it('normalizes diff, PR link, status, and unique dialog title ids', () => {
    const first = buildTaskActionDialogModel({
      action: 'diff',
      status: 'completed',
      diff: 'diff text',
    }, 1);
    const second = buildTaskActionDialogModel({
      action: 'create_pr',
      status: 'completed',
      taskStatus: 'completed',
      prUrl: 'https://example.invalid/pull/1',
    }, 2);
    expect(first).toMatchObject({
      titleId: 'task-action-dialog-title-1',
      titleKey: 'task.action.diff',
      statusKey: 'task.actionCompleted',
      diff: 'diff text',
    });
    expect(second).toMatchObject({
      titleId: 'task-action-dialog-title-2',
      taskStatusKey: 'app.status.completed',
      prUrl: 'https://example.invalid/pull/1',
    });
    expect(first.titleId).not.toBe(second.titleId);
  });
});
