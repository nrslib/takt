import { sanitizeSensitiveText } from '../../../shared/utils/sensitiveText.js';
import { truncateUtf8PreservingMarker } from '../../../shared/utils/text.js';
import { MAX_AGENT_FAILURE_MESSAGE_BYTES } from '../../../shared/types/agent-failure.js';
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
  const sanitizeAndBound = (text: string): string => truncateUtf8PreservingMarker(
    sanitizeSensitiveText(text),
    MAX_AGENT_FAILURE_MESSAGE_BYTES,
  );

  return {
    kind: input.kind,
    step: input.step,
    reason: sanitizeAndBound(input.reason),
    error: sanitizeAndBound(input.error),
    ...(input.details === undefined ? {} : { details: input.details }),
  };
}
