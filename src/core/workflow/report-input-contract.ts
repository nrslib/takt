import { basename } from 'node:path';
import { getAllParallelSubSteps, type WorkflowConfig, type WorkflowStep } from '../models/types.js';
import { reportInputEntries } from '../models/workflow-report-input.js';
import type { WorkflowCallResolver } from './types.js';
import { getReportFiles } from './output-contract-files.js';
import { getWorkflowReference } from './workflow-reference.js';
import { MAX_WORKFLOW_CALL_DEPTH } from './workflow-call-depth.js';
import { classifyReportRelativePath } from '../models/reserved-report-names.js';

interface ReportInputContractContext {
  readonly workflowCallResolver?: WorkflowCallResolver;
  readonly projectCwd: string;
  readonly lookupCwd: string;
}

function validateParallelReportNames(step: WorkflowStep, selected: ReadonlySet<string> | undefined): void {
  const publications = new Set<string>();
  for (const child of step.parallel === undefined ? [] : getAllParallelSubSteps(step.parallel)) {
    for (const path of getReportFiles(child.outputContracts)) {
      if (publications.has(path) && (selected === undefined || selected.has(basename(path)))) {
        throw new Error(`Report input "${basename(path)}" has ambiguous parallel producers`);
      }
      publications.add(path);
    }
  }
}

/** Reserve names before checking execution evidence, including optional sources. */
export function reportInputNames(
  workflow: WorkflowConfig,
  consumer: Pick<WorkflowStep, 'name' | 'inputReports'>,
  context: ReportInputContractContext,
): readonly (readonly string[])[] {
  const collect = (step: WorkflowStep, owner: WorkflowConfig, ancestors: readonly string[]): string[] => {
    const names = [...getReportFiles(step.outputContracts)];
    validateParallelReportNames(step, undefined);
    const parallel = step.parallel === undefined ? [] : getAllParallelSubSteps(step.parallel);
    for (const child of parallel) {
      names.push(...collect(child, owner, ancestors));
    }
    if (step.kind === 'workflow_call') {
      const child = context.workflowCallResolver?.({ parentWorkflow: owner, step, projectCwd: context.projectCwd, lookupCwd: context.lookupCwd });
      if (child == null) throw new Error(`Report input source workflow "${step.call}" could not be resolved`);
      const reference = getWorkflowReference(child);
      if (ancestors.includes(reference) || ancestors.length >= MAX_WORKFLOW_CALL_DEPTH) {
        throw new Error(`Report input source workflow "${step.call}" is recursive or exceeds call depth`);
      }
      for (const childStep of child.steps) names.push(...collect(childStep, child, [...ancestors, reference]));
    }
    return names.map((name) => basename(name));
  };
  const reserved = new Set<string>();
  return reportInputEntries(consumer.inputReports).map((input) => {
    const source = workflow.steps.find((step) => step.name === input.fromStep);
    if (source === undefined || source.name === consumer.name || source.kind === 'system') {
      throw new Error(`Invalid report input source "${input.fromStep}"`);
    }
    if (source.kind !== 'workflow_call' && source.parallel === undefined && getReportFiles(source.outputContracts).length === 0) {
      throw new Error(`Report input source "${input.fromStep}" has no report output contract`);
    }
    if (input.reports !== 'all') validateParallelReportNames(source, new Set(input.reports));
    const names = input.reports === 'all'
      ? [...new Set(collect(source, workflow, [getWorkflowReference(workflow)]))]
      : input.reports;
    for (const name of names) {
      if (classifyReportRelativePath(name).kind !== 'public' || name.includes('/')) throw new Error(`Report inputs require a public report name: "${name}"`);
      if (reserved.has(name)) throw new Error(`Report input "${name}" has ambiguous declared producers`);
      reserved.add(name);
    }
    return names;
  });
}
