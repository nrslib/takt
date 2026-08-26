export interface ExecutionEvent {
  readonly type: string;
  readonly timestamp?: string;
  readonly step?: string;
  readonly phase?: number;
  readonly phaseName?: string;
  readonly phaseExecutionId?: string;
  readonly iteration?: number;
  readonly persona?: string;
  readonly workflow?: string;
  readonly childWorkflow?: string;
  readonly callInstance?: string;
  readonly stack?: readonly ExecutionStackFrame[];
  readonly status?: string;
  readonly content?: string;
  readonly error?: string;
  readonly reason?: string;
  readonly preview?: string;
  readonly previewTruncated?: boolean;
}

export interface ExecutionStackFrame {
  readonly workflow: string;
  readonly workflow_ref: string;
  readonly step: string;
  readonly kind: 'agent' | 'system' | 'workflow_call' | 'parallel';
  readonly occurrence: number;
}

export interface ExecutionMeta {
  readonly workflow: string;
  readonly status: string;
  readonly currentStep?: string;
  readonly currentIteration?: number;
}

export interface ExecutionOccurrence {
  readonly id: string;
  readonly logicalId: string;
  readonly workflow: string;
  readonly kind: 'step' | 'workflow';
  readonly childWorkflow?: string;
  readonly iteration?: number;
  readonly callInstance?: string;
  readonly stack?: readonly ExecutionStackFrame[];
  readonly status: string;
  readonly phases: readonly string[];
  readonly personas: readonly string[];
  readonly preview?: string;
  readonly previewTruncated?: boolean;
  readonly eventIndexes: readonly number[];
  readonly firstEventIndex: number;
  readonly lastEventIndex: number;
}

export interface ExecutionNode {
  readonly id: string;
  readonly workflow: string;
  readonly kind: 'step' | 'workflow';
  readonly label: string;
  readonly childWorkflow?: string;
  readonly firstEventIndex: number;
  readonly occurrences: readonly ExecutionOccurrence[];
}

export interface ExecutionLane {
  readonly id: string;
  readonly workflow: string;
  readonly depth: number;
  readonly steps: readonly ExecutionNode[];
}

export interface ExecutionTransition {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly sourceLogicalId: string;
  readonly targetLogicalId: string;
  readonly kind: 'transition' | 'loop';
}

export interface ExecutionLoop {
  readonly id: string;
  readonly logicalId: string;
  readonly from: string;
  readonly to: string;
  readonly iteration?: number;
}

export interface ExecutionTrace {
  readonly events: readonly ExecutionEvent[];
  readonly lanes: readonly ExecutionLane[];
  readonly nodes: readonly ExecutionNode[];
  readonly transitions: readonly ExecutionTransition[];
  readonly loops: readonly ExecutionLoop[];
  readonly calls: readonly ExecutionCall[];
  readonly totalOccurrences: number;
  readonly graphOccurrenceCount: number;
  readonly graphTruncated: boolean;
}

export interface ExecutionCall {
  readonly id: string;
  readonly occurrenceId: string;
  readonly workflow: string;
  readonly childWorkflow: string;
  readonly callInstance?: string;
  readonly stack?: readonly ExecutionStackFrame[];
  readonly targetOccurrenceId?: string;
  readonly targetObserved: boolean;
}

export interface ExecutionGraphSummary {
  /** Canonical occurrence snapshots in newest-first order. */
  readonly occurrences: readonly ExecutionEvent[];
  readonly totalOccurrences: number;
  readonly truncated: boolean;
}

export function buildExecutionTrace(
  meta: ExecutionMeta,
  newestFirstEvents: readonly ExecutionEvent[],
  newestFirstHistory?: readonly ExecutionEvent[],
  graphSummary?: ExecutionGraphSummary,
): ExecutionTrace;

export function encodeIdPart(value: string | number): string;

export function reportDisplayName(filename: string): string;
export function reportDirectory(filename: string): string;
