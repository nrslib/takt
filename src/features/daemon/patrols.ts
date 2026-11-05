import { randomUUID } from 'node:crypto';
import type { DaemonIngress } from '../../core/daemon/ports.js';
import { startWatchLoop, WATCH_INTERVALS, type WatchLoop } from './watchers/loop.js';

export interface ManagerPatrolTarget {
  conversationId: string;
  repositoryDirectory: string;
  intervalSeconds: number;
}

/** 予定はメモリ内だけに持ち、停止中の周期を再生しない。 */
export function startManagerPatrols(dependencies: {
  targets(): Promise<readonly ManagerPatrolTarget[]>;
  goals(repositoryDirectory: string): Promise<readonly string[]>;
  pending(conversationId: string): boolean;
  ingress: Pick<DaemonIngress, 'accept'>;
  now(): number;
  onError(error: unknown): void;
}): WatchLoop {
  const schedules = new Map<string, { interval: number; due: number; lastQueued: number }>();
  let nextDelay: number = WATCH_INTERVALS.files;
  return startWatchLoop(() => nextDelay, async (signal) => {
    const observedAt = dependencies.now();
    const targets = await dependencies.targets();
    const present = new Set(targets.map((target) => target.repositoryDirectory));
    for (const key of schedules.keys()) if (!present.has(key)) schedules.delete(key);
    // 同じ workspace のリポジトリが同時に期限を迎えても、毎回同じ一つを優先しない。
    const ordered = [...targets].sort((left, right) => (schedules.get(left.repositoryDirectory)?.lastQueued ?? 0)
      - (schedules.get(right.repositoryDirectory)?.lastQueued ?? 0));
    for (const target of ordered) {
      signal.throwIfAborted();
      const interval = target.intervalSeconds * 1000;
      let schedule = schedules.get(target.repositoryDirectory);
      if (schedule === undefined || schedule.interval !== interval) {
        schedule = { interval, due: observedAt + interval, lastQueued: 0 };
        schedules.set(target.repositoryDirectory, schedule);
      }
      if (dependencies.now() < schedule.due) continue;
      // 実行中・待機中の見回りがあれば、その周期は飛ばす。
      schedule.due = dependencies.now() + interval;
      if (dependencies.pending(target.conversationId)) continue;
      const goalIds = await dependencies.goals(target.repositoryDirectory);
      signal.throwIfAborted();
      if (goalIds.length === 0) continue;
      const id = `patrol-${randomUUID()}`;
      const admission = await dependencies.ingress.accept({ eventId: id, requestId: id,
        conversationId: target.conversationId, source: 'daemon', occurredAt: new Date(dependencies.now()).toISOString(),
        event: { kind: 'patrol', repositoryDirectory: target.repositoryDirectory, goalIds: [...goalIds] } });
      if (admission.kind === 'rejected') dependencies.onError(new Error(`Patrol admission rejected: ${admission.reason}`));
      else schedule.lastQueued = dependencies.now();
    }
    nextDelay = Math.max(1, Math.min(WATCH_INTERVALS.files,
      ...[...schedules.values()].map((schedule) => schedule.due - dependencies.now())));
  }, dependencies.onError);
}
