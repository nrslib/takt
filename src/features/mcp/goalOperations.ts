import { GoalStore } from '../../infra/goals/store.js';
import { getRegisteredGoal } from '../../infra/goals/registration.js';
import { withGoalTurns } from '../../infra/goals/turn-lock.js';
import { reconcileGoalTasks } from '../../infra/goals/reconcile.js';
import { verifiedGoalCompletionContext } from '../../infra/goals/completion-evidence.js';
import { enqueueTask } from '../../infra/task/enqueueService.js';
import { saveEnqueuedTaskFile } from '../../infra/task/enqueuedTaskFile.js';
import { listWorkflows, loadWorkflowByIdentifier } from '../../infra/config/index.js';
import { validateGoalWorkflow } from './goalWorkflowValidation.js';
import { assertCwdAllowedByMcpRoot, errorResult, jsonResult, type McpOperationDependencies } from './operations.js';
import type { EnqueueGoalTaskInput, ListGoalsInput, RecordGoalDecisionInput } from './schemas.js';

export async function enqueueTaktGoalTask(input: EnqueueGoalTaskInput, deps: McpOperationDependencies, signal: AbortSignal) {
  try {
    assertCwdAllowedByMcpRoot(input.cwd, deps.allowedProjectRoot);
    const store = new GoalStore(input.cwd);
    await getRegisteredGoal(input.cwd, input.goalId);
    return await withGoalTurns(input.cwd, [input.goalId], async () => {
      await getRegisteredGoal(input.cwd, input.goalId);
      await reconcileGoalTasks(input.cwd, input.goalId);
      const goal = await getRegisteredGoal(input.cwd, input.goalId);
      if (goal.status !== 'created') throw new Error('Goal cannot accept work');
      validateGoalWorkflow(input.workflow, input.cwd);
      const created = await enqueueTask({
        cwd: input.cwd, task: input.task, workflow: input.workflow,
        goalId: goal.id, goalPurpose: input.purpose,
        worktree: true, autoPr: false, shouldPublishBranchToOrigin: false,
        taskContext: { baseBranch: goal.branch }, abortSignal: signal,
      }, deps.saveTaskFile ?? saveEnqueuedTaskFile);
      await store.update(goal.id, (current) => ({
        ...current, workUnits: [...(current.workUnits ?? []), { taskName: created.taskName, purpose: input.purpose }],
      }));
      return jsonResult(created);
    }, deps.goalTurnOwners, signal);
  } catch (error) { return errorResult('Goal task enqueue failed', error); }
}

export async function recordTaktGoalDecision(input: RecordGoalDecisionInput, deps: McpOperationDependencies) {
  try {
    assertCwdAllowedByMcpRoot(input.cwd, deps.allowedProjectRoot);
    const store = new GoalStore(input.cwd);
    await getRegisteredGoal(input.cwd, input.goalId);
    return await withGoalTurns(input.cwd, [input.goalId], async () => {
      await getRegisteredGoal(input.cwd, input.goalId);
      const goal = await store.update(input.goalId, (current) => ({
        ...current, decisions: [...(current.decisions ?? []), {
          decision: input.decision, reason: input.reason, recordedAt: new Date().toISOString(),
        }],
      }));
      return jsonResult({ goal: deps.registeredGoalsOnly ? verifiedGoalCompletionContext(input.cwd, goal) : goal });
    }, deps.goalTurnOwners);
  } catch (error) { return errorResult('Goal decision failed', error); }
}

export function listTaktWorkflows(input: ListGoalsInput, deps: McpOperationDependencies) {
  try {
    assertCwdAllowedByMcpRoot(input.cwd, deps.allowedProjectRoot);
    return jsonResult({ workflows: listWorkflows(input.cwd).map((name) => {
      const workflow = loadWorkflowByIdentifier(name, input.cwd);
      if (workflow === null) throw new Error(`Workflow not found: ${name}`);
      return { name, description: workflow.description };
    }) });
  } catch (error) { return errorResult('Workflow list failed', error); }
}
