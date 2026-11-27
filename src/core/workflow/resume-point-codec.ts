import type { WorkflowResumePoint } from '../models/types.js';
import { WorkflowResumePointSchema } from '../models/workflow-resume-schema.js';

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
    ...(resumePoint.missing_report_generations === undefined ? {} : {
      missing_report_generations: Object.fromEntries(
        Object.entries(resumePoint.missing_report_generations)
          .map(([namespace, names]) => [namespace, [...names]]),
      ),
    }),
    ...(resumePoint.report_input_recoveries === undefined ? {} : {
      report_input_recoveries: structuredClone(resumePoint.report_input_recoveries),
    }),
  };
}
