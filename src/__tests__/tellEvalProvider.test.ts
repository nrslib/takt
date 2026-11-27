import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveEvalProvider } from '../../eval/scenarios/tell/eval-provider.js';
import { PROVIDER_TYPES } from '../shared/types/provider.js';

describe('resolveEvalProvider', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('defaults to codex and leaves the model unspecified', () => {
    expect(resolveEvalProvider(undefined, undefined)).toEqual({ providerType: 'codex', model: undefined });
  });

  it.each(PROVIDER_TYPES.filter((provider) => provider !== 'mock'))('preserves explicit real provider %s', (provider) => {
    expect(resolveEvalProvider(provider, 'explicit-model')).toEqual({ providerType: provider, model: 'explicit-model' });
  });

  it('preserves an explicit model with the default provider', () => {
    expect(resolveEvalProvider(undefined, 'gpt-6.1-sol')).toEqual({ providerType: 'codex', model: 'gpt-6.1-sol' });
  });

  it('leaves the model unspecified with an explicit provider', () => {
    expect(resolveEvalProvider('codex', undefined)).toEqual({ providerType: 'codex', model: undefined });
  });

  it.each(['mock', 'invalid-provider', '', ' codex ', 'CODEX'])('rejects provider %j', (provider) => {
    expect(() => resolveEvalProvider(provider, undefined)).toThrow();
  });

  it.each([
    [undefined, undefined, 'codex', 'tell-model', 'codex', 'tell-model'],
    ['claude', undefined, 'codex', 'tell-model', 'claude', 'tell-model'],
    [undefined, 'inline-model', 'codex', 'tell-model', 'codex', 'inline-model'],
    ['claude', 'inline-model', 'codex', 'tell-model', 'claude', 'inline-model'],
  ] as const)('resolves inline provider %j and model %j independently before Tell candidates', (inlineProvider, inlineModel, tellProvider, tellModel, providerType, model) => {
    expect(resolveEvalProvider(inlineProvider ?? tellProvider, inlineModel ?? tellModel)).toEqual({ providerType, model });
  });

  it('rejects an invalid inline override without substituting the Tell provider', () => {
    const inlineProvider: string | undefined = 'mock';
    const tellProvider = 'codex';
    expect(() => resolveEvalProvider(inlineProvider ?? tellProvider, undefined)).toThrow();
  });

  it.each([
    ['TAKT_INLINE_UTTERANCE_EVAL_PROVIDER', 'mock'],
    ['TAKT_INLINE_UTTERANCE_EVAL_MODEL', 'inline-model'],
  ])('keeps Tell candidates independent of %s', (name, value) => {
    vi.stubEnv('TAKT_TELL_EVAL_PROVIDER', undefined);
    vi.stubEnv('TAKT_TELL_EVAL_MODEL', undefined);
    vi.stubEnv('TAKT_INLINE_UTTERANCE_EVAL_PROVIDER', undefined);
    vi.stubEnv('TAKT_INLINE_UTTERANCE_EVAL_MODEL', undefined);
    vi.stubEnv(name, value);

    expect(resolveEvalProvider(process.env.TAKT_TELL_EVAL_PROVIDER, process.env.TAKT_TELL_EVAL_MODEL))
      .toEqual({ providerType: 'codex', model: undefined });
  });
});
