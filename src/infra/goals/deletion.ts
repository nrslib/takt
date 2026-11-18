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
  // ワークスペースから外したリポジトリのゴールも、元のワークスペースの完了・中止したエピックが参照し続ける。
  // 他のワークスペースにはこのリポジトリが入っていないのでメンバーを足せず、ロックなしで読むだけで足りる。
  for (const workspace of await readWorkspaceRegistry(globalConfigDirectory)) {
    if (workspace.id !== managerWorkspaceId) await assertGoalHasNoEpicReferences({ globalConfigDirectory, workspaceId: workspace.id }, goal);
  }
  if (managerWorkspaceId === undefined) {
    await deleteGoalRecords(cwd, goalId);
    return;
  }
  // エピックへのメンバー追加と競合しないよう、確認から削除までエピックのロックを持つ。
  await withWorkspaceEpicLock(globalConfigDirectory, managerWorkspaceId, async () => {
    await assertGoalHasNoEpicReferences({ globalConfigDirectory, workspaceId: managerWorkspaceId }, goal);
    await deleteGoalRecords(cwd, goalId);
  });
}

async function deleteGoalRecords(cwd: string, goalId: string): Promise<void> {
  await new GoalStore(cwd).delete(goalId, (goal) => {
    if (!isGoalFinished(goal)) throw new Error('Only a completed or aborted goal can be deleted');
    new TaskRunner(cwd).deleteFinishedGoalTasks(goalId);
    // ゴールのディレクトリより先に消し、途中で失敗してもゴールが残って削除をやり直せるようにする。
    deleteGoalEvents(cwd, goalId);
  });
}
