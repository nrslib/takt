import type {
  LeaseHandle,
  RunStorageRoot,
} from '../../../infra/run-storage/index.js';
import {
  RunCleanupError,
  type RunFinalization,
} from './workflowRunExecution.js';

const HEARTBEAT_INTERVAL_MS = 10_000;
const LEASE_DURATION_MS = 30_000;

export class SqliteFindingStoreLifecycle {
  readonly #root: RunStorageRoot;
  readonly #lease: LeaseHandle;
  readonly #abortController: AbortController;
  #heartbeatFailure: unknown;
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  #closed = false;

  constructor(input: {
    readonly root: RunStorageRoot;
    readonly lease: LeaseHandle;
    readonly abortController: AbortController;
  }) {
    this.#root = input.root;
    this.#lease = input.lease;
    this.#abortController = input.abortController;
    this.startHeartbeat();
  }

  assertHealthy(): void {
    if (this.#heartbeatFailure !== undefined) {
      throw this.#heartbeatFailure;
    }
  }

  close(): RunFinalization {
    if (this.#closed) {
      throw new Error('SQLite Finding store lifecycle is closed');
    }
    this.#closed = true;
    this.stopHeartbeat();
    const cleanupErrors: unknown[] = [];
    captureError(cleanupErrors, () => {
      this.#root.releaseLease(this.#lease);
    });
    captureError(cleanupErrors, () => {
      this.#root.close();
    });
    return Object.freeze({
      issues: Object.freeze(
        cleanupErrors.map((error) => new RunCleanupError(error)),
      ),
    });
  }

  private startHeartbeat(): void {
    this.#heartbeatTimer = setInterval(() => {
      try {
        this.#root.heartbeatLease(this.#lease, LEASE_DURATION_MS);
      } catch (error) {
        this.#heartbeatFailure = error;
        this.stopHeartbeat();
        if (!this.#abortController.signal.aborted) {
          this.#abortController.abort(error);
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.#heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.#heartbeatTimer !== undefined) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
    }
  }
}

function captureError(errors: unknown[], action: () => void): void {
  try {
    action();
  } catch (error) {
    errors.push(error);
  }
}
