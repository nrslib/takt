import type { StructuredCaller } from '../../../agents/structured-caller.js';
import type {
  AgentWorkflowStep,
  WorkflowPromotionEntry,
} from '../../models/types.js';
import type { ProviderType } from '../../../shared/types/provider.js';

export interface PromotionEvaluationContext {
  cwd: string;
  stepIteration: number;
  previousResponseContent: string;
  structuredCaller?: StructuredCaller;
  resolvedProvider?: ProviderType;
  resolvedModel?: string;
}

function matchesAt(entry: WorkflowPromotionEntry, stepIteration: number): boolean {
  return entry.at !== undefined && stepIteration >= entry.at;
}

async function matchesAiCondition(
  entry: WorkflowPromotionEntry,
  entryIndex: number,
  context: PromotionEvaluationContext,
): Promise<boolean> {
  if (entry.condition === undefined) {
    return false;
  }

  if (entry.aiConditionText === undefined) {
    throw new Error(`Promotion condition at index ${entryIndex} is not normalized`);
  }
  if (context.structuredCaller === undefined) {
    throw new Error(`Promotion condition at index ${entryIndex} requires structuredCaller`);
  }

  const matchedIndex = await context.structuredCaller.evaluateCondition(
    context.previousResponseContent,
    [{ index: entryIndex, text: entry.aiConditionText }],
    {
      cwd: context.cwd,
      provider: context.resolvedProvider,
      resolvedProvider: context.resolvedProvider,
      resolvedModel: context.resolvedModel,
    },
  );
  return matchedIndex === entryIndex;
}

export async function evaluatePromotion(
  step: AgentWorkflowStep,
  context: PromotionEvaluationContext,
): Promise<WorkflowPromotionEntry | undefined> {
  if (!step.promotion || step.promotion.length === 0) {
    return undefined;
  }

  for (let index = step.promotion.length - 1; index >= 0; index--) {
    const entry = step.promotion[index];
    if (!entry) {
      continue;
    }
    if (matchesAt(entry, context.stepIteration)) {
      return entry;
    }
    if (await matchesAiCondition(entry, index, context)) {
      return entry;
    }
  }

  return undefined;
}
