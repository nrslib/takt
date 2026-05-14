import type { RateLimitFallbackConfig, StepProviderOptions, WorkflowRuntimeConfig } from '../../core/models/workflow-types.js';
import type { ProviderPermissionProfiles } from '../../core/models/provider-profiles.js';
import type {
  WorkflowOverrides,
  PersonaProviderEntry,
  PipelineConfig,
  TaktProviderConfigEntry,
  TaktProvidersConfig,
} from '../../core/models/config-types.js';
import { validateProviderModelCompatibility } from './providerModelCompatibility.js';
import {
  normalizeConfigProviderReferenceDetailed,
  type ConfigProviderReference,
} from './providerReference.js';

function assertNormalizedPersonaProviderOptions(
  persona: string,
  providerOptions: unknown,
): void {
  if (providerOptions !== undefined) {
    return;
  }

  throw new Error(
    `Configuration error: persona_providers.${persona}.provider_options must include at least one provider-specific option`,
  );
}

export function normalizeRuntime(
  runtime: { prepare?: string[] } | undefined,
): WorkflowRuntimeConfig | undefined {
  if (!runtime?.prepare || runtime.prepare.length === 0) {
    return undefined;
  }
  return { prepare: [...new Set(runtime.prepare)] };
}

export function normalizeRateLimitFallback(
  raw: { switch_chain?: Array<{ provider: RateLimitFallbackConfig['switchChain'][number]['provider']; model?: string }> } | undefined,
): RateLimitFallbackConfig | undefined {
  if (!raw) {
    return undefined;
  }
  const switchChain = raw.switch_chain ?? [];
  return {
    switchChain: switchChain.map((entry, index) => {
      validateProviderModelCompatibility(entry.provider, entry.model, {
        modelFieldName: `Configuration error: rate_limit_fallback.switch_chain[${index}].model`,
      });
      return {
        provider: entry.provider,
        ...(entry.model !== undefined ? { model: entry.model } : {}),
      };
    }),
  };
}

export function denormalizeRateLimitFallback(
  config: RateLimitFallbackConfig | undefined,
): { switch_chain: Array<{ provider: RateLimitFallbackConfig['switchChain'][number]['provider']; model?: string }> } | undefined {
  if (!config) {
    return undefined;
  }
  return {
    switch_chain: config.switchChain.map((entry) => ({
      provider: entry.provider,
      ...(entry.model !== undefined ? { model: entry.model } : {}),
    })),
  };
}

export function normalizeProviderProfiles(
  raw: Record<string, {
    default_permission_mode: string;
    step_permission_overrides?: Record<string, string>;
  }> | undefined,
): ProviderPermissionProfiles | undefined {
  if (!raw) return undefined;

  const entries = Object.entries(raw).map(([provider, profile]) => [
    provider,
    {
      defaultPermissionMode: profile.default_permission_mode,
      stepPermissionOverrides: profile.step_permission_overrides,
    },
  ]);

  return Object.fromEntries(entries) as ProviderPermissionProfiles;
}

export function denormalizeProviderProfiles(
  profiles: ProviderPermissionProfiles | undefined,
): Record<string, { default_permission_mode: string; step_permission_overrides?: Record<string, string> }> | undefined {
  if (!profiles) return undefined;
  const entries = Object.entries(profiles);
  if (entries.length === 0) return undefined;

  return Object.fromEntries(entries.map(([provider, profile]) => [provider, {
    default_permission_mode: profile.defaultPermissionMode,
    ...(profile.stepPermissionOverrides
      ? { step_permission_overrides: profile.stepPermissionOverrides }
      : {}),
  }])) as Record<string, { default_permission_mode: string; step_permission_overrides?: Record<string, string> }>;
}

