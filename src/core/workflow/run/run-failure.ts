import { sanitizeSensitiveText } from '../../../shared/utils/sensitiveText.js';
import type {
  WorkflowAbortKind,
  WorkflowStepFailureSummary,
} from '../types.js';

interface RunFailureInput {
  readonly kind: WorkflowAbortKind;
  readonly step: string;
  readonly reason: string;
  readonly error: string;
}

export function createRunFailure(input: RunFailureInput): WorkflowStepFailureSummary {
  return {
    kind: input.kind,
    step: input.step,
    reason: sanitizeSensitiveText(input.reason),
    error: sanitizeSensitiveText(input.error),
  };
}
