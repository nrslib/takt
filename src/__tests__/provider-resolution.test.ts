import { describe, expect, it } from 'vitest';
import { resolveMovementProviderModel } from '../core/piece/provider-resolution.js';

describe('resolveMovementProviderModel', () => {
  it('should prefer step.provider when step provider is defined', () => {
    // Given: step.provider が指定されている
    const result = resolveMovementProviderModel({
      step: { provider: 'codex', model: undefined, personaDisplayName: 'coder' },
      provider: 'claude',
      personaProviders: { coder: { provider: 'opencode' } },
    });

    // When: provider/model を解決する
    // Then: step.provider が最優先になる
    expect(result.provider).toBe('codex');
  });

  it('should use personaProviders.provider when step.provider is undefined', () => {
    // Given: step.provider が未定義で personaProviders に対応がある
    const result = resolveMovementProviderModel({
      step: { provider: undefined, model: undefined, personaDisplayName: 'reviewer' },
      provider: 'claude',
      personaProviders: { reviewer: { provider: 'opencode' } },
    });

    // When: provider/model を解決する
    // Then: personaProviders の provider が使われる
    expect(result.provider).toBe('opencode');
  });

  it('should fallback to input.provider when persona mapping is missing', () => {
    // Given: step.provider 未定義かつ persona マッピングが存在しない
    const result = resolveMovementProviderModel({
      step: { provider: undefined, model: undefined, personaDisplayName: 'unknown' },
      provider: 'mock',
      personaProviders: { reviewer: { provider: 'codex' } },
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

  it('should prefer step.model over personaProviders.model and input.model', () => {
    // Given: step.model と personaProviders.model と input.model が指定されている
    const result = resolveMovementProviderModel({
      step: { provider: undefined, model: 'step-model', personaDisplayName: 'coder' },
      model: 'input-model',
      personaProviders: { coder: { provider: 'codex', model: 'persona-model' } },
    });

    // When: provider/model を解決する
    // Then: step.model が最優先になる
    expect(result.model).toBe('step-model');
  });

  it('should use personaProviders.model when step.model is undefined', () => {
    // Given: step.model が未定義で personaProviders.model が指定されている
    const result = resolveMovementProviderModel({
      step: { provider: undefined, model: undefined, personaDisplayName: 'coder' },
      model: 'input-model',
      personaProviders: { coder: { provider: 'codex', model: 'persona-model' } },
    });

    // When: provider/model を解決する
    // Then: personaProviders.model が使われる
    expect(result.model).toBe('persona-model');
  });

  it('should fallback to input.model when step.model and personaProviders.model are undefined', () => {
    // Given: step.model と personaProviders.model が未定義で input.model が指定されている
    const result = resolveMovementProviderModel({
      step: { provider: undefined, model: undefined, personaDisplayName: 'coder' },
      model: 'input-model',
      personaProviders: { coder: { provider: 'codex' } },
    });

    // When: provider/model を解決する
    // Then: input.model が使われる
    expect(result.model).toBe('input-model');
  });

  it('should return undefined model when all model candidates are missing', () => {
    // Given: model の候補がすべて未定義
    const result = resolveMovementProviderModel({
      step: { provider: undefined, model: undefined, personaDisplayName: 'coder' },
      model: undefined,
      personaProviders: { coder: { provider: 'codex' } },
    });

    // Then: model は undefined になる
    expect(result.model).toBeUndefined();
  });

  it('should resolve provider from personaProviders entry with only model specified', () => {
    // Given: personaProviders エントリに provider が指定されていない（model のみ）
    const result = resolveMovementProviderModel({
      step: { provider: undefined, model: undefined, personaDisplayName: 'coder' },
      provider: 'claude',
      personaProviders: { coder: { model: 'o3-mini' } },
    });

    // Then: provider は input.provider、model は personaProviders.model になる
    expect(result.provider).toBe('claude');
    expect(result.model).toBe('o3-mini');
  });
});
