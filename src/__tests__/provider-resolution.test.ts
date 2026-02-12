import { describe, expect, it } from 'vitest';
import { resolveMovementProviderModel } from '../core/piece/provider-resolution.js';

describe('resolveMovementProviderModel', () => {
  it('should prefer step.provider when step provider is defined', () => {
    // Given: step.provider が指定されている
    const result = resolveMovementProviderModel({
      step: { provider: 'codex', model: undefined, personaDisplayName: 'coder' },
      provider: 'claude',
      personaProviders: { coder: 'opencode' },
    });

    // When: provider/model を解決する
    // Then: step.provider が最優先になる
    expect(result.provider).toBe('codex');
  });

  it('should use personaProviders when step.provider is undefined', () => {
    // Given: step.provider が未定義で personaProviders に対応がある
    const result = resolveMovementProviderModel({
      step: { provider: undefined, model: undefined, personaDisplayName: 'reviewer' },
      provider: 'claude',
      personaProviders: { reviewer: 'opencode' },
    });

    // When: provider/model を解決する
    // Then: personaProviders の値が使われる
    expect(result.provider).toBe('opencode');
  });

  it('should fallback to input.provider when persona mapping is missing', () => {
    // Given: step.provider 未定義かつ persona マッピングが存在しない
    const result = resolveMovementProviderModel({
      step: { provider: undefined, model: undefined, personaDisplayName: 'unknown' },
      provider: 'mock',
      personaProviders: { reviewer: 'codex' },
    });

    // When: provider/model を解決する
    // Then: input.provider が使われる
    expect(result.provider).toBe('mock');
  });

  it('should return undefined provider when all provider candidates are missing', () => {
    // Given: provider の候補がすべて未定義
    const result = resolveMovementProviderModel({
      step: { provider: undefined, model: undefined, personaDisplayName: 'none' },
      provider: undefined,
      personaProviders: undefined,
    });

    // When: provider/model を解決する
    // Then: provider は undefined になる
    expect(result.provider).toBeUndefined();
  });

  it('should prefer step.model over input.model', () => {
    // Given: step.model と input.model が両方指定されている
    const result = resolveMovementProviderModel({
      step: { provider: undefined, model: 'step-model', personaDisplayName: 'coder' },
      model: 'input-model',
    });

    // When: provider/model を解決する
    // Then: step.model が最優先になる
    expect(result.model).toBe('step-model');
  });

  it('should fallback to input.model when step.model is undefined', () => {
    // Given: step.model が未定義で input.model が指定されている
    const result = resolveMovementProviderModel({
      step: { provider: undefined, model: undefined, personaDisplayName: 'coder' },
      model: 'input-model',
    });

    // When: provider/model を解決する
    // Then: input.model が使われる
    expect(result.model).toBe('input-model');
  });
});
