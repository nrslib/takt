import { readWorkspaceRegistry } from '../config/global/workspaceRegistry.js';
import { withWorkspaceEpicLock } from '../epics/lock.js';
import type { EpicMember } from '../epics/schema.js';
import { assertGoalHasNoEpicReferences } from '../epics/service.js';
import { TaskRunner } from '../task/runner.js';
import { isGoalFinished } from './activity.js';
import { deleteGoalEvents } from './events.js';
import { GoalStore } from './store.js';

/**
 * Branches, run directories and clones of failed tasks are kept; only the goal, its task records and its saved manager events are removed.
 * `managerWorkspaceId` is the workspace of the manager that deletes the goal; a repository manager has none.
 */
export async function deleteFinishedGoal(
  cwd: string,
  goalId: string,
  globalConfigDirectory: string,
  managerWorkspaceId: string | undefined,
): Promise<void> {
  const goal: EpicMember = { repositoryDirectory: cwd, goalId };
  if (managerWorkspaceId === undefined) {
    await assertNoWorkspaceEpicReferences(globalConfigDirectory, goal);
    await deleteGoalRecords(cwd, goalId);
    return;
  }
  // 削除元のワークスペースのエピックへのメンバー追加とは、ロックで競合しないようにする。
  // ロックを待つ間にリポジトリが別のワークスペースへ移り、そこでメンバーに足されることもあるため、
  // 参照の確認はロックを取った後、削除の直前に全ワークスペースについて行う。
  await withWorkspaceEpicLock(globalConfigDirectory, managerWorkspaceId, async () => {
    await assertNoWorkspaceEpicReferences(globalConfigDirectory, goal);
    await deleteGoalRecords(cwd, goalId);
  });
}

// ワークスペースから外したリポジトリのゴールも、元のワークスペースの完了・中止したエピックが参照し続ける。
async function assertNoWorkspaceEpicReferences(globalConfigDirectory: string, goal: EpicMember): Promise<void> {
  for (const workspace of await readWorkspaceRegistry(globalConfigDirectory)) {
    await assertGoalHasNoEpicReferences({ globalConfigDirectory, workspaceId: workspace.id }, goal);
  }
}

async function deleteGoalRecords(cwd: string, goalId: string): Promise<void> {
  await new GoalStore(cwd).delete(goalId, (goal) => {
    if (!isGoalFinished(goal)) throw new Error('Only a completed or aborted goal can be deleted');
    new TaskRunner(cwd).deleteFinishedGoalTasks(goalId);
    // ゴールのディレクトリより先に消し、途中で失敗してもゴールが残って削除をやり直せるようにする。
    deleteGoalEvents(cwd, goalId);
  });
}
