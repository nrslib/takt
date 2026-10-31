import { appendGoalWorkLog } from '../../infra/goals/workLog.js';
import { join } from 'node:path';
import { GoalStore } from '../../infra/goals/store.js';
import { TaskRunner } from '../../infra/task/runner.js';
import type { RequeueExceededTaskOptions } from '../../infra/task/taskExceedService.js';
import { buildAutoRequeueNote } from '../../infra/task/retryNote.js';
import { resolveConfigValue } from '../../infra/config/index.js';
import {
  buildFailedTaskRetryStartContext, prepareFailedTaskRetry, resolveFailedTaskRetryStart,
  type FailedTaskRetryStartContext,
} from '../tasks/taskRetryPreparation.js';
import {
  appendRetryNote, persistFailedTaskRetry, type FailedTaskRetryPersistenceOptions,
} from '../tasks/taskRetryPersistence.js';
import { ensureManagerRun } from '../manager/autoRun.js';
import { goalWrite } from './goalWrite.js';
import type { McpOperationDependencies } from './operations.js';
import type { RequeueGoalTaskInput, RetryGoalTaskInput } from './goalTaskRetrySchemas.js';

const START_PATH_SEPARATOR = '/';

function listStartCandidates(context: FailedTaskRetryStartContext) {
  return context.startOptions.options.filter((option) => option.selectable).flatMap((option) => {
    const start = resolveFailedTaskRetryStart(context, option.id);
    const stack = start.restartPoint?.stack;
    if (stack === undefined) return [];
    return [{ path: stack.map((entry) => entry.step).join(START_PATH_SEPARATOR), rootStep: stack[0]?.step, start }];
  });
}

function formatStartCandidates(candidates: ReturnType<typeof listStartCandidates>): string {
  return `Available startStep values: ${JSON.stringify(candidates.map((candidate) => candidate.path))}`;
}

function resolveStart(context: FailedTaskRetryStartContext, startStep: string | undefined) {
  if (startStep === undefined) {
    const reason = context.startOptions.resumeFailureReason;
    if (reason === undefined) return resolveFailedTaskRetryStart(context, context.startOptions.defaultId);
    throw new Error(`Saved resume position cannot be used: ${reason}. Specify startStep to choose where to restart. `
      + formatStartCandidates(listStartCandidates(context)));
  }
  const candidates = listStartCandidates(context);
  const matched = candidates.find((candidate) => candidate.path === startStep)
    ?? candidates.find((candidate) => candidate.rootStep === startStep);
  if (matched !== undefined) return matched.start;
  throw new Error(`Unknown retry start step: ${startStep}. ${formatStartCandidates(candidates)}`);
}

type PreparedRetry =
  | { kind: 'failed'; options: FailedTaskRetryPersistenceOptions }
  | { kind: 'exceeded'; options: RequeueExceededTaskOptions };

function prepareRetry(
  input: RequeueGoalTaskInput | RetryGoalTaskInput, kind: 'requeue' | 'retry',
  runner: TaskRunner,
): PreparedRetry {
  const task = (kind === 'requeue' ? runner.listAllTaskItems() : runner.listFailedTasks())
    .find((item) => item.name === input.taskName);
  if (task === undefined) throw new Error('Task is not available for retry');
  if (task.kind === 'exceeded' && kind === 'requeue') {
    if (!task.data?.start_step?.trim()) throw new Error('Exceeded task has no saved stopping position');
    if (input.startStep !== undefined) throw new Error('Exceeded task resumes from its saved stopping position; startStep is not supported');
    const additional = (input as RequeueGoalTaskInput).retryNote;
    return { kind: 'exceeded', options: {
      ...(additional === undefined ? {} : { retryNote: appendRetryNote(task.data?.retry_note, additional) }),
    } };
  }
  const preparation = prepareFailedTaskRetry(task, input.cwd);
  if (preparation.previousWorkflow === undefined) throw new Error('Task has no previous workflow');
  const context = buildFailedTaskRetryStartContext(preparation, input.cwd, preparation.previousWorkflow);
  const start = resolveStart(context, input.startStep);
  let retryNote: string | undefined;
  if (kind === 'requeue') {
    retryNote = appendRetryNote(task.data?.retry_note, buildAutoRequeueNote({
      ...preparation.failure, step: preparation.failedStep,
    }));
    const additional = (input as RequeueGoalTaskInput).retryNote;
    if (additional !== undefined) retryNote = appendRetryNote(retryNote, additional);
  }
  return { kind: 'failed', options: {
    task, projectDir: input.cwd, worktreePath: preparation.worktreePath,
    startStep: start.startStep, resumePoint: start.resumePoint, restartPoint: start.restartPoint,
    sourceResumePoint: start.sourceResumePoint,
    retryNote, workflow: context.workflowOverride,
    taskDir: kind === 'retry' ? task.taskDir : undefined, sourceRunSlug: preparation.matchedRunSlug,
    ...(kind === 'retry' ? { revisedOrder: {
      content: (input as RetryGoalTaskInput).task, lang: resolveConfigValue(input.cwd, 'language'),
    } } : {}),
  } };
}

async function retryGoalTask(
  input: RequeueGoalTaskInput | RetryGoalTaskInput, kind: 'requeue' | 'retry',
  deps: McpOperationDependencies, signal: AbortSignal,
) {
  let queued = false;
  try {
    return await goalWrite(input, deps, signal, async () => {
      const store = new GoalStore(input.cwd);
      const goal = await store.get(input.goalId);
      const runner = new TaskRunner(input.cwd);
      const target = runner.listTaskStateItems().find((task) => task.name === input.taskName);
      if (target === undefined || target.goalId !== goal.id) throw new Error('Task does not belong to this goal');
      const result = { taskName: input.taskName, tasksFile: join(input.cwd, '.takt', 'tasks.yaml'), status: target.status };
      if (target.status === 'pending' || target.status === 'running' || target.status === 'completed') return result;
      if (goal.status !== 'created') throw new Error('Goal cannot accept work');
      if (target.status !== 'failed' && !(kind === 'requeue' && target.status === 'exceeded')) {
        throw new Error(`Task cannot ${kind} from status: ${target.status}`);
      }
      const prepared = prepareRetry(input, kind, runner);
      signal.throwIfAborted();
      if (prepared.kind === 'exceeded') runner.requeueExceededTask(input.taskName, prepared.options);
      else await persistFailedTaskRetry(prepared.options);
      queued = true;
      await store.update(goal.id, (current) => appendGoalWorkLog(current, {
        summary: `${kind === 'retry' ? 'Retried with corrected instructions' : 'Requeued'} ${input.taskName}`,
      }));
      return { ...result, status: 'pending' };
    }, `Goal task ${kind} failed`, kind);
  } finally {
    if (queued) await ensureManagerRun(input.cwd);
  }
}

export function requeueTaktGoalTask(
  input: RequeueGoalTaskInput, deps: McpOperationDependencies, signal: AbortSignal,
) {
  return retryGoalTask(input, 'requeue', deps, signal);
}

export function retryTaktGoalTask(
  input: RetryGoalTaskInput, deps: McpOperationDependencies, signal: AbortSignal,
) {
  return retryGoalTask(input, 'retry', deps, signal);
}
