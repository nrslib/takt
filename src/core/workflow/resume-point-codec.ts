import type { WorkflowResumePoint } from '../models/types.js';
import {
  RawWorkflowResumePointSchema,
  WorkflowResumePointSchema,
} from '../models/workflow-resume-schema.js';
import { cloneDynamicParallelSelectionSnapshot } from './dynamic-parallel/snapshot.js';
import {
  parseWorkflowExecutionOwnerIdentity,
  serializeWorkflowExecutionOwnerIdentity,
  type WorkflowExecutionOwnerIdentity,
  type WorkflowExecutionOwnerSegment,
} from '../models/workflow-resume-contract.js';

const LEGACY_WORKFLOW_CALL_NAMESPACE_PATTERN = /^iteration-([1-9]\d*)--step-([^/]+)--workflow-([^/]+)$/;
const LEGACY_CALL_V1_PREFIX = 'call-v1-';

function encodeLegacyValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function legacyStepName(identity: WorkflowExecutionOwnerIdentity): string {
  let lastCallIndex = -1;
  identity.owners.forEach((owner, index) => {
    if (owner.kind === 'workflow_call') {
      lastCallIndex = index;
    }
  });
  return [
    ...identity.owners.slice(lastCallIndex + 1).map((owner) => owner.step),
    identity.step,
  ].join('/');
}

function projectLegacyInvocation(
  invocation: WorkflowExecutionOwnerIdentity,
): WorkflowExecutionOwnerIdentity {
  let lastCallIndex = -1;
  invocation.owners.forEach((owner, index) => {
    if (owner.kind === 'workflow_call') {
      lastCallIndex = index;
    }
  });
  return {
    workflow: invocation.workflow,
    step: invocation.step,
    owners: invocation.owners.slice(lastCallIndex + 1),
  };
}

