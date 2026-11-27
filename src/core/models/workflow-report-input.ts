import type { WorkflowReportInput, WorkflowStep } from './workflow-types.js';

export function reportInputEntries(input: WorkflowStep['inputReports']): readonly WorkflowReportInput[] {
  if (input === undefined) return [];
  return Array.isArray(input) ? input : [input as WorkflowReportInput];
}
