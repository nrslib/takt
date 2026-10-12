import { join } from 'node:path';
import { z } from 'zod/v4';
import { GoalStore } from '../../infra/goals/store.js';
import { assertGoalWorkReady } from '../../infra/goals/questions.js';
import { finishGoalOperation, saveGoalOperationRecovery, validateGoalOperation } from '../../infra/goals/operations.js';
import { GoalTaskRetryRecordSchema, recordGoalTaskRetry } from '../../infra/goals/taskRetry.js';
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

const retryRecoverySchema = z.object({
  result: z.object({ taskName: z.string().min(1), tasksFile: z.string(), status: z.literal('pending') }).strict(),
  record: GoalTaskRetryRecordSchema,
}).strict();

function resolveStart(context: FailedTaskRetryStartContext, startStep: string | undefined) {
  if (startStep === undefined) return resolveFailedTaskRetryStart(context, context.startOptions.defaultId);
  for (const option of context.startOptions.options) {
    if (!option.selectable) continue;
    const start = resolveFailedTaskRetryStart(context, option.id);
    if (start.restartPoint?.stack[0]?.step === startStep) return start;
  }
  throw new Error(`Unknown retry start step: ${startStep}`);
}

type PreparedRetry =
  | { kind: 'failed'; options: FailedTaskRetryPersistenceOptions }
  | { kind: 'exceeded'; options: RequeueExceededTaskOptions };

function prepareRetry(
  input: RequeueGoalTaskInput | RetryGoalTaskInput, kind: 'requeue' | 'retry',
  runner: TaskRunner, operationId: string | undefined,
): PreparedRetry {
  const task = (kind === 'requeue' ? runner.listAllTaskItems() : runner.listFailedTasks())
    .find((item) => item.name === input.taskName);
  if (task === undefined) throw new Error('Task is not available for retry');
  if (task.kind === 'exceeded' && kind === 'requeue') {
    if (!task.data?.start_step?.trim()) throw new Error('Exceeded task has no saved stopping position');
    const additional = (input as RequeueGoalTaskInput).retryNote;
    return { kind: 'exceeded', options: {
      ...(additional === undefined ? {} : { retryNote: appendRetryNote(task.data?.retry_note, additional) }),
      ...(operationId === undefined ? {} : { goalOperationId: operationId }),
    } };
  }
  const preparation = prepareFailedTaskRetry(task, input.cwd);
  if (preparation.previousWorkflow === undefined) throw new Error('Task has no previous workflow');
  const context = buildFailedTaskRetryStartContext(preparation, input.cwd, preparation.previousWorkflow);
  const start = resolveStart(context, kind === 'retry' ? (input as RetryGoalTaskInput).startStep : undefined);
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
    retryNote, workflow: context.workflowOverride,
    taskDir: kind === 'retry' ? task.taskDir : undefined, sourceRunSlug: preparation.matchedRunSlug,
    ...(operationId === undefined ? {} : { goalOperationId: operationId }),
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
    return await goalWrite(input, deps, signal, async (_policy, _mainMerge, operation) => {
      const store = new GoalStore(input.cwd);
      const goal = await store.get(input.goalId);
      const runner = new TaskRunner(input.cwd);
      const target = runner.listTaskStateItems().find((task) => task.name === input.taskName);
      const recovery = operation?.recovery === undefined ? undefined : retryRecoverySchema.parse(operation.recovery);
      const applied = operation !== undefined && recovery !== undefined
        && target?.goalOperationId === operation.id;
      const prepared = await validateGoalOperation(store, goal.id, operation, signal, async () => {
        if (goal.status !== 'created') throw new Error('Goal cannot accept work');
        if (target === undefined || target.goalId !== goal.id) throw new Error('Task does not belong to this goal');
        const unit = goal.workUnits?.find((item) => item.taskName === input.taskName);
        if (unit === undefined) throw new Error('Task has no work unit in this goal');
        if (!applied) assertGoalWorkReady(goal, unit.workKey);
        signal.throwIfAborted();
        if (applied) return undefined;
        if (target.status !== 'failed' && !(kind === 'requeue' && target.status === 'exceeded')) {
          throw new Error(`Task cannot ${kind} from status: ${target.status}`);
        }
        return prepareRetry(input, kind, runner, operation?.id);
      });
      const saved = recovery ?? {
        result: { taskName: input.taskName, tasksFile: join(input.cwd, '.takt', 'tasks.yaml'), status: 'pending' as const },
        record: {
          kind, recordedAt: operation?.recordedAt ?? new Date().toISOString(),
          ...(operation === undefined ? {} : { operationId: operation.id }),
        },
      };
      if (prepared !== undefined) {
        if (operation !== undefined) await saveGoalOperationRecovery(store, goal.id, operation, saved);
        signal.throwIfAborted();
        if (prepared.kind === 'exceeded') runner.requeueExceededTask(input.taskName, prepared.options);
        else await persistFailedTaskRetry(prepared.options);
      }
      queued = true;
      await store.update(goal.id, (current) => finishGoalOperation(
        recordGoalTaskRetry(current, input.taskName, saved.record), operation, saved.result,
      ));
      return saved.result;
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
