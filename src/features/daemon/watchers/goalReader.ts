import { Worker } from 'node:worker_threads';
import type { Goal } from '../../../infra/goals/schema.js';

export type WatchGoal = Pick<Goal, 'id' | 'status' | 'executionStatus' | 'questions' | 'pullRequest' | 'branch' | 'integrationBranch'> & {
  lastUpdatedAt: string | undefined;
  blockedNotifications: string[];
};
export type GoalReadReply = { id: number } & ({ ok: true; goal: WatchGoal } | { ok: false; message: string });

/** daemon ごとに1ワーカー、未完了の依頼は最大32件に制限する。 */
export class WatchGoalReader {
  private worker: Worker | undefined;
  private readonly pending = new Map<number, { resolve: (goal: WatchGoal) => void; reject: (error: Error) => void }>();
  private nextId = 0;
  private closed = false;

  read(cwd: string, goalId: string): Promise<WatchGoal> {
    if (this.closed) return Promise.reject(new Error('Goal reader is closed'));
    if (this.pending.size >= 32) return Promise.reject(new Error('Goal reader capacity exceeded'));
    if (this.worker === undefined) {
      const worker = new Worker(new URL('./goalReaderWorker.js', import.meta.url), {
        execArgv: import.meta.url.endsWith('.ts') ? ['--import', 'tsx'] : [],
      });
      this.worker = worker;
      worker.on('message', (reply: GoalReadReply) => {
        const request = this.pending.get(reply.id);
        if (request === undefined) return;
        this.pending.delete(reply.id);
        if (reply.ok) request.resolve(reply.goal);
        else request.reject(new Error(reply.message));
        if (this.pending.size === 0) worker.unref();
      });
      worker.on('error', (error) => this.fail(worker, error));
      worker.on('exit', (code) => this.fail(worker, new Error(`Goal reader exited (${code})`)));
    }
    const worker = this.worker;
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.ref();
      worker.postMessage({ id, cwd, goalId });
    });
  }

  private fail(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  async close(): Promise<void> {
    this.closed = true;
    const worker = this.worker;
    if (worker === undefined) return;
    this.fail(worker, new Error('Goal reader is closed'));
    await worker.terminate();
  }
}
