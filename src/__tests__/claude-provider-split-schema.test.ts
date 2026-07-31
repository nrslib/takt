import { describe, expect, it } from 'vitest';
import { GlobalConfigSchema } from '../core/models/index.js';
import {
  PersonaProviderEntrySchema,
  ProviderBlockSchema,
  ProviderPermissionProfilesSchema,
  ProviderReferenceSchema,
  StepProviderOptionsSchema,
  ProviderTypeSchema,
} from '../core/models/schema-base.js';

describe('Claude provider split (Zod)', () => {
  describe('ProviderTypeSchema', () => {
    it('Given claude-sdk string, When parse, Then succeeds', () => {
      expect(ProviderTypeSchema.parse('claude-sdk')).toBe('claude-sdk');
    });

    it('Given claude string, When parse, Then succeeds (headless id)', () => {
      expect(ProviderTypeSchema.parse('claude')).toBe('claude');
    });
  });

  describe('ProviderReferenceSchema', () => {
    it('Given shorthand claude-sdk, When parse, Then succeeds', () => {
      expect(ProviderReferenceSchema.parse('claude-sdk')).toBe('claude-sdk');
    });
  });

  describe('ProviderBlockSchema', () => {
    it('Given claude-sdk block with sandbox, When parse, Then succeeds', () => {
      const parsed = ProviderBlockSchema.parse({
        type: 'claude-sdk',
        sandbox: { allow_unsandboxed_commands: true },
      });

      expect(parsed.type).toBe('claude-sdk');
      expect(parsed.sandbox).toEqual({ allow_unsandboxed_commands: true });
    });

    it('Given headless claude block with sandbox, When parse, Then succeeds', () => {
      const parsed = ProviderBlockSchema.parse({
        type: 'claude',
        sandbox: { excluded_commands: ['rm'] },
      });

      expect(parsed.type).toBe('claude');
      expect(parsed.sandbox).toEqual({ excluded_commands: ['rm'] });
    });

    it('Given headless claude block with network_access, When parse, Then fails', () => {
      expect(() =>
        ProviderBlockSchema.parse({
          type: 'claude',
          network_access: true,
        }),
      ).toThrow(/network_access/i);
    });
  });

  describe('PersonaProviderEntrySchema', () => {
    it('Given empty nested provider_options object, When parse, Then fails', () => {
      expect(() =>
        PersonaProviderEntrySchema.parse({
          provider_options: {
            claude: {
              sandbox: {},
            },
          },
        }),
      ).toThrow(/provider_options/i);
    });

    it('Given nested provider_options leaf, When parse, Then succeeds', () => {
      const parsed = PersonaProviderEntrySchema.parse({
        provider_options: {
          claude: {
            sandbox: {
              excluded_commands: ['rm'],
            },
          },
        },
      });

      expect(parsed.provider_options?.claude?.sandbox).toEqual({
        excluded_commands: ['rm'],
      });
    });
  });

  describe('ProviderPermissionProfilesSchema', () => {
    it('Given profiles for claude and claude-sdk, When parse, Then both keys are accepted', () => {
      const parsed = ProviderPermissionProfilesSchema.parse({
        claude: {
          default_permission_mode: 'readonly',
        },
        'claude-sdk': {
          default_permission_mode: 'edit',
        },
      });

      expect(parsed?.claude?.default_permission_mode).toBe('readonly');
      expect(parsed?.['claude-sdk']?.default_permission_mode).toBe('edit');
    });
  });

  describe('Claude Skill provider option', () => {
    it('Given boolean enabled, When parsing provider_options.claude.skills, Then it preserves the value', () => {
      const parsed = StepProviderOptionsSchema.parse({
        claude: { skills: { enabled: false } },
      });

      expect(parsed?.claude?.skills?.enabled).toBe(false);
    });

    it('Given an empty Skills object, When parsing provider_options.claude.skills, Then it is accepted', () => {
      const parsed = StepProviderOptionsSchema.parse({
        claude: { skills: {} },
      });

      expect(parsed?.claude?.skills).toEqual({});
    });

    it('Given a non-boolean enabled value, When parsing provider_options.claude.skills, Then it rejects the configuration', () => {
      expect(() => StepProviderOptionsSchema.parse({
        claude: { skills: { enabled: 'false' } },
      })).toThrow(/enabled|boolean/i);
    });

    it.each([
      ['unknown key', { enabeld: true }],
      ['array', []],
      ['scalar', 'enabled'],
      ['null', null],
    ])(
      'Given %s Skills shape, When parsing provider_options.claude.skills, Then it rejects the configuration',
      (_caseName, skills) => {
        expect(() => StepProviderOptionsSchema.parse({
          claude: { skills },
        })).toThrow(/skills|unrecognized|object/i);
      },
    );
  });

  describe('GlobalConfigSchema default provider', () => {
    it('Given empty object, When parse with defaults, Then provider is claude (headless)', () => {
      const parsed = GlobalConfigSchema.parse({});

      expect(parsed.provider).toBe('claude');
    });

    it('Given explicit claude-sdk provider, When parse, Then preserved', () => {
      const parsed = GlobalConfigSchema.parse({ provider: 'claude-sdk' });

      expect(parsed.provider).toBe('claude-sdk');
    });
  });
});
