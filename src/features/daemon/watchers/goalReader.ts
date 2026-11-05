import { Worker } from 'node:worker_threads';
import type { Goal } from '../../../infra/goals/schema.js';
import type { RunProgress } from './runProgress.js';
import { WATCH_INTERVALS } from './loop.js';

export type WatchGoal = Pick<Goal, 'id' | 'status' | 'executionStatus' | 'questions' | 'pullRequest' | 'branch' | 'integrationBranch'> & {
  lastUpdatedAt: string | undefined;
  blockedNotifications: string[];
};
type WatchReadOperation = { kind: 'goal'; cwd: string; goalId: string } | { kind: 'run'; path: string };
export type WatchReadRequest = { id: number } & WatchReadOperation;
type WatchReadResult = { kind: 'goal'; goal: WatchGoal } | { kind: 'run'; progress: RunProgress | undefined };
export type WatchReadReply = { id: number } & (({ ok: true } & WatchReadResult) | { ok: false; message: string });

/** daemon ごとに1ワーカー、未完了の依頼は最大32件に制限する。 */
export class WatchGoalReader {
  private worker: Worker | undefined;
  private readonly pending = new Map<number, { resolve: (result: WatchReadResult) => void; reject: (error: unknown) => void }>();
  private terminating: Promise<void> | undefined;
  private nextId = 0;
  private closed = false;

  async read(cwd: string, goalId: string): Promise<WatchGoal> {
    const result = await this.request({ kind: 'goal', cwd, goalId }, AbortSignal.timeout(WATCH_INTERVALS.long));
    if (result.kind !== 'goal') throw new Error('Unexpected goal reader reply');
    return result.goal;
  }

  async readRunProgress(path: string, signal?: AbortSignal): Promise<RunProgress | undefined> {
    const deadline = AbortSignal.timeout(WATCH_INTERVALS.long);
    const cancellation = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
    const result = await this.request({ kind: 'run', path }, cancellation);
    if (result.kind !== 'run') throw new Error('Unexpected run reader reply');
    return result.progress;
  }

  private async request(operation: WatchReadOperation, signal?: AbortSignal): Promise<WatchReadResult> {
    if (this.terminating !== undefined) await this.terminating;
    signal?.throwIfAborted();
    if (this.closed) throw new Error('Goal reader is closed');
    if (this.pending.size >= 32) throw new Error('Goal reader capacity exceeded');
    if (this.worker === undefined) {
      const worker = new Worker(new URL('./goalReaderWorker.js', import.meta.url), {
        execArgv: import.meta.url.endsWith('.ts') ? ['--import', 'tsx'] : [],
      });
      this.worker = worker;
      worker.on('message', (reply: WatchReadReply) => {
        const request = this.pending.get(reply.id);
        if (request === undefined) return;
        this.pending.delete(reply.id);
        if (reply.ok) request.resolve(reply);
        else request.reject(new Error(reply.message));
        if (this.pending.size === 0) worker.unref();
      });
      worker.on('error', (error) => { void this.terminate(worker, error); });
      worker.on('exit', (code) => this.fail(worker, new Error(`Goal reader exited (${code})`)));
    }
    const worker = this.worker;
    const id = ++this.nextId;
    const abort = (): void => { void this.terminate(worker, signal?.reason); };
    try {
      return await new Promise<WatchReadResult>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        signal?.addEventListener('abort', abort, { once: true });
        worker.ref();
        worker.postMessage({ id, ...operation } satisfies WatchReadRequest);
      });
    } finally {
      signal?.removeEventListener('abort', abort);
      if (this.terminating !== undefined) await this.terminating;
    }
  }

  private fail(worker: Worker, error: unknown): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  private terminate(worker: Worker, error: unknown): Promise<void> {
    if (this.worker !== worker) return this.terminating ?? Promise.resolve();
    const terminating = worker.terminate().then(() => {
      if (this.terminating === terminating) this.terminating = undefined;
    });
    this.terminating = terminating;
    this.fail(worker, error);
    return terminating;
  }

  async close(): Promise<void> {
    this.closed = true;
    const worker = this.worker;
    if (worker !== undefined) await this.terminate(worker, new Error('Goal reader is closed'));
    else await this.terminating;
  }
}
