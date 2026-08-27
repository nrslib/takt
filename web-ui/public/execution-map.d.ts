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

export interface EdgePoint {
  readonly x: number;
  readonly y: number;
  readonly side: 'left' | 'right' | 'top' | 'bottom';
}

export function edgeAnchorGeometry(
  sourceRect: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number },
  targetRect: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number },
  canvasRect: { readonly left: number; readonly top: number },
  scale?: number,
  forceLoopPorts?: boolean,
): { readonly source: EdgePoint; readonly target: EdgePoint };

export function curvePath(
  source: EdgePoint,
  target: EdgePoint,
  kind: 'transition' | 'loop' | 'call',
): string;

export interface ExecutionMapOptions {
  readonly liveIndicator: unknown;
  readonly emptyState: unknown;
  readonly selectedStepId?: string | null;
  readonly selectedOccurrenceId: string | null;
  readonly onSelectStep?: (node: ExecutionNode) => void;
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
  selectedStepId?: string | null,
): void;
