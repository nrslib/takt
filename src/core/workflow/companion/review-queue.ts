import type { CompanionDiff } from './diff-reader.js';
import { createAbortError, isAbortError } from './abort.js';

export interface CompanionReviewRequest {
  readonly companionName: string;
  readonly snapshot: CompanionDiff;
  readonly reason: 'quiet' | 'forced' | 'completion' | 'commit';
  readonly observedGeneration: number;
}

export interface CompanionReviewQueueCoalesced {
  readonly companionName: string;
  readonly replaced: {
    readonly trigger: CompanionReviewRequest['reason'];
    readonly digest: string;
    readonly changedLines: number;
    readonly observedGeneration: number;
  };
  readonly replacement: {
    readonly trigger: CompanionReviewRequest['reason'];
    readonly digest: string;
    readonly changedLines: number;
    readonly observedGeneration: number;
  };
}

interface QueueWaiter {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

interface PendingBatch {
  request: CompanionReviewRequest;
  readonly waiters: QueueWaiter[];
}

interface QueueState {
  draining: boolean;
  running?: AbortController;
  readonly pending: PendingBatch[];
  readonly idleWaiters: Array<() => void>;
}

export class CompanionReviewQueue {
  private readonly states = new Map<string, QueueState>();
  private stopped = false;

  constructor(private readonly input: {
    runReview: (request: CompanionReviewRequest & { signal: AbortSignal }) => Promise<void>;
    onCoalesced?: (event: CompanionReviewQueueCoalesced) => void;
  }) {}

  enqueue(request: CompanionReviewRequest): Promise<void> {
    this.throwIfStopped();
    const state = this.getState(request.companionName);
    const waiter = promiseWaiter();
    const last = state.pending.at(-1);
    if (last !== undefined && last.request.reason !== 'completion') {
      const replaced = toQueueAuditRequest(last.request);
      last.request = request;
      last.waiters.push(waiter.waiter);
      this.input.onCoalesced?.({
        companionName: request.companionName,
        replaced,
        replacement: toQueueAuditRequest(request),
      });
    } else {
      state.pending.push({ request, waiters: [waiter.waiter] });
    }
    this.startDrain(state);
    return waiter.promise;
  }

  complete(request: Omit<CompanionReviewRequest, 'reason'>): Promise<void> {
    this.throwIfStopped();
    const state = this.getState(request.companionName);
    const error = createAbortError();
    this.rejectPending(state, error);
    state.running?.abort();
    const waiter = promiseWaiter();
    state.pending.push({
      request: { ...request, reason: 'completion' },
      waiters: [waiter.waiter],
    });
    this.startDrain(state);
    return waiter.promise;
  }

  async settle(companionName: string): Promise<void> {
    this.throwIfStopped();
    const state = this.getState(companionName);
    const error = createAbortError();
    this.rejectPending(state, error);
    state.running?.abort();
    if (!state.draining && state.running === undefined) return;
    await new Promise<void>((resolve) => state.idleWaiters.push(resolve));
  }

  stop(reason?: unknown): void {
    if (this.stopped) return;
    this.stopped = true;
    const error = createAbortError(reason);
    for (const state of this.states.values()) {
      this.rejectPending(state, error);
      state.running?.abort(reason);
    }
  }

  private startDrain(state: QueueState): void {
    if (state.draining) return;
    state.draining = true;
    void this.drain(state);
  }

  private async drain(state: QueueState): Promise<void> {
    while (!this.stopped && state.pending.length > 0) {
      const batch = state.pending.shift();
      if (batch === undefined) throw new Error('Companion review queue lost a pending batch');
      const controller = new AbortController();
      state.running = controller;
      try {
        await this.input.runReview({ ...batch.request, signal: controller.signal });
        for (const waiter of batch.waiters) waiter.resolve();
      } catch (error) {
        for (const waiter of batch.waiters) waiter.reject(error);
        if (!isAbortError(error)) this.rejectPending(state, error);
      } finally {
        state.running = undefined;
      }
    }
    if (this.stopped) this.rejectPending(state, createAbortError());
    state.draining = false;
    for (const resolve of state.idleWaiters.splice(0)) resolve();
    if (!this.stopped && state.pending.length > 0) this.startDrain(state);
  }

  private getState(companionName: string): QueueState {
    const current = this.states.get(companionName);
    if (current !== undefined) return current;
    const created: QueueState = { draining: false, pending: [], idleWaiters: [] };
    this.states.set(companionName, created);
    return created;
  }

  private rejectPending(state: QueueState, error: unknown): void {
    for (const batch of state.pending.splice(0)) {
      for (const waiter of batch.waiters) waiter.reject(error);
    }
  }

  private throwIfStopped(): void {
    if (this.stopped) throw createAbortError();
  }
}

function toQueueAuditRequest(request: CompanionReviewRequest): CompanionReviewQueueCoalesced['replaced'] {
  return {
    trigger: request.reason,
    digest: request.snapshot.digest,
    changedLines: request.snapshot.changedLines,
    observedGeneration: request.observedGeneration,
  };
}

function promiseWaiter(): { promise: Promise<void>; waiter: QueueWaiter } {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, waiter: { resolve, reject } };
}
