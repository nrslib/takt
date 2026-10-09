import { safeExternalErrorMessage } from '../../shared/utils/safeExternalErrorMessage.js';
import { GoalStore } from '../../infra/goals/store.js';
import { withGoalTurns } from '../../infra/goals/turn-lock.js';
import { reconcileGoalTasks } from '../../infra/goals/reconcile.js';
import { assertGoalWorkReady } from '../../infra/goals/questions.js';
import { ensureManagerRun } from '../manager/autoRun.js';
import { enqueueTask } from '../../infra/task/enqueueService.js';
import { saveEnqueuedTaskFile } from '../../infra/task/enqueuedTaskFile.js';
import { listWorkflows } from '../../infra/config/index.js';
import { GoalWorkflowNotAllowedError, validateGoalWorkflow } from './goalWorkflowValidation.js';
import { assertCwdAllowedByMcpRoot, errorResult, jsonResult, type McpOperationDependencies } from './operations.js';
import type { EnqueueGoalTaskInput, ListGoalsInput } from './schemas.js';

export async function enqueueTaktGoalTask(input: EnqueueGoalTaskInput, deps: McpOperationDependencies, signal: AbortSignal) {
  let enqueued = false;
  try {
    assertCwdAllowedByMcpRoot(input.cwd, deps.allowedProjectRoot);
    const store = new GoalStore(input.cwd);
    await store.get(input.goalId);
    return await withGoalTurns(input.cwd, [input.goalId], async () => {
      await reconcileGoalTasks(input.cwd, input.goalId);
      const goal = await store.get(input.goalId);
      if (goal.status !== 'created') throw new Error('Goal cannot accept work');
      assertGoalWorkReady(goal, input.workKey);
      validateGoalWorkflow(input.workflow, input.cwd);
      const created = await enqueueTask({
        cwd: input.cwd, task: input.task, workflow: input.workflow,
        goalId: goal.id, goalPurpose: input.purpose,
        ...(input.workKey === undefined ? {} : { goalWorkKey: input.workKey }),
        worktree: true, autoPr: false, shouldPublishBranchToOrigin: false,
        taskContext: { baseBranch: goal.branch }, abortSignal: signal,
      }, deps.saveTaskFile ?? saveEnqueuedTaskFile);
      enqueued = true;
      try {
        await store.update(goal.id, (current) => ({
          ...current, workUnits: [...(current.workUnits ?? []), {
            taskName: created.taskName, purpose: input.purpose,
            ...(input.workKey === undefined ? {} : { workKey: input.workKey }),
          }],
        }));
      } catch (error) {
        // The queue owns the saved task; reconciliation can restore its work unit.
        return jsonResult({
          ...created, taskEnqueued: true, workUnitRecorded: false,
          workUnitRecordError: safeExternalErrorMessage(error),
        });
      }
      return jsonResult(created);
    }, deps.goalTurnOwners, signal);
  } catch (error) { return errorResult('Goal task enqueue failed', error); }
  finally { if (enqueued) await ensureManagerRun(input.cwd); }
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
