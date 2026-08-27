const CONFIRMATION_ACTIONS = new Set(['delete', 'force_fail', 'try', 'merge']);
const TASK_ACTION_FINALIZATION_STATES = new Set(['active', 'finalizing', 'accepted', 'failed']);

export function taskActionButtonModel(task, action) {
  return {
    taskId: task.taskId,
    action,
    labelKey: `task.action.${action}`,
  };
}

export function taskActionNeedsConfirmation(action) {
  return CONFIRMATION_ACTIONS.has(action);
}

function selectableRetryOptions(reference) {
  const options = reference?.retryStartOptions?.options;
  if (!Array.isArray(options)) return [];
  return options.filter((option) => option !== null
    && typeof option === 'object'
    && option.selectable !== false
    && typeof option.id === 'string'
    && option.id.length > 0);
}

export function taskActionSurfaceModel(session, task) {
  const reference = session?.taskAction;
  if (reference === undefined || reference === null) return null;
  const options = selectableRetryOptions(reference);
  const defaultId = reference.retryStartOptions?.defaultId;
  const selectedOptionId = reference.action === 'retry'
    && typeof defaultId === 'string'
    && options.some((option) => option.id === defaultId)
    ? defaultId
    : undefined;
  const latestRun = Array.isArray(task?.runs) && task.runs.length > 0
    ? task.runs[task.runs.length - 1]
    : undefined;
  return {
    taskId: reference.taskId,
    action: reference.action,
    generation: reference.generation,
    retryStartOptions: reference.action === 'retry' ? options : [],
    selectedOptionId,
    canFinalizeRetry: reference.action !== 'retry' || selectedOptionId !== undefined,
    finalizationState: 'active',
    snapshot: {
      taskId: reference.taskId,
      ...(typeof task?.status === 'string' ? { status: task.status } : {}),
      ...(typeof latestRun?.slug === 'string' ? { latestRun: latestRun.slug } : {}),
      ...(typeof task?.branch === 'string' ? { branch: task.branch } : {}),
      ...(typeof task?.workflow === 'string' ? { workflow: task.workflow } : {}),
    },
  };
}

export function taskActionFinalizationState(surface) {
  if (surface === null || surface === undefined) return null;
  const state = surface.finalizationState;
  if (TASK_ACTION_FINALIZATION_STATES.has(state)) return state;
  throw new Error('Task action surface has an invalid finalization state');
}

export function taskActionSurfaceWithState(surface, finalizationState) {
  if (surface === null || surface === undefined) return null;
  if (!TASK_ACTION_FINALIZATION_STATES.has(finalizationState)) {
    throw new Error('Task action surface state is invalid');
  }
  return { ...surface, finalizationState };
}

export function taskActionCanRestart(surface) {
  const state = taskActionFinalizationState(surface);
  return state === 'active' || state === 'failed';
}

export function taskActionGoState(surface, text) {
  const goCommand = /(?:^|\s)\/go(?:\s|$)/u.test(text.trim());
  const state = taskActionFinalizationState(surface);
  if (!goCommand) {
    if (state === 'accepted') {
      return { goCommand: false, canSubmit: false, reasonKey: 'app.taskActionAccepted' };
    }
    if (state === 'finalizing') {
      return { goCommand: false, canSubmit: false, reasonKey: 'app.taskActionFinalizing' };
    }
    return { goCommand: false, canSubmit: true };
  }
  if (state === 'accepted') {
    return { goCommand: true, canSubmit: false, reasonKey: 'app.taskActionAccepted' };
  }
  if (state === 'finalizing') {
    return { goCommand: true, canSubmit: false, reasonKey: 'app.taskActionFinalizing' };
  }
  if (surface === null || surface === undefined) {
    return { goCommand: true, canSubmit: false, reasonKey: 'app.taskActionFinalized' };
  }
  if (surface.action === 'retry' && surface.canFinalizeRetry !== true) {
    return { goCommand: true, canSubmit: false, reasonKey: 'app.retryOptionRequired' };
  }
  return {
    goCommand: true,
    canSubmit: true,
    ...(surface.selectedOptionId === undefined
      ? {}
      : { taskActionOptionId: surface.selectedOptionId }),
  };
}

export function taskInstructionRoute(session, reply) {
  if (reply?.kind !== 'task_instruction') return null;
  if (session?.taskAction === undefined) {
    return reply.taskAction === undefined
      ? { kind: 'new-task', task: reply.task }
      : { kind: 'invalid' };
  }
  if (reply.taskAction === undefined) return { kind: 'invalid' };
  return {
    kind: 'task-action',
    task: reply.task,
    taskAction: reply.taskAction,
    ...(reply.taskActionOptionId === undefined
      ? {}
      : { taskActionOptionId: reply.taskActionOptionId }),
  };
}

export function buildTaskActionRequest(
  projectId,
  taskId,
  action,
  input,
  conversationId,
  taskActionOptionId,
) {
  return {
    path: `/api/tasks/${encodeURIComponent(taskId)}/actions/${encodeURIComponent(action)}`,
    body: {
      projectId,
      ...(input === undefined ? {} : { input }),
      ...(conversationId === undefined ? {} : { conversationId }),
      ...(taskActionOptionId === undefined ? {} : { taskActionOptionId }),
    },
  };
}

export function buildTaskActionDialogModel(result, sequence) {
  const titleId = `task-action-dialog-title-${sequence}`;
  return {
    titleId,
    titleKey: `task.action.${result.action}`,
    statusKey: result.status === 'accepted' ? 'task.actionAccepted' : 'task.actionCompleted',
    taskStatusKey: typeof result.taskStatus === 'string'
      ? `app.status.${result.taskStatus}`
      : undefined,
    diff: typeof result.diff === 'string' ? result.diff : undefined,
    prUrl: typeof result.prUrl === 'string' && result.prUrl.length > 0
      ? result.prUrl
      : undefined,
  };
}
