export const WORKFLOW_RESUME_FRAME_KINDS = [
  'agent',
  'system',
  'workflow_call',
  'parallel',
] as const;

export type WorkflowResumeFrameKind = typeof WORKFLOW_RESUME_FRAME_KINDS[number];

export interface CanonicalWorkflowResumeFrame {
  readonly workflow: string;
  readonly workflow_ref: string;
  readonly step: string;
  readonly kind: WorkflowResumeFrameKind;
  readonly occurrence: number;
}

const WORKFLOW_RESUME_FRAME_KIND_SET: ReadonlySet<string> = new Set(
  WORKFLOW_RESUME_FRAME_KINDS,
);

export function isWorkflowResumeFrameKind(
  value: unknown,
): value is WorkflowResumeFrameKind {
  return typeof value === 'string'
    && WORKFLOW_RESUME_FRAME_KIND_SET.has(value);
}

export function parseCanonicalWorkflowResumeFrame(
  value: unknown,
  path = 'workflow resume frame',
): CanonicalWorkflowResumeFrame {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  const frame = value as Readonly<Record<string, unknown>>;
  const workflow = requireNonEmptyString(frame.workflow, `${path}.workflow`);
  const workflowRef = requireNonEmptyString(
    frame.workflow_ref,
    `${path}.workflow_ref`,
  );
  const step = requireNonEmptyString(frame.step, `${path}.step`);
  if (!isWorkflowResumeFrameKind(frame.kind)) {
    throw new Error(`${path}.kind is invalid`);
  }
  if (!Number.isSafeInteger(frame.occurrence) || (frame.occurrence as number) <= 0) {
    throw new Error(`${path}.occurrence must be a positive safe integer`);
  }
  return Object.freeze({
    workflow,
    workflow_ref: workflowRef,
    step,
    kind: frame.kind,
    occurrence: frame.occurrence as number,
  });
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}