function decodeCanonicalLegacyValue(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 && encodeLegacyValue(decoded) === value ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function parseCallV1ChildWorkflow(
  identity: string,
  segment: string,
  callInstance: number,
): string | undefined {
  if (!segment.startsWith(LEGACY_CALL_V1_PREFIX)) {
    return undefined;
  }
  const invocation = parseWorkflowExecutionOwnerIdentity(identity);
  if (invocation === undefined) {
    return undefined;
  }
  const fields = segment.slice(LEGACY_CALL_V1_PREFIX.length).split('!');
  if (Number(fields[0]) !== callInstance) {
    return undefined;
  }
  const workflow = decodeCanonicalLegacyValue(fields[1] ?? '');
  const step = decodeCanonicalLegacyValue(fields[2] ?? '');
  const ownerCount = Number(fields[3]);
  if (workflow === undefined || step === undefined || !Number.isInteger(ownerCount) || ownerCount < 0) {
    return undefined;
  }
  const owners: WorkflowExecutionOwnerSegment[] = [];
  let cursor = 4;
  for (let index = 0; index < ownerCount; index += 1) {
    const kind = fields[cursor];
    const ownerWorkflow = fields[cursor + 1] === '='
      ? workflow
      : decodeCanonicalLegacyValue(fields[cursor + 1] ?? '');
    const ownerStep = decodeCanonicalLegacyValue(fields[cursor + 2] ?? '');
    if ((kind !== 'a' && kind !== 's') || ownerWorkflow === undefined || ownerStep === undefined) {
      return undefined;
    }
    owners.push({ workflow: ownerWorkflow, step: ownerStep, kind: kind === 'a' ? 'agent' : 'system' });
    cursor += 3;
  }
  const childWorkflow = decodeCanonicalLegacyValue(fields[cursor] ?? '');
  if (childWorkflow === undefined || cursor !== fields.length - 1) {
    return undefined;
  }
  const parsedInvocation = { workflow, step, owners };
  if (serializeWorkflowExecutionOwnerIdentity(parsedInvocation)
    !== serializeWorkflowExecutionOwnerIdentity(projectLegacyInvocation(invocation))) {
    return undefined;
  }
  const ownerFields = owners.flatMap((owner) => [
    owner.kind === 'agent' ? 'a' : 's',
    owner.workflow === workflow ? '=' : encodeLegacyValue(owner.workflow),
    encodeLegacyValue(owner.step),
  ]);
  const rebuilt = LEGACY_CALL_V1_PREFIX + [
    callInstance,
    encodeLegacyValue(workflow),
    encodeLegacyValue(step),
    owners.length,
    ...ownerFields,
    encodeLegacyValue(childWorkflow),
  ].join('!');
  return rebuilt === segment ? childWorkflow : undefined;
}

function legacyInvocationChildWorkflow(
  identity: string,
  segment: string,
  callInstance: number,
): string {
  const callV1Child = parseCallV1ChildWorkflow(identity, segment, callInstance);
  if (callV1Child !== undefined) {
    return callV1Child;
  }
  const match = LEGACY_WORKFLOW_CALL_NAMESPACE_PATTERN.exec(segment);
  if (match === null) {
    throw new Error(`Invalid workflow-call report namespace segment: ${segment}`);
  }
  const legacyIteration = Number(match[1]);
  const stepName = decodeURIComponent(match[2]!);
  const workflowName = decodeURIComponent(match[3]!);
  const canonicalLegacyShape = `iteration-${legacyIteration}--step-${encodeLegacyValue(stepName)}`
    + `--workflow-${encodeLegacyValue(workflowName)}`;
  if (canonicalLegacyShape !== segment) {
    throw new Error(`Invalid workflow-call report namespace segment: ${segment}`);
  }
  const invocation = parseWorkflowExecutionOwnerIdentity(identity);
  if (invocation === undefined || legacyStepName(invocation) !== stepName) {
    throw new Error(`Workflow-call invocation identity does not match legacy namespace: ${identity}`);
  }
  return workflowName;
}

export function parseWorkflowResumePoint(value: unknown): WorkflowResumePoint {
  const raw = RawWorkflowResumePointSchema.parse(value);
  const canonical = WorkflowResumePointSchema.parse({
    ...raw,
    workflow_call_invocations: Object.fromEntries(
      Object.entries(raw.workflow_call_invocations).map(([identity, record]) => [identity,
        'child_workflow_ref' in record
          ? record
          : {
              call_instance: record.call_instance,
              child_workflow_ref: legacyInvocationChildWorkflow(
                identity,
                record.report_namespace_segment,
                record.call_instance,
              ),
            },
      ]),
    ),
  });
  return cloneWorkflowResumePoint(canonical);
}

export function cloneWorkflowResumePoint(resumePoint: WorkflowResumePoint): WorkflowResumePoint {
  return {
    ...resumePoint,
    ...(resumePoint.max_steps === undefined ? {} : { max_steps: resumePoint.max_steps }),
    ...(resumePoint.pending_loop_judge === undefined
      ? {}
      : {
          pending_loop_judge: {
            ...resumePoint.pending_loop_judge,
            cycle: [...resumePoint.pending_loop_judge.cycle],
          },
        }),
    ...(resumePoint.pending_fallback === undefined
      ? {}
      : {
          pending_fallback: {
            context: { ...resumePoint.pending_fallback.context },
            attempts: resumePoint.pending_fallback.attempts.map((attempt) => ({ ...attempt })),
          },
        }),
    stack: resumePoint.stack.map((entry) => ({
      ...entry,
      ...(entry.step_iterations === undefined ? {} : { step_iterations: { ...entry.step_iterations } }),
    })),
    ...(resumePoint.dynamic_parallel_selections === undefined
      ? {}
      : {
          dynamic_parallel_selections: Object.fromEntries(Object.entries(resumePoint.dynamic_parallel_selections)
            .map(([identity, snapshot]) => [identity, cloneDynamicParallelSelectionSnapshot(snapshot)])),
        }),
    workflow_call_invocations: Object.fromEntries(
      Object.entries(resumePoint.workflow_call_invocations)
        .map(([identity, record]) => [identity, { ...record }]),
    ),
    workflow_step_participations: Object.fromEntries(
      Object.entries(resumePoint.workflow_step_participations)
        .map(([identity, record]) => [
          identity,
          { report_names: [...record.report_names] },
        ]),
    ),
  };
}
