import type { MovementProviderOptions, PieceRuntimeConfig } from '../../core/models/piece-types.js';
import type { ProviderPermissionProfiles } from '../../core/models/provider-profiles.js';
import type { PieceOverrides, PersonaProviderEntry, PipelineConfig } from '../../core/models/persisted-global-config.js';
import { validateProviderModelCompatibility } from './providerModelCompatibility.js';

export function normalizeRuntime(
  runtime: { prepare?: string[] } | undefined,
): PieceRuntimeConfig | undefined {
  if (!runtime?.prepare || runtime.prepare.length === 0) {
    return undefined;
  }
  return { prepare: [...new Set(runtime.prepare)] };
}

export function normalizeProviderProfiles(
  raw: Record<string, { default_permission_mode: unknown; movement_permission_overrides?: Record<string, unknown> }> | undefined,
): ProviderPermissionProfiles | undefined {
  if (!raw) return undefined;

  const entries = Object.entries(raw).map(([provider, profile]) => [provider, {
    defaultPermissionMode: profile.default_permission_mode,
    movementPermissionOverrides: profile.movement_permission_overrides,
  }]);

  return Object.fromEntries(entries) as ProviderPermissionProfiles;
}

export function denormalizeProviderProfiles(
  profiles: ProviderPermissionProfiles | undefined,
): Record<string, { default_permission_mode: string; movement_permission_overrides?: Record<string, string> }> | undefined {
  if (!profiles) return undefined;
  const entries = Object.entries(profiles);
  if (entries.length === 0) return undefined;

  return Object.fromEntries(entries.map(([provider, profile]) => [provider, {
    default_permission_mode: profile.defaultPermissionMode,
    ...(profile.movementPermissionOverrides
      ? { movement_permission_overrides: profile.movementPermissionOverrides }
      : {}),
  }])) as Record<string, { default_permission_mode: string; movement_permission_overrides?: Record<string, string> }>;
}

export function normalizePieceOverrides(
  raw: { quality_gates?: string[]; quality_gates_edit_only?: boolean; movements?: Record<string, { quality_gates?: string[] }> } | undefined,
): PieceOverrides | undefined {
  if (!raw) return undefined;
  return {
    qualityGates: raw.quality_gates,
    qualityGatesEditOnly: raw.quality_gates_edit_only,
    movements: raw.movements
      ? Object.fromEntries(
          Object.entries(raw.movements).map(([name, override]) => [
            name,
            { qualityGates: override.quality_gates },
          ])
        )
      : undefined,
  };
}

export function denormalizePieceOverrides(
  overrides: PieceOverrides | undefined,
): { quality_gates?: string[]; quality_gates_edit_only?: boolean; movements?: Record<string, { quality_gates?: string[] }> } | undefined {
  if (!overrides) return undefined;
  const result: { quality_gates?: string[]; quality_gates_edit_only?: boolean; movements?: Record<string, { quality_gates?: string[] }> } = {};
  if (overrides.qualityGates !== undefined) {
    result.quality_gates = overrides.qualityGates;
  }
  if (overrides.qualityGatesEditOnly !== undefined) {
    result.quality_gates_edit_only = overrides.qualityGatesEditOnly;
  }
  if (overrides.movements) {
    result.movements = Object.fromEntries(
      Object.entries(overrides.movements).map(([name, override]) => {
        const movementOverride: { quality_gates?: string[] } = {};
        if (override.qualityGates !== undefined) {
          movementOverride.quality_gates = override.qualityGates;
        }
        return [name, movementOverride];
      })
    );
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function normalizePersonaProviders(
  raw: Record<string, string | { type?: string; provider?: string; model?: string }> | undefined,
): Record<string, PersonaProviderEntry> | undefined {
  if (!raw) return undefined;
  const entries = Object.entries(raw);
  if (entries.length === 0) return undefined;

  return Object.fromEntries(entries.map(([persona, entry]) => {
    const normalizedEntry: PersonaProviderEntry = typeof entry === 'string'
      ? { provider: entry as PersonaProviderEntry['provider'] }
      : {
        ...(entry.provider !== undefined || entry.type !== undefined
          ? { provider: (entry.provider ?? entry.type) as PersonaProviderEntry['provider'] }
          : {}),
        ...(entry.model !== undefined ? { model: entry.model } : {}),
      };
    validateProviderModelCompatibility(
      normalizedEntry.provider,
      normalizedEntry.model,
      {
        modelFieldName: `Configuration error: persona_providers.${persona}.model`,
        requireProviderQualifiedModelForOpencode: false,
      },
    );
    return [persona, normalizedEntry];
  }));
}

export function normalizePipelineConfig(raw: {
  default_branch_prefix?: string;
  commit_message_template?: string;
  pr_body_template?: string;
} | undefined): PipelineConfig | undefined {
  if (!raw) return undefined;
  const { default_branch_prefix, commit_message_template, pr_body_template } = raw;
  if (default_branch_prefix === undefined && commit_message_template === undefined && pr_body_template === undefined) {
    return undefined;
  }
  return {
    defaultBranchPrefix: default_branch_prefix,
    commitMessageTemplate: commit_message_template,
    prBodyTemplate: pr_body_template,
  };
}

export function denormalizeProviderOptions(
  providerOptions: MovementProviderOptions | undefined,
): Record<string, unknown> | undefined {
  if (!providerOptions) {
    return undefined;
  }

  const raw: Record<string, unknown> = {};
  if (providerOptions.codex?.networkAccess !== undefined) {
    raw.codex = { network_access: providerOptions.codex.networkAccess };
  }
  if (providerOptions.opencode?.networkAccess !== undefined) {
    raw.opencode = { network_access: providerOptions.opencode.networkAccess };
  }
  if (providerOptions.claude) {
    const claude: Record<string, unknown> = {};
    if (providerOptions.claude.allowedTools !== undefined) {
      claude.allowed_tools = providerOptions.claude.allowedTools;
    }
    const sandbox: Record<string, unknown> = {};
    if (providerOptions.claude.sandbox?.allowUnsandboxedCommands !== undefined) {
      sandbox.allow_unsandboxed_commands = providerOptions.claude.sandbox.allowUnsandboxedCommands;
    }
    if (providerOptions.claude.sandbox?.excludedCommands !== undefined) {
      sandbox.excluded_commands = providerOptions.claude.sandbox.excludedCommands;
    }
    if (Object.keys(sandbox).length > 0) {
      claude.sandbox = sandbox;
    }
    if (Object.keys(claude).length > 0) {
      raw.claude = claude;
    }
  }

  return Object.keys(raw).length > 0 ? raw : undefined;
}
