import type { Goal } from './schema.js';

// Short outages get early retries; the remaining attempts allow recovery over nearly two hours.
export const GOAL_PR_RETRY_DELAYS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 30 * 60_000, 30 * 60_000] as const;

export function goalPullRequestFailure(goal: Goal): Goal['pullRequestFailure'] {
  if (goal.status !== 'awaiting_merge' || goal.executionStatus !== 'active' || goal.pullRequest !== undefined
    || goal.completion === undefined) return undefined;
  if (goal.pullRequestFailure !== undefined) {
    return goal.pullRequestFailure.goalSha === goal.completion.goalSha ? goal.pullRequestFailure : undefined;
  }
  // Recover goals stranded before structured PR failures were saved.
  const entry = [...goal.workLog].reverse().find((item) => /^Goal PR (?:push failed:|creation failed:|origin unavailable:|creation requires )/.test(item.summary));
  return entry === undefined ? undefined : {
    id: entry.id, goalSha: goal.completion.goalSha, recordedAt: entry.recordedAt, error: entry.summary,
  };
}
