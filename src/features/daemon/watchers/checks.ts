import { stat } from 'node:fs/promises';
import type { TaskRef } from '../../../core/daemon/events.js';
import type { IoOptions, ProcessOwner, ProcessPort } from '../../../core/daemon/io.js';
import { WATCH_THRESHOLDS } from './loop.js';
import { watchKey, WatchObservations, type WatchTarget } from './observations.js';

export interface RunWatchTarget extends WatchTarget {
  task: TaskRef;
  owner: ProcessOwner | null;
  running: boolean;
  paused: boolean;
  awaitingAnswer: boolean;
  logPath: string | null;
}

export interface InquiryWatchTarget extends WatchTarget {
  repositoryDirectory: string;
  questionId: string;
  goalId: string | null;
  pending: boolean;
  createdAt: string | null;
}

export interface GoalWatchTarget extends WatchTarget {
  repositoryDirectory: string;
  goalId: string;
  active: boolean;
  lastUpdatedAt: string;
}

/** 実行可能性・autoRun の解決は業務側が行い、見張りはその小さな結果だけを観測する。 */
export interface LaunchWatchTarget extends WatchTarget {
  repositoryDirectory: string;
  autoRun: boolean;
  runnablePending: boolean;
  owner: 'present' | 'absent' | 'unknown';
  launching: boolean | null;
  pendingSince: string | null;
}

export interface LogStamp {
  identity: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export async function readLogStamp(path: string): Promise<LogStamp> {
  const value = await stat(path);
  if (!value.isFile()) throw new Error('Run log is not a regular file');
  return { identity: `${value.dev}:${value.ino}`, size: value.size, mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs };
}

export class WatchChecks {
  private readonly failures = new Map<string, number>();
  private readonly logs = new Map<string, { stamp: LogStamp; updatedAt: number }>();

  constructor(
    private readonly observations: WatchObservations,
    private readonly now: () => number,
    private readonly onError: (target: WatchTarget, error: unknown) => void,
    private readonly scope: 'process' | 'log' | 'pr' | 'inquiry' | 'goal' | 'launch',
  ) {}

  retain(targets: readonly WatchTarget[]): void {
    const keys = new Set(targets.map((target) => JSON.stringify([target.targetId, target.generation])));
    for (const key of this.failures.keys()) if (!keys.has(key)) this.failures.delete(key);
    for (const key of this.logs.keys()) if (!keys.has(key)) this.logs.delete(key);
  }

  /** unknown は正常への復帰とも異常の確定とも扱わない。 */
  async check(target: WatchTarget, action: () => Promise<void>): Promise<void> {
    const key = JSON.stringify([target.targetId, target.generation]);
    const failureTarget = { ...target, targetId: `${this.scope}-${watchKey(target, 'watch_failed')}` };
    try {
      await action();
      await this.observations.normal(failureTarget, 'watch_failed');
      this.failures.delete(key);
    } catch (error) {
      this.onError(target, error);
      const count = (this.failures.get(key) ?? 0) + 1;
      this.failures.set(key, count);
      if (count >= 3) await this.observations.abnormal(failureTarget, {
        ...this.observations.evidence(failureTarget), kind: 'watch_failed',
        reason: `${this.scope} observation failed three consecutive times for ${target.targetId}`,
      });
    }
  }

  async process(target: RunWatchTarget, processes: Pick<ProcessPort, 'inspect'>, options: IoOptions,
    reread: () => Promise<RunWatchTarget | undefined>): Promise<void> {
    options.signal.throwIfAborted();
    if (!target.running) return this.observations.normal(target, 'run_process_lost');
    if (target.owner === null) throw new Error('Run process identity is unknown');
    const observed = await processes.inspect(target.owner, options);
    options.signal.throwIfAborted();
    if (observed.kind === 'unknown') throw new Error('Run process observation is unknown');
    const current = await reread();
    if (current === undefined || current.generation !== target.generation || !current.running
      || current.owner?.pid !== target.owner.pid || current.owner.startTime !== target.owner.startTime) return;
    if (observed.kind === 'alive' && observed.owner.pid === target.owner.pid && observed.owner.startTime === target.owner.startTime) {
      return this.observations.normal(target, 'run_process_lost');
    }
    await this.observations.abnormal(target, {
      ...this.observations.evidence(target), kind: 'run_process_lost', task: target.task, ...target.owner,
    });
  }

