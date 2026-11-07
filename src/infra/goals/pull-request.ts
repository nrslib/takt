import { z } from 'zod/v4';
import type { Language } from '../../core/models/types.js';
import { getLabel } from '../../shared/i18n/index.js';
import { truncateUtf8 } from '../../shared/utils/utf8.js';
import { toLocalBranchRef } from '../../shared/utils/gitBranchValidation.js';
import { createPullRequestSafely } from '../git/index.js';
import { GitHubProvider } from '../github/GitHubProvider.js';
import { parseGitHubPullRequestTarget } from '../github/pull-request-target.js';
import { runPrCommand } from '../github/pr-command.js';
import { runGoalGit } from './git-command.js';
import type { Goal } from './schema.js';
import { resolveConfigValue } from '../config/resolveConfigValue.js';
import { detectVcsProvider } from '../git/detect.js';
import { safeExternalErrorMessage } from '../../shared/utils/safeExternalErrorMessage.js';

export class GoalPullRequestUnavailableError extends Error {
  constructor(message: string, readonly operation?: 'body') {
    super(message);
  }
}

const TAKT_BODY_START = '<!-- takt:goal-pr:start -->';
const TAKT_BODY_END = '<!-- takt:goal-pr:end -->';
const PullRequestBodySchema = z.object({ body: z.string() });
const CODERABBIT_RELEASE_NOTES_START = '<!-- This is an auto-generated comment: release notes by coderabbit.ai -->';
const CODERABBIT_RELEASE_NOTES_END = '<!-- end of auto-generated comment: release notes by coderabbit.ai -->';

function buildGoalPullRequestBody(
  goal: Goal, completion: NonNullable<Goal['completion']>, humanChecks: string, language: Language,
): string {
  const changes = completion.changeSummary;
  return [
    TAKT_BODY_START,
    `## ${getLabel('manager.goalPr.objective', language)}`, goal.objective,
    `## ${getLabel('manager.goalPr.changes', language)}`,
    ...changes.files.map((file) => `- ${file.path}`),
    ...(changes.truncated ? [getLabel('manager.goalPr.truncated', language)] : []),
    `## ${getLabel('manager.goalPr.verification', language)}`, completion.summary,
    `## ${getLabel('manager.goalPr.humanChecks', language)}`, humanChecks, TAKT_BODY_END,
  ].join('\n\n');
}

function codeRabbitRanges(body: string): Array<{ start: number; end: number }> {
  const notes: Array<{ start: number; end: number }> = [];
  let offset = 0;
  while (offset < body.length) {
    const start = body.indexOf(CODERABBIT_RELEASE_NOTES_START, offset);
    const end = body.indexOf(CODERABBIT_RELEASE_NOTES_END, offset);
    if (start === -1 && end === -1) break;
    if (start === -1 || end === -1 || end < start) {
      throw new Error('CodeRabbit release note markers are incomplete');
    }
    const nextStart = body.indexOf(CODERABBIT_RELEASE_NOTES_START, start + CODERABBIT_RELEASE_NOTES_START.length);
    if (nextStart !== -1 && nextStart < end) {
      throw new Error('CodeRabbit release note markers are nested');
    }
    const afterEnd = end + CODERABBIT_RELEASE_NOTES_END.length;
    notes.push({ start, end: afterEnd });
    offset = afterEnd;
  }
  return notes;
}

function replaceGoalPullRequestBody(body: string, replacement: string): string {
  const start = body.indexOf(TAKT_BODY_START);
  const end = body.indexOf(TAKT_BODY_END);
  if (start === -1 && end === -1) {
    const notes = codeRabbitRanges(body).map((range) => body.slice(range.start, range.end));
    return [replacement, ...notes].join('\n\n');
  }
  if (start === -1 || end < start
    || body.indexOf(TAKT_BODY_START, start + TAKT_BODY_START.length) !== -1
    || body.indexOf(TAKT_BODY_END, end + TAKT_BODY_END.length) !== -1) {
    throw new Error('TAKT PR body markers are incomplete or duplicated');
  }
  return body.slice(0, start) + replacement + body.slice(end + TAKT_BODY_END.length);
}

export async function prepareGoalPullRequest(
  cwd: string, goal: Goal, completion: NonNullable<Goal['completion']>,
  humanChecks: string | undefined, language: Language, signal: AbortSignal | undefined,
  assertCurrent: () => Promise<void>,
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
  await assertCurrent();
  try {
    await runGoalGit(cwd, ['push', '--', 'origin', `${completion.goalSha}:${toLocalBranchRef(goal.branch)}`], 4096, signal);
  } catch (error) {
    signal?.throwIfAborted();
    throw new GoalPullRequestUnavailableError(`Goal PR push failed: ${safeExternalErrorMessage(error)}`);
  }
  await assertCurrent();
  const provider = new GitHubProvider();
  const existing = provider.findExistingPr(goal.branch, cwd);
  if (existing !== undefined) {
    const details = await provider.fetchPrDetails(existing.number, cwd, signal);
    if (!details.sameRepository || details.headBranch !== goal.branch || details.baseBranch !== goal.integrationBranch) {
      throw new Error('Existing PR does not match the goal head and integration branch');
    }
    const generated = buildGoalPullRequestBody(goal, completion, humanChecks, language);
    let body: string;
    try {
      const output = await runPrCommand(['pr', 'view', existing.url, '--json', 'body'], cwd, { signal });
      const previous = PullRequestBodySchema.parse(JSON.parse(output));
      body = replaceGoalPullRequestBody(previous.body, generated);
    } catch (error) {
      signal?.throwIfAborted();
      throw new GoalPullRequestUnavailableError(`Goal PR body read failed: ${safeExternalErrorMessage(error)}`, 'body');
    }
    signal?.throwIfAborted();
    await assertCurrent();
    try {
      await runPrCommand(['pr', 'edit', existing.url, '--body', body], cwd, { signal });
    } catch (error) {
      signal?.throwIfAborted();
      throw new GoalPullRequestUnavailableError(`Goal PR body update failed: ${safeExternalErrorMessage(error)}`, 'body');
    }
    signal?.throwIfAborted();
    return existing;
  }
  const body = buildGoalPullRequestBody(goal, completion, humanChecks, language);
  signal?.throwIfAborted();
  await assertCurrent();
  const result = createPullRequestSafely(provider, {
    branch: goal.branch, base: goal.integrationBranch, title: truncateUtf8(goal.objective, 200).value, body,
  }, cwd);
  if (!result.success) throw new GoalPullRequestUnavailableError(`Goal PR creation failed: ${result.error}`);
  if (result.url === undefined) throw new Error('Goal PR creation returned no URL');
  const { number, url } = parseGitHubPullRequestTarget(result.url);
  signal?.throwIfAborted();
  return { number, url };
}
