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

export class ManualRestartRequiredError extends OperationRecoveryError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ManualRestartRequiredError';
  }
}
