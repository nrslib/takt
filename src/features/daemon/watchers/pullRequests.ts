import { z } from 'zod/v4';
import type { CommandPort, IoOptions } from '../../../core/daemon/io.js';
import { assertGitHubPullRequestTarget, parseGitHubPullRequestTarget } from '../../../infra/github/pull-request-target.js';
import { WatchObservations, type WatchTarget } from './observations.js';

export interface PullRequestWatchTarget extends WatchTarget {
  repositoryDirectory: string;
  goalId: string;
  awaitingMerge: boolean;
  number: number;
  url: string;
  headBranch: string;
  baseBranch: string;
}

const ResponseSchema = z.object({
  number: z.number().int().positive(), url: z.url(), state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
  headRefName: z.string(), baseRefName: z.string(),
  mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']),
});

export async function observePullRequest(target: PullRequestWatchTarget, command: CommandPort,
  observations: WatchObservations, options: IoOptions): Promise<void> {
  options.signal.throwIfAborted();
  if (!target.awaitingMerge) {
    await observations.normal(target, 'pr_changed');
    await observations.normal(target, 'pr_mismatch');
    await observations.normal(target, 'pr_conflicting');
    return;
  }
  const published = parseGitHubPullRequestTarget(target.url);
  let mismatch: string | undefined;
  if (published.number !== target.number) mismatch = 'Saved PR number differs from its URL';
  else {
    const result = await command.run({ executable: 'gh',
      args: ['pr', 'view', published.url, '--json', 'number,url,state,headRefName,baseRefName,mergeable'],
      cwd: target.repositoryDirectory, env: process.env, maxOutputBytes: 16 * 1024,
    }, options);
    options.signal.throwIfAborted();
    if (result.code !== 0 || result.signal !== null || result.truncated) throw new Error('PR observation is unavailable');
    const response = ResponseSchema.parse(JSON.parse(Buffer.from(result.stdout).toString('utf8')));
    try { assertGitHubPullRequestTarget(response.url, published); }
    catch { mismatch = 'Returned PR repository or URL differs from the saved PR'; }
    if (response.number !== target.number || response.headRefName !== target.headBranch || response.baseRefName !== target.baseBranch) {
      mismatch = 'Returned PR number or branches differ from the saved PR';
    }
    if (mismatch === undefined) {
      await observations.normal(target, 'pr_mismatch');
      if (response.state === 'OPEN') {
        await observations.normal(target, 'pr_changed');
        if (response.mergeable === 'CONFLICTING') {
          await observations.abnormal(target, { ...observations.evidence(target), kind: 'pr_conflicting',
            repositoryDirectory: target.repositoryDirectory, goalId: target.goalId, url: target.url });
        } else if (response.mergeable === 'MERGEABLE') {
          await observations.normal(target, 'pr_conflicting');
        }
        return;
      }
      await observations.abnormal(target, { ...observations.evidence(target), kind: 'pr_changed',
        repositoryDirectory: target.repositoryDirectory, goalId: target.goalId, url: target.url, state: response.state });
      return;
    }
  }
  await observations.abnormal(target, { ...observations.evidence(target), kind: 'pr_mismatch',
    repositoryDirectory: target.repositoryDirectory, goalId: target.goalId, url: target.url, reason: mismatch });
}
