export class OperationRecoveryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OperationRecoveryError';
  }
}

export class OperationJournalConflictError extends OperationRecoveryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OperationJournalConflictError';
  }
}

export const ORPHAN_WORKER_AFTER_DISPATCH_RECOVERY_CODE = 'orphan_worker_after_dispatch';
export const EXPLICIT_PART_FAILURE_RECOVERY_CODE = 'explicit_part_failure';

export interface ManualRestartRequiredErrorOptions extends ErrorOptions {
  readonly boundaryId: string;
}

export class ManualRestartRequiredError extends OperationRecoveryError {
  readonly recoveryCode = ORPHAN_WORKER_AFTER_DISPATCH_RECOVERY_CODE;
  readonly boundaryId: string;

  constructor(message: string, options: ManualRestartRequiredErrorOptions) {
    super(message, options);
    this.name = 'ManualRestartRequiredError';
    this.boundaryId = options.boundaryId;
  }
}

export class ExplicitPartFailureError extends OperationRecoveryError {
  readonly recoveryCode = EXPLICIT_PART_FAILURE_RECOVERY_CODE;
  readonly boundaryId: string;

  constructor(message: string, options: ManualRestartRequiredErrorOptions) {
    super(message, options);
    this.name = 'ExplicitPartFailureError';
    this.boundaryId = options.boundaryId;
  }
}

export class OperationRecoveryBlockedError extends OperationRecoveryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OperationRecoveryBlockedError';
  }
}
