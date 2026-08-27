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
  readonly provider?: string;
  readonly providerSource?: string;
  readonly model?: string;
  readonly modelSource?: string;
  readonly matchedRuleIndex?: number;
  readonly matchedRuleMethod?: string;
  readonly matchMethod?: string;
  readonly returnValue?: string;
  readonly stage?: number;
  readonly method?: string;
  readonly response?: string;
  readonly judgeStage?: ExecutionJudgeStage;
  readonly judgeStages?: readonly ExecutionJudgeStage[];
  readonly content?: string;
  readonly error?: string;
  readonly reason?: string;
  readonly preview?: string;
  readonly previewTruncated?: boolean;
  /** Stable identity emitted by the server's chronological graph cache. */
  readonly occurrenceId?: string;
}

export interface ExecutionJudgeStage {
  readonly stage: number;
  readonly method: string;
  readonly status: string;
  readonly response: string;
}

export interface ExecutionStackFrame {
  readonly workflow: string;
  readonly workflow_ref: string;
  readonly step: string;
  readonly kind: 'agent' | 'system' | 'workflow_call' | 'parallel';
  readonly occurrence: number;
  /** Optional persisted canonical call-site evidence from newer run logs. */
  readonly workflowCallSiteDigest?: string;
  readonly callSiteDigest?: string;
  readonly siteDigest?: string;
}

export function parallelGroupFamilyKey(
  stack: readonly ExecutionStackFrame[],
  evidence?: ExecutionMeta,
): string | undefined;

export interface ExecutionResumePointEvidence {
  readonly workflow_call_invocations?: Readonly<Record<string, {
    readonly call_instance?: number;
    readonly report_namespace_segment?: string;
    readonly workflowCallSiteDigest?: string;
    readonly callSiteDigest?: string;
    readonly siteDigest?: string;
  }>>;
}

export interface ExecutionMeta {
  readonly workflow: string;
  readonly status: string;
  readonly currentStep?: string;
  readonly currentIteration?: number;
  readonly resumePoint?: ExecutionResumePointEvidence;
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
  /** Terminal status observed from a lifecycle boundary or terminal phase. */
  readonly terminalStatus?: 'completed' | 'failed' | 'aborted';
  readonly phases: readonly string[];
  readonly personas: readonly string[];
  readonly matchedRuleIndex?: number;
  readonly matchedRuleMethod?: string;
  readonly matchMethod?: string;
  readonly returnValue?: string;
  readonly provider?: string;
  readonly providerSource?: string;
  readonly model?: string;
  readonly modelSource?: string;
  readonly judgeStages?: readonly ExecutionJudgeStage[];
  readonly preview?: string;
  readonly previewTruncated?: boolean;
  readonly eventIndexes: readonly number[];
  readonly firstEventIndex: number;
  readonly lastEventIndex: number;
  /** Canonical parent parallel invocation identity, when unambiguous. */
  readonly parallelGroupKey?: string;
  readonly parallelGroupFamilyKey?: string;
  readonly parallelGroupIteration?: number;
  readonly parallelGroupLabel?: string;
  readonly parallelGroupOrdinal?: number;
  readonly parallelGroupAmbiguous?: boolean;
  /** One-based chronological ordinal across all observed step occurrences. */
  readonly ordinal?: number;
}

export interface ExecutionNode {
  readonly id: string;
  readonly workflow: string;
  readonly kind: 'step' | 'workflow';
  readonly label: string;
  /** Human-readable label; raw label/id remains available for identity. */
  readonly displayLabel?: string;
  readonly displayWorkflow?: string;
  readonly childWorkflow?: string;
  readonly firstEventIndex: number;
  readonly occurrences: readonly ExecutionOccurrence[];
}

export interface ExecutionLane {
  readonly id: string;
  readonly workflow: string;
  readonly displayWorkflow?: string;
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
  readonly ordinal?: number;
}

export interface ExecutionParallelGroup {
  readonly key: string;
  readonly familyKey: string;
  readonly label?: string;
  readonly ordinal: number;
  readonly iteration?: number;
  readonly firstEventIndex: number;
  readonly nodeIds: readonly string[];
  readonly occurrenceIds: readonly string[];
}

export interface ExecutionTrace {
  readonly events: readonly ExecutionEvent[];
  readonly lanes: readonly ExecutionLane[];
  readonly nodes: readonly ExecutionNode[];
  readonly transitions: readonly ExecutionTransition[];
  readonly loops: readonly ExecutionLoop[];
  readonly parallelGroups: readonly ExecutionParallelGroup[];
  readonly calls: readonly ExecutionCall[];
  readonly totalOccurrences: number;
  readonly graphOccurrenceCount: number;
  readonly graphTruncated: boolean;
}

export interface ExecutionCall {
  readonly id: string;
  readonly occurrenceId: string;
  readonly workflow: string;
  readonly step: string;
  readonly childWorkflow: string;
  readonly displayWorkflow?: string;
  readonly displayChildWorkflow?: string;
  readonly callInstance?: string;
  readonly stack?: readonly ExecutionStackFrame[];
  readonly startEventIndex?: number;
  readonly completeEventIndex?: number;
  /** True only when a workflow_call_start was observed for this occurrence. */
  readonly startObserved: boolean;
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
  locale?: 'ja' | 'en',
): ExecutionTrace;

export function encodeIdPart(value: string | number): string;
export function isBuiltinWorkflowRef(value: unknown): boolean;
export function shortBuiltinDigest(value: unknown): string;
export function workflowDisplayName(value: string, locale?: 'ja' | 'en', stack?: readonly ExecutionStackFrame[]): string;

export function reportDisplayName(filename: string): string;
export function reportDirectory(filename: string): string;
