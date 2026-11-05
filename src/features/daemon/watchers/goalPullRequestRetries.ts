import type { CommandPort, IoOptions } from '../../../core/daemon/io.js';
import { GOAL_PR_RETRY_DELAYS } from '../../../infra/goals/pull-request-failure.js';
import { buildSafeGitEnvironment } from '../../../infra/task/git-environment.js';
import { toLocalBranchRef } from '../../../shared/utils/gitBranchValidation.js';
import { watchKey, WatchObservations, type WatchRecordStore, type WatchTarget } from './observations.js';

export interface GoalPullRequestRetryTarget extends WatchTarget {
  repositoryDirectory: string;
  goalId: string;
  expectedSha: string;
  headBranch: string;
  failureId: string;
  failedAt: string;
  error: string;
}

export class GoalPullRequestRetries {
  constructor(
    private readonly source: {
      pullRequestRetry(target: GoalPullRequestRetryTarget): Promise<GoalPullRequestRetryTarget | undefined>;
      notifyPullRequestRetryLimit(target: GoalPullRequestRetryTarget, options: IoOptions): Promise<boolean>;
    },
    private readonly commands: CommandPort,
    private readonly records: WatchRecordStore,
    private readonly observations: WatchObservations,
    private readonly now: () => number,
  ) {}

  private async current(target: GoalPullRequestRetryTarget, options: IoOptions): Promise<GoalPullRequestRetryTarget | undefined> {
    const current = await this.source.pullRequestRetry(target);
    if (current?.generation !== target.generation) return undefined;
    const head = await this.commands.run({ executable: 'git',
      args: ['rev-parse', '--verify', `${toLocalBranchRef(current.headBranch)}^{commit}`],
      cwd: current.repositoryDirectory,
      env: await buildSafeGitEnvironment(current.repositoryDirectory, { allowGitHooks: false, allowGitFilters: true }, options.signal),
      maxOutputBytes: 4096,
    }, options);
    options.signal.throwIfAborted();
    if (head.code !== 0 || head.signal !== null || head.truncated) throw new Error('Goal PR retry cannot read the branch tip');
    const latest = await this.source.pullRequestRetry(target);
    return latest?.generation === current.generation && Buffer.from(head.stdout).toString('utf8').trim() === current.expectedSha
      ? latest : undefined;
  }

  async observe(target: GoalPullRequestRetryTarget, options: IoOptions): Promise<void> {
    options.signal.throwIfAborted();
    const saved = await this.records.read(watchKey(target, 'goal_pr_retry'));
    const previous = saved?.input?.event;
    const pending = previous?.kind === 'watch_observation' && previous.observation.kind === 'goal_pr_retry'
      ? previous.observation : undefined;
    const retry = saved?.retry ?? { attempts: 0, lastAttemptAt: target.failedAt };
    if (saved?.accepted === false && pending !== undefined) {
      const current = await this.current(target, options);
      if (current !== undefined) await this.observations.abnormal(current, pending);
      return;
    }
    if (retry.limitNotified) return;
    const delay = GOAL_PR_RETRY_DELAYS[retry.attempts];
    if (delay !== undefined && this.now() - Date.parse(retry.lastAttemptAt) < delay) return;
    const current = await this.current(target, options);
    if (current === undefined) return;
    options.signal.throwIfAborted();
    if (delay === undefined) {
      if (!await this.source.notifyPullRequestRetryLimit(current, options)) return;
      if (saved === undefined) throw new Error('Missing PR retry budget');
      await this.records.write(watchKey(target, 'goal_pr_retry'), { ...saved, retry: { ...retry, limitNotified: true } });
      return;
    }
    await this.observations.abnormal(current, {
      ...this.observations.evidence(current), kind: 'goal_pr_retry',
      repositoryDirectory: current.repositoryDirectory, goalId: current.goalId, failureId: current.failureId, expectedSha: current.expectedSha,
      reason: current.error, attempt: retry.attempts + 1, maxAttempts: GOAL_PR_RETRY_DELAYS.length,
    });
  }
}
