export function resolveTargetBranch(task) {
  if (!task.branch) throw new Error(`Branch is required for ${task.name}`);
  return task.branch;
}

export async function createPullRequestForTask(task, dependencies, body) {
  if (!task.worktreePath) return false;
  const branch = resolveTargetBranch(task);
  const currentBranch = dependencies.getCurrentBranch(task.worktreePath);
  if (currentBranch === 'HEAD' || currentBranch !== branch) return false;

  await dependencies.confirm();
  await dependencies.commit();
  await dependencies.push(branch);
  await dependencies.createPullRequest(branch, body);
  return true;
}
