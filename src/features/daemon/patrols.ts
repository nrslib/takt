import { randomUUID } from 'node:crypto';
import type { DaemonIngress } from '../../core/daemon/ports.js';
import { startWatchLoop, WATCH_INTERVALS, type WatchLoop } from './watchers/loop.js';

const PATROL_RECORD_RETRY_MS = WATCH_INTERVALS.long;

type PatrolSchedule = {
  interval: number;
  due: number;
  lastQueued: number | undefined;
  pendingWrite: number | undefined;
  retryAt: number | undefined;
};

export interface ManagerPatrolTarget {
  conversationId: string;
  repositoryDirectory: string;
  intervalSeconds: number;
}

export interface PatrolRecordStore {
  read(repositoryDirectory: string): Promise<number | undefined>;
  write(repositoryDirectory: string, lastQueued: number): Promise<void>;
}

/** 前回受付時刻を保存・復元し、停止中に過ぎた周期はまとめて再生しない。 */
export function startManagerPatrols(dependencies: {
  targets(): Promise<readonly ManagerPatrolTarget[]>;
  goals(repositoryDirectory: string): Promise<readonly string[]>;
  pending(conversationId: string): boolean;
  ingress: Pick<DaemonIngress, 'accept'>;
  records: PatrolRecordStore;
  now(): number;
  onError(error: unknown): void;
}): WatchLoop {
  const schedules = new Map<string, PatrolSchedule>();
  const persist = async (repositoryDirectory: string, schedule: PatrolSchedule, lastQueued: number): Promise<void> => {
    schedule.pendingWrite = lastQueued;
    schedule.retryAt = undefined;
    try {
      await dependencies.records.write(repositoryDirectory, lastQueued);
      if (schedule.pendingWrite === lastQueued) {
        schedule.pendingWrite = undefined;
        schedule.retryAt = undefined;
      }
    } catch (error) {
      schedule.pendingWrite = lastQueued;
      schedule.retryAt = dependencies.now() + PATROL_RECORD_RETRY_MS;
      dependencies.onError(error);
    }
  };
  let nextDelay: number = WATCH_INTERVALS.files;
  return startWatchLoop(() => nextDelay, async (signal) => {
    const targets = await dependencies.targets();
    const present = new Set(targets.map((target) => target.repositoryDirectory));
    for (const [key, schedule] of schedules) if (!present.has(key) && schedule.pendingWrite === undefined) schedules.delete(key);

    for (const [repositoryDirectory, schedule] of schedules) {
      if (schedule.pendingWrite === undefined) continue;
      const target = targets.find((item) => item.repositoryDirectory === repositoryDirectory);
      if (target !== undefined && dependencies.pending(target.conversationId)) continue;
      if (target === undefined && schedule.retryAt !== undefined && dependencies.now() < schedule.retryAt) continue;
      await persist(repositoryDirectory, schedule, schedule.pendingWrite);
      if (target === undefined && schedule.pendingWrite === undefined) schedules.delete(repositoryDirectory);
    }

    for (const target of targets) {
      signal.throwIfAborted();
      const interval = target.intervalSeconds * 1000;
      const schedule = schedules.get(target.repositoryDirectory);
      if (schedule === undefined) {
        let lastQueued: number | undefined;
        try { lastQueued = await dependencies.records.read(target.repositoryDirectory); }
        catch (error) { dependencies.onError(error); }
        const restoredAt = dependencies.now();
        const correctedTimestamp = lastQueued !== undefined && lastQueued > restoredAt ? restoredAt : undefined;
        if (correctedTimestamp !== undefined) lastQueued = correctedTimestamp;
        const restored = { interval, lastQueued, pendingWrite: correctedTimestamp, retryAt: undefined,
          due: lastQueued === undefined ? restoredAt : lastQueued + interval };
        schedules.set(target.repositoryDirectory, restored);
        if (correctedTimestamp !== undefined) await persist(target.repositoryDirectory, restored, correctedTimestamp);
      } else if (schedule.interval !== interval) {
        schedule.interval = interval;
        schedule.due = schedule.lastQueued === undefined ? dependencies.now() : schedule.lastQueued + interval;
      }
    }
    // 同じ workspace のリポジトリが同時に期限を迎えても、毎回同じ一つを優先しない。
    const ordered = [...targets].sort((left, right) => (schedules.get(left.repositoryDirectory)!.lastQueued ?? 0)
      - (schedules.get(right.repositoryDirectory)!.lastQueued ?? 0));
    for (const target of ordered) {
      signal.throwIfAborted();
      const schedule = schedules.get(target.repositoryDirectory)!;
      const interval = schedule.interval;
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
      else {
        schedule.lastQueued = dependencies.now();
        schedule.due = schedule.lastQueued + interval;
        await persist(target.repositoryDirectory, schedule, schedule.lastQueued);
      }
    }
    const deadlines = targets.map((target) => schedules.get(target.repositoryDirectory)!.due - dependencies.now());
    deadlines.push(...[...schedules.entries()]
      .filter(([repositoryDirectory, schedule]) => !present.has(repositoryDirectory) && schedule.pendingWrite !== undefined
        && schedule.retryAt !== undefined)
      .map(([, schedule]) => schedule.retryAt! - dependencies.now()));
    nextDelay = Math.max(1, Math.min(WATCH_INTERVALS.files, ...deadlines));
  }, dependencies.onError);
}
