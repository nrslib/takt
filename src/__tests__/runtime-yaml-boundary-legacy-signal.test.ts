import { describe, expect, it } from 'vitest';
import { collectLegacyProviderSignals } from '../infra/config/runtime-provider/legacy-signals.js';
import { determineProviderConfigMode } from '../infra/config/runtime-provider/mode.js';
import type { LegacyProviderEnvironmentInput } from '../infra/config/runtime-provider/environment.js';
import type { RuntimeProviderFile } from '../infra/config/runtime-provider/schema.js';

/** Workflow promotions are ladder selectors now; they are not legacy provider signals. */

const CLEAN_LEGACY: LegacyProviderEnvironmentInput = {
  provider: undefined,
  providerSource: 'default',
  model: undefined,
  modelSource: 'default',
  personaProviders: undefined,
  providerRouting: undefined,
  autoRouting: undefined,
  providerOptions: undefined,
};

const ACTIVE_RUNTIME_FILE: RuntimeProviderFile = {
  version: 1,
  provider: { defaults: { profile: 'd' }, profiles: { d: { provider: 'mock', model: 'm' } } },
} as unknown as RuntimeProviderFile;

describe('runtime-v1 mixed configuration boundary', () => {
  it('does not report workflow promotion entries as legacy provider signals', () => {
    expect(collectLegacyProviderSignals(CLEAN_LEGACY, 'default')).toEqual([]);
  });

  it('keeps an active runtime.yaml configuration valid when workflow uses ladder promotions', () => {
    const signals = collectLegacyProviderSignals(CLEAN_LEGACY, 'default');
    expect(determineProviderConfigMode({
      runtimeFile: ACTIVE_RUNTIME_FILE,
      legacyProviderSignals: signals,
    })).toEqual({ mode: 'runtime-v1' });
  });

  it('still rejects a real config.yaml legacy provider signal next to runtime.yaml', () => {
    const signals = collectLegacyProviderSignals({
      ...CLEAN_LEGACY,
      provider: 'codex',
      providerSource: 'global',
    }, 'default');
    expect(() => determineProviderConfigMode({
      runtimeFile: ACTIVE_RUNTIME_FILE,
      legacyProviderSignals: signals,
    })).toThrow(/Mixed provider configuration/i);
  });
});
