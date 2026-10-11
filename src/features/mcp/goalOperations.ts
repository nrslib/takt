import { safeExternalErrorMessage } from '../../shared/utils/safeExternalErrorMessage.js';
import { GoalStore } from '../../infra/goals/store.js';
import { reconcileGoalTasks } from '../../infra/goals/reconcile.js';
import { assertGoalWorkReady } from '../../infra/goals/questions.js';
import { ensureManagerRun } from '../manager/autoRun.js';
import { enqueueTask } from '../../infra/task/enqueueService.js';
import { saveEnqueuedTaskFile } from '../../infra/task/enqueuedTaskFile.js';
import { listWorkflows } from '../../infra/config/index.js';
import { GoalWorkflowNotAllowedError, validateGoalWorkflow } from './goalWorkflowValidation.js';
import { assertCwdAllowedByMcpRoot, errorResult, jsonResult, type McpOperationDependencies } from './operations.js';
import type { EnqueueGoalTaskInput, ListGoalsInput } from './schemas.js';
import { TaskRunner } from '../../infra/task/runner.js';
import { join } from 'node:path';
import { beginGoalOperation, finishGoalOperation, validateGoalOperation } from '../../infra/goals/operations.js';
import { goalWrite } from './goalWrite.js';

export async function enqueueTaktGoalTask(input: EnqueueGoalTaskInput, deps: McpOperationDependencies, signal: AbortSignal) {
  let enqueued = false;
  try {
    return await goalWrite(input, deps, signal, async (_policy, _mainMerge, operation) => {
      const store = new GoalStore(input.cwd);
      const queued = operation === undefined ? undefined : new TaskRunner(input.cwd).listTaskStateItems()
        .find((task) => task.goalId === input.goalId && task.goalOperationId === operation.id);
      if (operation === undefined) await reconcileGoalTasks(input.cwd, input.goalId);
      const goal = await store.get(input.goalId);
      if (queued === undefined) {
        await validateGoalOperation(store, goal.id, operation, signal, async () => {
          if (goal.status !== 'created') throw new Error('Goal cannot accept work');
          assertGoalWorkReady(goal, input.workKey);
          validateGoalWorkflow(input.workflow, input.cwd);
          signal.throwIfAborted();
        });
        if (operation !== undefined) await beginGoalOperation(store, goal.id, operation);
      }
      const created = queued === undefined ? await enqueueTask({
        cwd: input.cwd, task: input.task, workflow: input.workflow,
        goalId: goal.id, goalPurpose: input.purpose,
        ...(operation === undefined ? {} : { goalOperationId: operation.id }),
        ...(input.workKey === undefined ? {} : { goalWorkKey: input.workKey }),
        worktree: true, autoPr: false, shouldPublishBranchToOrigin: false,
        taskContext: { baseBranch: goal.branch }, abortSignal: signal,
      }, deps.saveTaskFile ?? saveEnqueuedTaskFile) : { taskName: queued.name, tasksFile: join(input.cwd, '.takt', 'tasks.yaml'), workflow: input.workflow };
      enqueued = true;
      try {
        await store.update(goal.id, (current) => finishGoalOperation({
          ...current, workUnits: [...(current.workUnits ?? []), {
            taskName: created.taskName, purpose: input.purpose,
            ...(input.workKey === undefined ? {} : { workKey: input.workKey }),
          }].filter((unit, index, units) => units.findIndex((saved) => saved.taskName === unit.taskName) === index),
        }, operation, created));
      } catch (error) {
        // The queue owns the saved task; reconciliation can restore its work unit.
        if (operation !== undefined) throw error;
        return {
          ...created, taskEnqueued: true, workUnitRecorded: false,
          workUnitRecordError: safeExternalErrorMessage(error),
        };
      }
      return created;
    }, 'Goal task enqueue failed', 'enqueue');
  } finally { if (enqueued) await ensureManagerRun(input.cwd); }
}

export function listTaktWorkflows(input: ListGoalsInput, deps: McpOperationDependencies) {
  try {
    assertCwdAllowedByMcpRoot(input.cwd, deps.allowedProjectRoot);
    return jsonResult({ workflows: listWorkflows(input.cwd).flatMap((name) => {
      try {
        const workflow = validateGoalWorkflow(name, input.cwd);
        return [{ name, description: workflow.description }];
      } catch (error) {
        if (error instanceof GoalWorkflowNotAllowedError) return [];
        throw error;
      }
    }) });
  } catch (error) { return errorResult('Workflow list failed', error); }
}
