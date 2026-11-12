/**
 * provider_options.claude.permissions (deny / import_user_read_deny).
 *
 * The new leaves must travel through the same schema, normalization, layer
 * merge, effective-value resolution, origin tracking, and persistence paths as
 * the existing provider_options leaves.
 */
import { describe, expect, it } from 'vitest';
import {
  GlobalConfigSchema,
  ProjectConfigSchema,
} from '../core/models/index.js';
import {
  NormalizedTaktSelectorProviderEntrySchema,
  PersonaProviderEntrySchema,
  StepProviderOptionsSchema,
  TaktSelectorProviderEntrySchema,
} from '../core/models/schema-base.js';
import type { StepProviderOptions } from '../core/models/workflow-provider-options.js';
import {
  mergeProviderOptions,
  normalizeProviderOptions,
  resolveEffectiveProviderOptions,
  resolveProviderOptionsSources,
} from '../infra/config/providerOptions.js';
import { denormalizeProviderOptions } from '../infra/config/configNormalizers.js';
import {
  PROVIDER_OPTIONS_ENV_SPECS,
  PROVIDER_OPTIONS_TRACE_PATHS,
  PROVIDER_OPTIONS_TRACKED_KEYS,
  getPresentProviderOptionPaths,
  toProviderOptionsTracePath,
} from '../infra/config/providerOptionsContract.js';

function asProviderOptions(value: unknown): StepProviderOptions {
  return value as StepProviderOptions;
}

function claudePermissions(permissions: Record<string, unknown>): StepProviderOptions {
  return asProviderOptions({ claude: { permissions } });
}

describe('claude permissions schema', () => {
  const rawPermissions = { deny: ['Read(./.env)', 'Read(~/.ssh/**)'], import_user_read_deny: true };

  it('Given deny and import_user_read_deny, When parsing step provider_options, Then both leaves are kept', () => {
    const parsed = StepProviderOptionsSchema.parse({ claude: { permissions: rawPermissions } });

    expect(parsed?.claude?.permissions).toEqual(rawPermissions);
  });

  it('Given the same options in global and project config, When parsing, Then both configs keep them', () => {
    const raw = { provider_options: { claude: { permissions: rawPermissions } } };

    expect(GlobalConfigSchema.parse(raw).provider_options?.claude?.permissions).toEqual(rawPermissions);
    expect(ProjectConfigSchema.parse(raw).provider_options?.claude?.permissions).toEqual(rawPermissions);
  });

  it('Given a persona_providers entry that only sets permissions.deny, When parsing, Then it counts as a provider-specific option', () => {
    const parsed = PersonaProviderEntrySchema.parse({
      provider_options: { claude: { permissions: { deny: ['Read(./.env)'] } } },
    });

    expect(parsed.provider_options?.claude?.permissions).toEqual({ deny: ['Read(./.env)'] });
  });

  it('Given a strict provider_options context, When permissions has an unknown key, Then parsing fails', () => {
    const entry = (permissions: Record<string, unknown>) => ({
      provider: 'claude',
      provider_options: { claude: { permissions } },
    });

    expect(() => TaktSelectorProviderEntrySchema.parse(entry({ deny: ['Read(./.env)'] }))).not.toThrow();
    expect(() => TaktSelectorProviderEntrySchema.parse(entry({ deny: ['Read(./.env)'], bogus: true }))).toThrow(/bogus|unrecognized/iu);
  });

  it('Given normalized selector providerOptions, When permissions has an unknown key, Then parsing fails', () => {
    const entry = (permissions: Record<string, unknown>) => ({
      provider: 'claude',
      providerOptions: { claude: { permissions } },
    });

    expect(() => NormalizedTaktSelectorProviderEntrySchema.parse(
      entry({ deny: ['Read(./.env)'], importUserReadDeny: true }),
    )).not.toThrow();
    expect(() => NormalizedTaktSelectorProviderEntrySchema.parse(
      entry({ deny: ['Read(./.env)'], bogus: true }),
    )).toThrow(/bogus|unrecognized/iu);
  });

  describe('Given a misspelled permissions key next to a valid one', () => {
    const misspelled = { deny: ['Read(./.env)'], import_user_read_denyy: true };
    const providerOptions = { claude: { permissions: misspelled } };

    it.each([
      ['step provider_options', () => StepProviderOptionsSchema.parse(providerOptions)],
      ['global config provider_options', () => GlobalConfigSchema.parse({ provider_options: providerOptions })],
      ['project config provider_options', () => ProjectConfigSchema.parse({ provider_options: providerOptions })],
      ['persona_providers entry', () => PersonaProviderEntrySchema.parse({ provider_options: providerOptions })],
    ])('When parsing %s, Then the key is reported instead of silently dropped', (_context, parse) => {
      expect(parse).toThrow(/import_user_read_denyy/u);
    });
  });

  it.each([
    ['deny is a string instead of an array', { deny: 'Read(./.env)' }],
    ['deny has a non-string entry', { deny: ['Read(./.env)', 42] }],
    ['deny has an empty entry', { deny: ['Read(./.env)', ''] }],
    ['import_user_read_deny is not a boolean', { import_user_read_deny: 'yes' }],
  ])('Given %s, When parsing step provider_options, Then it is rejected instead of silently dropped', (_state, permissions) => {
    expect(() => StepProviderOptionsSchema.parse({ claude: { permissions } })).toThrow();
  });
});

