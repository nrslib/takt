import type {
  ExecutionEvent,
  ExecutionOccurrence,
  ExecutionTrace,
} from './execution-model.js';

export interface LogSelection {
  readonly events: readonly ExecutionEvent[];
  readonly occurrence: ExecutionOccurrence | null;
  readonly historyPreview: boolean;
  readonly scope: 'run' | 'iteration';
}

export function resolveLogSelection(
  trace: ExecutionTrace,
  selectedOccurrenceId: string | null,
): LogSelection;

export interface ExecutionViewController {
  renderTaskList(tasks: readonly unknown[], selection: unknown): void;
  renderDetail(detail: unknown, selection: { readonly projectId: string; readonly slug: string }): boolean;
  renderPlaceholder(): void;
  prepareRunSelection(selection: { readonly projectId: string; readonly slug: string }): void;
  refreshLocale(): void;
  dispose(): void;
  setLiveState(state: string): void;
}

export function createExecutionView(options: unknown): ExecutionViewController;
