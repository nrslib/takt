import type { ProviderUsageSnapshot } from '../../core/models/response.js';

type TokenPricing = InputDiscountTokenPricing | SeparateCacheTokenPricing;

interface BaseTokenPricing {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

interface TokenPricingTier extends BaseTokenPricing {
  cachedInputUsdPerMillion: number;
}

interface FixedInputDiscountTokenPricing extends TokenPricingTier {
  cacheAccounting: 'input_discount';
}

interface TieredInputDiscountTokenPricing {
  cacheAccounting: 'input_discount';
  longContextThresholdTokens: number;
  shortContext: TokenPricingTier;
  longContext: TokenPricingTier;
}

type InputDiscountTokenPricing = FixedInputDiscountTokenPricing | TieredInputDiscountTokenPricing;

interface SeparateCacheTokenPricing extends BaseTokenPricing {
  cacheAccounting: 'separate_cache';
  cacheCreationInputUsdPerMillion: number;
  cacheReadInputUsdPerMillion: number;
}

const OPENAI_LONG_CONTEXT_THRESHOLD_TOKENS = 270_000;

const OPENAI_TOKEN_PRICING: Readonly<Record<string, TokenPricing>> = {
  'gpt-5.5': {
    cacheAccounting: 'input_discount',
    longContextThresholdTokens: OPENAI_LONG_CONTEXT_THRESHOLD_TOKENS,
    shortContext: {
      inputUsdPerMillion: 5,
      cachedInputUsdPerMillion: 0.5,
      outputUsdPerMillion: 30,
    },
    longContext: {
      inputUsdPerMillion: 10,
      cachedInputUsdPerMillion: 1,
      outputUsdPerMillion: 45,
    },
  },
  'gpt-5.4': {
    cacheAccounting: 'input_discount',
    longContextThresholdTokens: OPENAI_LONG_CONTEXT_THRESHOLD_TOKENS,
    shortContext: {
      inputUsdPerMillion: 2.5,
      cachedInputUsdPerMillion: 0.25,
      outputUsdPerMillion: 15,
    },
    longContext: {
      inputUsdPerMillion: 5,
      cachedInputUsdPerMillion: 0.5,
      outputUsdPerMillion: 22.5,
    },
  },
  'gpt-5.4-mini': {
    cacheAccounting: 'input_discount',
    inputUsdPerMillion: 0.75,
    cachedInputUsdPerMillion: 0.075,
    outputUsdPerMillion: 4.5,
  },
  'gpt-5.4-nano': {
    cacheAccounting: 'input_discount',
    inputUsdPerMillion: 0.2,
    cachedInputUsdPerMillion: 0.02,
    outputUsdPerMillion: 1.25,
  },
  'gpt-5.3-codex': {
    cacheAccounting: 'input_discount',
    inputUsdPerMillion: 1.75,
    cachedInputUsdPerMillion: 0.175,
    outputUsdPerMillion: 14,
  },
};

const ANTHROPIC_TOKEN_PRICING: Readonly<Record<string, TokenPricing>> = {
  'claude-opus-4-5-20251101': {
    cacheAccounting: 'separate_cache',
    inputUsdPerMillion: 5,
    cacheCreationInputUsdPerMillion: 6.25,
    cacheReadInputUsdPerMillion: 0.5,
    outputUsdPerMillion: 25,
  },
};

export function estimateProviderTokenCostUsd(
  provider: string,
  model: string,
  usage: ProviderUsageSnapshot,
): number | undefined {
  if (usage.usageMissing) {
    return undefined;
  }

  const pricing = resolveTokenPricing(provider, model);
  if (!pricing) {
    return undefined;
  }

  const inputTokens = finiteTokenCount(usage.inputTokens);
  const outputTokens = finiteTokenCount(usage.outputTokens);
  if (inputTokens === undefined || outputTokens === undefined) {
    return undefined;
  }
  return estimateWithPricing(pricing, usage, inputTokens, outputTokens);
}

function estimateWithPricing(
  pricing: TokenPricing,
  usage: ProviderUsageSnapshot,
  inputTokens: number,
  outputTokens: number,
): number | undefined {
  if (pricing.cacheAccounting === 'input_discount') {
    return estimateInputDiscountCost(pricing, usage, inputTokens, outputTokens);
  }
  return estimateSeparateCacheCost(pricing, usage, inputTokens, outputTokens);
}

function estimateInputDiscountCost(
  pricing: InputDiscountTokenPricing,
  usage: ProviderUsageSnapshot,
  inputTokens: number,
  outputTokens: number,
): number | undefined {
  const tier = resolveInputDiscountTier(pricing, inputTokens);
  const cachedInputTokens = optionalFiniteTokenCount(usage.cachedInputTokens);
  if (cachedInputTokens === undefined || cachedInputTokens > inputTokens) {
    return undefined;
  }

  const uncachedInputTokens = inputTokens - cachedInputTokens;
  return (
    (uncachedInputTokens * tier.inputUsdPerMillion)
    + (cachedInputTokens * tier.cachedInputUsdPerMillion)
    + (outputTokens * tier.outputUsdPerMillion)
  ) / 1_000_000;
}

function resolveInputDiscountTier(
  pricing: InputDiscountTokenPricing,
  inputTokens: number,
): TokenPricingTier {
  if (!('longContextThresholdTokens' in pricing)) {
    return pricing;
  }

  return inputTokens >= pricing.longContextThresholdTokens
    ? pricing.longContext
    : pricing.shortContext;
}

function estimateSeparateCacheCost(
  pricing: SeparateCacheTokenPricing,
  usage: ProviderUsageSnapshot,
  inputTokens: number,
  outputTokens: number,
): number | undefined {
  const cachedInputTokens = optionalFiniteTokenCount(usage.cachedInputTokens);
  const cacheCreationInputTokens = optionalFiniteTokenCount(usage.cacheCreationInputTokens);
  const cacheReadInputTokens = optionalFiniteTokenCount(usage.cacheReadInputTokens);
  if (
    cachedInputTokens === undefined
    || cacheCreationInputTokens === undefined
    || cacheReadInputTokens === undefined
  ) {
    return undefined;
  }

  const splitCachedInputTokens = cacheCreationInputTokens + cacheReadInputTokens;
  if (usage.cachedInputTokens !== undefined && splitCachedInputTokens !== cachedInputTokens) {
    return undefined;
  }

  return (
    (inputTokens * pricing.inputUsdPerMillion)
    + (cacheCreationInputTokens * pricing.cacheCreationInputUsdPerMillion)
    + (cacheReadInputTokens * pricing.cacheReadInputUsdPerMillion)
    + (outputTokens * pricing.outputUsdPerMillion)
  ) / 1_000_000;
}

function resolveTokenPricing(provider: string, model: string): TokenPricing | undefined {
  if (isOpenAiProvider(provider)) {
    return OPENAI_TOKEN_PRICING[model];
  }
  if (isAnthropicProvider(provider)) {
    return ANTHROPIC_TOKEN_PRICING[model];
  }
  if (provider === 'opencode') {
    return resolveOpenCodeTokenPricing(model);
  }
  return undefined;
}

function resolveOpenCodeTokenPricing(model: string): TokenPricing | undefined {
  const separatorIndex = model.indexOf('/');
  if (separatorIndex < 1 || separatorIndex === model.length - 1) {
    return undefined;
  }

  const provider = model.slice(0, separatorIndex);
  const providerModel = model.slice(separatorIndex + 1);
  if (provider === 'openai') {
    return OPENAI_TOKEN_PRICING[providerModel];
  }
  if (provider === 'anthropic') {
    return ANTHROPIC_TOKEN_PRICING[providerModel];
  }
  return undefined;
}

function isOpenAiProvider(provider: string): boolean {
  return provider === 'openai' || provider === 'codex';
}

function isAnthropicProvider(provider: string): boolean {
  return provider === 'anthropic' || provider === 'claude' || provider === 'claude-sdk' || provider === 'claude-terminal';
}

function finiteTokenCount(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function optionalFiniteTokenCount(value: number | undefined): number | undefined {
  if (value === undefined) {
    return 0;
  }
  return finiteTokenCount(value);
}