  async log(target: RunWatchTarget, stamp: () => Promise<LogStamp>,
    reread: () => Promise<RunWatchTarget | undefined>): Promise<void> {
    const key = JSON.stringify([target.targetId, target.generation]);
    if (!target.running || target.paused || target.awaitingAnswer) {
      this.logs.delete(key);
      return this.observations.normal(target, 'run_log_stalled');
    }
    if (target.logPath === null) return;
    const value = await stamp();
    const previous = this.logs.get(key);
    const changed = previous !== undefined && (previous.stamp.identity !== value.identity
      || previous.stamp.size !== value.size || previous.stamp.mtimeMs !== value.mtimeMs || previous.stamp.ctimeMs !== value.ctimeMs);
    const updatedAt = changed ? this.now() : previous?.updatedAt ?? Math.max(value.mtimeMs, value.ctimeMs);
    this.logs.set(key, { stamp: value, updatedAt });
    const current = await reread();
    if (current === undefined || current.generation !== target.generation || current.logPath !== target.logPath
      || !current.running || current.paused || current.awaitingAnswer) return;
    if (this.now() - updatedAt < WATCH_THRESHOLDS.log) return this.observations.normal(target, 'run_log_stalled');
    await this.observations.abnormal(target, {
      ...this.observations.evidence(target), kind: 'run_log_stalled', task: target.task,
      lastUpdatedAt: new Date(updatedAt).toISOString(),
    });
  }

  async inquiry(target: InquiryWatchTarget): Promise<void> {
    if (!target.pending) return this.observations.normal(target, 'inquiry_stalled');
    if (target.createdAt === null || !Number.isFinite(Date.parse(target.createdAt))) throw new Error('Inquiry creation time is unknown');
    if (this.now() - Date.parse(target.createdAt) < WATCH_THRESHOLDS.inquiry) return this.observations.normal(target, 'inquiry_stalled');
    await this.observations.abnormal(target, {
      ...this.observations.evidence(target), kind: 'inquiry_stalled', repositoryDirectory: target.repositoryDirectory,
      questionId: target.questionId, goalId: target.goalId,
    });
  }

  async goal(target: GoalWatchTarget): Promise<void> {
    const updatedAt = Date.parse(target.lastUpdatedAt);
    if (!Number.isFinite(updatedAt)) throw new Error('Goal update time is unknown');
    if (!target.active || this.now() - updatedAt < WATCH_THRESHOLDS.inquiry) return this.observations.normal(target, 'goal_stalled');
    await this.observations.abnormal(target, { ...this.observations.evidence(target), kind: 'goal_stalled',
      repositoryDirectory: target.repositoryDirectory, goalId: target.goalId, lastUpdatedAt: target.lastUpdatedAt });
  }

  async launch(target: LaunchWatchTarget): Promise<void> {
    if (!target.autoRun || !target.runnablePending || target.owner === 'present' || target.launching === true) {
      return this.observations.normal(target, 'run_launch_stalled');
    }
    if (target.owner === 'unknown' || target.launching === null || target.pendingSince === null
      || !Number.isFinite(Date.parse(target.pendingSince))) throw new Error('Run launch state is unknown');
    if (this.now() - Date.parse(target.pendingSince) < WATCH_THRESHOLDS.launch) return this.observations.normal(target, 'run_launch_stalled');
    await this.observations.abnormal(target, {
      ...this.observations.evidence(target), kind: 'run_launch_stalled', repositoryDirectory: target.repositoryDirectory,
    });
  }
}
