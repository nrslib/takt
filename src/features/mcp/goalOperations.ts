import { resolveTaskOrderContent } from '../tasks/orderRevision.js';
import { appendGoalWorkLog } from '../../infra/goals/workLog.js';
import { GoalStore } from '../../infra/goals/store.js';
import { createGoal } from '../../infra/goals/service.js';
import { getGlobalConfigDir } from '../../infra/config/paths.js';
import { conversationId } from '../../infra/conversations/identity.js';
import { withManagerLifecycleLock } from '../../infra/conversations/managerLifecycleLock.js';
import type { GoalCreateInput } from '../../infra/goals/schema.js';
import { ensureManagerRun } from '../manager/autoRun.js';
import { enqueueTask } from '../../infra/task/enqueueService.js';
import { saveEnqueuedTaskFile } from '../../infra/task/enqueuedTaskFile.js';
import { resolveGitRepositoryDirectory } from '../../infra/task/repositoryDirectory.js';
import { listWorkflows, loadWorkflowByIdentifier } from '../../infra/config/index.js';
import { assertCwdAllowedByMcpRoot, errorResult, jsonResult, type McpOperationDependencies } from './operations.js';
import type { EnqueueGoalTaskInput, ListGoalsInput } from './schemas.js';
import { TaskRunner } from '../../infra/task/runner.js';
import { join } from 'node:path';
import { mkdir, realpath } from 'node:fs/promises';
import { goalWrite } from './goalWrite.js';
import { goalWriteSummary } from './goalResponse.js';
import { pagedResult } from './response.js';
import { readManagerImageTask, withManagerImageTask } from '../tasks/managerImageAttachments.js';
import type { SaveEnqueuedTaskFile } from '../../infra/task/enqueueService.js';

export async function enqueueTaktGoalTask(input: EnqueueGoalTaskInput, deps: McpOperationDependencies, signal: AbortSignal) {
  let enqueued = false;
  try {
    return await goalWrite(input, deps, signal, async () => {
      const execute = async (taskContent: string, saveTaskFile: SaveEnqueuedTaskFile, selectedImagePaths: readonly string[]) => {
        const store = new GoalStore(input.cwd);
        const goal = await store.get(input.goalId);
        const runner = new TaskRunner(input.cwd);
        const allTasks = input.workKey === undefined ? runner.listAllTaskItems() : [];
        const existing = runner.listTaskStateItems().find((task) => {
          if (task.goalId !== goal.id) return false;
          if (input.workKey !== undefined) return task.goalWorkKey === input.workKey;
          if (task.goalPurpose !== input.purpose || task.workflow !== input.workflow) return false;
          const saved = allTasks.find((item) => item.name === task.name);
          if (saved === undefined || resolveTaskOrderContent(input.cwd, saved.taskDir, saved.content) !== taskContent.trim()) return false;
          const savedImages = saved.taskDir === undefined ? undefined : readManagerImageTask(join(input.cwd, saved.taskDir));
          const savedPaths = new Set(savedImages?.images.map((image) => image.path) ?? []);
          return savedPaths.size === selectedImagePaths.length && selectedImagePaths.every((path) => savedPaths.has(path));
        });
        if (input.runtimeAssignment !== undefined && deps.managerRuntimeAssignments !== undefined
          && !deps.managerRuntimeAssignments.some(({ name }) => name === input.runtimeAssignment)) {
          throw new Error(`Runtime assignment "${input.runtimeAssignment}" is not allowed for manager tasks. Allowed runtime assignments: ${deps.managerRuntimeAssignments.map(({ name }) => name).join(', ') || '(none)'}. Configure manager.runtime_assignments in project .takt/config.yaml or global .takt/config.yaml under your home directory (or config.yaml in TAKT_CONFIG_DIR).`);
        }
        if (existing !== undefined) return { taskName: existing.name, tasksFile: join(input.cwd, '.takt', 'tasks.yaml'), workflow: existing.workflow, ...(existing.runtimeAssignment === undefined ? {} : { runtimeAssignment: existing.runtimeAssignment }) };
        if (goal.status !== 'created') throw new Error('Goal cannot accept work');
        if (deps.managerWorkflows !== undefined && !deps.managerWorkflows.some(({ name }) => name === input.workflow)) {
          throw new Error(`Workflow "${input.workflow}" is not allowed for manager tasks. Allowed workflows: ${deps.managerWorkflows.map(({ name }) => name).join(', ') || '(none)'}. Configure manager.workflows in project .takt/config.yaml or global .takt/config.yaml under your home directory (or config.yaml in TAKT_CONFIG_DIR).`);
        }
        if (loadWorkflowByIdentifier(input.workflow, input.cwd) === null) throw new Error(`Workflow not found: ${input.workflow}`);
        signal.throwIfAborted();
        const created = await enqueueTask({
          cwd: input.cwd, task: taskContent, workflow: input.workflow,
          ...(input.runtimeAssignment === undefined ? {} : { runtimeAssignment: input.runtimeAssignment }),
          goalId: goal.id, goalPurpose: input.purpose,
          ...(input.workKey === undefined ? {} : { goalWorkKey: input.workKey }),
          worktree: true, autoPr: input.autoPr ?? false, shouldPublishBranchToOrigin: input.shouldPublishBranchToOrigin ?? false,
          taskContext: { baseBranch: goal.branch }, abortSignal: signal,
        }, saveTaskFile);
        enqueued = true;
        await store.update(goal.id, (current) => appendGoalWorkLog(current, {
          summary: `Submitted ${created.taskName}: ${input.purpose}`,
        }));
        return created;
      };
      const saveTaskFile = deps.saveTaskFile ?? saveEnqueuedTaskFile;
      return deps.managerImageSource === undefined ? execute(input.task, saveTaskFile, [])
        : withManagerImageTask({ imageRoot: deps.managerImageSource.root, conversationId: deps.managerImageSource.conversationId,
          repositoryDirectory: input.cwd, task: input.task, saveTaskFile }, execute);
    }, 'Goal task enqueue failed', 'enqueue');
  } finally { if (enqueued) await ensureManagerRun(input.cwd); }
}

