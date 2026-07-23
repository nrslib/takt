import { FindingContractTeamLeaderDecisionValidationError } from '../team-leader-finding-contract-decision.js';

export const FINDING_CONTRACT_DECISION_MAX_ATTEMPTS = 3;
const FINDING_CONTRACT_VALIDATION_ERROR_MAX_LENGTH = 2_000;

export interface FindingContractRejectedDecision {
  attempt: number;
  maxAttempts: number;
  validationError: string;
}

interface FindingContractDecisionRetryOptions<T> {
  abortSignal?: AbortSignal;
  request: (rejectedDecision: FindingContractRejectedDecision | undefined) => Promise<T>;
  validate: (result: T) => void;
  onRejected?: (rejectedDecision: FindingContractRejectedDecision) => void;
}

export async function requestValidFindingContractDecision<T>(
  options: FindingContractDecisionRetryOptions<T>,
): Promise<T> {
  let rejectedDecision: FindingContractRejectedDecision | undefined;
  let lastError: FindingContractTeamLeaderDecisionValidationError | undefined;

  for (let attempt = 1; attempt <= FINDING_CONTRACT_DECISION_MAX_ATTEMPTS; attempt++) {
    options.abortSignal?.throwIfAborted();
    try {
      const result = await options.request(rejectedDecision);
      options.abortSignal?.throwIfAborted();
      options.validate(result);
      return result;
    } catch (error) {
      options.abortSignal?.throwIfAborted();
      if (!(error instanceof FindingContractTeamLeaderDecisionValidationError)) {
        throw error;
      }
      lastError = error;
      if (attempt === FINDING_CONTRACT_DECISION_MAX_ATTEMPTS) {
        throw error;
      }
      rejectedDecision = {
        attempt,
        maxAttempts: FINDING_CONTRACT_DECISION_MAX_ATTEMPTS,
        validationError: boundValidationError(error.message),
      };
      options.onRejected?.(rejectedDecision);
    }
  }

  throw lastError ?? new Error('Finding Contract Team Leader decision retry completed without a result');
}

function boundValidationError(message: string): string {
  if (message.length <= FINDING_CONTRACT_VALIDATION_ERROR_MAX_LENGTH) {
    return message;
  }
  return `${message.slice(0, FINDING_CONTRACT_VALIDATION_ERROR_MAX_LENGTH - 1)}…`;
}
