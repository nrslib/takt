export interface ExecutionEvent {
  readonly type: string;
  readonly timestamp?: string;
  readonly step?: string;
  readonly phaseName?: string;
  readonly iteration?: number;
  readonly persona?: string;
  readonly workflow?: string;
  readonly childWorkflow?: string;
  readonly callInstance?: string;
  readonly status?: string;
}

export interface ExecutionMeta {
  readonly workflow: string;
  readonly status: string;
  readonly currentStep?: string;
  readonly currentIteration?: number;
}

export interface ExecutionNode {
  readonly id: string;
  readonly kind: 'step' | 'workflow';
  readonly label: string;
  readonly eyebrow: string;
  readonly status: string;
  readonly iteration?: number;
  readonly persona?: string;
  readonly phases: readonly string[];
  readonly eventIndexes: readonly number[];
}

export function buildExecutionTrace(
  meta: ExecutionMeta,
  newestFirstEvents: readonly ExecutionEvent[],
): {
  readonly events: readonly ExecutionEvent[];
  readonly nodes: readonly ExecutionNode[];
  readonly edges: readonly { readonly id: string; readonly source: string; readonly target: string }[];
};

export function reportDisplayName(filename: string): string;
export function reportDirectory(filename: string): string;