export function normalizeWorkflowOverrides(
  raw: {
    quality_gates?: string[];
    quality_gates_edit_only?: boolean;
    steps?: Record<string, { quality_gates?: string[] }>;
    personas?: Record<string, { quality_gates?: string[] }>;
  } | undefined,
): WorkflowOverrides | undefined {
  if (!raw) return undefined;
  return {
    qualityGates: raw.quality_gates,
    qualityGatesEditOnly: raw.quality_gates_edit_only,
    steps: raw.steps
      ? Object.fromEntries(
        Object.entries(raw.steps).map(([name, override]) => [
          name,
          { qualityGates: override.quality_gates },
        ])
      )
      : undefined,
    personas: raw.personas
      ? Object.fromEntries(
        Object.entries(raw.personas).map(([name, override]) => [
          name,
          { qualityGates: override.quality_gates },
        ])
      )
      : undefined,
  };
}

export function denormalizeWorkflowOverrides(
  overrides: WorkflowOverrides | undefined,
): {
  quality_gates?: string[];
  quality_gates_edit_only?: boolean;
  steps?: Record<string, { quality_gates?: string[] }>;
  personas?: Record<string, { quality_gates?: string[] }>;
} | undefined {
  if (!overrides) return undefined;
  const result: {
    quality_gates?: string[];
    quality_gates_edit_only?: boolean;
    steps?: Record<string, { quality_gates?: string[] }>;
    personas?: Record<string, { quality_gates?: string[] }>;
  } = {};
  if (overrides.qualityGates !== undefined) {
    result.quality_gates = overrides.qualityGates;
  }
  if (overrides.qualityGatesEditOnly !== undefined) {
    result.quality_gates_edit_only = overrides.qualityGatesEditOnly;
  }
  if (overrides.steps) {
    result.steps = Object.fromEntries(
      Object.entries(overrides.steps).map(([name, override]) => {
        const stepOverride: { quality_gates?: string[] } = {};
        if (override.qualityGates !== undefined) {
          stepOverride.quality_gates = override.qualityGates;
        }
        return [name, stepOverride];
      })
    );
  }
  if (overrides.personas) {
    result.personas = Object.fromEntries(
      Object.entries(overrides.personas).map(([name, override]) => {
        const personaOverride: { quality_gates?: string[] } = {};
        if (override.qualityGates !== undefined) {
          personaOverride.quality_gates = override.qualityGates;
        }
        return [name, personaOverride];
      })
    );
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function normalizePersonaProviders(
  raw: Record<string, string | {
    type?: string;
    provider?: string;
    model?: string;
    provider_options?: Record<string, unknown>;
  }> | undefined,
): Record<string, PersonaProviderEntry> | undefined {
  if (!raw) return undefined;
  const entries = Object.entries(raw);
  if (entries.length === 0) return undefined;

  return Object.fromEntries(entries.map(([persona, entry]) => {
    const rawProviderOptions = typeof entry === 'string' ? undefined : entry.provider_options;
    const normalizedReference = normalizeConfigProviderReferenceDetailed(
      (typeof entry === 'string' ? entry : (entry.provider ?? entry.type)) as ConfigProviderReference<NonNullable<PersonaProviderEntry['provider']>>,
      typeof entry === 'string' ? undefined : entry.model,
      rawProviderOptions,
    );
    if (rawProviderOptions !== undefined) {
      assertNormalizedPersonaProviderOptions(persona, normalizedReference.providerOptions);
    }
    const normalizedEntry: PersonaProviderEntry = {
      ...(normalizedReference.provider !== undefined ? { provider: normalizedReference.provider } : {}),
      ...(normalizedReference.model !== undefined ? { model: normalizedReference.model } : {}),
      ...(normalizedReference.providerOptions !== undefined
        ? { providerOptions: normalizedReference.providerOptions }
        : {}),
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

export function denormalizePersonaProviders(
  personaProviders: Record<string, PersonaProviderEntry> | undefined,
): Record<string, Record<string, unknown>> | undefined {
  if (!personaProviders) {
    return undefined;
  }

  const entries = Object.entries(personaProviders);
  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries.map(([persona, entry]) => {
    const rawEntry: Record<string, unknown> = {};
    if (entry.provider !== undefined) {
      rawEntry.provider = entry.provider;
    }
    if (entry.model !== undefined) {
      rawEntry.model = entry.model;
    }

    const rawProviderOptions = denormalizeProviderOptions(entry.providerOptions);
    if (entry.providerOptions !== undefined) {
      assertNormalizedPersonaProviderOptions(persona, rawProviderOptions);
    }
    if (rawProviderOptions !== undefined) {
      rawEntry.provider_options = rawProviderOptions;
    }

    if (Object.keys(rawEntry).length === 0) {
      throw new Error(
        `Configuration error: persona_providers.${persona} must include at least one of 'provider', 'model', or 'provider_options'`,
      );
    }

    return [persona, rawEntry];
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

export function normalizeTaktProviders(raw: {
  assistant?: {
    provider?: TaktProviderConfigEntry['provider'];
    model?: string;
  };
} | undefined): TaktProvidersConfig | undefined {
  if (!raw) {
    return undefined;
  }
  const normalizedAssistant = normalizeTaktAssistantProvider(raw.assistant);
  if (!normalizedAssistant) {
    return undefined;
  }
  return { assistant: normalizedAssistant };
}

export function normalizeTaktAssistantProvider(
  assistant:
    | {
      provider?: TaktProviderConfigEntry['provider'];
      model?: string;
    }
    | undefined,
): TaktProviderConfigEntry | undefined {
  if (!assistant) {
    return undefined;
  }
  const { provider, model } = assistant;
  if (provider === undefined && model === undefined) {
    throw new Error("Configuration error: 'takt_providers.assistant' must include provider or model.");
  }
  validateProviderModelCompatibility(
    provider,
    model,
    {
      modelFieldName: 'Configuration error: takt_providers.assistant.model',
    },
  );
  if (provider !== undefined) {
    return {
      provider,
      ...(model !== undefined ? { model } : {}),
    };
  }
  if (model === undefined) {
    throw new Error("Configuration error: 'takt_providers.assistant' must include provider or model.");
  }
  return { model };
}

export function buildRawTaktProvidersOrThrow(
  taktProviders: TaktProvidersConfig | undefined,
): { assistant: TaktProviderConfigEntry } | undefined {
  if (taktProviders === undefined) {
    return undefined;
  }
  if (taktProviders.assistant === undefined) {
    throw new Error("Configuration error: 'taktProviders.assistant' is required when taktProviders is set.");
  }
  const assistant = normalizeTaktAssistantProvider(taktProviders.assistant);
  if (!assistant) {
    throw new Error("Configuration error: 'takt_providers.assistant' must include provider or model.");
  }
  return { assistant };
}

export function denormalizeProviderOptions(
  providerOptions: StepProviderOptions | undefined,
): Record<string, unknown> | undefined {
  if (!providerOptions) {
    return undefined;
  }

  const raw: Record<string, unknown> = {};
  if (
    providerOptions.codex?.networkAccess !== undefined
    || providerOptions.codex?.reasoningEffort !== undefined
  ) {
    raw.codex = {
      ...(providerOptions.codex.networkAccess !== undefined
        ? { network_access: providerOptions.codex.networkAccess }
        : {}),
      ...(providerOptions.codex.reasoningEffort !== undefined
        ? { reasoning_effort: providerOptions.codex.reasoningEffort }
        : {}),
    };
  }
  if (providerOptions.opencode?.networkAccess !== undefined || providerOptions.opencode?.variant !== undefined) {
    raw.opencode = {
      ...(providerOptions.opencode.networkAccess !== undefined
        ? { network_access: providerOptions.opencode.networkAccess }
        : {}),
      ...(providerOptions.opencode.variant !== undefined
        ? { variant: providerOptions.opencode.variant }
        : {}),
    };
  }
  if (providerOptions.claude) {
    const claude: Record<string, unknown> = {};
    if (providerOptions.claude.allowedTools !== undefined) {
      claude.allowed_tools = providerOptions.claude.allowedTools;
    }
    if (providerOptions.claude.effort !== undefined) {
      claude.effort = providerOptions.claude.effort;
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
  if (providerOptions.copilot?.effort !== undefined) {
    raw.copilot = { effort: providerOptions.copilot.effort };
  }

  return Object.keys(raw).length > 0 ? raw : undefined;
}
