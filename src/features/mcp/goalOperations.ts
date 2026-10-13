import { resolveTaskOrderContent } from '../tasks/orderRevision.js';
import { appendGoalWorkLog } from '../../infra/goals/workLog.js';
import { GoalStore } from '../../infra/goals/store.js';
import { ensureManagerRun } from '../manager/autoRun.js';
import { enqueueTask } from '../../infra/task/enqueueService.js';
import { saveEnqueuedTaskFile } from '../../infra/task/enqueuedTaskFile.js';
import { listWorkflows } from '../../infra/config/index.js';
import { GoalWorkflowNotAllowedError, validateGoalWorkflow } from './goalWorkflowValidation.js';
import { assertCwdAllowedByMcpRoot, errorResult, jsonResult, type McpOperationDependencies } from './operations.js';
import type { EnqueueGoalTaskInput, ListGoalsInput } from './schemas.js';
import { TaskRunner } from '../../infra/task/runner.js';
import { join } from 'node:path';
import { goalWrite } from './goalWrite.js';

export async function enqueueTaktGoalTask(input: EnqueueGoalTaskInput, deps: McpOperationDependencies, signal: AbortSignal) {
  let enqueued = false;
  try {
    return await goalWrite(input, deps, signal, async () => {
      const store = new GoalStore(input.cwd);
      const goal = await store.get(input.goalId);
      const runner = new TaskRunner(input.cwd);
      const existing = runner.listTaskStateItems().find((task) => {
        if (task.goalId !== goal.id) return false;
        if (input.workKey !== undefined) return task.goalWorkKey === input.workKey;
        if (task.goalPurpose !== input.purpose || task.workflow !== input.workflow) return false;
        const saved = runner.listAllTaskItems().find((item) => item.name === task.name);
        return saved !== undefined && resolveTaskOrderContent(input.cwd, saved.taskDir, saved.content) === input.task.trim();
      });
      if (existing !== undefined) return { taskName: existing.name, tasksFile: join(input.cwd, '.takt', 'tasks.yaml'), workflow: existing.workflow };
      if (goal.status !== 'created') throw new Error('Goal cannot accept work');
      validateGoalWorkflow(input.workflow, input.cwd);
      signal.throwIfAborted();
      const created = await enqueueTask({
        cwd: input.cwd, task: input.task, workflow: input.workflow,
        goalId: goal.id, goalPurpose: input.purpose,
        ...(input.workKey === undefined ? {} : { goalWorkKey: input.workKey }),
        worktree: true, autoPr: false, shouldPublishBranchToOrigin: false,
        taskContext: { baseBranch: goal.branch }, abortSignal: signal,
      }, deps.saveTaskFile ?? saveEnqueuedTaskFile);
      enqueued = true;
      await store.update(goal.id, (current) => appendGoalWorkLog(current, {
        summary: `Submitted ${created.taskName}: ${input.purpose}`,
      }));
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
