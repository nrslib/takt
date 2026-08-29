import type {
  ExecutionNode,
  ExecutionOccurrence,
  ExecutionParallelGroup,
  ExecutionTrace,
} from './execution-model.js';

export interface ExecutionMapElement {
  querySelectorAll(selector: string): readonly unknown[];
}

export const MIN_MAP_SCALE: number;
export const MAX_MAP_SCALE: number;
export const DEFAULT_MAP_SCALE: number;
export function clampMapScale(value: number): number;
export function parallelGroupPresentationOrdinal(
  trace: ExecutionTrace,
  groupKey: string | null | undefined,
): number | undefined;

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
  portRects?: {
    readonly source?: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };
    readonly target?: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };
  },
): { readonly source: EdgePoint; readonly target: EdgePoint };

export function curvePath(
  source: EdgePoint,
  target: EdgePoint,
  kind: 'transition' | 'loop' | 'call' | 'parallel',
): string;

export interface ExecutionMapOptions {
  readonly liveIndicator: unknown;
  readonly emptyState: unknown;
  readonly selectedStepId?: string | null;
  readonly selectedOccurrenceId: string | null;
  readonly selectedParallelGroupKey?: string | null;
  readonly onSelectStep?: (node: ExecutionNode) => void;
  readonly onSelectOccurrence: (node: ExecutionNode, occurrence: ExecutionOccurrence) => void;
  readonly onSelectParallelGroup?: (
    group: ExecutionParallelGroup,
    iteration: {
      readonly key: string;
      readonly ordinal: number;
      readonly familyKey?: string;
      readonly iteration?: number;
    },
  ) => void;
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
  selectedParallelGroupKey?: string | null,
): void;
