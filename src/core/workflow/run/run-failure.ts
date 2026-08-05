import { sanitizeSensitiveText } from '../../../shared/utils/sensitiveText.js';
import type {
  WorkflowAbortKind,
  WorkflowStepFailureSummary,
  ReviewIntegrityFailureDetails,
} from '../types.js';

interface RunFailureInput {
  readonly kind: WorkflowAbortKind;
  readonly step: string;
  readonly reason: string;
  readonly error: string;
  readonly details?: {
    reviewIntegrity?: ReviewIntegrityFailureDetails;
  };
}

export function createRunFailure(input: RunFailureInput): WorkflowStepFailureSummary {
  return {
    kind: input.kind,
    step: input.step,
    reason: sanitizeSensitiveText(input.reason),
    error: sanitizeSensitiveText(input.error),
    ...(input.details === undefined ? {} : { details: input.details }),
  };
}
