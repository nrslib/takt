import type { StructuredCaller } from '../../../agents/structured-caller.js';
import type { AgentWorkflowStep, WorkflowStep } from '../../models/types.js';
import type { RuntimeStepResolution, StepProviderInfo } from '../types.js';
import { isDelegatedWorkflowStep } from '../step-kind.js';
import { evaluatePromotion } from './PromotionEvaluator.js';
import { mergeProviderOptions, PROVIDER_OPTION_PATHS } from '../../../infra/config/providerOptions.js';

export interface PromotionRuntimeContext {
  cwd: string;
  previousResponseContent: string;
  structuredCaller?: StructuredCaller;
  resolveStepProviderModel: (step: WorkflowStep, runtime?: RuntimeStepResolution) => StepProviderInfo;
}

function isPromotionStep(step: WorkflowStep): step is AgentWorkflowStep {
  return step.kind !== 'system' && step.kind !== 'workflow_call';
}

function getProviderOptionValue(options: StepProviderInfo['providerOptions'], path: string): unknown {
  if (!options) return undefined;
  return path.split('.').reduce<unknown>((current, part) => {
    if (current === undefined || current === null || typeof current !== 'object') {
      return undefined;
    }
    return (current as Record<string, unknown>)[part];
  }, options);
}

function setProviderOptionValue(
  options: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const parts = path.split('.');
  let current = options;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (next === undefined || next === null || typeof next !== 'object' || Array.isArray(next)) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}

function filterPromotionProviderOptions(
  baseSources: StepProviderInfo['providerOptionsSources'],
  promotionOptions: StepProviderInfo['providerOptions'],
): StepProviderInfo['providerOptions'] {
  if (!promotionOptions) {
    return undefined;
  }

  const result: Record<string, unknown> = {};
  for (const path of PROVIDER_OPTION_PATHS) {
    const value = getProviderOptionValue(promotionOptions, path);
    if (value === undefined) {
      continue;
    }
    const baseSource = baseSources?.[path];
    if (baseSource === 'env' || baseSource === 'cli') {
      continue;
    }
    setProviderOptionValue(result, path, value);
  }

  return Object.keys(result).length > 0
    ? result as StepProviderInfo['providerOptions']
    : undefined;
}

function resolvePromotedModel(
  baseProviderInfo: StepProviderInfo,
  promotion: NonNullable<AgentWorkflowStep['promotion']>[number],
): Pick<StepProviderInfo, 'model' | 'modelSource'> {
  if (promotion.model !== undefined) {
    return { model: promotion.model, modelSource: 'promotion' };
  }
  if (promotion.providerSpecified) {
    return { model: undefined, modelSource: undefined };
  }
  return {
    model: baseProviderInfo.model,
    modelSource: baseProviderInfo.modelSource,
  };
}

function resolvePromotionProviderOptionsSources(
  baseSources: StepProviderInfo['providerOptionsSources'],
  promotionOptions: StepProviderInfo['providerOptions'],
): StepProviderInfo['providerOptionsSources'] {
  if (!promotionOptions) {
    return baseSources;
  }

  const sources: Record<string, NonNullable<StepProviderInfo['providerOptionsSources']>[string]> = {
    ...baseSources,
  };
  for (const path of PROVIDER_OPTION_PATHS) {
    if (getProviderOptionValue(promotionOptions, path) !== undefined) {
      sources[path] = 'promotion';
    }
  }
  return Object.keys(sources).length > 0 ? sources : undefined;
}

export async function resolvePromotionRuntime(
  context: PromotionRuntimeContext,
  step: WorkflowStep,
  stepIteration: number | undefined,
  runtime: RuntimeStepResolution | undefined,
): Promise<RuntimeStepResolution | undefined> {
  if (!isPromotionStep(step) || !step.promotion || step.promotion.length === 0) {
    return runtime;
  }
  if (isDelegatedWorkflowStep(step)) {
    throw new Error(`Step "${step.name}" promotion is only supported for normal agent steps`);
  }
  if (stepIteration === undefined) {
    throw new Error(`Step "${step.name}" promotion requires a normal agent step execution`);
  }

  const baseProviderInfo = context.resolveStepProviderModel(step, runtime);
  const promotion = await evaluatePromotion(step, {
    cwd: context.cwd,
    stepIteration,
    previousResponseContent: context.previousResponseContent,
    structuredCaller: context.structuredCaller,
    resolvedProvider: baseProviderInfo.provider,
    resolvedModel: baseProviderInfo.model,
  });
  if (!promotion) {
    return runtime;
  }

  const promotionProviderOptions = filterPromotionProviderOptions(
    baseProviderInfo.providerOptionsSources,
    promotion.providerOptions,
  );
  const promotedModel = resolvePromotedModel(baseProviderInfo, promotion);
  return {
    ...runtime,
    providerInfo: {
      ...baseProviderInfo,
      provider: promotion.provider ?? baseProviderInfo.provider,
      providerSource: promotion.provider !== undefined ? 'promotion' : baseProviderInfo.providerSource,
      model: promotedModel.model,
      modelSource: promotedModel.modelSource,
      providerOptions: mergeProviderOptions(baseProviderInfo.providerOptions, promotionProviderOptions),
      providerOptionsSources: resolvePromotionProviderOptionsSources(
        baseProviderInfo.providerOptionsSources,
        promotionProviderOptions,
      ),
    },
  };
}
