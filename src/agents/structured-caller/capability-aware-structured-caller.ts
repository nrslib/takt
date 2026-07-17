import type {
  WorkflowRule,
} from '../../core/models/types.js';
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
    rules: WorkflowRule[],
    options: JudgeStatusOptions,
  ): Promise<JudgeStatusResult> {
    const provider = resolveProvider(options.provider, options.resolvedProvider);
    if (shouldUsePromptBased(provider)) {
      return this.promptBased.judgeStatus(structuredInstruction, tagInstruction, rules, options);
    }

    return super.judgeStatus(structuredInstruction, tagInstruction, rules, options);
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
    maxTotalParts: number,
    options: DecomposeTaskOptions,
  ): Promise<DecomposeTaskResponse> {
    const provider = resolveProvider(options.provider, options.resolvedProvider);
    if (shouldUsePromptBased(provider)) {
      return this.promptBased.decomposeTask(instruction, maxTotalParts, options);
    }

    return super.decomposeTask(instruction, maxTotalParts, options);
  }

  async requestMoreParts(
    originalInstruction: string,
    allResults: Array<{ id: string; title: string; status: string; content: string }>,
    existingIds: string[],
    maxAdditionalParts: number,
    options: MorePartsOptions,
  ): Promise<MorePartsResponse> {
    const provider = resolveProvider(options.provider, options.resolvedProvider);
    if (shouldUsePromptBased(provider)) {
      return this.promptBased.requestMoreParts(
        originalInstruction,
        allResults,
        existingIds,
        maxAdditionalParts,
        options,
      );
    }

    return super.requestMoreParts(
      originalInstruction,
      allResults,
      existingIds,
      maxAdditionalParts,
      options,
    );
  }
}
