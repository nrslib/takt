import type { ResolvedFacetPool } from '../../models/workflow-types.js';
import { buildSelectorGuidanceLines } from '../selector-contract.js';

export interface DynamicFacetSelectorInstructionInput {
  readonly task: string;
  readonly workflowName: string;
  readonly stepName: string;
  readonly workflowCallPath: readonly { readonly step: string }[];
  readonly isReentry: boolean;
  readonly stepIteration: number;
  readonly reports: string;
  readonly unresolvedFindings: string;
  readonly cumulativeDiff: string;
  readonly pool: ResolvedFacetPool;
  readonly maxSelected?: number;
  readonly selectorInstruction?: string;
}

export function buildDynamicFacetSelectorInstruction(input: DynamicFacetSelectorInstructionInput): string {
  const entryType = input.isReentry ? 're-entry' : 'initial entry';
  const callPath = input.workflowCallPath.length === 0
    ? '(root)'
    : input.workflowCallPath.map((entry) => entry.step).join(' > ');
  const candidates = input.pool.candidates
    .map((candidate) => `- ${candidate.id}: ${candidate.description}`)
    .join('\n');
  return [
    'You are TAKT\'s internal dynamic facet selector. Select only candidate IDs from the provided pool.',
    'Return only the requested structured output.',
    ...buildSelectorGuidanceLines(input.selectorInstruction),
    '',
    `Task:\n${input.task}`,
    '',
    `Workflow:\n${input.workflowName}`,
    `Step:\n${input.stepName}`,
    `Workflow call path:\n${callPath}`,
    `Entry type:\n${entryType}`,
    `Step iteration:\n${input.stepIteration}`,
    '',
    `Prior reports:\n${input.reports}`,
    '',
    `Unresolved findings:\n${input.unresolvedFindings}`,
    '',
    `Cumulative diff:\n${input.cumulativeDiff}`,
    '',
    `Candidates:\n${candidates}`,
    '',
    `Max selected:\n${input.maxSelected ?? 'unlimited'}`,
  ].join('\n');
}
