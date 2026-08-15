import { describe, expect, it } from 'vitest';
// New module under test (implemented in the following `implement` step).
import {
  hasActiveProviderSection,
  determineProviderConfigMode,
} from '../infra/config/runtime-provider/mode.js';
import type { RuntimeProviderFile } from '../infra/config/runtime-provider/schema.js';

/**
 * Contracts covered (see plan.md 完了契約):
 * - C11/C25 runtime mode is decided by the presence of an *active* `provider` section,
 *           not by the file merely existing
 * - C12 runtime-v1 + legacy provider config detected together fails fast, and the error
 *       names each location and its migration target
 * - C13 each enumerated legacy provider setting triggers the mixed-config error
 *
 * `determineProviderConfigMode({ runtimeFile, legacyProviderSignals }) => { mode }`,
 * throwing on mixed config. LegacyProviderSignal = { setting; location; migrateTo }.
 */

const activeFile = {
  version: 1 as const,
  provider: { defaults: { profile: 'default' }, profiles: { default: { provider: 'mock', model: 'm' } } },
};

function runtimeFile(value: unknown): RuntimeProviderFile {
  return value as RuntimeProviderFile;
}

describe('hasActiveProviderSection (C11/C25)', () => {
  it('Given undefined, Then it is not active', () => {
    expect(hasActiveProviderSection(undefined)).toBe(false);
  });

  it('Given an inactive `version: 1` file, Then it is not active', () => {
    expect(hasActiveProviderSection({ version: 1 })).toBe(false);
  });

  it('Given an empty provider section, Then it is not active', () => {
    expect(hasActiveProviderSection(runtimeFile({ version: 1, provider: {} }))).toBe(false);
  });

  it('Given a populated provider section, Then it is active', () => {
    expect(hasActiveProviderSection(activeFile)).toBe(true);
  });

  it('Given a disabled companion-only target, Then it is inactive', () => {
    expect(hasActiveProviderSection(runtimeFile({
      version: 1,
      companion: { enabled: false },
      provider: { targets: { companions: { security: { profile: 'security' } } } },
    }))).toBe(false);
  });

  it('Given a companion-only target without a companion policy, Then it is inactive by default', () => {
    expect(hasActiveProviderSection(runtimeFile({
      version: 1,
      provider: { targets: { companions: { security: { profile: 'security' } } } },
    }))).toBe(false);
  });

  it('Given an enabled companion-only target, Then it is active', () => {
    expect(hasActiveProviderSection(runtimeFile({
      version: 1,
      companion: { enabled: true },
      provider: { targets: { companions: { security: { profile: 'security' } } } },
    }))).toBe(true);
  });

  it('Given a defaults-only provider section, Then it is active', () => {
    expect(hasActiveProviderSection({ version: 1, provider: { defaults: { profile: 'default' } } })).toBe(true);
  });

  it('Given defaults and targets, Then the provider section is active', () => {
    expect(
      hasActiveProviderSection({
        version: 1,
        provider: {
          defaults: { profile: 'default' },
          targets: { personas: { coder: { profile: 'default' } } },
        },
      }),
    ).toBe(true);
  });

  it('Given defaults and auto_routing, Then the provider section is active', () => {
    expect(
      hasActiveProviderSection({
        version: 1,
        provider: { defaults: { profile: 'default' }, auto_routing: { strategy: 'balanced' } },
      }),
    ).toBe(true);
  });

  it('Given an empty `profiles` map, Then it is not active', () => {
    expect(hasActiveProviderSection(runtimeFile({ version: 1, provider: { profiles: {} } }))).toBe(false);
  });

  it('Given an empty `targets` map, Then it is not active', () => {
    expect(hasActiveProviderSection(runtimeFile({ version: 1, provider: { targets: {} } }))).toBe(false);
  });

  it('Given `targets` with only empty nested maps, Then it is not active', () => {
    expect(
      hasActiveProviderSection(runtimeFile({ version: 1, provider: { targets: { personas: {} } } })),
    ).toBe(false);
  });

  it('Given an empty `auto_routing` map, Then it is not active', () => {
    expect(hasActiveProviderSection(runtimeFile({ version: 1, provider: { auto_routing: {} } }))).toBe(false);
  });

  it('Given an empty `defaults` map, Then it is not active', () => {
    expect(hasActiveProviderSection(runtimeFile({ version: 1, provider: { defaults: {} } }))).toBe(false);
  });
});

describe('determineProviderConfigMode (C11/C12/C13)', () => {
  it('Given no runtime file and legacy signals present, When determining mode, Then legacy mode is chosen (C11)', () => {
    const result = determineProviderConfigMode({
      runtimeFile: undefined,
      legacyProviderSignals: [{ setting: 'provider', location: 'config.yaml', migrateTo: 'provider.defaults' }],
    });
    expect(result.mode).toBe('legacy');
  });

  it('Given an inactive runtime file and legacy signals, When determining mode, Then legacy mode is chosen (C11/C25)', () => {
    const result = determineProviderConfigMode({
      runtimeFile: { version: 1 },
      legacyProviderSignals: [{ setting: 'provider', location: 'config.yaml', migrateTo: 'provider.defaults' }],
    });
    expect(result.mode).toBe('legacy');
  });

  it('Given an active runtime file and no legacy signals, When determining mode, Then runtime-v1 mode is chosen', () => {
    const result = determineProviderConfigMode({ runtimeFile: activeFile, legacyProviderSignals: [] });
    expect(result.mode).toBe('runtime-v1');
  });

  it('Given defaults and targets in an active runtime file and no legacy signals, When determining mode, Then runtime-v1 mode is chosen', () => {
    const result = determineProviderConfigMode({
      runtimeFile: {
        version: 1,
        provider: {
          defaults: { profile: 'default' },
          targets: { steps: { 'default/supervise': { profile: 'router' } } },
        },
      },
      legacyProviderSignals: [],
    });
    expect(result.mode).toBe('runtime-v1');
  });

  it('Given an active runtime file AND legacy signals, When determining mode, Then it fails fast with location and migration target (C12)', () => {
    let error: Error | undefined;
    try {
      determineProviderConfigMode({
        runtimeFile: activeFile,
        legacyProviderSignals: [
          { setting: 'provider_routing', location: 'config.yaml:provider_routing', migrateTo: 'provider.targets' },
        ],
      });
    } catch (e) {
      error = e as Error;
    }
    expect(error).toBeDefined();
    expect(error?.message).toContain('config.yaml:provider_routing');
    expect(error?.message).toContain('provider.targets');
  });

  it.each([
    ['config.yaml provider/model', 'provider', 'provider.defaults'],
    ['provider_options', 'provider_options', 'provider.profiles'],
    ['provider_routing', 'provider_routing', 'provider.targets'],
    ['persona_providers', 'persona_providers', 'provider.targets.personas'],
    ['legacy auto_routing', 'auto_routing', 'provider.auto_routing'],
    ['takt_providers', 'takt_providers', 'provider.targets.internal_agents'],
    ['workflow provider', 'workflow.provider', 'provider.targets.steps'],
  ])('Given active runtime and a %s legacy signal, When determining mode, Then it fails fast (C13)', (_name, setting, migrateTo) => {
    const location = `config.yaml:${setting}`;
    let thrown: unknown;

    try {
      determineProviderConfigMode({
        runtimeFile: activeFile,
        legacyProviderSignals: [{ setting, location, migrateTo }],
      });
    } catch (error: unknown) {
      thrown = error;
    }

    // The error must name the actual location and migration target for every signal, not just
    // mention the setting somewhere.
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain(location);
    expect(message).toContain(migrateTo);
  });
});
