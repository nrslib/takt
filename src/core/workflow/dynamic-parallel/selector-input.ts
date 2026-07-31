import type {
  DynamicParallelPoolSubStep,
  DynamicParallelSubSteps,
  DynamicParallelSelectionSnapshot,
} from '../../models/types.js';

export interface DynamicSelectorInput {
  readonly task: string;
  readonly reports: string;
  readonly workingTreeDiff: string;
  readonly pool: readonly DynamicParallelPoolSubStep[];
  readonly selection: DynamicParallelSubSteps['selection'];
  readonly previousSnapshot?: DynamicParallelSelectionSnapshot;
}

export function buildDynamicSelectorInstruction(input: DynamicSelectorInput): string {
  const candidates = input.pool.map((subStep) => `- ${subStep.name}: ${subStep.description}`).join('\n');
  return [
    'Select the pool reviewer IDs that are required for this task.',
    'Return only the requested structured output.',
    '',
    `Task:\n${input.task}`,
    '',
    `Prior reports:\n${input.reports}`,
    '',
    `Current working-tree diff against HEAD:\n${input.workingTreeDiff}`,
    ...(input.selection.mode === 'cumulative'
      ? ['', `Previously selected pool IDs:\n${input.previousSnapshot?.selected_pool_ids.join(', ') || '(none)'}`]
      : []),
    '',
    `Entry type:\n${input.previousSnapshot === undefined ? 'initial entry' : 're-entry after a prior round'}`,
    '',
    `Candidates:\n${candidates}`,
  ].join('\n');
}
