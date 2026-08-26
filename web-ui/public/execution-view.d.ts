import type {
  ExecutionEvent,
  ExecutionOccurrence,
  ExecutionTrace,
} from './execution-model.js';

export interface LogSelection {
  readonly events: readonly ExecutionEvent[];
  readonly occurrence: ExecutionOccurrence | null;
  readonly historyPreview: boolean;
}

export function resolveLogSelection(
  trace: ExecutionTrace,
  selectedOccurrenceId: string | null,
): LogSelection;
