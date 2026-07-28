import type {
  LeaseHandle,
  RunStorageRoot,
} from '../../../infra/run-storage/index.js';
import {
  RunCleanupError,
  type RunCommitFinalization,
  type RunFinalization,
  type WorkflowRunTerminalOutcome,
} from './workflowRunExecution.js';

const HEARTBEAT_INTERVAL_MS = 10_000;
const LEASE_DURATION_MS = 30_000;

export class SqliteWorkflowRunStorageLifecycle {
  readonly #root: RunStorageRoot;
  readonly #lease: LeaseHandle;
  readonly #abortController: AbortController;
  #heartbeatFailure: unknown;
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  #finished = false;
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

  finish(
    outcome: WorkflowRunTerminalOutcome,
    publicationPayload: string,
  ): RunCommitFinalization {
    this.assertActive();
    assertTerminalOutcome(outcome);
    this.#finished = true;
    this.stopHeartbeat();

    let commitError: unknown;
    let commitReceipt: ReturnType<RunStorageRoot['finishRun']> | undefined;
    try {
      commitReceipt = this.#root.finishRun(this.#lease, {
        status: outcome.status,
        ...(outcome.status === 'failed' && outcome.reason !== undefined
          ? { failureReason: outcome.reason }
          : {}),
        publication: {
          status: outcome.status === 'cancelled'
            ? 'aborted'
            : outcome.status,
          iteration: outcome.iteration,
          ...(outcome.reason === undefined
            ? {}
            : { reason: outcome.reason }),
          payload: publicationPayload,
        },
      });
    } catch (error) {
      commitError = error;
    }

    const cleanupErrors: unknown[] = [];
    if (commitError !== undefined) {
      captureError(cleanupErrors, () => {
        this.#root.releaseLease(this.#lease);
      });
    }
    this.closeRoot(cleanupErrors);
    if (commitError !== undefined) {
      throwWithCleanup(commitError, cleanupErrors);
    }
    if (commitReceipt === undefined) {
      throw new Error('SQLite terminal commit receipt is missing');
    }
    return Object.freeze({
      receipt: Object.freeze({
        runId: commitReceipt.runId,
        publicationId: commitReceipt.eventId,
        runStatus: outcome.status,
        iteration: commitReceipt.iteration,
        payloadSha256: commitReceipt.payloadDigest,
        proof: {
          backend: 'sqlite' as const,
          terminalAt: commitReceipt.terminalAt,
        },
      }),
      issues: Object.freeze(
        cleanupErrors.map((error) => new RunCleanupError(error)),
      ),
    });
  }

  closeUnfinished(): RunFinalization {
    this.assertActive();
    this.#finished = true;
    this.stopHeartbeat();
    const cleanupErrors: unknown[] = [];
    captureError(cleanupErrors, () => {
      this.#root.releaseLease(this.#lease);
    });
    this.closeRoot(cleanupErrors);
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

  private assertActive(): void {
    if (this.#closed || this.#finished) {
      throw new Error('SQLite workflow run storage lifecycle is finished');
    }
  }

  private closeRoot(errors: unknown[]): void {
    this.#closed = true;
    captureError(errors, () => {
      this.#root.close();
    });
  }
}

function assertTerminalOutcome(outcome: WorkflowRunTerminalOutcome): void {
  if (
    outcome.status !== 'completed'
    && (outcome.reason?.length ?? 0) === 0
  ) {
    throw new Error('SQLite terminal failure publication requires a reason');
  }
}

function captureError(errors: unknown[], action: () => void): void {
  try {
    action();
  } catch (error) {
    errors.push(error);
  }
}

function throwWithCleanup(
  primaryError: unknown,
  cleanupErrors: readonly unknown[],
): never {
  if (cleanupErrors.length === 0) {
    throw primaryError;
  }
  throw new AggregateError(
    [primaryError, ...cleanupErrors],
    errorMessage(primaryError),
    { cause: primaryError },
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