export function listTaktWorkflows(input: ListGoalsInput, deps: McpOperationDependencies) {
  try {
    assertCwdAllowedByMcpRoot(input.cwd, deps.allowedProjectRoot);
    const workflows = deps.managerWorkflows ?? listWorkflows(input.cwd).map((name) => {
      const workflow = loadWorkflowByIdentifier(name, input.cwd);
      if (workflow === null) throw new Error(`Workflow not found: ${name}`);
      return { name, description: workflow.description };
    });
    const offset = input.offset ?? 0;
    return pagedResult('workflows', workflows.slice(offset, offset + (input.limit ?? 50)), workflows.length, offset);
  } catch (error) { return errorResult('Workflow list failed', error); }
}

export function listTaktRuntimeAssignments(input: ListGoalsInput, deps: McpOperationDependencies) {
  try {
    assertCwdAllowedByMcpRoot(input.cwd, deps.allowedProjectRoot);
    const runtimeAssignments = deps.managerRuntimeAssignments ?? [];
    const offset = input.offset ?? 0;
    return pagedResult('runtimeAssignments', runtimeAssignments.slice(offset, offset + (input.limit ?? 50)), runtimeAssignments.length, offset);
  } catch (error) { return errorResult('Runtime assignment list failed', error); }
}

export async function createTaktGoal(input: GoalCreateInput, deps: McpOperationDependencies, signal: AbortSignal) {
  try {
    assertCwdAllowedByMcpRoot(input.cwd, deps.allowedProjectRoot);
    signal.throwIfAborted();
    const root = await resolveGitRepositoryDirectory(input.cwd);
    if (await realpath(input.cwd) !== root) {
      throw new Error(`cwd must be the Git repository root: ${root}`);
    }
    const configDirectory = getGlobalConfigDir();
    await mkdir(configDirectory, { recursive: true, mode: 0o700 });
    const managerId = conversationId({ kind: 'repository', repositoryDirectory: root });
    const goal = await withManagerLifecycleLock(configDirectory, managerId, signal,
      () => createGoal({ ...input, cwd: root }, signal));
    return jsonResult({ goal: goalWriteSummary(goal) });
  } catch (error) { return errorResult('Goal creation failed', error); }
}
