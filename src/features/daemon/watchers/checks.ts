import type { TaskRef } from '../../../core/daemon/events.js';
import type { IoOptions, ProcessOwner, ProcessPort } from '../../../core/daemon/io.js';
import { RUN_LAUNCH_STALL_MS } from './loop.js';
import { watchKey, WatchObservations, type WatchTarget } from './observations.js';

export interface RunWatchTarget extends WatchTarget {
  task: TaskRef;
  owner: ProcessOwner | null;
  running: boolean;
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

export class WatchChecks {
  private readonly failures = new Map<string, number>();

  constructor(
    private readonly observations: WatchObservations,
    private readonly now: () => number,
    private readonly onError: (target: WatchTarget, error: unknown) => void,
    private readonly scope: 'process' | 'pr' | 'pr_retry' | 'launch',
  ) {}

  retain(targets: readonly WatchTarget[]): void {
    const keys = new Set(targets.map((target) => JSON.stringify([target.targetId, target.generation])));
    for (const key of this.failures.keys()) if (!keys.has(key)) this.failures.delete(key);
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

  async launch(target: LaunchWatchTarget): Promise<void> {
    if (!target.autoRun || !target.runnablePending || target.owner === 'present' || target.launching === true) {
      return this.observations.normal(target, 'run_launch_stalled');
    }
    if (target.owner === 'unknown' || target.launching === null || target.pendingSince === null
      || !Number.isFinite(Date.parse(target.pendingSince))) throw new Error('Run launch state is unknown');
    if (this.now() - Date.parse(target.pendingSince) < RUN_LAUNCH_STALL_MS) return this.observations.normal(target, 'run_launch_stalled');
    await this.observations.abnormal(target, {
      ...this.observations.evidence(target), kind: 'run_launch_stalled', repositoryDirectory: target.repositoryDirectory,
    });
  }
}
