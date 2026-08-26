import type {
  ExecutionNode,
  ExecutionOccurrence,
  ExecutionTrace,
} from './execution-model.js';

export interface ExecutionMapElement {
  querySelectorAll(selector: string): readonly unknown[];
}

export const MIN_MAP_SCALE: number;
export const MAX_MAP_SCALE: number;
export const DEFAULT_MAP_SCALE: number;
export function clampMapScale(value: number): number;

export interface ExecutionMapOptions {
  readonly liveIndicator: unknown;
  readonly emptyState: unknown;
  readonly selectedOccurrenceId: string | null;
  readonly onSelectOccurrence: (node: ExecutionNode, occurrence: ExecutionOccurrence) => void;
  readonly customNodePositions?: ReadonlyMap<string, { readonly x: number; readonly y: number }>;
  readonly onMoveNode?: (
    nodeId: string,
    position: { readonly x: number; readonly y: number },
  ) => void;
  readonly scale?: number;
  readonly onScaleChange?: (scale: number) => void;
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
