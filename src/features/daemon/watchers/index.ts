import { GoalPullRequestRetries, type GoalPullRequestRetryTarget } from './goalPullRequestRetries.js';
import { MAX_WATCH_ENTRIES } from './files.js';
import type { CommandPort, IoOptions, ProcessPort } from '../../../core/daemon/io.js';
import type { DaemonIngress, DaemonResources } from '../../../core/daemon/ports.js';
import { readLogStamp, WatchChecks, type GoalWatchTarget, type InquiryWatchTarget, type LaunchWatchTarget, type RunWatchTarget } from './checks.js';
import { startDirectoryWatcher, type DirectoryWatchTarget, type WatchFileChange } from './directories.js';
import { startWatchLoop, WATCH_INTERVALS, type WatchLoop } from './loop.js';
import { WatchObservations, type WatchRecordStore, type WatchTarget } from './observations.js';
import { observePullRequest, type PullRequestWatchTarget } from './pullRequests.js';
import type { RunProgress } from './runProgress.js';

/** 観測対象を取得する。1回の観測件数はループ側で区切る。 */
export interface DaemonWatchSource {
  runs(): Promise<readonly RunWatchTarget[]>;
  run(targetId: string): Promise<RunWatchTarget | undefined>;
  readRunProgress(path: string, signal?: AbortSignal): Promise<RunProgress | undefined>;
  pullRequests(): Promise<readonly PullRequestWatchTarget[]>;
  pullRequestRetries(): Promise<readonly GoalPullRequestRetryTarget[]>;
  pullRequestRetry(target: GoalPullRequestRetryTarget): Promise<GoalPullRequestRetryTarget | undefined>;
  notifyPullRequestRetryLimit(target: GoalPullRequestRetryTarget, options: IoOptions): Promise<boolean>;
  inquiries(): Promise<readonly InquiryWatchTarget[]>;
  goals(): Promise<readonly GoalWatchTarget[]>;
  launches(): Promise<readonly LaunchWatchTarget[]>;
  directories(): Promise<readonly DirectoryWatchTarget[]>;
}

export interface DaemonWatchers extends DaemonResources {
  changed(): void;
  drain(): Promise<void>;
}

/** runDaemon の最終組立から開始し、DaemonResources.close で全観測・受付の完了を待つ。 */
export function startDaemonWatchers(dependencies: {
  source: DaemonWatchSource;
  processes: Pick<ProcessPort, 'inspect'>;
  commands: CommandPort;
  records: WatchRecordStore;
  ingress: Pick<DaemonIngress, 'accept'>;
  filesChanged(change: WatchFileChange): Promise<void>;
  now(): number;
  onError(target: WatchTarget | null, error: unknown): void;
}): DaemonWatchers {
  const observations = new WatchObservations(dependencies.records, dependencies.ingress, dependencies.now);
  const loops: WatchLoop[] = [];
  const retries = new GoalPullRequestRetries(dependencies.source, dependencies.commands, dependencies.records, observations, dependencies.now);
  const register = <T extends WatchTarget>(scope: 'process' | 'log' | 'run' | 'pr' | 'pr_retry' | 'inquiry' | 'goal' | 'launch', interval: number, read: () => Promise<readonly T[]>,
    observe: (checks: WatchChecks, target: T, signal: AbortSignal) => Promise<void>): void => {
    const checks = new WatchChecks(observations, dependencies.now, dependencies.onError, scope);
    let offset = 0;
    loops.push(startWatchLoop(interval, async (signal) => {
      const targets = await read();
      checks.retain(targets);
      if (offset >= targets.length) offset = 0;
      const page = targets.slice(offset, offset + MAX_WATCH_ENTRIES);
      offset += page.length;
      for (const target of page) {
        signal.throwIfAborted();
        await checks.check(target, () => observe(checks, target, signal));
      }
    }, (error) => dependencies.onError(null, error)));
  };
  register('process', WATCH_INTERVALS.process, () => dependencies.source.runs(), (checks, target, signal) =>
    checks.process(target, dependencies.processes, { signal, timeoutMs: WATCH_INTERVALS.process }, () => dependencies.source.run(target.targetId)));
  register('log', WATCH_INTERVALS.log, async () => (await dependencies.source.runs()).filter((target) => target.task.runSlug !== undefined), (checks, target) =>
    checks.log(target, readLogStamp, () => dependencies.source.run(target.targetId)));
  register('run', WATCH_INTERVALS.long, () => dependencies.source.runs(), (checks, target, signal) =>
    checks.runProgress(target, (path) => dependencies.source.readRunProgress(path, signal), () => dependencies.source.run(target.targetId)));
  register('pr', WATCH_INTERVALS.long, () => dependencies.source.pullRequests(), (_checks, target, signal) =>
    observePullRequest(target, dependencies.commands, observations, { signal, timeoutMs: WATCH_INTERVALS.long }));
  register('pr_retry', WATCH_INTERVALS.long, () => dependencies.source.pullRequestRetries(), (_checks, target, signal) =>
    retries.observe(target, { signal, timeoutMs: WATCH_INTERVALS.long }));
  register('inquiry', WATCH_INTERVALS.files, () => dependencies.source.inquiries(), (checks, target) => checks.inquiry(target));
  register('goal', WATCH_INTERVALS.long, () => dependencies.source.goals(), (checks, target) => checks.goal(target));
  register('launch', WATCH_INTERVALS.launch, () => dependencies.source.launches(), (checks, target) => checks.launch(target));
  loops.push(startDirectoryWatcher({ targets: () => dependencies.source.directories(), changed: dependencies.filesChanged,
    onError: (error) => dependencies.onError(null, error) }));
  return {
    changed() { for (const loop of loops) loop.wake(); },
    async drain() { await Promise.all(loops.map((loop) => loop.drain())); },
    async close() {
      const results = await Promise.allSettled(loops.map((loop) => loop.close()));
      const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason as unknown] : []);
      if (errors.length > 0) throw new AggregateError(errors, 'Cannot close daemon watchers');
    },
  };
}
