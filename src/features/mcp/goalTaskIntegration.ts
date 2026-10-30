import { GoalStore } from '../../infra/goals/store.js';
import { isGoalCommitIncluded, resolveGoalBranchSha, runGoalGit } from '../../infra/goals/git-command.js';
import type { TaskState } from '../../infra/task/types.js';
import { safeExternalErrorMessage } from '../../shared/utils/safeExternalErrorMessage.js';

type GoalBranchResolution = { sha: string } | { reason: string };

export async function getTaskGoalIntegrations(
  cwd: string, tasks: readonly TaskState[],
): Promise<Record<string, unknown>[]> {
  const store = new GoalStore(cwd);
  const branches = new Map<string, GoalBranchResolution>();
  const integrations: Record<string, unknown>[] = [];
  for (const task of tasks) {
    if (task.goalId === undefined) {
      integrations.push({});
      continue;
    }
    const sha = task.completion?.sha;
    if (task.status !== 'completed' || sha === undefined) {
      integrations.push({ goalIntegration: 'not_integrated' });
      continue;
    }
    let branch = branches.get(task.goalId);
    if (branch === undefined) {
      try {
        const goal = await store.get(task.goalId);
        branch = { sha: await resolveGoalBranchSha(cwd, goal.branch, undefined) };
      } catch (error) {
        branch = { reason: `Goal branch could not be resolved: ${safeExternalErrorMessage(error)}` };
      }
      branches.set(task.goalId, branch);
    }
    if ('reason' in branch) {
      integrations.push({ goalIntegration: 'unknown', goalIntegrationReason: branch.reason });
      continue;
    }
    try {
      const included = await isGoalCommitIncluded(cwd, sha, branch.sha, undefined);
      integrations.push({ goalIntegration: included ? 'integrated' : 'not_integrated' });
    } catch (error) {
      let reason = safeExternalErrorMessage(error);
      try {
        const commit = await runGoalGit(cwd, ['cat-file', '-e', '--', `${sha}^{commit}`], 0, undefined, [0, 1, 128]);
        if (commit.code !== 0) reason = 'Completion commit not found or unreadable';
      } catch (checkError) {
        reason = `${reason}; completion commit check failed: ${safeExternalErrorMessage(checkError)}`;
      }
      integrations.push({ goalIntegration: 'unknown', goalIntegrationReason: reason });
    }
  }
  return integrations;
}
