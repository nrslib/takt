import { COMPANION_OUTPUT_LIMITS } from './output-envelope.js';

export const COMPANION_CUMULATIVE_LIMITS = {
  maxFindingsPerMailbox: 256,
  maxDeferredFindingsPerMailbox: 100,
  maxRecordsPerMailbox: 1_024,
  maxMailboxProjectionBytes: 1024 * 1024,
  maxPromptBytes: 640 * 1024,
  maxTrackedTransitions: 256,
  maxTransitionsPerRound: COMPANION_OUTPUT_LIMITS.maxArrayItems,
} as const;

export type CompanionCapacityKind =
  | 'deferred_findings'
  | 'mailbox_findings'
  | 'mailbox_projection_bytes'
  | 'mailbox_records'
  | 'prompt_bytes';

export class CompanionCapacityError extends Error {
  readonly name = 'CompanionCapacityError';

  constructor(readonly kind: CompanionCapacityKind) {
    super(`Companion cumulative capacity exceeded (${kind})`);
  }
}

export function isCompanionCapacityError(error: unknown): error is CompanionCapacityError {
  return error instanceof CompanionCapacityError;
}

export function assertCompanionCapacity(
  condition: boolean,
  kind: CompanionCapacityKind,
): void {
  if (!condition) throw new CompanionCapacityError(kind);
}
