import type {
  ExecutionNode,
  ExecutionOccurrence,
  ExecutionTrace,
} from './execution-model.js';

export interface ExecutionMapElement {
  querySelectorAll(selector: string): readonly unknown[];
}

export interface ExecutionMapOptions {
  readonly liveIndicator: unknown;
  readonly emptyState: unknown;
  readonly selectedOccurrenceId: string | null;
  readonly onSelectOccurrence: (node: ExecutionNode, occurrence: ExecutionOccurrence) => void;
}

export function renderExecutionMap(
  trace: ExecutionTrace,
  options: ExecutionMapOptions,
): ExecutionMapElement;

export function disposeExecutionMap(container: ExecutionMapElement): void;

export function updateExecutionMapSelection(
  container: ExecutionMapElement,
  selectedOccurrenceId: string | null,
): void;
