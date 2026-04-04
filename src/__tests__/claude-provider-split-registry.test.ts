import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProviderRegistry, getProvider } from '../infra/providers/index.js';
import type { ProviderType } from '../infra/providers/types.js';

describe('Claude provider split (registry)', () => {
  beforeEach(() => {
    ProviderRegistry.resetInstance();
  });

  afterEach(() => {
    ProviderRegistry.resetInstance();
  });

  it('Given reset registry, When getProvider(claude-sdk) and getProvider(claude), Then two distinct Provider instances', () => {
    const sdk = getProvider('claude-sdk');
    const headless = getProvider('claude');

    expect(sdk).not.toBe(headless);
  });

  it('Given claude-sdk path, When supportsStructuredOutput, Then true (SDK structured output)', () => {
    const sdk = getProvider('claude-sdk');

    expect(sdk.supportsStructuredOutput).toBe(true);
  });

  it('Given headless claude path, When supportsStructuredOutput, Then false until CLI json-schema is wired', () => {
    const headless = getProvider('claude');

    expect(headless.supportsStructuredOutput).toBe(false);
  });

  it('Given unknown id, When getProvider, Then throws with clear message', () => {
    expect(() => getProvider('claude-legacy' as ProviderType)).toThrow(/Unknown provider type/i);
  });
});