describe('claude permissions normalization and persistence', () => {
  it('Given snake_case permissions, When normalizeProviderOptions, Then camelCase options are returned', () => {
    expect(normalizeProviderOptions({
      claude: { permissions: { deny: ['Read(./.env)'], import_user_read_deny: true } },
    })).toEqual({
      claude: { permissions: { deny: ['Read(./.env)'], importUserReadDeny: true } },
    });
  });

  it('Given only the import switch set to false, When normalizeProviderOptions, Then the explicit false is kept', () => {
    expect(normalizeProviderOptions({ claude: { permissions: { import_user_read_deny: false } } }))
      .toEqual({ claude: { permissions: { importUserReadDeny: false } } });
  });

  it('Given only deny, When normalizeProviderOptions, Then no import switch is invented', () => {
    expect(normalizeProviderOptions({ claude: { permissions: { deny: ['Read(./.env)'] } } }))
      .toEqual({ claude: { permissions: { deny: ['Read(./.env)'] } } });
  });

  it('Given an empty permissions object, When normalizeProviderOptions, Then nothing is produced', () => {
    expect(normalizeProviderOptions({ claude: { permissions: {} } })).toBeUndefined();
  });

  it('Given camelCase permissions, When denormalizeProviderOptions, Then snake_case options are persisted', () => {
    expect(denormalizeProviderOptions(claudePermissions({
      deny: ['Read(./.env)'],
      importUserReadDeny: false,
    }))).toEqual({
      claude: { permissions: { deny: ['Read(./.env)'], import_user_read_deny: false } },
    });
  });

  it('Given an empty permissions object, When denormalizeProviderOptions, Then nothing is persisted', () => {
    expect(denormalizeProviderOptions(claudePermissions({}))).toBeUndefined();
  });

  it('Given persisted permissions, When normalized and denormalized, Then the persisted form round-trips', () => {
    const raw = { claude: { permissions: { deny: ['Read(./.env)', 'Read(**/*.pem)'], import_user_read_deny: true } } };

    expect(denormalizeProviderOptions(normalizeProviderOptions(raw))).toEqual(raw);
  });
});

describe('claude permissions layer merge', () => {
  it('Given deny in two layers, When mergeProviderOptions, Then the later deny replaces the earlier one without concatenating', () => {
    const merged = mergeProviderOptions(
      claudePermissions({ deny: ['Read(./.env)'] }),
      claudePermissions({ deny: ['Read(~/.ssh/**)'] }),
    );

    expect(merged).toEqual({ claude: { permissions: { deny: ['Read(~/.ssh/**)'] } } });
  });

  it('Given the layers set different leaves, When mergeProviderOptions, Then each leaf is overridden independently', () => {
    const merged = mergeProviderOptions(
      claudePermissions({ deny: ['Read(./.env)'], importUserReadDeny: true }),
      claudePermissions({ importUserReadDeny: false }),
    );

    expect(merged).toEqual({
      claude: { permissions: { deny: ['Read(./.env)'], importUserReadDeny: false } },
    });
  });

  it('Given permissions next to sandbox in different layers, When mergeProviderOptions, Then neither is lost', () => {
    const merged = mergeProviderOptions(
      asProviderOptions({ claude: { sandbox: { excludedCommands: ['./gradlew'] } } }),
      claudePermissions({ deny: ['Read(./.env)'] }),
    );

    expect(merged).toEqual({
      claude: {
        sandbox: { excludedCommands: ['./gradlew'] },
        permissions: { deny: ['Read(./.env)'] },
      },
    });
  });
});

