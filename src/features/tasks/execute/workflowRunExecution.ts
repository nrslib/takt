import type {
  WorkflowRunTerminalStatus,
} from './workflowTerminalStatus.js';
import type {
  WorkflowTerminalPublicationPayload,
} from './workflowTerminalPayload.js';

export interface WorkflowRunExecutionHandle {
  run<T>(
    operation: (control: WorkflowRunExecutionControl) => Promise<T>,
  ): Promise<T>;
  finish(
    outcome: WorkflowRunTerminalOutcome,
    payload: WorkflowTerminalPublicationPayload,
  ): Promise<RunCommitFinalization>;
}

export interface WorkflowRunExecutionControl {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}

export interface WorkflowRunTerminalOutcome {
  readonly status: WorkflowRunTerminalStatus;
  readonly iteration: number;
  readonly reason?: string;
}

export interface RunFinalization {
  readonly receipt?: TerminalCommitReceipt;
  readonly issues: readonly RunFinalizationIssue[];
}

export interface RunCommitFinalization extends RunFinalization {
  readonly receipt: TerminalCommitReceipt;
}

export interface TerminalCommitReceipt {
  readonly runId: string;
  readonly publicationId: string;
  readonly runStatus: WorkflowRunTerminalStatus;
  readonly iteration: number;
  readonly payloadSha256: string;
  readonly proof:
    | {
        readonly backend: 'file';
      }
    | {
        readonly backend: 'sqlite';
        readonly terminalAt: number;
      };
}

export type RunFinalizationIssue =
  | RunProjectionError
  | RunCleanupError
  | AuthorityPostCommitIssue
  | RunLiveDeliveryError;

export class AuthorityPostCommitIssue extends Error {
  constructor(error: unknown) {
    super(errorMessage(error), { cause: error });
    this.name = 'AuthorityPostCommitIssue';
  }
}

export class RunProjectionError extends Error {
  readonly stage: 'publication' | 'meta' | 'session' | 'trace';

  constructor(
    stage: RunProjectionError['stage'],
    error: unknown,
  ) {
    super(errorMessage(error), { cause: error });
    this.name = 'RunProjectionError';
    this.stage = stage;
  }
}

export class RunCleanupError extends Error {
  constructor(error: unknown) {
    super(errorMessage(error), { cause: error });
    this.name = 'RunCleanupError';
  }
}

export class RunLiveDeliveryError extends Error {
  constructor(error: unknown) {
    super(errorMessage(error), { cause: error });
    this.name = 'RunLiveDeliveryError';
  }
}

export class WorkflowRunExecutionControlError extends AggregateError {
  constructor(
    primaryError: unknown,
    operationError: unknown,
  ) {
    super(
      primaryError === operationError
        ? [primaryError]
        : [primaryError, operationError],
      errorMessage(primaryError),
      { cause: primaryError },
    );
    this.name = 'WorkflowRunExecutionControlError';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
