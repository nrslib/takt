import type { Language } from '../../core/models/types.js';
import { getLabel } from '../../shared/i18n/index.js';
import { truncateUtf8 } from '../../shared/utils/utf8.js';
import { toLocalBranchRef } from '../../shared/utils/gitBranchValidation.js';
import { createPullRequestSafely } from '../git/index.js';
import { GitHubProvider } from '../github/GitHubProvider.js';
import { parseGitHubPullRequestTarget } from '../github/pull-request-target.js';
import { runGoalGit } from './git-command.js';
import type { Goal } from './schema.js';
import { resolveConfigValue } from '../config/resolveConfigValue.js';
import { detectVcsProvider } from '../git/detect.js';
import { safeExternalErrorMessage } from '../../shared/utils/safeExternalErrorMessage.js';

export class GoalPullRequestUnavailableError extends Error {}

export async function prepareGoalPullRequest(
  cwd: string, goal: Goal, completion: NonNullable<Goal['completion']>,
  humanChecks: string | undefined, language: Language, signal: AbortSignal | undefined,
): Promise<NonNullable<Goal['pullRequest']>> {
  signal?.throwIfAborted();
  const providerType = resolveConfigValue(cwd, 'vcsProvider') ?? detectVcsProvider(cwd);
  if (providerType !== 'github') {
    throw new GoalPullRequestUnavailableError('Goal PR creation requires a GitHub origin or vcs_provider: github');
  }
  try {
    await runGoalGit(cwd, ['remote', 'get-url', 'origin'], 4096, signal);
  } catch (error) {
    signal?.throwIfAborted();
    throw new GoalPullRequestUnavailableError(`Goal PR origin unavailable: ${safeExternalErrorMessage(error)}`);
  }
  if (humanChecks === undefined || humanChecks.trim().length === 0) {
    throw new Error('humanChecks is required for a goal PR');
  }
  try {
    await runGoalGit(cwd, ['push', '--', 'origin', `${completion.goalSha}:${toLocalBranchRef(goal.branch)}`], 4096, signal);
  } catch (error) {
    signal?.throwIfAborted();
    throw new GoalPullRequestUnavailableError(`Goal PR push failed: ${safeExternalErrorMessage(error)}`);
  }
  const provider = new GitHubProvider();
  const existing = provider.findExistingPr(goal.branch, cwd);
  if (existing !== undefined) {
    const details = await provider.fetchPrDetails(existing.number, cwd, signal);
    if (!details.sameRepository || details.headBranch !== goal.branch || details.baseBranch !== goal.integrationBranch) {
      throw new Error('Existing PR does not match the goal head and integration branch');
    }
    signal?.throwIfAborted();
    return existing;
  }
  const changes = completion.changeSummary;
  const body = [
    `## ${getLabel('manager.goalPr.objective', language)}`, goal.objective,
    `## ${getLabel('manager.goalPr.changes', language)}`,
    ...changes.files.map((file) => `- ${file.path}`),
    ...(changes.truncated ? [getLabel('manager.goalPr.truncated', language)] : []),
    `## ${getLabel('manager.goalPr.verification', language)}`, completion.summary,
    `## ${getLabel('manager.goalPr.humanChecks', language)}`, humanChecks,
  ].join('\n\n');
  signal?.throwIfAborted();
  const result = createPullRequestSafely(provider, {
    branch: goal.branch, base: goal.integrationBranch, title: truncateUtf8(goal.objective, 200).value, body,
  }, cwd);
  if (!result.success) throw new GoalPullRequestUnavailableError(`Goal PR creation failed: ${result.error}`);
  if (result.url === undefined) throw new Error('Goal PR creation returned no URL');
  const { number, url } = parseGitHubPullRequestTarget(result.url);
  signal?.throwIfAborted();
  return { number, url };
}
