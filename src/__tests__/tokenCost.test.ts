import { describe, expect, it } from 'vitest';
import { estimateProviderTokenCostUsd } from '../infra/providers/tokenCost.js';

describe('token cost estimator', () => {
  it('Given a priced model and token usage, When estimating cost, Then returns a positive finite USD value', () => {
    const cost = estimateProviderTokenCostUsd('openai', 'gpt-5.4-mini', {
      usageMissing: false,
      inputTokens: 1_000,
      outputTokens: 500,
    });

    expect(cost).toEqual(expect.any(Number));
    expect(cost).toBeGreaterThan(0);
    expect(Number.isFinite(cost)).toBe(true);
  });

  it('Given an unknown model, When estimating cost, Then returns undefined instead of a zero fallback', () => {
    const cost = estimateProviderTokenCostUsd('openai', 'unpriced-model', {
      usageMissing: false,
      inputTokens: 1_000,
      outputTokens: 500,
    });

    expect(cost).toBeUndefined();
  });

  it('Given an unconfirmed OpenAI model alias, When estimating cost, Then returns undefined instead of inferred pricing', () => {
    const cost = estimateProviderTokenCostUsd('openai', 'gpt-5', {
      usageMissing: false,
      inputTokens: 1_000,
      outputTokens: 500,
    });

    expect(cost).toBeUndefined();
  });

  it('Given an OpenAI model call below the long-context boundary, When estimating cost, Then uses short-context token prices', () => {
    const cost = estimateProviderTokenCostUsd('openai', 'gpt-5.5', {
      usageMissing: false,
      inputTokens: 271_999,
      outputTokens: 0,
      totalTokens: 271_999,
    });

    expect(cost).toBe(1.359995);
  });

  it('Given an OpenAI model call at the long-context boundary, When estimating cost, Then uses short-context token prices', () => {
    const cost = estimateProviderTokenCostUsd('openai', 'gpt-5.5', {
      usageMissing: false,
      inputTokens: 272_000,
      outputTokens: 0,
      totalTokens: 272_000,
    });

    expect(cost).toBe(1.36);
  });

  it('Given an OpenAI model call above the boundary with additional output, When estimating cost, Then uses long-context token prices', () => {
    const cost = estimateProviderTokenCostUsd('openai', 'gpt-5.5', {
      usageMissing: false,
      inputTokens: 272_001,
      outputTokens: 1_000,
      totalTokens: 273_001,
    });

    expect(cost).toBe(2.76501);
  });

  it('Given a Codex model call, When estimating cost, Then uses the Codex model token prices', () => {
    const cost = estimateProviderTokenCostUsd('codex', 'gpt-5.3-codex', {
      usageMissing: false,
      inputTokens: 1_000,
      outputTokens: 500,
    });

    expect(cost).toBe(0.00875);
  });

  it('Given an OpenCode OpenAI Codex model call, When estimating cost, Then resolves provider-prefixed pricing', () => {
    const cost = estimateProviderTokenCostUsd('opencode', 'openai/gpt-5.3-codex', {
      usageMissing: false,
      inputTokens: 1_000,
      outputTokens: 500,
    });

    expect(cost).toBe(0.00875);
  });

  it('Given missing usage, When estimating cost, Then returns undefined', () => {
    const cost = estimateProviderTokenCostUsd('openai', 'gpt-5', {
      usageMissing: true,
    });

    expect(cost).toBeUndefined();
  });

  it('Given non-finite or negative token usage, When estimating cost, Then returns undefined', () => {
    for (const invalidTokenCount of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(estimateProviderTokenCostUsd('openai', 'gpt-5.4-mini', {
        usageMissing: false,
        inputTokens: invalidTokenCount,
        outputTokens: 500,
      })).toBeUndefined();

      expect(estimateProviderTokenCostUsd('openai', 'gpt-5.4-mini', {
        usageMissing: false,
        inputTokens: 1_000,
        outputTokens: invalidTokenCount,
      })).toBeUndefined();

      expect(estimateProviderTokenCostUsd('openai', 'gpt-5.4-mini', {
        usageMissing: false,
        inputTokens: 1_000,
        outputTokens: 500,
        cachedInputTokens: invalidTokenCount,
      })).toBeUndefined();

      expect(estimateProviderTokenCostUsd('claude', 'claude-opus-4-5-20251101', {
        usageMissing: false,
        inputTokens: 1_000,
        outputTokens: 500,
        cachedInputTokens: 12_000,
        cacheCreationInputTokens: invalidTokenCount,
        cacheReadInputTokens: 10_000,
      })).toBeUndefined();

      expect(estimateProviderTokenCostUsd('claude', 'claude-opus-4-5-20251101', {
        usageMissing: false,
        inputTokens: 1_000,
        outputTokens: 500,
        cachedInputTokens: 12_000,
        cacheCreationInputTokens: 2_000,
        cacheReadInputTokens: invalidTokenCount,
      })).toBeUndefined();
    }
  });

  it('Given OpenAI cached input tokens, When estimating cost, Then prices cached tokens at the cached input rate', () => {
    const cost = estimateProviderTokenCostUsd('openai', 'gpt-5.4-mini', {
      usageMissing: false,
      inputTokens: 1_000,
      outputTokens: 500,
      cachedInputTokens: 400,
    });

    expect(cost).toBe(0.00273);
  });

  it('Given OpenAI cached input tokens exceed input tokens, When estimating cost, Then returns undefined', () => {
    const cost = estimateProviderTokenCostUsd('openai', 'gpt-5.4-mini', {
      usageMissing: false,
      inputTokens: 1_000,
      outputTokens: 500,
      cachedInputTokens: 1_001,
    });

    expect(cost).toBeUndefined();
  });

  it('Given Claude prompt cache usage for a confirmed model id, When cached tokens exceed base input tokens, Then prices cache writes and reads separately', () => {
    const cost = estimateProviderTokenCostUsd('claude', 'claude-opus-4-5-20251101', {
      usageMissing: false,
      inputTokens: 1_000,
      outputTokens: 500,
      cachedInputTokens: 12_000,
      cacheCreationInputTokens: 2_000,
      cacheReadInputTokens: 10_000,
    });

    expect(cost).toBe(0.035);
  });

  it('Given Claude prompt cache split does not match cached input tokens, When estimating cost, Then returns undefined', () => {
    const cost = estimateProviderTokenCostUsd('claude', 'claude-opus-4-5-20251101', {
      usageMissing: false,
      inputTokens: 1_000,
      outputTokens: 500,
      cachedInputTokens: 12_000,
      cacheCreationInputTokens: 2_000,
      cacheReadInputTokens: 9_999,
    });

    expect(cost).toBeUndefined();
  });

  it('Given Claude usage with explicit zero cached input tokens but non-zero cache splits, When estimating cost, Then returns undefined', () => {
    const cost = estimateProviderTokenCostUsd('claude', 'claude-opus-4-5-20251101', {
      usageMissing: false,
      inputTokens: 1_000,
      outputTokens: 500,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 100,
      cacheReadInputTokens: 50,
    });

    expect(cost).toBeUndefined();
  });

  it('Given Claude usage with omitted cached input tokens and matching cache splits, When estimating cost, Then prices the split tokens', () => {
    const cost = estimateProviderTokenCostUsd('claude', 'claude-opus-4-5-20251101', {
      usageMissing: false,
      inputTokens: 1_000,
      outputTokens: 500,
      cacheCreationInputTokens: 2_000,
      cacheReadInputTokens: 10_000,
    });

    expect(cost).toBe(0.035);
  });

  it('Given an unconfirmed Claude model alias, When estimating cost, Then returns undefined instead of inferred pricing', () => {
    const cost = estimateProviderTokenCostUsd('claude', 'claude-opus-4-5', {
      usageMissing: false,
      inputTokens: 1_000,
      outputTokens: 500,
      cachedInputTokens: 12_000,
      cacheCreationInputTokens: 2_000,
      cacheReadInputTokens: 10_000,
    });

    expect(cost).toBeUndefined();
  });
});
