import type { WorkflowResumePoint } from '../models/types.js';
import { WorkflowResumePointSchema } from '../models/workflow-resume-schema.js';
import { cloneDynamicParallelSelectionSnapshot } from './dynamic-parallel/snapshot.js';

export function parseWorkflowResumePoint(value: unknown): WorkflowResumePoint {
  return cloneWorkflowResumePoint(WorkflowResumePointSchema.parse(value));
}

export function cloneWorkflowResumePoint(resumePoint: WorkflowResumePoint): WorkflowResumePoint {
  return {
    ...resumePoint,
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
