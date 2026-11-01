import type { z } from 'zod';
import type { WorkflowReportInputRawSchema } from '../../../core/models/workflow-schemas.js';
import type { WorkflowReportInput, WorkflowStep } from '../../../core/models/workflow-types.js';

type RawInput = z.infer<typeof WorkflowReportInputRawSchema>;

export function normalizeReportInputs(input: RawInput | undefined): WorkflowStep['inputReports'] {
  if (input === undefined) return undefined;
  const normalize = (entry: Exclude<RawInput, unknown[]>): WorkflowReportInput => ({
    fromStep: entry.from_step,
    reports: entry.reports,
    optionalIfUnrun: entry.optional_if_unrun,
    ...(entry.history === undefined ? {} : { history: entry.history }),
  });
  return Array.isArray(input) ? input.map(normalize) : normalize(input);
}
