import type {
  DynamicParallelPoolSubStep,
  DynamicParallelSubSteps,
  DynamicParallelSelectionSnapshot,
  WorkflowResumePointEntry,
} from '../../models/types.js';
import { resolveReportReferencePath } from '../instruction/report-reference.js';
import { buildResumeReportConsumerKey } from '../run/resume-report-consumer.js';
import { buildSelectorGuidanceLines } from '../selector-contract.js';

export interface SelectorReportNamesInput {
  readonly reportDirectory: string;
  readonly reportsRootDirectory: string;
  readonly reportNames: readonly string[];
  readonly stepName: string;
  readonly workflowReference: string;
  readonly workflowCallPath: readonly WorkflowResumePointEntry[];
}

export function resolveSelectorReportNames(input: SelectorReportNamesInput): readonly string[] {
  const resumeReportConsumerKey = buildResumeReportConsumerKey(
    input.workflowReference,
    input.stepName,
    input.workflowCallPath,
  );
  return [...new Set(input.reportNames.flatMap((reference) => {
    const resolved = resolveReportReferencePath(input.reportDirectory, reference, {
      stepName: input.stepName,
      reportsRootDir: input.reportsRootDirectory,
      resumeReportConsumerKey,
    });
    return resolved === undefined ? [] : [resolved.path];
  }))];
}

export interface DynamicSelectorInput {
  readonly task: string;
  readonly reportDirectory: string;
  readonly reportNames: readonly string[];
  readonly changedPaths: readonly string[];
  readonly pool: readonly DynamicParallelPoolSubStep[];
  readonly selection: DynamicParallelSubSteps['selection'];
  readonly previousSnapshot?: DynamicParallelSelectionSnapshot;
  readonly selectorInstruction?: string;
}

function renderList(values: readonly string[]): string {
  return values.length === 0 ? '(none)' : values.map((value) => `- ${value}`).join('\n');
}

export function buildDynamicSelectorInstruction(input: DynamicSelectorInput): string {
  const candidates = input.pool.map((subStep) => {
    const candidate = `- ${subStep.name}: ${subStep.description}`;
    return subStep.selectionHint === undefined
      ? candidate
      : `${candidate}\n  Selection hint: ${subStep.selectionHint}`;
  }).join('\n');
  return [
    'Select the pool reviewer IDs that are required for this task.',
    'Return only the requested structured output.',
    'Each candidate line states what the reviewer does. When a candidate has a "Selection hint", follow it to decide whether to select that candidate; otherwise decide from what the reviewer does.',
    ...buildSelectorGuidanceLines(input.selectorInstruction),
    '',
    `Task:\n${input.task}`,
    '',
    `Report Directory:\n${input.reportDirectory}`,
    '',
    `Reports to inspect:\n${renderList(input.reportNames)}`,
    '',
    `Changed file paths:\n${renderList(input.changedPaths)}`,
    ...(input.selection.mode === 'cumulative'
      ? ['', `Previously selected pool IDs:\n${input.previousSnapshot?.selected_pool_ids.join(', ') || '(none)'}`]
      : []),
    '',
    `Entry type:\n${input.previousSnapshot === undefined ? 'initial entry' : 're-entry after a prior round'}`,
    '',
    `Candidates:\n${candidates}`,
  ].join('\n');
}
