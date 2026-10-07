import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { GlobalConfigSchema, ProjectConfigSchema } from '../core/models/index.js';
import { StepProviderOptionsObjectSchema } from '../core/models/schema-base.js';
import { buildRawTaktProvidersOrThrow, denormalizeProviderOptions } from '../infra/config/configNormalizers.js';
import { createDefaultProviderOptionsForProvider } from '../infra/config/resolveConfigValue.js';
import {
  mergeProviderOptions,
  normalizeProviderOptions,
  resolveEffectiveProviderOptions,
  resolveProviderOptionOrigin,
  resolveProviderOptionsSources,
} from '../infra/config/providerOptions.js';

describe('OpenCode Skill configuration', () => {
  it.each([true, false])('accepts boolean skills.enabled=%s in global and project settings', (enabled) => {
    const raw = { provider_options: { opencode: { skills: { enabled } } } };
    for (const schema of [GlobalConfigSchema, ProjectConfigSchema]) {
      expect(schema.parse(raw)).toMatchObject(raw);
    }
  });

  it.each(['true', 1, null])('rejects a non-boolean skills.enabled=%j', (enabled) => {
    expect(() => StepProviderOptionsObjectSchema.parse({ opencode: { skills: { enabled } } })).toThrow();
  });

  it.each([
    'opencode:\n  skills:\n    enabled: true\n',
    'opencode: {skills: {enabled: true}}',
  ])('preserves OpenCode Skill configuration from YAML %s', (yaml) => {
    const options = normalizeProviderOptions(StepProviderOptionsObjectSchema.parse(parse(yaml)));
    expect(options).toMatchObject({ opencode: { skills: { enabled: true } } });
  });

  it('resolves omitted OpenCode Skill settings to false', () => {
    expect(createDefaultProviderOptionsForProvider('opencode'))
      .toMatchObject({ opencode: { skills: { enabled: false } } });
  });

  it.each([true, false])('round-trips skills.enabled=%s through normalized selector validation and persistence', (enabled) => {
    const raw = { opencode: { network_access: false, skills: { enabled } } };
    const options = normalizeProviderOptions(StepProviderOptionsObjectSchema.parse(raw));
    expect(denormalizeProviderOptions(options)).toEqual(raw);
    expect(buildRawTaktProvidersOrThrow({ selector: { provider: 'opencode', providerOptions: options } }))
      .toEqual({ selector: { provider: 'opencode', provider_options: raw } });
  });

  it('merges an explicit false leaf while preserving sibling OpenCode options', () => {
    const base = { opencode: { networkAccess: true, skills: { enabled: true } } };
    const override = { opencode: { variant: 'high', skills: { enabled: false } } };
    expect(mergeProviderOptions(base, override)).toEqual({
      opencode: { networkAccess: true, variant: 'high', skills: { enabled: false } },
    });
  });

  it.each([
    { origin: 'local', expected: false },
    { origin: 'env', expected: true },
  ] as const)('uses $origin origin when resolving a conflicting Skill leaf', ({ origin, expected }) => {
    const config = { opencode: { networkAccess: true, skills: { enabled: true } } };
    const persona = { opencode: { variant: 'low', skills: { enabled: true } } };
    const step = { opencode: { variant: 'high', skills: { enabled: false } } };
    expect(resolveEffectiveProviderOptions('project', (path) => path === 'opencode.skills.enabled' ? origin : 'local', config, step, persona))
      .toMatchObject({ opencode: { networkAccess: true, variant: 'high', skills: { enabled: expected } } });
  });

  it('does not inherit an environment origin from another OpenCode leaf', () => {
    const origin = (path: string) => path === 'opencode' || path === 'opencode.networkAccess' ? 'env' as const : 'default' as const;
    expect(resolveProviderOptionOrigin(origin, 'opencode.skills.enabled', 'project')).toBe('default');
    const config = { opencode: { networkAccess: true, skills: { enabled: false } } };
    const step = { opencode: { variant: 'high', skills: { enabled: true } } };
    expect(resolveEffectiveProviderOptions('project', origin, config, step))
      .toMatchObject({ opencode: { networkAccess: true, skills: { enabled: true } } });
  });

  it.each([
    { origin: 'local', expected: 'step' },
    { origin: 'env', expected: 'env' },
  ] as const)('reports the effective Skill source for a $origin setting', ({ origin, expected }) => {
    const sources = resolveProviderOptionsSources(
      { opencode: { skills: { enabled: false } } },
      [],
      { opencode: { skills: { enabled: true } } },
      (path) => path === 'opencode.skills.enabled' ? origin : 'default',
      'project',
    );
    expect(sources['opencode.skills.enabled']).toBe(expected);
  });
});
