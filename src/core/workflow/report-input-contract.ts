import { basename } from 'node:path';
import { getAllParallelSubSteps, type WorkflowConfig, type WorkflowStep } from '../models/types.js';
import { reportInputEntries } from '../models/workflow-report-input.js';
import type { WorkflowReportInput } from '../models/workflow-types.js';
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
  const paths = new Set<string>();
  const publications = new Set<string>();
  for (const child of step.parallel === undefined ? [] : getAllParallelSubSteps(step.parallel)) {
    for (const path of getReportFiles(child.outputContracts)) {
      if (selected === undefined && paths.has(path)) continue;
      paths.add(path);
      const name = basename(path);
      if (publications.has(name) && (selected === undefined || selected.has(name))) {
        throw new Error(`Report input "${name}" has ambiguous parallel producers`);
      }
      publications.add(name);
    }
  }
}

/** Reserve names before checking execution evidence, including optional sources. */
export function reportInputNames(
  workflow: WorkflowConfig,
  consumer: Pick<WorkflowStep, 'name' | 'inputReports'>,
  context: ReportInputContractContext,
  skipNestedContractResolution?: (input: WorkflowReportInput) => boolean,
): readonly (readonly string[])[] {
  const collect = (
    step: WorkflowStep,
    owner: WorkflowConfig,
    ancestors: readonly string[],
    selected: ReadonlySet<string> | undefined,
  ): string[] => {
    const names = [...getReportFiles(step.outputContracts)];
    validateParallelReportNames(step, selected);
    const parallel = step.parallel === undefined ? [] : getAllParallelSubSteps(step.parallel);
    for (const child of parallel) {
      names.push(...collect(child, owner, ancestors, selected));
    }
    if (step.kind === 'workflow_call') {
      const child = context.workflowCallResolver?.({ parentWorkflow: owner, step, projectCwd: context.projectCwd, lookupCwd: context.lookupCwd });
      if (child == null) throw new Error(`Report input source workflow "${step.call}" could not be resolved`);
      const reference = getWorkflowReference(child);
      if (ancestors.includes(reference) || ancestors.length >= MAX_WORKFLOW_CALL_DEPTH) {
        throw new Error(`Report input source workflow "${step.call}" is recursive or exceeds call depth`);
      }
      for (const childStep of child.steps) names.push(...collect(childStep, child, [...ancestors, reference], selected));
    }
    return names;
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
    const selected = input.reports === 'all' ? undefined : new Set(input.reports);
    const paths = input.reports !== 'all' && skipNestedContractResolution?.(input) === true
      ? input.reports
      : [...new Set(collect(source, workflow, [getWorkflowReference(workflow)], selected))];
    if (selected !== undefined) {
      for (const name of selected) {
        const matches = paths.filter((path) => basename(path) === name);
        if (new Set(matches).size > 1) throw new Error(`Report input "${name}" has ambiguous declared producers`);
      }
    }
    const names = input.reports === 'all' ? paths.map((path) => basename(path)) : input.reports;
    for (const name of names) {
      if (classifyReportRelativePath(name).kind !== 'public' || name.includes('/')) throw new Error(`Report inputs require a public report name: "${name}"`);
      if (reserved.has(name)) throw new Error(`Report input "${name}" has ambiguous declared producers`);
      reserved.add(name);
    }
    return names;
  });
}
