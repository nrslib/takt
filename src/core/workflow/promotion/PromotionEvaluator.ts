import type { StructuredCaller } from '../../../agents/structured-caller.js';
import type {
  AgentWorkflowStep,
  WorkflowPromotionEntry,
} from '../../models/types.js';
import type { RunAgentOptions } from '../../../agents/runner.js';
import type { ProviderType } from '../../../shared/types/provider.js';
import type { PermissionMode } from '../../models/types.js';
import type { StepProviderOptions } from '../../models/workflow-types.js';

export interface PromotionEvaluationContext {
  cwd: string;
  stepIteration: number;
  previousResponseContent: string;
  structuredCaller?: StructuredCaller;
  resolvedProvider?: ProviderType;
  resolvedModel?: string;
  resolvedProviderOptions?: StepProviderOptions;
  permissionMode?: PermissionMode;
  childProcessEnv?: RunAgentOptions['childProcessEnv'];
  abortSignal?: RunAgentOptions['abortSignal'];
  onStream?: RunAgentOptions['onStream'];
  onActivity?: RunAgentOptions['onActivity'];
}

function matchesAt(entry: WorkflowPromotionEntry, stepIteration: number): boolean {
  return entry.at !== undefined && stepIteration >= entry.at;
}

/**
 * A promotion entry is "targeted" when it names a concrete provider/model/provider_options. Such
 * an entry drives provider/model directly (CT-PROMO-2). A target-less `{at:N}` entry names no
 * target and instead advances the runtime.yaml `ladder` (issue #1208).
 */
export function isTargetedPromotionEntry(entry: WorkflowPromotionEntry): boolean {
  return entry.provider !== undefined
    || entry.model !== undefined
    || entry.providerOptions !== undefined;
}

/**
 * Count how many target-less `{at:N}` promotion entries the current step iteration has reached
 * (issue #1208). The count is the ladder stage index the promotion advances to: one matched
 * `{at}` per stage. Target-less entries carry no condition, so this is deterministic and never
 * invokes the AI judge (INV-C). Targeted entries are ignored here — they drive provider/model
 * directly, not the ladder.
 */
export function countMatchedLadderStages(
  step: AgentWorkflowStep,
  stepIteration: number,
): number {
  if (!step.promotion) {
    return 0;
  }
  let count = 0;
  for (const entry of step.promotion) {
    if (
      entry
      && !isTargetedPromotionEntry(entry)
      && entry.condition === undefined
      && matchesAt(entry, stepIteration)
    ) {
      count++;
    }
  }
  return count;
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
      resolvedProviderOptions: context.resolvedProviderOptions,
      permissionMode: context.permissionMode,
      childProcessEnv: context.childProcessEnv,
      abortSignal: context.abortSignal,
      onStream: context.onStream,
      onActivity: context.onActivity,
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