describe('claude permissions effective resolution', () => {
  it('Given a config layer that only sets the import switch and a step that sets another Claude option, When resolving, Then the switch is kept', () => {
    expect(resolveEffectiveProviderOptions(
      'project',
      undefined,
      claudePermissions({ importUserReadDeny: true }),
      asProviderOptions({ claude: { effort: 'high' } }),
    )).toEqual({ claude: { effort: 'high', permissions: { importUserReadDeny: true } } });
  });

  it('Given config, persona, and step layers, When resolving, Then step wins over persona and persona wins over config per leaf', () => {
    const result = resolveEffectiveProviderOptions(
      'project',
      undefined,
      claudePermissions({ deny: ['Read(config)'], importUserReadDeny: false }),
      claudePermissions({ deny: ['Read(step)'] }),
      claudePermissions({ deny: ['Read(persona)'], importUserReadDeny: true }),
    );

    expect(result).toEqual({
      claude: { permissions: { deny: ['Read(step)'], importUserReadDeny: true } },
    });
  });

  it('Given deny in config and step, When resolving, Then the arrays are not concatenated', () => {
    const result = resolveEffectiveProviderOptions(
      'project',
      undefined,
      claudePermissions({ deny: ['Read(./.env)'] }),
      claudePermissions({ deny: ['Read(~/.ssh/**)'] }),
    );

    expect(result?.claude?.permissions?.deny).toEqual(['Read(~/.ssh/**)']);
  });

  it('Given an env-origin config leaf, When resolving, Then it wins over the step while the other leaf follows normal precedence', () => {
    const result = resolveEffectiveProviderOptions(
      'project',
      (path: string) => (path === 'claude.permissions.deny' ? 'env' : 'local'),
      claudePermissions({ deny: ['Read(./.env)'] }),
      claudePermissions({ deny: ['Read(~/.ssh/**)'], importUserReadDeny: true }),
    );

    expect(result).toEqual({
      claude: { permissions: { deny: ['Read(./.env)'], importUserReadDeny: true } },
    });
  });

  it('Given an env-origin import switch, When resolving, Then it wins over the step switch', () => {
    const result = resolveEffectiveProviderOptions(
      'project',
      (path: string) => (path === 'claude.permissions.importUserReadDeny' ? 'env' : 'local'),
      claudePermissions({ importUserReadDeny: true }),
      claudePermissions({ importUserReadDeny: false }),
    );

    expect(result?.claude?.permissions?.importUserReadDeny).toBe(true);
  });

  it('Given permissions next to sandbox, When resolving, Then both survive effective resolution', () => {
    const result = resolveEffectiveProviderOptions(
      'project',
      undefined,
      asProviderOptions({ claude: { sandbox: { allowUnsandboxedCommands: true } } }),
      claudePermissions({ deny: ['Read(./.env)'] }),
    );

    expect(result).toEqual({
      claude: {
        sandbox: { allowUnsandboxedCommands: true },
        permissions: { deny: ['Read(./.env)'] },
      },
    });
  });

  it('Given the leaves come from different layers, When resolving sources, Then each leaf reports its own source', () => {
    const sources = resolveProviderOptionsSources(
      claudePermissions({ deny: ['Read(./.env)'] }),
      [],
      claudePermissions({ importUserReadDeny: true }),
      undefined,
      'project',
    );

    expect(sources).toMatchObject({
      'claude.permissions.deny': 'step',
      'claude.permissions.importUserReadDeny': 'project',
    });
  });
});

describe('claude permissions contract paths', () => {
  it('declares env specs for both leaves with matching value types', () => {
    const specs = new Map(PROVIDER_OPTIONS_ENV_SPECS.map((spec) => [spec.path, spec.type]));

    expect(specs.get('provider_options.claude.permissions.deny')).toBe('json');
    expect(specs.get('provider_options.claude.permissions.import_user_read_deny')).toBe('boolean');
  });

  it('traces the permissions object and both leaves', () => {
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toEqual(expect.arrayContaining([
      'provider_options.claude.permissions',
      'provider_options.claude.permissions.deny',
      'provider_options.claude.permissions.import_user_read_deny',
    ]));
    expect(PROVIDER_OPTIONS_TRACKED_KEYS).toContain('provider_options.claude.permissions');
  });

  it('maps the internal leaf paths to traced-config paths', () => {
    expect(toProviderOptionsTracePath('claude.permissions.deny'))
      .toBe('provider_options.claude.permissions.deny');
    expect(toProviderOptionsTracePath('claude.permissions.importUserReadDeny'))
      .toBe('provider_options.claude.permissions.import_user_read_deny');
  });

  it('enumerates the present permissions leaves, including an explicit false switch', () => {
    const present = getPresentProviderOptionPaths(claudePermissions({
      deny: ['Read(./.env)'],
      importUserReadDeny: false,
    }));

    expect([...present].sort()).toEqual([
      'claude.permissions.deny',
      'claude.permissions.importUserReadDeny',
    ]);
    expect(getPresentProviderOptionPaths(claudePermissions({}))).toEqual([]);
  });
});
