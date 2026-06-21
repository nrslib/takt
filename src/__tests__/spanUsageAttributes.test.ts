import { describe, expect, it } from 'vitest';
import { usageSnapshotFromSpanAttributes } from '../core/logging/spanUsageAttributes.js';

describe('span usage attribute normalization', () => {
  it('Given complete span usage attributes without total tokens, When normalizing, Then derives total tokens', () => {
    const usage = usageSnapshotFromSpanAttributes({
      'gen_ai.usage.input_tokens': 11,
      'gen_ai.usage.output_tokens': 7,
      'gen_ai.usage.cached_input_tokens': 3,
      'gen_ai.usage.cache_creation_input_tokens': 2,
      'gen_ai.usage.cache_read_input_tokens': 1,
    });

    expect(usage).toEqual({
      usageMissing: false,
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18,
      cachedInputTokens: 3,
      cacheCreationInputTokens: 2,
      cacheReadInputTokens: 1,
    });
  });

  it('Given partial span usage attributes, When normalizing, Then records token-missing reason', () => {
    const usage = usageSnapshotFromSpanAttributes({
      'gen_ai.usage.input_tokens': 11,
    });

    expect(usage).toEqual({
      usageMissing: true,
      reason: 'usage_tokens_missing',
    });
  });

  it('Given no span usage attributes, When normalizing, Then records usage-not-available reason', () => {
    const usage = usageSnapshotFromSpanAttributes({});

    expect(usage).toEqual({
      usageMissing: true,
      reason: 'usage_not_available',
    });
  });
});
