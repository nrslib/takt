import { resolveConfigValue } from '../../infra/config/index.js';
import { parseGitHubPullRequestTarget } from '../../infra/github/pull-request-target.js';
import type { Goal } from '../../infra/goals/schema.js';
import { enqueuePrMergeTask, resolveMergeSettings } from '../merge/index.js';

export async function mergeGoalPr(cwd: string, goal: Goal, until: 'prepare' | 'merge', signal: AbortSignal) {
  if (goal.pullRequest === undefined) throw new Error('Goal has no saved PR');
  const pullRequest = parseGitHubPullRequestTarget(goal.pullRequest.url);
  if (pullRequest.number !== goal.pullRequest.number) throw new Error('Saved goal PR identity is inconsistent');
  const settings = resolveMergeSettings(resolveConfigValue(cwd, 'merge'));
  const task = await enqueuePrMergeTask({
    projectCwd: cwd, prNumber: pullRequest.number, pullRequest,
    until, workflow: until === 'prepare' ? settings.prepareWorkflow : settings.workflow,
    settings, abortSignal: signal,
  }, goal);
  return { taskName: task.name, status: task.status, goalId: goal.id, prNumber: pullRequest.number,
    mergeTask: true, workflow: task.data!.workflow, until };
}
