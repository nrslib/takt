import type { SemanticRuleCandidate } from '../../core/models/workflow-rule-condition.js';
import type { ProviderType } from '../../shared/types/provider.js';
import type {
  JudgeStatusOptions,
  JudgeStatusResult,
  EvaluateConditionOptions,
} from '../judge-status-usecase.js';
import type {
  DecomposeTaskOptions,
  DecomposeTaskResponse,
  MorePartsOptions,
  MorePartsResponse,
  TeamLeaderPartFeedbackResult,
} from '../decompose-task-usecase.js';
import { providerSupportsStructuredOutput } from '../../infra/providers/provider-capabilities.js';
import { DefaultStructuredCaller } from './default-structured-caller.js';
import { PromptBasedStructuredCaller } from './prompt-based-structured-caller.js';

function resolveProvider(
  provider: ProviderType | undefined,
  resolvedProvider: ProviderType | undefined,
): ProviderType | undefined {
  return resolvedProvider ?? provider;
}

function shouldUsePromptBased(provider: ProviderType | undefined): boolean {
  return provider !== undefined && !providerSupportsStructuredOutput(provider);
}

export class CapabilityAwareStructuredCaller extends DefaultStructuredCaller {
  private readonly promptBased = new PromptBasedStructuredCaller();

  async judgeStatus(
    structuredInstruction: string,
    tagInstruction: string,
    candidates: SemanticRuleCandidate[],
    options: JudgeStatusOptions,
  ): Promise<JudgeStatusResult> {
    const provider = resolveProvider(options.provider, options.resolvedProvider);
    if (shouldUsePromptBased(provider)) {
      return this.promptBased.judgeStatus(structuredInstruction, tagInstruction, candidates, options);
    }

    return super.judgeStatus(structuredInstruction, tagInstruction, candidates, options);
  }

  async evaluateCondition(
    agentOutput: string,
    conditions: Array<{ index: number; text: string }>,
    options: EvaluateConditionOptions,
  ): Promise<number> {
    const provider = resolveProvider(options.provider, options.resolvedProvider);
    if (shouldUsePromptBased(provider)) {
      return this.promptBased.evaluateCondition(agentOutput, conditions, options);
    }

    return super.evaluateCondition(agentOutput, conditions, options);
  }

  async decomposeTask(
    instruction: string,
    maxInitialParts: number | undefined,
    options: DecomposeTaskOptions,
  ): Promise<DecomposeTaskResponse> {
    const provider = resolveProvider(options.provider, options.resolvedProvider);
    if (shouldUsePromptBased(provider)) {
      return this.promptBased.decomposeTask(instruction, maxInitialParts, options);
    }

    return super.decomposeTask(instruction, maxInitialParts, options);
  }

  async requestMoreParts(
    originalInstruction: string,
    allResults: TeamLeaderPartFeedbackResult[],
    existingIds: string[],
    options: MorePartsOptions,
  ): Promise<MorePartsResponse> {
    const provider = resolveProvider(options.provider, options.resolvedProvider);
    if (shouldUsePromptBased(provider)) {
      return this.promptBased.requestMoreParts(
        originalInstruction,
        allResults,
        existingIds,
        options,
      );
    }

    return super.requestMoreParts(
      originalInstruction,
      allResults,
      existingIds,
      options,
    );
  }
}
