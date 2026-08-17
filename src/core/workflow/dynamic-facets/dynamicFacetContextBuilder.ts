import type {
  AgentWorkflowStep,
  DynamicFacetSelectionSnapshot,
  ResolvedFacetContent,
  ResolvedFacetPool,
} from '../../models/workflow-types.js';
import { buildSelectorGuidanceLines } from '../selector-contract.js';

export interface DynamicFacetSelectorInstructionInput {
  readonly task: string;
  readonly workflowName: string;
  readonly stepName: string;
  readonly workflowCallPath: readonly { readonly step: string }[];
  readonly previousSnapshot?: DynamicFacetSelectionSnapshot;
  readonly stepIteration: number;
  readonly reportDirectory: string;
  readonly reportNames: readonly string[];
  readonly changedPaths: readonly string[];
  readonly targetAgentPrompt: string;
  readonly pool: ResolvedFacetPool;
  readonly maxSelected?: number;
  readonly selectorInstruction?: string;
}

function joinFacetContents(contents: readonly ResolvedFacetContent[] | undefined): string {
  if (contents === undefined || contents.length === 0) return '(none)';
  return contents.map(({ content }) => content).join('\n\n---\n\n');
}

function renderList(values: readonly string[]): string {
  return values.length === 0 ? '(none)' : values.map((value) => `- ${value}`).join('\n');
}

export function buildDynamicFacetTargetAgentPrompt(step: AgentWorkflowStep): string {
  return [
    ...(step.persona === undefined ? [] : [`Persona:\n${step.persona}`]),
    `Policy:\n${joinFacetContents(step.policyContents)}`,
    `Knowledge:\n${joinFacetContents(step.knowledgeContents)}`,
    `Instruction:\n${step.instruction}`,
  ].join('\n\n');
}

export function buildDynamicFacetSelectorInstruction(input: DynamicFacetSelectorInstructionInput): string {
  const entryType = input.previousSnapshot === undefined ? 'initial entry' : 're-entry';
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
    ...(input.previousSnapshot === undefined
      ? []
      : [
          '',
          'Previous selection snapshot:',
          `round: ${input.previousSnapshot.round}`,
          `selected_ids:\n${renderList(input.previousSnapshot.selected_ids)}`,
          `selected_policy_refs:\n${renderList(input.previousSnapshot.selected_policy_refs)}`,
          `selected_knowledge_refs:\n${renderList(input.previousSnapshot.selected_knowledge_refs)}`,
          `rationale:\n${input.previousSnapshot.rationale}`,
        ]),
    `Step iteration:\n${input.stepIteration}`,
    '',
    `Report Directory:\n${input.reportDirectory}`,
    '',
    `Reports to inspect:\n${renderList(input.reportNames)}`,
    '',
    `Changed file paths:\n${renderList(input.changedPaths)}`,
    '',
    `Target agent prompt:\n${input.targetAgentPrompt}`,
    '',
    `Candidates:\n${candidates}`,
    '',
    `Max selected:\n${input.maxSelected ?? 'unlimited'}`,
  ].join('\n');
}
